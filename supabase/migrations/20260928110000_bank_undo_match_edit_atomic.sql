-- Undo, match, exclude and journal-entry edit: one database transaction each.
--
-- Audit theme G ("undo and void"). Four client flows were a chain of
-- separate REST writes whose errors were mostly not checked:
--
--   * Undo (Banking.js undoTransaction) voided txn.journal_entry_id no
--     matter how the transaction got it. For a MATCHED transaction that id
--     is an entry created elsewhere -- a tenant payment, a bill -- so Undo
--     voided the payment itself and moved the tenant's balance. It also
--     carried on after a failed void (period lock, trg_mgmt_gate for an
--     office assistant) and returned the transaction to For Review while
--     its entry was still posted, inviting a second posting.
--   * Match (confirmMatch) was three writes with no for_review lock, no
--     period-lock check, and accepted any entry whose DEBITS summed to the
--     bank amount, whether or not it touched the bank account at all.
--   * Exclude never recorded posting_decision_id, so a later Restore could
--     not mark the decision undone, and did not check that the transaction
--     was still For Review.
--   * Editing a journal entry (Accounting.js updateJournalEntry) updated
--     the header without checking the error, deleted every line and
--     re-inserted them. A dropped connection left a half-saved entry, and
--     every save silently wiped each line's bank_feed_transaction_id and
--     reconciled / reconciled_date -- un-reconciling the bank account.
--
-- All four functions are SECURITY INVOKER, like post_bank_transaction:
-- RLS, the period-lock triggers and the management gate (trg_mgmt_gate,
-- which reads current_user = 'authenticated') all still apply to the
-- caller. Because a function body is one transaction, any failure --
-- including one raised by those triggers -- rolls back everything.
--
-- Deliberately NOT changed (owner decision, audit item G3): voiding an
-- entry does not touch the payments row, bill status, owner distribution
-- or deposit status it came from.

