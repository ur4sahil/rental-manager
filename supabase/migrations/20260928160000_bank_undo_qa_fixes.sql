-- QA follow-ups to 20260928110000 (bank undo / match / JE edit), plus one
-- late-fee fix. The function changes to undo_bank_transaction and
-- update_journal_entry were made in 110000 itself (it has not reached
-- production); this file holds what is new:
--
--   1. void_journal_entry: Void in Accounting as ONE transaction. The old
--      client chain voided the entry and sent its bank transactions back to
--      For Review, but left their matched_to link and their 'posted'
--      decision behind. A later Undo then read that stale link as "matched"
--      and left a new BANK- posting on the books.
--   2. A one-time cleanup of such stale matched_to links and decisions.
--      Safe and idempotent: it only touches links/decisions whose bank
--      transaction no longer points at them.
--   3. trg_jl_scope_guard: a journal line's account and class must belong
--      to the line's company, and the line's company must be its entry's.
--      update_journal_entry and post_bank_transaction (and every client
--      insert) accepted another company's account id -- a line could be
--      moved onto another company's tenant AR.
--   4. _late_fee_tenant_ar: lpad() TRUNCATES, so tenant AR code 1100-1009
--      came out as '1100-100', collided, and every later new tenant got
--      NULL (never charged a late fee).
--   5. post_bank_transaction refuses NaN / Infinity and two-sided lines,
--      and is the only writer of BANK-/XFER-/SPLIT- references;
--   6. trg_je_bank_reference_guard refuses them from anywhere else.
--   7. chk_jl_amounts_finite: journal amounts must be finite numbers.
--
-- All of it is database-wide. Production needs the owner's approval.

