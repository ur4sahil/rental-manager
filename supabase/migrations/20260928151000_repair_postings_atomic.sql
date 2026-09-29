-- Repairs booked once, even under concurrency and deletes (theme K, QA round).
--
-- An independent attack on the client-side version of the repair postings
-- (work-order accrual WO-<id>, invoice payment VPAY-<invoice id>, close-out
-- WO-ADJ-<id>) found:
--   * completing a work order while its invoice was being paid, or paying
--     two linked invoices at once, double-expensed / over-cleared AP: each
--     browser read the ledger, decided, then posted, with nothing in between;
--   * hard-deleting a work order after its accrual unlinked the invoice
--     (FK ON DELETE SET NULL), so paying it expensed the repair again;
--   * a voided accrual or close-out could never be re-posted;
--   * company A staff could attach a photo or an invoice to company B's work
--     order;
--   * tenants could not add photos to their own requests (no INSERT policy).
--
-- This migration:
--   1. moves read-decide-post into three RPCs that serialise on a
--      transaction-scoped advisory lock per work order (and per invoice), so
--      concurrent calls see each other's postings. They are SECURITY INVOKER:
--      staff RLS already allows everything they touch, and the caller is
--      additionally checked with _assert_company_staff. Nothing is granted to
--      anon.
--   2. makes vendor_invoices.work_order_id ON DELETE RESTRICT and refuses to
--      delete a work order that has a live WO-/WO-ADJ- entry (purge skips
--      such work orders instead of failing);
--   3. refuses to re-point a paid invoice at another work order;
--   4. requires an invoice's and a photo's work order to be in the same
--      company as the row;
--   5. adds a tenant INSERT policy for photos on the tenant's OWN work orders;
--   6. adds vendor_invoices.archived_at / archived_by: the property-archive
--      cascade already writes them (it failed silently without the column),
--      and an archived (withdrawn) invoice no longer blocks a close-out.
--
-- No existing journal entry is changed.

-- ── 6. archived invoices ───────────────────────────────────────────────────
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.vendor_invoices ADD COLUMN IF NOT EXISTS archived_by text;

-- ── 2. deleting a booked work order ────────────────────────────────────────
ALTER TABLE public.vendor_invoices DROP CONSTRAINT IF EXISTS vendor_invoices_work_order_id_fkey;
ALTER TABLE public.vendor_invoices
  ADD CONSTRAINT vendor_invoices_work_order_id_fkey
  FOREIGN KEY (work_order_id) REFERENCES public.work_orders(id)
  ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public._work_order_is_booked(p_company_id text, p_wo_id integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $$
  SELECT EXISTS (SELECT 1 FROM acct_journal_entries
                  WHERE company_id = p_company_id
                    AND reference IN ('WO-' || p_wo_id, 'WO-ADJ-' || p_wo_id)
                    AND status <> 'voided')
      OR EXISTS (SELECT 1 FROM vendor_invoices
                  WHERE company_id = p_company_id AND work_order_id = p_wo_id);
$$;

CREATE OR REPLACE FUNCTION public._guard_work_order_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF public._work_order_is_booked(OLD.company_id, OLD.id) THEN
    RAISE EXCEPTION 'Work order #% has accounting entries or vendor invoices and cannot be permanently deleted. Keep it archived.', OLD.id
      USING ERRCODE = '23503', HINT = 'work_order_booked';
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public._guard_work_order_delete() FROM PUBLIC, anon;
DROP TRIGGER IF EXISTS trg_guard_work_order_delete ON public.work_orders;
CREATE TRIGGER trg_guard_work_order_delete BEFORE DELETE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public._guard_work_order_delete();

-- The 180-day archive purge must skip booked work orders, not abort on them.
CREATE OR REPLACE FUNCTION public.purge_old_archives()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_cutoff TIMESTAMPTZ := NOW() - INTERVAL '180 days';
  v_total INT := 0;
  v_count INT;
BEGIN
  DELETE FROM work_orders w WHERE w.archived_at IS NOT NULL AND w.archived_at < v_cutoff
     AND NOT public._work_order_is_booked(w.company_id, w.id);
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM autopay_schedules WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM utilities WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM hoa_payments WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM documents WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM payments WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM leases WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  DELETE FROM tenants WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  -- Properties last (FK dependencies)
  DELETE FROM properties WHERE archived_at IS NOT NULL AND archived_at < v_cutoff;
  GET DIAGNOSTICS v_count = ROW_COUNT; v_total := v_total + v_count;
  RETURN jsonb_build_object('purged', v_total, 'cutoff', v_cutoff);
END;
$function$;

-- ── 3 + 4. same-company links, no re-pointing a paid invoice ───────────────
CREATE OR REPLACE FUNCTION public._guard_work_order_link()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF NEW.work_order_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id = NEW.work_order_id AND w.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'Work order #% does not belong to this company', NEW.work_order_id
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
DROP TRIGGER IF EXISTS trg_guard_work_order_link ON public.vendor_invoices;
CREATE TRIGGER trg_guard_work_order_link BEFORE INSERT OR UPDATE OF work_order_id, company_id ON public.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public._guard_work_order_link();
DROP TRIGGER IF EXISTS trg_guard_work_order_link ON public.work_order_photos;
CREATE TRIGGER trg_guard_work_order_link BEFORE INSERT OR UPDATE OF work_order_id, company_id ON public.work_order_photos
  FOR EACH ROW EXECUTE FUNCTION public._guard_work_order_link();

-- ── 5. tenants add photos to their own requests ────────────────────────────
DROP POLICY IF EXISTS wo_photos_tenant_insert ON public.work_order_photos;
CREATE POLICY wo_photos_tenant_insert ON public.work_order_photos
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM work_orders wo
                       WHERE wo.id = work_order_photos.work_order_id
                         AND wo.company_id = work_order_photos.company_id
                         AND wo.tenant_id IS NOT NULL
                         AND wo.tenant_id = get_tenant_id(wo.company_id)));

