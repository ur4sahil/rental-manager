CREATE OR REPLACE FUNCTION approve_member_request(p_member_id bigint, p_role text DEFAULT 'tenant')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE company_members SET status = 'active', role = COALESCE(p_role, 'tenant') WHERE id = p_member_id;
END;
$$
