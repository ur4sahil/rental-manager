-- ROLLBACK for 20260530000002_rls_phase2_scoped_and_view.sql
-- Restores the pre-Phase-2 always-true policies and the unfiltered view.
-- Run manually (SQL editor / apply_migration) only to unblock. NOT auto-applied.
-- ⚠️ Reopens cross-company exposure on these tables — use only to recover.

-- 1) company_settings
DROP POLICY IF EXISTS "company_settings_read" ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_write" ON public.company_settings;
CREATE POLICY "company_settings_read" ON public.company_settings FOR SELECT TO public USING (true);
CREATE POLICY "company_settings_write" ON public.company_settings FOR ALL TO public USING (true) WITH CHECK (true);

-- 2) eviction_cases
DROP POLICY IF EXISTS "eviction_cases_staff" ON public.eviction_cases;
CREATE POLICY "eviction_cases_authenticated" ON public.eviction_cases FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3) journal_entries
CREATE POLICY "Allow all" ON public.journal_entries FOR ALL TO public USING (true);
CREATE POLICY "auth_journal" ON public.journal_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4) app_users
DROP POLICY IF EXISTS "app_users_self_read" ON public.app_users;
DROP POLICY IF EXISTS "app_users_self_update" ON public.app_users;
CREATE POLICY "auth_app_users" ON public.app_users FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete app_users" ON public.app_users FOR DELETE TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert app_users" ON public.app_users FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "app_users_insert" ON public.app_users FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Authenticated users can read app_users" ON public.app_users FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can update app_users" ON public.app_users FOR UPDATE TO authenticated USING (true);

-- 5) ledger_entries view — restore WITHOUT the embedded access filter
CREATE OR REPLACE VIEW public.ledger_entries AS
 SELECT jl.id, jl.company_id, t.name AS tenant, a.tenant_id,
    COALESCE(je.property, ''::text) AS property, NULL::bigint AS property_id,
    je.date::text::date AS date, COALESCE(je.description, ''::text) AS description,
    COALESCE(jl.debit, 0::numeric) + COALESCE(jl.credit, 0::numeric) AS amount,
    COALESCE(je.transaction_type, CASE WHEN COALESCE(jl.debit,0::numeric)>0::numeric THEN 'charge'::text ELSE 'payment'::text END) AS type,
    sum(CASE
            WHEN COALESCE(je.transaction_type, CASE WHEN COALESCE(jl.debit,0::numeric)>0::numeric THEN 'charge'::text ELSE 'payment'::text END) = ANY (ARRAY['charge'::text,'late_fee'::text,'expense'::text,'deposit_deduction'::text,'deposit'::text]) THEN COALESCE(jl.debit,0::numeric)+COALESCE(jl.credit,0::numeric)
            WHEN COALESCE(je.transaction_type, CASE WHEN COALESCE(jl.debit,0::numeric)>0::numeric THEN 'charge'::text ELSE 'payment'::text END) = ANY (ARRAY['payment'::text,'credit'::text,'deposit_return'::text,'void'::text]) THEN -(COALESCE(jl.debit,0::numeric)+COALESCE(jl.credit,0::numeric))
            ELSE COALESCE(jl.debit,0::numeric)+COALESCE(jl.credit,0::numeric)
        END) OVER (PARTITION BY a.tenant_id ORDER BY (je.date::text::date), je.created_at, jl.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance,
    je.id AS journal_entry_id, je.created_at
   FROM acct_journal_lines jl
     JOIN acct_journal_entries je ON je.id = jl.journal_entry_id
     JOIN acct_accounts a ON a.id = jl.account_id
     JOIN tenants t ON t.id = a.tenant_id
  WHERE a.tenant_id IS NOT NULL AND je.status = 'posted'::text;
