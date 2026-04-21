-- Promote messages.created_at from `timestamp without time zone` to
-- `timestamptz`. Existing rows were written with `new Date().toISOString()`
-- (UTC) but stored as wall-clock without the `Z`, then read back and
-- parsed as local — producing a ~TZ-offset skew in the UI. Interpret
-- existing values AS UTC (which is what they always were) so every row's
-- actual send moment is preserved.
ALTER TABLE public.messages
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
