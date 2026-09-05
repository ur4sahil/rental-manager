-- Close the privilege-escalation holes in company_members and the
-- over-broad FOR ALL grants that ride on top of it.
--
-- Root cause, and the reason these went unnoticed: PostgreSQL ORs
-- *permissive* policies. The correctly-written `members_manage` (self
-- may only insert a PENDING row; admins may insert anything) sat
-- alongside a legacy `cm_insert` whose only test was "is this row my
-- own email?" -- so the restrictive policy was decorative and the
-- permissive one decided every request. Same pairing for
-- members_update (admin-only) vs cm_update (self OR any member).
--
-- Verified consequence before this migration: any authenticated user
-- could POST {company_id: <ANY company>, user_email: <their own>,
-- role: 'admin', status: 'active'} into company_members and then read
-- that company's entire books, because every other table's RLS trusts
-- company_members. The request_join_company approval flow was bypassed
-- entirely.

-- ---------------------------------------------------------------
-- 1. company_members: one policy per command, no permissive overlap
-- ---------------------------------------------------------------
DROP POLICY IF EXISTS cm_insert   ON public.company_members;  -- self-insert at ANY role
DROP POLICY IF EXISTS cm_update   ON public.company_members;  -- self-escalate to admin
DROP POLICY IF EXISTS cm_delete   ON public.company_members;  -- any member evicts any other
DROP POLICY IF EXISTS cm_staff_all ON public.company_members; -- FOR ALL to every staff role

-- INSERT is left to `members_manage`, which already encodes the
-- intended contract (self+pending, founder bootstrap, or admin).

-- Members may touch their own row: auth_user_id backfill (App.js),
-- accepting or expiring an invite, and leaving a company. WHICH
-- columns may change is enforced by the trigger below -- RLS cannot
-- compare OLD to NEW, so a policy alone cannot express "your row, but
-- not your role".
CREATE POLICY members_self_update ON public.company_members
  FOR UPDATE
  USING      (lower(user_email) = lower(auth.jwt() ->> 'email'))
  WITH CHECK (lower(user_email) = lower(auth.jwt() ->> 'email'));

-- Hard delete is admin-only. The app itself never hard-deletes a
-- membership (it sets status='removed'), so this is a backstop.
CREATE POLICY members_delete ON public.company_members
  FOR DELETE USING (public.is_company_admin(company_id));

-- ---------------------------------------------------------------
-- 2. Column guard: a member may not rewrite their own privileges
-- ---------------------------------------------------------------
-- `current_user` is the discriminator. PostgREST executes a browser
-- request as the `authenticated` role; SECURITY DEFINER functions
-- (redeem_invite_code, request_join_company) and the service key run
-- as the owner or service_role. Guarding only `authenticated` lets the
-- server-side paths keep working -- redeem_invite_code legitimately
-- sets role='tenant', status='active' on someone else's behalf.
-- SECURITY INVOKER is load-bearing. Inside a SECURITY DEFINER function
-- `current_user` is the function's OWNER, not the caller -- so the
-- current_user test below would read 'postgres' on every call and wave
-- everything through. Verified: with SECURITY DEFINER an office
-- assistant still escalated itself to admin with this trigger installed.
-- As INVOKER, current_user is 'authenticated' for a browser request,
-- 'service_role' for the service key, and the owner inside SECURITY
-- DEFINER callers like redeem_invite_code -- exactly the split we want.
CREATE OR REPLACE FUNCTION public.guard_membership_privileges()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;
  IF public.is_company_admin(OLD.company_id) THEN RETURN NEW; END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR lower(NEW.user_email) IS DISTINCT FROM lower(OLD.user_email)
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.manager_email IS DISTINCT FROM OLD.manager_email THEN
    RAISE EXCEPTION 'Only a company admin can change membership privileges';
  END IF;

  -- Status: accept an invite, expire a stale one, or leave. Nothing else.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (OLD.status = 'invited' AND NEW.status IN ('active', 'expired'))
       OR NEW.status = 'removed'
     ) THEN
    RAISE EXCEPTION 'Only a company admin can change membership status (% -> %)',
      OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS guard_membership_privileges ON public.company_members;
CREATE TRIGGER guard_membership_privileges
  BEFORE UPDATE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_privileges();

