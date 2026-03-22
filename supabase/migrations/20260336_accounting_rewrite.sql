-- ============================================================
-- ACCOUNTING MODULE REWRITE MIGRATION
-- Migrates acct_accounts from text PKs to UUID PKs with code column
-- Adds company_id to journal lines for direct RLS
-- Drops broken create_journal_entry RPC
-- Fixes RLS policies for staff INSERT/UPDATE
-- ============================================================

-- Step 1: Add code column to acct_accounts
ALTER TABLE acct_accounts ADD COLUMN IF NOT EXISTS code TEXT;

-- Backfill code from existing text id
UPDATE acct_accounts SET code = id WHERE code IS NULL;

-- Step 2: Add new UUID column
ALTER TABLE acct_accounts ADD COLUMN IF NOT EXISTS new_id UUID DEFAULT gen_random_uuid();
UPDATE acct_accounts SET new_id = gen_random_uuid() WHERE new_id IS NULL;

-- Step 3: Add new UUID FK column to journal lines
ALTER TABLE acct_journal_lines ADD COLUMN IF NOT EXISTS new_account_id UUID;

-- Backfill from old text join
UPDATE acct_journal_lines jl
SET new_account_id = a.new_id
FROM acct_accounts a
WHERE jl.account_id = a.id
  AND jl.new_account_id IS NULL;

-- Step 4: Drop old FK constraint if exists
ALTER TABLE acct_journal_lines DROP CONSTRAINT IF EXISTS acct_journal_lines_account_id_fkey;
ALTER TABLE acct_journal_lines DROP CONSTRAINT IF EXISTS fk_account;

-- Step 5: Drop old PK
ALTER TABLE acct_accounts DROP CONSTRAINT IF EXISTS acct_accounts_pkey;

-- Step 6: Rename columns
ALTER TABLE acct_accounts RENAME COLUMN id TO old_text_id;
ALTER TABLE acct_accounts RENAME COLUMN new_id TO id;

ALTER TABLE acct_journal_lines RENAME COLUMN account_id TO old_account_id;
ALTER TABLE acct_journal_lines RENAME COLUMN new_account_id TO account_id;

-- Step 7: Set new PK and constraints
ALTER TABLE acct_accounts ADD PRIMARY KEY (id);
ALTER TABLE acct_accounts ADD CONSTRAINT acct_accounts_company_code_unique UNIQUE (company_id, code);

-- Step 8: Add FK from journal lines to accounts (nullable — orphan lines won't block)
ALTER TABLE acct_journal_lines
  ADD CONSTRAINT acct_journal_lines_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES acct_accounts(id) ON DELETE SET NULL;

-- Step 9: Add company_id to journal lines for direct RLS
ALTER TABLE acct_journal_lines ADD COLUMN IF NOT EXISTS company_id TEXT;

UPDATE acct_journal_lines jl
SET company_id = je.company_id
FROM acct_journal_entries je
WHERE jl.journal_entry_id = je.id
  AND jl.company_id IS NULL;

-- Auto-set company_id trigger
CREATE OR REPLACE FUNCTION set_journal_line_company_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT company_id INTO NEW.company_id
    FROM acct_journal_entries WHERE id = NEW.journal_entry_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jl_company_id ON acct_journal_lines;
CREATE TRIGGER trg_jl_company_id
  BEFORE INSERT ON acct_journal_lines
  FOR EACH ROW EXECUTE FUNCTION set_journal_line_company_id();

-- Step 10: Normalize recurring_journal_entries account IDs to bare codes
UPDATE recurring_journal_entries rje
SET debit_account_id = a.code
FROM acct_accounts a
WHERE rje.debit_account_id = a.old_text_id
  AND a.code IS NOT NULL;

UPDATE recurring_journal_entries rje
SET credit_account_id = a.code
FROM acct_accounts a
WHERE rje.credit_account_id = a.old_text_id
  AND a.code IS NOT NULL;

-- Step 11: Drop broken create_journal_entry RPC (all overloads)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT oid::regprocedure AS sig
    FROM pg_proc WHERE proname = 'create_journal_entry'
    AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

-- Step 12: Fix RLS — ensure staff can INSERT/UPDATE/SELECT on all acct tables
-- acct_journal_entries
DROP POLICY IF EXISTS "acct_je_staff_all" ON acct_journal_entries;
CREATE POLICY "acct_je_staff_all" ON acct_journal_entries
  FOR ALL USING (is_company_staff(company_id))
  WITH CHECK (is_company_staff(company_id));

-- acct_journal_lines (now uses direct company_id)
DROP POLICY IF EXISTS "acct_jl_staff" ON acct_journal_lines;
DROP POLICY IF EXISTS "acct_jl_staff_all" ON acct_journal_lines;
CREATE POLICY "acct_jl_staff_all" ON acct_journal_lines
  FOR ALL USING (is_company_staff(company_id))
  WITH CHECK (is_company_staff(company_id));

-- acct_accounts
DROP POLICY IF EXISTS "acct_accounts_staff_all" ON acct_accounts;
CREATE POLICY "acct_accounts_staff_all" ON acct_accounts
  FOR ALL USING (is_company_staff(company_id))
  WITH CHECK (is_company_staff(company_id));

-- Ensure RLS is enabled
ALTER TABLE acct_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE acct_journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE acct_accounts ENABLE ROW LEVEL SECURITY;

-- Step 13: Rebuild indexes for new UUID columns
DROP INDEX IF EXISTS idx_acct_jl_account;
CREATE INDEX IF NOT EXISTS idx_acct_accounts_company_code ON acct_accounts(company_id, code);
CREATE INDEX IF NOT EXISTS idx_acct_jl_account ON acct_journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_acct_jl_company ON acct_journal_lines(company_id);
CREATE INDEX IF NOT EXISTS idx_acct_jl_je ON acct_journal_lines(journal_entry_id);
