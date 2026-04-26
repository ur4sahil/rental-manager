-- Stripe integration columns. Phase 1 (one-time payments) only needs
-- to write `payments.stripe_session_id` (already exists) — this
-- migration adds the columns Phase 2 (saved card / autopay) will need
-- so we don't have to re-migrate later.

-- Stripe customer ID per tenant — created on first save-for-future
-- (Phase 2). Phase 1 doesn't write it; the column is just here so
-- the schema is ready when Phase 2 ships.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- Stripe payment_intent ID stamped on the JE the webhook posts. We
-- already have payments.stripe_session_id (legacy, used by the older
-- Checkout-redirect flow); add a parallel column on
-- acct_journal_entries so we can find the originating Stripe charge
-- from the JE row without joining through payments.
ALTER TABLE acct_journal_entries
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;

-- Helpful index — webhooks look up the JE by intent ID for
-- idempotency (so a replayed webhook doesn't double-post).
CREATE INDEX IF NOT EXISTS idx_acct_je_stripe_pi
  ON acct_journal_entries(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
