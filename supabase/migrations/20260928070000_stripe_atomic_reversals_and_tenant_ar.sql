-- Stripe webhook: atomic refund / dispute reversals, and a locked tenant-AR
-- lookup for receipts. Server-only (api/stripe.js calls these with the
-- service key); nothing here is callable by anon or authenticated.
--
-- Why (QA against TEST, Stripe stubbed, 2026-09-28):
--  * Two charge.refunded events delivered at the same time both read "already
--    reversed = 0" and each posted its own reversal: cumulative 300 and 600
--    reversed 900 instead of 600.
--  * A partial refund followed by a dispute on the remainder reversed
--    300 + 731.21 of a 1,000 rent -- more than was ever booked.
--  * charge.dispute.closed (won) delivered before charge.dispute.created found
--    nothing to re-post, then .created reversed the payment for good.
--  * Two first payments racing to create a tenant's AR account: the loser got
--    no account and the receipt was credited to Rental Income.
--
-- 1. stripe_dispute_outcomes: a durable marker per dispute recording how it
--    closed. The least invasive way to remember "won" when there is nothing
--    to re-post yet (a zero-line journal entry would be a real, if empty,
--    entry in the books). .created consults it and skips a won dispute.
-- 2. stripe_post_reversal(): every refund / dispute reversal and every
--    dispute-won re-post, under a per-payment (and per-charge) advisory lock.
--    It computes what is already reversed from POSTED STRIPE-REFUND- /
--    STRIPE-DISPUTE- entries (net of STRIPE-DISPUTE-WON- re-posts), caps the
--    new reversal at booked rent - already reversed, and posts the entry the
--    webhook used to post itself: same lines (the original's, sides swapped,
--    scaled; the last line per side absorbs rounding), same class_id, New York
--    business date, next_je_number with number-collision retry, idempotent by
--    reference. It additionally stamps stripe_payment_intent_id on the
--    reversal header so a dispute (keyed by dispute id) and a refund (keyed
--    by charge id) of the same payment are counted against one another.
-- 3. stripe_tenant_ar(): the tenant's own AR account for a Stripe receipt,
--    via the existing _late_fee_tenant_ar helper (find / adopt / create with
--    retry) under a per-tenant advisory lock. NULL only when the tenant row
--    does not exist; if the tenant exists and no account can be established
--    it RAISES, so the webhook returns 500 and Stripe retries -- a receipt
--    for an existing tenant never falls back to Rental Income.

