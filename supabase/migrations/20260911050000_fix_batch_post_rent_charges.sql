-- batch_post_rent_charges has NEVER worked in this schema.
--
-- It failed on its first statement, before the loop began, so no rent has
-- ever been posted by it. Four faults, all left over from when these
-- columns were text and the ledger was a table:
--
--   1. `l.start_date <= v_today::TEXT` -- leases.start_date is a date, so
--      this raised 42883 "operator does not exist: date <= text".
--   2. The journal header passed v_charge_date (text) into a date column.
--   3. It INSERTed into ledger_entries, now a derived VIEW containing
--      window functions, which cannot be written to at all (55000).
--   4. No service_role branch, so only a signed-in staff member could
--      call it -- it could never be scheduled.
--
-- On (3): a tenant ledger should be DERIVED from the journal lines, not
-- stored again. The journal entry IS the charge; the ledger is a view of
-- that tenant's receivable activity with a running balance. Storing it
-- twice creates two sources of truth for one charge, which is how they
-- drift. The schema already made this change -- ledger_entries became a
-- view and ledger_entries_legacy_table is the leftover -- but this
-- function was never updated to match.
--
-- Preserved deliberately: the due-day clamp, the journal-number retry
-- loop, and the explicit tenants.balance update (the AR leg lands on the
-- shared account, whose per-tenant trigger does not fire, so this update
-- is what actually moves the balance).
--
-- The duplicate guard is tightened. It matched `reference LIKE
-- 'RENT-AUTO-%<month>%'` AND the tenant's name appearing anywhere in the
-- description -- fragile, because names are not unique and one tenant's
-- name can appear in another's description. The reference is already
-- deterministic per lease per month, so exact equality is correct and
-- index-friendly.
--
-- Also now only charges leases whose term covers the month, which the
-- original did not check: an ended lease would have kept being charged.
--
-- VERIFIED on the test project: before, it raised 42883 immediately;
-- after, it posted 1 charge, balanced DR $999 = CR $999 across two lines
-- dated 2026-09-01 with the tenant on each line, and a second run added
-- nothing. Sandbox restored to the $432,247.66 baseline afterwards.
CREATE OR REPLACE FUNCTION public.batch_post_rent_charges(p_company_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $function$
DECLARE
  v_lease RECORD;
  v_today DATE := CURRENT_DATE;
  v_month TEXT := to_char(v_today, 'YYYY-MM');
  v_charge_date DATE;
  v_je_id TEXT; v_je_number TEXT; v_class_id TEXT;
  v_ar_id uuid; v_revenue_id uuid;
  v_due_day INTEGER; v_attempt INTEGER;
  v_count INTEGER := 0; v_skipped INTEGER := 0;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' AND NOT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
      AND lower(user_email) = lower(auth.jwt()->>'email')
      AND status = 'active' AND role IN ('admin','office_assistant','accountant')
  ) THEN
    RAISE EXCEPTION 'Access denied: insufficient role for this operation';
  END IF;

  SELECT id INTO v_ar_id      FROM acct_accounts WHERE company_id = p_company_id AND name = 'Accounts Receivable' LIMIT 1;
  SELECT id INTO v_revenue_id FROM acct_accounts WHERE company_id = p_company_id AND name = 'Rental Income'        LIMIT 1;
  IF v_ar_id IS NULL OR v_revenue_id IS NULL THEN
    RAISE EXCEPTION 'Missing required accounts (Accounts Receivable or Rental Income) for company %', p_company_id;
  END IF;

  FOR v_lease IN
    SELECT l.*
    FROM leases l
    WHERE l.company_id = p_company_id
      AND l.status = 'active'
      AND l.start_date <= v_today
      AND (l.end_date IS NULL OR l.end_date >= date_trunc('month', v_today)::date)
  LOOP
    v_due_day := LEAST(
      COALESCE(v_lease.payment_due_day, 1),
      EXTRACT(DAY FROM (date_trunc('month', v_today) + interval '1 month - 1 day'))::INTEGER
    );
    v_charge_date := make_date(
      EXTRACT(YEAR FROM v_today)::int, EXTRACT(MONTH FROM v_today)::int, v_due_day
    );

    IF EXISTS (
      SELECT 1 FROM acct_journal_entries
      WHERE company_id = p_company_id
        AND reference = 'RENT-AUTO-' || v_lease.id::text || '-' || v_month
        AND status <> 'voided'
    ) THEN v_skipped := v_skipped + 1; CONTINUE; END IF;

    IF coalesce(v_lease.rent_amount, 0) <= 0 THEN
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    SELECT id INTO v_class_id FROM acct_classes
     WHERE company_id = p_company_id AND name = v_lease.property LIMIT 1;

    v_attempt := 0;
    LOOP
      v_attempt := v_attempt + 1;
      IF v_attempt > 5 THEN v_je_id := NULL; EXIT; END IF;
      BEGIN
        v_je_number := next_journal_number(p_company_id);
        v_je_id := 'je-' || EXTRACT(EPOCH FROM NOW())::BIGINT || '-' || substr(md5(random()::text),1,8) || v_count || v_attempt;
        INSERT INTO acct_journal_entries (id, number, date, description, reference, property, status, company_id)
        VALUES (v_je_id, v_je_number, v_charge_date,
                'Rent charge — ' || v_lease.tenant_name || ' — ' || v_lease.property,
                'RENT-AUTO-' || v_lease.id::text || '-' || v_month,
                v_lease.property, 'posted', p_company_id);
        EXIT;
      EXCEPTION WHEN unique_violation THEN CONTINUE;
      END;
    END LOOP;

    IF v_je_id IS NOT NULL THEN
      INSERT INTO acct_journal_lines (journal_entry_id, account_id, account_name, debit, credit, class_id, memo, entity_type, entity_id, entity_name, company_id)
      VALUES
        (v_je_id, v_ar_id, 'Accounts Receivable', v_lease.rent_amount, 0, v_class_id,
         'Rent — ' || v_month, 'customer', v_lease.tenant_id::text, v_lease.tenant_name, p_company_id),
        (v_je_id, v_revenue_id, 'Rental Income', 0, v_lease.rent_amount, v_class_id,
         v_lease.property || ' — ' || v_month, 'customer', v_lease.tenant_id::text, v_lease.tenant_name, p_company_id);

      IF v_lease.tenant_id IS NOT NULL THEN
        UPDATE tenants SET balance = COALESCE(balance, 0) + v_lease.rent_amount
        WHERE id = v_lease.tenant_id;
      END IF;

      -- No ledger_entries write: the ledger is derived from the lines above.
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'charges_posted', v_count,
                            'skipped', v_skipped, 'month', v_month);
END;
$function$;

REVOKE ALL ON FUNCTION public.batch_post_rent_charges(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_post_rent_charges(text) TO authenticated, service_role;
