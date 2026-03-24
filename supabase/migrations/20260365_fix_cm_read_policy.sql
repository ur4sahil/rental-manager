-- Fix company_members read policy: users must be able to read their OWN rows
-- (any status) to see which companies they belong to, plus all rows for
-- companies where they are active members.
DROP POLICY IF EXISTS "cm_read_company" ON company_members;
CREATE POLICY "cm_read_own_and_company" ON company_members FOR SELECT
  USING (
    -- Can always read your own membership rows (any status)
    lower(user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
    OR
    -- Can read all members of companies where you are active
    company_id IN (
      SELECT cm2.company_id FROM company_members cm2
      WHERE lower(cm2.user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
      AND cm2.status = 'active'
    )
  )
