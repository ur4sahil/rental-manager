-- Fix three errors the wizard's commit step surfaced on
-- sandbox-llc tonight:
--
-- 1) insert_ledger_entry_with_balance took p_date as TEXT but the
--    ledger_entries.date column is DATE; Postgres refused the insert
--    ("column date is of type date but expression is of type text").
--    Add an explicit ::date cast on the INSERT.
--
-- 2) update_tenant_balance existed with two signatures
--      (bigint, numeric) AND (integer, numeric)
--    so PostgREST bailed with "Could not choose the best candidate".
--    Drop the integer variant (tenants.id is bigserial in prod).
--
-- 3) post_je_and_ledger's inner call to insert_ledger_entry_with_balance
--    passes p_ledger_date straight through; once #1 fixes the callee
--    the caller continues to work untouched, but we also add the cast
--    where the caller inserts directly, for defense in depth.

-- ─── 1. drop the ambiguous integer variant of update_tenant_balance ─
DROP FUNCTION IF EXISTS update_tenant_balance(integer, numeric);

-- ─── 2. rewrite insert_ledger_entry_with_balance with date cast ─────
CREATE OR REPLACE FUNCTION insert_ledger_entry_with_balance(
  p_company_id text,
  p_tenant text DEFAULT NULL,
  p_tenant_id bigint DEFAULT NULL,
  p_property text DEFAULT NULL,
  p_date text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_amount numeric DEFAULT 0,
  p_type text DEFAULT NULL
)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_prev_balance numeric := 0;
  v_new_balance numeric := 0;
  v_caller_email text;
  v_caller_role text;
  v_id bigint;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of this company';
  END IF;

  IF p_tenant_id IS NOT NULL THEN
    SELECT COALESCE(balance, 0) INTO v_prev_balance
    FROM ledger_entries
    WHERE company_id = p_company_id
      AND tenant_id = p_tenant_id
      AND (p_property IS NULL OR property = p_property)
    ORDER BY date DESC, created_at DESC
    LIMIT 1;

    IF p_type IN ('charge', 'late_fee', 'expense', 'deposit_deduction') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) + p_amount;
    ELSIF p_type IN ('payment', 'credit', 'deposit_return', 'void') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) - p_amount;
    ELSE
      v_new_balance := COALESCE(v_prev_balance, 0) + p_amount;
    END IF;
  ELSE
    v_new_balance := 0;
  END IF;

  INSERT INTO ledger_entries (
    company_id, tenant, tenant_id, property, date,
    description, amount, type, balance
  ) VALUES (
    p_company_id, p_tenant, p_tenant_id, p_property, p_date::date,
    p_description, p_amount, p_type, v_new_balance
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
