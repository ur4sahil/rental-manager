-- Schema and policy half of the functional-testing fixes. Each item was
-- reproduced against the test database before being written.

-- ---------------------------------------------------------------
-- 1. Who is the caller, as a tenant id
-- ---------------------------------------------------------------
-- get_tenant_name() already exists and is what the tenant policies key
-- on. Name matching is not safe: 5 same-name tenant groups exist in
-- production today, so two tenants sharing a name in one company can
-- read each other's rows. This is the id-based counterpart.
CREATE OR REPLACE FUNCTION public.get_tenant_id(p_company_id text)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.id FROM tenants t
    JOIN company_members cm
      ON cm.company_id = t.company_id AND lower(cm.user_email) = lower(t.email)
   WHERE cm.company_id = p_company_id
     AND (cm.auth_user_id = auth.uid() OR lower(cm.user_email) = lower(auth.email()))
     AND cm.status = 'active' AND cm.role = 'tenant'
     AND t.archived_at IS NULL
   LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_tenant_id(text) TO authenticated;

-- ---------------------------------------------------------------
-- 2. documents.tenant_id -- close the same-name document leak
-- ---------------------------------------------------------------
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS tenant_id bigint;

-- Backfill only where the name resolves to EXACTLY ONE active tenant in
-- that company. Ambiguous rows stay null and therefore become invisible
-- to tenants -- fail closed, since an ambiguous row is precisely the
-- case that could be shown to the wrong person.
UPDATE public.documents d
   SET tenant_id = t.id
  FROM tenants t
 WHERE d.tenant_id IS NULL
   AND coalesce(btrim(d.tenant),'') <> ''
   AND t.company_id = d.company_id
   AND lower(t.name) = lower(btrim(d.tenant))
   AND t.archived_at IS NULL
   AND (SELECT count(*) FROM tenants t2
         WHERE t2.company_id = d.company_id
           AND lower(t2.name) = lower(btrim(d.tenant))
           AND t2.archived_at IS NULL) = 1;

CREATE INDEX IF NOT EXISTS idx_documents_tenant_id
  ON public.documents (company_id, tenant_id) WHERE tenant_id IS NOT NULL;

-- Keyed on tenant_id, and honouring tenant_visible. The previous policy
-- did neither: it matched on name and ignored the visibility flag
-- entirely, exposing 33 of 51 tenant-tagged documents that staff had
-- explicitly marked not-visible.
DROP POLICY IF EXISTS documents_tenant ON public.documents;
CREATE POLICY documents_tenant ON public.documents
  FOR SELECT USING (
    COALESCE(tenant_visible, false) = true
    AND tenant_id IS NOT NULL
    AND tenant_id = public.get_tenant_id(company_id)
  );

DROP POLICY IF EXISTS documents_tenant_insert ON public.documents;
CREATE POLICY documents_tenant_insert ON public.documents
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id(company_id));

-- ---------------------------------------------------------------
-- 3. payments.tenant_id -- the column the tenant portal already queries
-- ---------------------------------------------------------------
-- TenantPortal.js filters payments by tenant_id. The column did not
-- exist, so PostgREST returned 400 on every portal load and the
-- Payments tab was permanently empty -- silently, because the error
-- lands in `p.error` and the code reads `p.data || []`.
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS tenant_id bigint;

-- Matched against ACTIVE tenants only. Including archived rows made
-- almost every name ambiguous -- a name typically matches one active
-- tenant plus several archived historical ones -- and coverage came out
-- at 37 of 91. Restricting to active tenants raises it to 88 of 91; the
-- remaining 3 match no tenant at all and are therefore already
-- invisible to every tenant today, so nothing is lost by them staying
-- null. Property equality was dropped: it excluded nothing that the
-- uniqueness test did not already catch, and it wrongly excluded
-- payments made before a tenant moved.
UPDATE public.payments p
   SET tenant_id = t.id
  FROM tenants t
 WHERE p.tenant_id IS NULL
   AND coalesce(btrim(p.tenant),'') <> ''
   AND t.company_id = p.company_id
   AND lower(t.name) = lower(btrim(p.tenant))
   AND t.archived_at IS NULL
   AND (SELECT count(*) FROM tenants t2
         WHERE t2.company_id = p.company_id
           AND lower(t2.name) = lower(btrim(p.tenant))
           AND t2.archived_at IS NULL) = 1;

