-- Fix company_members RLS: allow self-update and invited member self-join

-- Allow users to UPDATE their own row (auth_user_id backfill, status changes)
DROP POLICY IF EXISTS "cm_read_own" ON company_members;
CREATE POLICY "cm_self_select" ON company_members FOR SELECT USING (
  auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email())
);
CREATE POLICY "cm_self_update" ON company_members FOR UPDATE USING (
  auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email())
);

-- Allow invited users to INSERT/UPSERT their own membership (tenant invite redemption)
-- The user can only insert a row matching their own email
CREATE POLICY "cm_self_insert" ON company_members FOR INSERT WITH CHECK (
  lower(user_email) = lower(auth.email())
);