-- ── 1. atomic repair postings ──────────────────────────────────────────────
-- Account by bare code, resolved the way the client's resolveAccountId does:
-- exact code, then the standard name, then a "...-<code>" suffix; created if
-- missing.
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
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public._repair_class(p_company_id text, p_property text)
RETURNS text LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $$
  SELECT COALESCE(
    (SELECT p.class_id FROM properties p JOIN acct_classes c ON c.id = p.class_id AND c.company_id = p.company_id
      WHERE p.company_id = p_company_id AND p.address = p_property LIMIT 1),
    (SELECT id FROM acct_classes WHERE company_id = p_company_id AND name = p_property LIMIT 1));
$$;

-- Post a balanced entry. p_lines: [{code, name, debit, credit, memo}].
CREATE OR REPLACE FUNCTION public._repair_post(p_company_id text, p_date date, p_description text,
  p_reference text, p_property text, p_lines jsonb)
RETURNS text LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_je_id text; v_number text; v_attempt int := 0; v_constraint text; v_line jsonb;
  v_class text := public._repair_class(p_company_id, p_property);
  v_dr numeric; v_cr numeric;
BEGIN
  SELECT COALESCE(sum((l ->> 'debit')::numeric), 0), COALESCE(sum((l ->> 'credit')::numeric), 0)
    INTO v_dr, v_cr FROM jsonb_array_elements(p_lines) l;
  IF abs(v_dr - v_cr) > 0.005 OR v_dr <= 0 THEN
    RAISE EXCEPTION '_repair_post: entry out of balance (DR % vs CR %)', v_dr, v_cr;
  END IF;
  LOOP
    v_number := next_je_number(p_company_id);
    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status)
      VALUES (p_company_id, v_number, p_date, COALESCE(p_description, ''), p_reference, COALESCE(p_property, ''), 'posted')
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint <> 'unique_je_number_per_company' THEN RAISE; END IF;
      v_attempt := v_attempt + 1;
      IF v_attempt >= 5 THEN RAISE EXCEPTION '_repair_post: could not allocate a JE number'; END IF;
    END;
  END LOOP;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    CONTINUE WHEN COALESCE((v_line ->> 'debit')::numeric, 0) = 0 AND COALESCE((v_line ->> 'credit')::numeric, 0) = 0;
    INSERT INTO acct_journal_lines (journal_entry_id, company_id, account_id, account_name, debit, credit, class_id, memo)
    VALUES (v_je_id, p_company_id, public._repair_account(p_company_id, v_line ->> 'code'), COALESCE(v_line ->> 'name', ''),
            COALESCE((v_line ->> 'debit')::numeric, 0), COALESCE((v_line ->> 'credit')::numeric, 0), v_class, COALESCE(v_line ->> 'memo', ''));
  END LOOP;
  RETURN v_je_id;
END $$;

