-- Direct drop by exact name (from error message)
DO $$
BEGIN
  EXECUTE 'ALTER TABLE public.acct_journal_entries DROP CONSTRAINT IF EXISTS "acct_journal_entries_company_reference_unique"';
  RAISE NOTICE 'Dropped acct_journal_entries_company_reference_unique';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Drop failed: %, trying unique index...', SQLERRM;
END $$;

-- It might be a unique INDEX, not a constraint
DROP INDEX IF EXISTS public.acct_journal_entries_company_reference_unique;
DROP INDEX IF EXISTS public."acct_journal_entries_company_reference_unique";
