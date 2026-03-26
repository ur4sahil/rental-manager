-- Error Management System: error_log table + find_unbalanced_jes RPC

CREATE TABLE IF NOT EXISTS error_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id TEXT REFERENCES companies(id),

  error_code TEXT NOT NULL,
  message TEXT NOT NULL,
  raw_message TEXT,
  severity TEXT DEFAULT 'error',

  module TEXT,
  context TEXT,
  meta JSONB DEFAULT '{}',

  user_email TEXT,
  user_role TEXT,

  url TEXT,
  user_agent TEXT,

  reported_by_user BOOLEAN DEFAULT FALSE,
  resolved BOOLEAN DEFAULT FALSE,
  resolution_notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_error_log_company ON error_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_code ON error_log(error_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_unresolved ON error_log(resolved, created_at DESC) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_error_log_reported ON error_log(reported_by_user, created_at DESC) WHERE reported_by_user = TRUE;

ALTER TABLE error_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert errors" ON error_log FOR INSERT WITH CHECK (TRUE);

CREATE POLICY "Company members can read own errors" ON error_log FOR SELECT USING (
  company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
    AND cm.status = 'active'
  )
);

CREATE POLICY "Admins can update errors" ON error_log FOR UPDATE USING (
  company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
    AND cm.status = 'active' AND cm.role IN ('admin', 'owner')
  )
);

-- RPC to find unbalanced journal entries
CREATE OR REPLACE FUNCTION find_unbalanced_jes(p_company_id TEXT)
RETURNS TABLE(id UUID, number TEXT, difference NUMERIC) AS $$
BEGIN
  RETURN QUERY
  SELECT je.id, je.number,
    ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) AS difference
  FROM acct_journal_entries je
  LEFT JOIN acct_journal_lines jl ON jl.journal_entry_id = je.id
  WHERE je.company_id = p_company_id AND je.status = 'posted'
  GROUP BY je.id, je.number
  HAVING ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) > 0.01
  ORDER BY je.date DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
