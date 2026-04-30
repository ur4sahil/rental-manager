-- Admin-grade notification configuration. Per-LLC, per-event-type
-- control over WHO gets notified, WHEN, on WHAT channels, and with
-- WHAT exact content. Replaces the thin 4-option recipients string +
-- body-only template with full subject/body/cc/bcc/recipients/quiet-
-- hours data. RLS already gates notification_settings via
-- is_company_staff(company_id) so the new columns inherit it.

ALTER TABLE notification_settings
  -- Custom subject template. Falls back to DEFAULTS[event_type].subject
  -- in the worker if NULL — keeps current emails working unchanged
  -- until the admin sets one explicitly.
  ADD COLUMN IF NOT EXISTS subject_template TEXT,

  -- Recipients structured as a JSON array. Each entry:
  --   { kind: 'role'|'user'|'tenant'|'owner'|'manager'|'property_manager'|'email',
  --     value: string|null }
  -- Empty array → fall back to the legacy `recipients` string for
  -- back-compat with v1 of the settings UI.
  ADD COLUMN IF NOT EXISTS custom_recipients JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS cc                JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bcc               JSONB DEFAULT '[]'::jsonb,

  -- Quiet hours window. If `now()` (in quiet_hours_tz) falls inside
  -- [start, end], queueNotification stamps scheduled_for with the next
  -- end-of-window UTC timestamp and the worker waits to send.
  ADD COLUMN IF NOT EXISTS quiet_hours_start TIME,
  ADD COLUMN IF NOT EXISTS quiet_hours_end   TIME,
  ADD COLUMN IF NOT EXISTS quiet_hours_tz    TEXT DEFAULT 'America/New_York',

  -- Severity flag. 'high' bumps the email priority header (and could
  -- bypass quiet hours later if we want). 'low' could batch / digest
  -- in a future release. For now: read by the worker, not yet acted on.
  ADD COLUMN IF NOT EXISTS severity          TEXT DEFAULT 'normal'
    CHECK (severity IN ('low','normal','high'));

ALTER TABLE notification_queue
  -- Per-row cc/bcc copied from notification_settings at queue time so
  -- a settings change doesn't retroactively rewrite addressing on
  -- already-queued rows.
  ADD COLUMN IF NOT EXISTS cc            JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bcc           JSONB DEFAULT '[]'::jsonb,

  -- When set, the worker leaves the row pending until now() >=
  -- scheduled_for. NULL = ready immediately (current behaviour).
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

-- Worker query needs to skip rows that are deferred. Index on the
-- (status, scheduled_for) pair so the partial index stays small —
-- only pending rows are candidates.
CREATE INDEX IF NOT EXISTS idx_notif_queue_scheduled
  ON notification_queue (status, scheduled_for) WHERE status = 'pending';
