-- Fix: old_account_id inherited NOT NULL from the original account_id column
-- New inserts don't provide this column, so it must be nullable
ALTER TABLE acct_journal_lines ALTER COLUMN old_account_id DROP NOT NULL;
