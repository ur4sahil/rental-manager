-- Theme K, QA round 3: gaps left around the repair postings.
--
--   1. Hard-deleting a vendor cascaded away its invoices
--      (vendor_invoices.vendor_id ON DELETE CASCADE), so the paid invoice
--      vanished and completing its work order expensed the repair again.
--      Now ON DELETE RESTRICT, plus a guard with a clear message.
--   3. repair_pay_invoice paid withdrawn (archived) and disputed invoices.
--   5. Voiding a VPAY- entry left the invoice "paid" with no way to re-pay it
--      in the app. A trigger now puts the invoice back to pending (and takes
--      it back out of the vendor's totals); un-voiding does the reverse.
--   6. First use in a fresh company: two concurrent postings both tried to
--      create account 2110/5300 and one failed on
--      acct_accounts_company_code_unique. Insert is now ON CONFLICT DO NOTHING.
--   7. The 180-day archive purge aborted the WHOLE run on the first row it
--      could not delete (an archived property still referenced by a kept,
--      booked work order). It now deletes row by row and skips what it
--      cannot delete.
--   8. VPAY- joins je_reference_is_system; the work-order link error no
--      longer echoes the id (it said nothing different for "exists in
--      another company" vs "does not exist", now it doesn't name it either).
--
-- No existing journal entry is changed.

-- ── 1. vendors with invoices cannot be hard-deleted ────────────────────────
ALTER TABLE public.vendor_invoices DROP CONSTRAINT IF EXISTS vendor_invoices_vendor_id_fkey;
ALTER TABLE public.vendor_invoices
  ADD CONSTRAINT vendor_invoices_vendor_id_fkey
  FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public._guard_vendor_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM vendor_invoices WHERE vendor_id = OLD.id) THEN
    RAISE EXCEPTION 'This vendor has invoices and cannot be permanently deleted. Keep it archived.'
      USING ERRCODE = '23503', HINT = 'vendor_has_invoices';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public._guard_vendor_delete() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS trg_guard_vendor_delete ON public.vendors;
CREATE TRIGGER trg_guard_vendor_delete BEFORE DELETE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public._guard_vendor_delete();

-- ── 3. withdrawn / disputed invoices are not payable ───────────────────────
CREATE OR REPLACE FUNCTION public.repair_pay_invoice(p_company_id text, p_invoice_id uuid, p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_inv vendor_invoices%ROWTYPE; f record; v_ap numeric := 0; v_exp numeric; v_amt numeric;
  v_je text; v_reason text; v_co jsonb; v_flipped boolean := false; v_lines jsonb; v_vendor text;
BEGIN
  PERFORM public._assert_company_staff(p_company_id);
  PERFORM pg_advisory_xact_lock(hashtext(p_company_id || ':VINV:' || p_invoice_id));
  SELECT * INTO v_inv FROM vendor_invoices WHERE company_id = p_company_id AND id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('reason', 'no_invoice'); END IF;
  -- A withdrawn (archived) or disputed invoice is not payable: a stale tab
  -- or a direct call must not book it.
  IF v_inv.archived_at IS NOT NULL THEN RETURN jsonb_build_object('reason', 'withdrawn'); END IF;
  IF v_inv.status = 'disputed' THEN RETURN jsonb_build_object('reason', 'disputed'); END IF;
  IF v_inv.work_order_id IS NOT NULL THEN PERFORM public._repair_lock_wo(p_company_id, v_inv.work_order_id); END IF;
  v_amt := round(COALESCE(v_inv.amount, 0), 2);
  v_vendor := COALESCE(NULLIF(v_inv.vendor_name, ''), 'vendor');

  SELECT id INTO v_je FROM acct_journal_entries WHERE company_id = p_company_id
     AND reference = 'VPAY-' || p_invoice_id AND status <> 'voided' LIMIT 1;
  IF v_je IS NOT NULL THEN
    v_reason := 'already_posted';
  ELSIF v_inv.status = 'paid' AND NOT EXISTS (SELECT 1 FROM acct_journal_entries WHERE company_id = p_company_id
                                                 AND reference = 'VPAY-' || p_invoice_id) THEN
    -- Paid before this system existed (legacy VINV- entry we cannot see): never pay it again.
    RETURN jsonb_build_object('reason', 'already_paid');
  ELSIF v_amt <= 0 THEN
    RETURN jsonb_build_object('reason', 'no_amount');
  ELSE
    IF v_inv.work_order_id IS NOT NULL THEN
      SELECT * INTO f FROM public._repair_facts(p_company_id, v_inv.work_order_id, p_invoice_id);
      v_ap := round(least(v_amt, greatest(0, f.accrued - f.applied)), 2);
    END IF;
    v_exp := v_amt - v_ap;
    v_lines := jsonb_build_array();
    IF v_ap > 0 THEN v_lines := v_lines || jsonb_build_object('code', '2110', 'name', 'Accounts Payable', 'debit', v_ap, 'credit', 0, 'memo', 'Clears work-order payable — ' || v_vendor); END IF;
    IF v_exp > 0 THEN v_lines := v_lines || jsonb_build_object('code', '5300', 'name', 'Repairs & Maintenance', 'debit', v_exp, 'credit', 0, 'memo', v_vendor || COALESCE(': ' || NULLIF(v_inv.description, ''), '')); END IF;
    v_lines := v_lines || jsonb_build_object('code', '1000', 'name', 'Checking Account', 'debit', 0, 'credit', v_amt, 'memo', 'Payment to ' || v_vendor);
    v_je := public._repair_post(p_company_id, p_date,
      'Vendor payment — ' || v_vendor || ' — ' || COALESCE(NULLIF(v_inv.description, ''), v_inv.invoice_number, ''),
      'VPAY-' || p_invoice_id, v_inv.property, v_lines);
    v_reason := 'posted';
  END IF;

  -- Mark paid; the transition (not the post) is what counts the payment in
  -- the vendor's totals, so a retry after a half-finished attempt counts once.
  IF v_inv.status IS DISTINCT FROM 'paid' THEN
    UPDATE vendor_invoices SET status = 'paid', paid_date = COALESCE(paid_date, p_date)
     WHERE company_id = p_company_id AND id = p_invoice_id;
    v_flipped := true;
    IF v_inv.vendor_id IS NOT NULL THEN
      UPDATE vendors SET total_paid = COALESCE(total_paid, 0) + v_amt, total_jobs = COALESCE(total_jobs, 0) + 1
       WHERE company_id = p_company_id AND id = v_inv.vendor_id;
    END IF;
  END IF;

  IF v_inv.work_order_id IS NOT NULL THEN v_co := public._repair_close_out(p_company_id, v_inv.work_order_id, p_date); END IF;
  RETURN jsonb_build_object('reason', v_reason, 'je_id', v_je, 'ap', v_ap, 'expense', COALESCE(v_exp, 0),
                            'marked_paid', v_flipped, 'closeout', v_co);
END $$;


-- ── 5. voiding a VPAY- entry un-pays its invoice ───────────────────────────
CREATE OR REPLACE FUNCTION public._vpay_follow_void()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_id uuid;
  v_inv vendor_invoices%ROWTYPE;
BEGIN
  IF NEW.reference !~* '^VPAY-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  v_id := substring(NEW.reference FROM 6)::uuid;
  SELECT * INTO v_inv FROM vendor_invoices WHERE id = v_id AND company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.status = 'voided' AND OLD.status IS DISTINCT FROM 'voided' AND v_inv.status = 'paid'
     -- another live payment of the same invoice would keep it paid
     AND NOT EXISTS (SELECT 1 FROM acct_journal_entries WHERE company_id = NEW.company_id
                      AND reference = NEW.reference AND status <> 'voided' AND id <> NEW.id) THEN
    UPDATE vendor_invoices SET status = 'pending', paid_date = NULL WHERE id = v_id;
    IF v_inv.vendor_id IS NOT NULL THEN
      UPDATE vendors SET total_paid = greatest(0, COALESCE(total_paid, 0) - COALESCE(v_inv.amount, 0)),
                         total_jobs = greatest(0, COALESCE(total_jobs, 0) - 1)
       WHERE id = v_inv.vendor_id AND company_id = NEW.company_id;
    END IF;
  ELSIF OLD.status = 'voided' AND NEW.status IS DISTINCT FROM 'voided' AND v_inv.status IS DISTINCT FROM 'paid' THEN
    UPDATE vendor_invoices SET status = 'paid', paid_date = COALESCE(paid_date, NEW.date) WHERE id = v_id;
    IF v_inv.vendor_id IS NOT NULL THEN
      UPDATE vendors SET total_paid = COALESCE(total_paid, 0) + COALESCE(v_inv.amount, 0),
                         total_jobs = COALESCE(total_jobs, 0) + 1
       WHERE id = v_inv.vendor_id AND company_id = NEW.company_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._vpay_follow_void() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS trg_vpay_follow_void ON public.acct_journal_entries;
CREATE TRIGGER trg_vpay_follow_void AFTER UPDATE OF status ON public.acct_journal_entries
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.reference LIKE 'VPAY-%')
  EXECUTE FUNCTION public._vpay_follow_void();

-- ── 6. account creation is race-safe ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public._repair_account(p_company_id text, p_code text)
RETURNS uuid LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_id uuid;
  v_name text := CASE p_code WHEN '2110' THEN 'Accounts Payable' WHEN '5300' THEN 'Repairs & Maintenance'
                             WHEN '1000' THEN 'Checking Account' ELSE 'Account ' || p_code END;
BEGIN
  SELECT id INTO v_id FROM acct_accounts WHERE company_id = p_company_id AND code = p_code ORDER BY created_at NULLS LAST LIMIT 1;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM acct_accounts WHERE company_id = p_company_id AND name = v_name ORDER BY created_at NULLS LAST LIMIT 1; END IF;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM acct_accounts WHERE company_id = p_company_id AND code ~ ('(^|[^0-9])' || p_code || '$') ORDER BY created_at NULLS LAST LIMIT 1; END IF;
  IF v_id IS NULL THEN
    INSERT INTO acct_accounts (company_id, code, name, type, is_active, old_text_id)
    VALUES (p_company_id, p_code, v_name,
            CASE substring(p_code, 1, 1) WHEN '1' THEN 'Asset' WHEN '2' THEN 'Liability' ELSE 'Expense' END,
            true, p_company_id || '-' || p_code)
    ON CONFLICT (company_id, code) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN  -- a concurrent posting created it first
      SELECT id INTO v_id FROM acct_accounts WHERE company_id = p_company_id AND code = p_code LIMIT 1;
    END IF;
  END IF;
  RETURN v_id;
END $$;

-- ── 7. purge skips what it cannot delete ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_old_archives()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cutoff  TIMESTAMPTZ := NOW() - INTERVAL '180 days';
  v_total   INT := 0;
  v_skipped INT := 0;
  t text;
  r record;
BEGIN
  -- Children before parents; properties last. Each row is deleted on its
  -- own, so one row that is still referenced (e.g. an archived property
  -- whose booked work order is kept for the books) is skipped instead of
  -- aborting the whole run.
  FOREACH t IN ARRAY ARRAY['work_orders', 'autopay_schedules', 'utilities', 'hoa_payments', 'documents',
                           'payments', 'leases', 'tenants', 'properties'] LOOP
    -- ids travel as text (the tables use integer and uuid keys) and go back
    -- in as a literal, which Postgres casts to the column's own type.
    FOR r IN EXECUTE format('SELECT id::text AS id, company_id::text AS company_id FROM public.%I WHERE archived_at IS NOT NULL AND archived_at < $1', t) USING v_cutoff LOOP
      IF t = 'work_orders' AND public._work_order_is_booked(r.company_id, r.id::integer) THEN
        v_skipped := v_skipped + 1; CONTINUE;
      END IF;
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE id = %L', t, r.id);
        v_total := v_total + 1;
      EXCEPTION WHEN OTHERS THEN
        v_skipped := v_skipped + 1;
      END;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('purged', v_total, 'skipped', v_skipped, 'cutoff', v_cutoff);
END;
$function$;

-- ── 8. VPAY- is a system reference; the link error names nothing ───────────
CREATE OR REPLACE FUNCTION public.je_reference_is_system(p_reference text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(btrim(p_reference), '') ~ '^(OPENING|PRORENT|RENT|RENT1|LATEFEE|LATE|DEPDED|DEPRET|DEPFORF|DEP|WOFF|WO|VINV|VPAY|BANK|XFER|SPLIT|APAY|PAY|STRIPE|RECUR|MOVEOUT|ODIST|DIST|HOA|UTIL|LOAN|EVICT|BULK|MANUAL)-';
$function$;
REVOKE ALL ON FUNCTION public.je_reference_is_system(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.je_reference_is_system(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._guard_work_order_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF NEW.work_order_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = NEW.work_order_id AND w.company_id = NEW.company_id) THEN
    -- Same message whether the id exists in another company or not at all.
    RAISE EXCEPTION 'Work order not found in this company'
      USING ERRCODE = '42501', HINT = 'cross_company_work_order';
  END IF;
  IF TG_TABLE_NAME = 'vendor_invoices' AND TG_OP = 'UPDATE'
     AND NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
     AND EXISTS (SELECT 1 FROM acct_journal_entries
                  WHERE company_id = OLD.company_id AND reference = 'VPAY-' || OLD.id AND status <> 'voided') THEN
    RAISE EXCEPTION 'This invoice has been paid; its work order can no longer be changed'
      USING ERRCODE = 'P0001', HINT = 'paid_invoice_relink';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._guard_work_order_link() FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.repair_pay_invoice(text, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repair_pay_invoice(text, uuid, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public._repair_account(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._repair_account(text, text) TO authenticated, service_role;
