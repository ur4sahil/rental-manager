-- Support for the QuickBooks ledger import.
--
-- The import writes ~14,200 journal lines and ~6,650 headers in one run.
-- At that volume two things matter that are invisible at normal usage:
-- redundant indexes (every one is maintained on every insert), and the
-- per-row tenant-balance trigger.
--
-- Nothing here changes application behaviour. The dropped indexes are
-- exact duplicates or strict prefixes of indexes that remain, so every
-- query they served is still served.

-- 1. idx_acct_jl_je is byte-identical to idx_acct_jl_entry — both are
--    btree(journal_entry_id). Two identical indexes were created by
--    different migrations (20260335_core_indexes and
--    20260336_accounting_rewrite). Dropping one removes ~14,200
--    redundant index writes on the import and halves the ongoing write
--    cost on every journal line the app creates.
DROP INDEX IF EXISTS idx_acct_jl_je;

-- 2. idx_acct_je_company is btree(company_id), a strict prefix of
--    idx_acct_je_company_date btree(company_id, date). Postgres uses the
--    composite for company-only lookups, so the single-column index is
--    dead weight on every header insert.
DROP INDEX IF EXISTS idx_acct_je_company;

-- 3. idx_jl_bank_feed_txn indexes bank_feed_transaction_id including its
--    NULLs. Only lines created from a bank feed carry a value; the
--    import adds ~14,200 NULLs to it for nothing. Its siblings
--    (idx_acct_accounts_parent, idx_acct_accounts_tenant) are already
--    partial — this brings it in line.
DROP INDEX IF EXISTS idx_jl_bank_feed_txn;
CREATE INDEX IF NOT EXISTS idx_jl_bank_feed_txn
  ON acct_journal_lines (bank_feed_transaction_id)
  WHERE bank_feed_transaction_id IS NOT NULL;

-- 4. Bulk tenant-balance recompute.
--
--    acct_journal_lines carries an AFTER INSERT ... FOR EACH ROW trigger
--    (sync_tenant_balance_lines) that calls recompute_tenant_balance()
--    for the affected tenant. That function sums every posted line for
--    that tenant, so inserting N lines against one tenant's AR account
--    costs O(N^2). The import has 54 tenant AR accounts and thousands of
--    AR lines, which makes it the dominant cost of the whole run.
--
--    The importer therefore disables that trigger for the load and calls
--    this once afterwards: one pass over the company's tenants, one
--    balance computation each, instead of one per inserted line.
--
--    SECURITY DEFINER so the import route can call it, with an explicit
--    staff check so it cannot be used to probe another company. Mirrors
--    the scoping used by the acct_* RLS policies.
CREATE OR REPLACE FUNCTION public.recompute_tenant_balances_bulk(p_company_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_company_id = '' THEN
    RAISE EXCEPTION 'company_id is required';
  END IF;

  -- Callable by company staff, or by the service role (the import route).
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role'
     AND NOT is_company_staff(p_company_id) THEN
    RAISE EXCEPTION 'not authorized for company %', p_company_id;
  END IF;

  -- Computation below is the body of recompute_tenant_balance(bigint)
  -- run once per tenant, as a correlated subquery, so the result is
  -- identical to what the per-row trigger would have produced. Note the
  -- inner sum is deliberately NOT company-scoped, matching the original.
  WITH tenant_ids AS (
    SELECT DISTINCT a.tenant_id
      FROM acct_accounts a
     WHERE a.company_id = p_company_id
       AND a.tenant_id IS NOT NULL
  ), balances AS (
    SELECT ti.tenant_id,
           COALESCE((
             SELECT SUM(jl.debit) - SUM(jl.credit)
               FROM acct_journal_lines jl
               JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
               JOIN acct_accounts a         ON a.id  = jl.account_id
              WHERE a.tenant_id = ti.tenant_id
                AND je.status = 'posted'
           ), 0) AS bal
      FROM tenant_ids ti
  )
  UPDATE tenants t
     SET balance = b.bal
    FROM balances b
   WHERE t.id = b.tenant_id
     AND t.company_id = p_company_id
     -- skip no-op writes so a re-run doesn't churn dead tuples
     AND t.balance IS DISTINCT FROM b.bal;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_tenant_balances_bulk(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_tenant_balances_bulk(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.recompute_tenant_balances_bulk(text) IS
  'Recompute tenants.balance for every tenant in a company in one pass. Used after a bulk ledger import that ran with sync_tenant_balance_lines disabled.';
