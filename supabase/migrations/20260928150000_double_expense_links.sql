-- Book each real-world expense once (audit theme K): work-order links.
--
-- vendor_invoices.work_order_id and work_order_photos.work_order_id were
-- declared uuid while work_orders.id is an integer, so neither could ever
-- point at a real work order:
--   - an invoice could not be linked to the work order it bills, so the two
--     postings could not see each other: completing a work order booked
--     DR Repairs / CR Accounts Payable, and paying the vendor's invoice booked
--     DR Repairs / CR Checking -- the same repair expensed twice, and the
--     payable never cleared;
--   - the tenant portal's photo upload inserted the integer id into a uuid
--     column and failed.
-- Both are retyped to integer with a real FK. Neither was ever writable with
-- a real id, so both are expected to be empty; if either is not, the
-- migration stops rather than discard data.
--
-- RLS policies that reference the column (work_order_photos has two, which
-- compare it as ::text) block ALTER TYPE. They are read from pg_policies,
-- dropped, and re-created from their OWN stored definitions after the retype
-- -- never from a hard-coded copy, so whatever each database has is what it
-- keeps.
--
-- No existing journal entry, invoice, photo or loan row is changed.

DO $$
DECLARE
  t text;
  v_type text;
  v_nonnull bigint;
  pol record;
  saved jsonb;
  stmt text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vendor_invoices', 'work_order_photos'] LOOP
    SELECT data_type INTO v_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t AND column_name = 'work_order_id';
    CONTINUE WHEN v_type IS DISTINCT FROM 'uuid';

    EXECUTE format('SELECT count(*) FROM public.%I WHERE work_order_id IS NOT NULL', t) INTO v_nonnull;
    IF v_nonnull > 0 THEN
      RAISE EXCEPTION '%.work_order_id has % non-null uuid values; resolve them by hand before retyping', t, v_nonnull;
    END IF;

    -- Save + drop the policies whose expressions mention work_order_id.
    saved := '[]'::jsonb;
    FOR pol IN
      SELECT policyname, permissive, cmd, roles, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND (coalesce(qual, '') ~ 'work_order_id' OR coalesce(with_check, '') ~ 'work_order_id')
    LOOP
      saved := saved || jsonb_build_array(to_jsonb(pol));
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
    END LOOP;

    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN work_order_id TYPE integer USING NULL', t);

    -- Re-create each policy exactly as it was.
    FOR pol IN SELECT * FROM jsonb_to_recordset(saved)
        AS x(policyname text, permissive text, cmd text, roles text[], qual text, with_check text)
    LOOP
      stmt := format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s',
                     pol.policyname, t, pol.permissive, pol.cmd,
                     (SELECT string_agg(CASE WHEN r = 'public' THEN 'public' ELSE quote_ident(r) END, ', ')
                        FROM unnest(pol.roles) r));
      IF pol.qual IS NOT NULL THEN stmt := stmt || ' USING (' || pol.qual || ')'; END IF;
      IF pol.with_check IS NOT NULL THEN stmt := stmt || ' WITH CHECK (' || pol.with_check || ')'; END IF;
      EXECUTE stmt;
    END LOOP;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendor_invoices_work_order_id_fkey') THEN
    ALTER TABLE public.vendor_invoices
      ADD CONSTRAINT vendor_invoices_work_order_id_fkey
      FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;  -- deleting a billed work order must not unlink its invoice
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_order_photos_work_order_id_fkey') THEN
    ALTER TABLE public.work_order_photos
      ADD CONSTRAINT work_order_photos_work_order_id_fkey
      FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_vendor_invoices_work_order
  ON public.vendor_invoices (company_id, work_order_id) WHERE work_order_id IS NOT NULL;
