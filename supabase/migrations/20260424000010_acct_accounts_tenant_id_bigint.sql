-- Same pattern as 20260424000007 for recurring_journal_entries:
-- acct_accounts.tenant_id was declared as uuid back in
-- 20260340_fix_account_codes_and_subledger.sql, but tenants.id is
-- bigint. Every code path that tried to populate tenant_id (e.g.
-- getOrCreateTenantAR's INSERT) failed silently with "invalid
-- input syntax for type uuid" and the column stayed NULL.
-- Migration 20260422000006_wizard_schema_audit.sql even called this
-- out — "the column is unused in this DB; don't write to it" — so
-- the per-tenant AR linkage was left as a name-string match,
-- which is exactly what blocked the per-lease split.
--
-- Verified zero rows have tenant_id set company-wide. Type change
-- loses no real data.

ALTER TABLE acct_accounts
  ALTER COLUMN tenant_id DROP DEFAULT;

-- Drop the existing index first (it references the uuid column).
DROP INDEX IF EXISTS idx_acct_accounts_tenant;

ALTER TABLE acct_accounts
  ALTER COLUMN tenant_id TYPE bigint USING NULL;

CREATE INDEX IF NOT EXISTS idx_acct_accounts_tenant
  ON acct_accounts (tenant_id)
  WHERE tenant_id IS NOT NULL;
