-- Drop the unique constraint on (company_id, reference) for acct_journal_entries.
-- References are for audit/traceability, not uniqueness.
-- JE uniqueness is enforced by (company_id, number) which already exists.
-- The reference unique constraint causes failures when:
--   1. Bank feed transactions are re-posted after undo
--   2. Multiple imports create JEs with similar references
--   3. Retry logic generates same reference on collision recovery

ALTER TABLE acct_journal_entries DROP CONSTRAINT IF EXISTS acct_journal_entries_company_reference_unique;
ALTER TABLE acct_journal_entries DROP CONSTRAINT IF EXISTS unique_je_reference_per_company;
ALTER TABLE acct_journal_entries DROP CONSTRAINT IF EXISTS acct_journal_entries_company_id_reference_key;

-- Also drop any index that enforces uniqueness on reference
DROP INDEX IF EXISTS idx_je_company_reference_unique;
DROP INDEX IF EXISTS unique_je_reference_per_company;
