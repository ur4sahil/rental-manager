CREATE OR REPLACE FUNCTION request_join_company(p_company_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_email text;
BEGIN
  v_email := current_setting('request.jwt.claims', true)::json->>'email';
  INSERT INTO company_members (company_id, user_email, role, status)
  VALUES (p_company_id, v_email, 'tenant', 'pending')
  ON CONFLICT DO NOTHING;
END;
$$
