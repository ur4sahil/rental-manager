-- JE number generation was racing against itself and producing
-- collisions on `unique_je_number_per_company`. Two root causes:
--
--   1. Both the client (src/utils/accounting.js, Banking.js,
--      Accounting.js) and the post_je_and_ledger RPC computed the
--      "next" number by picking the most-recently-created row and
--      reading its `number`. But created_at is not monotonic with
--      respect to JE number: a backfill, an aborted retry, or a
--      test fixture can leave a row with a small number after rows
--      with larger numbers. Reading that row hands back a stale
--      max, and the very next insert collides.
--
--   2. The RPC's number-extractor used regexp_replace(number,
--      '\D', '', 'g')::bigint — which strips letters from
--      hash-format legacy numbers like 'JE-MN2L179P', yielding a
--      meaningless integer (2179) that's almost certainly an
--      already-used number. This is how gaps appeared in the
--      sequence to begin with.
--
-- Fix: a stable next_je_number(company_id) function that takes
-- MAX over rows matching ^JE-\d+$ only (skipping hash-format JEs
-- entirely), and returns the next number formatted with at-least-
-- 4-digit zero padding. The retry loop stays as a concurrency
-- safety net since MAX doesn't lock against concurrent writers.
CREATE OR REPLACE FUNCTION next_je_number(p_company_id text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT 'JE-' || lpad(
    (COALESCE(
      (SELECT MAX(CAST(SUBSTRING(number FROM 'JE-(\d+)$') AS BIGINT))
       FROM acct_journal_entries
       WHERE company_id = p_company_id
         AND number ~ '^JE-\d+$'),
      0
    ) + 1)::text,
    4, '0'
  );
$$;

GRANT EXECUTE ON FUNCTION next_je_number(text) TO anon, authenticated, service_role;

-- Rewrite post_je_and_ledger to use the new helper. Same retry
-- loop, but each retry re-evaluates MAX so a concurrent committed
-- insert is reflected on the next attempt (READ COMMITTED).
CREATE OR REPLACE FUNCTION post_je_and_ledger(
  p_company_id text, p_date text, p_description text,
  p_reference text DEFAULT '', p_property text DEFAULT '',
  p_status text DEFAULT 'posted', p_lines jsonb DEFAULT '[]'::jsonb,
  p_ledger_tenant text DEFAULT NULL, p_ledger_tenant_id bigint DEFAULT NULL,
  p_ledger_property text DEFAULT NULL, p_ledger_amount numeric DEFAULT 0,
  p_ledger_type text DEFAULT NULL, p_ledger_description text DEFAULT NULL,
  p_balance_change numeric DEFAULT 0
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_je_id uuid; v_je_number text; v_attempt int := 0; v_line jsonb;
BEGIN
  LOOP
    v_je_number := next_je_number(p_company_id);
    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status, transaction_type)
      VALUES (p_company_id, v_je_number, p_date::date, p_description, p_reference, p_property, p_status, COALESCE(p_ledger_type, 'charge'))
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN RAISE EXCEPTION 'Could not generate unique JE number after 5 attempts'; END IF;
    END;
  END LOOP;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO acct_journal_lines (journal_entry_id, company_id, account_id, account_name, debit, credit, class_id, memo)
    VALUES (v_je_id, p_company_id, (v_line->>'account_id')::uuid, COALESCE(v_line->>'account_name', ''),
      COALESCE((v_line->>'debit')::numeric, 0), COALESCE((v_line->>'credit')::numeric, 0),
      NULLIF(v_line->>'class_id', ''), COALESCE(v_line->>'memo', ''));
  END LOOP;
  RETURN v_je_id;
END;
$$;
