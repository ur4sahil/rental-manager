-- Stage 1 of the reporting rework: compute reports in the DATABASE.
--
-- Accounting.js currently downloads every journal entry and line for the
-- company on page load and adds them up in the browser. Measured on the
-- Sahil LLC dataset (7,722 entries / 16,548 lines): 17.8 seconds and 78
-- REST requests, 19 of them paging acct_journal_lines. The cost grows
-- with the size of the books, forever.
--
-- The same trial balance computed as one aggregate here: 819ms, 71 rows,
-- one request. Cost now scales with the number of ACCOUNTS, not the
-- number of transactions.
--
-- These deliberately mirror the client's existing semantics exactly, so
-- the figures do not move:
--   * posted entries only            (buildBalanceIndex skips non-posted)
--   * active accounts only           (getTrialBalance filters is_active)
--   * date <= p_end                  (getTrialBalance takes an endDate)
--   * net >= half a cent to appear   (the 0.005 tolerance, which exists
--                                     because float sums land on ~1e-10)
--
-- SECURITY DEFINER with an explicit membership check, matching
-- has_write_access and friends: RLS on acct_journal_lines would
-- otherwise be evaluated per row across the whole ledger.

CREATE OR REPLACE FUNCTION public.report_trial_balance(
  p_company_id text, p_end date
) RETURNS TABLE (
  account_id uuid, code text, name text, type text,
  debit_balance numeric, credit_balance numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_member_of_company(p_company_id) THEN
    RAISE EXCEPTION 'Not a member of %', p_company_id;
  END IF;

  RETURN QUERY
  WITH net AS (
    SELECT l.account_id AS aid,
           SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0)) AS n
      FROM acct_journal_lines l
      JOIN acct_journal_entries je ON je.id = l.journal_entry_id
     WHERE l.company_id = p_company_id
       AND je.status = 'posted'
       AND je.date <= p_end
     GROUP BY l.account_id
  )
  SELECT a.id, a.code, a.name, a.type,
         CASE WHEN net.n > 0 THEN net.n ELSE 0 END,
         CASE WHEN net.n < 0 THEN abs(net.n) ELSE 0 END
    FROM acct_accounts a
    JOIN net ON net.aid = a.id
   WHERE a.company_id = p_company_id
     AND a.is_active
     AND abs(net.n) >= 0.005
   ORDER BY a.code;
END;
$function$;

-- Income and expense movement across a period, for the P&L. Same
-- filters, but bounded at both ends rather than as-of.
CREATE OR REPLACE FUNCTION public.report_profit_and_loss(
  p_company_id text, p_start date, p_end date
) RETURNS TABLE (
  account_id uuid, code text, name text, type text, subtype text,
  amount numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_member_of_company(p_company_id) THEN
    RAISE EXCEPTION 'Not a member of %', p_company_id;
  END IF;

  RETURN QUERY
  SELECT a.id, a.code, a.name, a.type, a.subtype,
         -- Revenue is credit-normal, expenses debit-normal. Returning a
         -- POSITIVE figure for each in its natural direction keeps the
         -- caller from having to know which is which.
         CASE WHEN a.type IN ('Revenue','Income')
              THEN SUM(COALESCE(l.credit,0) - COALESCE(l.debit,0))
              ELSE SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0))
         END
    FROM acct_journal_lines l
    JOIN acct_journal_entries je ON je.id = l.journal_entry_id
    JOIN acct_accounts a ON a.id = l.account_id
   WHERE l.company_id = p_company_id
     AND je.status = 'posted'
     AND je.date BETWEEN p_start AND p_end
     AND a.is_active
     AND a.type IN ('Revenue','Income','Expense','COGS','Other Income','Other Expense')
   GROUP BY a.id, a.code, a.name, a.type, a.subtype
  HAVING abs(SUM(COALESCE(l.debit,0) - COALESCE(l.credit,0))) >= 0.005
   ORDER BY a.code;
END;
$function$;

-- One account's movement, for the General Ledger, with a running
-- balance computed in SQL rather than by walking every entry in JS.
CREATE OR REPLACE FUNCTION public.report_general_ledger(
  p_company_id text, p_account_id uuid, p_start date, p_end date
) RETURNS TABLE (
  line_id text, entry_id text, entry_number text, entry_date date,
  description text, reference text, memo text,
  debit numeric, credit numeric, running_balance numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_normal text;
BEGIN
  IF NOT public.is_member_of_company(p_company_id) THEN
    RAISE EXCEPTION 'Not a member of %', p_company_id;
  END IF;

  SELECT CASE WHEN a.type IN ('Asset','Expense','COGS','Other Expense')
              THEN 'debit' ELSE 'credit' END
    INTO v_normal
    FROM acct_accounts a WHERE a.id = p_account_id AND a.company_id = p_company_id;

  RETURN QUERY
  SELECT l.id::text, je.id::text, COALESCE(je.number,''), je.date,
         COALESCE(je.description,''), COALESCE(je.reference,''), COALESCE(l.memo,''),
         COALESCE(l.debit,0), COALESCE(l.credit,0),
         SUM(CASE WHEN v_normal = 'debit'
                  THEN COALESCE(l.debit,0) - COALESCE(l.credit,0)
                  ELSE COALESCE(l.credit,0) - COALESCE(l.debit,0) END)
           OVER (ORDER BY je.date, je.created_at, l.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    FROM acct_journal_lines l
    JOIN acct_journal_entries je ON je.id = l.journal_entry_id
   WHERE l.company_id = p_company_id
     AND l.account_id = p_account_id
     AND je.status = 'posted'
     AND je.date BETWEEN p_start AND p_end
   ORDER BY je.date, je.created_at, l.id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.report_trial_balance(text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_profit_and_loss(text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_general_ledger(text, uuid, date, date) TO authenticated;
