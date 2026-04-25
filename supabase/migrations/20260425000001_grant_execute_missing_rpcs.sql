-- Grant EXECUTE on the four critical RPCs so the browser-side anon /
-- authenticated roles can call them. Without these grants, PostgREST
-- returns 404 ("function not found") even though the function exists
-- in the public schema — it just isn't reachable for the caller's
-- role.
--
-- Discovered via the click-coverage walkthrough on 2026-04-25:
-- src/utils/company.js's startup health check was firing four
-- spurious 404s per session for archive_property /
-- update_tenant_balance / create_company_atomic / sign_lease, all of
-- which traced back to missing role grants (and one truly missing
-- function — sign_lease). Each 404 also hit Sentry, contributing to
-- the inflated event count.
--
-- This migration:
-- 1. (Re)creates sign_lease — the one truly missing function. The
--    20260350 migration that originally defined it never made it to
--    prod (or was dropped); supabase-js + service role both got
--    PGRST202.
-- 2. Grants EXECUTE on all four to authenticated + anon so PostgREST
--    surfaces them.
--
-- The four functions are SECURITY DEFINER and already validate the
-- caller's permissions internally (see e.g. archive_property's
-- company_members membership check), so granting anon + authenticated
-- doesn't widen the actual authorization surface — it just lets the
-- HTTP request reach the function in the first place.

-- 1. (Re)create sign_lease so it exists on this schema
CREATE OR REPLACE FUNCTION sign_lease(p_signature_id uuid, p_signer_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE lease_signatures
     SET status = 'signed',
         signed_at = now(),
         signer_name = p_signer_name
   WHERE id = p_signature_id;
END;
$$;

-- 2. Grants — bind to the exact arg-list signatures used by the app
-- Each grant in its own DO-block so the migration runner doesn't try
-- to batch them into a prepared statement (SQLSTATE 42601 otherwise).
DO $$ BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION update_tenant_balance(bigint, numeric) TO authenticated, anon';
END $$;

DO $$ BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION archive_property(text, text, text, boolean, text) TO authenticated, anon';
END $$;

DO $$ BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION create_company_atomic(text, text, text, text, text, text, text, text, text, text) TO authenticated, anon';
END $$;

DO $$ BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION sign_lease(uuid, text) TO authenticated, anon';
END $$;
