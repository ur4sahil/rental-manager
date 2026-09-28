-- Close anonymous / cross-company access to SECURITY DEFINER functions.
--
-- Verified 2026-09-28 from outside with only the public anon key and no login:
--   * TEST: POST /rest/v1/rpc/post_je_and_ledger posted a real 2-line journal
--     entry (JE-7723) into another company's books.
--   * PROD: the same call aimed at Sigma Housing LLC with a deliberately invalid
--     date returned "invalid input syntax for type date" (22007) -- the function
--     RAN for an anonymous caller; only the bad date stopped it.
-- These functions are SECURITY DEFINER, so they bypass RLS entirely, and none
-- of them checked who was calling or which company they belong to. Postgres
-- grants EXECUTE to PUBLIC by default, so "anon" could call every one.
--
-- 1. No anonymous access to any of them.
-- 2. The ones the app never calls from a browser are server-only.
--    recompute_tenant_balance stays callable by authenticated: the
--    INVOKER triggers on acct_journal_lines / acct_journal_entries call it as
--    the logged-in user, and revoking it would break every journal post. It
--    only recomputes a balance from the GL, so it cannot change the books.
-- 3. The ones the browser does call now refuse unless the caller is active
--    staff of the company named (is_company_staff). Requests with no JWT
--    (pg_cron, migrations, direct postgres) and the service key are allowed,
--    so server jobs are unaffected.

-- ── guard helper ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._assert_company_staff(p_company_id text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims text := current_setting('request.jwt.claims', true);
BEGIN
  -- No request context (pg_cron, migrations, psql) or the server key: trusted.
  IF v_claims IS NULL OR v_claims = '' OR (v_claims::jsonb ->> 'role') = 'service_role' THEN
    RETURN;
  END IF;
  IF p_company_id IS NULL OR NOT public.is_company_staff(p_company_id) THEN
    RAISE EXCEPTION 'Not authorized for this company' USING ERRCODE = '42501';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public._assert_company_staff(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._assert_company_staff(text) TO authenticated, service_role;

-- ── 1 + 2: privileges ───────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN (
         'post_je_and_ledger','delete_property_cascade','_cascade_property_rename',
         'apply_late_fee_atomic','archive_property','move_out_commit_state',
         'restore_archived','purge_old_archives','recompute_tenant_balance',
         'rename_property_v2','create_company_atomic','increment_vendor_totals',
         'accept_pm_assignment','derive_property_occupancy','set_signed_pdf')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    IF r.proname IN ('delete_property_cascade','_cascade_property_rename',
                     'apply_late_fee_atomic','restore_archived','purge_old_archives',
                     'derive_property_occupancy','set_signed_pdf') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', r.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
  END LOOP;
END $$;

-- ── 3: company check inside the browser-called functions ─────────────────
-- Inserted as the first statement of each body. Done by rewriting the live
-- definition so the rest of each function is untouched, and idempotent (a
-- body that already calls the guard is skipped).
DO $$
DECLARE
  r record; v_def text; v_new text; v_guard text;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (   p.proname IN ('post_je_and_ledger','move_out_commit_state')
            OR (p.proname = 'archive_property'        AND pg_get_function_identity_arguments(p.oid) LIKE 'p_company_id text, p_property_id text%')
            OR (p.proname = 'rename_property_v2'      AND pg_get_function_identity_arguments(p.oid) LIKE '%p_property_id text%')
            OR (p.proname = 'increment_vendor_totals' AND pg_get_function_identity_arguments(p.oid) LIKE 'p_company_id text%')
            OR (p.proname = 'accept_pm_assignment'    AND pg_get_function_identity_arguments(p.oid) LIKE '%p_reviewer_email%')
            OR  p.proname = 'create_company_atomic')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    CONTINUE WHEN v_def LIKE '%_assert_company_staff%' OR v_def LIKE '%create_company_atomic: creator must be caller%';
    IF r.proname = 'accept_pm_assignment' THEN
      v_guard := '  PERFORM public._assert_company_staff(p_pm_company_id);';
    ELSIF r.proname = 'create_company_atomic' THEN
      -- A new company has no staff yet; instead the admin being created must
      -- be the signed-in person, so nobody can mint companies for others.
      v_guard := '  -- create_company_atomic: creator must be caller' || chr(10) ||
                 '  IF COALESCE(current_setting(''request.jwt.claims'', true), '''') <> '''' ' ||
                 'AND (current_setting(''request.jwt.claims'', true)::jsonb ->> ''role'') IS DISTINCT FROM ''service_role'' ' ||
                 'AND lower(COALESCE(p_creator_email, '''')) IS DISTINCT FROM lower(COALESCE(auth.email(), '''')) THEN' || chr(10) ||
                 '    RAISE EXCEPTION ''Not authorized to create a company for another user'' USING ERRCODE = ''42501'';' || chr(10) ||
                 '  END IF;';
    ELSE
      v_guard := '  PERFORM public._assert_company_staff(p_company_id);';
    END IF;
    -- First top-level BEGIN line of the body (after any DECLARE section).
    v_new := regexp_replace(v_def, E'\\nBEGIN\\n', E'\nBEGIN\n' || v_guard || E'\n');
    IF v_new = v_def THEN
      RAISE EXCEPTION 'lock_down: could not find BEGIN in %(%)', r.proname, r.args;
    END IF;
    EXECUTE v_new;
  END LOOP;
END $$;
