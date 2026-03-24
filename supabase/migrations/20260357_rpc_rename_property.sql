CREATE OR REPLACE FUNCTION rename_property_v2(p_company_id text, p_property_id bigint, p_new_address text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_old text;
BEGIN
  SELECT address INTO v_old FROM properties WHERE id = p_property_id AND company_id = p_company_id;
  IF v_old IS NULL THEN RETURN; END IF;
  UPDATE properties SET address = p_new_address WHERE id = p_property_id AND company_id = p_company_id;
  UPDATE tenants SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE payments SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE leases SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE work_orders SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE documents SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE utilities SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE ledger_entries SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE acct_journal_entries SET property = p_new_address WHERE company_id = p_company_id AND property = v_old;
  UPDATE acct_classes SET name = p_new_address WHERE company_id = p_company_id AND name = v_old;
END;
$$