-- ── 1. dispute outcome marker ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stripe_dispute_outcomes (
  dispute_id        text PRIMARY KEY,
  company_id        text NOT NULL REFERENCES public.companies(id) ON UPDATE CASCADE ON DELETE CASCADE,
  payment_intent_id text,
  status            text NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stripe_dispute_outcomes_company ON public.stripe_dispute_outcomes (company_id);
ALTER TABLE public.stripe_dispute_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_dispute_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_dispute_outcomes TO service_role;

-- ── 2. atomic reversal ──────────────────────────────────────────────────
-- p_kind:
--   'refund'      p_amount_cents = the charge's CUMULATIVE amount_refunded
--   'dispute'     p_amount_cents = the dispute amount (gross); p_dispute_id set
--   'dispute_won' re-post the STRIPE-DISPUTE-<p_dispute_id> reversal (if any);
--                 always records the 'won' marker
-- Returns jsonb: { id } posted | { idempotent: true } | { skipped: reason }
--   | { error: reason }, plus booked_cents / already_cents / amount_cents.
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
  p_date              date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_orig        record;
  v_src_id      text;
  v_booked      bigint;
  v_already     bigint;
  v_refunded    bigint;
  v_req         bigint;
  v_amt         bigint;
  v_src_total   bigint;
  v_want        bigint;
  v_existing    text;
  v_je_id       text;
  v_num         text;
  v_con         text;
  v_date        date;
  v_nd int; v_nc int; v_kd int := 0; v_kc int := 0;
  v_used_d bigint := 0; v_used_c bigint := 0; v_c bigint;
  v_line        record;
  v_charge_like text;
BEGIN
  IF p_kind NOT IN ('refund', 'dispute', 'dispute_won') THEN
    RAISE EXCEPTION 'stripe_post_reversal: unknown kind %', p_kind;
  END IF;
  IF coalesce(p_company_id, '') = '' OR coalesce(p_payment_intent_id, '') = '' OR coalesce(p_reference, '') = '' THEN
    RAISE EXCEPTION 'stripe_post_reversal: company, payment intent and reference are required';
  END IF;
  IF p_kind IN ('dispute', 'dispute_won') AND coalesce(p_dispute_id, '') = '' THEN
    RAISE EXCEPTION 'stripe_post_reversal: dispute id required for %', p_kind;
  END IF;

  -- Serialise every reversal of this payment. Payment first, then charge:
  -- one fixed order, so two callers can never deadlock on the pair.
  PERFORM pg_advisory_xact_lock(hashtext('stripe:' || p_payment_intent_id));
  IF coalesce(p_charge_id, '') <> '' AND p_charge_id <> p_payment_intent_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('stripe:' || p_charge_id));
  END IF;

  -- Dispute outcome marker (durable even when nothing is posted).
  IF p_kind = 'dispute_won' OR (p_kind = 'dispute' AND p_dispute_status IN ('won', 'lost')) THEN
    INSERT INTO stripe_dispute_outcomes (dispute_id, company_id, payment_intent_id, status)
    VALUES (p_dispute_id, p_company_id, p_payment_intent_id, CASE WHEN p_kind = 'dispute_won' THEN 'won' ELSE p_dispute_status END)
    ON CONFLICT (dispute_id) DO UPDATE SET status = EXCLUDED.status, recorded_at = now();
  END IF;

  -- A dispute that already closed as won must not be reversed by a late
  -- (out-of-order) charge.dispute.created.
  IF p_kind = 'dispute' AND coalesce(p_dispute_status, '') <> 'lost' AND EXISTS (
    SELECT 1 FROM stripe_dispute_outcomes WHERE dispute_id = p_dispute_id AND status = 'won'
  ) THEN
    RETURN jsonb_build_object('skipped', 'dispute_already_won');
  END IF;

  SELECT id, property INTO v_orig FROM acct_journal_entries
   WHERE company_id = p_company_id AND reference = 'STRIPE-' || p_payment_intent_id AND status <> 'voided'
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'original_not_found');
  END IF;
  SELECT round(coalesce(sum(debit), 0) * 100)::bigint INTO v_booked
    FROM acct_journal_lines WHERE journal_entry_id = v_orig.id;

  -- Idempotent by reference.
  SELECT id INTO v_existing FROM acct_journal_entries
   WHERE company_id = p_company_id AND reference = p_reference AND status <> 'voided' LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('idempotent', true, 'id', v_existing);
  END IF;

  -- What is already reversed for this payment: posted refund / dispute
  -- reversals, net of dispute-won re-posts. Found by the payment-intent
  -- stamp, and -- for entries posted before the stamp existed -- by the
  -- charge's refund references and this dispute's references.
  v_charge_like := replace(replace(replace(coalesce(p_charge_id, ''), '\', '\\'), '%', '\%'), '_', '\_');
  WITH pool AS (
    SELECT e.id, e.reference FROM acct_journal_entries e
     WHERE e.company_id = p_company_id AND e.status = 'posted'
       AND (
         (e.stripe_payment_intent_id = p_payment_intent_id
            AND (e.reference LIKE 'STRIPE-REFUND-%' OR e.reference LIKE 'STRIPE-DISPUTE-%'))
         OR (v_charge_like <> '' AND e.reference LIKE 'STRIPE-REFUND-' || v_charge_like || '-%')
         OR (coalesce(p_dispute_id, '') <> '' AND e.reference IN ('STRIPE-DISPUTE-' || p_dispute_id, 'STRIPE-DISPUTE-WON-' || p_dispute_id))
       )
  ), amt AS (
    SELECT p.reference, round(coalesce(sum(l.debit), 0) * 100)::bigint AS cents
      FROM pool p JOIN acct_journal_lines l ON l.journal_entry_id = p.id
     GROUP BY p.id, p.reference
  )
  SELECT coalesce(sum(CASE WHEN reference LIKE 'STRIPE-DISPUTE-WON-%' THEN -cents ELSE cents END), 0),
         coalesce(sum(CASE WHEN reference LIKE 'STRIPE-REFUND-%' THEN cents ELSE 0 END), 0)
    INTO v_already, v_refunded
    FROM amt;

  IF p_kind = 'dispute_won' THEN
    SELECT id INTO v_src_id FROM acct_journal_entries
     WHERE company_id = p_company_id AND reference = 'STRIPE-DISPUTE-' || p_dispute_id AND status = 'posted' LIMIT 1;
    IF v_src_id IS NULL THEN
      RETURN jsonb_build_object('skipped', 'nothing_to_repost', 'marker', 'won');
    END IF;
    SELECT round(coalesce(sum(debit), 0) * 100)::bigint INTO v_amt FROM acct_journal_lines WHERE journal_entry_id = v_src_id;
  ELSE
    v_src_id := v_orig.id;
    IF p_kind = 'refund' THEN
      v_req := LEAST(v_booked, GREATEST(coalesce(p_amount_cents, 0), 0)) - v_refunded;
    ELSE
      v_req := LEAST(v_booked, GREATEST(coalesce(p_amount_cents, v_booked), 0));
    END IF;
    v_amt := LEAST(v_req, v_booked - v_already);
  END IF;

  IF v_amt IS NULL OR v_amt <= 0 THEN
    RETURN jsonb_build_object('skipped', 'nothing_to_reverse', 'booked_cents', v_booked, 'already_cents', v_already);
  END IF;

  -- Lines of the source entry, sides swapped, scaled to v_amt.
  SELECT round(coalesce(sum(debit), 0) * 100)::bigint,
         count(*) FILTER (WHERE debit > 0), count(*) FILTER (WHERE credit > 0)
    INTO v_src_total, v_nd, v_nc
    FROM acct_journal_lines WHERE journal_entry_id = v_src_id AND (debit > 0 OR credit > 0);
  IF v_src_total <= 0 THEN
    RETURN jsonb_build_object('skipped', 'nothing_to_reverse');
  END IF;
  v_want := LEAST(v_amt, v_src_total);

  v_date := coalesce(p_date, (now() AT TIME ZONE 'America/New_York')::date);
  FOR i IN 1..5 LOOP
    v_num := next_je_number(p_company_id);
    BEGIN
      INSERT INTO acct_journal_entries (company_id, number, date, description, reference, property, status, stripe_payment_intent_id)
      VALUES (p_company_id, v_num, v_date, left(coalesce(p_description, ''), 500), p_reference,
              coalesce(v_orig.property, ''), 'posted', p_payment_intent_id)
      RETURNING id INTO v_je_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
      IF v_con = 'idx_je_company_reference_unique' THEN
        RETURN jsonb_build_object('idempotent', true);
      END IF;
      IF v_con IS DISTINCT FROM 'unique_je_number_per_company' THEN
        RAISE;
      END IF;
    END;
  END LOOP;
  IF v_je_id IS NULL THEN
    RAISE EXCEPTION 'stripe_post_reversal: could not allocate a journal entry number';
  END IF;

  FOR v_line IN
    SELECT account_id, account_name, debit, credit, class_id
      FROM acct_journal_lines
     WHERE journal_entry_id = v_src_id AND (debit > 0 OR credit > 0)
     ORDER BY id
  LOOP
    IF v_line.debit > 0 THEN
      v_kd := v_kd + 1;
      v_c := CASE WHEN v_kd = v_nd THEN v_want - v_used_d
                  ELSE round(round(v_line.debit * 100) * v_want::numeric / v_src_total)::bigint END;
      v_used_d := v_used_d + v_c;
      -- original debit becomes a credit
      IF v_c > 0 THEN
        INSERT INTO acct_journal_lines (company_id, journal_entry_id, account_id, account_name, debit, credit, class_id, memo)
        VALUES (p_company_id, v_je_id, v_line.account_id, coalesce(v_line.account_name, ''), 0, v_c / 100.0, v_line.class_id, coalesce(p_memo, ''));
      END IF;
    ELSE
      v_kc := v_kc + 1;
      v_c := CASE WHEN v_kc = v_nc THEN v_want - v_used_c
                  ELSE round(round(v_line.credit * 100) * v_want::numeric / v_src_total)::bigint END;
      v_used_c := v_used_c + v_c;
      IF v_c > 0 THEN
        INSERT INTO acct_journal_lines (company_id, journal_entry_id, account_id, account_name, debit, credit, class_id, memo)
        VALUES (p_company_id, v_je_id, v_line.account_id, coalesce(v_line.account_name, ''), v_c / 100.0, 0, v_line.class_id, coalesce(p_memo, ''));
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('id', v_je_id, 'number', v_num, 'amount_cents', v_want,
                            'booked_cents', v_booked, 'already_cents', v_already);
END;
$function$;

REVOKE ALL ON FUNCTION public.stripe_post_reversal(text, text, text, text, text, bigint, text, text, text, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_post_reversal(text, text, text, text, text, bigint, text, text, text, text, date) TO service_role;

-- ── 3. tenant AR for a Stripe receipt ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.stripe_tenant_ar(p_company_id text, p_tenant_id bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t  record;
  v_id uuid;
BEGIN
  IF coalesce(p_company_id, '') = '' OR p_tenant_id IS NULL THEN RETURN NULL; END IF;
  SELECT id, name, property INTO v_t FROM tenants WHERE company_id = p_company_id AND id = p_tenant_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- One creator per tenant at a time: a second concurrent receipt waits and
  -- then finds the account the first one created.
  PERFORM pg_advisory_xact_lock(hashtext('tenant_ar:' || p_company_id || ':' || p_tenant_id::text));
  v_id := public._late_fee_tenant_ar(p_company_id, p_tenant_id, v_t.name, v_t.property);
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Could not establish an AR account for tenant % in company %', p_tenant_id, p_company_id;
  END IF;
  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.stripe_tenant_ar(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stripe_tenant_ar(text, bigint) TO service_role;
