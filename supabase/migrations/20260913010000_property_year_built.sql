-- year_built on properties, so lead-paint rules can be applied at all.
--
-- Federal law bans lead-based paint in housing built from 1978, so
-- disclosure and Maryland's MDE registration apply to units built BEFORE
-- 1978. The app could not express that rule because it had no idea when a
-- property was built -- there was no year column anywhere on properties.
--
-- Nullable on purpose: an unknown year must not be treated as pre-1978
-- (which would flag every property) nor as post-1978 (which would flag
-- none). Unknown is its own state and the compliance report says so.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS year_built integer;

-- A sanity bound rather than a free-for-all integer: a typo'd 19788 or a
-- year in the future is a data-entry slip, not a building.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_year_built_sane;
ALTER TABLE properties ADD CONSTRAINT properties_year_built_sane
  CHECK (year_built IS NULL OR (year_built >= 1600 AND year_built <= EXTRACT(YEAR FROM now())::int + 2));

COMMENT ON COLUMN properties.year_built IS
  'Year of construction. Drives the pre-1978 lead-paint requirement. NULL means unknown, which is reported as unknown rather than assumed either way.';
