-- Bank sync guard (2026-09-30, after 2,153 old transactions flooded For Review).
--
-- sync_lock_until: one Plaid sync per connection at a time (claimed
--   atomically by api/plaid-sync-transactions.js; self-expires).
-- triggered_by:    who started each sync (cron / webhook / user:<email>).
-- sync_from_date (existing, dropped by the Plaid rewrite): now the permanent
--   start date on every sync, not just the first import.
ALTER TABLE public.bank_connection ADD COLUMN IF NOT EXISTS sync_lock_until timestamptz;
ALTER TABLE public.plaid_sync_event ADD COLUMN IF NOT EXISTS triggered_by text;

COMMENT ON COLUMN public.bank_connection.sync_from_date IS
  'Bank start date: no transaction dated before this is ever imported, on any sync.';

-- Sigma Housing LLC chose Jan 1, 2026 when the bank was connected on Sep 15.
UPDATE public.bank_connection SET sync_from_date = '2026-01-01'
 WHERE company_id = 'f985cc7a-0d6b-4905-aea9-4b6eb9fd1dec' AND source_type = 'plaid' AND sync_from_date IS NULL;
