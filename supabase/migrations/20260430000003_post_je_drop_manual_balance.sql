-- Stop double-counting tenants.balance.
--
-- post_je_and_ledger() previously did its own manual UPDATE of
-- tenants.balance (Step 4, "p_balance_change") on top of the per-line
-- writes in Step 2. After we shipped the trigger
-- 20260426000003_tenant_balance_sync_trigger.sql, the recompute now
-- runs automatically on every acct_journal_lines INSERT/UPDATE/DELETE,
-- so the manual update in Step 4 is redundant — and worse, it
-- double-counts whenever the JE includes a per-tenant AR line (which
-- is the common case for charges/payments/late fees).
--
-- 14 tenants accumulated drift before this fix. The trigger handles
-- ongoing sync; a one-time recompute migration immediately after this
-- one reconciles the historical drift.
--
-- The p_balance_change parameter is kept in the signature for back-
-- compat with callers that still pass it, but the body now ignores
-- it. We don't drop the column / param to avoid coordinated app +
-- DB deploy ordering issues.

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
  v_prev_balance numeric := 0;
  v_new_balance numeric := 0;
  v_line jsonb;
BEGIN
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

  -- Step 2: Insert JE lines. The sync_tenant_balance_lines trigger
  -- recomputes tenants.balance for every per-tenant AR account
  -- touched by these lines.
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

  -- Step 3: Insert ledger entry with running balance (if tenant
  -- provided). ledger_entries is the separate "tenant payment history"
  -- view; tenants.balance is computed from acct_journal_lines via the
  -- trigger and is the source of truth for the cached balance.
  IF p_ledger_type IS NOT NULL AND (p_ledger_tenant_id IS NOT NULL OR p_ledger_tenant IS NOT NULL) THEN
    IF p_ledger_tenant_id IS NOT NULL THEN
      SELECT COALESCE(balance, 0) INTO v_prev_balance
      FROM ledger_entries
      WHERE company_id = p_company_id AND tenant_id = p_ledger_tenant_id
      ORDER BY date DESC, created_at DESC LIMIT 1;
    ELSE
      SELECT COALESCE(balance, 0) INTO v_prev_balance
      FROM ledger_entries
      WHERE company_id = p_company_id AND lower(tenant) = lower(p_ledger_tenant)
      ORDER BY date DESC, created_at DESC LIMIT 1;
    END IF;

    IF p_ledger_type IN ('charge', 'late_fee', 'expense', 'deposit_deduction') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) + p_ledger_amount;
    ELSIF p_ledger_type IN ('payment', 'credit', 'deposit_return', 'void') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) - p_ledger_amount;
    ELSE
      v_new_balance := COALESCE(v_prev_balance, 0) + p_ledger_amount;
    END IF;

    INSERT INTO ledger_entries (
      company_id, tenant, tenant_id, property, date,
      description, amount, type, balance
    ) VALUES (
      p_company_id, p_ledger_tenant, p_ledger_tenant_id, p_ledger_property, p_date,
      COALESCE(p_ledger_description, p_description), p_ledger_amount, p_ledger_type, v_new_balance
    );
  END IF;

  -- Step 4 (REMOVED): the previous manual UPDATE tenants SET balance
  -- is now redundant — the trigger sync_tenant_balance_lines fires on
  -- the line inserts above and recomputes balance from posted
  -- acct_journal_lines. Keeping that update double-counted balance for
  -- every JE that touched per-tenant AR (which is the common case).
  -- Drift accumulated for 14 tenants before this fix; a follow-up
  -- recompute migration handles the historical reconciliation.

  RETURN v_je_id;
END;
$$;
