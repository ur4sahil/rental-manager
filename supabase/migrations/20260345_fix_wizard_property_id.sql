-- Fix property_id type on property_setup_wizard — properties.id is integer, not uuid
ALTER TABLE property_setup_wizard ALTER COLUMN property_id TYPE text USING property_id::text;
