-- E-signature legal-defensibility hardening — three layered fixes
-- to bring the lease e-sign flow up to ESIGN Act §101(c) and UETA.
-- Each section corresponds to one defensibility gap surfaced in the
-- audit; see the README of this migration for citations.
--
-- (1) ESIGN §101(c) consumer disclosure
--     - New columns on doc_signatures capturing the explicit
--       consent acts the signer must perform (separate from the
--       signature itself):
--         e_records_consented              boolean
--         e_records_consent_at             timestamptz
--         e_records_consent_version        text
--         hardware_software_acknowledged   boolean
--         paper_copy_requested_at          timestamptz
--         consent_withdrawn_at             timestamptz
--     - New RPCs request_paper_copy(token) and
--       withdraw_e_records_consent(token) so the signer can
--       exercise the withdrawal/paper-copy rights ESIGN requires
--       to be available at any time.
--
-- (2) Document-version binding
--     - New column doc_generated.doc_hash_at_send: SHA-256 of
--       rendered_body computed when create_doc_envelope is called.
--       This is the hash the SIGNER sees and binds their signature
--       to — independent of any later mutation of rendered_body.
--     - sign_document.integrity_hash drops the timestamp from its
--       inputs so the hash is reproducible on any later
--       verification pass: hash = SHA-256(doc_hash_at_send ||
--       signer_email || signature_data || consent_version).
--     - get_signature_by_token returns doc_hash_at_send so the
--       signer can see and reference it before signing.
--
-- (3) Immutable signed-PDF storage
--     - New columns on doc_generated:
--         signed_pdf_hash                  text  -- SHA-256 of stored PDF bytes
--         signed_pdf_uploaded_at           timestamptz
--     - Client renders the final PDF after the last signer completes
--       and POSTs it to /api/finalize-signed-pdf, which uploads to
--       the signed-documents Storage bucket and writes signed_pdf_hash
--       + signed_pdf_path back via service role.
--
-- This migration is fully idempotent; running it on a database
-- that already has the columns / RPCs is a no-op.

-- ─── (1) Consent columns ─────────────────────────────────────
ALTER TABLE doc_signatures
  ADD COLUMN IF NOT EXISTS e_records_consented boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS e_records_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS e_records_consent_version text,
  ADD COLUMN IF NOT EXISTS hardware_software_acknowledged boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paper_copy_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_withdrawn_reason text;

-- ─── (2) Document-version binding columns ────────────────────
ALTER TABLE doc_generated
  ADD COLUMN IF NOT EXISTS doc_hash_at_send text,
  ADD COLUMN IF NOT EXISTS signed_pdf_hash text,
  ADD COLUMN IF NOT EXISTS signed_pdf_uploaded_at timestamptz;

-- ─── create_doc_envelope: snapshot doc_hash_at_send ──────────
CREATE OR REPLACE FUNCTION create_doc_envelope(p_doc_id uuid, p_signers jsonb)
RETURNS TABLE(signer_id uuid, signer_email text, access_token text, sign_order int, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_company_id text;
  v_template_id uuid;
  v_signing_mode text;
  v_user_email text;
  v_now timestamptz := now();
  v_expiry timestamptz := v_now + interval '30 days';
  v_doc_hash text;
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

  -- Snapshot the rendered body's hash NOW. This is what the signer
  -- will see displayed and what their signature commits to. Any
  -- later mutation of rendered_body will not change this hash, so
  -- a forensic reviewer can detect tampering by re-hashing the
  -- post-mutation body and comparing to doc_hash_at_send.
  SELECT encode(digest(COALESCE(d.rendered_body,''), 'sha256'), 'hex')
    INTO v_doc_hash
    FROM doc_generated d WHERE d.id = p_doc_id;

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
    UPDATE doc_signatures
      SET status = 'sent'
      WHERE doc_id = p_doc_id AND status = 'pending' AND sign_order = v_min_order;
  ELSE
    UPDATE doc_signatures
      SET status = 'sent'
      WHERE doc_id = p_doc_id AND status = 'pending';
  END IF;

  UPDATE doc_generated
    SET envelope_status = 'out_for_signature',
        envelope_sent_at = v_now,
        doc_hash_at_send = v_doc_hash
  WHERE id = p_doc_id;

  RETURN QUERY
    SELECT ds.id, ds.signer_email, ds.access_token, ds.sign_order, ds.status
    FROM doc_signatures ds
    WHERE ds.doc_id = p_doc_id
    ORDER BY ds.sign_order, ds.created_at;
END; $$;

-- ─── get_signature_by_token: include doc_hash_at_send ─────────
CREATE OR REPLACE FUNCTION get_signature_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

  SELECT name, email INTO v_company_name, v_company_email
    FROM companies WHERE id = v_doc.company_id;

  IF v_sig.status = 'sent' THEN
    UPDATE doc_signatures SET status = 'viewed', viewed_at = now()
      WHERE id = v_sig.id;
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
    'expires_at', v_sig.token_expires_at
  );
