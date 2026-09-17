-- Never release a payment for a utility the TENANT is responsible for.
--
-- A tenant-responsibility bill is the tenant's to pay. Paying it on their
-- behalf spends the owner's money on someone else's debt, and it is the kind
-- of mistake that is invisible until a statement is reconciled months later.
--
-- Put in claim_utility_payment rather than only in the app, because the app
-- is one of four ways a row could reach this table and the only place that
-- cannot be bypassed is here. The button is hidden too, and the worker
-- refuses as well -- three layers, of which this is the one that holds.
CREATE OR REPLACE FUNCTION public.claim_utility_payment(p_company_id text, p_id uuid, p_worker text)
RETURNS TABLE(ok boolean, reason text, payment_id uuid, amount numeric, provider text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pay     public.utility_payments%ROWTYPE;
  v_set     public.utility_payment_settings%ROWTYPE;
  v_today   numeric;
  v_resp    text;
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

  -- THE TENANT'S BILL IS NOT OURS TO PAY.
  --
  -- Checked on the bill first and the account second, because responsibility
  -- can be set per statement -- a bill that says 'tenant' overrides an
  -- account that says 'owner'. A bill whose responsibility is NULL falls back
  -- to its account; if neither says, it is treated as the owner's, which is
  -- the existing default everywhere else in the app.
  IF v_pay.bill_id IS NOT NULL THEN
    SELECT COALESCE(b.responsibility, a.responsibility) INTO v_resp
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
  END IF;

  IF v_pay.approved_amount > v_set.max_payment_amount THEN
    RETURN QUERY SELECT false, format('%s is over the per-payment cap of %s', v_pay.approved_amount, v_set.max_payment_amount), NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;

  SELECT COALESCE(sum(approved_amount), 0) INTO v_today
    FROM public.utility_payments
   WHERE company_id = p_company_id
     AND status IN ('submitting','paid','unknown')
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
