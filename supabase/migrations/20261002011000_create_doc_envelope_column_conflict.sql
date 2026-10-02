-- create_doc_envelope returns a table whose columns are named like the
-- signature table's (status, sign_order, ...). Inside the function those
-- names were therefore ambiguous between the output columns and the
-- table's, and the first statement to touch doc_signatures.status raised
-- "column reference status is ambiguous". Found by a rolled-back probe on
-- the test database straight after 20261002010000. Prefer the column.
CREATE OR REPLACE FUNCTION public.create_doc_envelope(p_doc_id uuid, p_signers jsonb, p_signing_mode text DEFAULT NULL)
RETURNS TABLE(signer_id uuid, signer_email text, access_token text, sign_order integer, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
#variable_conflict use_column
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

NOTIFY pgrst, 'reload schema';
