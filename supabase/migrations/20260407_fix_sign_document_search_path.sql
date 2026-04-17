-- Fix: sign_document couldn't resolve digest() because pgcrypto lives in the
-- extensions schema on Supabase and the RPC's search_path only included public.
-- Caught by tests/doc-signatures.test.js:
--   "function digest(text, unknown) does not exist"
-- Widen search_path on all three e-sign RPCs so extension functions resolve.
-- Also cast the signature-hash input through convert_to(text, 'UTF8') to
-- eliminate the text/bytea ambiguity.

CREATE OR REPLACE FUNCTION create_doc_envelope(p_doc_id uuid, p_signers jsonb)
RETURNS TABLE(signer_id uuid, signer_email text, access_token text, sign_order int, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_company_id text;
  v_template_id uuid;
  v_signing_mode text;
  v_user_email text;
  v_now timestamptz := now();
  v_expiry timestamptz := v_now + interval '30 days';
  s jsonb;
  v_min_order int;
BEGIN
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT d.company_id, d.template_id INTO v_company_id, v_template_id
  FROM doc_generated d WHERE d.id = p_doc_id;
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'doc not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM company_members cm
    WHERE cm.company_id = v_company_id
      AND cm.user_email ILIKE v_user_email
      AND cm.status = 'active'
      AND cm.role IN ('admin','owner','pm','office_assistant')
  ) THEN
    RAISE EXCEPTION 'not authorized for this company';
  END IF;

  SELECT COALESCE(t.signing_mode, 'parallel') INTO v_signing_mode
  FROM doc_templates t WHERE t.id = v_template_id;
  v_signing_mode := COALESCE(v_signing_mode, 'parallel');
  IF v_signing_mode = 'none' THEN v_signing_mode := 'parallel'; END IF;

  DELETE FROM doc_signatures
  WHERE doc_id = p_doc_id AND status IN ('pending','sent','viewed');

  FOR s IN SELECT * FROM jsonb_array_elements(p_signers) LOOP
    INSERT INTO doc_signatures (
      company_id, doc_id, signer_role, signer_name, signer_email,
      sign_order, status, access_token, token_expires_at, sent_at
    ) VALUES (
      v_company_id, p_doc_id,
      COALESCE(s->>'role', 'signer'),
      s->>'name',
      lower(s->>'email'),
      COALESCE((s->>'order')::int, 1),
      'pending',
      _gen_signing_token(),
      v_expiry,
      v_now
    );
  END LOOP;

  IF v_signing_mode = 'sequential' THEN
    SELECT MIN(ds.sign_order) INTO v_min_order
      FROM doc_signatures ds
      WHERE ds.doc_id = p_doc_id AND ds.status = 'pending';
    UPDATE doc_signatures SET status = 'sent'
      WHERE doc_id = p_doc_id AND status = 'pending' AND sign_order = v_min_order;
  ELSE
    UPDATE doc_signatures SET status = 'sent'
      WHERE doc_id = p_doc_id AND status = 'pending';
  END IF;

  UPDATE doc_generated
    SET envelope_status = 'out_for_signature', envelope_sent_at = v_now
  WHERE id = p_doc_id;

  RETURN QUERY
    SELECT ds.id, ds.signer_email, ds.access_token, ds.sign_order, ds.status
    FROM doc_signatures ds
    WHERE ds.doc_id = p_doc_id
    ORDER BY ds.sign_order, ds.created_at;
END; $$;

CREATE OR REPLACE FUNCTION get_signature_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
  v_company_name text;
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
  SELECT name INTO v_company_name FROM companies WHERE id = v_doc.company_id;
  IF v_sig.status = 'sent' THEN
    UPDATE doc_signatures SET status = 'viewed', viewed_at = now() WHERE id = v_sig.id;
    v_sig.status := 'viewed'; v_sig.viewed_at := now();
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
    'doc_property_address', v_doc.property_address,
    'doc_tenant_name', v_doc.tenant_name,
    'company_name', v_company_name,
    'expires_at', v_sig.token_expires_at
  );
END; $$;

CREATE OR REPLACE FUNCTION sign_document(
  p_token text,
  p_signer_name text,
  p_signature_data text,
  p_signing_method text,
  p_consent_text text,
  p_user_agent text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
  v_now timestamptz := now();
  v_hash text;
  v_ip inet;
  v_remaining int;
  v_signing_mode text;
  v_next_id uuid;
  v_next_email text;
  v_next_min_order int;
  v_all_signed boolean;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  IF p_signature_data IS NULL OR length(p_signature_data) < 10 THEN
    RETURN jsonb_build_object('error','signature required');
  END IF;
  IF p_consent_text IS NULL OR length(p_consent_text) < 10 THEN
    RETURN jsonb_build_object('error','consent text required');
  END IF;

  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < v_now THEN RETURN jsonb_build_object('error','token expired'); END IF;
  IF v_sig.status NOT IN ('sent','viewed') THEN
    RETURN jsonb_build_object('error','already signed or cancelled','status',v_sig.status);
  END IF;
  IF p_signing_method NOT IN ('draw','type') THEN
    RETURN jsonb_build_object('error','invalid signing method');
  END IF;

  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;

  -- Cast text input to bytea via convert_to so digest() picks the bytea overload
  -- unambiguously, regardless of pgcrypto's install schema.
  v_hash := encode(
    digest(
      convert_to(
        COALESCE(v_doc.rendered_body,'') || '|' ||
        v_sig.signer_email || '|' ||
        p_signature_data || '|' ||
        v_now::text,
        'UTF8'
      ),
      'sha256'
    ), 'hex'
  );

  BEGIN
    v_ip := inet_client_addr();
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;

  UPDATE doc_signatures SET
    status = 'signed',
    signer_name = COALESCE(NULLIF(p_signer_name,''), signer_name),
    signature_data = p_signature_data,
    signing_method = p_signing_method,
    consent_text = p_consent_text,
    user_agent = p_user_agent,
    signer_ip = v_ip,
    integrity_hash = v_hash,
    signed_at = v_now
  WHERE id = v_sig.id;

  SELECT COUNT(*) INTO v_remaining
    FROM doc_signatures
    WHERE doc_id = v_sig.doc_id AND status IN ('pending','sent','viewed');

  IF v_remaining = 0 THEN
    UPDATE doc_generated
      SET envelope_status = 'completed', envelope_completed_at = v_now
      WHERE id = v_sig.doc_id;
    v_all_signed := true;
  ELSE
    v_all_signed := false;
    SELECT COALESCE(t.signing_mode, 'parallel') INTO v_signing_mode
      FROM doc_generated d LEFT JOIN doc_templates t ON t.id = d.template_id
      WHERE d.id = v_sig.doc_id;
    IF v_signing_mode = 'sequential' THEN
      SELECT MIN(ds.sign_order) INTO v_next_min_order
        FROM doc_signatures ds
        WHERE ds.doc_id = v_sig.doc_id AND ds.status = 'pending';
      IF v_next_min_order IS NOT NULL THEN
        UPDATE doc_signatures SET status = 'sent'
          WHERE doc_id = v_sig.doc_id AND status = 'pending' AND sign_order = v_next_min_order
          RETURNING id, signer_email INTO v_next_id, v_next_email;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'signed_at', v_now,
    'integrity_hash', v_hash,
    'all_signed', v_all_signed,
    'next_signer_id', v_next_id,
    'next_signer_email', v_next_email
  );
END; $$;
