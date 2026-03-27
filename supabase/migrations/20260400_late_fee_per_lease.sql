-- Add per-tenant/per-lease late fee configuration
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_fee_type TEXT DEFAULT 'flat';

ALTER TABLE leases
  ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_fee_type TEXT DEFAULT 'flat';

-- Constraint: late_fee_type must be flat or percent
ALTER TABLE tenants
  ADD CONSTRAINT chk_tenant_late_fee_type CHECK (late_fee_type IS NULL OR late_fee_type IN ('flat', 'percent'));

ALTER TABLE leases
  ADD CONSTRAINT chk_lease_late_fee_type CHECK (late_fee_type IS NULL OR late_fee_type IN ('flat', 'percent'));
