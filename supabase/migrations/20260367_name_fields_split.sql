-- Add first_name, middle_initial, last_name to person-name tables
-- Keep name column as computed display field for backward compatibility

-- Tenants
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS first_name text DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS middle_initial text DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_name text DEFAULT ''
