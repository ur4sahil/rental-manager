-- Property Loans table
CREATE TABLE IF NOT EXISTS property_loans (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL,
  property text NOT NULL,
  property_id uuid,
  lender_name text NOT NULL,
  loan_type text DEFAULT 'conventional',
  original_amount numeric DEFAULT 0,
  current_balance numeric DEFAULT 0,
  interest_rate numeric DEFAULT 0,
  monthly_payment numeric DEFAULT 0,
  escrow_included boolean DEFAULT false,
  escrow_amount numeric DEFAULT 0,
  escrow_covers jsonb DEFAULT '[]',
  loan_start_date date,
  maturity_date date,
  account_number text,
  status text DEFAULT 'active',
  notes text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE property_loans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "property_loans_company_isolation" ON property_loans
  FOR ALL USING (
    company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
      AND cm.status = 'active'
    )
  );

CREATE INDEX IF NOT EXISTS idx_property_loans_company ON property_loans(company_id);
CREATE INDEX IF NOT EXISTS idx_property_loans_property ON property_loans(company_id, property);

-- Property Insurance table
CREATE TABLE IF NOT EXISTS property_insurance (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL,
  property text NOT NULL,
  property_id uuid,
  provider text,
  policy_number text,
  premium_amount numeric DEFAULT 0,
  premium_frequency text DEFAULT 'annual',
  coverage_amount numeric DEFAULT 0,
  expiration_date date,
  notes text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE property_insurance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "property_insurance_company_isolation" ON property_insurance
  FOR ALL USING (
    company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
      AND cm.status = 'active'
    )
  );

CREATE INDEX IF NOT EXISTS idx_property_insurance_company ON property_insurance(company_id);

-- Property Setup Wizard progress table
CREATE TABLE IF NOT EXISTS property_setup_wizard (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL,
  property_id uuid,
  property_address text,
  current_step int DEFAULT 1,
  completed_steps jsonb DEFAULT '[]',
  wizard_data jsonb DEFAULT '{}',
  status text DEFAULT 'in_progress',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE property_setup_wizard ENABLE ROW LEVEL SECURITY;
CREATE POLICY "property_setup_wizard_company_isolation" ON property_setup_wizard
  FOR ALL USING (
    company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
      AND cm.status = 'active'
    )
  );

CREATE INDEX IF NOT EXISTS idx_property_setup_wizard_company ON property_setup_wizard(company_id, status);
