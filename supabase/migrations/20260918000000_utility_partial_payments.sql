-- Paying LESS than the amount due.
--
-- THE TRADE-OFF, STATED PLAINLY
--
-- idx_utility_payments_one_live_per_bill permitted exactly one live payment
-- per bill. That makes a partial payment a dead end: pay $10 of $27.66 and
-- the remaining $17.66 can never be paid through the app. Supporting
-- partials therefore means removing that guard, which is not a thing to do
-- quietly on a path that moves money.
--
-- It is replaced by a stronger rule, enforced in SQL inside
-- claim_utility_payment: the TOTAL of a bill's live payments may never
-- exceed the bill. That bounds the money rather than the row count, which is
-- the thing actually worth bounding, and it permits the legitimate case the
-- index forbade.
--
-- 'unknown' counts at its full approved value, so a payment nobody could
-- confirm still blocks every attempt after it.
--
-- Verified on the test database before being written here:
--   $10 on a $27.66 bill                -> ok
--   another $10                          -> ok   (impossible under the index)
--   a third $10                          -> refused, "total would exceed the
--                                           bill: 20 already, 10 requested,
--                                           bill is 27.66"
--   $1 after an unconfirmed $27.66       -> refused
--   a 'tenant' bill on an 'owner' account-> cancelled, unchanged
DROP INDEX IF EXISTS idx_utility_payments_one_live_per_bill;

CREATE INDEX IF NOT EXISTS idx_utility_payments_bill
  ON public.utility_payments (company_id, bill_id)
  WHERE bill_id IS NOT NULL;

ALTER TABLE public.utility_bills
  ADD COLUMN IF NOT EXISTS amount_paid numeric;

ALTER TABLE public.utility_payments DROP CONSTRAINT IF EXISTS utility_payments_status_known;
ALTER TABLE public.utility_payments ADD CONSTRAINT utility_payments_status_known
  CHECK (status = ANY (ARRAY[
    'pending_approval','approved','submitting','paid','partial','failed','unknown','cancelled'
  ]));

CREATE OR REPLACE FUNCTION public.claim_utility_payment(p_company_id text, p_id uuid, p_worker text)
RETURNS TABLE(ok boolean, reason text, payment_id uuid, amount numeric, provider text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pay        public.utility_payments%ROWTYPE;
  v_set        public.utility_payment_settings%ROWTYPE;
  v_today      numeric;
  v_resp       text;
  v_bill_total numeric;
  v_already    numeric;
BEGIN
  SELECT * INTO v_set FROM public.utility_payment_settings WHERE company_id = p_company_id;
  IF NOT FOUND OR NOT v_set.enabled THEN
    RETURN QUERY SELECT false, 'payment is not enabled for this company', NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  SELECT * INTO v_pay FROM public.utility_payments
    WHERE id = p_id AND company_id = p_company_id
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'no such payment, or another runner holds it', NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  IF v_pay.status <> 'approved' THEN
    RETURN QUERY SELECT false, format('payment is %s, not approved', v_pay.status), NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;
  IF v_set.require_per_payment_approval AND v_pay.approved_by IS NULL THEN
    RETURN QUERY SELECT false, 'no person approved this payment', NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  IF v_pay.bill_id IS NOT NULL THEN
    SELECT COALESCE(b.responsibility, a.responsibility), b.amount
      INTO v_resp, v_bill_total
      FROM public.utility_bills b
      LEFT JOIN public.utility_accounts a ON a.id = b.utility_account_id
     WHERE b.id = v_pay.bill_id AND b.company_id = p_company_id;

    IF v_resp = 'tenant' THEN
      UPDATE public.utility_payments
         SET status = 'cancelled',
             error  = 'the tenant is responsible for this utility — it is not ours to pay'
       WHERE id = v_pay.id;
      RETURN QUERY SELECT false, 'the tenant is responsible for this utility', NULL::uuid, NULL::numeric, NULL::text; RETURN;
    END IF;

    SELECT COALESCE(sum(approved_amount), 0) INTO v_already
      FROM public.utility_payments
     WHERE company_id = p_company_id
       AND bill_id = v_pay.bill_id
       AND id <> v_pay.id
       AND status IN ('submitting','paid','unknown','partial');

    IF v_bill_total IS NOT NULL AND v_bill_total > 0
       AND v_already + v_pay.approved_amount > v_bill_total + 0.005 THEN
      UPDATE public.utility_payments
         SET status = 'cancelled',
             error  = format('would pay %s of a %s bill that already has %s against it',
                             v_pay.approved_amount, v_bill_total, v_already)
       WHERE id = v_pay.id;
      RETURN QUERY SELECT false,
        format('total would exceed the bill: %s already, %s requested, bill is %s',
               v_already, v_pay.approved_amount, v_bill_total),
        NULL::uuid, NULL::numeric, NULL::text; RETURN;
    END IF;
  END IF;

  IF v_pay.approved_amount > v_set.max_payment_amount THEN
    RETURN QUERY SELECT false, format('%s is over the per-payment cap of %s', v_pay.approved_amount, v_set.max_payment_amount), NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  SELECT COALESCE(sum(approved_amount), 0) INTO v_today
    FROM public.utility_payments
   WHERE company_id = p_company_id
     AND status IN ('submitting','paid','unknown','partial')
     AND submitted_at >= date_trunc('day', now());
  IF v_today + v_pay.approved_amount > v_set.max_daily_total THEN
    RETURN QUERY SELECT false, format('would exceed the daily cap of %s (already %s)', v_set.max_daily_total, v_today), NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  UPDATE public.utility_payments
     SET status = 'submitting', submitted_at = now(), error = NULL
   WHERE id = v_pay.id;

  RETURN QUERY SELECT true, 'ok', v_pay.id, v_pay.approved_amount, v_pay.provider;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_utility_payment(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_utility_payment(text, uuid, text) TO service_role;
