-- Documents, phase 0: link generated documents to records, and repair the
-- e-sign engine so another module can rely on it.
--
-- Found while planning the Tenant <-> Document Builder wiring
-- (docs/PLAN-tenant-documents.md):
--   * a generated document knows its tenant only by NAME, and its lease
--     and property not at all (the lease id sat inside a JSON blob);
--   * re-sending a signature request failed outright: create_doc_envelope
--     DELETEd the open signer rows, the audit trigger then logged a row
--     pointing at the deleted id, and the audit log's foreign key refused it;
--   * with two signers at the same step, the first signature promoted the
--     NEXT step (the landlord) while the second tenant had not signed, and
--     "UPDATE ... RETURNING INTO" raised when a step held two signers;
--   * a lease never showed as signed: nothing wrote leases.signature_status
--     once the old sign_lease RPC was retired;
--   * every active member of a company -- tenants included -- could read
--     every signature row, and the row holds the secret signing link.
--
-- Everything here is additive except the three policy/constraint fixes.

-- ── 1. doc_generated: links by record ────────────────────────────────
ALTER TABLE public.doc_generated
  ADD COLUMN IF NOT EXISTS lease_id uuid REFERENCES public.leases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eviction_case_id uuid REFERENCES public.eviction_cases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS doc_kind text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS signing_mode text,
  ADD COLUMN IF NOT EXISTS served_at timestamptz,
  ADD COLUMN IF NOT EXISTS served_method text,
  ADD COLUMN IF NOT EXISTS effective_date date,
  ADD COLUMN IF NOT EXISTS pdf_output_hash text,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by text,
  ADD COLUMN IF NOT EXISTS void_reason text,
  ADD COLUMN IF NOT EXISTS filed_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL;

-- property_id was text, never written and never constrained. Make it the
-- real link. Anything that is not a number, or not a property, becomes NULL
-- rather than failing the migration.
ALTER TABLE public.doc_generated
  ALTER COLUMN property_id TYPE integer
  USING (CASE WHEN property_id ~ '^[0-9]+$' THEN property_id::integer END);
UPDATE public.doc_generated d SET property_id = NULL
 WHERE d.property_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.properties p WHERE p.id = d.property_id);
ALTER TABLE public.doc_generated
  DROP CONSTRAINT IF EXISTS doc_generated_property_id_fkey,
  ADD CONSTRAINT doc_generated_property_id_fkey FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE SET NULL;

ALTER TABLE public.doc_generated
  DROP CONSTRAINT IF EXISTS doc_generated_signing_mode_check,
  ADD CONSTRAINT doc_generated_signing_mode_check CHECK (signing_mode IS NULL OR signing_mode IN ('parallel','sequential')),
  DROP CONSTRAINT IF EXISTS doc_generated_doc_kind_check,
  ADD CONSTRAINT doc_generated_doc_kind_check CHECK (doc_kind IN (
    'lease','renewal','addendum','rent_increase_notice','notice_to_vacate','move_out_acknowledgment',
    'late_notice','notice_of_intent','ftpr_complaint','court_other','move_out_statement',
    'deposit_disposition','letter','other'));

-- The Leases page kept its lease id inside field_values. Lift it out.
UPDATE public.doc_generated d
   SET lease_id = l.id, doc_kind = 'lease'
  FROM public.leases l
 WHERE d.lease_id IS NULL
   AND d.field_values ->> 'lease_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND l.id = (d.field_values ->> 'lease_id')::uuid
   AND l.company_id = d.company_id;
UPDATE public.doc_generated SET doc_kind = 'lease' WHERE output_type = 'lease' AND doc_kind = 'other';

