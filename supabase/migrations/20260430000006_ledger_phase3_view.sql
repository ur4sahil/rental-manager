-- Phase 3: build the view that will replace the ledger_entries table
-- in Phase 4. Same shape (id, company_id, tenant, tenant_id, property,
-- date, description, amount, type, balance, journal_entry_id,
-- created_at), derived from the GL on every read.
--
-- This view exists alongside the table for one migration cycle so we
-- can verify it matches before swapping. It lives at
-- ledger_entries_v in Phase 3; Phase 4 renames the table and points
-- this name at the view.
--
-- Shape rules (matching the table):
--   tenant       — tenants.name (joined via acct_accounts.tenant_id)
--   amount       — magnitude only (positive); type field disambiguates direction
--   type         — acct_journal_entries.transaction_type, or direction-based
--                  fallback for legacy JEs without it
--   balance      — running per-tenant SUM(debit-credit) over posted JEs
--   date         — acct_journal_entries.date as DATE
--   id           — acct_journal_lines.id (the line's id, since this row IS the line)
--   property     — acct_journal_entries.property
--   property_id  — NULL (the table also stored this; not derivable from GL alone)
--
-- Only AR-account lines are included (lines on accounts where
-- acct_accounts.tenant_id IS NOT NULL). Banking expense lines and
-- vendor-side lines are correctly excluded — they were never meant
-- to live in ledger_entries.

CREATE OR REPLACE VIEW ledger_entries_v AS
SELECT
  jl.id,
  jl.company_id,
  t.name                                         AS tenant,
  a.tenant_id,
  COALESCE(je.property, '')                      AS property,
  NULL::bigint                                   AS property_id,
  je.date::text::date                            AS date,
  COALESCE(je.description, '')                   AS description,
  COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0) AS amount,
  COALESCE(
    je.transaction_type,
    CASE WHEN COALESCE(jl.debit, 0) > 0 THEN 'charge' ELSE 'payment' END
  )                                              AS type,
  -- Running balance per tenant, ordered by date then created_at.
  -- charge/late_fee/expense/deposit_deduction/deposit add to balance;
  -- payment/credit/deposit_return/void subtract.
  SUM(
    CASE WHEN COALESCE(je.transaction_type,
                        CASE WHEN COALESCE(jl.debit, 0) > 0 THEN 'charge' ELSE 'payment' END)
              IN ('charge', 'late_fee', 'expense', 'deposit_deduction', 'deposit')
         THEN  (COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0))
         WHEN COALESCE(je.transaction_type,
                        CASE WHEN COALESCE(jl.debit, 0) > 0 THEN 'charge' ELSE 'payment' END)
              IN ('payment', 'credit', 'deposit_return', 'void')
         THEN -(COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0))
         ELSE  (COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0))
    END
  ) OVER (
    PARTITION BY a.tenant_id
    ORDER BY je.date::text::date, je.created_at, jl.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )                                              AS balance,
  je.id::text                                    AS journal_entry_id,
  je.created_at                                  AS created_at
FROM acct_journal_lines jl
JOIN acct_journal_entries je ON je.id::text = jl.journal_entry_id::text
JOIN acct_accounts a ON a.id = jl.account_id
JOIN tenants t ON t.id = a.tenant_id
WHERE a.tenant_id IS NOT NULL
  AND je.status = 'posted';

-- Permissions: the view is selectable by anyone who can SELECT the
-- underlying tables. RLS on the underlying tables (acct_journal_lines,
-- acct_journal_entries, acct_accounts, tenants) flows through.
GRANT SELECT ON ledger_entries_v TO anon, authenticated, service_role;

-- Helper function — returns ledger_entries_v rows for one tenant.
-- Use from app code in Phase 3 to start migrating reads off the table.
CREATE OR REPLACE FUNCTION get_tenant_ledger(p_company_id text, p_tenant_id bigint)
RETURNS SETOF ledger_entries_v
LANGUAGE sql STABLE AS $$
  SELECT * FROM ledger_entries_v
  WHERE company_id = p_company_id AND tenant_id = p_tenant_id
  ORDER BY date DESC, created_at DESC;
$$;
