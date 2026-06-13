-- ============================================================================
-- RLS hardening — Phase 4: close the documents_tenant cross-company leak
-- ============================================================================
-- Found by tests/rls-enforcement.test.js (anon probe). The portal-tenant SELECT
-- policy on `documents` was:
--     lower(tenant) = lower(COALESCE(get_tenant_name(company_id), ''))
-- Every OTHER tenant-portal policy compares `col = get_tenant_name(company_id)`
-- WITHOUT a COALESCE, so for a non-member caller get_tenant_name() returns NULL,
-- the comparison is NULL (not true), and nothing matches. The COALESCE here
-- converted that NULL → '' , collapsing the predicate to `lower(tenant) = ''`.
-- Result: ANY caller (the public anon key shipped in the frontend bundle, or an
-- authenticated tenant of a different company) could read every untenanted
-- (company-level) document across ALL companies. Verified: anon read 8 docs
-- across 6 companies; a portal tenant read 4 docs from companies it does not
-- belong to.
--
-- Fix: drop the COALESCE and explicitly reject empty/NULL tenant rows. A real
-- portal tenant still sees documents assigned to them (get_tenant_name returns
-- their name → exact match, unchanged). Untenanted/company-level documents are
-- reached only by staff via documents_staff / documents_read — that path is
-- unaffected.
-- Rollback: supabase/rollbacks/20260612000001_..._ROLLBACK.sql
-- ============================================================================
DROP POLICY IF EXISTS "documents_tenant" ON public.documents;

CREATE POLICY "documents_tenant" ON public.documents
  FOR SELECT TO public
  USING (
    tenant IS NOT NULL
    AND btrim(tenant) <> ''
    AND lower(tenant) = lower(get_tenant_name(company_id))
  );
