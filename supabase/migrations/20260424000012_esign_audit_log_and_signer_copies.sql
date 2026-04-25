-- Two follow-on hardenings to the e-sign hardening from
-- 20260424000011: an append-only audit log on doc_signatures, and
-- a notification_queue fan-out so each signer gets a copy of the
-- final signed PDF.
--
-- (#2) Append-only audit log
--   doc_signatures rows are mutable by company staff — RLS lets
--   any admin/owner UPDATE them. A compromised admin or rogue
--   employee could backdate signed_at, swap signature_data, or
--   change integrity_hash without leaving a trail. Trial counsel
--   knows to ask for it. Fix: doc_signature_audit_log table that
--   captures every INSERT/UPDATE/DELETE via a SECURITY DEFINER
--   trigger; the table itself is INSERT-only via the trigger
--   function (no direct DML granted to anyone, including admin),
--   and SELECT is read-only for company staff. Field-level
--   changes go into a JSONB delta so the log is queryable.
--
-- (#4) Signer copies
--   When /api/finalize-signed-pdf calls set_signed_pdf, this
--   migration also queues a notification_queue row per signer
--   with type='signed_doc_copy' and the signed PDF's storage path.
--   The post-sign UI already promises "you'll receive a copy" —
--   queueing the rows now lets the (separate) email-delivery
--   worker pick them up when wired. Until then, staff can scan
--   the queue manually to honor the promise.

-- ─── Audit log table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doc_signature_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signature_id    uuid NOT NULL REFERENCES doc_signatures(id) ON DELETE NO ACTION,
  doc_id          uuid NOT NULL,
  company_id      text NOT NULL,
  op              text NOT NULL CHECK (op IN ('insert','update','delete')),
  old_status      text,
  new_status      text,
  field_deltas    jsonb,
  actor_email     text,
  actor_role      text,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doc_sig_audit_signature
  ON doc_signature_audit_log (signature_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_sig_audit_doc
  ON doc_signature_audit_log (doc_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_sig_audit_company
  ON doc_signature_audit_log (company_id, changed_at DESC);

ALTER TABLE doc_signature_audit_log ENABLE ROW LEVEL SECURITY;

-- Read-only for staff. Writes are gated below: we revoke direct
-- INSERT/UPDATE/DELETE from authenticated and rely on the trigger
-- (which runs SECURITY DEFINER) to populate rows.
DROP POLICY IF EXISTS doc_sig_audit_select ON doc_signature_audit_log;
CREATE POLICY doc_sig_audit_select ON doc_signature_audit_log FOR SELECT TO authenticated
USING (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
));

REVOKE INSERT, UPDATE, DELETE ON doc_signature_audit_log FROM authenticated, anon, public;

-- ─── Trigger function: capture deltas on doc_signatures DML ─
CREATE OR REPLACE FUNCTION _doc_signatures_audit_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor text;
  v_role text;
  v_deltas jsonb := '{}'::jsonb;
  -- Field set we care about — everything else (UI-only metadata)
  -- is excluded from the delta to keep the log compact.
  v_tracked text[] := ARRAY[
    'status','signer_name','signer_email','signature_data','signing_method',
    'consent_text','signer_ip','user_agent','integrity_hash',
    'signed_at','viewed_at','sent_at','declined_at','declined_reason',
    'access_token','token_expires_at',
    'e_records_consented','e_records_consent_at','e_records_consent_version',
    'hardware_software_acknowledged','paper_copy_requested_at',
    'consent_withdrawn_at','consent_withdrawn_reason'
  ];
  k text;
  v_old_val text;
  v_new_val text;
BEGIN
  -- Best-effort actor identity. JWT email is set when the call
  -- comes through PostgREST as a logged-in staff user; for
  -- public-RPC paths (sign_document, request_paper_copy) the JWT
  -- is the anon role with no email, so we tag those as 'public'.
  BEGIN v_actor := COALESCE(NULLIF(auth.jwt() ->> 'email',''), 'public'); EXCEPTION WHEN others THEN v_actor := 'system'; END;
  BEGIN v_role  := NULLIF(auth.jwt() ->> 'role','');                        EXCEPTION WHEN others THEN v_role := NULL; END;

  IF (TG_OP = 'INSERT') THEN
    INSERT INTO doc_signature_audit_log (
      signature_id, doc_id, company_id, op,
      old_status, new_status, field_deltas, actor_email, actor_role
    ) VALUES (
      NEW.id, NEW.doc_id, NEW.company_id, 'insert',
      NULL, NEW.status,
      to_jsonb(NEW) - 'access_token' - 'signature_data',  -- redact secrets at rest in the log
      v_actor, v_role
    );
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    -- Build a column-by-column delta of tracked fields.
    FOREACH k IN ARRAY v_tracked LOOP
      v_old_val := (to_jsonb(OLD) ->> k);
      v_new_val := (to_jsonb(NEW) ->> k);
      IF v_old_val IS DISTINCT FROM v_new_val THEN
        -- Redact long/secret fields in the delta — keep just the
        -- hash prefix so the auditor knows it changed without
        -- copying the full signature image / token into the log.
        IF k IN ('signature_data','access_token') THEN
          v_deltas := v_deltas || jsonb_build_object(k, jsonb_build_object(
            'old_prefix', LEFT(COALESCE(v_old_val,''), 16),
            'new_prefix', LEFT(COALESCE(v_new_val,''), 16),
            'len_changed', length(COALESCE(v_old_val,'')) <> length(COALESCE(v_new_val,''))
          ));
        ELSE
          v_deltas := v_deltas || jsonb_build_object(k, jsonb_build_object('old', v_old_val, 'new', v_new_val));
        END IF;
      END IF;
    END LOOP;
    -- Skip entirely if nothing tracked changed (e.g. a transient
    -- viewed_at-only update fired by a re-fetch race).
    IF v_deltas <> '{}'::jsonb THEN
      INSERT INTO doc_signature_audit_log (
        signature_id, doc_id, company_id, op,
        old_status, new_status, field_deltas, actor_email, actor_role
      ) VALUES (
        NEW.id, NEW.doc_id, NEW.company_id, 'update',
        OLD.status, NEW.status, v_deltas, v_actor, v_role
      );
    END IF;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    INSERT INTO doc_signature_audit_log (
      signature_id, doc_id, company_id, op,
      old_status, new_status, field_deltas, actor_email, actor_role
    ) VALUES (
      OLD.id, OLD.doc_id, OLD.company_id, 'delete',
      OLD.status, NULL,
      to_jsonb(OLD) - 'access_token' - 'signature_data',
      v_actor, v_role
    );
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS doc_signatures_audit ON doc_signatures;
CREATE TRIGGER doc_signatures_audit
  AFTER INSERT OR UPDATE OR DELETE ON doc_signatures
  FOR EACH ROW EXECUTE FUNCTION _doc_signatures_audit_trg();

-- ─── (#4) set_signed_pdf — fan out signer copies to queue ──
-- Replaces the version from migration 11 with one that also
-- inserts notification_queue rows for every signer once the PDF
-- is stored. Idempotent: re-runs are a no-op because the path-
-- already-set check still gates the body.
CREATE OR REPLACE FUNCTION set_signed_pdf(
  p_doc_id uuid,
  p_pdf_path text,
  p_pdf_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_doc doc_generated%ROWTYPE;
  v_sig record;
  v_queued int := 0;
BEGIN
  SELECT * INTO v_doc FROM doc_generated WHERE id = p_doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;
  IF v_doc.envelope_status <> 'completed' THEN
    RETURN jsonb_build_object('error','envelope not completed');
  END IF;
  IF v_doc.signed_pdf_path IS NOT NULL THEN
    RETURN jsonb_build_object('already_set', true,
      'signed_pdf_path', v_doc.signed_pdf_path,
      'signed_pdf_hash', v_doc.signed_pdf_hash);
  END IF;

  UPDATE doc_generated
    SET signed_pdf_path = p_pdf_path,
        signed_pdf_hash = p_pdf_hash,
        signed_pdf_uploaded_at = now()
    WHERE id = p_doc_id;

  -- Fan out: one notification_queue row per signer. The delivery
  -- worker picks these up by type='signed_doc_copy' and signs a
  -- short-lived URL against signed_pdf_path at send time, so the
  -- URL never goes stale waiting in the queue.
  FOR v_sig IN
    SELECT id, signer_email, signer_name FROM doc_signatures
    WHERE doc_id = p_doc_id
      AND status IN ('signed','viewed','sent','pending')
      AND signer_email IS NOT NULL
  LOOP
    INSERT INTO notification_queue (company_id, type, recipient_email, data, status)
    VALUES (
      v_doc.company_id, 'signed_doc_copy', lower(v_sig.signer_email),
      jsonb_build_object(
        'doc_id', p_doc_id,
        'doc_name', v_doc.name,
        'signed_pdf_path', p_pdf_path,
        'signed_pdf_hash', p_pdf_hash,
        'signer_name', v_sig.signer_name
      )::text,
      'pending'
    );
    v_queued := v_queued + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'signers_queued', v_queued);
END $$;

-- service-role only — no GRANT to anon/authenticated.

-- ─── get_signed_pdf_url — short-lived signed URL for a signer ─
-- Used by the post-sign UI ("Download your signed copy") and by
-- the email worker. Anyone with a valid signing token (still
-- within its expiry) can fetch a short-lived URL for the doc
-- they signed. We rely on the existing token semantics for auth
-- — callers without a token can't reach this RPC at all because
-- the token is part of the signature row scope.
--
-- The actual URL signing happens server-side because PostgREST
-- can't issue Supabase Storage signed URLs. So this RPC just
-- returns the path + the token-scoped doc_id; the API route
-- /api/finalize-signed-pdf (and a future /api/get-signer-copy)
-- mints the signed URL with the service-role key.
CREATE OR REPLACE FUNCTION resolve_signed_pdf_path(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sig doc_signatures%ROWTYPE;
  v_doc doc_generated%ROWTYPE;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN
    RETURN jsonb_build_object('error','invalid token');
  END IF;
  SELECT * INTO v_sig FROM doc_signatures WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','token not found'); END IF;
  IF v_sig.token_expires_at < now() THEN
    RETURN jsonb_build_object('error','token expired');
  END IF;
  SELECT * INTO v_doc FROM doc_generated WHERE id = v_sig.doc_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','doc not found'); END IF;
  IF v_doc.signed_pdf_path IS NULL THEN
    RETURN jsonb_build_object('error','signed pdf not yet stored',
      'envelope_status', v_doc.envelope_status);
  END IF;
  RETURN jsonb_build_object(
    'doc_id', v_doc.id,
    'doc_name', v_doc.name,
    'signed_pdf_path', v_doc.signed_pdf_path,
    'signed_pdf_hash', v_doc.signed_pdf_hash
  );
END $$;
REVOKE ALL ON FUNCTION resolve_signed_pdf_path(text) FROM public;
GRANT EXECUTE ON FUNCTION resolve_signed_pdf_path(text) TO anon, authenticated;