CREATE INDEX IF NOT EXISTS idx_payments_tenant_id
  ON public.payments (company_id, tenant_id) WHERE tenant_id IS NOT NULL;

-- ---------------------------------------------------------------
-- 4. Columns the property-delete cascade writes but did not exist
-- ---------------------------------------------------------------
-- deleteProperty() applies {archived_at, archived_by} to every child
-- table. utilities had no archived_by and inspections had NEITHER
-- column, so both updates failed with 400 and the rows stayed live --
-- while the confirmation dialog promises "Work orders, utilities,
-- documents, inspections" are removed from active views.
ALTER TABLE public.utilities   ADD COLUMN IF NOT EXISTS archived_by text;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.inspections ADD COLUMN IF NOT EXISTS archived_by text;

CREATE INDEX IF NOT EXISTS idx_inspections_active
  ON public.inspections (company_id) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------
-- 5. tenants.updated_at -- the concurrent-edit guard was dead
-- ---------------------------------------------------------------
-- Tenants.js re-reads tenants.updated_at before saving to detect that
-- someone else changed the row first. The column did not exist, so the
-- select errored, freshTenant came back null, and the guard never fired
-- once: concurrent edits silently last-write-wins.
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS updated_at timestamptz;
-- tenants has no created_at column; seed the backfill with now().
UPDATE public.tenants SET updated_at = now() WHERE updated_at IS NULL;
ALTER TABLE public.tenants ALTER COLUMN updated_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tenants_touch_updated_at ON public.tenants;
CREATE TRIGGER tenants_touch_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------
-- 6. The tenant Ledger tab was empty for every tenant
-- ---------------------------------------------------------------
-- The portal builds its ledger from acct_accounts (to find the tenant's
-- AR sub-account) and then acct_journal_lines for that account. Neither
-- table had a tenant-facing SELECT policy, so acct_accounts returned
-- zero rows, arAcct was undefined, and the entire block was skipped.
--
-- Scoped to the tenant's OWN AR sub-account. Deliberately does not
-- expose the shared 1100 Accounts Receivable account: the client falls
-- back to it when no per-tenant sub-account exists, and its lines carry
-- every tenant's activity.
DROP POLICY IF EXISTS acct_accounts_tenant ON public.acct_accounts;
CREATE POLICY acct_accounts_tenant ON public.acct_accounts
  FOR SELECT USING (
    tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id)
  );

-- Posted lines only, and only on that same sub-account. A draft or
-- voided entry is not something a tenant should see as owed.
DROP POLICY IF EXISTS acct_jl_tenant ON public.acct_journal_lines;
CREATE POLICY acct_jl_tenant ON public.acct_journal_lines
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM acct_accounts a
       WHERE a.id = acct_journal_lines.account_id
         AND a.tenant_id IS NOT NULL
         AND a.tenant_id = public.get_tenant_id(acct_journal_lines.company_id)
    )
    AND EXISTS (
      SELECT 1 FROM acct_journal_entries je
       WHERE je.id = acct_journal_lines.journal_entry_id
         AND je.status = 'posted'
    )
  );

