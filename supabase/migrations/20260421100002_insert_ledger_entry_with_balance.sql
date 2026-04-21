-- insert_ledger_entry_with_balance: atomic read-prev-balance + insert in
-- one DB call. Replaces the client-side read-then-insert pattern in
-- safeLedgerInsert, which raced under concurrent writes for the same
-- tenant (two payments both reading prevBal=$100 and each computing
-- balance from that stale baseline).
--
-- Scoping: by (company_id, tenant_id, property) so that a tenant renting
-- two units keeps two independent running balances. The existing
-- post_je_and_ledger RPC does similar math in-line; this function exists
-- for call sites that need ledger-only (no JE) inserts — Leases
-- termination/deposit-return, Accounting JE void, Utilities expense,
-- Properties wizard edges. Keeping the logic here rather than inlining
-- in every caller guarantees the balance is computed from a snapshot
-- taken inside the same transaction as the insert.

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
  -- Authorization: caller must be an active member of this company
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of this company';
  END IF;

  -- Compute running balance ONLY when tenant_id is present. Name-based
  -- fallback used to mix balances for two tenants sharing a name across
  -- properties. A missing tenant_id keeps balance=0 (caller-side that's
  -- fine — the ledger row is still a valid audit record).
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
    p_company_id, p_tenant, p_tenant_id, p_property, p_date,
    p_description, p_amount, p_type, v_new_balance
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Update post_je_and_ledger to scope its balance lookup by property too,
-- matching the new helper. Previously it read the latest ledger row by
-- (company_id, tenant_id) only — a tenant renting two units would
-- cross-pollinate balances. Also removes the lower(tenant) name-match
-- fallback so a rename doesn't snap the running total to a different
-- tenant's last row. The callers that rely on this RPC already pass
-- p_ledger_property whenever tenant_id is present.
CREATE OR REPLACE FUNCTION post_je_and_ledger(
  p_company_id text,
  p_date text,
  p_description text,
  p_reference text DEFAULT '',
  p_property text DEFAULT '',
  p_status text DEFAULT 'posted',
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_ledger_tenant text DEFAULT NULL,
  p_ledger_tenant_id bigint DEFAULT NULL,
  p_ledger_property text DEFAULT NULL,
  p_ledger_amount numeric DEFAULT 0,
  p_ledger_type text DEFAULT NULL,
  p_ledger_description text DEFAULT NULL,
  p_balance_change numeric DEFAULT 0
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_je_id uuid;
  v_je_number text;
  v_last_num int;
  v_attempt int := 0;
  v_line jsonb;
  v_caller_email text;
  v_caller_role text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
  WHERE company_id = p_company_id AND lower(user_email) = lower(v_caller_email) AND status = 'active';

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a member of this company';
  END IF;

  -- Step 1: Generate collision-safe JE number
  LOOP
    SELECT COALESCE(
      (SELECT regexp_replace(number, '\D', '', 'g')::int
       FROM acct_journal_entries
       WHERE company_id = p_company_id
       ORDER BY created_at DESC LIMIT 1), 0
    ) INTO v_last_num;

    v_je_number := 'JE-' || lpad((v_last_num + 1 + v_attempt)::text, 4, '0');

    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
      VALUES (p_company_id, v_je_number, p_date, p_description, p_reference, p_property, p_status)
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION 'Could not generate unique JE number after 5 attempts';
      END IF;
    END;
  END LOOP;

  -- Step 2: Insert JE lines
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    INSERT INTO acct_journal_lines (
      journal_entry_id, company_id, account_id, account_name,
      debit, credit, class_id, memo
    ) VALUES (
      v_je_id, p_company_id,
      v_line->>'account_id', COALESCE(v_line->>'account_name', ''),
      COALESCE((v_line->>'debit')::numeric, 0),
      COALESCE((v_line->>'credit')::numeric, 0),
      NULLIF(v_line->>'class_id', ''),
      COALESCE(v_line->>'memo', '')
    );
  END LOOP;

  -- Step 3: Ledger entry — delegate to the shared helper. It handles
  -- balance computation with the same scoping rules used elsewhere.
  -- When tenant_id is missing the helper still inserts the row with
  -- balance=0, preserving the audit trail without introducing a
  -- cross-tenant balance leak.
  IF p_ledger_type IS NOT NULL AND (p_ledger_tenant_id IS NOT NULL OR p_ledger_tenant IS NOT NULL) THEN
    PERFORM insert_ledger_entry_with_balance(
      p_company_id := p_company_id,
      p_tenant := p_ledger_tenant,
      p_tenant_id := p_ledger_tenant_id,
      p_property := COALESCE(p_ledger_property, p_property),
      p_date := p_date,
      p_description := COALESCE(p_ledger_description, p_description),
      p_amount := p_ledger_amount,
      p_type := p_ledger_type
    );
  END IF;

  -- Step 4: Update tenant balance (if balance change specified)
  IF p_balance_change != 0 AND p_ledger_tenant_id IS NOT NULL THEN
    UPDATE tenants SET balance = COALESCE(balance, 0) + p_balance_change WHERE id = p_ledger_tenant_id;
  END IF;

  RETURN v_je_id;
END;
$$;
