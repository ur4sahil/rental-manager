-- Per-rule custom variables that admins can declare from the
-- Notifications editor. Stored as a JSON array of strings, e.g.
-- ["office_phone", "landlord_name"]. The chip palette renders them
-- alongside the event's standard `vars` so admins have a typed
-- handle for fields they've wired up at the call site (or want to
-- use as a placeholder reminder).
--
-- The worker's render() never reads this column directly — unknown
-- {{tokens}} just resolve to "" if no value is in the data payload.
-- This is purely an editor affordance.
ALTER TABLE notification_settings
  ADD COLUMN IF NOT EXISTS extra_vars JSONB DEFAULT '[]'::jsonb;
