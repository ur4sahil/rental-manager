-- Fix company_id type on new tables to match companies.id (text, not uuid)
ALTER TABLE property_loans ALTER COLUMN company_id TYPE text;
ALTER TABLE property_insurance ALTER COLUMN company_id TYPE text;
ALTER TABLE property_setup_wizard ALTER COLUMN company_id TYPE text;
