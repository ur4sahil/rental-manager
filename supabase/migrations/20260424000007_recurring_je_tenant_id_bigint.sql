-- Fix: recurring_journal_entries.tenant_id is type uuid, but
-- tenants.id is bigint. Every code path that tried to set
-- tenant_id (Property Setup Wizard, RecurringEntryModal, balance
-- backfills) failed silently with "invalid input syntax for type
-- uuid" and the column stayed NULL. autoPostRecurringEntries
-- gates the update_tenant_balance call on entry.tenant_id, so
-- recurring rent posted to the GL but never bumped tenants.balance.
-- The visible symptom: Sheeba's tenant portal showed $0 while her
-- 1100-003 AR sub-account showed $17,500 — same drift bug we saw
-- on Falana / Andrea Wilson / Anish / Shruti.
--
-- Verified zero rows have tenant_id set company-wide before
-- altering, so the type change loses no real data — every prior
-- write into this column rejected.

ALTER TABLE recurring_journal_entries
  ALTER COLUMN tenant_id DROP DEFAULT;

ALTER TABLE recurring_journal_entries
  ALTER COLUMN tenant_id TYPE bigint USING NULL;

-- Lookups by tenant for the recurring catch-up and reporting flows.
CREATE INDEX IF NOT EXISTS idx_recur_je_tenant_id
  ON recurring_journal_entries (tenant_id)
  WHERE tenant_id IS NOT NULL;
