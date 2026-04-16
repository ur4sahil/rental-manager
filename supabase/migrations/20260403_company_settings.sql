-- Company-level settings (overrides COMPANY_DEFAULTS in config.js)
CREATE TABLE IF NOT EXISTS company_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Late Fees
  late_fee_grace_days INTEGER DEFAULT 5,
  late_fee_amount NUMERIC(10,2) DEFAULT 50,
  late_fee_type TEXT DEFAULT 'flat' CHECK (late_fee_type IN ('flat', 'percent')),

  -- Lease Defaults
  default_lease_months INTEGER DEFAULT 12,
  default_deposit_months INTEGER DEFAULT 1,
  rent_escalation_pct NUMERIC(5,2) DEFAULT 3.0,
  payment_due_day INTEGER DEFAULT 1 CHECK (payment_due_day BETWEEN 1 AND 31),
  renewal_notice_days INTEGER DEFAULT 60,

  -- Notification Thresholds
  rent_due_reminder_days INTEGER DEFAULT 3,
  lease_expiry_warning_days INTEGER DEFAULT 60,
  insurance_expiry_warning_days INTEGER DEFAULT 90,

  -- Legal / Lease Template
  deposit_return_days INTEGER DEFAULT 30,
  termination_notice_days INTEGER DEFAULT 30,

  -- Data Retention
  archive_retention_days INTEGER DEFAULT 180,

  -- Other
  hoa_upcoming_window_days INTEGER DEFAULT 14,
  voucher_reexam_window_days INTEGER DEFAULT 120,

  -- Metadata
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT,

  UNIQUE(company_id)
);

-- RLS
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_settings_read" ON company_settings
  FOR SELECT USING (true);

CREATE POLICY "company_settings_write" ON company_settings
  FOR ALL USING (true) WITH CHECK (true);

-- Index
CREATE INDEX IF NOT EXISTS idx_company_settings_company ON company_settings(company_id);
