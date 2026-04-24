-- Formalizing migration for bank_reconciliations.
--
-- The Reconcile feature (src/components/Accounting.js) has been
-- inserting into public.bank_reconciliations since launch, but the
-- table itself was created manually via the Supabase SQL editor — no
-- migration committed. That made a fresh DB restore / new-tenant
-- onboarding fail 500 on the first reconciliation save.
--
-- Everything here is idempotent (CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS) so running it against the live DB that
-- already has the table + rows is a no-op.
--
-- RLS is intentionally left alone: production already has whatever
-- policies were set up when the table was created manually; this
-- migration's job is to make a fresh DB reproduce the schema, not to
-- redefine access controls. If a fresh restore needs RLS, it should
-- be added in a follow-up migration once the team decides the
-- canonical policy (matching accounting_period_lock etc.).
--
-- Schema mirrors the columns the production instance already uses
-- (introspected 2026-04-24): period (YYYY-MM), bank_ending_balance,
-- book_balance, difference, status ('reconciled' | 'in_progress' |
-- 'discrepancy' | 'pending_items'), reconciled_items / unreconciled_items
-- serialized JSON, notes, reconciled_by, reconciled_at, created_at,
-- company_id TEXT (per feedback_company_id_type.md — not a uuid FK).

CREATE TABLE IF NOT EXISTS public.bank_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period text,
  bank_ending_balance numeric,
  book_balance numeric,
  difference numeric,
  status text,
  reconciled_items jsonb,
  unreconciled_items jsonb,
  notes text,
  reconciled_by text,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  company_id text
);

-- Dashboard and list queries always filter by company_id + created_at
-- desc (see Accounting.js:1741 and :3658).
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_company_created
  ON public.bank_reconciliations (company_id, created_at DESC);

-- Lookups for a specific period when re-opening or cross-checking.
CREATE INDEX IF NOT EXISTS idx_bank_reconciliations_company_period
  ON public.bank_reconciliations (company_id, period);
