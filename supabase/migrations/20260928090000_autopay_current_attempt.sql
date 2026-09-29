-- Autopay: remember each schedule's CURRENT charge attempt and the last
-- period that was actually paid.
--
-- Why (QA re-test 2026-09-28, scenario B7): a period is claimed by moving
-- next_charge_date forward; an async payment_intent.payment_failed gives it
-- back (next_charge_date -> claimed date) when next_charge_date still equals
-- the advanced date. Every attempt in the same period shares that advanced
-- date, so a LATE failure webhook of an EARLIER attempt (day-0 decline,
-- delivered after the day-1 retry succeeded) reopened a paid period and the
-- next run charged it again.
--
-- api/stripe.js now:
--   * clears last_payment_intent_id when it claims a period, and sets it to
--     the PaymentIntent it creates (or the one Stripe returns on a decline);
--   * sets last_paid_period (YYYY-MM, only ever forward) when a charge for a
--     period succeeds (synchronously, or via payment_intent.succeeded);
--   * releases a claim on payment_intent.payment_failed only when the failing
--     PaymentIntent IS last_payment_intent_id and the period is not paid.
-- Rows charged before this migration have both columns NULL, so an old
-- failure event never releases anything (it still stamps last_error).
--
-- Plain nullable columns: no backfill, no behaviour change for the app.

ALTER TABLE public.autopay_schedules
  ADD COLUMN IF NOT EXISTS last_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS last_paid_period text;

ALTER TABLE public.autopay_schedules
  DROP CONSTRAINT IF EXISTS autopay_schedules_last_paid_period_format;
ALTER TABLE public.autopay_schedules
  ADD CONSTRAINT autopay_schedules_last_paid_period_format
  CHECK (last_paid_period IS NULL OR last_paid_period ~ '^\d{4}-\d{2}$');

COMMENT ON COLUMN public.autopay_schedules.last_payment_intent_id IS
  'Stripe PaymentIntent of the current charge attempt; only its own async failure may release the claimed period.';
COMMENT ON COLUMN public.autopay_schedules.last_paid_period IS
  'Last billing period (YYYY-MM) a Stripe autopay charge succeeded for; a late failure never reopens it.';

-- ════════════════════════════════════════════════════════════════════════
-- payments.status for Stripe refunds / disputes: derived under the lock.
--
-- QA re-test N2 / A15: the webhook set payments.status itself AFTER the
-- reversal RPC returned, from the one event it was handling. Two events for
-- the same payment (dispute created + won, delivered together) could finish
-- in either order, leaving "disputed" on a payment whose dispute was won; a
-- dispute on a fully refunded payment set "disputed" although nothing was
-- reversed; a won dispute on a partially refunded payment set "paid".
--
-- Now stripe_post_reversal derives the status from the BOOKS, inside the same
-- per-payment advisory lock, after every call (posted, idempotent or skipped),
-- so the last writer always writes the state of the ledger, not of its event:
--
--   dispute_lost        a posted dispute reversal whose dispute closed lost
--   disputed            a posted dispute reversal not yet won or lost
--   refunded            refund reversals >= booked rent, or Stripe said the
--                       charge is fully refunded (sticky once written)
--   partially_refunded  some refund reversal (sticky once written)
--   paid                otherwise (incl. a dispute that was won)
--
-- Precedence is top to bottom. A dispute that reversed nothing (the payment
-- was already fully refunded) does not count, so the status stays refunded.
-- src/utils/paymentRules.js derivePaymentStatus mirrors this rule.
--
-- The previous stripe_post_reversal is kept, renamed, as the posting core.
-- ════════════════════════════════════════════════════════════════════════

ALTER FUNCTION public.stripe_post_reversal(text, text, text, text, text, bigint, text, text, text, text, date)
  RENAME TO _stripe_post_reversal_core;
