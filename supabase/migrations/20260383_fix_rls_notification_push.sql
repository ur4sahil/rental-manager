-- Fix notification_queue and push_subscriptions RLS (was USING(true) — no isolation)

-- notification_queue: scope to company_id
DROP POLICY IF EXISTS nq_company_isolation ON notification_queue;
CREATE POLICY nq_company_isolation ON notification_queue FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));

-- push_subscriptions: scope to company
DROP POLICY IF EXISTS ps_user_isolation ON push_subscriptions;
CREATE POLICY ps_user_isolation ON push_subscriptions FOR ALL
  USING (company_id IN (
    SELECT cm.company_id FROM company_members cm
    WHERE lower(cm.user_email) = lower(auth.jwt()->>'email')
    AND cm.status = 'active'
  ));
