-- Bank reconciliations: align CHECK + NOT NULL with actual code paths.
--
-- Two issues caught by the bank-recon stress test on 2026-04-24:
--
-- (1) status CHECK constraint mismatch.
--     Live DB: bank_reconciliations_status_check allows
--       reconciled | in_progress | discrepancy
--     But the code writes:
--       - "pending_items" — Accounting.js:3939, on save when difference
--         is zero but not every line was checked off (legitimate state
--         the user can save and resume later).
--       - "reopened"      — Accounting.js:3809, when an admin reopens
--         a previously-completed reconciliation to amend it.
--     Both writes would 500 on the live constraint. Production rows
--     today only carry "reconciled" and "discrepancy" — those two
--     code paths haven't been hit yet, but they're real flows.
--     Fixing by replacing the CHECK with the full set the code uses.
--
-- (2) bank_ending_balance NOT NULL.
--     Live table has it (introspected via INSERT probe); the
--     20260424000001 migration that formalized the table doesn't
--     declare it. Fresh DB restores would silently allow NULL
--     ending balances. Code always passes a number (Accounting.js:3942
--     uses Number(...) on the user input), so this is purely a
--     migration / fresh-deploy fidelity fix — no live data changes.

ALTER TABLE bank_reconciliations
  DROP CONSTRAINT IF EXISTS bank_reconciliations_status_check;

ALTER TABLE bank_reconciliations
  ADD CONSTRAINT bank_reconciliations_status_check
  CHECK (status IN ('reconciled', 'in_progress', 'discrepancy', 'pending_items', 'reopened'));

-- Idempotent NOT NULL — only sets if the column is currently nullable.
-- Wrapped in a DO block so re-running this migration on a DB that
-- already has it (production) is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'bank_reconciliations'
       AND column_name = 'bank_ending_balance'
       AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE bank_reconciliations
      ALTER COLUMN bank_ending_balance SET NOT NULL;
  END IF;
END $$;
