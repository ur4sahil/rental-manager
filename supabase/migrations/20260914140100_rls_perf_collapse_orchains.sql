-- STEP 1b/1c: turn the accounting permission checks into a hashed set test
-- instead of three function calls per row.
--
-- RESULT, same query, same data, real admin JWT, test DB:
--     before                880 ms   18,180 buffers
--     after 1a (this file's predecessor)
--                           364 ms   17,864 buffers
--     after this file         3 ms    1,180 buffers     ~290x
--
-- Each of acct_journal_entries, acct_journal_lines and acct_accounts
-- carried three permissive staff policies, OR'd:
--
--   is_company_staff(company_id)
--   has_write_access(company_id)
--   company_id IN (SELECT get_user_company_ids())
--
-- All three resolve to the SAME people, and is_company_staff is the widest:
--
--   is_company_staff      auth_user_id OR email, role NOT IN (tenant, owner)
--   get_user_company_ids  email only,            role NOT IN (tenant, owner)
--   has_write_access      email only,            role IN (admin, manager,
--                                                office_assistant, accountant,
--                                                maintenance)
--
-- Write roles are all non-tenant/non-owner, so has_write_access is a subset
-- of is_company_staff; matching by email is a subset of matching by
-- uid-or-email. Permissive policies are OR'd, so the union of the three IS
-- is_company_staff -- the other two never admit anyone it would not.
--
-- The cost was the SHAPE, not the logic. is_company_staff(company_id) takes
-- a COLUMN as its argument, so it runs once per row. Expressing the same
-- membership as a SET of company ids lets Postgres evaluate it once as a
-- hashed subplan and answer each row with a hash lookup.
--
-- Access is unchanged, verified by counting visible rows in all three
-- tables for five personas -- staff-admin / tenant / owner / outsider
-- (no membership row for this company) / anon -- before and after. Only
-- staff could read these tables before; only staff can after.

CREATE OR REPLACE FUNCTION public.get_staff_company_ids()
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT company_id FROM company_members
  WHERE (auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email()))
    AND status = 'active'
    AND role NOT IN ('tenant', 'owner');
$function$;

REVOKE ALL ON FUNCTION public.get_staff_company_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_staff_company_ids() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_staff_company_ids() IS
  'The company ids where the caller is active staff (not a tenant or owner). '
  'Set-returning counterpart to is_company_staff(text): used as '
  'company_id IN (SELECT get_staff_company_ids()) so RLS evaluates membership '
  'once per query instead of once per row.';

DROP POLICY IF EXISTS acct_je_staff_all ON public.acct_journal_entries;
DROP POLICY IF EXISTS acct_journal_entries_write ON public.acct_journal_entries;
DROP POLICY IF EXISTS acct_journal_entries_read ON public.acct_journal_entries;

CREATE POLICY acct_journal_entries_staff ON public.acct_journal_entries
  FOR ALL
  USING (company_id IN (SELECT get_staff_company_ids()))
  WITH CHECK (company_id IN (SELECT get_staff_company_ids()));

-- je_lines_access granted by the PARENT ENTRY's company rather than the
-- line's own, so replacing it with a test on the line's company_id is only
-- equivalent if those never disagree. Verified before writing this: 0 lines
-- whose company_id differs from their entry's, and 0 lines with no entry.
-- The new WITH CHECK keeps it that way -- a writer can only insert lines
-- for a company they are staff of.
DROP POLICY IF EXISTS acct_jl_staff_all ON public.acct_journal_lines;
DROP POLICY IF EXISTS je_lines_access ON public.acct_journal_lines;

CREATE POLICY acct_journal_lines_staff ON public.acct_journal_lines
  FOR ALL
  USING (company_id IN (SELECT get_staff_company_ids()))
  WITH CHECK (company_id IN (SELECT get_staff_company_ids()));

DROP POLICY IF EXISTS acct_accounts_staff_all ON public.acct_accounts;
DROP POLICY IF EXISTS acct_accounts_write ON public.acct_accounts;
DROP POLICY IF EXISTS acct_accounts_read ON public.acct_accounts;

CREATE POLICY acct_accounts_staff ON public.acct_accounts
  FOR ALL
  USING (company_id IN (SELECT get_staff_company_ids()))
  WITH CHECK (company_id IN (SELECT get_staff_company_ids()));

-- acct_jl_tenant and acct_accounts_tenant are deliberately LEFT IN PLACE.
-- Both are dead for reads today (acct_jl_tenant's second EXISTS reads
-- acct_journal_entries, which no tenant can see, so it can never be
-- satisfied -- the persona matrix measures tenants at 0 rows), but they are
-- tenant-facing rules and removing them is a separate decision from a
-- performance change. They cost nothing: the planner short-circuits them
-- for staff and both show as "never executed".
