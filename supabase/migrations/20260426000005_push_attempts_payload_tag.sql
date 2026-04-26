-- Correlation key between server-side push dispatch and SW-side
-- reception. Server generates a random tag, embeds in payload,
-- writes the row. When the SW receives the push it beacons the
-- same tag back via /api/push-beacon and we insert a sibling row
-- with status='sw_received'. JOIN by payload_tag to see which
-- pushes made it from APNS to the device.
ALTER TABLE push_attempts ADD COLUMN IF NOT EXISTS payload_tag text;
CREATE INDEX IF NOT EXISTS idx_push_attempts_payload_tag
  ON push_attempts(payload_tag, created_at DESC)
  WHERE payload_tag IS NOT NULL;
