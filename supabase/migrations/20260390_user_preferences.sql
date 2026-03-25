-- Add preferences JSONB column to app_users for report favorites, column prefs, etc.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS preferences jsonb DEFAULT '{}';
