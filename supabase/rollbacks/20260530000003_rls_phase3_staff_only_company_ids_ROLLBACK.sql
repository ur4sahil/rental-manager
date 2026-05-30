-- ROLLBACK for 20260530000003_rls_phase3_staff_only_company_ids.sql
-- Restores get_user_company_ids() to its original (all-member) behavior.
-- ⚠️ Reopens the within-company leak to portal tenants/owners. Recovery only.
CREATE OR REPLACE FUNCTION public.get_user_company_ids()
 RETURNS SETOF text
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT company_id FROM company_members
  WHERE LOWER(user_email) = LOWER(auth.jwt()->>'email')
  AND status = 'active';
END;
$function$;
