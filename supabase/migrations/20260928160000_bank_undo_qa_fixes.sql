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
--
-- All of it is database-wide. Production needs the owner's approval.

-- ---------------------------------------------------------------------------
-- 1. void_journal_entry
-- ---------------------------------------------------------------------------
-- Voids a posted/draft entry and releases every bank transaction that
-- claimed it: the transaction goes back to For Review, its links to this
-- entry (and any matched_to link) are deleted, its decisions are marked
-- undone, and all bank stamps on the entry's lines are cleared. Reconciled
-- flags on the entry's lines are cleared too (a voided line is not a match
-- for the next reconciliation). A transaction that is reconciled and
-- locked is left alone.
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

  -- Every transaction that claims this entry, locked in id order.
  SELECT array_agg(id ORDER BY id) INTO v_txns FROM (
    SELECT t.id FROM bank_feed_transaction t
     WHERE t.company_id = p_company_id
       AND t.status IN ('categorized', 'matched', 'posted')
       AND (t.journal_entry_id = v_uuid
            OR t.id IN (SELECT bank_feed_transaction_id FROM acct_journal_lines
                         WHERE journal_entry_id = p_je_id AND bank_feed_transaction_id IS NOT NULL)
            OR t.id IN (SELECT bank_feed_transaction_id FROM bank_feed_transaction_link
                         WHERE company_id = p_company_id AND linked_object_type = 'journal_entry'
                           AND linked_object_id = v_uuid))
     ORDER BY t.id
     FOR UPDATE OF t) s;

  UPDATE acct_journal_entries SET status = 'voided'
   WHERE id = p_je_id AND company_id = p_company_id AND status <> 'voided';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'void_journal_entry: could not void entry %', v_je.number;
  END IF;

  UPDATE acct_journal_lines
     SET reconciled = false, reconciled_date = NULL, bank_feed_transaction_id = NULL
   WHERE journal_entry_id = p_je_id AND company_id = p_company_id
     AND (COALESCE(reconciled, false) OR reconciled_date IS NOT NULL OR bank_feed_transaction_id IS NOT NULL);

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
