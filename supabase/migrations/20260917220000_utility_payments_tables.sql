-- The utility payment tables, which the repo never held.
--
-- utility_payments, utility_payment_settings and claim_utility_payment were
-- created directly against the TEST project and no migration recorded them.
-- So production had utility_bills and utility_accounts but none of the
-- payment machinery, and applying the end-to-end migration there failed with
-- 'relation "public.utility_payments" does not exist'. This is that DDL,
-- reproduced from the live test schema so the repo and production finally
-- agree.
--
-- Nothing here enables anything: utility_payment_settings.enabled defaults
-- to false and no row is inserted, so claim_utility_payment refuses every
-- payment for every company until a person turns it on deliberately.

-- ---------------------------------------------------------------------------
-- WHAT MAY BE PAID, AND HOW MUCH
CREATE TABLE IF NOT EXISTS public.utility_payment_settings (
  company_id                   text PRIMARY KEY,
  -- The kill switch. False means no payment can be claimed at all.
  enabled                      boolean NOT NULL DEFAULT false,
  max_payment_amount           numeric NOT NULL DEFAULT 500,
  max_daily_total              numeric NOT NULL DEFAULT 2000,
  require_per_payment_approval boolean NOT NULL DEFAULT true,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   text
);

-- ---------------------------------------------------------------------------
-- ONE ROW PER PAYMENT, WRITTEN BEFORE THE BROWSER OPENS
--
-- The record exists before anything is clicked, so if the worker dies
-- mid-payment the evidence that a payment was in flight already exists.
CREATE TABLE IF NOT EXISTS public.utility_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           text NOT NULL,
  utility_id           text,
  provider             text NOT NULL,
  approved_amount      numeric NOT NULL CHECK (approved_amount > 0),
  approved_at          timestamptz,
  approved_by          text,
  observed_amount      numeric,
  due_date             date,
  statement_ref        text,
  -- provider:account:statement:amount. Next month's identical amount is a
  -- DIFFERENT payment; a retry of this one is the SAME payment and is refused.
  idem_key             text NOT NULL,
  status               text NOT NULL DEFAULT 'pending_approval',
  confirmation_ref     text,
  screenshot_path      text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  submitted_at         timestamptz,
  settled_at           timestamptz,
  -- No FK: utility_bill_runs does not exist in production. The column is kept
  -- so the two schemas hold the same shape, and the constraint is not
  -- invented here just to match a table that isn't there.
  run_id               uuid,
  -- Added by the end-to-end wiring: what the app needs to close the loop.
  bill_id              integer REFERENCES public.utility_bills(id) ON DELETE SET NULL,
  bank_account_id      uuid REFERENCES public.acct_accounts(id) ON DELETE SET NULL,
  property             text,
  receipt_storage_path text,
  requested_by         text,
  CONSTRAINT utility_payments_status_known CHECK (status = ANY (ARRAY[
    'pending_approval','approved','submitting','paid','failed','unknown','cancelled'
  ]))
);

-- The double-payment guards. Both, because they catch different mistakes:
-- idem stops the same STATEMENT being paid twice even across a re-import that
-- renumbers bills; one_live_per_bill stops the same BILL ROW being paid twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_utility_payments_idem
  ON public.utility_payments (company_id, idem_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_utility_payments_one_live_per_bill
  ON public.utility_payments (company_id, bill_id)
  WHERE bill_id IS NOT NULL
    AND status = ANY (ARRAY['pending_approval','approved','submitting','paid','unknown']);

CREATE INDEX IF NOT EXISTS idx_utility_payments_company_status
  ON public.utility_payments (company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_utility_payments_queue
  ON public.utility_payments (company_id, status, approved_at)
  WHERE status = 'approved';

ALTER TABLE public.utility_payments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.utility_payment_settings  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS utility_payments_staff ON public.utility_payments;
CREATE POLICY utility_payments_staff ON public.utility_payments
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()))
  WITH CHECK (company_id IN (SELECT get_user_company_ids()));

DROP POLICY IF EXISTS utility_payment_settings_staff ON public.utility_payment_settings;
CREATE POLICY utility_payment_settings_staff ON public.utility_payment_settings
  FOR ALL USING (company_id IN (SELECT get_user_company_ids()))
  WITH CHECK (company_id IN (SELECT get_user_company_ids()));

-- Without these PostgREST reads nothing at all. Deliberately no DELETE for
-- authenticated: a payment record is evidence and staff do not erase it.
GRANT SELECT, INSERT, UPDATE ON public.utility_payments         TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.utility_payment_settings TO authenticated;
GRANT ALL ON public.utility_payments         TO service_role;
GRANT ALL ON public.utility_payment_settings TO service_role;

-- ---------------------------------------------------------------------------
-- THE CLAIM
--
-- Checks the kill switch, the per-payment cap and the daily cap IN SQL, and
-- flips the row to 'submitting' inside the same transaction that selected it.
-- Application logic cannot be trusted with this: two runners racing is
-- exactly when application logic loses.
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

  -- Only an approved payment may run. 'unknown' especially: retrying a
  -- payment whose outcome nobody knows is how one becomes two.
  IF v_pay.status <> 'approved' THEN
    RETURN QUERY SELECT false, format('payment is %s, not approved', v_pay.status), NULL::uuid, NULL::numeric, NULL::text; RETURN;
  END IF;
  IF v_set.require_per_payment_approval AND v_pay.approved_by IS NULL THEN
    RETURN QUERY SELECT false, 'no person approved this payment', NULL::uuid, NULL::numeric, NULL::text; RETURN;
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

  -- Mark BEFORE returning. The caller is about to click Pay.
  UPDATE public.utility_payments
     SET status = 'submitting', submitted_at = now(), error = NULL
   WHERE id = v_pay.id;

  RETURN QUERY SELECT true, 'ok', v_pay.id, v_pay.approved_amount, v_pay.provider;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_utility_payment(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_utility_payment(text, uuid, text) TO service_role;
