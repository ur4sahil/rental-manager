CREATE OR REPLACE FUNCTION redeem_invite_code(p_code text, p_user_email text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE tenant_invite_codes SET redeemed_at = now(), redeemed_by = p_user_email WHERE code = p_code AND redeemed_at IS NULL;
END;
$$
