CREATE OR REPLACE FUNCTION handle_membership_request(p_member_id bigint, p_action text, p_role text DEFAULT 'tenant')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_action = 'approve' THEN
    UPDATE company_members SET status = 'active', role = COALESCE(p_role, 'tenant') WHERE id = p_member_id;
  ELSIF p_action = 'reject' THEN
    UPDATE company_members SET status = 'rejected' WHERE id = p_member_id;
  END IF;
END;
$$
