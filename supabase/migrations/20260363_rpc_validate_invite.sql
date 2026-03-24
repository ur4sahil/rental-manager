CREATE OR REPLACE FUNCTION validate_invite_code(p_code text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_result json;
BEGIN
  SELECT json_build_object('valid', true, 'company_id', company_id, 'property', property)
  INTO v_result FROM tenant_invite_codes WHERE code = p_code AND redeemed_at IS NULL;
  IF v_result IS NULL THEN RETURN json_build_object('valid', false); END IF;
  RETURN v_result;
END;
$$
