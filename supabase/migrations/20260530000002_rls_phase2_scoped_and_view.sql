-- ============================================================================
-- RLS hardening — Phase 2: scope the no-fallback tables, fix the legacy view
-- ============================================================================
-- Follows 20260530000001 (Phase 1). Handles the tables that had ONLY always-true
-- policies (no scoped fallback) plus the ledger_entries SECURITY DEFINER view.
-- Reuses the existing helper fns (get_user_company_ids / has_write_access /
-- is_company_staff — all SECURITY DEFINER). Validated live post-apply.
-- Rollback: supabase/rollbacks/20260530000002_..._ROLLBACK.sql
--
-- Accepted, documented exceptions left in place (not leaks): utility_providers
-- (intentional global lookup, read-only), write-only public INSERT on
-- audit_trail / error_log (logging), utility_audit service_role policy.
-- ============================================================================

-- 1) company_settings: members read, writers write. (Not read by tenant/owner
--    portals; no credential columns.)
DROP POLICY IF EXISTS "company_settings_read" ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_write" ON public.company_settings;
CREATE POLICY "company_settings_read" ON public.company_settings FOR SELECT TO public
  USING (company_id IN (SELECT get_user_company_ids()));
CREATE POLICY "company_settings_write" ON public.company_settings FOR ALL TO public
  USING (has_write_access(company_id)) WITH CHECK (has_write_access(company_id));

-- 2) eviction_cases: staff only (accessed via companyQuery in staff app).
DROP POLICY IF EXISTS "eviction_cases_authenticated" ON public.eviction_cases;
CREATE POLICY "eviction_cases_staff" ON public.eviction_cases FOR ALL TO public
  USING (is_company_staff(company_id)) WITH CHECK (is_company_staff(company_id));

-- 3) journal_entries: legacy table, unused by the app (replaced by
--    acct_journal_entries) and has no company_id to scope by. Drop the
--    always-true policies; RLS stays enabled with no policy → no anon/
--    authenticated access. Service role still bypasses for any maintenance.
DROP POLICY IF EXISTS "Allow all" ON public.journal_entries;
DROP POLICY IF EXISTS "auth_journal" ON public.journal_entries;

-- 4) app_users: add self-access (so a user can always read/update THEIR OWN
--    row — needed during onboarding before company_members is active, and for
--    self preference/profile updates), then drop the always-true policies.
--    Inserts already covered by app_users_safe_insert; staff/company access by
--    app_users_company + app_users_staff.
CREATE POLICY "app_users_self_read" ON public.app_users FOR SELECT TO public
  USING (lower(email) = lower(auth.email()));
CREATE POLICY "app_users_self_update" ON public.app_users FOR UPDATE TO public
  USING (lower(email) = lower(auth.email())) WITH CHECK (lower(email) = lower(auth.email()));
DROP POLICY IF EXISTS "auth_app_users" ON public.app_users;
DROP POLICY IF EXISTS "Authenticated users can delete app_users" ON public.app_users;
DROP POLICY IF EXISTS "Authenticated users can insert app_users" ON public.app_users;
DROP POLICY IF EXISTS "app_users_insert" ON public.app_users;
DROP POLICY IF EXISTS "Authenticated users can read app_users" ON public.app_users;
DROP POLICY IF EXISTS "Authenticated users can update app_users" ON public.app_users;

-- 5) ledger_entries view: self-filtering SECURITY DEFINER view. Same columns as
--    before (so dependent reads are unchanged) plus an embedded access filter:
--    staff see their companies' ledgers; a tenant sees only their OWN ledger
--    (email match on the joined tenant — NOT get_user_company_ids, which would
--    expose the whole company since tenants are members); service role bypasses.
CREATE OR REPLACE VIEW public.ledger_entries AS
 SELECT jl.id,
    jl.company_id,
    t.name AS tenant,
    a.tenant_id,
    COALESCE(je.property, ''::text) AS property,
    NULL::bigint AS property_id,
    je.date::text::date AS date,
    COALESCE(je.description, ''::text) AS description,
    COALESCE(jl.debit, 0::numeric) + COALESCE(jl.credit, 0::numeric) AS amount,
    COALESCE(je.transaction_type,
        CASE
            WHEN COALESCE(jl.debit, 0::numeric) > 0::numeric THEN 'charge'::text
            ELSE 'payment'::text
        END) AS type,
    sum(
        CASE
            WHEN COALESCE(je.transaction_type,
            CASE
                WHEN COALESCE(jl.debit, 0::numeric) > 0::numeric THEN 'charge'::text
                ELSE 'payment'::text
            END) = ANY (ARRAY['charge'::text, 'late_fee'::text, 'expense'::text, 'deposit_deduction'::text, 'deposit'::text]) THEN COALESCE(jl.debit, 0::numeric) + COALESCE(jl.credit, 0::numeric)
            WHEN COALESCE(je.transaction_type,
            CASE
                WHEN COALESCE(jl.debit, 0::numeric) > 0::numeric THEN 'charge'::text
                ELSE 'payment'::text
            END) = ANY (ARRAY['payment'::text, 'credit'::text, 'deposit_return'::text, 'void'::text]) THEN - (COALESCE(jl.debit, 0::numeric) + COALESCE(jl.credit, 0::numeric))
            ELSE COALESCE(jl.debit, 0::numeric) + COALESCE(jl.credit, 0::numeric)
        END) OVER (PARTITION BY a.tenant_id ORDER BY (je.date::text::date), je.created_at, jl.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance,
    je.id AS journal_entry_id,
    je.created_at
   FROM acct_journal_lines jl
     JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
     JOIN acct_accounts a ON a.id = jl.account_id
     JOIN tenants t ON t.id = a.tenant_id
  WHERE a.tenant_id IS NOT NULL
    AND je.status = 'posted'::text
    AND (
      is_company_staff(jl.company_id)
      OR lower(t.email) = lower(auth.email())
      OR coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    );