REVOKE ALL ON FUNCTION public._stripe_post_reversal_core(text, text, text, text, text, bigint, text, text, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._stripe_post_reversal_core(text, text, text, text, text, bigint, text, text, text, text, date) TO service_role;

CREATE OR REPLACE FUNCTION public._stripe_sync_payment_status(
  p_company_id text, p_payment_intent_id text, p_charge_id text, p_dispute_id text, p_refund_full boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_orig_id     text;
  v_booked      bigint;
  v_refunded    bigint := 0;
  v_open        int := 0;
  v_lost        int := 0;
  v_cur         text;
  v_status      text;
  v_charge_like text;
  v_d           record;
BEGIN
  SELECT id INTO v_orig_id FROM acct_journal_entries
   WHERE company_id = p_company_id AND reference = 'STRIPE-' || p_payment_intent_id AND status <> 'voided'
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT round(coalesce(sum(debit), 0) * 100)::bigint INTO v_booked FROM acct_journal_lines WHERE journal_entry_id = v_orig_id;

  v_charge_like := replace(replace(replace(coalesce(p_charge_id, ''), '\', '\\'), '%', '\%'), '_', '\_');
  -- The reversal pool, as the core computes it: posted refund / dispute
  -- entries of this payment (stamped), plus legacy unstamped refunds of the
  -- charge and entries of this dispute.
  FOR v_d IN
    WITH pool AS (
      SELECT e.id, e.reference, round(coalesce(sum(l.debit), 0) * 100)::bigint AS cents
        FROM acct_journal_entries e JOIN acct_journal_lines l ON l.journal_entry_id = e.id
       WHERE e.company_id = p_company_id AND e.status = 'posted'
         AND (
           (e.stripe_payment_intent_id = p_payment_intent_id
              AND (e.reference LIKE 'STRIPE-REFUND-%' OR e.reference LIKE 'STRIPE-DISPUTE-%'))
           OR (v_charge_like <> '' AND e.reference LIKE 'STRIPE-REFUND-' || v_charge_like || '-%')
           OR (coalesce(p_dispute_id, '') <> '' AND e.reference IN ('STRIPE-DISPUTE-' || p_dispute_id, 'STRIPE-DISPUTE-WON-' || p_dispute_id))
         )
       GROUP BY e.id, e.reference
    )
    SELECT reference, cents,
           CASE WHEN reference LIKE 'STRIPE-DISPUTE-%' AND reference NOT LIKE 'STRIPE-DISPUTE-WON-%'
                THEN substring(reference FROM '^STRIPE-DISPUTE-(.*)$') END AS dispute_id
      FROM pool
  LOOP
    IF v_d.reference LIKE 'STRIPE-REFUND-%' THEN
      v_refunded := v_refunded + v_d.cents;
      CONTINUE;
    END IF;
    IF v_d.dispute_id IS NULL OR v_d.cents <= 0 THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM acct_journal_entries
                WHERE company_id = p_company_id AND status = 'posted'
                  AND reference = 'STRIPE-DISPUTE-WON-' || v_d.dispute_id) THEN
      CONTINUE;  -- won: funds returned
    ELSIF EXISTS (SELECT 1 FROM stripe_dispute_outcomes WHERE dispute_id = v_d.dispute_id AND status = 'lost') THEN
      v_lost := v_lost + 1;
    ELSE
      v_open := v_open + 1;
    END IF;
  END LOOP;

  SELECT status INTO v_cur FROM payments
   WHERE company_id = p_company_id AND stripe_session_id = p_payment_intent_id
   ORDER BY id LIMIT 1;

  v_status := CASE
    WHEN v_lost > 0 THEN 'dispute_lost'
    WHEN v_open > 0 THEN 'disputed'
    WHEN (v_booked > 0 AND v_refunded >= v_booked) OR coalesce(p_refund_full, false) OR v_cur = 'refunded' THEN 'refunded'
    WHEN v_refunded > 0 OR v_cur = 'partially_refunded' THEN 'partially_refunded'
    ELSE 'paid'
  END;

  UPDATE payments SET status = v_status
   WHERE company_id = p_company_id AND stripe_session_id = p_payment_intent_id
     AND status IS DISTINCT FROM v_status;
  RETURN v_status;
END;
$function$;

REVOKE ALL ON FUNCTION public._stripe_sync_payment_status(text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._stripe_sync_payment_status(text, text, text, text, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.stripe_post_reversal(
  p_company_id        text,
  p_payment_intent_id text,
  p_charge_id         text,
  p_kind              text,
  p_reference         text,
  p_amount_cents      bigint,
  p_description       text,
  p_memo              text,
  p_dispute_id        text DEFAULT NULL,
  p_dispute_status    text DEFAULT NULL,
  p_date              date DEFAULT NULL,
  p_refund_full       boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_res    jsonb;
  v_status text;
BEGIN
  IF coalesce(p_payment_intent_id, '') = '' THEN
    RAISE EXCEPTION 'stripe_post_reversal: payment intent required';
  END IF;
  -- Same lock order as the core (payment, then charge); advisory xact locks
  -- are re-entrant for the session, so the core re-taking them is harmless.
  PERFORM pg_advisory_xact_lock(hashtext('stripe:' || p_payment_intent_id));
  IF coalesce(p_charge_id, '') <> '' AND p_charge_id <> p_payment_intent_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('stripe:' || p_charge_id));
  END IF;
  v_res := public._stripe_post_reversal_core(p_company_id, p_payment_intent_id, p_charge_id, p_kind, p_reference,
                                             p_amount_cents, p_description, p_memo, p_dispute_id, p_dispute_status, p_date);
  IF v_res ? 'error' THEN RETURN v_res; END IF;
  v_status := public._stripe_sync_payment_status(p_company_id, p_payment_intent_id, p_charge_id, p_dispute_id, p_refund_full);
  RETURN v_res || jsonb_build_object('payment_status', v_status);
END;
$function$;

REVOKE ALL ON FUNCTION public.stripe_post_reversal(text, text, text, text, text, bigint, text, text, text, text, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_post_reversal(text, text, text, text, text, bigint, text, text, text, text, date, boolean) TO service_role;
