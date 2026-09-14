-- STEP 1a of the accounting performance work: make the permission check cheap.
--
-- Measured before (test DB, 16,548 journal lines, real admin JWT):
--   one 1000-row page of acct_journal_lines = 880 ms, 18,180 buffers,
--   of which 743 ms is a sequential scan of acct_journal_entries whose
--   filter reads
--     has_write_access(company_id) OR (company_id = ANY(hashed))
--       OR is_company_staff(company_id) OR is_company_staff(company_id)
--   evaluated once per row, 15,444 times. The app reads 17 such pages on
--   every Accounting load -- the ~17s its own comments describe.
--
-- Neither change below alters who can see what.

-- (1) has_write_access was VOLATILE. Its body is a single SELECT EXISTS
--     against company_members -- it reads and returns, it never writes.
--     VOLATILE forbids Postgres from evaluating it once and reusing the
--     result, forcing a fresh call per row scanned. STABLE is what its two
--     siblings (is_company_staff, get_user_company_ids) already carry.
CREATE OR REPLACE FUNCTION public.has_write_access(p_company_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN EXISTS(
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND LOWER(user_email) = LOWER(auth.jwt()->>'email')
    AND status = 'active'
    AND role IN ('admin', 'manager', 'office_assistant', 'accountant', 'maintenance')
  );
END;
$function$;

-- (2) Exact duplicate policies. acct_accounts_staff and
--     acct_accounts_staff_all are the same policy written twice: both
--     PERMISSIVE, both TO public, both FOR ALL, both
--     USING is_company_staff(company_id). One omits WITH CHECK, and for an
--     ALL policy Postgres then uses the USING expression as the check --
--     so they are identical in effect. Same for the pair on
--     acct_journal_entries.
--
--     Permissive policies are OR'd, so a duplicate grants nothing extra; it
--     only makes the planner evaluate the identical function twice per row.
--     That is the "OR is_company_staff(x) OR is_company_staff(x)" in the
--     plan above. The _all variants are kept, as they state WITH CHECK.
DROP POLICY IF EXISTS acct_accounts_staff ON public.acct_accounts;
DROP POLICY IF EXISTS acct_je_staff ON public.acct_journal_entries;
