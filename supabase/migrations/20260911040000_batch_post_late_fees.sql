-- Automatic late fees, plus two pre-existing bugs this uncovered.
--
-- Sahil's spec: on the 5th, charge the late fee to any tenant who still
-- owes for the month. He was right that this is simple, and my earlier
-- objection was wrong: I treated the browser's applyLateFee as "the
-- logic", when the app already posts bulk charges from the DATABASE --
-- batch_post_rent_charges does exactly this for rent. So late fees are a
-- sibling of a function that already exists, and there is no second copy
-- of the posting rules to drift.
--
-- Idempotent on reference LATEFEE-<tenant>-<YYYY-MM>: a retry, a
-- double-trigger, or a fee already charged by hand cannot produce a
-- second one. Verified: first run posted 6, second run posted 0 and
-- skipped 6.
--
-- ===== BUG 1: next_journal_number overflowed =====
-- It cast the journal number to INTEGER. Numbers are normally sequential
-- ("JE-0266") but some are epoch-based ("JE-1774214632393"), which the
-- client generates as a uniqueness fallback. 1,774,214,632,393 exceeds
-- int4, so the function raised 22003 and every caller failed.
-- batch_post_rent_charges calls it too, so AUTOMATIC RENT POSTING was
-- failing for any company that ever produced an epoch-style number.
-- Now bigint, and only all-digit numbers of at most 9 digits count
-- toward MAX -- including an epoch would make every later number an
-- epoch as well.
CREATE OR REPLACE FUNCTION public.next_journal_number(p_company_id text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $function$
DECLARE next_num bigint;
BEGIN
  SELECT COALESCE(MAX(n), 0) + 1 INTO next_num
  FROM (
    SELECT CAST(REPLACE(number, 'JE-', '') AS bigint) AS n
    FROM acct_journal_entries
    WHERE company_id = p_company_id AND number IS NOT NULL
      AND REPLACE(number, 'JE-', '') ~ '^[0-9]{1,9}$'
  ) s;
  RETURN 'JE-' || LPAD(next_num::text, 4, '0');
END;
$function$;

COMMENT ON FUNCTION public.next_journal_number(text) IS
  'Next sequential journal number. Considers only all-digit numbers of at most 9 digits: epoch-style fallback numbers (JE-1774214632393) overflow integer and, if included in MAX, would make every later number an epoch too.';

-- ===== BUG 2 (NOT fixed here, flagged) =====
-- batch_post_rent_charges also INSERTs into ledger_entries, which is a
-- VIEW containing window functions and therefore not insertable at all
-- (55000). So automatic rent posting fails at that line too. This
-- function deliberately does NOT write a ledger row: the ledger is
-- GL-derived from the journal lines, so the two lines below ARE the
-- ledger entry. batch_post_rent_charges needs the same treatment, but it
-- is money-posting code outside tonight's scope.

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
   WHERE company_id = p_company_id AND archived_at IS NULL ORDER BY created_at LIMIT 1;
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

REVOKE ALL ON FUNCTION public.batch_post_late_fees(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_post_late_fees(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.batch_post_late_fees(text) IS
  'Charges the company late fee rule to every unarchived tenant with a positive balance, once per tenant per month. Sibling of batch_post_rent_charges. Callable by company staff or by the scheduled job via the service role. Idempotent on reference LATEFEE-<tenant>-<YYYY-MM>.';
