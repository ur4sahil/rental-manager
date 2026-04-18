-- County tracking for properties. Required going forward via wizard
-- validation; existing rows are back-filled on a best-effort basis by
-- tests/backfill-property-county.js (ZIP→county lookup).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS county TEXT;
CREATE INDEX IF NOT EXISTS idx_properties_county ON properties(company_id, county) WHERE county IS NOT NULL;