-- Live ledger facts for a work order (voided entries count as absent).
--   accrued   AP credit on WO-<id>
--   applied   AP debits from linked VPAY-s (except p_exclude) + WO-ADJ-<id>
--   expensed  Repairs debits from linked VPAY-s
--   statuses  statuses of the linked, NOT archived invoices
CREATE OR REPLACE FUNCTION public._repair_facts(p_company_id text, p_wo_id integer, p_exclude uuid,
  OUT accrued numeric, OUT applied numeric, OUT expensed numeric, OUT statuses text[])
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_ap uuid := public._repair_account(p_company_id, '2110');
  v_rep uuid := public._repair_account(p_company_id, '5300');
BEGIN
  SELECT COALESCE(sum(l.credit) FILTER (WHERE e.reference = 'WO-' || p_wo_id AND l.account_id = v_ap), 0),
         COALESCE(sum(l.debit) FILTER (WHERE e.reference <> 'WO-' || p_wo_id
                                         AND e.reference IS DISTINCT FROM 'VPAY-' || p_exclude
                                         AND l.account_id = v_ap), 0),
         COALESCE(sum(l.debit) FILTER (WHERE e.reference LIKE 'VPAY-%' AND l.account_id = v_rep), 0)
    INTO accrued, applied, expensed
    FROM acct_journal_entries e JOIN acct_journal_lines l ON l.journal_entry_id = e.id
   WHERE e.company_id = p_company_id AND e.status <> 'voided'
     AND (e.reference IN ('WO-' || p_wo_id, 'WO-ADJ-' || p_wo_id)
          OR e.reference IN (SELECT 'VPAY-' || i.id FROM vendor_invoices i
                              WHERE i.company_id = p_company_id AND i.work_order_id = p_wo_id));
  -- An invoice marked paid whose VPAY- entry was voided (and not re-posted)
  -- is not paid as far as the books are concerned: it holds the close-out.
  SELECT COALESCE(array_agg(CASE
           WHEN i.status = 'paid'
            AND EXISTS (SELECT 1 FROM acct_journal_entries x WHERE x.company_id = p_company_id AND x.reference = 'VPAY-' || i.id)
            AND NOT EXISTS (SELECT 1 FROM acct_journal_entries x WHERE x.company_id = p_company_id AND x.reference = 'VPAY-' || i.id AND x.status <> 'voided')
           THEN 'payment_voided' ELSE i.status END), '{}')
    INTO statuses FROM vendor_invoices i
   WHERE i.company_id = p_company_id AND i.work_order_id = p_wo_id AND i.archived_at IS NULL;
END $$;

-- Close-out, caller holds the work-order lock.
CREATE OR REPLACE FUNCTION public._repair_close_out(p_company_id text, p_wo_id integer, p_date date)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_wo work_orders%ROWTYPE; f record; v_rev numeric; v_je text; v_memo text;
BEGIN
  SELECT * INTO v_wo FROM work_orders WHERE company_id = p_company_id AND id = p_wo_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('reason', 'no_work_order', 'reversed', 0); END IF;
  IF EXISTS (SELECT 1 FROM acct_journal_entries WHERE company_id = p_company_id
              AND reference = 'WO-ADJ-' || p_wo_id AND status <> 'voided') THEN
    RETURN jsonb_build_object('reason', 'already_posted', 'reversed', 0);
  END IF;
  IF v_wo.status IS DISTINCT FROM 'completed' THEN RETURN jsonb_build_object('reason', 'work_order_open', 'reversed', 0); END IF;
  SELECT * INTO f FROM public._repair_facts(p_company_id, p_wo_id, NULL);
  IF cardinality(f.statuses) = 0 THEN RETURN jsonb_build_object('reason', 'no_linked_invoice', 'reversed', 0); END IF;
  IF EXISTS (SELECT 1 FROM unnest(f.statuses) s WHERE s IS DISTINCT FROM 'paid') THEN
    RETURN jsonb_build_object('reason', 'invoices_unpaid', 'reversed', 0);
  END IF;
  v_rev := round(greatest(0, f.accrued - f.applied), 2);
  IF v_rev <= 0 THEN RETURN jsonb_build_object('reason', 'fully_used', 'reversed', 0); END IF;
  v_memo := 'Unused accrual reversed — work order #' || p_wo_id || ': ' || COALESCE(v_wo.issue, '');
  v_je := public._repair_post(p_company_id, p_date, 'Work order #' || p_wo_id || ' closed under budget — ' || COALESCE(v_wo.property, ''),
    'WO-ADJ-' || p_wo_id, v_wo.property, jsonb_build_array(
      jsonb_build_object('code', '2110', 'name', 'Accounts Payable', 'debit', v_rev, 'credit', 0, 'memo', v_memo),
      jsonb_build_object('code', '5300', 'name', 'Repairs & Maintenance', 'debit', 0, 'credit', v_rev, 'memo', v_memo)));
  RETURN jsonb_build_object('reason', 'reverse_unused_accrual', 'reversed', v_rev, 'je_id', v_je);
