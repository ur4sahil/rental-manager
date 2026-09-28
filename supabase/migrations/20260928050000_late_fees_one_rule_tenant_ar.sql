-- Late fees: one duplicate rule, one reference, the tenant's own AR.
--
-- Three code paths charge late fees and until now none could see the others:
--   * Late Fees page      LATE-<tid>-YYYYMM      DR shared 1100 + manual balance bump
--   * Tenant "Late Fee"   LATEFEE-<tid>-YYYYMM   DR tenant's own AR
--   * this nightly job    LATEFEE-<tid>-YYYY-MM  DR shared 1100 + manual balance bump
-- Three references means the unique reference index never collided, and each
-- path's own duplicate check looked only for its own shape, so running two
-- of them in one month charged the tenant twice.
--
-- The rule now, identical here and in src/utils/lateFeeRules.js
-- (lateFeeAlreadyPostedInMonth -- change one, change the other):
--   a tenant already has a late fee for month M if ANY non-voided journal
--   entry dated in M
--     (a) has reference LATEFEE-<tid>-YYYYMM, LATEFEE-<tid>-YYYY-MM or
--         LATE-<tid>-YYYYMM, or
--     (b) debits one of the tenant's own AR accounts (acct_accounts.tenant_id
--         = tenant) AND credits the company's late-fee income account
--         (code 4010 or name 'Late Fee Income') -- this catches late fees
--         typed in by hand, which carry no reference.
-- New fees use LATEFEE-<tid>-YYYYMM only, and idx_je_company_reference_unique
-- stays the final backstop.
--
-- New fees debit the tenant's own AR account, never the shared 1100. The
-- sync_tenant_balance_lines trigger then recomputes tenants.balance from the
-- GL, so the manual `balance = balance + fee` is gone -- keeping it would
-- count the fee twice.

