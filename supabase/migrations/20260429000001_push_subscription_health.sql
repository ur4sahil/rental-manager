-- Push subscription health tracking. Apple's web.push.apple.com
-- returns 201 even after a subscription has been silently revoked
-- by Web.app (the iOS PWA host process). The only reliable signal
-- of a live subscription is whether the SW actually beacons back
-- after we send a push.
--
-- last_sw_received_at: stamped by /api/notifications?action=beacon
-- whenever the SW reports it received a push event. If this column
-- is older than 7 days while we've been actively sending pushes,
-- the subscription is almost certainly dead and we should stop
-- wasting APNS calls + prompt the user to re-enable.
--
-- last_dispatch_at: stamped server-side every time we dispatch to
-- this subscription. Lets us compute "we've been pushing for X
-- days but the SW hasn't acknowledged — assume dead."

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS last_sw_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_dispatch_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_marked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_push_subs_health
  ON push_subscriptions(company_id, user_email, last_sw_received_at);
