-- The signing page shows the signatures already given by the other
-- signers on their own lines (Sahil, 2026-10-03: "show earlier signers'
-- signatures on screen to the later signers", as DocuSign does).
-- get_signature_by_token gains 'others': role, name, status, time, and --
-- for a signer who has signed -- their signature and initials.
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
    'initials_each_page', COALESCE((v_doc.field_values ->> '_initials_each_page')::boolean, false),
    -- The other signers of this document, so the page can show the
    -- signatures already given on their lines (the signed copy carries
    -- them all; a co-signer sees nothing here they will not see there).
    'others', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'role', o.signer_role, 'name', o.signer_name, 'status', o.status, 'signed_at', o.signed_at,
        'signature_data', CASE WHEN o.status = 'signed' THEN o.signature_data END,
        'initials_data', CASE WHEN o.status = 'signed' THEN o.initials_data END
      ) ORDER BY o.sign_order, o.created_at)
      FROM doc_signatures o WHERE o.doc_id = v_doc.id AND o.id <> v_sig.id
    ), '[]'::jsonb)
  );
END $$;
NOTIFY pgrst, 'reload schema';