-- ---------------------------------------------------------------
-- 7. Managers could not do the one thing the role exists for
-- ---------------------------------------------------------------
-- has_write_access() listed admin, office_assistant, accountant and
-- maintenance -- but not manager, which was added to ROLES later. On
-- most tables this was masked by a parallel is_company_staff policy
-- (permissive policies are OR'd), so it went unnoticed. On the five
-- tables where has_write_access is the ONLY write gate it bites:
--
--   property_change_requests  <- managers are supposed to APPROVE these
--   bank_reconciliations      <- UI shows managers "Re-open", RLS 42501
--   company_settings
--   lease_signatures
--   utility_audit
--
-- Properties.js literally comments "Admin/manager: approve change
-- request" over an update that RLS refused.
CREATE OR REPLACE FUNCTION public.has_write_access(p_company_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN EXISTS(
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND LOWER(user_email) = LOWER(auth.jwt()->>'email')
    AND status = 'active'
    AND role IN ('admin', 'manager', 'office_assistant', 'accountant', 'maintenance')
  );
END;
$function$;

-- ---------------------------------------------------------------
-- 8. payments_tenant_read was name-keyed too
-- ---------------------------------------------------------------
-- Same defect as documents_tenant: `tenant = get_tenant_name(company_id)`
-- shows a tenant every payment row merely carrying their name, so two
-- tenants sharing a name in one company see each other's payment
-- history. Now keyed on the backfilled id.
DROP POLICY IF EXISTS payments_tenant_read ON public.payments;
CREATE POLICY payments_tenant_read ON public.payments
  FOR SELECT USING (
    tenant_id IS NOT NULL AND tenant_id = public.get_tenant_id(company_id)
  );

-- ---------------------------------------------------------------
-- 9. Tenants could read the whole membership list
-- ---------------------------------------------------------------
-- cm_read's second branch was is_member_of_company(), which is true for
-- tenants and owners as well as staff -- so any tenant could read every
-- company_members row, including other TENANTS' email addresses.
-- Verified before this change: a seeded tenant read 5 rows, one of them
-- a co-tenant's contact details.
--
-- Tenants still need to see STAFF rows: TenantPortal fans a new message
-- out to every non-tenant member, and without that the message reaches
-- nobody. So the third branch grants exactly that and nothing more.
DROP POLICY IF EXISTS cm_read ON public.company_members;
CREATE POLICY cm_read ON public.company_members
  FOR SELECT USING (
    lower(user_email) = lower(auth.jwt() ->> 'email')
    OR public.is_company_staff(company_id)
    OR (public.is_member_of_company(company_id) AND role NOT IN ('tenant', 'owner'))
  );

-- ---------------------------------------------------------------
-- 10. Keep tenant_id populated on NEW rows, not just backfilled ones
-- ---------------------------------------------------------------
-- The backfill above fixes history. Without this, every NEW row stays
-- null and is therefore invisible to the tenant under the id-keyed
-- policies -- documents especially: all three upload paths
-- (Documents.js, shared.js DocUploadModal, the property wizard) write
-- `tenant` as a NAME from a form and have no id to hand. Caught by the
-- portal E2E: "documents tab lists this tenant's visible documents
-- only" went red because a freshly uploaded document vanished.
--
-- Doing it in a trigger rather than at the three call sites means any
-- other writer -- an importer, a backfill script, a route added later --
-- gets it too. Ambiguous names resolve to NULL, preserving fail-closed.
CREATE OR REPLACE FUNCTION public.derive_tenant_id_from_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_count int;
BEGIN
  IF NEW.tenant_id IS NOT NULL OR coalesce(btrim(NEW.tenant),'') = '' THEN
    RETURN NEW;
  END IF;
  -- count and id in one pass; a window function is not legal in HAVING,
  -- and an ambiguous name must resolve to NULL rather than to whichever
  -- row sorted first.
  SELECT count(*), min(t.id) INTO v_count, NEW.tenant_id
    FROM tenants t
   WHERE t.company_id = NEW.company_id
     AND lower(t.name) = lower(btrim(NEW.tenant))
     AND t.archived_at IS NULL;
  IF v_count <> 1 THEN NEW.tenant_id := NULL; END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS documents_derive_tenant_id ON public.documents;
CREATE TRIGGER documents_derive_tenant_id
  BEFORE INSERT OR UPDATE OF tenant ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.derive_tenant_id_from_name();

DROP TRIGGER IF EXISTS payments_derive_tenant_id ON public.payments;
CREATE TRIGGER payments_derive_tenant_id
  BEFORE INSERT OR UPDATE OF tenant ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.derive_tenant_id_from_name();
