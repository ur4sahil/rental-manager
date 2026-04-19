-- acct_journal_entries.id is text (not uuid). The old RPC declared
-- RETURNS TABLE(id uuid, ...) which raised 42804 structure mismatch
-- every time runDataIntegrityChecks (and the Admin health check) ran.
-- Recreate with id text so the sweep actually succeeds. Also return
-- the latest line date so callers can display it.
DROP FUNCTION IF EXISTS public.find_unbalanced_jes(text);
CREATE OR REPLACE FUNCTION public.find_unbalanced_jes(p_company_id text)
RETURNS TABLE(id text, number text, difference numeric, date date)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    je.id,
    je.number,
    ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0))::numeric AS difference,
    MAX(je.date) AS date
  FROM acct_journal_entries je
  LEFT JOIN acct_journal_lines jl ON jl.journal_entry_id = je.id
  WHERE je.company_id = p_company_id
    AND je.status = 'posted'
  GROUP BY je.id, je.number
  HAVING ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) > 0.01
  ORDER BY MAX(je.date) DESC
  LIMIT 50;
END;
$$;
