-- Fix RLS on notification_queue and push_subscriptions.
--
-- Migration 20260383 tightened these from USING(true) to require an
-- active company_members row matching auth.jwt()->>'email'. That
-- locked out two legitimate write paths and produced 510+ PM-8005
-- errors over the last 7 days:
--
--  1. Cron / system writes to notification_queue (the worker, the
--     recurring engine, scheduled emails). These run with no JWT —
--     auth.jwt() returns NULL, the subquery is empty, every insert
--     42501s.
--
--  2. New users registering for push notifications before their
--     company_members row flips from 'pending'/'invited' to
--     'active'. Same RLS path, fails for any non-active member.
--
-- Fix:
--  - service_role bypass: any call made with the service role JWT
--    skips the membership check (covers cron, server-to-server).
--  - widen the membership check to status IN ('active','pending',
--    'invited') for push_subscriptions only — a user setting up
--    notifications shouldn't have to wait for invite acceptance.
--    notification_queue stays strict on 'active' for SELECT (so
--    pending users can't read other companies' queue) but writes
--    are gated more loosely.

-- ── notification_queue ───────────────────────────────────────────
DROP POLICY IF EXISTS nq_company_isolation ON notification_queue;

-- SELECT/UPDATE/DELETE: only active members of the company.
CREATE POLICY nq_company_isolation_read ON notification_queue
  FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
        AND cm.status = 'active'
    )
  );

-- INSERT: active OR pending members can queue. Service role always
-- allowed (cron, worker, recurring engine).
CREATE POLICY nq_company_isolation_insert ON notification_queue
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role'
    OR company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
        AND cm.status IN ('active', 'pending', 'invited')
    )
  );

-- UPDATE/DELETE: keep tight — only active members or service role.
CREATE POLICY nq_company_isolation_modify ON notification_queue
  FOR UPDATE
  USING (
    auth.role() = 'service_role'
    OR company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
        AND cm.status = 'active'
    )
  );

CREATE POLICY nq_company_isolation_delete ON notification_queue
  FOR DELETE
  USING (
    auth.role() = 'service_role'
    OR company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
        AND cm.status = 'active'
    )
  );

-- ── push_subscriptions ──────────────────────────────────────────
DROP POLICY IF EXISTS ps_user_isolation ON push_subscriptions;

CREATE POLICY ps_user_isolation ON push_subscriptions
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
        AND cm.status IN ('active', 'pending', 'invited')
    )
  )
  WITH CHECK (
    auth.role() = 'service_role'
    OR company_id IN (
      SELECT cm.company_id FROM company_members cm
      WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
        AND cm.status IN ('active', 'pending', 'invited')
    )
  );
