-- Tracks whether a user has set a real password after being bootstrapped
-- via a magic link. The App-level auth router checks this column to avoid
-- repeatedly prompting magic-link users to "set your password" after
-- they've already done so in a prior session.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_set_at timestamptz;
