-- Generalized e-signature engine that any doc_generated row can use.
-- Leaves existing lease_signatures + sign_lease intact for backward compatibility;
-- a later migration will backfill lease_signatures into doc_signatures and rewrite
-- sign_lease as a thin wrapper around sign_document.

-- ============ doc_templates: envelope config ============
ALTER TABLE doc_templates
  ADD COLUMN IF NOT EXISTS signing_mode text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS signer_roles jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE doc_templates
  DROP CONSTRAINT IF EXISTS doc_templates_signing_mode_check;
ALTER TABLE doc_templates
  ADD CONSTRAINT doc_templates_signing_mode_check
  CHECK (signing_mode IN ('none','parallel','sequential'));

-- ============ doc_generated: envelope lifecycle ============
ALTER TABLE doc_generated
  ADD COLUMN IF NOT EXISTS envelope_status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS envelope_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS envelope_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS signed_pdf_path text,
  ADD COLUMN IF NOT EXISTS certificate_pdf_path text;

ALTER TABLE doc_generated
  DROP CONSTRAINT IF EXISTS doc_generated_envelope_status_check;
ALTER TABLE doc_generated
  ADD CONSTRAINT doc_generated_envelope_status_check
  CHECK (envelope_status IN ('draft','out_for_signature','completed','declined','voided'));

-- ============ doc_signatures table ============
CREATE TABLE IF NOT EXISTS doc_signatures (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        text NOT NULL,
  doc_id            uuid NOT NULL REFERENCES doc_generated(id) ON DELETE CASCADE,
  signer_role       text NOT NULL,
  signer_name       text,
  signer_email      text NOT NULL,
  sign_order        int NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'pending',  -- pending | sent | viewed | signed | declined | voided
  access_token      text UNIQUE,
  token_expires_at  timestamptz,
  signature_data    text,
  signing_method    text,            -- 'draw' | 'type'
  consent_text      text,
  signer_ip         inet,
  user_agent        text,
  integrity_hash    text,
  sent_at           timestamptz,
  viewed_at         timestamptz,
  signed_at         timestamptz,
  declined_at       timestamptz,
  declined_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doc_signatures_doc ON doc_signatures(doc_id);
CREATE INDEX IF NOT EXISTS idx_doc_signatures_company ON doc_signatures(company_id);
CREATE INDEX IF NOT EXISTS idx_doc_signatures_token ON doc_signatures(access_token) WHERE access_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doc_signatures_email ON doc_signatures(signer_email);

ALTER TABLE doc_signatures
  DROP CONSTRAINT IF EXISTS doc_signatures_status_check;
ALTER TABLE doc_signatures
  ADD CONSTRAINT doc_signatures_status_check
  CHECK (status IN ('pending','sent','viewed','signed','declined','voided'));

ALTER TABLE doc_signatures ENABLE ROW LEVEL SECURITY;

-- Staff (authenticated) can read/write their own company's signatures.
DROP POLICY IF EXISTS doc_signatures_select ON doc_signatures;
CREATE POLICY doc_signatures_select ON doc_signatures FOR SELECT TO authenticated
USING (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
));

DROP POLICY IF EXISTS doc_signatures_insert ON doc_signatures;
CREATE POLICY doc_signatures_insert ON doc_signatures FOR INSERT TO authenticated
WITH CHECK (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
    AND cm.role IN ('admin','owner','pm','office_assistant')
));

DROP POLICY IF EXISTS doc_signatures_update ON doc_signatures;
CREATE POLICY doc_signatures_update ON doc_signatures FOR UPDATE TO authenticated
USING (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
    AND cm.role IN ('admin','owner','pm','office_assistant')
));

-- Anon users have NO direct access. Public signing page must go through
-- SECURITY DEFINER RPCs below.

-- ============ helper: URL-safe 32-byte token ============
CREATE OR REPLACE FUNCTION _gen_signing_token() RETURNS text AS $$
  SELECT translate(replace(encode(gen_random_bytes(32), 'base64'), '=', ''), '+/', '-_');
$$ LANGUAGE sql VOLATILE;

