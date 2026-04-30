-- Phase 2A: prevent duplicate ledger_entries rows when both the
-- mirror trigger AND the post_je_and_ledger RPC's Step 3 fire on
-- the same JE. Adds a unique index on (journal_entry_id, tenant_id)
-- and switches both writers to ON CONFLICT semantics.
--
-- Without this, every paired RPC call would produce two rows: the
-- trigger inserts after Step 2 (line insert), then Step 3's INSERT
-- runs unconditionally. The unique index makes that impossible at
-- the DB level; the UPSERT lets Step 3 enrich the trigger's row
-- with the caller's precise type/description rather than fighting
-- it.

-- 0. Dedup any existing rows that share (journal_entry_id, tenant_id).
--    Phase 1's trigger and the RPC's Step 3 both fired during initial
--    rollout/testing, leaving duplicates. Keep the row with the
--    richer type (not the generic 'charge'/'payment' fallback the
--    trigger uses) — that's the row the explicit RPC caller wrote.
WITH ranked AS (
  SELECT id, journal_entry_id, tenant_id,
    ROW_NUMBER() OVER (
      PARTITION BY journal_entry_id, tenant_id
      ORDER BY
        CASE WHEN type IN ('charge','payment') THEN 1 ELSE 0 END, -- prefer non-generic types
        created_at -- then earliest
    ) AS rn
  FROM ledger_entries
  WHERE journal_entry_id IS NOT NULL
)
DELETE FROM ledger_entries
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 1. Unique index. Partial — only enforced when journal_entry_id is
--    set (legacy rows without a link stay valid).
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_je_tenant
  ON ledger_entries (journal_entry_id, tenant_id)
  WHERE journal_entry_id IS NOT NULL;

-- 2. Trigger uses ON CONFLICT DO NOTHING. Even if a race let the
--    trigger fire after Step 3 (it won't, but defensive), no
--    duplicate row appears.
CREATE OR REPLACE FUNCTION trg_mirror_je_line_to_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id bigint;
  v_tenant_name text;
  v_je RECORD;
  v_amount numeric;
  v_type text;
  v_prev_balance numeric := 0;
  v_new_balance numeric := 0;
BEGIN
  SELECT a.tenant_id INTO v_tenant_id
  FROM acct_accounts a WHERE a.id = NEW.account_id;
  IF v_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT je.date, je.description, je.transaction_type, je.property
    INTO v_je
  FROM acct_journal_entries je
  WHERE je.id::text = NEW.journal_entry_id::text;

  SELECT name INTO v_tenant_name FROM tenants WHERE id = v_tenant_id;

  v_amount := COALESCE(NEW.debit, 0) + COALESCE(NEW.credit, 0);
  v_type := COALESCE(
    v_je.transaction_type,
    CASE WHEN COALESCE(NEW.debit, 0) > 0 THEN 'charge' ELSE 'payment' END
  );

  SELECT COALESCE(balance, 0) INTO v_prev_balance
  FROM ledger_entries
  WHERE company_id = NEW.company_id AND tenant_id = v_tenant_id
  ORDER BY date DESC, created_at DESC LIMIT 1;
  IF v_type IN ('charge', 'late_fee', 'expense', 'deposit_deduction', 'deposit') THEN
    v_new_balance := COALESCE(v_prev_balance, 0) + v_amount;
  ELSIF v_type IN ('payment', 'credit', 'deposit_return', 'void') THEN
    v_new_balance := COALESCE(v_prev_balance, 0) - v_amount;
  ELSE
    v_new_balance := COALESCE(v_prev_balance, 0) + v_amount;
  END IF;

  INSERT INTO ledger_entries (
    company_id, tenant, tenant_id, property, date,
    description, amount, type, balance, journal_entry_id
  ) VALUES (
    NEW.company_id, v_tenant_name, v_tenant_id, COALESCE(v_je.property, ''),
    v_je.date::text::date,
    COALESCE(v_je.description, ''), v_amount, v_type, v_new_balance, NEW.journal_entry_id::text
  )
  ON CONFLICT (journal_entry_id, tenant_id) WHERE journal_entry_id IS NOT NULL
  DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. RPC Step 3 uses ON CONFLICT DO UPDATE so the caller's precise
--    type / description / balance overrides whatever the trigger put
--    in by direction-based heuristic.
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
  LOOP
    SELECT COALESCE(
      (SELECT regexp_replace(number, '\D', '', 'g')::int
       FROM acct_journal_entries
       WHERE company_id = p_company_id
       ORDER BY created_at DESC LIMIT 1), 0
    ) INTO v_last_num;

    v_je_number := 'JE-' || lpad((v_last_num + 1 + v_attempt)::text, 4, '0');

    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status, transaction_type)
      VALUES (p_company_id, v_je_number, p_date, p_description, p_reference, p_property, p_status, COALESCE(p_ledger_type, 'charge'))
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN
        RAISE EXCEPTION 'Could not generate unique JE number after 5 attempts';
      END IF;
    END;
  END LOOP;

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

    IF p_ledger_type IN ('charge', 'late_fee', 'expense', 'deposit_deduction', 'deposit') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) + p_ledger_amount;
    ELSIF p_ledger_type IN ('payment', 'credit', 'deposit_return', 'void') THEN
      v_new_balance := COALESCE(v_prev_balance, 0) - p_ledger_amount;
    ELSE
      v_new_balance := COALESCE(v_prev_balance, 0) + p_ledger_amount;
    END IF;

    INSERT INTO ledger_entries (
      company_id, tenant, tenant_id, property, date,
      description, amount, type, balance, journal_entry_id
    ) VALUES (
      p_company_id, p_ledger_tenant, p_ledger_tenant_id, p_ledger_property, p_date,
      COALESCE(p_ledger_description, p_description), p_ledger_amount, p_ledger_type,
      v_new_balance, v_je_id::text
    )
    ON CONFLICT (journal_entry_id, tenant_id) WHERE journal_entry_id IS NOT NULL
    DO UPDATE SET
      type = EXCLUDED.type,
      description = EXCLUDED.description,
      amount = EXCLUDED.amount,
      balance = EXCLUDED.balance,
      tenant = COALESCE(EXCLUDED.tenant, ledger_entries.tenant),
      property = COALESCE(EXCLUDED.property, ledger_entries.property);
  END IF;

  RETURN v_je_id;
END;
$$;
