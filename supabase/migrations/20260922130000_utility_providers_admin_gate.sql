-- Approving a provider (pending -> approved), or inserting one already approved,
-- must be an admin/owner action -- UI-gating alone is not a control (this app
-- has a documented history of permissive RLS under a gated UI). SECURITY
-- DEFINER helpers read company_members without triggering its RLS (no recursion).
CREATE OR REPLACE FUNCTION public.caller_staff_company_ids()
 RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  SELECT company_id FROM company_members
   WHERE (auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email()))
     AND status = 'active' AND role <> 'tenant'
$$;
CREATE OR REPLACE FUNCTION public.caller_admin_company_ids()
 RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
  SELECT company_id FROM company_members
   WHERE (auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email()))
     AND status = 'active' AND role IN ('admin','owner')
$$;

DROP POLICY IF EXISTS providers_insert ON public.utility_providers;
DROP POLICY IF EXISTS providers_update_pending ON public.utility_providers;

CREATE POLICY providers_insert ON public.utility_providers FOR INSERT TO authenticated
WITH CHECK (
  (approval_status = 'pending'
     AND requested_company_id IS NOT NULL
     AND requested_company_id IN (SELECT public.caller_staff_company_ids()))
  OR
  (approval_status = 'approved'
     AND EXISTS (SELECT 1 FROM public.caller_admin_company_ids()))
);

CREATE POLICY providers_admin_review ON public.utility_providers FOR UPDATE TO authenticated
USING (approval_status = 'pending'
       AND requested_company_id IN (SELECT public.caller_admin_company_ids()))
WITH CHECK (requested_company_id IN (SELECT public.caller_admin_company_ids()));
