-- Rental applications, and a checklist of what a prospect has handed in
-- (Phase 1B of docs/PLAN-tenant-documents.md).
--
-- The lease refers to "the application" (Section XXII) and until now there
-- was none: a prospect had file uploads and a notes box. An application is
-- sent to an applicant as a private link, filled in and signed by THEM (no
-- account), and kept against the prospect.
--
-- Deliberately not collected: Social Security numbers, dates of birth, bank
-- details, criminal history. None is needed to keep a record of what the
-- applicant told us, and each would be a liability to hold.

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS checklist jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.prospect_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,
  applicant_name text NOT NULL,
  applicant_email text,
  access_token text NOT NULL UNIQUE,
  token_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'opened', 'submitted', 'withdrawn')),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  signed_name text,
  consent_text text,
  signer_ip inet,
  user_agent text,
  integrity_hash text,
  opened_at timestamptz,
  submitted_at timestamptz,
  request_emailed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prospect_applications_prospect ON public.prospect_applications (prospect_id, created_at DESC);

ALTER TABLE public.prospect_applications ENABLE ROW LEVEL SECURITY;
DO $pol$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'prospect_applications' AND policyname = 'prospect_applications_staff') THEN
    CREATE POLICY prospect_applications_staff ON public.prospect_applications
      FOR ALL TO authenticated
      USING (public.is_company_staff(company_id))
      WITH CHECK (public.is_company_staff(company_id));
  END IF;
END $pol$;
REVOKE ALL ON public.prospect_applications FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.prospect_applications TO authenticated;
GRANT ALL ON public.prospect_applications TO service_role;

-- Staff: make an application link for one person on a prospect.
CREATE OR REPLACE FUNCTION public.create_prospect_application(p_prospect_id uuid, p_name text, p_email text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_p prospects%ROWTYPE; v_row prospect_applications%ROWTYPE; v_who text := COALESCE(NULLIF(auth.email(), ''), 'system');
BEGIN
  SELECT * INTO v_p FROM prospects WHERE id = p_prospect_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That prospect no longer exists.' USING ERRCODE = 'P0002'; END IF;
  IF COALESCE(NULLIF(auth.role(), ''), 'postgres') NOT IN ('service_role', 'postgres')
     AND NOT public.is_company_staff(v_p.company_id) THEN
    RAISE EXCEPTION 'You do not have access to this company.' USING ERRCODE = '42501';
  END IF;
  IF btrim(COALESCE(p_name, '')) = '' THEN RAISE EXCEPTION 'The applicant needs a name.'; END IF;
  -- One live application per person: asking again withdraws the earlier link.
  UPDATE prospect_applications SET status = 'withdrawn'
   WHERE prospect_id = p_prospect_id AND lower(btrim(applicant_name)) = lower(btrim(p_name)) AND status IN ('sent', 'opened');
  INSERT INTO prospect_applications (company_id, prospect_id, applicant_name, applicant_email, access_token, created_by)
  VALUES (v_p.company_id, p_prospect_id, btrim(p_name), NULLIF(lower(btrim(COALESCE(p_email, ''))), ''), _gen_signing_token(), v_who)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'access_token', v_row.access_token, 'token_expires_at', v_row.token_expires_at);
END $$;
REVOKE ALL ON FUNCTION public.create_prospect_application(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_prospect_application(uuid, text, text) TO authenticated, service_role;

-- The applicant: what the link is for. Returns nothing that is not theirs.
CREATE OR REPLACE FUNCTION public.get_application_by_token(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_a prospect_applications%ROWTYPE; v_p prospects%ROWTYPE; v_company text;
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN RETURN jsonb_build_object('error', 'invalid link'); END IF;
  SELECT * INTO v_a FROM prospect_applications WHERE access_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not found'); END IF;
  IF v_a.status = 'withdrawn' THEN RETURN jsonb_build_object('error', 'withdrawn'); END IF;
  IF v_a.status = 'submitted' THEN RETURN jsonb_build_object('status', 'submitted', 'applicant_name', v_a.applicant_name, 'submitted_at', v_a.submitted_at); END IF;
  IF v_a.token_expires_at < now() THEN RETURN jsonb_build_object('error', 'expired'); END IF;
  SELECT * INTO v_p FROM prospects WHERE id = v_a.prospect_id;
  SELECT name INTO v_company FROM companies WHERE id::text = v_a.company_id;
  IF v_a.status = 'sent' THEN UPDATE prospect_applications SET status = 'opened', opened_at = now() WHERE id = v_a.id; END IF;
  RETURN jsonb_build_object('status', 'open', 'applicant_name', v_a.applicant_name, 'applicant_email', v_a.applicant_email,
    'company_name', COALESCE(v_company, ''), 'property', COALESCE(v_p.property, ''), 'rent', v_p.rent, 'lease_start', v_p.lease_start,
    'expires_at', v_a.token_expires_at);
END $$;
REVOKE ALL ON FUNCTION public.get_application_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_application_by_token(text) TO anon, authenticated, service_role;

-- The applicant: hand it in. Once. The answers are fingerprinted with the
-- name they signed with, so what was submitted can be shown not to have
-- changed since.
CREATE OR REPLACE FUNCTION public.submit_application(p_token text, p_answers jsonb, p_signed_name text, p_consent_text text, p_user_agent text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE v_a prospect_applications%ROWTYPE; v_ip inet; v_hash text; v_now timestamptz := now();
BEGIN
  IF p_token IS NULL OR length(p_token) < 20 THEN RETURN jsonb_build_object('error', 'invalid link'); END IF;
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' THEN RETURN jsonb_build_object('error', 'answers required'); END IF;
  IF length(p_answers::text) > 60000 THEN RETURN jsonb_build_object('error', 'the application is too long'); END IF;
  IF btrim(COALESCE(p_signed_name, '')) = '' THEN RETURN jsonb_build_object('error', 'signature required'); END IF;
  IF length(COALESCE(p_consent_text, '')) < 10 THEN RETURN jsonb_build_object('error', 'certification required'); END IF;
  SELECT * INTO v_a FROM prospect_applications WHERE access_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not found'); END IF;
  IF v_a.status NOT IN ('sent', 'opened') THEN RETURN jsonb_build_object('error', 'already submitted or withdrawn', 'status', v_a.status); END IF;
  IF v_a.token_expires_at < v_now THEN RETURN jsonb_build_object('error', 'expired'); END IF;
  BEGIN v_ip := inet_client_addr(); EXCEPTION WHEN others THEN v_ip := NULL; END;
  v_hash := encode(digest(p_answers::text || '|' || btrim(p_signed_name) || '|' || v_now::text, 'sha256'), 'hex');
  UPDATE prospect_applications SET status = 'submitted', answers = p_answers, signed_name = btrim(p_signed_name), consent_text = p_consent_text,
         signer_ip = v_ip, user_agent = left(COALESCE(p_user_agent, ''), 400), integrity_hash = v_hash, submitted_at = v_now
   WHERE id = v_a.id;
  -- Tick "application received" on the prospect, and tell staff on their page.
  UPDATE prospects
     SET checklist = COALESCE(checklist, '{}'::jsonb) || jsonb_build_object('application', jsonb_build_object('done', true, 'at', v_now, 'by', v_a.applicant_name)),
         updated_at = v_now
   WHERE id = v_a.prospect_id;
  RETURN jsonb_build_object('success', true, 'submitted_at', v_now);
END $$;
REVOKE ALL ON FUNCTION public.submit_application(text, jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_application(text, jsonb, text, text, text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
