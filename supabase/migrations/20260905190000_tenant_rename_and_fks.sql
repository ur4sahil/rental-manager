-- Two things the tenant-identity work turned up.

-- ---------------------------------------------------------------
-- 1. rename_tenant_cascade has never worked
-- ---------------------------------------------------------------
-- Its fifth statement is `UPDATE ledger_entries`, and ledger_entries is
-- a VIEW over a window function -- not automatically updatable. So the
-- function raised "cannot update view ledger_entries" every single time,
-- which rolled back the four updates before it. No tenant rename has
-- ever cascaded through this RPC; Tenants.js caught the error, logged a
-- silent PM-3002, and fell through to a narrower client-side path.
--
-- This is the identical defect fixed in rename_property_v2 earlier
-- today, from the identical cause. ledger_entries derives `tenant` from
-- acct_journal_lines -> acct_accounts, so it follows automatically once
-- the base tables are right and must not be written to directly.
--
-- The function also covered 8 of the 15 tables that carry a tenant
-- name. The missing ones are added below.
CREATE OR REPLACE FUNCTION public.rename_tenant_cascade(
  p_company_id text, p_old_name text, p_new_name text, p_property text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_email text;
  v_caller_role  text;
BEGIN
  v_caller_email := current_setting('request.jwt.claims', true)::json->>'email';
  SELECT role INTO v_caller_role FROM company_members
   WHERE company_id = p_company_id
     AND lower(user_email) = lower(v_caller_email)
     AND status = 'active';

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('admin', 'owner') THEN
    RAISE EXCEPTION 'Unauthorized: only admins/owners can rename tenants';
  END IF;

  IF p_old_name IS NULL OR p_new_name IS NULL OR p_old_name = p_new_name THEN
    RETURN;
  END IF;

  -- Scoped by property throughout, so two tenants sharing a name at
  -- different addresses do not rewrite each other.
  UPDATE payments          SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE leases            SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name AND property = p_property;
  UPDATE work_orders       SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE documents         SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE messages          SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE autopay_schedules SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND property = p_property;
  UPDATE properties        SET tenant      = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name AND address  = p_property;

  -- Previously missed entirely, so a renamed tenant kept their old name
  -- on generated documents, eviction paperwork, recurring entries,
  -- outstanding invite codes and pending change requests.
  UPDATE doc_generated           SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE doc_exception_requests  SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE eviction_cases          SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE recurring_journal_entries SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE tenant_invite_codes     SET tenant_name = p_new_name WHERE company_id = p_company_id AND tenant_name = p_old_name;
  UPDATE property_change_requests SET tenant     = p_new_name WHERE company_id = p_company_id AND tenant      = p_old_name;

  -- ledger_entries is deliberately NOT updated: it is a non-updatable
  -- view and derives `tenant` from the base tables above.
END;
$function$;

-- ---------------------------------------------------------------
-- 2. tenant_id columns with no foreign key
-- ---------------------------------------------------------------
-- CLAUDE.md's own rule, learned from the acct_classes incident that
-- detached 13,947 journal lines: "any column holding a reference to
-- another table needs a real FK -- without one, nothing prevents silent
-- orphaning." Eleven of thirteen tenant_id columns had none.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a tenant must not
-- delete their payment history. A null tenant_id fails closed under the
-- id-keyed policies, which is the safe direction.
--
-- Verified zero existing orphans on production before adding these.
ALTER TABLE public.acct_accounts             DROP CONSTRAINT IF EXISTS acct_accounts_tenant_id_fkey;
ALTER TABLE public.acct_accounts             ADD CONSTRAINT acct_accounts_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.messages                  DROP CONSTRAINT IF EXISTS messages_tenant_id_fkey;
ALTER TABLE public.messages                  ADD CONSTRAINT messages_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.recurring_journal_entries DROP CONSTRAINT IF EXISTS recurring_journal_entries_tenant_id_fkey;
ALTER TABLE public.recurring_journal_entries ADD CONSTRAINT recurring_journal_entries_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.tenant_invite_codes       DROP CONSTRAINT IF EXISTS tenant_invite_codes_tenant_id_fkey;
ALTER TABLE public.tenant_invite_codes       ADD CONSTRAINT tenant_invite_codes_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.documents                 DROP CONSTRAINT IF EXISTS documents_tenant_id_fkey;
ALTER TABLE public.documents                 ADD CONSTRAINT documents_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.payments                  DROP CONSTRAINT IF EXISTS payments_tenant_id_fkey;
ALTER TABLE public.payments                  ADD CONSTRAINT payments_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.work_orders               DROP CONSTRAINT IF EXISTS work_orders_tenant_id_fkey;
ALTER TABLE public.work_orders               ADD CONSTRAINT work_orders_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE public.doc_generated             DROP CONSTRAINT IF EXISTS doc_generated_tenant_id_fkey;
ALTER TABLE public.doc_generated             ADD CONSTRAINT doc_generated_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- eviction_cases.tenant_id is deliberately left alone: it is a UUID
-- while tenants.id is an integer, so it cannot reference tenants at all
-- and never has. It holds no rows today. Changing its type is a
-- separate piece of work, not something to smuggle into a FK migration.
COMMENT ON COLUMN public.eviction_cases.tenant_id IS
  'UNUSED / WRONG TYPE: uuid, but tenants.id is integer. Cannot reference tenants. Match on tenant_name until this is retyped.';