-- A caller must be staff of the company. bank_feed_transaction's RLS lets
-- any active member (tenants included) read and write it, and the journal
-- tables' RLS would silently hide rows from a non-staff caller -- an
-- UPDATE that matches 0 rows is not an error. Checked up front instead.
-- The service role (no JWT) is trusted, as everywhere else.
CREATE OR REPLACE FUNCTION public._bank_require_staff(p_company_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user = 'authenticated'
     AND NOT EXISTS (SELECT 1 FROM public.get_staff_company_ids() s WHERE s = p_company_id) THEN
    RAISE EXCEPTION 'Only staff of this company can change its books.'
      USING ERRCODE = '42501', HINT = 'not_staff';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public._bank_require_staff(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._bank_require_staff(text) TO authenticated, service_role;

-- References that tie an entry to another record (a bank transaction, a
-- Stripe payment, a deposit, a recurring schedule ...). Their reference is
-- an idempotency key; the JE form already shows it read-only, and
-- update_journal_entry refuses to change it. Mirrors REF_LABELS in
-- Accounting.js (every prefix the app generates).
CREATE OR REPLACE FUNCTION public.je_reference_is_system(p_reference text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(btrim(p_reference), '') ~ '^(OPENING|PRORENT|RENT|RENT1|LATEFEE|LATE|DEPDED|DEPRET|DEPFORF|DEP|WOFF|WO|VINV|BANK|XFER|SPLIT|APAY|PAY|STRIPE|RECUR|MOVEOUT|ODIST|DIST|HOA|UTIL|LOAN|EVICT|BULK|MANUAL)-';
$function$;
REVOKE ALL ON FUNCTION public.je_reference_is_system(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.je_reference_is_system(text) TO authenticated, service_role;

-- A journal amount must be a real number. numeric accepts 'NaN',
-- 'Infinity' and '-Infinity', and NaN = NaN in Postgres, so a NaN line
-- passes a DR = CR check and poisons every balance it is summed into.
-- NULL counts as finite (it is read as 0 everywhere).
CREATE OR REPLACE FUNCTION public.je_amount_is_finite(p_amount numeric)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_amount IS NULL OR p_amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric);
$function$;
-- Executable by everyone: it is pure, and chk_jl_amounts_finite (160000)
-- calls it for whoever writes a journal line.
GRANT EXECUTE ON FUNCTION public.je_amount_is_finite(numeric) TO PUBLIC;

-- ---------------------------------------------------------------------------
-- undo_bank_transaction
-- ---------------------------------------------------------------------------
-- Returns the transaction to For Review. Decided in this order:
--   excluded               -> restore: decision undone, status reset
--   created by Banking     -> the entry's reference is EXACTLY
--                             BANK-/XFER-/SPLIT- followed by THIS txn's id:
--                             void it, release its stamps.
--   matched                -> status 'matched', or a 'matched_to' link whose
--                             entry IS the txn's journal_entry_id: UNLINK
--                             ONLY. The matched entry is someone else's
--                             record (a tenant payment, a bill) and is NEVER
--                             voided.
--   nothing live           -> no entry, or it is already voided: reset.
--   anything else          -> 'unlinked': the entry is left posted -- when
--                             in doubt, leave the books alone.
-- "Created by Banking" is tested first and on the reference alone. A stale
-- matched_to link (left behind when the matched entry was voided in
-- Accounting) used to win over it, so Undo of a later BANK- posting
-- returned 'unmatched' and left that posting on the books. A created_from
-- link alone is not proof either: it follows a relink onto whatever entry
-- carries the BANK- reference, and that reference used to be editable.
-- In every case the txn ends up claiming nothing: all its matched_to links,
-- its created_from links to voided entries, its stamps on the entries it
-- pointed at, and every one of its still-'posted' decisions are released.
CREATE OR REPLACE FUNCTION public.undo_bank_transaction(
  p_company_id text,
  p_txn_id     uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_txn      bank_feed_transaction%ROWTYPE;
  v_lock     date;
  v_je       acct_journal_entries%ROWTYPE;
  v_je_id    text;
  v_mode     text;
  v_n        int;
  v_linked   text[];
BEGIN
  PERFORM public._bank_require_staff(p_company_id);

  SELECT * INTO v_txn FROM bank_feed_transaction
   WHERE id = p_txn_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'undo_bank_transaction: transaction not found' USING HINT = 'not_found';
  END IF;

  -- A retry after a lost response: already undone.
  IF v_txn.status = 'for_review' THEN
    RETURN jsonb_build_object('outcome', 'already_for_review');
  END IF;
  IF v_txn.status = 'locked' THEN
    RAISE EXCEPTION 'This transaction is reconciled and locked; it cannot be undone.'
      USING ERRCODE = 'P0001', HINT = 'locked';
  END IF;
  IF v_txn.status NOT IN ('categorized', 'matched', 'posted', 'excluded') THEN
    RAISE EXCEPTION 'This transaction cannot be undone (status %).', v_txn.status
      USING ERRCODE = 'P0001', HINT = 'bad_status';
  END IF;

  SELECT lock_date INTO v_lock FROM accounting_period_lock WHERE company_id = p_company_id;
  IF v_lock IS NOT NULL AND v_txn.posted_date <= v_lock THEN
    RAISE EXCEPTION 'Accounting period is locked through %. This transaction (%) cannot be undone.', v_lock, v_txn.posted_date
      USING ERRCODE = 'check_violation', HINT = 'period_locked';
  END IF;

  v_je_id := v_txn.journal_entry_id::text;
  IF v_je_id IS NOT NULL THEN
    SELECT * INTO v_je FROM acct_journal_entries
     WHERE id = v_je_id AND company_id = p_company_id
     FOR UPDATE;
  END IF;

  IF v_txn.status = 'excluded' THEN
    v_mode := 'restored';
  ELSIF v_je.id IS NOT NULL AND v_je.status <> 'voided'
     AND v_je.reference IN ('BANK-' || p_txn_id::text, 'XFER-' || p_txn_id::text, 'SPLIT-' || p_txn_id::text) THEN
    v_mode := 'voided';
  ELSIF v_txn.status = 'matched'
     OR (v_je_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM bank_feed_transaction_link
            WHERE bank_feed_transaction_id = p_txn_id AND company_id = p_company_id
              AND link_role = 'matched_to' AND linked_object_id::text = v_je_id)) THEN
    v_mode := 'unmatched';
  ELSIF v_je.id IS NULL OR v_je.status = 'voided' THEN
    v_mode := 'reset';        -- nothing live on the books to undo
  ELSE
    v_mode := 'unlinked';     -- points at an entry we can't prove we created
  END IF;

  IF v_mode = 'voided' THEN
    -- Voiding a reconciled line would silently break a finished
    -- reconciliation. Make the user unreconcile first.
    IF EXISTS (SELECT 1 FROM acct_journal_lines
                WHERE journal_entry_id = v_je.id AND COALESCE(reconciled, false)) THEN
      RAISE EXCEPTION 'Entry % has reconciled lines. Unreconcile them before undoing this transaction.', v_je.number
        USING ERRCODE = 'P0001', HINT = 'reconciled';
    END IF;
    -- trg_mgmt_gate and the period-lock trigger fire here; either raises
    -- and rolls back the whole undo.
    UPDATE acct_journal_entries SET status = 'voided'
     WHERE id = v_je.id AND company_id = p_company_id AND status <> 'voided';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'undo_bank_transaction: could not void entry %', v_je.number;
    END IF;
  END IF;

  IF v_mode <> 'restored' THEN
    -- Entries this txn points at: its journal_entry_id plus anything a
    -- matched_to link names (a stale link included).
    SELECT array_agg(DISTINCT x) INTO v_linked FROM (
      SELECT v_je_id AS x WHERE v_je_id IS NOT NULL
      UNION
      SELECT linked_object_id::text FROM bank_feed_transaction_link
       WHERE bank_feed_transaction_id = p_txn_id AND company_id = p_company_id
         AND link_role = 'matched_to' AND linked_object_type = 'journal_entry') s;

    -- Release only THIS transaction's claim on those lines; any other
    -- stamp on the same entry belongs to someone else.
    IF v_linked IS NOT NULL THEN
      UPDATE acct_journal_lines SET bank_feed_transaction_id = NULL
       WHERE journal_entry_id = ANY (v_linked) AND company_id = p_company_id
         AND bank_feed_transaction_id = p_txn_id;
    END IF;

    -- Every matched_to link goes (the txn is For Review again), and so does
    -- a created_from link to an entry that is now voided (or gone). A
    -- created_from link to a still-posted entry is kept.
    DELETE FROM bank_feed_transaction_link k
     WHERE k.bank_feed_transaction_id = p_txn_id AND k.company_id = p_company_id
       AND (k.link_role = 'matched_to'
            OR (k.link_role = 'created_from' AND k.linked_object_type = 'journal_entry'
                AND NOT EXISTS (SELECT 1 FROM acct_journal_entries e
                                 WHERE e.id = k.linked_object_id::text AND e.status <> 'voided')));
  END IF;

  -- Nothing about this txn is decided any more: its recorded decision and
  -- any other decision still marked 'posted' (older rows never recorded the
  -- id; a match left over from an entry voided in Accounting) are undone.
  UPDATE bank_posting_decision SET status = 'undone', updated_at = now()
   WHERE company_id = p_company_id AND bank_feed_transaction_id = p_txn_id
     AND (id = v_txn.posting_decision_id OR status = 'posted')
     AND status IS DISTINCT FROM 'undone';

  UPDATE bank_feed_transaction
     SET status = 'for_review', accepted_at = NULL, accepted_by = NULL,
         excluded_at = NULL, excluded_by = NULL, exclusion_reason = NULL,
         journal_entry_id = NULL, posting_decision_id = NULL,
         matched_target_type = NULL, matched_target_id = NULL
   WHERE id = p_txn_id AND company_id = p_company_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'undo_bank_transaction: could not reset the transaction';
  END IF;

  RETURN jsonb_build_object('outcome', v_mode, 'je_id', v_je_id, 'je_number', v_je.number);
END;
$function$;
REVOKE ALL ON FUNCTION public.undo_bank_transaction(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_bank_transaction(text, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- exclude_bank_transaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exclude_bank_transaction(
  p_company_id text,
  p_txn_id     uuid,
  p_reason     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_txn         bank_feed_transaction%ROWTYPE;
  v_decision_id uuid;
  v_email       text := COALESCE(auth.jwt() ->> 'email', '');
BEGIN
  PERFORM public._bank_require_staff(p_company_id);
  IF COALESCE(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'exclude_bank_transaction: a reason is required' USING HINT = 'no_reason';
  END IF;

  SELECT * INTO v_txn FROM bank_feed_transaction
   WHERE id = p_txn_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exclude_bank_transaction: transaction not found' USING HINT = 'not_found';
  END IF;
  IF v_txn.status = 'excluded' AND v_txn.exclusion_reason IS NOT DISTINCT FROM p_reason THEN
    RETURN jsonb_build_object('outcome', 'already_excluded', 'decision_id', v_txn.posting_decision_id);
  END IF;
  IF v_txn.status <> 'for_review' THEN
    RAISE EXCEPTION 'exclude_bank_transaction: transaction already processed (status %)', v_txn.status
      USING ERRCODE = 'P0001', HINT = 'already_processed';
  END IF;

  INSERT INTO bank_posting_decision
    (company_id, bank_feed_transaction_id, decision_type, memo, status, created_by)
  VALUES (p_company_id, p_txn_id, 'exclude', p_reason, 'posted', v_email)
  RETURNING id INTO v_decision_id;

  UPDATE bank_feed_transaction
     SET status = 'excluded', exclusion_reason = p_reason,
         excluded_at = now(), excluded_by = v_email,
         posting_decision_id = v_decision_id
   WHERE id = p_txn_id AND company_id = p_company_id;

  RETURN jsonb_build_object('outcome', 'excluded', 'decision_id', v_decision_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.exclude_bank_transaction(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exclude_bank_transaction(text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- match_bank_transaction
-- ---------------------------------------------------------------------------
-- Links a For Review bank transaction to an EXISTING posted entry. The
-- entry must carry a line on the feed's GL account, on the bank's side
-- (inflow = debit, outflow = credit), for exactly the bank amount, not
-- already claimed by another bank transaction. That line gets this txn's
-- stamp. No amounts are written.
CREATE OR REPLACE FUNCTION public.match_bank_transaction(
  p_company_id text,
  p_txn_id     uuid,
  p_je_id      text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_txn         bank_feed_transaction%ROWTYPE;
  v_je          acct_journal_entries%ROWTYPE;
  v_gl          uuid;
  v_abs         numeric;
  v_line_id     int;
  v_lock        date;
  v_decision_id uuid;
  v_email       text := COALESCE(auth.jwt() ->> 'email', '');
BEGIN
  PERFORM public._bank_require_staff(p_company_id);
  IF p_je_id IS NULL OR p_je_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'This entry cannot be matched (legacy id).' USING HINT = 'bad_entry';
  END IF;

  SELECT * INTO v_txn FROM bank_feed_transaction
   WHERE id = p_txn_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'match_bank_transaction: transaction not found' USING HINT = 'not_found';
  END IF;
  IF v_txn.status <> 'for_review' THEN
    IF v_txn.status = 'matched' AND v_txn.journal_entry_id::text = p_je_id THEN
      RETURN jsonb_build_object('outcome', 'already_matched', 'je_id', p_je_id);
    END IF;
    RAISE EXCEPTION 'match_bank_transaction: transaction already processed (status %)', v_txn.status
      USING ERRCODE = 'P0001', HINT = 'already_processed';
  END IF;

  -- Locking the entry serialises two DIFFERENT bank transactions racing to
  -- claim it; the loser re-reads the link below after the winner commits.
  SELECT * INTO v_je FROM acct_journal_entries
   WHERE id = p_je_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND OR v_je.status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted journal entry can be matched.' USING HINT = 'bad_entry';
  END IF;

  SELECT lock_date INTO v_lock FROM accounting_period_lock WHERE company_id = p_company_id;
  IF v_lock IS NOT NULL AND (v_txn.posted_date <= v_lock OR v_je.date <= v_lock) THEN
    RAISE EXCEPTION 'Accounting period is locked through %. This match cannot be recorded.', v_lock
      USING ERRCODE = 'check_violation', HINT = 'period_locked';
  END IF;

  IF EXISTS (SELECT 1 FROM bank_feed_transaction_link
              WHERE company_id = p_company_id AND linked_object_type = 'journal_entry'
                AND linked_object_id::text = p_je_id) THEN
    RAISE EXCEPTION 'Entry % is already linked to another bank transaction.', v_je.number
      USING ERRCODE = 'P0001', HINT = 'already_linked';
  END IF;

  SELECT gl_account_id INTO v_gl FROM bank_account_feed
   WHERE id = v_txn.bank_account_feed_id AND company_id = p_company_id;
  IF v_gl IS NULL THEN
    RAISE EXCEPTION 'This bank account is not linked to a GL account.' USING HINT = 'no_gl';
  END IF;

  v_abs := round(abs(v_txn.amount), 2);
  SELECT id INTO v_line_id FROM acct_journal_lines
   WHERE journal_entry_id = p_je_id AND company_id = p_company_id
     AND account_id = v_gl
     AND (bank_feed_transaction_id IS NULL OR bank_feed_transaction_id = p_txn_id)
     AND CASE WHEN v_txn.direction = 'inflow'
              THEN round(COALESCE(debit, 0), 2) = v_abs AND COALESCE(credit, 0) = 0
              ELSE round(COALESCE(credit, 0), 2) = v_abs AND COALESCE(debit, 0) = 0 END
   ORDER BY id
   LIMIT 1
   FOR UPDATE;
  IF v_line_id IS NULL THEN
    RAISE EXCEPTION 'Entry % has no % of % on this bank account, so it is not this transaction.',
      v_je.number, CASE WHEN v_txn.direction = 'inflow' THEN 'debit' ELSE 'credit' END, v_abs
      USING ERRCODE = 'P0001', HINT = 'no_matching_line';
  END IF;

  INSERT INTO bank_feed_transaction_link
    (company_id, bank_feed_transaction_id, linked_object_type, linked_object_id, link_role)
  VALUES (p_company_id, p_txn_id, 'journal_entry', p_je_id::uuid, 'matched_to');

  INSERT INTO bank_posting_decision
    (company_id, bank_feed_transaction_id, decision_type, memo, status, created_by)
  VALUES (p_company_id, p_txn_id, 'match', 'Matched to ' || COALESCE(v_je.number, p_je_id), 'posted', v_email)
  RETURNING id INTO v_decision_id;

  UPDATE acct_journal_lines SET bank_feed_transaction_id = p_txn_id
   WHERE id = v_line_id;

  UPDATE bank_feed_transaction
     SET status = 'matched', accepted_at = now(), accepted_by = v_email,
         journal_entry_id = p_je_id::uuid, posting_decision_id = v_decision_id,
         matched_target_type = 'journal_entry', matched_target_id = p_je_id::uuid
   WHERE id = p_txn_id AND company_id = p_company_id;

  RETURN jsonb_build_object('outcome', 'matched', 'je_id', p_je_id, 'je_number', v_je.number,
                            'line_id', v_line_id, 'decision_id', v_decision_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.match_bank_transaction(text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_bank_transaction(text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- update_journal_entry
-- ---------------------------------------------------------------------------
-- Saves an edited entry in one transaction. Lines are matched to the
-- existing ones by id (the editor carries each line's id), falling back to
-- same account + debit + credit for a line sent without one. A matched
-- line is UPDATED IN PLACE, so it keeps its id, bank_feed_transaction_id,
-- reconciled and reconciled_date; unmatched old lines are deleted; new
-- lines are inserted clean.
--
-- What the editor loaded must still be what is on the books:
--   * p_expected_line_ids -- exactly the entry's current line ids, else
--     the save would delete a line the user never saw (stale_lines);
--   * p_expected -- the header and lines as the editor loaded them
--     ({header: {date, description, reference, status, property},
--       lines: [{id, account_id, debit, credit, class_id, memo}]}). Any
--     difference means someone else saved in between; refused
--     (stale_entry) rather than silently overwriting their change.
-- Both are required.
--
-- Amounts: must be finite numbers (NaN / Infinity refused -- NaN = NaN in
-- Postgres, so a NaN entry used to pass every later check), not negative,
-- and not on both sides of one line. A kept line whose amount is sent
-- back unchanged keeps its stored amount as is (legacy entries with more
-- than 2 decimals stay re-savable); every other amount is rounded to
-- cents. DR must then equal CR exactly, and not be zero.
--
-- Also refused (nothing written):
--   * fewer than 2 lines; a line with no account
--   * a voided entry, or a status other than draft/posted
--   * changing a system reference (it is an idempotency key), or changing
--     an ordinary reference INTO a system one
--   * changing the account or amount of a RECONCILED line, removing one,
--     or moving the date of an entry that has one -- unreconcile first
--   * changing the account or amount of a line stamped with a bank
--     transaction, or removing it -- undo that transaction in Banking
--   * posted -> draft while any line is stamped or reconciled
--
-- Earlier signatures (no expected ids / no snapshot) are dropped: they
-- were never on production, and leaving them would let a caller skip the
-- checks.
DROP FUNCTION IF EXISTS public.update_journal_entry(text, text, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.update_journal_entry(text, text, jsonb, jsonb, int[]);
CREATE OR REPLACE FUNCTION public.update_journal_entry(
  p_company_id        text,
  p_je_id             text,
  p_header            jsonb,
  p_lines             jsonb,
  p_expected_line_ids int[] DEFAULT NULL,
  p_expected          jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_je        acct_journal_entries%ROWTYPE;
  v_old       acct_journal_lines%ROWTYPE;
  v_lines     jsonb;                  -- p_lines with the amounts to write
  v_line      jsonb;
  v_ord       bigint;
  v_id        int;
  v_map       jsonb := '{}'::jsonb;   -- ordinality -> old line id
  v_used      int[] := '{}';
  v_dr        numeric;
  v_cr        numeric;
  v_new_date  date;
  v_new_ref   text;
  v_status    text;
  v_n         int;
  v_kept      int := 0;
  v_inserted  int := 0;
  v_deleted   int := 0;
BEGIN
  PERFORM public._bank_require_staff(p_company_id);

  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'A journal entry needs at least 2 lines.' USING HINT = 'too_few_lines';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE COALESCE(l ->> 'account_id', '') = '') THEN
    RAISE EXCEPTION 'Every line needs an account.' USING HINT = 'no_account';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
              WHERE NOT public.je_amount_is_finite(NULLIF(l ->> 'debit', '')::numeric)
                 OR NOT public.je_amount_is_finite(NULLIF(l ->> 'credit', '')::numeric)) THEN
    RAISE EXCEPTION 'Every amount must be a number.' USING HINT = 'bad_amount';
  END IF;

  SELECT * INTO v_je FROM acct_journal_entries
   WHERE id = p_je_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_journal_entry: entry not found' USING HINT = 'not_found';
  END IF;
  IF v_je.status = 'voided' THEN
    RAISE EXCEPTION 'A voided entry cannot be edited.' USING HINT = 'voided';
  END IF;

  -- The editor must have loaded exactly the entry's current lines, and may
  -- only send ids from that set.
  IF p_expected_line_ids IS NULL
     OR EXISTS (SELECT id FROM acct_journal_lines WHERE journal_entry_id = p_je_id
                EXCEPT SELECT unnest(p_expected_line_ids))
     OR EXISTS (SELECT unnest(p_expected_line_ids)
                EXCEPT SELECT id FROM acct_journal_lines WHERE journal_entry_id = p_je_id)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
                 WHERE COALESCE(l ->> 'id', '') <> ''
                   AND (l ->> 'id' !~ '^[0-9]+$' OR NOT ((l ->> 'id')::int = ANY (p_expected_line_ids)))) THEN
    RAISE EXCEPTION 'This entry has changed or didn''t fully load. Reload the page and edit it again.'
      USING HINT = 'stale_lines';
  END IF;

  -- ...and it must still read the way the editor loaded it (optimistic
  -- concurrency: a second editor's save in between is not overwritten).
  IF p_expected IS NULL OR jsonb_typeof(p_expected -> 'lines') IS DISTINCT FROM 'array'
     OR v_je.date::text IS DISTINCT FROM (p_expected -> 'header' ->> 'date')
     OR COALESCE(v_je.description, '') <> COALESCE(p_expected -> 'header' ->> 'description', '')
     OR COALESCE(v_je.reference, '')   <> COALESCE(p_expected -> 'header' ->> 'reference', '')
     OR COALESCE(v_je.status, '')      <> COALESCE(p_expected -> 'header' ->> 'status', '')
     OR COALESCE(v_je.property, '')    <> COALESCE(p_expected -> 'header' ->> 'property', '')
     OR jsonb_array_length(p_expected -> 'lines') <> (SELECT count(*) FROM acct_journal_lines WHERE journal_entry_id = p_je_id)
     OR EXISTS (
          SELECT 1 FROM acct_journal_lines jl
           WHERE jl.journal_entry_id = p_je_id
             AND NOT EXISTS (
                   SELECT 1 FROM jsonb_array_elements(p_expected -> 'lines') e
                    WHERE e ->> 'id' = jl.id::text
                      AND e ->> 'account_id' IS NOT DISTINCT FROM jl.account_id::text
                      AND public.je_amount_is_finite(NULLIF(e ->> 'debit', '')::numeric)
                      AND public.je_amount_is_finite(NULLIF(e ->> 'credit', '')::numeric)
                      AND COALESCE(NULLIF(e ->> 'debit', '')::numeric, 0)  = COALESCE(jl.debit, 0)
                      AND COALESCE(NULLIF(e ->> 'credit', '')::numeric, 0) = COALESCE(jl.credit, 0)
                      AND COALESCE(e ->> 'class_id', '') = COALESCE(jl.class_id, '')
                      AND COALESCE(e ->> 'memo', '')     = COALESCE(jl.memo, ''))) THEN
    RAISE EXCEPTION 'This entry changed since you opened it — reload it and make your edit again.'
      USING HINT = 'stale_entry';
  END IF;

  -- The amounts to write. A kept line sent back with its stored amounts
  -- keeps them exactly (a legacy 33.335 is not re-rounded, so a balanced
  -- legacy entry stays balanced); anything else is rounded to cents.
  SELECT jsonb_agg(l || jsonb_build_object(
           'debit',  CASE WHEN o.id IS NOT NULL THEN COALESCE(o.debit, 0)
                          ELSE round(COALESCE(NULLIF(l ->> 'debit', '')::numeric, 0), 2) END,
           'credit', CASE WHEN o.id IS NOT NULL THEN COALESCE(o.credit, 0)
                          ELSE round(COALESCE(NULLIF(l ->> 'credit', '')::numeric, 0), 2) END) ORDER BY x.ord)
    INTO v_lines
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY x(l, ord)
    LEFT JOIN acct_journal_lines o
      ON COALESCE(l ->> 'id', '') ~ '^[0-9]+$' AND o.id = (l ->> 'id')::int AND o.journal_entry_id = p_je_id
     AND COALESCE(o.debit, 0)  = COALESCE(NULLIF(l ->> 'debit', '')::numeric, 0)
     AND COALESCE(o.credit, 0) = COALESCE(NULLIF(l ->> 'credit', '')::numeric, 0);

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l
              WHERE (l ->> 'debit')::numeric < 0 OR (l ->> 'credit')::numeric < 0) THEN
    RAISE EXCEPTION 'Amounts cannot be negative. Put the amount on the other side instead.'
      USING HINT = 'negative_amount';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_lines) l
              WHERE (l ->> 'debit')::numeric > 0 AND (l ->> 'credit')::numeric > 0) THEN
    RAISE EXCEPTION 'A line can have a debit or a credit, not both.' USING HINT = 'both_sides';
  END IF;
  SELECT sum((l ->> 'debit')::numeric), sum((l ->> 'credit')::numeric)
    INTO v_dr, v_cr FROM jsonb_array_elements(v_lines) l;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'update_journal_entry: entry out of balance (DR % vs CR %)', v_dr, v_cr
      USING ERRCODE = 'P0001', HINT = 'unbalanced';
  END IF;
  IF v_dr = 0 THEN
    RAISE EXCEPTION 'Every line of this entry is zero.' USING HINT = 'zero_entry';
  END IF;

  v_new_date := COALESCE(NULLIF(p_header ->> 'date', '')::date, v_je.date);
  v_new_ref  := COALESCE(p_header ->> 'reference', v_je.reference, '');
  v_status   := COALESCE(NULLIF(p_header ->> 'status', ''), v_je.status);
  IF v_status NOT IN ('draft', 'posted') THEN
    RAISE EXCEPTION 'update_journal_entry: status % is not allowed here', v_status USING HINT = 'bad_status';
  END IF;
  IF public.je_reference_is_system(v_je.reference) AND v_new_ref IS DISTINCT FROM v_je.reference THEN
    RAISE EXCEPTION 'The reference % links this entry to another record and cannot be changed.', v_je.reference
      USING HINT = 'system_reference';
  END IF;
  IF v_new_ref IS DISTINCT FROM COALESCE(v_je.reference, '') AND public.je_reference_is_system(v_new_ref) THEN
    RAISE EXCEPTION 'The reference % is reserved for entries the system creates. Choose another reference.', v_new_ref
      USING HINT = 'system_reference';
  END IF;
  IF v_new_date IS DISTINCT FROM v_je.date AND EXISTS (
       SELECT 1 FROM acct_journal_lines WHERE journal_entry_id = p_je_id AND COALESCE(reconciled, false)) THEN
    RAISE EXCEPTION 'This entry has reconciled lines, so its date cannot change. Unreconcile them first.'
      USING HINT = 'reconciled_line';
  END IF;
  IF v_je.status = 'posted' AND v_status = 'draft' AND EXISTS (
       SELECT 1 FROM acct_journal_lines WHERE journal_entry_id = p_je_id
          AND (COALESCE(reconciled, false) OR bank_feed_transaction_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'This entry has reconciled or bank-linked lines, so it cannot go back to draft. Unreconcile them or undo the bank transaction first.'
      USING HINT = 'posted_to_draft';
  END IF;

  -- Pass 1: lines that carry the id of one of this entry's lines.
  FOR v_line, v_ord IN SELECT value, ordinality FROM jsonb_array_elements(v_lines) WITH ORDINALITY LOOP
    IF COALESCE(v_line ->> 'id', '') ~ '^[0-9]+$' THEN
      SELECT id INTO v_id FROM acct_journal_lines
       WHERE id = (v_line ->> 'id')::int AND journal_entry_id = p_je_id
         AND NOT (id = ANY (v_used));
      IF v_id IS NOT NULL THEN
        v_map := v_map || jsonb_build_object(v_ord::text, v_id);
        v_used := v_used || v_id;
      END IF;
      v_id := NULL;
    END IF;
  END LOOP;
  -- Pass 2: lines sent without an id -- same account, debit and credit.
  FOR v_line, v_ord IN SELECT value, ordinality FROM jsonb_array_elements(v_lines) WITH ORDINALITY LOOP
    IF NOT (v_map ? v_ord::text) AND COALESCE(v_line ->> 'id', '') = '' THEN
      SELECT id INTO v_id FROM acct_journal_lines
       WHERE journal_entry_id = p_je_id AND NOT (id = ANY (v_used))
         AND account_id = (v_line ->> 'account_id')::uuid
         AND COALESCE(debit, 0)  = (v_line ->> 'debit')::numeric
         AND COALESCE(credit, 0) = (v_line ->> 'credit')::numeric
       ORDER BY id LIMIT 1;
      IF v_id IS NOT NULL THEN
        v_map := v_map || jsonb_build_object(v_ord::text, v_id);
        v_used := v_used || v_id;
      END IF;
      v_id := NULL;
    END IF;
  END LOOP;

  -- Old lines nobody kept.
  FOR v_old IN SELECT * FROM acct_journal_lines
                WHERE journal_entry_id = p_je_id AND NOT (id = ANY (v_used)) LOOP
    IF COALESCE(v_old.reconciled, false) THEN
      RAISE EXCEPTION 'A reconciled line (% %) cannot be removed. Unreconcile it first.',
        COALESCE(NULLIF(v_old.account_name, ''), 'account'), CASE WHEN COALESCE(v_old.debit, 0) <> 0 THEN 'DR ' || v_old.debit ELSE 'CR ' || v_old.credit END
        USING HINT = 'reconciled_line';
    END IF;
    IF v_old.bank_feed_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'The % line is linked to a bank transaction and cannot be removed here. Undo that transaction in Banking instead.',
        COALESCE(NULLIF(v_old.account_name, ''), 'bank-linked')
        USING HINT = 'bank_line';
    END IF;
  END LOOP;

  UPDATE acct_journal_entries
     SET date = v_new_date,
         description = COALESCE(p_header ->> 'description', v_je.description),
         reference = v_new_ref,
         property = COALESCE(p_header ->> 'property', v_je.property, ''),
         status = v_status
   WHERE id = p_je_id AND company_id = p_company_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'update_journal_entry: could not update the entry header';
  END IF;

  DELETE FROM acct_journal_lines
   WHERE journal_entry_id = p_je_id AND company_id = p_company_id AND NOT (id = ANY (v_used));
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  FOR v_line, v_ord IN SELECT value, ordinality FROM jsonb_array_elements(v_lines) WITH ORDINALITY LOOP
    IF v_map ? v_ord::text THEN
      SELECT * INTO v_old FROM acct_journal_lines WHERE id = (v_map ->> v_ord::text)::int;
      IF v_old.account_id IS DISTINCT FROM (v_line ->> 'account_id')::uuid
         OR COALESCE(v_old.debit, 0)  <> (v_line ->> 'debit')::numeric
         OR COALESCE(v_old.credit, 0) <> (v_line ->> 'credit')::numeric THEN
        IF COALESCE(v_old.reconciled, false) THEN
          RAISE EXCEPTION 'A reconciled line (% %) cannot change account or amount. Unreconcile it first.',
            COALESCE(NULLIF(v_old.account_name, ''), 'account'), CASE WHEN COALESCE(v_old.debit, 0) <> 0 THEN 'DR ' || v_old.debit ELSE 'CR ' || v_old.credit END
            USING HINT = 'reconciled_line';
        END IF;
        -- The stamp says "this line IS that bank transaction". Moving it to
        -- another account or amount would carry the claim onto a line that
        -- no longer is (the bank line quietly becoming Income).
        IF v_old.bank_feed_transaction_id IS NOT NULL THEN
          RAISE EXCEPTION 'The % line is linked to a bank transaction, so its account and amount cannot change here. Undo that transaction in Banking first.',
            COALESCE(NULLIF(v_old.account_name, ''), 'bank-linked')
            USING HINT = 'bank_line';
        END IF;
      END IF;
      -- Stamps (bank_feed_transaction_id, reconciled, reconciled_date) are
      -- left exactly as they are.
      UPDATE acct_journal_lines
         SET account_id   = (v_line ->> 'account_id')::uuid,
             account_name = COALESCE(v_line ->> 'account_name', ''),
             debit        = (v_line ->> 'debit')::numeric,
             credit       = (v_line ->> 'credit')::numeric,
             class_id     = NULLIF(v_line ->> 'class_id', ''),
             memo         = COALESCE(v_line ->> 'memo', ''),
             entity_type  = NULLIF(v_line ->> 'entity_type', ''),
             entity_id    = NULLIF(v_line ->> 'entity_id', ''),
             entity_name  = NULLIF(v_line ->> 'entity_name', '')
       WHERE id = v_old.id AND company_id = p_company_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'update_journal_entry: could not update line %', v_old.id;
      END IF;
      v_kept := v_kept + 1;
    ELSE
      INSERT INTO acct_journal_lines
        (journal_entry_id, company_id, account_id, account_name, debit, credit, class_id, memo,
         entity_type, entity_id, entity_name)
      VALUES
        (p_je_id, p_company_id, (v_line ->> 'account_id')::uuid, COALESCE(v_line ->> 'account_name', ''),
         (v_line ->> 'debit')::numeric, (v_line ->> 'credit')::numeric,
         NULLIF(v_line ->> 'class_id', ''), COALESCE(v_line ->> 'memo', ''),
         NULLIF(v_line ->> 'entity_type', ''), NULLIF(v_line ->> 'entity_id', ''),
         NULLIF(v_line ->> 'entity_name', ''));
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('outcome', 'updated', 'je_id', p_je_id,
                            'kept', v_kept, 'inserted', v_inserted, 'deleted', v_deleted);
END;
$function$;
REVOKE ALL ON FUNCTION public.update_journal_entry(text, text, jsonb, jsonb, int[], jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_journal_entry(text, text, jsonb, jsonb, int[], jsonb) TO authenticated, service_role;