END $$;

CREATE OR REPLACE FUNCTION public._repair_lock_wo(p_company_id text, p_wo_id integer)
RETURNS void LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtext(p_company_id || ':WO:' || p_wo_id)); $$;

-- Work order completed (status button or edit form). Accrues once, then
-- closes out if every linked invoice is already paid.
CREATE OR REPLACE FUNCTION public.repair_complete_work_order(p_company_id text, p_wo_id integer, p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_wo work_orders%ROWTYPE; f record; v_accrue numeric; v_je text; v_reason text; v_co jsonb;
BEGIN
  PERFORM public._assert_company_staff(p_company_id);
  PERFORM public._repair_lock_wo(p_company_id, p_wo_id);
  SELECT * INTO v_wo FROM work_orders WHERE company_id = p_company_id AND id = p_wo_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('reason', 'no_work_order', 'accrued', 0); END IF;
  IF COALESCE(v_wo.cost, 0) <= 0 THEN
    v_reason := 'no_cost';
  ELSIF EXISTS (SELECT 1 FROM acct_journal_entries WHERE company_id = p_company_id
                 AND reference = 'WO-' || p_wo_id AND status <> 'voided') THEN
    v_reason := 'already_posted';
  ELSE
    SELECT * INTO f FROM public._repair_facts(p_company_id, p_wo_id, NULL);
    v_accrue := round(greatest(0, v_wo.cost - f.expensed), 2);
    IF v_accrue <= 0 THEN
      v_reason := 'already_expensed_by_invoice';
    ELSE
      v_je := public._repair_post(p_company_id, p_date, 'Maintenance: ' || COALESCE(v_wo.issue, '') || ' — ' || COALESCE(v_wo.property, ''),
        'WO-' || p_wo_id, v_wo.property, jsonb_build_array(
          jsonb_build_object('code', '5300', 'name', 'Repairs & Maintenance', 'debit', v_accrue, 'credit', 0,
                             'memo', COALESCE(v_wo.issue, '') || ' — ' || COALESCE(NULLIF(v_wo.assigned, ''), 'unassigned')),
          jsonb_build_object('code', '2110', 'name', 'Accounts Payable', 'debit', 0, 'credit', v_accrue,
                             'memo', 'AP owed for: ' || COALESCE(v_wo.issue, ''))));
      v_reason := CASE WHEN v_accrue < v_wo.cost THEN 'partly_expensed_by_invoice' ELSE 'accrue' END;
    END IF;
  END IF;
  v_co := public._repair_close_out(p_company_id, p_wo_id, p_date);
  RETURN jsonb_build_object('reason', v_reason, 'accrued', COALESCE(CASE WHEN v_je IS NOT NULL THEN v_accrue END, 0),
                            'je_id', v_je, 'closeout', v_co);
END $$;

-- Vendor invoice paid: post VPAY-<id> (clearing the linked work order's
-- unused accrual first), mark the invoice paid, count it in the vendor's
-- totals, then close out the work order -- one transaction.
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

CREATE OR REPLACE FUNCTION public.repair_close_out_work_order(p_company_id text, p_wo_id integer, p_date date DEFAULT CURRENT_DATE)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  PERFORM public._assert_company_staff(p_company_id);
  PERFORM public._repair_lock_wo(p_company_id, p_wo_id);
  RETURN public._repair_close_out(p_company_id, p_wo_id, p_date);
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._work_order_is_booked(text, integer)', 'public._repair_account(text, text)',
    'public._repair_class(text, text)', 'public._repair_post(text, date, text, text, text, jsonb)',
    'public._repair_facts(text, integer, uuid)', 'public._repair_close_out(text, integer, date)',
    'public._repair_lock_wo(text, integer)', 'public.repair_complete_work_order(text, integer, date)',
    'public.repair_pay_invoice(text, uuid, date)', 'public.repair_close_out_work_order(text, integer, date)'] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION ' || f || ' FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || f || ' TO authenticated, service_role';
  END LOOP;
END $$;
