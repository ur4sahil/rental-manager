-- Fix: post_je_and_ledger declared p_date as text but INSERTed it into
-- acct_journal_entries.date (type: date) with no explicit cast. Postgres
-- raised "column \"date\" is of type date but expression is of type text"
-- under strict planning, which bubbled up as PM-4002 in Sentry. The
-- client-side wrapper (atomicPostJEAndLedger) catches the error and
-- falls back to non-atomic sequential writes — so move-outs and other
-- JE posts still completed, but every atomic post logged a noisy error
-- AND lost the transaction guarantee the RPC was built to provide.
--
-- Fix: cast both date uses (JE header + ledger_entries) as ::date. The
-- rest of the function is identical to 20260392.

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
      VALUES (p_company_id, v_je_number, p_date::date, p_description, p_reference, p_property, p_status)
      RETURNING id INTO v_je_id;
      EXIT; -- success
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

  -- Step 3: Insert ledger entry with running balance (if tenant provided)
  IF p_ledger_type IS NOT NULL AND (p_ledger_tenant_id IS NOT NULL OR p_ledger_tenant IS NOT NULL) THEN
    -- Get previous balance
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

    -- Calculate new balance based on type
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
      p_company_id, p_ledger_tenant, p_ledger_tenant_id, p_ledger_property, p_date::date,
      COALESCE(p_ledger_description, p_description), p_ledger_amount, p_ledger_type, v_new_balance
    );
  END IF;

  -- Step 4: Update tenant balance (if balance change specified)
  IF p_balance_change != 0 AND p_ledger_tenant_id IS NOT NULL THEN
    UPDATE tenants SET balance = COALESCE(balance, 0) + p_balance_change WHERE id = p_ledger_tenant_id;
  END IF;

  RETURN v_je_id;
END;
$$;
