-- A utility bill row carries the account's CURRENT balance (amount: what the
-- portal says is owed today -- $0 once paid, negative in credit). The statement
-- PDF filed with it is a dated document with its own figures, which the
-- Statements list was mislabelling with that balance (WSSC 4747 River Valley:
-- a "Bill Date 07/13/26, Total Due $805.37" statement shown as "$-1.00").
--
-- These columns hold the statement's OWN figures, read from the PDF when it is
-- attached (api/_statement-fields.js). bill_date already exists and takes the
-- statement's bill/issue date. All nullable: a field not found on the PDF is
-- left empty, never guessed. Adds columns only; no existing data changes.
ALTER TABLE public.utility_bills
  ADD COLUMN IF NOT EXISTS statement_total        numeric(12,2),
  ADD COLUMN IF NOT EXISTS statement_period_start date,
  ADD COLUMN IF NOT EXISTS statement_period_end   date,
  ADD COLUMN IF NOT EXISTS statement_due_date     date;

COMMENT ON COLUMN public.utility_bills.statement_total IS
  'Total due printed ON the attached statement PDF (negative = credit statement). Distinct from amount, which is the current balance.';