-- ---------------------------------------------------------------
-- 3. Lockout guard: never strip a live company of its last admin
-- ---------------------------------------------------------------
-- Exempts archived companies, because archiving legitimately sets
-- every member to 'removed' in one sweep (CompanySelector.js).
CREATE OR REPLACE FUNCTION public.guard_last_admin()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_was_admin boolean; v_still_admin boolean; v_archived boolean;
BEGIN
  v_was_admin := (OLD.role = 'admin' AND OLD.status = 'active');
  IF NOT v_was_admin THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.status = 'active' THEN
    RETURN NEW;
  END IF;

  SELECT (archived_at IS NOT NULL) INTO v_archived
    FROM companies WHERE id = OLD.company_id;
  IF COALESCE(v_archived, false) THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT EXISTS (
    SELECT 1 FROM company_members
     WHERE company_id = OLD.company_id AND id <> OLD.id
       AND role = 'admin' AND status = 'active'
  ) INTO v_still_admin;

  IF NOT v_still_admin THEN
    RAISE EXCEPTION 'Cannot remove the last active admin of %', OLD.company_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS guard_last_admin ON public.company_members;
CREATE TRIGGER guard_last_admin
  BEFORE UPDATE OR DELETE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_last_admin();

-- ---------------------------------------------------------------
-- 4. Period lock was not a lock
-- ---------------------------------------------------------------
-- apl_company_access was FOR ALL to every active member -- tenants and
-- owners included. The UI hides the unlock button from an office
-- assistant and prints "Only admin/manager can unlock"; the DELETE went
-- through regardless, after which closed periods can be backdated.
CREATE OR REPLACE FUNCTION public.is_company_admin_or_manager(p_company_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM company_members
     WHERE company_id = p_company_id
       AND lower(user_email) = lower(auth.jwt() ->> 'email')
       AND status = 'active'
       AND role IN ('admin', 'manager')
  );
$function$;

DROP POLICY IF EXISTS apl_company_access ON public.accounting_period_lock;

CREATE POLICY apl_read ON public.accounting_period_lock
  FOR SELECT USING (public.is_member_of_company(company_id));

CREATE POLICY apl_write ON public.accounting_period_lock
  FOR ALL
  USING      (public.is_company_admin_or_manager(company_id))
  WITH CHECK (public.is_company_admin_or_manager(company_id));

-- ---------------------------------------------------------------
-- 5. Property delete was UI-only
-- ---------------------------------------------------------------
-- Properties.js checks admin/manager twice (client state, then a
-- server round-trip) and offers everyone else "Request Delete", which
-- files a property_change_request for approval. Both checks live in
-- React; properties_staff (FOR ALL, is_company_staff) let any
-- non-tenant/owner member -- including maintenance -- DELETE outright.
DROP POLICY IF EXISTS properties_staff ON public.properties;

CREATE POLICY properties_staff_write ON public.properties
  FOR INSERT WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY properties_staff_update ON public.properties
  FOR UPDATE
  USING      (public.is_company_staff(company_id))
  WITH CHECK (public.is_company_staff(company_id));

CREATE POLICY properties_delete ON public.properties
  FOR DELETE USING (public.is_company_admin_or_manager(company_id));

-- SELECT already covered by properties_select / _tenant / _owner.

-- ---------------------------------------------------------------
-- 6. Tenant documents: honour the visibility flag
-- ---------------------------------------------------------------
-- documents_tenant ignored `tenant_visible` entirely, so every document
-- merely TAGGED with a tenant's name was readable by that tenant --
-- including the ones staff had explicitly marked not-visible. Measured
-- on production at the time of this migration: 33 of 51 tenant-tagged
-- documents were exposed this way.
--
-- The name match is also weaker than the codebase's own stated rule
-- ("tenant_id over tenant.name"): 5 same-name tenant groups exist in
-- production today, and same-name tenants in one company can therefore
-- still see each other's documents. Closing that needs a documents.tenant_id
-- column and a backfill, which touches the write paths -- it is a
-- separate migration, deliberately not smuggled into this one.
DROP POLICY IF EXISTS documents_tenant ON public.documents;

CREATE POLICY documents_tenant ON public.documents
  FOR SELECT USING (
    COALESCE(tenant_visible, false) = true
    AND tenant IS NOT NULL
    AND btrim(tenant) <> ''
    AND lower(tenant) = lower(public.get_tenant_name(company_id))
  );

