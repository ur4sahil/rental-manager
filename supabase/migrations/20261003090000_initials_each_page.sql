-- Initials on every page (Word feature 7 of the editor work, 2026-10-03).
--
-- A template can ask that each signer also initial every page. The signer
-- types their initials when they sign; the signed PDF carries them in the
-- foot of every page. The initials are set on the signer's own row, by
-- their own link, just before they sign (the signing function's signature
-- stays as it is).
ALTER TABLE public.doc_signatures ADD COLUMN IF NOT EXISTS initials_data text;

CREATE OR REPLACE FUNCTION public.set_signature_initials(p_token text, p_initials_data text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_sig doc_signatures%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN RETURN jsonb_build_object('error', 'invalid token'); END IF;
  IF p_initials_data IS NULL OR length(btrim(p_initials_data)) < 2 OR length(p_initials_data) > 200000 THEN RETURN jsonb_build_object('error', 'initials required'); END IF;
  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'token not found'); END IF;
  IF v_sig.token_expires_at < now() THEN RETURN jsonb_build_object('error', 'token expired'); END IF;
  IF v_sig.status NOT IN ('sent', 'viewed') THEN RETURN jsonb_build_object('error', 'already signed or cancelled', 'status', v_sig.status); END IF;
  UPDATE doc_signatures SET initials_data = p_initials_data WHERE id = v_sig.id;
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.set_signature_initials(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_signature_initials(text, text) TO anon, authenticated, service_role;

-- The signing page learns whether initials are wanted: the document says
-- so in its own values (_initials_each_page), set when it was made from a
-- template with the option on.
CREATE OR REPLACE FUNCTION public.get_signature_by_token(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
  v_company_name text;
  v_company_email text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < now() THEN RETURN jsonb_build_object('error','token expired'); END IF;
  IF v_sig.status NOT IN ('sent','viewed') THEN
    RETURN jsonb_build_object('error','not available','status', v_sig.status,'signed_at', v_sig.signed_at);
  END IF;
  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;
  SELECT name, email INTO v_company_name, v_company_email FROM companies WHERE id = v_doc.company_id;
  IF v_sig.status = 'sent' THEN
    UPDATE doc_signatures SET status = 'viewed', viewed_at = now() WHERE id = v_sig.id;
    v_sig.status := 'viewed';
    v_sig.viewed_at := now();
  END IF;
  RETURN jsonb_build_object(
    'signer_id', v_sig.id,
    'signer_role', v_sig.signer_role,
    'signer_name', v_sig.signer_name,
    'signer_email', v_sig.signer_email,
    'status', v_sig.status,
    'sign_order', v_sig.sign_order,
    'doc_id', v_doc.id,
    'doc_name', v_doc.name,
    'doc_body', v_doc.rendered_body,
    'doc_hash_at_send', v_doc.doc_hash_at_send,
    'doc_property_address', v_doc.property_address,
    'doc_tenant_name', v_doc.tenant_name,
    'company_name', v_company_name,
    'company_contact_email', v_company_email,
    'expires_at', v_sig.token_expires_at,
    'initials_each_page', COALESCE((v_doc.field_values ->> '_initials_each_page')::boolean, false)
  );
END $$;
NOTIFY pgrst, 'reload schema';
