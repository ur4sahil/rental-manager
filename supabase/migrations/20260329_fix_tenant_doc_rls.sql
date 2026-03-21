-- Fix: Allow tenants to see all docs where they are the tenant
-- (both tenant_visible=true from admin AND their own uploads)
-- Also allow tenant INSERT for their own docs
DROP POLICY IF EXISTS "documents_tenant" ON documents;
CREATE POLICY "documents_tenant" ON documents FOR SELECT USING (
  lower(tenant) = lower(coalesce(get_tenant_name(company_id), ''))
);
CREATE POLICY "documents_tenant_insert" ON documents FOR INSERT WITH CHECK (
  tenant = get_tenant_name(company_id)
);
