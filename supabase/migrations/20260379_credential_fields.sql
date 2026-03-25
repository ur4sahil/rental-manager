-- Add website, username (encrypted), password (encrypted) + IV to all 4 property-related tables

ALTER TABLE utilities ADD COLUMN IF NOT EXISTS website text DEFAULT '';
ALTER TABLE utilities ADD COLUMN IF NOT EXISTS username_encrypted text DEFAULT '';
ALTER TABLE utilities ADD COLUMN IF NOT EXISTS password_encrypted text DEFAULT '';
ALTER TABLE utilities ADD COLUMN IF NOT EXISTS encryption_iv text DEFAULT '';

ALTER TABLE hoa_payments ADD COLUMN IF NOT EXISTS website text DEFAULT '';
ALTER TABLE hoa_payments ADD COLUMN IF NOT EXISTS username_encrypted text DEFAULT '';
ALTER TABLE hoa_payments ADD COLUMN IF NOT EXISTS password_encrypted text DEFAULT '';
ALTER TABLE hoa_payments ADD COLUMN IF NOT EXISTS encryption_iv text DEFAULT '';

ALTER TABLE property_loans ADD COLUMN IF NOT EXISTS website text DEFAULT '';
ALTER TABLE property_loans ADD COLUMN IF NOT EXISTS username_encrypted text DEFAULT '';
ALTER TABLE property_loans ADD COLUMN IF NOT EXISTS password_encrypted text DEFAULT '';
ALTER TABLE property_loans ADD COLUMN IF NOT EXISTS encryption_iv text DEFAULT '';

ALTER TABLE property_insurance ADD COLUMN IF NOT EXISTS website text DEFAULT '';
ALTER TABLE property_insurance ADD COLUMN IF NOT EXISTS username_encrypted text DEFAULT '';
ALTER TABLE property_insurance ADD COLUMN IF NOT EXISTS password_encrypted text DEFAULT '';
ALTER TABLE property_insurance ADD COLUMN IF NOT EXISTS encryption_iv text DEFAULT '';
