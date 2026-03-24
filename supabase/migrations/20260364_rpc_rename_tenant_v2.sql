CREATE OR REPLACE FUNCTION rename_tenant_cascade(p_company_id text, p_old_name text, p_new_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE payments SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE leases SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE work_orders SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE documents SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE ledger_entries SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE messages SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE autopay_schedules SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
  UPDATE properties SET tenant = p_new_name WHERE company_id = p_company_id AND tenant = p_old_name;
END;
$$
