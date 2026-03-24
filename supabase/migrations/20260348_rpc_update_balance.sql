CREATE OR REPLACE FUNCTION update_tenant_balance(p_tenant_id bigint, p_amount_change numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE tenants SET balance = COALESCE(balance, 0) + p_amount_change WHERE id = p_tenant_id;
END;
$$
