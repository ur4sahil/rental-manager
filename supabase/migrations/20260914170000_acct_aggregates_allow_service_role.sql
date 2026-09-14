-- The aggregates refused the service role, for the same reason
-- acct_rebuild_period_totals did: get_staff_company_ids() reads a JWT, and
-- the service key has none. That blocks background jobs and, more
-- immediately, tests/report-parity.test.js, which is what proves the server
-- path and the browser path agree.
--
-- current_user is read deliberately and safely here. The repo's rule is
-- "never use current_user for caller identity inside a SECURITY DEFINER
-- function", because there it resolves to the function's OWNER. These are
-- SECURITY INVOKER, so current_user IS the caller -- the documented case
-- where reading it is correct. Under PostgREST an INVOKER function sees
-- 'authenticated' for a browser request and 'service_role' for the service
-- key, so this widens nothing for a browser caller: an authenticated user
-- still has to be staff of the company.
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
  WHERE (current_user IN ('service_role','postgres','supabase_admin')
         OR p_company_id IN (SELECT get_staff_company_ids()))
    AND jl.company_id = p_company_id
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND (p_start IS NULL OR je.date >= p_start)
    AND (p_end   IS NULL OR je.date <= p_end)
  GROUP BY jl.account_id, jl.class_id;
$function$;

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
  WHERE (current_user IN ('service_role','postgres','supabase_admin')
         OR p_company_id IN (SELECT get_staff_company_ids()))
    AND jl.company_id = p_company_id
    AND je.company_id = p_company_id
    AND a.company_id  = p_company_id
    AND jl.account_id = ANY(p_account_ids)
    AND je.status = 'posted'
    AND (p_start IS NULL OR je.date >= p_start)
    AND (p_end   IS NULL OR je.date <= p_end)
  ORDER BY jl.account_id, je.date, je.number, jl.id;
$function$;
