-- Add bank_feed_transaction_id to acct_journal_lines for traceability
-- Links JE lines back to the bank feed transaction that created them
ALTER TABLE acct_journal_lines ADD COLUMN IF NOT EXISTS bank_feed_transaction_id uuid DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_jl_bank_feed_txn ON acct_journal_lines(bank_feed_transaction_id);
