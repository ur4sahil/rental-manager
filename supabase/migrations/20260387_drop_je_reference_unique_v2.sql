-- Find and drop the actual constraint by querying pg_constraint
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'acct_journal_entries'::regclass
  AND conname LIKE '%reference%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE 'ALTER TABLE acct_journal_entries DROP CONSTRAINT ' || constraint_name;
    RAISE NOTICE 'Dropped constraint: %', constraint_name;
  ELSE
    RAISE NOTICE 'No reference constraint found';
  END IF;
END $$;