CREATE INDEX IF NOT EXISTS idx_doc_generated_tenant ON public.doc_generated (company_id, tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doc_generated_lease ON public.doc_generated (lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doc_generated_property ON public.doc_generated (company_id, property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doc_generated_case ON public.doc_generated (eviction_case_id) WHERE eviction_case_id IS NOT NULL;

-- ── 2. doc_templates: a stable key, so a button finds "the lease" even
--      after someone renames the template ────────────────────────────
ALTER TABLE public.doc_templates ADD COLUMN IF NOT EXISTS template_key text;
WITH keyed AS (
  SELECT id, CASE lower(btrim(name))
      WHEN 'md residential lease' THEN 'md_residential_lease'
      WHEN 'lease renewal offer' THEN 'lease_renewal_offer'
      WHEN 'rent increase notice' THEN 'rent_increase_notice'
      WHEN 'notice to vacate' THEN 'notice_to_vacate'
      WHEN 'notice to pay or quit' THEN 'notice_to_pay_or_quit'
      WHEN 'late fee notice' THEN 'late_fee_notice'
      WHEN 'lease addendum' THEN 'lease_addendum'
      WHEN 'general letter' THEN 'general_letter'
      WHEN 'maintenance authorization' THEN 'maintenance_authorization'
    END AS k,
    row_number() OVER (PARTITION BY company_id, lower(btrim(name)) ORDER BY created_at, id) AS rn
  FROM public.doc_templates WHERE is_active IS NOT FALSE AND template_key IS NULL
)
UPDATE public.doc_templates t SET template_key = keyed.k
  FROM keyed WHERE keyed.id = t.id AND keyed.k IS NOT NULL AND keyed.rn = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_templates_company_key
  ON public.doc_templates (company_id, template_key) WHERE template_key IS NOT NULL AND is_active IS NOT FALSE;

-- ── 3. doc_signatures: delivery facts, and who may read the links ────
ALTER TABLE public.doc_signatures
  ADD COLUMN IF NOT EXISTS request_emailed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;

-- access_token IS the signing link. Staff only. A signer reaches their own
-- row through get_signature_by_token, which needs no table access.
DROP POLICY IF EXISTS doc_signatures_select ON public.doc_signatures;
CREATE POLICY doc_signatures_select ON public.doc_signatures
  FOR SELECT TO authenticated USING (public.is_company_staff(company_id));

DROP POLICY IF EXISTS doc_templates_system_read ON public.doc_templates;
CREATE POLICY doc_templates_system_read ON public.doc_templates
  FOR SELECT TO authenticated
  USING (company_id = '00000000-0000-0000-0000-000000000000' OR public.is_company_staff(company_id));

-- An audit log must outlive what it describes. The foreign key made the
-- "delete" audit row itself impossible to write.
ALTER TABLE public.doc_signature_audit_log DROP CONSTRAINT IF EXISTS doc_signature_audit_log_signature_id_fkey;

-- ── 4. A log of every document email: who, when, and whether it left ─
CREATE TABLE IF NOT EXISTS public.doc_email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  doc_id uuid REFERENCES public.doc_generated(id) ON DELETE SET NULL,
  signature_id uuid,
  kind text NOT NULL,              -- sign_request | sign_reminder | signed_copy | completed_staff | document
  to_email text NOT NULL,          -- where it actually went
  intended_email text,             -- where it was meant to go (differs on the test site)
  subject text,
  status text NOT NULL,            -- sent | failed | suppressed
  error text,
  provider_id text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_email_log_doc ON public.doc_email_log (doc_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_email_log_company ON public.doc_email_log (company_id, created_at DESC);
ALTER TABLE public.doc_email_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_email_log_staff_read ON public.doc_email_log;
CREATE POLICY doc_email_log_staff_read ON public.doc_email_log
  FOR SELECT TO authenticated USING (public.is_company_staff(company_id));
REVOKE ALL ON public.doc_email_log FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.doc_email_log FROM authenticated;
GRANT SELECT ON public.doc_email_log TO authenticated;
GRANT ALL ON public.doc_email_log TO service_role;

-- ── 5. Keep a lease's signature status true ──────────────────────────
CREATE OR REPLACE FUNCTION public._sync_lease_signature_status(p_doc_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_doc doc_generated%ROWTYPE; v_lease uuid; v_open int; v_signed int; v_status text;
BEGIN
  SELECT * INTO v_doc FROM doc_generated WHERE id = p_doc_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_lease := v_doc.lease_id;
  IF v_lease IS NULL THEN RETURN; END IF;
  SELECT count(*) FILTER (WHERE status IN ('pending','sent','viewed')),
         count(*) FILTER (WHERE status = 'signed')
    INTO v_open, v_signed FROM doc_signatures WHERE doc_id = p_doc_id;
  v_status := CASE
    WHEN v_doc.envelope_status = 'completed' THEN 'fully_signed'
    WHEN v_doc.envelope_status IN ('voided','declined') THEN 'unsigned'
    WHEN v_signed > 0 THEN 'partially_signed'
    WHEN v_open > 0 THEN 'pending'
    ELSE 'unsigned' END;
  UPDATE leases SET signature_status = v_status
   WHERE id = v_lease AND company_id = v_doc.company_id AND signature_status IS DISTINCT FROM v_status;
END $$;
REVOKE ALL ON FUNCTION public._sync_lease_signature_status(uuid) FROM PUBLIC, anon, authenticated;

-- ── 6. create_doc_envelope: re-sendable, and the mode travels with the doc
DROP FUNCTION IF EXISTS public.create_doc_envelope(uuid, jsonb);
CREATE OR REPLACE FUNCTION public.create_doc_envelope(p_doc_id uuid, p_signers jsonb, p_signing_mode text DEFAULT NULL)
RETURNS TABLE(signer_id uuid, signer_email text, access_token text, sign_order integer, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE
  v_company_id text; v_template_id uuid; v_doc_mode text; v_signing_mode text; v_user_email text;
  v_now timestamptz := now(); v_expiry timestamptz := now() + interval '30 days';
  v_doc_hash text; s jsonb; v_min_order int;
BEGIN
  v_user_email := auth.jwt() ->> 'email';
  IF v_user_email IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  SELECT d.company_id, d.template_id, d.signing_mode INTO v_company_id, v_template_id, v_doc_mode FROM doc_generated d WHERE d.id = p_doc_id;
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'doc not found'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM company_members cm
     WHERE cm.company_id = v_company_id AND cm.user_email ILIKE v_user_email
       AND cm.status = 'active' AND cm.role IN ('admin','pm','manager','office_assistant')
  ) THEN RAISE EXCEPTION 'not authorized for this company'; END IF;
  IF p_signers IS NULL OR jsonb_typeof(p_signers) <> 'array' OR jsonb_array_length(p_signers) = 0 THEN
    RAISE EXCEPTION 'at least one signer is required';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_signers) e WHERE coalesce(btrim(e->>'email'),'') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') THEN
    RAISE EXCEPTION 'every signer needs a valid email address';
  END IF;
  SELECT encode(digest(COALESCE(d.rendered_body,''), 'sha256'), 'hex') INTO v_doc_hash FROM doc_generated d WHERE d.id = p_doc_id;
  -- Mode: what the caller asked for, else what this document was last sent
  -- with, else the template's. 'none' on a template means "not normally
  -- signed"; if someone sends it anyway, everyone gets it at once.
  SELECT t.signing_mode INTO v_signing_mode FROM doc_templates t WHERE t.id = v_template_id;
  v_signing_mode := COALESCE(NULLIF(p_signing_mode,''), v_doc_mode, v_signing_mode, 'parallel');
  IF v_signing_mode = 'none' THEN v_signing_mode := 'parallel'; END IF;
  IF v_signing_mode NOT IN ('parallel','sequential') THEN RAISE EXCEPTION 'invalid signing mode'; END IF;
  -- Retire open requests instead of deleting them: their links stop
  -- working, and the history of who was asked stays.
  UPDATE doc_signatures SET status = 'voided' WHERE doc_id = p_doc_id AND status IN ('pending','sent','viewed');
  FOR s IN SELECT * FROM jsonb_array_elements(p_signers) LOOP
    INSERT INTO doc_signatures (company_id, doc_id, signer_role, signer_name, signer_email, sign_order, status, access_token, token_expires_at, sent_at)
    VALUES (v_company_id, p_doc_id, COALESCE(s->>'role', 'signer'), s->>'name', lower(btrim(s->>'email')),
            COALESCE((s->>'order')::int, 1), 'pending', _gen_signing_token(), v_expiry, v_now);
  END LOOP;
  IF v_signing_mode = 'sequential' THEN
    SELECT MIN(ds.sign_order) INTO v_min_order FROM doc_signatures ds WHERE ds.doc_id = p_doc_id AND ds.status = 'pending';
    UPDATE doc_signatures SET status = 'sent' WHERE doc_id = p_doc_id AND status = 'pending' AND sign_order = v_min_order;
  ELSE
    UPDATE doc_signatures SET status = 'sent' WHERE doc_id = p_doc_id AND status = 'pending';
  END IF;
  UPDATE doc_generated SET envelope_status = 'out_for_signature', envelope_sent_at = v_now, doc_hash_at_send = v_doc_hash,
         signing_mode = v_signing_mode, voided_at = NULL, voided_by = NULL, void_reason = NULL,
         envelope_completed_at = NULL
   WHERE id = p_doc_id;
  PERFORM _sync_lease_signature_status(p_doc_id);
  RETURN QUERY SELECT ds.id, ds.signer_email, ds.access_token, ds.sign_order, ds.status
    FROM doc_signatures ds WHERE ds.doc_id = p_doc_id AND ds.status IN ('pending','sent') ORDER BY ds.sign_order, ds.created_at;
END; $$;
REVOKE ALL ON FUNCTION public.create_doc_envelope(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_doc_envelope(uuid, jsonb, text) TO authenticated, service_role;

-- ── 7. sign_document: a step is done when EVERYONE in it has signed ──
CREATE OR REPLACE FUNCTION public.sign_document(p_token text, p_signer_name text, p_signature_data text, p_signing_method text, p_consent_text text, p_user_agent text, p_e_records_consented boolean DEFAULT NULL::boolean, p_hw_sw_acknowledged boolean DEFAULT NULL::boolean, p_consent_version text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
  v_now timestamptz := now();
  v_hash text; v_doc_hash text; v_ip inet;
  v_remaining int; v_in_flight int; v_signing_mode text;
  v_next_id uuid; v_next_email text; v_next_min_order int; v_next_count int := 0;
  v_all_signed boolean;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN RETURN jsonb_build_object('error','invalid token'); END IF;
  IF p_signature_data IS NULL OR length(p_signature_data) < 10 THEN RETURN jsonb_build_object('error','signature required'); END IF;
  IF p_consent_text IS NULL OR length(p_consent_text) < 10 THEN RETURN jsonb_build_object('error','consent text required'); END IF;
  -- ESIGN §101(c)(1)(A): affirmative consent to use electronic records.
  IF p_e_records_consented IS NOT NULL AND p_e_records_consented = false THEN
    RETURN jsonb_build_object('error','electronic records consent required');
  END IF;

  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < v_now THEN RETURN jsonb_build_object('error','token expired'); END IF;
  IF v_sig.status NOT IN ('sent','viewed') THEN
    RETURN jsonb_build_object('error','already signed or cancelled','status',v_sig.status);
  END IF;
  IF p_signing_method NOT IN ('draw','type') THEN RETURN jsonb_build_object('error','invalid signing method'); END IF;

  -- Lock the document too: two signers finishing at the same moment must
  -- not both conclude "someone is still outstanding".
  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;
  IF v_doc.envelope_status = 'voided' THEN RETURN jsonb_build_object('error','already signed or cancelled','status','voided'); END IF;

  -- The hash snapshotted at send, not the current body: it binds the
  -- signature to what the signer was shown.
  v_doc_hash := COALESCE(v_doc.doc_hash_at_send, encode(digest(COALESCE(v_doc.rendered_body,''), 'sha256'), 'hex'));
  v_hash := encode(digest(v_doc_hash || '|' || v_sig.signer_email || '|' || p_signature_data || '|' || COALESCE(p_consent_version, ''), 'sha256'), 'hex');
  BEGIN v_ip := inet_client_addr(); EXCEPTION WHEN others THEN v_ip := NULL; END;

  UPDATE doc_signatures SET
    status = 'signed',
    signer_name = COALESCE(NULLIF(p_signer_name,''), signer_name),
    signature_data = p_signature_data, signing_method = p_signing_method,
    consent_text = p_consent_text, user_agent = p_user_agent, signer_ip = v_ip,
    integrity_hash = v_hash, signed_at = v_now,
    e_records_consented = COALESCE(p_e_records_consented, e_records_consented),
    e_records_consent_at = CASE WHEN p_e_records_consented IS TRUE THEN v_now ELSE e_records_consent_at END,
    e_records_consent_version = COALESCE(p_consent_version, e_records_consent_version),
    hardware_software_acknowledged = COALESCE(p_hw_sw_acknowledged, hardware_software_acknowledged)
  WHERE id = v_sig.id;

  SELECT count(*), count(*) FILTER (WHERE status IN ('sent','viewed'))
    INTO v_remaining, v_in_flight
    FROM doc_signatures WHERE doc_id = v_sig.doc_id AND status IN ('pending','sent','viewed');

  IF v_remaining = 0 THEN
    UPDATE doc_generated SET envelope_status = 'completed', envelope_completed_at = v_now WHERE id = v_sig.doc_id;
    v_all_signed := true;
  ELSE
    v_all_signed := false;
    SELECT COALESCE(v_doc.signing_mode, t.signing_mode, 'parallel') INTO v_signing_mode
      FROM (SELECT 1) x LEFT JOIN doc_templates t ON t.id = v_doc.template_id;
    -- Advance only when nobody at the current step is still outstanding.
    -- Two tenants share step 1; the landlord (step 2) must not be asked
    -- until both have signed.
    IF v_signing_mode = 'sequential' AND v_in_flight = 0 THEN
      SELECT MIN(ds.sign_order) INTO v_next_min_order FROM doc_signatures ds
        WHERE ds.doc_id = v_sig.doc_id AND ds.status = 'pending';
      IF v_next_min_order IS NOT NULL THEN
        UPDATE doc_signatures SET status = 'sent', sent_at = v_now
          WHERE doc_id = v_sig.doc_id AND status = 'pending' AND sign_order = v_next_min_order;
        GET DIAGNOSTICS v_next_count = ROW_COUNT;
        SELECT ds.id, ds.signer_email INTO v_next_id, v_next_email FROM doc_signatures ds
          WHERE ds.doc_id = v_sig.doc_id AND ds.status = 'sent' AND ds.sign_order = v_next_min_order
          ORDER BY ds.created_at LIMIT 1;
      END IF;
    END IF;
  END IF;

  PERFORM _sync_lease_signature_status(v_sig.doc_id);

  RETURN jsonb_build_object(
    'success', true, 'signed_at', v_now, 'integrity_hash', v_hash, 'doc_hash_at_send', v_doc_hash,
    'all_signed', v_all_signed, 'doc_id', v_sig.doc_id,
    'next_signer_id', v_next_id, 'next_signer_email', v_next_email, 'next_signers_count', v_next_count,
    'still_waiting', v_in_flight
  );
END; $$;

-- ── 8. set_signed_pdf: record the copy; the API sends the emails ─────
-- It used to queue a 'signed_doc_copy' row per signer for a worker that is
-- paused, has no schedule, and whose template carried no link. The API
-- that stores the PDF now emails it directly and logs each send.
CREATE OR REPLACE FUNCTION public.set_signed_pdf(p_doc_id uuid, p_pdf_path text, p_pdf_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_doc doc_generated%ROWTYPE;
BEGIN
  SELECT * INTO v_doc FROM doc_generated WHERE id = p_doc_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;
  IF v_doc.envelope_status <> 'completed' THEN RETURN jsonb_build_object('error','envelope not completed'); END IF;
  IF v_doc.signed_pdf_path IS NOT NULL THEN
    RETURN jsonb_build_object('already_set', true, 'signed_pdf_path', v_doc.signed_pdf_path, 'signed_pdf_hash', v_doc.signed_pdf_hash);
  END IF;
  UPDATE doc_generated SET signed_pdf_path = p_pdf_path, signed_pdf_hash = p_pdf_hash, signed_pdf_uploaded_at = now() WHERE id = p_doc_id;
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.set_signed_pdf(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_signed_pdf(uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
