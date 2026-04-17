-- Property rental licenses + expiry tracking
-- Supports: rental license, lead paint cert, fire inspection, DC BBL, rental registration, etc.
-- Multi-tenant by company_id, soft-delete via archived_at.

CREATE TABLE IF NOT EXISTS property_licenses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            text NOT NULL,
  property_id           integer NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  license_type          text NOT NULL,        -- rental_license, lead_paint, fire_inspection, bbl, rental_registration, lead_risk_assessment, other
  license_type_custom   text,                 -- free-text label when license_type='other'
  license_number        text,
  jurisdiction          text,                 -- "Prince George's County, MD"
  issue_date            date,
  expiry_date           date NOT NULL,
  fee_amount            numeric(10,2),
  status                text NOT NULL DEFAULT 'active',   -- active, pending_renewal, expired, revoked
  document_id           uuid REFERENCES documents(id) ON DELETE SET NULL,
  notes                 text,
  last_reminder_sent_at timestamptz,
  last_reminder_day_bucket int,               -- 90/60/30/7/0 — avoids duplicate sends for same bucket
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  archived_at           timestamptz,
  archived_by           text
);

CREATE INDEX IF NOT EXISTS idx_prop_licenses_company_expiry
  ON property_licenses(company_id, expiry_date)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_prop_licenses_property
  ON property_licenses(property_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_prop_licenses_reminder_scan
  ON property_licenses(expiry_date)
  WHERE archived_at IS NULL AND status IN ('active','pending_renewal');

-- updated_at trigger
CREATE OR REPLACE FUNCTION property_licenses_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_property_licenses_updated_at ON property_licenses;
CREATE TRIGGER trg_property_licenses_updated_at
  BEFORE UPDATE ON property_licenses
  FOR EACH ROW EXECUTE FUNCTION property_licenses_touch_updated_at();

-- RLS: same company scoping as properties. Relies on company_members membership.
ALTER TABLE property_licenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_licenses_select ON property_licenses;
CREATE POLICY property_licenses_select ON property_licenses
  FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE cm.user_email ILIKE (auth.jwt() ->> 'email')
        AND cm.status = 'active'
    )
  );

DROP POLICY IF EXISTS property_licenses_insert ON property_licenses;
CREATE POLICY property_licenses_insert ON property_licenses
  FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE cm.user_email ILIKE (auth.jwt() ->> 'email')
        AND cm.status = 'active'
        AND cm.role IN ('admin','owner','pm','office_assistant')
    )
  );

DROP POLICY IF EXISTS property_licenses_update ON property_licenses;
CREATE POLICY property_licenses_update ON property_licenses
  FOR UPDATE TO authenticated
  USING (
    company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE cm.user_email ILIKE (auth.jwt() ->> 'email')
        AND cm.status = 'active'
        AND cm.role IN ('admin','owner','pm','office_assistant')
    )
  );

-- Service-role bypass is automatic; cron (via service-role key) can read/update regardless.
