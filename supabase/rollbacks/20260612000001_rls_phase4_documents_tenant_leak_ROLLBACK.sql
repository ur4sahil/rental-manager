-- ROLLBACK for 20260612000001_rls_phase4_documents_tenant_leak.sql
-- Restores the original documents_tenant policy.
-- ⚠️ Reopens the cross-company untenanted-document leak to the anon key and to
--    authenticated tenants of other companies. Recovery use only.
DROP POLICY IF EXISTS "documents_tenant" ON public.documents;
CREATE POLICY "documents_tenant" ON public.documents
  FOR SELECT TO public
  USING (lower(tenant) = lower(COALESCE(get_tenant_name(company_id), ''::text)));
