-- Prevent double-posting of recurring entries and other reference-based JEs.
-- Two concurrent calls to autoPostRecurringEntries() could both pass the SELECT check
-- and insert duplicate entries. This constraint makes the second insert fail safely.

-- Step 1: Void duplicate JEs (keep the oldest, void the rest)
-- This handles any existing duplicates so the unique index can be created.
WITH ranked AS (
  SELECT id, company_id, reference, status,
    ROW_NUMBER() OVER (PARTITION BY company_id, reference ORDER BY created_at ASC) AS rn
  FROM acct_journal_entries
  WHERE status != 'voided' AND reference != ''
)
UPDATE acct_journal_entries
SET status = 'voided', description = '[AUTO-VOIDED: duplicate reference] ' || description
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Step 2: Create partial unique index on non-voided, non-empty references
CREATE UNIQUE INDEX IF NOT EXISTS idx_je_company_reference_unique
ON acct_journal_entries (company_id, reference)
WHERE status != 'voided' AND reference != '';
