ALTER TABLE app_users ADD COLUMN IF NOT EXISTS first_name text DEFAULT '';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS middle_initial text DEFAULT '';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_name text DEFAULT ''
