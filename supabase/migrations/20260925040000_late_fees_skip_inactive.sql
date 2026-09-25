-- Wave 2 #3: batch late-fee posting must skip DISABLED rules (is_active=false).
-- Identical to 20260911040000's batch_post_late_fees except the rule lookup.

CREATE OR REPLACE FUNCTION public.batch_post_late_fees(p_company_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $function$
DECLARE
  v_t RECORD; v_rule RECORD;
  v_today DATE := CURRENT_DATE;
  v_month TEXT := to_char(v_today, 'YYYY-MM');
  v_fee NUMERIC; v_je_id TEXT; v_je_number TEXT; v_class_id TEXT;
  -- Types taken from the schema, not copied from the rent sibling, which
  -- declares these as TEXT although acct_accounts.id is uuid.
  v_ar_id uuid; v_income_id uuid;
  v_attempt INTEGER; v_count INTEGER := 0; v_skipped INTEGER := 0;
BEGIN
  -- Company staff OR the scheduled job. The rent sibling checks the
  -- caller's JWT email, which a cron does not have: it authenticates with
  -- the service key, where auth.role() is 'service_role'. Without this
  -- branch the cron is always denied.
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id AND lower(user_email) = lower(auth.jwt()->>'email')
      AND status = 'active' AND role IN ('admin','office_assistant','accountant')
  ) THEN RAISE EXCEPTION 'Access denied: insufficient role for this operation'; END IF;

  SELECT * INTO v_rule FROM late_fee_rules
   WHERE company_id = p_company_id AND archived_at IS NULL AND coalesce(is_active, true) ORDER BY created_at LIMIT 1;
  -- IF NOT FOUND, not `IF v_rule IS NULL`: on an unassigned RECORD the
  -- latter does not reliably mean "no row", so with no rule configured
  -- this ran on with an all-NULL rule, took the percentage branch because
  -- fee_type was NULL, computed a NULL fee and reported every tenant as
  -- "skipped" instead of saying no rule existed.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'fees_posted', 0, 'reason', 'no late fee rule configured');
  END IF;
  -- The sandbox contained a rule with EVERY field null. A blank rule is a
  -- configuration problem, not a reason to silently skip everyone.
  IF coalesce(v_rule.fee_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('success', true, 'fees_posted', 0, 'reason', 'late fee rule has no fee amount configured');
  END IF;
  -- Never charge before the grace period has elapsed, so running the job
  -- on the wrong day cannot charge anyone early.
  IF EXTRACT(DAY FROM v_today)::int <= coalesce(v_rule.grace_days, 0) THEN
    RETURN jsonb_build_object('success', true, 'fees_posted', 0,
      'reason', format('within grace period (day %s of %s)', EXTRACT(DAY FROM v_today)::int, v_rule.grace_days));
  END IF;

  SELECT id INTO v_ar_id     FROM acct_accounts WHERE company_id = p_company_id AND name = 'Accounts Receivable' LIMIT 1;
  SELECT id INTO v_income_id FROM acct_accounts WHERE company_id = p_company_id AND name = 'Late Fee Income'     LIMIT 1;
  IF v_ar_id IS NULL OR v_income_id IS NULL THEN
    RAISE EXCEPTION 'Missing required accounts (Accounts Receivable or Late Fee Income) for company %', p_company_id;
  END IF;

  FOR v_t IN
    SELECT id, name, property, rent, balance FROM tenants
    WHERE company_id = p_company_id AND archived_at IS NULL
      -- Both spellings. Production stores 'active' while the app writes
      -- 'current'; matching one would silently skip a third of tenants.
      AND lease_status IN ('active','current') AND coalesce(balance,0) > 0
  LOOP
    IF EXISTS (SELECT 1 FROM acct_journal_entries
               WHERE company_id = p_company_id
                 AND reference = 'LATEFEE-' || v_t.id::text || '-' || v_month
                 AND status <> 'voided')
    THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    IF v_rule.fee_type = 'flat' THEN v_fee := v_rule.fee_amount;
    ELSE
      -- Percent of RENT, never of the balance or of whatever was paid: a
      -- partial payment would otherwise change the fee. No rent on file
      -- means skip rather than invent a base.
      IF coalesce(v_t.rent, 0) <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;
      -- Rounded to the cent: $1250 x 5.1% is $63.75, and rounding the raw
      -- product made it $64.
      v_fee := round(v_t.rent * v_rule.fee_amount) / 100.0;
    END IF;
    IF v_fee IS NULL OR v_fee <= 0 THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    SELECT id INTO v_class_id FROM acct_classes WHERE company_id = p_company_id AND name = v_t.property LIMIT 1;

    v_attempt := 0;
    LOOP
      v_attempt := v_attempt + 1;
      IF v_attempt > 5 THEN v_je_id := NULL; EXIT; END IF;
      BEGIN
        v_je_number := next_journal_number(p_company_id);
        v_je_id := 'je-' || EXTRACT(EPOCH FROM NOW())::BIGINT || '-' || substr(md5(random()::text),1,8) || v_count || v_attempt;
        INSERT INTO acct_journal_entries (id, number, date, description, reference, property, status, company_id)
        VALUES (v_je_id, v_je_number, v_today,
                'Late fee — ' || v_t.name || ' — ' || coalesce(v_t.property,''),
                'LATEFEE-' || v_t.id::text || '-' || v_month, v_t.property, 'posted', p_company_id);
        EXIT;
      EXCEPTION WHEN unique_violation THEN CONTINUE;
      END;
    END LOOP;

    IF v_je_id IS NOT NULL THEN
      -- DR Accounts Receivable / CR Late Fee Income. The AR leg stays on
      -- the SHARED account, matching the manual path: a per-tenant AR
      -- sub-account fires the balance-sync trigger, which together with
      -- the explicit UPDATE below would double-count the fee.
      -- entity_id carries the tenant, which only became possible once
      -- that column was widened from uuid to text (migration
      -- 20260911020000) -- tenants.id is an integer.
      INSERT INTO acct_journal_lines (journal_entry_id, account_id, account_name, debit, credit, class_id, memo, entity_type, entity_id, entity_name, company_id)
      VALUES
        (v_je_id, v_ar_id, 'Accounts Receivable', v_fee, 0, v_class_id, 'Late fee — ' || v_month, 'customer', v_t.id::text, v_t.name, p_company_id),
        (v_je_id, v_income_id, 'Late Fee Income', 0, v_fee, v_class_id, 'Late fee — ' || v_month, 'customer', v_t.id::text, v_t.name, p_company_id);
      UPDATE tenants SET balance = coalesce(balance,0) + v_fee WHERE id = v_t.id;
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'fees_posted', v_count, 'skipped', v_skipped, 'month', v_month);
END;
$function$;
