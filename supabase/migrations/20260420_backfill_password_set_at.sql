-- Existing users (pre-M15 era) logged in via password or were imported
-- without the new password_set_at timestamp. Stamp them now so they're
-- not all pushed into the "Set Your Password" screen on next login.
-- The fallback to NOW() covers rows without created_at.
UPDATE app_users
SET password_set_at = COALESCE(created_at, NOW())
WHERE password_set_at IS NULL;
