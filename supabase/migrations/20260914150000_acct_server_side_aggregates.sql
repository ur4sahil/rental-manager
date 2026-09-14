-- STEP 2: compute in Postgres what the browser was computing over the whole
-- ledger.
--
-- Every accounting screen waits on the app downloading all 16,548 journal
-- lines and summing them in JavaScript (buildBalanceIndex in
-- src/utils/acctReports.js). These two functions return the same answers
-- from the database, so the browser can ask for the 40 numbers a report
-- shows instead of the ledger those numbers came from.
--
-- SECURITY INVOKER, deliberately: RLS still applies, so a caller can only
-- aggregate companies they are staff of. The explicit p_company_id filter
-- on every table is belt-and-braces on top of that, and the membership test
-- makes the refusal explicit rather than relying on an empty result.
--
-- Sums are numeric. The columns always were; only the JavaScript made them
-- IEEE doubles, which is why getTrialBalance carries a comment about
-- accounts that net to exactly zero landing on ~1e-10 and rendering as
-- spurious $0.00 rows.

-- Per-account (and per-class) debit/credit totals over POSTED entries.
-- Mirrors buildBalanceIndex(journalEntries, filterFn) exactly:
--   je.status = 'posted'        -> the status check
--   p_start / p_end on je.date  -> the filterFn used by the trial balance
--                                  (date <= end), the P&L (between) and the
--                                  balance sheet (as-of)
-- class_id is returned rather than pre-split, so one call feeds both the
-- index and the classIndex the JS builds side by side.
CREATE OR REPLACE FUNCTION public.acct_balance_index(
  p_company_id text,
  p_start date DEFAULT NULL,
  p_end date DEFAULT NULL
)
RETURNS TABLE(account_id uuid, class_id text, debit numeric, credit numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jl.account_id,
         jl.class_id,
         SUM(jl.debit)  AS debit,
         SUM(jl.credit) AS credit
  FROM acct_journal_lines jl
  JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
  WHERE p_company_id IN (SELECT get_staff_company_ids())
    AND jl.company_id = p_company_id
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND (p_start IS NULL OR je.date >= p_start)
    AND (p_end   IS NULL OR je.date <= p_end)
  GROUP BY jl.account_id, jl.class_id;
$function$;

-- One or more accounts' ledgers, with the running balance already applied.
-- Mirrors getGeneralLedger: posted entries only, ordered by date, running
-- total signed by the account's normal balance (debit-normal types add
-- debit and subtract credit; the rest do the reverse).
--
-- Takes an ARRAY of account ids because AccountLedgerView is also used for
-- roll-ups over several accounts (a parent and its sub-accounts). The
-- running balance is PARTITIONed per account, which is what makes a
-- multi-account ledger a stack of ledgers rather than one interleaved list.
CREATE OR REPLACE FUNCTION public.acct_account_ledger(
  p_company_id text,
  p_account_ids uuid[],
  p_start date DEFAULT NULL,
  p_end date DEFAULT NULL
)
RETURNS TABLE(
  account_id uuid, account_name text, account_code text, line_id integer,
  je_id text, je_number text, je_date date, description text, reference text,
  property text, memo text, class_id text, entity_type text, entity_name text,
  reconciled boolean, debit numeric, credit numeric, balance numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jl.account_id,
         a.name AS account_name,
         a.code AS account_code,
         jl.id  AS line_id,
         je.id  AS je_id,
         je.number AS je_number,
         je.date AS je_date,
         je.description,
         je.reference,
         je.property,
         jl.memo,
         jl.class_id,
         jl.entity_type,
         jl.entity_name,
         jl.reconciled,
         jl.debit,
         jl.credit,
         SUM(
           CASE WHEN a.type IN ('Asset','Cost of Goods Sold','Expense','Other Expense')
                THEN jl.debit - jl.credit
                ELSE jl.credit - jl.debit
           END
         ) OVER (PARTITION BY jl.account_id ORDER BY je.date, je.number, jl.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
  FROM acct_journal_lines jl
  JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
  JOIN acct_accounts a ON a.id = jl.account_id
  WHERE p_company_id IN (SELECT get_staff_company_ids())
    AND jl.company_id = p_company_id
    AND je.company_id = p_company_id
    AND a.company_id  = p_company_id
    AND jl.account_id = ANY(p_account_ids)
    AND je.status = 'posted'
    AND (p_start IS NULL OR je.date >= p_start)
    AND (p_end   IS NULL OR je.date <= p_end)
  ORDER BY jl.account_id, je.date, je.number, jl.id;
$function$;

REVOKE ALL ON FUNCTION public.acct_balance_index(text, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acct_balance_index(text, date, date) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.acct_account_ledger(text, uuid[], date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acct_account_ledger(text, uuid[], date, date) TO authenticated, service_role;
