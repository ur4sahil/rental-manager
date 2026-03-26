-- Budget table for Budget vs Actuals reporting
CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  account_id uuid REFERENCES acct_accounts(id),
  account_name text,
  period text NOT NULL, -- YYYY-MM format
  amount numeric(18,2) NOT NULL DEFAULT 0,
  notes text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company_id, account_id, period)
);
CREATE INDEX IF NOT EXISTS idx_budgets_company ON budgets(company_id);
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY budgets_company_access ON budgets FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));
