-- Fix property_id type on new tables — properties.id is integer/bigint, not uuid
ALTER TABLE property_loans ALTER COLUMN property_id TYPE text USING property_id::text;
ALTER TABLE property_insurance ALTER COLUMN property_id TYPE text USING property_id::text;
