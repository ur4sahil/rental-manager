-- Book each real-world expense once (audit theme K).
--
-- 1. vendor_invoices.work_order_id was declared uuid while work_orders.id is
--    an integer, so an invoice could never be linked to the work order it
--    bills. Without that link the two postings could not see each other:
--    completing a work order booked DR Repairs / CR Accounts Payable, and
--    paying the vendor's invoice booked DR Repairs / CR Checking -- the same
--    repair expensed twice, and the payable never cleared.
--    The column is retyped to integer with a real FK. The app never wrote it
--    (the invoice form had no work-order picker and the uuid type rejected
--    every real id), so it is expected to be empty; if it is not, the
--    migration stops rather than discard data.
--
-- 2. property_loans.last_payment_month ('YYYY-MM') records that "Record
--    payment" was used for a month. When the monthly mortgage recurring
--    entry already booked that month, Record payment no longer posts a
--    second expense; this column is what stops a second click from reducing
--    the loan balance twice.
--
-- No existing journal entry, invoice or loan row is changed.

DO $$
DECLARE
  v_type text;
  v_nonnull bigint;
BEGIN
  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vendor_invoices' AND column_name = 'work_order_id';
  IF v_type = 'uuid' THEN
    SELECT count(*) INTO v_nonnull FROM public.vendor_invoices WHERE work_order_id IS NOT NULL;
    IF v_nonnull > 0 THEN
      RAISE EXCEPTION 'vendor_invoices.work_order_id has % non-null uuid values; resolve them by hand before retyping', v_nonnull;
    END IF;
    ALTER TABLE public.vendor_invoices ALTER COLUMN work_order_id TYPE integer USING NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_invoices_work_order_id_fkey') THEN
    ALTER TABLE public.vendor_invoices
      ADD CONSTRAINT vendor_invoices_work_order_id_fkey
      FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vendor_invoices_work_order
  ON public.vendor_invoices (company_id, work_order_id) WHERE work_order_id IS NOT NULL;

ALTER TABLE public.property_loans ADD COLUMN IF NOT EXISTS last_payment_month text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_loans_last_payment_month_fmt') THEN
    ALTER TABLE public.property_loans
      ADD CONSTRAINT property_loans_last_payment_month_fmt
      CHECK (last_payment_month IS NULL OR last_payment_month ~ '^\d{4}-(0[1-9]|1[0-2])$');
  END IF;
END $$;
