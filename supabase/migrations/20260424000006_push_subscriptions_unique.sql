-- push_subscriptions is upserted client-side with
--   .upsert([...], { onConflict: "company_id,user_email" })
-- which requires a UNIQUE (or exclusion) constraint on
-- (company_id, user_email). Without it Postgres returns
-- "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification", the subscribe flow fails at the DB
-- step, and no push subscription ever lands — which is what
-- was happening when the new diagnostic panel surfaced the
-- error.
--
-- Clean up any duplicate (company_id, user_email) pairs before
-- adding the constraint, keeping the most recently-updated row
-- per pair so a stale subscription doesn't win the race. Rows
-- without updated_at/created_at fall back to id order.

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY company_id, lower(user_email)
           ORDER BY COALESCE(created_at, now()) DESC, id DESC
         ) AS rn
  FROM push_subscriptions
)
DELETE FROM push_subscriptions
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Enforce case-insensitive uniqueness on the email. The client
-- upserts with the raw entered email while queueNotification
-- lowercases the recipient; without lower() the two could collide
-- as distinct rows.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_company_email_key
  ON push_subscriptions (company_id, lower(user_email));

-- ON CONFLICT can only target a named constraint OR a matching
-- index (including partial / functional indexes). PostgREST's
-- onConflict="company_id,user_email" resolves against the column
-- list, so we also need a plain (company_id, user_email) index
-- so the parser can bind to it.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_company_email_raw_key
  ON push_subscriptions (company_id, user_email);
