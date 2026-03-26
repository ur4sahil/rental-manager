-- RPC: Find unbalanced journal entries for data integrity checks
CREATE OR REPLACE FUNCTION find_unbalanced_jes(p_company_id TEXT)
RETURNS TABLE(id UUID, number TEXT, difference NUMERIC) AS $$
BEGIN
  RETURN QUERY
  SELECT
    je.id,
    je.number,
    ABS(
      COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
    ) AS difference
  FROM acct_journal_entries je
  LEFT JOIN acct_journal_lines jl ON jl.journal_entry_id = je.id
  WHERE je.company_id = p_company_id
    AND je.status = 'posted'
  GROUP BY je.id, je.number
  HAVING ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) > 0.01
  ORDER BY je.date DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
