-- Ensure (company_id, event_type) is unique so upserts with
-- onConflict: "company_id,event_type" succeed. Without this, the
-- seed call from the admin Notifications panel returns 400 and the
-- panel renders an empty list.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'notification_settings'
      AND indexname = 'idx_notif_settings_unique'
  ) THEN
    CREATE UNIQUE INDEX idx_notif_settings_unique
      ON notification_settings (company_id, event_type);
  END IF;
END $$;
