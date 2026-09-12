-- Introspection helper for the RPC smoke test (tests/rpc-smoke.test.js).
--
-- It has to live in the database: catching a function's SQLSTATE requires
-- a PL/pgSQL exception block, which a client cannot do over PostgREST.
--
-- Why it exists: batch_post_rent_charges had never worked. It raised
-- 42883 on its FIRST statement, so no rent was ever posted by it, and
-- nothing caught it because every other audit in this repo tests
-- JavaScript or the browser. There are 209 database functions and 41
-- triggers, and none of them was ever executed by a test.
--
-- Four safety rules, three of them learned by getting it wrong:
--
--  1. NEVER call a function whose NAME suggests it destroys data. The
--     first trial sweep called hard_delete_company('sandbox-llc') and
--     survived only because that function refused to remove the last
--     admin. We cannot know a function is safe before calling it, so the
--     filter is on the name.
--  2. search_path must include `extensions`. Supabase installs pgcrypto
--     there, and _gen_signing_token has no search_path of its own, so
--     under a bare `public, pg_catalog` it could not see gen_random_bytes
--     and was reported BROKEN when it works perfectly.
--  3. Overloaded names are SKIPPED, not failed. request_join_company has
--     two signatures, so one text argument matches both (42725). Counting
--     overloads must look at every signature of the name, not only the
--     ones this filter selected.
--  4. proname is of type `name`, and an out column called `sqlstate`
--     shadows the PL/pgSQL built-in inside the handler. Both cost a
--     round trip.
--
-- Note the sweep genuinely EXECUTES what it calls, so functions that work
-- will post charges and move balances. The test runs only against the
-- test project and the caller restores the fixture afterwards.
CREATE OR REPLACE FUNCTION public.exec_rpc_smoke(p_company_id text)
RETURNS TABLE (fn text, args text, err_state text, msg text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_catalog
AS $function$
DECLARE r record; st text; m text;
BEGIN
  -- Service role only: this calls arbitrary functions. It is a harness,
  -- not something a signed-in user should be able to trigger.
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'exec_rpc_smoke is callable only with the service role';
  END IF;
  FOR r IN
    SELECT p.proname::text AS name, pg_get_function_arguments(p.oid) AS a,
           (SELECT count(*) FROM pg_proc p2 JOIN pg_namespace n2 ON n2.oid=p2.pronamespace
             WHERE n2.nspname='public' AND p2.proname = p.proname) AS overloads
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND pg_get_function_result(p.oid) <> 'trigger'
      AND (pg_get_function_arguments(p.oid) = ''
           OR pg_get_function_arguments(p.oid) ~ '^p_company_id text$')
      AND p.proname !~* '(^|_)(hard_)?delete|purge|drop|truncate|wipe|remove_|cascade|reset_'
      AND p.proname <> 'exec_rpc_smoke'
    ORDER BY p.proname
  LOOP
    IF r.overloads > 1 THEN
      RETURN QUERY SELECT r.name, r.a::text, 'SKIP'::text,
        format('overloaded (%s signatures) — cannot be called unambiguously by name', r.overloads);
      CONTINUE;
    END IF;
    BEGIN
      IF r.a = '' THEN EXECUTE format('SELECT public.%I()', r.name);
      ELSE EXECUTE format('SELECT public.%I(%L::text)', r.name, p_company_id); END IF;
      st := '00000'; m := 'ran';
    EXCEPTION WHEN OTHERS THEN st := SQLSTATE; m := left(SQLERRM, 160);
    END;
    RETURN QUERY SELECT r.name, r.a::text, st, m;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.exec_rpc_smoke(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exec_rpc_smoke(text) TO service_role;

COMMENT ON FUNCTION public.exec_rpc_smoke(text) IS
  'Test harness. Calls every safely-callable public function and reports each SQLSTATE, so a function that no longer matches the schema becomes visible. Excludes destructive names and overloaded names. Service role only.';
