-- Wire the utility payment path to the app.
--
-- The machinery existed but nothing joined it up: the app's button wrote to
-- automation_jobs, which nothing reads, while pay-runner.js reads
-- utility_payments, which the app never wrote. Two mechanisms built at
-- different times that had never met.
--
-- utility_payments could not carry what the app needs to close the loop:
-- which BILL a payment settles, which ACCOUNT it came out of, and where the
-- receipt ended up. Without bill_id a confirmed payment cannot mark its own
-- bill paid, which is the whole point of pressing the button.
ALTER TABLE public.utility_payments
  ADD COLUMN IF NOT EXISTS bill_id integer REFERENCES public.utility_bills(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES public.acct_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS property text,
  ADD COLUMN IF NOT EXISTS receipt_storage_path text,
  ADD COLUMN IF NOT EXISTS requested_by text;

-- One live payment per bill. 'paid', 'submitting' and 'unknown' all count as
-- occupying the bill: 'unknown' especially, because a payment nobody could
-- confirm must block another attempt rather than invite one.
--
-- This sits alongside idem_key rather than replacing it. idem_key stops the
-- same STATEMENT being paid twice even across re-imports that renumber bills;
-- this stops the same BILL ROW being paid twice. They catch different
-- mistakes, so both are kept.
CREATE UNIQUE INDEX IF NOT EXISTS idx_utility_payments_one_live_per_bill
  ON public.utility_payments (company_id, bill_id)
  WHERE bill_id IS NOT NULL AND status IN ('pending_approval','approved','submitting','paid','unknown');

CREATE INDEX IF NOT EXISTS idx_utility_payments_queue
  ON public.utility_payments (company_id, status, approved_at)
  WHERE status = 'approved';

COMMENT ON COLUMN public.utility_payments.bill_id IS
  'The utility_bills row this settles. Set by the app when a person presses Pay; used by the worker to mark that bill paid on confirmation.';
COMMENT ON COLUMN public.utility_payments.receipt_storage_path IS
  'documents-bucket path of the confirmation receipt captured after payment.';

-- ---------------------------------------------------------------------------
-- BACKFILL: file the statements that are already in the bucket.
--
-- attach-bill-document uploaded each statement and set
-- utility_bills.pdf_storage_path, but never inserted a documents row. So the
-- PDFs existed and were reachable from exactly one column on the Utilities
-- page: not in the Documents module, not against the property. From the
-- outside the bills looked as though they had never been stored.
--
-- Keyed on url, so this is idempotent -- verified by running it twice on the
-- test database: 20 filed, then 0.
--
-- property_id is resolved from the address where one matches. Where it does
-- not, the row still carries the address text, which is what the property
-- panel actually queries on, so the document still appears.
INSERT INTO documents (company_id, name, file_name, url, property, property_id, type, uploaded_at, tenant_visible)
SELECT
  b.company_id,
  b.provider || COALESCE(' ' || b.statement_period, '') || ' statement',
  -- Both columns hold the storage path: getSignedUrl is called as
  -- (file_name || url), so a bare filename in file_name breaks every link.
  b.pdf_storage_path,
  b.pdf_storage_path,
  b.property,
  p.id,
  'Utility Bill',
  COALESCE(b.created_at, now()),
  -- A statement carries the owner's account number and usage history. Not
  -- the tenant's to read unless somebody says so.
  false
FROM utility_bills b
LEFT JOIN properties p ON p.company_id = b.company_id AND p.address = b.property
-- COALESCE, not IS NOT NULL. 64 of 86 production bills hold '' rather than
-- null, and IS NOT NULL accepts an empty string -- so the first version of
-- this backfill filed 64 documents whose View link pointed at nothing.
WHERE COALESCE(b.pdf_storage_path, '') <> ''
  AND NOT EXISTS (
    SELECT 1 FROM documents d
    WHERE d.company_id = b.company_id AND d.url = b.pdf_storage_path
  );
