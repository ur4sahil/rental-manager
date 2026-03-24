CREATE OR REPLACE FUNCTION change_user_email(p_old_email text, p_new_email text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE company_members SET user_email = p_new_email WHERE lower(user_email) = lower(p_old_email);
  UPDATE app_users SET email = p_new_email WHERE lower(email) = lower(p_old_email);
END;
$$
