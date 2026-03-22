-- Add property column to acct_journal_entries (used for property-based filtering and class tracking)
-- This column was referenced in code but never existed in the schema
ALTER TABLE acct_journal_entries ADD COLUMN IF NOT EXISTS property TEXT DEFAULT '';
