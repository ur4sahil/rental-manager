-- Tenant portal messaging scoped lookups by tenant_id, but the column
-- didn't exist — inserts from the portal were failing on first contact
-- (the pre-fix code didn't pass tenant_id and fell back to name; once we
-- started passing it for security, the insert broke with 400).
-- Nullable so existing name-only rows keep working; new inserts populate it.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS tenant_id bigint;
CREATE INDEX IF NOT EXISTS idx_messages_company_tenant_id
  ON public.messages (company_id, tenant_id)
  WHERE tenant_id IS NOT NULL;
