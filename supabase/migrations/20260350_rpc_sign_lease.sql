CREATE OR REPLACE FUNCTION sign_lease(p_signature_id uuid, p_signer_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE lease_signatures SET status = 'signed', signed_at = now(), signer_name = p_signer_name WHERE id = p_signature_id;
END;
$$
