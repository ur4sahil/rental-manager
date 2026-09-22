-- Portfolio loans: one loan spanning MANY properties, entered once, tracked at
-- portfolio level (no per-property split, no auto-posting). A join table links
-- the properties it covers. RLS copies property_loans' single company_members-
-- keyed ALL policy (non-recursive; company_members does not subquery these).
CREATE TABLE IF NOT EXISTS public.portfolio_loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  lender_name text NOT NULL,
  loan_type text DEFAULT 'Conventional',
  original_amount numeric DEFAULT 0,
  current_balance numeric DEFAULT 0,
  interest_rate numeric DEFAULT 0,
  monthly_payment numeric DEFAULT 0,
  account_number text,
  loan_start_date date,
  maturity_date date,
  escrow_included boolean DEFAULT false,
  escrow_amount numeric DEFAULT 0,
  status text DEFAULT 'active',
  notes text,
  website text DEFAULT '',
  username_encrypted text DEFAULT '',
  password_encrypted text DEFAULT '',
  encryption_iv text DEFAULT '',
  encryption_iv_username text,
  encryption_salt text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.portfolio_loan_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  portfolio_loan_id uuid NOT NULL REFERENCES public.portfolio_loans(id) ON DELETE CASCADE,
  property text NOT NULL,
  property_id bigint,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_loan_property_uniq
  ON public.portfolio_loan_properties(portfolio_loan_id, property);
CREATE INDEX IF NOT EXISTS idx_portfolio_loan_props_company ON public.portfolio_loan_properties(company_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_loans_company ON public.portfolio_loans(company_id);

ALTER TABLE public.portfolio_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolio_loan_properties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS portfolio_loans_company_isolation ON public.portfolio_loans;
CREATE POLICY portfolio_loans_company_isolation ON public.portfolio_loans
  USING (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower((current_setting('request.jwt.claims', true)::json ->> 'email')) AND cm.status = 'active'))
  WITH CHECK (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower((current_setting('request.jwt.claims', true)::json ->> 'email')) AND cm.status = 'active'));

DROP POLICY IF EXISTS portfolio_loan_properties_company_isolation ON public.portfolio_loan_properties;
CREATE POLICY portfolio_loan_properties_company_isolation ON public.portfolio_loan_properties
  USING (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower((current_setting('request.jwt.claims', true)::json ->> 'email')) AND cm.status = 'active'))
  WITH CHECK (company_id IN (SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower((current_setting('request.jwt.claims', true)::json ->> 'email')) AND cm.status = 'active'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_loans TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_loan_properties TO authenticated, service_role;