-- ============ create_doc_envelope ============
-- Input: doc_id + signers array [{ role, name, email, order }]
-- Inserts one doc_signatures row per signer, sets access_token + 30d expiry.
-- For 'sequential' mode only the order=1 signer is marked sent; others stay pending.
-- For 'parallel' mode all signers marked sent at once.
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

  -- Caller must be an active staff member of the doc's company
  IF NOT EXISTS (
    SELECT 1 FROM company_members cm
    WHERE cm.company_id = v_company_id
      AND cm.user_email ILIKE v_user_email
      AND cm.status = 'active'
      AND cm.role IN ('admin','owner','pm','office_assistant')
  ) THEN
    RAISE EXCEPTION 'not authorized for this company';
  END IF;

  -- Look up signing mode from template (if any). Template-less docs (legacy leases)
  -- default to parallel.
  SELECT COALESCE(t.signing_mode, 'parallel') INTO v_signing_mode
  FROM doc_templates t WHERE t.id = v_template_id;
  v_signing_mode := COALESCE(v_signing_mode, 'parallel');
  IF v_signing_mode = 'none' THEN
    v_signing_mode := 'parallel';
  END IF;

  -- Replace any existing pending/sent signatures (allows resending) but keep
  -- already-signed rows for audit.
  DELETE FROM doc_signatures
  WHERE doc_id = p_doc_id AND status IN ('pending','sent','viewed');

  -- Insert one row per signer from p_signers array.
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

  -- For sequential: activate only the lowest-order signer.
  -- For parallel: activate all at once.
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

  -- Flip envelope status
  UPDATE doc_generated
    SET envelope_status = 'out_for_signature',
        envelope_sent_at = v_now
  WHERE id = p_doc_id;

  -- Return all signature rows (caller uses this to build and send magic-link emails)
  RETURN QUERY
    SELECT ds.id, ds.signer_email, ds.access_token, ds.sign_order, ds.status
    FROM doc_signatures ds
    WHERE ds.doc_id = p_doc_id
    ORDER BY ds.sign_order, ds.created_at;
END; $$;

REVOKE ALL ON FUNCTION create_doc_envelope(uuid, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION create_doc_envelope(uuid, jsonb) TO authenticated;

-- ============ get_signature_by_token ============
-- Public (anon) RPC. Returns signer + rendered doc body when token is valid and
-- this signer is currently sent/viewed (not already signed or out of order).
-- Stamps viewed_at on first call.
CREATE OR REPLACE FUNCTION get_signature_by_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
  v_company_name text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;

  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','token not found');
  END IF;

  IF v_sig.token_expires_at < now() THEN
    RETURN jsonb_build_object('error','token expired');
  END IF;

  IF v_sig.status NOT IN ('sent','viewed') THEN
    RETURN jsonb_build_object(
      'error','not available',
      'status', v_sig.status,
      'signed_at', v_sig.signed_at
    );
  END IF;

  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','doc not found');
  END IF;

  SELECT name INTO v_company_name FROM companies WHERE id = v_doc.company_id;

  -- Mark viewed if first time
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
    'doc_property_address', v_doc.property_address,
    'doc_tenant_name', v_doc.tenant_name,
    'company_name', v_company_name,
    'expires_at', v_sig.token_expires_at
  );
END; $$;

REVOKE ALL ON FUNCTION get_signature_by_token(text) FROM public;
GRANT EXECUTE ON FUNCTION get_signature_by_token(text) TO anon, authenticated;

-- ============ sign_document ============
-- Public (anon) RPC. Validates token + expiry, records signature + IP + UA + hash,
-- advances the envelope. Returns { all_signed, next_signer_email? } on success.
CREATE OR REPLACE FUNCTION sign_document(
  p_token text,
  p_signer_name text,
  p_signature_data text,
  p_signing_method text,
  p_consent_text text,
  p_user_agent text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','token not found');
  END IF;
  IF v_sig.token_expires_at < v_now THEN
    RETURN jsonb_build_object('error','token expired');
  END IF;
  IF v_sig.status NOT IN ('sent','viewed') THEN
    RETURN jsonb_build_object('error','already signed or cancelled','status',v_sig.status);
  END IF;
  IF p_signing_method NOT IN ('draw','type') THEN
    RETURN jsonb_build_object('error','invalid signing method');
  END IF;

  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error','doc not found');
  END IF;

  -- Integrity hash: SHA-256 over (doc body || email || signature || timestamp).
  v_hash := encode(
    digest(
      COALESCE(v_doc.rendered_body,'') || '|' ||
      v_sig.signer_email || '|' ||
      p_signature_data || '|' ||
      v_now::text,
      'sha256'
    ), 'hex'
  );

  -- inet_client_addr() returns NULL for PgBouncer pooled connections on Supabase.
  -- Accept that gracefully.
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

  -- Any pending/sent signers left on this doc?
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

    -- Sequential? advance the next-order signer from pending → sent.
    SELECT COALESCE(t.signing_mode, 'parallel') INTO v_signing_mode
      FROM doc_generated d LEFT JOIN doc_templates t ON t.id = d.template_id
      WHERE d.id = v_sig.doc_id;

    IF v_signing_mode = 'sequential' THEN
      SELECT MIN(ds.sign_order) INTO v_next_min_order
        FROM doc_signatures ds
        WHERE ds.doc_id = v_sig.doc_id AND ds.status = 'pending';
      IF v_next_min_order IS NOT NULL THEN
        UPDATE doc_signatures
          SET status = 'sent'
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

REVOKE ALL ON FUNCTION sign_document(text,text,text,text,text,text) FROM public;
GRANT EXECUTE ON FUNCTION sign_document(text,text,text,text,text,text) TO anon, authenticated;