-- ── 1. the duplicate rule ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.late_fee_already_posted(p_company_id text, p_tenant_id bigint, p_month text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH m AS (
    SELECT to_date(p_month || '-01', 'YYYY-MM-DD') AS s,
           (to_date(p_month || '-01', 'YYYY-MM-DD') + interval '1 month')::date AS e
  )
  SELECT
    -- (a) any of the three late-fee references for this tenant and month
    EXISTS (
      SELECT 1 FROM acct_journal_entries je, m
       WHERE je.company_id = p_company_id
         AND je.status IS DISTINCT FROM 'voided'
         AND je.date >= m.s AND je.date < m.e
         AND je.reference IN (
               'LATEFEE-' || p_tenant_id::text || '-' || replace(p_month, '-', ''),
               'LATEFEE-' || p_tenant_id::text || '-' || p_month,
               'LATE-'    || p_tenant_id::text || '-' || replace(p_month, '-', ''))
    )
    -- (b) DR the tenant's own AR / CR late-fee income, whatever the reference
    OR EXISTS (
      SELECT 1
        FROM acct_accounts ar
        JOIN acct_journal_lines dl ON dl.account_id = ar.id
        JOIN acct_journal_entries je ON je.id = dl.journal_entry_id
        CROSS JOIN m
       WHERE ar.company_id = p_company_id
         AND ar.tenant_id = p_tenant_id
         AND coalesce(dl.debit, 0) > 0
         AND je.company_id = p_company_id
         AND je.status IS DISTINCT FROM 'voided'
         AND je.date >= m.s AND je.date < m.e
         AND EXISTS (
           SELECT 1 FROM acct_journal_lines cl
             JOIN acct_accounts inc ON inc.id = cl.account_id
            WHERE cl.journal_entry_id = je.id
              AND inc.company_id = p_company_id
              AND (inc.code = '4010' OR inc.name = 'Late Fee Income')
              AND coalesce(cl.credit, 0) > 0)
    );
$function$;
REVOKE ALL ON FUNCTION public.late_fee_already_posted(text, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.late_fee_already_posted(text, bigint, text) TO authenticated, service_role;

-- ── 2. the tenant's own AR account (find, adopt or create) ───────────────
-- Mirrors getOrCreateTenantAR (src/utils/accounting.js):
--   1. an Asset account with tenant_id = tenant (active first, lowest code);
--   2. a legacy unlinked 'AR - <name>' Asset account, adopted only when it is
--      the only one with that name and no other live tenant shares the name;
--   3. otherwise create '1100-NNN' 'AR - <name> (<street>)' under 1100.
-- Two deliberate differences: step 2 never adopts an account already linked
-- to a DIFFERENT tenant (the JS returns it anyway), and the next NNN is the
-- numeric max rather than the text max ('1100-999' sorts above '1100-1000').
-- Returns NULL if nothing could be established; the caller then skips the
-- tenant rather than posting to the shared 1100.
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
    v_code := '1100-' || lpad(v_seq::text, 3, '0');
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

-- ── 3. the nightly job ───────────────────────────────────────────────────
-- Unchanged: who is eligible, the rule lookup, grace, the fee amount.
-- Changed: the duplicate check, the reference, the AR leg, no manual balance
-- update, next_je_number with a number-only collision retry.
CREATE OR REPLACE FUNCTION public.batch_post_late_fees(p_company_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $function$
DECLARE
  v_t RECORD; v_rule RECORD;
  v_today DATE := CURRENT_DATE;
  v_month TEXT := to_char(v_today, 'YYYY-MM');
  v_ref TEXT;
  v_fee NUMERIC; v_je_id TEXT; v_je_number TEXT; v_class_id TEXT;
  v_ar_id uuid; v_ar_name text; v_income_id uuid; v_income_name text;
  v_attempt INTEGER; v_count INTEGER := 0; v_skipped INTEGER := 0;
  v_constraint TEXT;
  v_no_ar jsonb := '[]'::jsonb;
BEGIN
  -- Company staff OR the scheduled job (service key).
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id AND lower(user_email) = lower(auth.jwt()->>'email')
      AND status = 'active' AND role IN ('admin','office_assistant','accountant')
  ) THEN RAISE EXCEPTION 'Access denied: insufficient role for this operation'; END IF;

  SELECT * INTO v_rule FROM late_fee_rules
   WHERE company_id = p_company_id AND archived_at IS NULL AND coalesce(is_active, true) ORDER BY created_at LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'fees_posted', 0, 'reason', 'no late fee rule configured');
  END IF;
  IF coalesce(v_rule.fee_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('success', true, 'fees_posted', 0, 'reason', 'late fee rule has no fee amount configured');
  END IF;
  IF EXTRACT(DAY FROM v_today)::int <= coalesce(v_rule.grace_days, 0) THEN
    RETURN jsonb_build_object('success', true, 'fees_posted', 0,
      'reason', format('within grace period (day %s of %s)', EXTRACT(DAY FROM v_today)::int, v_rule.grace_days));
  END IF;

  -- Income account: code 4010 first, then the name -- the order the app's
  -- resolveAccountId('4010') uses, so both paths credit the same account.
  SELECT id, name INTO v_income_id, v_income_name FROM acct_accounts
   WHERE company_id = p_company_id AND code = '4010' LIMIT 1;
  IF v_income_id IS NULL THEN
    SELECT id, name INTO v_income_id, v_income_name FROM acct_accounts
     WHERE company_id = p_company_id AND name = 'Late Fee Income' LIMIT 1;
  END IF;
  IF v_income_id IS NULL THEN
    RAISE EXCEPTION 'Missing required account (Late Fee Income) for company %', p_company_id;
  END IF;

  FOR v_t IN
    SELECT id, name, property, rent, balance FROM tenants
    WHERE company_id = p_company_id AND archived_at IS NULL
      AND lease_status IN ('active','current') AND coalesce(balance,0) > 0
  LOOP
    IF public.late_fee_already_posted(p_company_id, v_t.id, v_month) THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    IF v_rule.fee_type = 'flat' THEN v_fee := v_rule.fee_amount;
    ELSE
      IF coalesce(v_t.rent, 0) <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
      v_fee := round(v_t.rent * v_rule.fee_amount) / 100.0;
    END IF;
    IF v_fee IS NULL OR v_fee <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    -- The tenant's own AR. No fallback to the shared 1100: a tenant whose
    -- account cannot be established is skipped and reported.
    v_ar_id := public._late_fee_tenant_ar(p_company_id, v_t.id, v_t.name, v_t.property);
    IF v_ar_id IS NULL THEN
      v_skipped := v_skipped + 1;
      v_no_ar := v_no_ar || jsonb_build_array(v_t.id);
      CONTINUE;
    END IF;
    SELECT name INTO v_ar_name FROM acct_accounts WHERE id = v_ar_id;

    SELECT id INTO v_class_id FROM acct_classes WHERE company_id = p_company_id AND name = v_t.property LIMIT 1;

    v_ref := 'LATEFEE-' || v_t.id::text || '-' || replace(v_month, '-', '');
    v_je_id := NULL;
    v_attempt := 0;
    LOOP
      v_je_number := next_je_number(p_company_id);
      BEGIN
        INSERT INTO acct_journal_entries (number, date, description, reference, property, status, company_id, transaction_type)
        VALUES (v_je_number, v_today,
                'Late fee — ' || v_t.name || ' — ' || coalesce(v_t.property,''),
                v_ref, v_t.property, 'posted', p_company_id, 'late_fee')
        RETURNING id INTO v_je_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        -- The reference is already on the books (a racing path posted it):
        -- that is the backstop doing its job, not an error. Skip the tenant.
        IF v_constraint = 'idx_je_company_reference_unique' THEN v_je_id := NULL; EXIT; END IF;
        IF v_constraint <> 'unique_je_number_per_company' THEN RAISE; END IF;
        v_attempt := v_attempt + 1;
        IF v_attempt >= 5 THEN
          RAISE EXCEPTION 'batch_post_late_fees: could not allocate a JE number after 5 attempts';
        END IF;
      END;
    END LOOP;

    IF v_je_id IS NULL THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    -- DR the tenant's own AR / CR Late Fee Income. The balance-sync
    -- trigger on acct_journal_lines recomputes tenants.balance from the GL.
    INSERT INTO acct_journal_lines (journal_entry_id, account_id, account_name, debit, credit, class_id, memo, entity_type, entity_id, entity_name, company_id)
    VALUES
      (v_je_id, v_ar_id, coalesce(v_ar_name, 'Accounts Receivable'), v_fee, 0, v_class_id, 'Late fee — ' || v_month, 'customer', v_t.id::text, v_t.name, p_company_id),
      (v_je_id, v_income_id, coalesce(v_income_name, 'Late Fee Income'), 0, v_fee, v_class_id, 'Late fee — ' || v_month, 'customer', v_t.id::text, v_t.name, p_company_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'fees_posted', v_count, 'skipped', v_skipped, 'month', v_month,
                            'skipped_no_ar_account', v_no_ar);
END;
$function$;
-- Server-only: the browser never calls it (the cron does, with the service key).
REVOKE ALL ON FUNCTION public.batch_post_late_fees(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.batch_post_late_fees(text) TO service_role;

-- ── 4. apply_late_fee_atomic: dead, and the last manual balance bump ─────
-- No caller in src/ or api/. It could not have worked for years: it takes
-- the tenant id as uuid (tenants.id is bigint), inserts into ledger_entries
-- (now a view) without account_name (NOT NULL), and then bumps the balance
-- by hand through update_tenant_balance. Server-only since 20260928040000.
DROP FUNCTION IF EXISTS public.apply_late_fee_atomic(text, uuid, text, text, numeric, text, text, text, text, uuid, uuid, uuid);
