-- notification_settings was originally created with a UNIQUE
-- constraint on `event_type` alone (constraint name
-- `notification_settings_event_type_key`). That made the table
-- single-tenant: once `sandbox-llc` had a row for `rent_due`, no
-- other company could ever insert one. Multi-tenant seeding from
-- the new admin Notifications panel hit 409s because PostgREST saw
-- a conflict on this legacy constraint instead of the
-- (company_id, event_type) index added in 20260429000003.
--
-- Drop the legacy constraint. The newer composite index already
-- enforces "one row per (company, event_type)" which is the actual
-- intent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'notification_settings'::regclass
      AND conname  = 'notification_settings_event_type_key'
  ) THEN
    ALTER TABLE notification_settings
      DROP CONSTRAINT notification_settings_event_type_key;
  END IF;
END $$;
