-- Voucher tenant tracking (Section 8 / county housing)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_voucher BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voucher_number TEXT,
  ADD COLUMN IF NOT EXISTS reexam_date DATE,
  ADD COLUMN IF NOT EXISTS case_manager_name TEXT,
  ADD COLUMN IF NOT EXISTS case_manager_email TEXT,
  ADD COLUMN IF NOT EXISTS case_manager_phone TEXT,
  ADD COLUMN IF NOT EXISTS voucher_portion NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tenant_portion NUMERIC DEFAULT 0;
