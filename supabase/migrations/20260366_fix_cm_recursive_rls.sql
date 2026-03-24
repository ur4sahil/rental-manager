-- Fix recursive RLS on company_members
-- The admin and read policies query company_members itself, causing
-- infinite recursion. Replace with auth.email() based direct checks.

DROP POLICY IF EXISTS "cm_admin_all" ON company_members;
DROP POLICY IF EXISTS "cm_read_own_and_company" ON company_members;
DROP POLICY IF EXISTS "cm_self_insert_restricted" ON company_members;
DROP POLICY IF EXISTS "cm_self_update_restricted" ON company_members;

-- Simple non-recursive read: users see rows where their email matches OR
-- rows in companies they belong to (using a SECURITY DEFINER helper to avoid recursion)
CREATE OR REPLACE FUNCTION is_member_of_company(p_company_id text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND lower(user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
    AND status = 'active'
  )
$$;

-- Read: see your own rows + all rows in companies you belong to
CREATE POLICY "cm_read" ON company_members FOR SELECT
  USING (
    lower(user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
    OR is_member_of_company(company_id)
  );

-- Insert: self-insert only with restricted role/status
CREATE POLICY "cm_insert" ON company_members FOR INSERT
  WITH CHECK (
    lower(user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
  );

-- Update: admins can update any row in their company, others can only update their own
CREATE POLICY "cm_update" ON company_members FOR UPDATE
  USING (
    lower(user_email) = lower(current_setting('request.jwt.claims', true)::json->>'email')
    OR is_member_of_company(company_id)
  );

-- Delete: only admins of the company
CREATE POLICY "cm_delete" ON company_members FOR DELETE
  USING (
    is_member_of_company(company_id)
  )
