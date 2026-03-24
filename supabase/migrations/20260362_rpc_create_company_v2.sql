CREATE OR REPLACE FUNCTION create_company_atomic(
  p_company_id text, p_name text, p_type text, p_company_code text,
  p_company_role text, p_address text, p_phone text, p_email text,
  p_creator_email text, p_creator_name text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO companies (id, name, type, company_code, company_role, address, phone, email)
  VALUES (p_company_id, p_name, p_type, p_company_code, p_company_role, p_address, p_phone, p_email);
  INSERT INTO company_members (company_id, user_email, role, status)
  VALUES (p_company_id, p_creator_email, 'admin', 'active');
END;
$$
