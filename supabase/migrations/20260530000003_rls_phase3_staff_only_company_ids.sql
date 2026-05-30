-- ============================================================================
-- RLS hardening — Phase 3: get_user_company_ids() = STAFF companies only
-- ============================================================================
-- Phase-2 validation found a pre-existing within-company leak: portal tenants
-- and owners are active company_members, so get_user_company_ids() returned
-- their company, and the 37 `X_read` policies using
-- `company_id IN (SELECT get_user_company_ids())` exposed the WHOLE company's
-- data (tenants, payments, messages, work_orders, ...) to any tenant/owner via
-- the REST API. (Verified: a portal tenant could read 17 tenants' rows.)
--
-- Fix: exclude role IN ('tenant','owner') from get_user_company_ids(), mirroring
-- is_company_staff(). Every X_read policy then becomes staff-only automatically.
-- Portals are unaffected — their _self/_tenant/_owner policies use
-- is_company_member() / get_tenant_name() / get_owner_id(), none of which call
-- get_user_company_ids(). Also pins search_path (SECURITY DEFINER best practice;
-- clears one function_search_path_mutable advisory).
-- Rollback: supabase/rollbacks/20260530000003_..._ROLLBACK.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_user_company_ids()
 RETURNS SETOF text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT company_id FROM company_members
  WHERE LOWER(user_email) = LOWER(auth.jwt()->>'email')
    AND status = 'active'
    AND role NOT IN ('tenant', 'owner');
END;
$function$;
