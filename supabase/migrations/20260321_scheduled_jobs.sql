-- Enable pg_cron extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule auto rent charges + recurring JE processing daily at 6 AM EST
SELECT cron.schedule(
  'auto-rent-charges',
  '0 11 * * *',  -- 11:00 UTC = 6:00 AM EST
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/auto-rent-charges',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Schedule notification queue processing every 15 minutes
SELECT cron.schedule(
  'process-notifications',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/send-notification',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Add stripe_session_id column to payments if not exists
DO $$ BEGIN
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add last_posted_date to recurring_journal_entries if not exists
DO $$ BEGIN
  ALTER TABLE recurring_journal_entries ADD COLUMN IF NOT EXISTS last_posted_date DATE;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add due_date to hoa_payments if not exists
DO $$ BEGIN
  ALTER TABLE hoa_payments ADD COLUMN IF NOT EXISTS due_date DATE;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
