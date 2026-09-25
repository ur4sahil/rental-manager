-- Wave 2 #2: per-user read/dismiss state for the activity feed. The inbox row
-- is shared (recipient_email may be null = everyone), so read/dismissed cannot
-- live on the row without one person clearing it for all. Each viewer keeps
-- their own state here; the feed joins on it for the current user.
CREATE TABLE IF NOT EXISTS public.notification_inbox_state (
  company_id text NOT NULL,
  inbox_id uuid NOT NULL REFERENCES public.notification_inbox(id) ON DELETE CASCADE,
  user_email text NOT NULL,
  read_at timestamptz,
  dismissed_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (inbox_id, user_email)
);
CREATE INDEX IF NOT EXISTS idx_notif_state_user ON public.notification_inbox_state (company_id, lower(user_email));

ALTER TABLE public.notification_inbox_state ENABLE ROW LEVEL SECURITY;
-- A viewer sees and writes ONLY their own state rows.
DROP POLICY IF EXISTS notif_state_own ON public.notification_inbox_state;
CREATE POLICY notif_state_own ON public.notification_inbox_state
  USING (lower(user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email'))
  WITH CHECK (lower(user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_inbox_state TO authenticated;