-- ---------------------------------------------------------------------------
-- 1. void_journal_entry
-- ---------------------------------------------------------------------------
-- Voids a posted/draft entry and releases every bank transaction that
-- claimed it: the transaction goes back to For Review, its links to this
-- entry (and any matched_to link) are deleted, its decisions are marked
-- undone, and all bank stamps on the entry's lines are cleared.
--
-- Refused (nothing written), as Undo refuses:
--   * an entry claimed by a reconciled/LOCKED bank transaction -- voiding
--     it would leave that transaction pointing at a voided entry (hint
--     'locked');
--   * an entry with reconciled lines -- it would silently break a
--     finished reconciliation; unreconcile first (hint 'reconciled').
--
-- SECURITY INVOKER: RLS, the period-lock triggers and trg_mgmt_gate apply
-- to the caller; any of them raising rolls everything back.
-- Tenant balances and the source record (payment, bill ...) are not
-- touched here -- the caller handles those as before (audit item G3).
CREATE OR REPLACE FUNCTION public.void_journal_entry(
  p_company_id text,
  p_je_id      text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_je     acct_journal_entries%ROWTYPE;
  v_uuid   uuid;
  v_txns   uuid[];
  v_n      int;
BEGIN
  PERFORM public._bank_require_staff(p_company_id);

  SELECT * INTO v_je FROM acct_journal_entries
   WHERE id = p_je_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'void_journal_entry: entry not found' USING HINT = 'not_found';
  END IF;
  IF v_je.status = 'voided' THEN
    RETURN jsonb_build_object('outcome', 'already_voided', 'je_id', p_je_id, 'txn_ids', '[]'::jsonb);
  END IF;

  -- bank_feed_transaction.journal_entry_id and link ids are uuid; a legacy
  -- entry id (je-seed-...) can only be reached through line stamps.
  IF p_je_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_uuid := p_je_id::uuid;
  END IF;

  -- Every transaction that claims this entry (any status), locked in id
  -- order.
  SELECT array_agg(id ORDER BY id) INTO v_txns FROM (
    SELECT t.id FROM bank_feed_transaction t
     WHERE t.company_id = p_company_id
       AND (t.journal_entry_id = v_uuid
            OR t.id IN (SELECT bank_feed_transaction_id FROM acct_journal_lines
                         WHERE journal_entry_id = p_je_id AND bank_feed_transaction_id IS NOT NULL)
            OR t.id IN (SELECT bank_feed_transaction_id FROM bank_feed_transaction_link
                         WHERE company_id = p_company_id AND linked_object_type = 'journal_entry'
                           AND linked_object_id = v_uuid))
     ORDER BY t.id
     FOR UPDATE OF t) s;

  IF EXISTS (SELECT 1 FROM bank_feed_transaction WHERE id = ANY (COALESCE(v_txns, '{}')) AND status = 'locked') THEN
    RAISE EXCEPTION 'Entry % belongs to a reconciled bank transaction and cannot be voided. Unreconcile it first.', v_je.number
      USING ERRCODE = 'P0001', HINT = 'locked';
  END IF;
  IF EXISTS (SELECT 1 FROM acct_journal_lines WHERE journal_entry_id = p_je_id AND COALESCE(reconciled, false)) THEN
    RAISE EXCEPTION 'Entry % has reconciled lines. Unreconcile them before voiding it.', v_je.number
      USING ERRCODE = 'P0001', HINT = 'reconciled';
  END IF;
  -- Only these go back to For Review; a For Review / excluded txn that
  -- merely still has a link is just unlinked below.
  SELECT array_agg(id ORDER BY id) INTO v_txns FROM bank_feed_transaction
   WHERE id = ANY (COALESCE(v_txns, '{}')) AND status IN ('categorized', 'matched', 'posted');

  UPDATE acct_journal_entries SET status = 'voided'
   WHERE id = p_je_id AND company_id = p_company_id AND status <> 'voided';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'void_journal_entry: could not void entry %', v_je.number;
  END IF;

  UPDATE acct_journal_lines
     SET bank_feed_transaction_id = NULL
   WHERE journal_entry_id = p_je_id AND company_id = p_company_id
     AND bank_feed_transaction_id IS NOT NULL;

  -- Links to this entry from any transaction that is not reconciled.
  IF v_uuid IS NOT NULL THEN
    DELETE FROM bank_feed_transaction_link k
     WHERE k.company_id = p_company_id AND k.linked_object_type = 'journal_entry'
       AND k.linked_object_id = v_uuid
       AND NOT EXISTS (SELECT 1 FROM bank_feed_transaction t
                        WHERE t.id = k.bank_feed_transaction_id AND t.status = 'locked');
  END IF;

  IF v_txns IS NOT NULL THEN
    -- A released transaction claims nothing: no matched_to link anywhere.
    DELETE FROM bank_feed_transaction_link
     WHERE company_id = p_company_id AND bank_feed_transaction_id = ANY (v_txns)
       AND link_role = 'matched_to';

    UPDATE bank_posting_decision d SET status = 'undone', updated_at = now()
      FROM bank_feed_transaction t
     WHERE d.company_id = p_company_id AND t.id = d.bank_feed_transaction_id
       AND t.id = ANY (v_txns)
       AND (d.id = t.posting_decision_id OR d.status = 'posted')
       AND d.status IS DISTINCT FROM 'undone';

    UPDATE bank_feed_transaction
       SET status = 'for_review', accepted_at = NULL, accepted_by = NULL,
           journal_entry_id = NULL, posting_decision_id = NULL,
           matched_target_type = NULL, matched_target_id = NULL
     WHERE company_id = p_company_id AND id = ANY (v_txns);
  END IF;

  RETURN jsonb_build_object('outcome', 'voided', 'je_id', p_je_id, 'je_number', v_je.number,
                            'txn_ids', COALESCE(to_jsonb(v_txns), '[]'::jsonb));
END;
$function$;
REVOKE ALL ON FUNCTION public.void_journal_entry(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_journal_entry(text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. One-time cleanup of stale matched_to links and decisions
-- ---------------------------------------------------------------------------
-- A matched_to link is live only while its transaction is still matched
-- (or matched and since reconciled/locked) to THAT entry. Anything else is
-- a leftover of the old client-side void and is what made Undo skip the
-- void. Likewise a 'match' decision still 'posted' for a transaction back
-- in For Review. Re-running this finds nothing.
DO $cleanup$
DECLARE
  v_links int;
  v_decisions int;
BEGIN
  DELETE FROM bank_feed_transaction_link k
   USING bank_feed_transaction t
   WHERE t.id = k.bank_feed_transaction_id
     AND k.link_role = 'matched_to'
     AND NOT (t.status IN ('matched', 'locked') AND t.journal_entry_id IS NOT DISTINCT FROM k.linked_object_id);
  GET DIAGNOSTICS v_links = ROW_COUNT;

  UPDATE bank_posting_decision d SET status = 'undone', updated_at = now()
    FROM bank_feed_transaction t
   WHERE t.id = d.bank_feed_transaction_id
     AND t.status = 'for_review'
     AND d.status = 'posted';
  GET DIAGNOSTICS v_decisions = ROW_COUNT;

  RAISE NOTICE 'stale matched_to links removed: %, stale posted decisions undone: %', v_links, v_decisions;
END;
$cleanup$;

-- ---------------------------------------------------------------------------
-- 3. Journal lines stay inside their company
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER only to read acct_accounts / acct_classes /
-- acct_journal_entries regardless of RLS (a row the caller can't see must
-- still be refused, not waved through); it never reads current_user.
-- Named to sort after trg_jl_company_id, which fills company_id from the
-- entry on insert (BEFORE triggers fire in name order).
CREATE OR REPLACE FUNCTION public.trg_jl_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_co text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
     AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id
     AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
     AND NEW.class_id IS NOT DISTINCT FROM OLD.class_id THEN
    RETURN NEW;
  END IF;

  SELECT company_id INTO v_co FROM acct_journal_entries WHERE id = NEW.journal_entry_id;
  IF FOUND AND v_co IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'A journal line must belong to the same company as its entry.'
      USING ERRCODE = 'check_violation', HINT = 'cross_company';
  END IF;

  IF NEW.account_id IS NOT NULL THEN
    SELECT company_id INTO v_co FROM acct_accounts WHERE id = NEW.account_id;
    IF FOUND AND v_co IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'That account belongs to another company.'
        USING ERRCODE = 'check_violation', HINT = 'cross_company';
    END IF;
  END IF;

  IF NEW.class_id IS NOT NULL THEN
    SELECT company_id INTO v_co FROM acct_classes WHERE id = NEW.class_id;
    IF FOUND AND v_co IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'That class belongs to another company.'
        USING ERRCODE = 'check_violation', HINT = 'cross_company';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_jl_scope_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_jl_scope_guard ON public.acct_journal_lines;
CREATE TRIGGER trg_jl_scope_guard
  BEFORE INSERT OR UPDATE ON public.acct_journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.trg_jl_scope_guard();

-- ---------------------------------------------------------------------------
-- 4. _late_fee_tenant_ar: codes past 1100-999
-- ---------------------------------------------------------------------------
-- Identical to 20260928050000 except the lpad width, which now matches the
-- JS side (String(n).padStart(3, "0") never truncates).
CREATE OR REPLACE FUNCTION public._late_fee_tenant_ar(p_company_id text, p_tenant_id bigint, p_tenant_name text, p_property text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid; v_parent uuid; v_seq int; v_code text; v_name text; v_short text;
  v_attempt int := 0; v_cnt int;
BEGIN
  IF p_tenant_id IS NULL THEN RETURN NULL; END IF;
  LOOP
    v_attempt := v_attempt + 1;
    -- 1. linked account
    SELECT id INTO v_id FROM acct_accounts
     WHERE company_id = p_company_id AND type = 'Asset' AND tenant_id = p_tenant_id
     ORDER BY (is_active IS NOT FALSE) DESC, code NULLS LAST, id::text
     LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    IF v_attempt > 5 THEN RETURN NULL; END IF;

    -- 2. legacy account by name
    IF coalesce(p_tenant_name, '') <> '' THEN
      SELECT count(*) INTO v_cnt FROM acct_accounts
       WHERE company_id = p_company_id AND type = 'Asset' AND name = 'AR - ' || p_tenant_name;
      IF v_cnt = 1 THEN
        SELECT id INTO v_id FROM acct_accounts
         WHERE company_id = p_company_id AND type = 'Asset' AND name = 'AR - ' || p_tenant_name
           AND tenant_id IS NULL;
        IF v_id IS NOT NULL
           AND (SELECT count(*) FROM tenants
                 WHERE company_id = p_company_id AND name = p_tenant_name AND archived_at IS NULL) <= 1 THEN
          BEGIN
            UPDATE acct_accounts SET tenant_id = p_tenant_id WHERE id = v_id;
            RETURN v_id;
          EXCEPTION WHEN unique_violation THEN
            v_id := NULL;  -- raced: someone else linked one; loop re-reads step 1
            CONTINUE;
          END;
        END IF;
        v_id := NULL;
      END IF;
    END IF;

    -- 3. create
    SELECT id INTO v_parent FROM acct_accounts
     WHERE company_id = p_company_id AND code = '1100' LIMIT 1;
    IF v_parent IS NULL THEN
      SELECT id INTO v_parent FROM acct_accounts
       WHERE company_id = p_company_id AND name = 'Accounts Receivable' AND tenant_id IS NULL LIMIT 1;
    END IF;
    SELECT coalesce(max(substring(code FROM '^1100-(\d+)$')::int), 0) + 1 INTO v_seq
      FROM acct_accounts WHERE company_id = p_company_id AND code ~ '^1100-\d+$';
    -- lpad(s, 3) cuts '1009' to '100'; pad only when shorter than 3.
    v_code := '1100-' || lpad(v_seq::text, greatest(3, length(v_seq::text)), '0');
    v_name := 'AR - ' || coalesce(p_tenant_name, '');
    v_short := btrim(split_part(coalesce(p_property, ''), ',', 1));
    IF v_short <> '' THEN v_name := v_name || ' (' || v_short || ')'; END IF;
    BEGIN
      INSERT INTO acct_accounts (company_id, code, name, type, is_active, old_text_id, parent_id, tenant_id)
      VALUES (p_company_id, v_code, v_name, 'Asset', true, p_company_id || '-' || v_code, v_parent, p_tenant_id)
      RETURNING id INTO v_id;
      RETURN v_id;
    EXCEPTION WHEN unique_violation THEN
      -- code taken, or the one-active-AR guard: another writer got there
      -- first. Re-read step 1, then try the next code.
      v_id := NULL;
    END;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public._late_fee_tenant_ar(text, bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._late_fee_tenant_ar(text, bigint, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. post_bank_transaction: finite amounts, one side per line, and the
--    bank-reference flag
-- ---------------------------------------------------------------------------
-- Identical to 20260928010000 except: non-finite amounts (hint
-- 'bad_amount') and a line with both a debit and a credit ('both_sides')
-- are refused, and the header insert runs with app.bank_posting = on so
-- trg_je_bank_reference_guard lets its BANK-/XFER-/SPLIT- reference in.
CREATE OR REPLACE FUNCTION public.post_bank_transaction(
  p_company_id     text,
  p_txn_id         uuid,
  p_kind           text,             -- 'add' | 'transfer' | 'split'
  p_description    text,
  p_property       text  DEFAULT '',
  p_lines          jsonb DEFAULT '[]'::jsonb,  -- JE lines, bank side included
  p_decision       jsonb DEFAULT '{}'::jsonb,  -- payee, memo, header_class_id, transfer_gl_account_id
  p_decision_lines jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_txn          bank_feed_transaction%ROWTYPE;
  v_ref          text;
  v_prior_id     text;
  v_prior_lines  int;
  v_je_id        text;
  v_je_number    text;
  v_decision_id  uuid;
  v_attempt      int := 0;
  v_line         jsonb;
  v_ord          bigint;
  v_email        text := COALESCE(auth.jwt() ->> 'email', '');
  v_constraint   text;
  v_dr           numeric;
  v_cr           numeric;
BEGIN
  IF p_kind NOT IN ('add', 'transfer', 'split') THEN
    RAISE EXCEPTION 'post_bank_transaction: unknown kind %', p_kind;
  END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'post_bank_transaction: a journal entry needs at least 2 lines';
  END IF;
  -- Amounts must be real numbers (NaN = NaN in Postgres, so a NaN line
  -- would pass the balance check) and on one side of a line only.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
              WHERE NOT public.je_amount_is_finite(NULLIF(l ->> 'debit', '')::numeric)
                 OR NOT public.je_amount_is_finite(NULLIF(l ->> 'credit', '')::numeric)) THEN
    RAISE EXCEPTION 'post_bank_transaction: every amount must be a number' USING ERRCODE = 'P0001', HINT = 'bad_amount';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
              WHERE COALESCE(NULLIF(l ->> 'debit', '')::numeric, 0) > 0 AND COALESCE(NULLIF(l ->> 'credit', '')::numeric, 0) > 0) THEN
    RAISE EXCEPTION 'post_bank_transaction: a line can have a debit or a credit, not both' USING ERRCODE = 'P0001', HINT = 'both_sides';
  END IF;

  -- DR must equal CR. The split path used to allow 2c/10c of slack, which
  -- posted the bank line at the full amount and the category lines short:
  -- an unbalanced entry. Refused here so no caller can post one.
  SELECT COALESCE(sum((l ->> 'debit')::numeric), 0), COALESCE(sum((l ->> 'credit')::numeric), 0)
    INTO v_dr, v_cr FROM jsonb_array_elements(p_lines) l;
  IF abs(v_dr - v_cr) > 0.005 THEN
    RAISE EXCEPTION 'post_bank_transaction: entry out of balance (DR % vs CR %)', v_dr, v_cr
      USING ERRCODE = 'P0001', HINT = 'unbalanced';
  END IF;

  -- Serialises concurrent posts of the same txn (two tabs, a double click
  -- that slipped the client guard, an auto-accept rule racing a human).
  SELECT * INTO v_txn FROM bank_feed_transaction
   WHERE id = p_txn_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'post_bank_transaction: transaction not found';
  END IF;

  v_ref := CASE p_kind WHEN 'add' THEN 'BANK-' WHEN 'transfer' THEN 'XFER-' ELSE 'SPLIT-' END
           || p_txn_id::text;

  -- The reference index excludes voided entries, so an undone post
  -- (voided JE) does not count as prior.
  SELECT id INTO v_prior_id FROM acct_journal_entries
   WHERE company_id = p_company_id AND reference = v_ref AND status <> 'voided'
   LIMIT 1;

  IF v_txn.status <> 'for_review' THEN
    IF v_prior_id IS NOT NULL AND v_txn.journal_entry_id::text = v_prior_id THEN
      RETURN jsonb_build_object('outcome', 'already_posted', 'je_id', v_prior_id);
    END IF;
    RAISE EXCEPTION 'post_bank_transaction: transaction already processed (status %)', v_txn.status
      USING ERRCODE = 'P0001', HINT = 'already_processed';
  END IF;

  IF v_prior_id IS NOT NULL THEN
    SELECT count(*) INTO v_prior_lines FROM acct_journal_lines
     WHERE journal_entry_id = v_prior_id;
    IF v_prior_lines = 0 THEN
      DELETE FROM acct_journal_entries WHERE id = v_prior_id AND company_id = p_company_id;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM bank_feed_transaction_link
                      WHERE bank_feed_transaction_id = p_txn_id
                        AND linked_object_type = 'journal_entry'
                        AND linked_object_id::text = v_prior_id) THEN
        INSERT INTO bank_feed_transaction_link
          (company_id, bank_feed_transaction_id, linked_object_type, linked_object_id, link_role)
        VALUES (p_company_id, p_txn_id, 'journal_entry', v_prior_id::uuid, 'created_from');
      END IF;
      UPDATE bank_feed_transaction
         SET status = 'categorized', accepted_at = now(), accepted_by = v_email,
             journal_entry_id = v_prior_id::uuid
       WHERE id = p_txn_id AND company_id = p_company_id;
      RETURN jsonb_build_object('outcome', 'relinked', 'je_id', v_prior_id);
    END IF;
  END IF;

  -- Header. Retry only a NUMBER collision (next_je_number is MAX-based and
  -- can race); a reference collision can't happen past the check above
  -- while we hold the txn lock, and if it somehow does, re-rolling the
  -- number would not fix it -- let it raise.
  -- BANK-/XFER-/SPLIT- references are reserved for this function
  -- (trg_je_bank_reference_guard); the flag is transaction-local and
  -- switched off again straight after the insert.
  PERFORM set_config('app.bank_posting', 'on', true);
  LOOP
    v_je_number := next_je_number(p_company_id);
    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
      VALUES (p_company_id, v_je_number, v_txn.posted_date, COALESCE(p_description, ''),
              v_ref, COALESCE(p_property, ''), 'posted')
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint <> 'unique_je_number_per_company' THEN RAISE; END IF;
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION 'post_bank_transaction: could not allocate a JE number after 5 attempts';
      END IF;
    END;
  END LOOP;
  PERFORM set_config('app.bank_posting', 'off', true);

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO acct_journal_lines
      (journal_entry_id, company_id, account_id, account_name, debit, credit, class_id, memo,
       entity_type, entity_id, entity_name, bank_feed_transaction_id)
    VALUES
      (v_je_id, p_company_id, (v_line ->> 'account_id')::uuid, COALESCE(v_line ->> 'account_name', ''),
       COALESCE((v_line ->> 'debit')::numeric, 0), COALESCE((v_line ->> 'credit')::numeric, 0),
       NULLIF(v_line ->> 'class_id', ''), COALESCE(v_line ->> 'memo', ''),
       NULLIF(v_line ->> 'entity_type', ''), NULLIF(v_line ->> 'entity_id', ''),
       NULLIF(v_line ->> 'entity_name', ''), p_txn_id);
  END LOOP;

  INSERT INTO bank_posting_decision
    (company_id, bank_feed_transaction_id, decision_type, payee, memo,
     header_class_id, transfer_gl_account_id, status, created_by)
  VALUES
    (p_company_id, p_txn_id, p_kind, COALESCE(p_decision ->> 'payee', ''), COALESCE(p_decision ->> 'memo', ''),
     CASE WHEN p_decision ->> 'header_class_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN (p_decision ->> 'header_class_id')::uuid END,
     NULLIF(p_decision ->> 'transfer_gl_account_id', '')::uuid,
     'posted', v_email)
  RETURNING id INTO v_decision_id;

  FOR v_line, v_ord IN SELECT value, ordinality FROM jsonb_array_elements(p_decision_lines) WITH ORDINALITY LOOP
    INSERT INTO bank_posting_decision_line
      (company_id, bank_posting_decision_id, line_no, gl_account_id, gl_account_name,
       amount, entry_side, memo, class_id)
    VALUES
      (p_company_id, v_decision_id, COALESCE((v_line ->> 'line_no')::int, v_ord::int),
       NULLIF(v_line ->> 'gl_account_id', '')::uuid, COALESCE(v_line ->> 'gl_account_name', ''),
       COALESCE((v_line ->> 'amount')::numeric, 0), COALESCE(v_line ->> 'entry_side', 'debit'),
       COALESCE(v_line ->> 'memo', ''),
       CASE WHEN v_line ->> 'class_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (v_line ->> 'class_id')::uuid END);
  END LOOP;

  INSERT INTO bank_feed_transaction_link
    (company_id, bank_feed_transaction_id, linked_object_type, linked_object_id, link_role)
  VALUES (p_company_id, p_txn_id, 'journal_entry', v_je_id::uuid, 'created_from');

  UPDATE bank_feed_transaction
     SET status = 'categorized', accepted_at = now(), accepted_by = v_email,
         journal_entry_id = v_je_id::uuid, posting_decision_id = v_decision_id
   WHERE id = p_txn_id AND company_id = p_company_id;

  RETURN jsonb_build_object('outcome', 'posted', 'je_id', v_je_id, 'decision_id', v_decision_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.post_bank_transaction(text, uuid, text, text, text, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_bank_transaction(text, uuid, text, text, text, jsonb, jsonb, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Bank references can only come from post_bank_transaction
-- ---------------------------------------------------------------------------
-- A manual entry (or an edit) carrying BANK-/XFER-/SPLIT-<txn id> made
-- post_bank_transaction "relink" that transaction to it, and Undo then
-- voided it -- a tenant receipt, say. The prefix is matched trimmed and
-- case-insensitively. Only an INSERT or a change of reference is checked,
-- so existing bank entries still void, post and rename as before. The one
-- writer that sets the flag is post_bank_transaction (grep: no client,
-- API route or other SQL function writes these prefixes;
-- scripts/ar-backfill/apply-6027-categories.js, a finished one-off, did and
-- would now be refused). Not SECURITY DEFINER: it reads only NEW/OLD and a
-- setting.
CREATE OR REPLACE FUNCTION public.trg_je_bank_reference_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.reference IS NOT NULL
     AND NEW.reference ~* '^\s*(BANK|XFER|SPLIT)-'
     AND (TG_OP = 'INSERT' OR NEW.reference IS DISTINCT FROM OLD.reference)
     AND COALESCE(current_setting('app.bank_posting', true), '') <> 'on' THEN
    RAISE EXCEPTION 'References starting BANK-, XFER- or SPLIT- are reserved for entries Banking creates. Choose another reference.'
      USING ERRCODE = 'check_violation', HINT = 'system_reference';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.trg_je_bank_reference_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_je_bank_reference_guard ON public.acct_journal_entries;
CREATE TRIGGER trg_je_bank_reference_guard
  BEFORE INSERT OR UPDATE OF reference ON public.acct_journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.trg_je_bank_reference_guard();

-- ---------------------------------------------------------------------------
-- 7. Journal amounts are finite
-- ---------------------------------------------------------------------------
-- Every path, not just the two RPCs: a NaN debit turned a whole Checking
-- balance into NaN. Added NOT VALID then validated (0 violating rows on
-- TEST when written); re-running is a no-op.
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.acct_journal_lines'::regclass AND conname = 'chk_jl_amounts_finite') THEN
    ALTER TABLE public.acct_journal_lines
      ADD CONSTRAINT chk_jl_amounts_finite
      CHECK (public.je_amount_is_finite(debit) AND public.je_amount_is_finite(credit)) NOT VALID;
  END IF;
END;
$chk$;
ALTER TABLE public.acct_journal_lines VALIDATE CONSTRAINT chk_jl_amounts_finite;