-- ---------------------------------------------------------------
-- 7. Company enumeration
-- ---------------------------------------------------------------
-- companies_search granted SELECT on every row of `companies` to any
-- authenticated user, company_code included -- defeating the
-- "prevents company enumeration" intent stated in CompanySelector.js.
--
-- It cannot simply be dropped: it is load-bearing. companies_member_access
-- uses get_user_company_ids(), which returns only ACTIVE, non-tenant,
-- non-owner memberships -- so without companies_search a tenant or owner
-- could not read their own company, and a pending/invited user could not
-- see the invite they were about to accept. Replace it with exactly that
-- scope instead of a blanket grant.
DROP POLICY IF EXISTS companies_search ON public.companies;

-- Must go through a SECURITY DEFINER function rather than an inline
-- subquery: members_manage (on company_members) subqueries `companies`,
-- so referencing company_members here makes the two policies mutually
-- recursive. Verified before this indirection was added -- every insert
-- into company_members failed with "infinite recursion detected in
-- policy for relation company_members". The function bypasses RLS on
-- company_members and breaks the cycle.
CREATE OR REPLACE FUNCTION public.get_my_company_ids_any_status()
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT company_id FROM company_members
   WHERE lower(user_email) = lower(auth.jwt() ->> 'email');
$function$;

GRANT EXECUTE ON FUNCTION public.get_my_company_ids_any_status() TO authenticated;

CREATE POLICY companies_my_memberships ON public.companies
  FOR SELECT USING (id IN (SELECT public.get_my_company_ids_any_status()));

-- Join-by-code still needs a lookup that does not require membership.
-- SECURITY DEFINER, and deliberately does NOT echo company_code back.
CREATE OR REPLACE FUNCTION public.find_company_by_code(p_code text)
RETURNS TABLE (id text, name text, type text, company_role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.name, c.type, c.company_role
    FROM companies c
   WHERE c.company_code = btrim(p_code)
     AND c.archived_at IS NULL
     AND auth.role() = 'authenticated'
   LIMIT 1;
$function$;

-- Uniqueness probe for company creation: boolean only, no row leak.
CREATE OR REPLACE FUNCTION public.company_code_exists(p_code text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM companies WHERE company_code = btrim(p_code));
$function$;

GRANT EXECUTE ON FUNCTION public.find_company_by_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_code_exists(text)  TO authenticated;

-- ---------------------------------------------------------------
-- 8. Keep the founder bootstrap working
-- ---------------------------------------------------------------
-- members_manage's founder branch subqueries `companies` inline. That
-- worked only because companies_search let any authenticated user read
-- every company; with companies now scoped to your own memberships the
-- subquery returns nothing for someone who has just created a company
-- and does not yet have a membership row -- a chicken-and-egg that
-- breaks CompanySelector's client-side fallback path. Verified: the
-- company INSERT succeeded and the membership INSERT was then refused.
--
-- Route the check through a SECURITY DEFINER function so it bypasses
-- RLS on `companies`. Deliberately NOT solved by giving creators a
-- SELECT policy on companies: 1 of the 9 production companies with a
-- creator has a creator who is no longer a member, and that would hand
-- them back read access they do not currently have.
CREATE OR REPLACE FUNCTION public.is_company_creator(p_company_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM companies
     WHERE id = p_company_id
       AND COALESCE(created_by, '') <> ''
       AND lower(created_by) = lower(auth.jwt() ->> 'email')
  );
$function$;

GRANT EXECUTE ON FUNCTION public.is_company_creator(text) TO authenticated;

DROP POLICY IF EXISTS members_manage ON public.company_members;

CREATE POLICY members_manage ON public.company_members
  FOR INSERT WITH CHECK (
    -- ask to join: pending only, admin approval still required
    ((lower(user_email) = lower(auth.jwt() ->> 'email')) AND status = 'pending')
    -- founder bootstrap: make yourself admin of a company you created
    OR ((lower(user_email) = lower(auth.jwt() ->> 'email'))
        AND role = 'admin' AND invited_by = 'self'
        AND public.is_company_creator(company_id))
    -- an admin may add anyone to their own company
    OR public.is_company_admin(company_id)
  );
