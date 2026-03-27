-- Atomic late fee application: JE + ledger + balance in one transaction
CREATE OR REPLACE FUNCTION apply_late_fee_atomic(
  p_company_id TEXT,
  p_tenant_id UUID,
  p_tenant_name TEXT,
  p_property TEXT,
  p_fee_amount NUMERIC,
  p_je_number TEXT,
  p_je_date TEXT,
  p_description TEXT,
  p_reference TEXT,
  p_late_fee_account_id UUID,
  p_ar_account_id UUID,
  p_class_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  v_je_id UUID;
  v_result JSON;
BEGIN
  -- 1. Create journal entry header
  INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
  VALUES (p_company_id, p_je_number, p_je_date, p_description, p_reference, p_property, 'posted')
  RETURNING id INTO v_je_id;

  -- 2. Create journal lines (DR: AR, CR: Late Fee Income)
  INSERT INTO acct_journal_lines (journal_entry_id, company_id, account_id, debit, credit, class_id, memo)
  VALUES
    (v_je_id, p_company_id, p_ar_account_id, p_fee_amount, 0, p_class_id, p_description),
    (v_je_id, p_company_id, p_late_fee_account_id, 0, p_fee_amount, p_class_id, p_description);

  -- 3. Create ledger entry
  INSERT INTO ledger_entries (company_id, tenant, tenant_id, property, date, description, amount, type, balance)
  VALUES (p_company_id, p_tenant_name, p_tenant_id, p_property, p_je_date, p_description, p_fee_amount, 'charge', 0);

  -- 4. Update tenant balance
  PERFORM update_tenant_balance(p_tenant_id, p_fee_amount);

  v_result := json_build_object('jeId', v_je_id, 'success', true);
  RETURN v_result;

EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