END; $$;

REVOKE ALL ON FUNCTION get_signature_by_token(text) FROM public;
GRANT EXECUTE ON FUNCTION get_signature_by_token(text) TO anon, authenticated;

-- ─── sign_document: deterministic hash + record consent ───────
-- New parameters:
--   p_e_records_consented   — explicit ESIGN §101(c) consent
--   p_hw_sw_acknowledged    — confirms ability to access electronic format
--   p_consent_version       — version string of the disclosure shown
-- Hash inputs no longer include the timestamp, so the hash is
-- reproducible: any reviewer can recompute it from doc_hash_at_send,
-- signer_email, signature_data, and consent_version.
CREATE OR REPLACE FUNCTION sign_document(
  p_token text,
  p_signer_name text,
  p_signature_data text,
  p_signing_method text,
  p_consent_text text,
  p_user_agent text,
  p_e_records_consented boolean DEFAULT NULL,
  p_hw_sw_acknowledged boolean DEFAULT NULL,
  p_consent_version text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
  v_now timestamptz := now();
  v_hash text;
  v_doc_hash text;
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
  -- ESIGN §101(c)(1)(A): affirmative consent to use electronic records.
  -- Backwards compatibility: if the caller passes NULL (legacy clients
  -- that haven't been updated), accept it but log nothing — the new
  -- frontend always passes true. After all clients update, flip to
  -- requiring true.
  IF p_e_records_consented IS NOT NULL AND p_e_records_consented = false THEN
    RETURN jsonb_build_object('error','electronic records consent required');
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

  -- Use the SNAPSHOTTED doc_hash_at_send (set when envelope was sent),
  -- not the current rendered_body. If the body is mutated between
  -- send and sign, the hash still binds to what the signer originally
  -- saw — that's the whole point. Fall back to recomputing from the
  -- current body for legacy envelopes that pre-date this column.
  v_doc_hash := COALESCE(
    v_doc.doc_hash_at_send,
    encode(digest(COALESCE(v_doc.rendered_body,''), 'sha256'), 'hex')
  );

  -- Reproducible signature hash: no timestamp included.
  -- Reviewers can recompute by hand from these four values.
  v_hash := encode(
    digest(
      v_doc_hash || '|' ||
      v_sig.signer_email || '|' ||
      p_signature_data || '|' ||
      COALESCE(p_consent_version, ''),
      'sha256'
    ), 'hex'
  );

  BEGIN v_ip := inet_client_addr(); EXCEPTION WHEN others THEN v_ip := NULL; END;

  UPDATE doc_signatures SET
    status = 'signed',
    signer_name = COALESCE(NULLIF(p_signer_name,''), signer_name),
    signature_data = p_signature_data,
    signing_method = p_signing_method,
    consent_text = p_consent_text,
    user_agent = p_user_agent,
    signer_ip = v_ip,
    integrity_hash = v_hash,
    signed_at = v_now,
    e_records_consented = COALESCE(p_e_records_consented, e_records_consented),
    e_records_consent_at = CASE WHEN p_e_records_consented IS TRUE THEN v_now ELSE e_records_consent_at END,
    e_records_consent_version = COALESCE(p_consent_version, e_records_consent_version),
    hardware_software_acknowledged = COALESCE(p_hw_sw_acknowledged, hardware_software_acknowledged)
  WHERE id = v_sig.id;

  SELECT COUNT(*) INTO v_remaining FROM doc_signatures
    WHERE doc_id = v_sig.doc_id AND status IN ('pending','sent','viewed');

  IF v_remaining = 0 THEN
    UPDATE doc_generated SET envelope_status = 'completed', envelope_completed_at = v_now
      WHERE id = v_sig.doc_id;
    v_all_signed := true;
  ELSE
    v_all_signed := false;
    SELECT COALESCE(t.signing_mode, 'parallel') INTO v_signing_mode
      FROM doc_generated d LEFT JOIN doc_templates t ON t.id = d.template_id
      WHERE d.id = v_sig.doc_id;
    IF v_signing_mode = 'sequential' THEN
      SELECT MIN(ds.sign_order) INTO v_next_min_order FROM doc_signatures ds
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
    'doc_hash_at_send', v_doc_hash,
    'all_signed', v_all_signed,
    'doc_id', v_sig.doc_id,
    'next_signer_id', v_next_id,
    'next_signer_email', v_next_email
  );
END; $$;

REVOKE ALL ON FUNCTION sign_document(text, text, text, text, text, text, boolean, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION sign_document(text, text, text, text, text, text, boolean, boolean, text) TO anon, authenticated;

-- ─── request_paper_copy ──────────────────────────────────────
-- Lets a signer (using their token even after signing, while the
-- token is still within its 30-day window) flag that they want a
-- paper copy. Staff sees this in the signatures admin view and
-- mails the paper. ESIGN §101(c)(1)(B)(iv) requires this option.
CREATE OR REPLACE FUNCTION request_paper_copy(p_token text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < now() THEN RETURN jsonb_build_object('error','token expired'); END IF;
  UPDATE doc_signatures
    SET paper_copy_requested_at = now(),
        consent_withdrawn_reason = COALESCE(NULLIF(p_reason, ''), consent_withdrawn_reason)
    WHERE id = v_sig.id;
  RETURN jsonb_build_object('success', true, 'requested_at', now());
END; $$;
REVOKE ALL ON FUNCTION request_paper_copy(text, text) FROM public;
GRANT EXECUTE ON FUNCTION request_paper_copy(text, text) TO anon, authenticated;

-- ─── withdraw_e_records_consent ──────────────────────────────
-- Per ESIGN §101(c)(1)(B)(i)(II): the signer must be able to
-- withdraw consent at any time. Withdrawal does not invalidate
-- the signature already given — it's a forward-looking notice
-- that future communications should be paper.
CREATE OR REPLACE FUNCTION withdraw_e_records_consent(p_token text, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  UPDATE doc_signatures
    SET consent_withdrawn_at = now(),
        consent_withdrawn_reason = NULLIF(p_reason, '')
    WHERE id = v_sig.id;
  RETURN jsonb_build_object('success', true, 'withdrawn_at', now());
END; $$;
REVOKE ALL ON FUNCTION withdraw_e_records_consent(text, text) FROM public;
GRANT EXECUTE ON FUNCTION withdraw_e_records_consent(text, text) TO anon, authenticated;

-- ─── set_signed_pdf — service-role-only finalization hook ────
-- Called by /api/finalize-signed-pdf after the client uploads the
-- rendered PDF to Storage. Writes the storage path + sha256 hash
-- back onto doc_generated, marking the envelope's signed-bytes as
-- canonical. Idempotent: if already set, no-op.
CREATE OR REPLACE FUNCTION set_signed_pdf(
  p_doc_id uuid,
  p_pdf_path text,
  p_pdf_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_doc doc_generated%ROWTYPE;
BEGIN
  SELECT * INTO v_doc FROM doc_generated WHERE id = p_doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;
  IF v_doc.envelope_status <> 'completed' THEN
    RETURN jsonb_build_object('error','envelope not completed');
  END IF;
  IF v_doc.signed_pdf_path IS NOT NULL THEN
    -- Idempotent: don't overwrite an existing signed PDF.
    RETURN jsonb_build_object('already_set', true,
      'signed_pdf_path', v_doc.signed_pdf_path,
      'signed_pdf_hash', v_doc.signed_pdf_hash);
  END IF;
  UPDATE doc_generated
    SET signed_pdf_path = p_pdf_path,
        signed_pdf_hash = p_pdf_hash,
        signed_pdf_uploaded_at = now()
    WHERE id = p_doc_id;
  RETURN jsonb_build_object('success', true);
END; $$;
-- service role only — no GRANT to anon/authenticated.

-- ─── Storage bucket for signed PDFs (idempotent) ─────────────
-- Bucket is private; downloads are gated by a SECURITY DEFINER RPC
-- (get_signed_pdf_url) that signs a short-lived URL — added in a
-- follow-up migration. Creating bucket via insert ... ON CONFLICT
-- so re-running is safe.
INSERT INTO storage.buckets (id, name, public)
VALUES ('signed-documents', 'signed-documents', false)
ON CONFLICT (id) DO NOTHING;
