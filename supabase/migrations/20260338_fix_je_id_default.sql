-- Fix: acct_journal_entries.id needs a default UUID generator
-- Without this, direct inserts (no RPC) fail with "null value in column id"
ALTER TABLE acct_journal_entries ALTER COLUMN id SET DEFAULT gen_random_uuid();
