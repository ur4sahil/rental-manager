-- Phase 2: Stripe-driven autopay. Extends autopay_schedules with the
-- columns the cron + save-card flow need.
--
-- Existing rows use {active, method, day_of_month, frequency} — those
-- are kept for back-compat with any legacy ACH/manual autopays. New
-- Stripe rows go in alongside them, identified by provider='stripe'.

ALTER TABLE autopay_schedules
  -- Per-tenant FK so saved-card lookups don't have to fuzzy-match by
  -- name. Older rows can remain null; new Stripe rows MUST set this.
  ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id) ON DELETE CASCADE,

  -- Engine flag. The TenantPortal already reads `enabled` (failing
  -- silently because the column never existed) — adding it here makes
  -- the autopay-enabled banner work for the first time. Default true
  -- so an explicit save-card-for-autopay row is on from creation.
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true,

  -- Drives the cron: charge runs when next_charge_date <= CURRENT_DATE.
  -- After a successful charge the impl bumps this forward by one
  -- frequency cycle.
  ADD COLUMN IF NOT EXISTS next_charge_date date,

  -- Distinguishes Stripe-card autopay from legacy ACH/manual rows.
  -- Used as the cron filter — `where provider='stripe'`.
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'manual',

  -- Stripe identifiers persisted at save-card time. customer_id is
  -- redundant with tenants.stripe_customer_id but copying it here
  -- saves a join in the off-session charge path.
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id text,

  -- Card metadata for the "Visa ending in 4242" UI in the Autopay tab.
  -- We do NOT store the full PAN — only the brand + last4 Stripe
  -- returns on PaymentMethod.card.
  ADD COLUMN IF NOT EXISTS card_brand text,
  ADD COLUMN IF NOT EXISTS card_last4 text,

  -- Most recent failure detail. The off-session webhook stamps these
  -- on payment_intent.payment_failed so the tenant can be prompted
  -- to update their card. NULLed on next successful charge.
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz,

  -- Stamped on each successful Stripe autopay charge. Lets ops see
  -- "last charge ran X days ago" without joining acct_journal_entries.
  ADD COLUMN IF NOT EXISTS last_charge_at timestamptz;

-- Cron picks up due rows fast — index the columns it filters on.
CREATE INDEX IF NOT EXISTS idx_autopay_due_stripe
  ON autopay_schedules(next_charge_date)
  WHERE enabled = true AND provider = 'stripe' AND archived_at IS NULL;

-- One Stripe autopay per (company, tenant) — the save-card flow is
-- "replace" semantics, not "append". A second card for the same
-- tenant overwrites the first row rather than creating a parallel one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopay_one_stripe_per_tenant
  ON autopay_schedules(company_id, tenant_id)
  WHERE provider = 'stripe' AND archived_at IS NULL;
