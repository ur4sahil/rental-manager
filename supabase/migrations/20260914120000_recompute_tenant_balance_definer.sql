-- recompute_tenant_balance() must not run under the caller's RLS.
--
-- THE BUG IT FIXES
--
-- Saving a journal entry with more than two lines, or any entry touching a
-- tenant ledger, failed with PM-8004 "canceling statement due to statement
-- timeout" and dumped the user back to the Journal Entries list with their
-- work lost. production error_log, context
-- "acct_journal_lines delete before re-insert".
--
-- The chain:
--
--   1. sync_tenant_balance_lines is a ROW trigger on acct_journal_lines, so
--      it fires once per line. Saving an edit deletes N lines and inserts N,
--      and the status trigger fires too -- so a 3-line entry recomputes the
--      tenant's whole balance up to 7 times.
--
--   2. recompute_tenant_balance was SECURITY INVOKER, so each of those
--      recomputes ran its three-table join under the caller's RLS.
--
--   3. acct_journal_lines carries three permissive policies, and permissive
--      policies are OR'd. The disjunction cannot be answered from an index,
--      so the planner materialises the je_lines_access IN-list with a full
--      sequential scan of acct_journal_entries, evaluating four function
--      calls per row.
--
-- Measured on the test database, same query, same data:
--
--      as postgres (RLS bypassed)   cost      90
--      as authenticated (RLS on)    cost  15,111      168x
--
-- Multiply that by up to 7 per save against an 8s statement_timeout
-- (the authenticated role's setting) and the save cannot finish.
--
-- THE CORRECTNESS BUG UNDERNEATH IT
--
-- Worse than the timeout: under RLS the function summed only the rows the
-- CURRENT USER could see, then wrote that partial sum to tenants.balance as
-- if it were the total. A balance is a property of the ledger, not of who is
-- looking at it. recompute_tenant_balances_bulk() -- the same computation,
-- written later -- was already SECURITY DEFINER, so the two functions could
-- return different balances for the same tenant.
--
-- This brings the per-tenant one in line with its own sibling: identical
-- body, SECURITY DEFINER, search_path pinned so the definer rights cannot be
-- redirected through a shadowed table name.
--
-- Note this function takes an id and returns void. It makes no decision based
-- on who is calling, so it never reads current_user -- which is the trap that
-- SECURITY DEFINER sets, and the reason the repo's guidance warns about it.

CREATE OR REPLACE FUNCTION public.recompute_tenant_balance(p_tenant_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_balance numeric;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN;
  END IF;
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)
  INTO v_balance
  FROM acct_journal_lines jl
  JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
  JOIN acct_accounts a ON a.id = jl.account_id
  WHERE a.tenant_id = p_tenant_id
    AND je.status = 'posted';
  UPDATE tenants SET balance = v_balance WHERE id = p_tenant_id;
END;
$function$;

-- Match recompute_tenant_balances_bulk's grants exactly. PUBLIC held EXECUTE
-- here and does not there; anon/authenticated/service_role keep the explicit
-- grants they already had, so the two ACLs end up identical.
REVOKE ALL ON FUNCTION public.recompute_tenant_balance(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_tenant_balance(bigint)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.recompute_tenant_balance(bigint) IS
  'Recompute tenants.balance from posted journal lines. SECURITY DEFINER: a '
  'balance is a property of the ledger, not of the caller, and running it '
  'under the caller''s RLS both wrote partial sums and made multi-line '
  'journal entry saves time out.';
