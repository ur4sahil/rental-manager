-- Per-installment property-tax bill tracking. Distinct from property_taxes
-- (which holds the annual metadata / jurisdiction info). One row per
-- installment per tax year per property. Auto-generated from
-- COUNTY_TAX_SCHEDULES (helpers.js) when a property's county is known,
-- then marked paid manually as the bills come in. Bank-recon auto-post
-- can come later; this migration is tracking-only.
CREATE TABLE IF NOT EXISTS property_tax_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  property text NOT NULL,
  property_id integer,
  tax_year int NOT NULL,
  installment_label text NOT NULL,          -- "1st half" / "County & Municipal" / "School" / "Annual"
  due_date date NOT NULL,
  expected_amount numeric,                  -- derived from property_taxes.annual_tax_amount / installments
  status text NOT NULL DEFAULT 'pending',   -- pending | paid | skipped | voided
  paid_date date,
  paid_amount numeric,
  paid_notes text,
  auto_generated boolean NOT NULL DEFAULT true,
  last_reminder_sent_at timestamptz,
  last_reminder_day_bucket int,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE property_tax_bills
  DROP CONSTRAINT IF EXISTS property_tax_bills_status_check;
ALTER TABLE property_tax_bills
  ADD CONSTRAINT property_tax_bills_status_check
  CHECK (status IN ('pending','paid','skipped','voided'));

-- Dedup guard: auto-generated bills are keyed by (company, property, year, installment).
-- Lets generateBillsForProperty() rerun safely; also lets a PM hand-add a row
-- (auto_generated=false) alongside an auto one without hitting this index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_tax_bills_autogen
  ON property_tax_bills(company_id, property, tax_year, installment_label)
  WHERE auto_generated = true AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_property_tax_bills_company_status_due
  ON property_tax_bills(company_id, status, due_date)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_property_tax_bills_property
  ON property_tax_bills(company_id, property)
  WHERE archived_at IS NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION property_tax_bills_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_property_tax_bills_updated_at ON property_tax_bills;
CREATE TRIGGER trg_property_tax_bills_updated_at
  BEFORE UPDATE ON property_tax_bills
  FOR EACH ROW EXECUTE FUNCTION property_tax_bills_touch_updated_at();

ALTER TABLE property_tax_bills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_tax_bills_select ON property_tax_bills;
CREATE POLICY property_tax_bills_select ON property_tax_bills FOR SELECT TO authenticated
USING (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
));

DROP POLICY IF EXISTS property_tax_bills_insert ON property_tax_bills;
CREATE POLICY property_tax_bills_insert ON property_tax_bills FOR INSERT TO authenticated
WITH CHECK (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
    AND cm.role IN ('admin','owner','pm','office_assistant')
));

DROP POLICY IF EXISTS property_tax_bills_update ON property_tax_bills;
CREATE POLICY property_tax_bills_update ON property_tax_bills FOR UPDATE TO authenticated
USING (company_id IN (
  SELECT cm.company_id FROM company_members cm
  WHERE cm.user_email ILIKE (auth.jwt() ->> 'email') AND cm.status = 'active'
    AND cm.role IN ('admin','owner','pm','office_assistant')
));
