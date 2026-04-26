-- Audit log for push notification dispatches.
--
-- Push delivery is fire-and-forget from the client (queueNotification)
-- and fire-and-forget from server-side webhook code, so when a push
-- doesn't appear on the recipient's device there's no breadcrumb
-- showing where it broke. Was the fetch made? Did the JWT verify?
-- Did APNS accept it? Did webpush throw? Each attempt now writes a
-- row here so we can answer "what happened to that push" without
-- digging through Vercel function logs.
--
-- The endpoint already returns { delivered, pruned } to the caller —
-- this just persists it. Keep the table small (TTL 14 days) so it
-- doesn't grow unbounded.

CREATE TABLE IF NOT EXISTS push_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  caller_email text,
  recipient_email text NOT NULL,
  title text,
  body text,
  -- 'attempted' = we tried; 'delivered' = at least one sub got the
  -- push; 'no_subs' = recipient has no registered devices; 'auth_failed'
  -- = JWT or membership check rejected; 'error' = webpush threw.
  status text NOT NULL,
  delivered_count int DEFAULT 0,
  pruned_count int DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_attempts_recipient
  ON push_attempts(recipient_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_attempts_company_recent
  ON push_attempts(company_id, created_at DESC);
