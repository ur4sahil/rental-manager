-- Performance index for company_members RLS recursive query
CREATE INDEX IF NOT EXISTS idx_cm_email_status ON company_members(lower(user_email), status);
CREATE INDEX IF NOT EXISTS idx_cm_company_status ON company_members(company_id, status);

-- Index for bank_feed_transaction common queries
CREATE INDEX IF NOT EXISTS idx_bft_date ON bank_feed_transaction(company_id, posted_date);
CREATE INDEX IF NOT EXISTS idx_bft_provider_txn ON bank_feed_transaction(provider_transaction_id);
