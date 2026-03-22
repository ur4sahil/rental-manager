-- ============================================================
-- FIX: Normalize account codes (strip compound prefix)
-- ADD: parent_id column for sub-account hierarchy (tenant AR)
-- ============================================================

-- Step 1: Strip "co-xxxxx-" prefix from code values
-- Pattern: any code starting with "co-" followed by chars and a dash before digits
UPDATE acct_accounts
SET code = regexp_replace(code, '^co-[a-z0-9]+-', '')
WHERE code LIKE 'co-%';

-- Step 2: Add parent_id for sub-account hierarchy (e.g., tenant-specific AR under 1100)
ALTER TABLE acct_accounts ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES acct_accounts(id) ON DELETE SET NULL;

-- Step 3: Add tenant_id to link AR sub-accounts to specific tenants
ALTER TABLE acct_accounts ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Step 4: Index for quick sub-account lookups
CREATE INDEX IF NOT EXISTS idx_acct_accounts_parent ON acct_accounts(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acct_accounts_tenant ON acct_accounts(tenant_id) WHERE tenant_id IS NOT NULL;

-- Step 5: Recreate unique constraint (codes may have changed)
ALTER TABLE acct_accounts DROP CONSTRAINT IF EXISTS acct_accounts_company_code_unique;
ALTER TABLE acct_accounts ADD CONSTRAINT acct_accounts_company_code_unique UNIQUE (company_id, code);
