-- Property tax tracking — one row per property (current tax year). Mirrors
-- the property_insurance table shape so the wizard and accounting plumbing
-- are near-copies of the insurance flow.
--
-- Drives two features:
--   1. Property-tax schedule visibility on the property detail + dashboard
--      widget (due dates, jurisdiction link-out).
--   2. Optional recurring journal entries (DR 5700 Property Taxes / CR 1000
--      Checking) at the annual / semi-annual / quarterly cadence via the
--      existing recurring_journal_entries engine.
CREATE TABLE IF NOT EXISTS property_taxes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id text NOT NULL,
  property text NOT NULL,
  property_id integer,
  county text,
  jurisdiction text,
  parcel_id text,
  assessed_value numeric DEFAULT 0,
  tax_year int,
  annual_tax_amount numeric NOT NULL DEFAULT 0,
  billing_frequency text DEFAULT 'semi_annual',
  next_due_date date,
  exemptions text,
  escrow_paid_by_lender boolean DEFAULT false,
  records_url text,
  notes text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE property_taxes
  DROP CONSTRAINT IF EXISTS property_taxes_billing_frequency_check;
ALTER TABLE property_taxes
  ADD CONSTRAINT property_taxes_billing_frequency_check
  CHECK (billing_frequency IN ('annual','semi_annual','quarterly','monthly'));

CREATE INDEX IF NOT EXISTS idx_property_taxes_company ON property_taxes(company_id);
CREATE INDEX IF NOT EXISTS idx_property_taxes_property ON property_taxes(company_id, property);
CREATE INDEX IF NOT EXISTS idx_property_taxes_next_due ON property_taxes(company_id, next_due_date) WHERE archived_at IS NULL;

ALTER TABLE property_taxes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_taxes_select ON property_taxes;
CREATE POLICY property_taxes_select ON property_taxes FOR SELECT TO authenticated
USING (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
));

DROP POLICY IF EXISTS property_taxes_insert ON property_taxes;
CREATE POLICY property_taxes_insert ON property_taxes FOR INSERT TO authenticated
WITH CHECK (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
    AND cm.role IN ('admin','owner','pm','office_assistant')
));

DROP POLICY IF EXISTS property_taxes_update ON property_taxes;
CREATE POLICY property_taxes_update ON property_taxes FOR UPDATE TO authenticated
USING (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
    AND cm.role IN ('admin','owner','pm','office_assistant')
));
