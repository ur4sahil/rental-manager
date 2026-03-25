-- Allow 'teller' as source_type in bank_connection
ALTER TABLE bank_connection DROP CONSTRAINT IF EXISTS bank_connection_source_type_check;
ALTER TABLE bank_connection ADD CONSTRAINT bank_connection_source_type_check CHECK (source_type IN ('plaid', 'teller', 'manual'));

-- Allow 'teller' as connection_type in bank_account_feed
ALTER TABLE bank_account_feed DROP CONSTRAINT IF EXISTS bank_account_feed_connection_type_check;
ALTER TABLE bank_account_feed ADD CONSTRAINT bank_account_feed_connection_type_check CHECK (connection_type IN ('csv', 'plaid', 'teller', 'manual'));
