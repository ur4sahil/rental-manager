-- Late fees: the nightly job and the app pick the same row and the same cent.
--
-- batch_post_late_fees is recreated from 20260928050000 with four edits and
-- nothing else (REVOKE/GRANT exactly as there):
--
--   1. Rule:     ORDER BY created_at, id   (was created_at only -- two rules
--                created in the same instant came back in any order).
--   2. Due day:  leases ORDER BY start_date DESC NULLS LAST, id   (id added);
--                rent-schedule fallback ORDER BY created_at, id   (it had a
--                LIMIT 1 with no ORDER BY at all).
--   3. Percent:  v_fee := round(round(rent * pct) / 100, 2)
--                (was round(rent * pct) / 100.0). The SAME value for every
--                input -- round(x) is an integer, so /100 is exact and the
--                outer round(.., 2) only fixes the scale -- but it is now
--                stored as 63.75, not 63.7500000000000000.
--
-- The app does the same (src/utils/lateFeeRules.js: LATE_FEE_RULE_ORDER,
-- LATE_FEE_LEASE_ORDER, LATE_FEE_SCHEDULE_ORDER, and computeLateFeeAmount in
-- exact decimal arithmetic -- change one, change the other).
--
-- Unchanged on purpose: lease_status IN ('active','current','notice') stays
-- case-sensitive; the app now matches it exactly ("Active" is charged by no
-- path).

CREATE OR REPLACE FUNCTION public.batch_post_late_fees(p_company_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $function$
DECLARE
  v_t RECORD; v_rule RECORD;
  v_today DATE := (now() AT TIME ZONE 'America/New_York')::date;
  v_month TEXT := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM');
  v_ref TEXT;
  v_fee NUMERIC; v_je_id TEXT; v_je_number TEXT; v_class_id TEXT;
  v_ar_id uuid; v_ar_name text; v_income_id uuid; v_income_name text;
  v_attempt INTEGER; v_count INTEGER := 0; v_skipped INTEGER := 0;
  v_constraint TEXT;
  v_no_ar jsonb := '[]'::jsonb;
  v_type TEXT; v_amount NUMERIC; v_grace INTEGER;
  v_due_day INTEGER; v_last_day INTEGER; v_due_date DATE;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id AND lower(user_email) = lower(auth.jwt()->>'email')
      AND status = 'active' AND role IN ('admin','office_assistant','accountant')
  ) THEN RAISE EXCEPTION 'Access denied: insufficient role for this operation'; END IF;

  -- oldest active rule; id breaks a created_at tie (app: LATE_FEE_RULE_ORDER)
  SELECT * INTO v_rule FROM late_fee_rules
   WHERE company_id = p_company_id AND archived_at IS NULL AND coalesce(is_active, true) ORDER BY created_at, id LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'fees_posted', 0, 'reason', 'no late fee rule configured');
  END IF;
  v_grace := GREATEST(0, floor(coalesce(v_rule.grace_days, 0))::int);

  SELECT id, name INTO v_income_id, v_income_name FROM acct_accounts
   WHERE company_id = p_company_id AND code = '4010' LIMIT 1;
  IF v_income_id IS NULL THEN
    SELECT id, name INTO v_income_id, v_income_name FROM acct_accounts
     WHERE company_id = p_company_id AND name = 'Late Fee Income' LIMIT 1;
  END IF;
  IF v_income_id IS NULL THEN
    RAISE EXCEPTION 'Missing required account (Late Fee Income) for company %', p_company_id;
  END IF;

  v_last_day := EXTRACT(DAY FROM (date_trunc('month', v_today) + interval '1 month - 1 day'))::int;

  FOR v_t IN
    SELECT id, name, property, rent, balance, late_fee_amount, late_fee_type FROM tenants
    WHERE company_id = p_company_id AND archived_at IS NULL
      AND lease_status IN ('active','current','notice') AND coalesce(balance,0) > 0
  LOOP
    -- amount + type: the tenant's own setting, else the rule
    IF coalesce(v_t.late_fee_amount, 0) > 0 THEN
      v_type := lower(btrim(coalesce(v_t.late_fee_type, 'flat')));
      v_amount := v_t.late_fee_amount;
    ELSE
      v_type := lower(btrim(coalesce(v_rule.fee_type, '')));
      v_amount := coalesce(v_rule.fee_amount, 0);
    END IF;
    v_type := CASE WHEN v_type IN ('flat','fixed') THEN 'flat'
                   WHEN v_type IN ('percent','percentage','pct','%') THEN 'percent'
                   ELSE NULL END;
    IF v_type IS NULL OR coalesce(v_amount, 0) <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    -- when: past the tenant's due day + grace. Newest active lease first,
    -- else the oldest active rent schedule; id breaks ties
    -- (app: LATE_FEE_LEASE_ORDER / LATE_FEE_SCHEDULE_ORDER).
    SELECT l.payment_due_day INTO v_due_day FROM leases l
     WHERE l.company_id = p_company_id AND l.tenant_id = v_t.id AND l.status = 'active' AND coalesce(l.payment_due_day, 0) > 0
     ORDER BY l.start_date DESC NULLS LAST, l.id LIMIT 1;
    IF v_due_day IS NULL THEN
      SELECT r.day_of_month INTO v_due_day FROM recurring_journal_entries r
       WHERE r.company_id = p_company_id AND r.tenant_id = v_t.id AND r.status = 'active' AND r.archived_at IS NULL
         AND coalesce(r.day_of_month, 0) > 0
       ORDER BY r.created_at, r.id LIMIT 1;
    END IF;
    v_due_day := LEAST(GREATEST(coalesce(v_due_day, 1), 1), v_last_day);
    v_due_date := make_date(EXTRACT(YEAR FROM v_today)::int, EXTRACT(MONTH FROM v_today)::int, v_due_day);
    IF (v_today - v_due_date) <= v_grace THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    IF public.late_fee_already_posted(p_company_id, v_t.id, v_month) THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    -- how much, to the cent (app: computeLateFeeAmount, exact decimals)
    IF v_type = 'flat' THEN v_fee := round(v_amount, 2);
    ELSE
      IF coalesce(v_t.rent, 0) <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
      v_fee := round(round(v_t.rent * v_amount) / 100, 2);
    END IF;
    IF v_fee IS NULL OR v_fee <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

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
        IF v_constraint = 'idx_je_company_reference_unique' THEN v_je_id := NULL; EXIT; END IF;
        IF v_constraint <> 'unique_je_number_per_company' THEN RAISE; END IF;
        v_attempt := v_attempt + 1;
        IF v_attempt >= 5 THEN
          RAISE EXCEPTION 'batch_post_late_fees: could not allocate a JE number after 5 attempts';
        END IF;
      END;
    END LOOP;

    IF v_je_id IS NULL THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

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
