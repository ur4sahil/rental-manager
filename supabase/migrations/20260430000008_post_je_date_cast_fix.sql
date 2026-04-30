-- Phase 4 migration regressed the p_date::date cast on the RPC's
-- acct_journal_entries INSERT (the original 20260424000005 migration
-- had it; my Phase 4 rewrite forgot it). Without the cast, every
-- post_je_and_ledger call errors with
--   "column \"date\" is of type date but expression is of type text"
-- Re-apply the cast.
CREATE OR REPLACE FUNCTION post_je_and_ledger(
  p_company_id text, p_date text, p_description text,
  p_reference text DEFAULT '', p_property text DEFAULT '',
  p_status text DEFAULT 'posted', p_lines jsonb DEFAULT '[]'::jsonb,
  p_ledger_tenant text DEFAULT NULL, p_ledger_tenant_id bigint DEFAULT NULL,
  p_ledger_property text DEFAULT NULL, p_ledger_amount numeric DEFAULT 0,
  p_ledger_type text DEFAULT NULL, p_ledger_description text DEFAULT NULL,
  p_balance_change numeric DEFAULT 0
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_je_id uuid; v_je_number text; v_last_num int; v_attempt int := 0; v_line jsonb;
BEGIN
  LOOP
    SELECT COALESCE((SELECT regexp_replace(number, '\D', '', 'g')::int FROM acct_journal_entries WHERE company_id = p_company_id ORDER BY created_at DESC LIMIT 1), 0) INTO v_last_num;
    v_je_number := 'JE-' || lpad((v_last_num + 1 + v_attempt)::text, 4, '0');
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
    VALUES (v_je_id, p_company_id, v_line->>'account_id', COALESCE(v_line->>'account_name', ''),
      COALESCE((v_line->>'debit')::numeric, 0), COALESCE((v_line->>'credit')::numeric, 0),
      NULLIF(v_line->>'class_id', ''), COALESCE(v_line->>'memo', ''));
  END LOOP;
  RETURN v_je_id;
END;
$$;
