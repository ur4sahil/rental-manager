-- owners.archived_at was referenced by both fetchData's filter
-- (`is("archived_at", null)`) and archiveOwner's update payload, but the
-- column itself never existed. The filter raised a schema error on
-- every Owners-page load, the fetch returned null, and the UI
-- silently rendered "No owners yet. Add one above." — making the
-- entire Owners module appear empty regardless of what was in the
-- owners table.
--
-- archived_by matches the pattern used on tenants / properties /
-- leases so the same audit-trail lookup works across modules.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE owners ADD COLUMN IF NOT EXISTS archived_by text;
