-- ============================================================================
-- RLS hardening — Phase 1: drop redundant always-true policies
-- ============================================================================
-- CONTEXT: Security audit found 48 `rls_policy_always_true` advisories. The
-- correct per-company RLS is ALREADY in place (scoped policies using helper
-- functions get_user_company_ids() / has_write_access() / is_company_staff()
-- / get_tenant_name() / get_owner_id()). The leak is that LEGACY policies
-- from the "RLS-off, filter client-side" era were never dropped:
--   • `{public}` "Allow all" policies → the anon key (shipped in the frontend
--     bundle) could read/write EVERY company's data via PostgREST.
--   • `{authenticated}` auth_* USING(true) policies → any logged-in user could
--     read/write across companies.
-- Permissive policies are OR'd, so these overrode every scoped policy.
--
-- This phase drops ONLY policies that have a verified scoped fallback for all
-- commands (staff + tenant + owner paths already covered). Public signing uses
-- SECURITY DEFINER RPCs (not direct table reads), so dropping the {public}
-- "Allow all" policies does not affect anon flows.
--
-- DEFERRED to a branch-tested Phase 2 (no scoped fallback / auth-critical):
--   company_settings, journal_entries (legacy/unused), eviction_cases,
--   utility_providers (global lookup), app_users (signup/invite writes),
--   the ledger_entries SECURITY DEFINER view, and the write-only public
--   INSERT policies on audit_trail / error_log.
-- Rollback: 20260530000001_rls_phase1_drop_always_true_ROLLBACK.sql
-- ============================================================================

-- --- {authenticated} auth_* always-true (cross-company leak for logged-in users)
DROP POLICY IF EXISTS "auth_acct_accounts" ON public.acct_accounts;
DROP POLICY IF EXISTS "auth_acct_classes" ON public.acct_classes;
DROP POLICY IF EXISTS "auth_acct_journal_entries" ON public.acct_journal_entries;
DROP POLICY IF EXISTS "auth_acct_journal_lines" ON public.acct_journal_lines;
DROP POLICY IF EXISTS "auth_audit_trail" ON public.audit_trail;
DROP POLICY IF EXISTS "Authenticated users can manage autopay_schedules" ON public.autopay_schedules;
DROP POLICY IF EXISTS "auth_autopay" ON public.autopay_schedules;
DROP POLICY IF EXISTS "auth_bank_recon" ON public.bank_reconciliations;
DROP POLICY IF EXISTS "Authenticated users can manage documents" ON public.documents;
DROP POLICY IF EXISTS "auth_documents" ON public.documents;
DROP POLICY IF EXISTS "auth_inspections" ON public.inspections;
DROP POLICY IF EXISTS "Authenticated users can manage late_fee_rules" ON public.late_fee_rules;
DROP POLICY IF EXISTS "auth_latefees" ON public.late_fee_rules;
DROP POLICY IF EXISTS "auth_lease_sigs" ON public.lease_signatures;
DROP POLICY IF EXISTS "auth_lease_templates" ON public.lease_templates;
DROP POLICY IF EXISTS "auth_leases" ON public.leases;
DROP POLICY IF EXISTS "auth_messages" ON public.messages;
DROP POLICY IF EXISTS "auth_notif_log" ON public.notification_log;
DROP POLICY IF EXISTS "auth_notif_settings" ON public.notification_settings;
DROP POLICY IF EXISTS "auth_payments" ON public.payments;
DROP POLICY IF EXISTS "auth_properties" ON public.properties;
DROP POLICY IF EXISTS "auth_property_change_requests" ON public.property_change_requests;
DROP POLICY IF EXISTS "auth_utilities" ON public.utilities;
DROP POLICY IF EXISTS "Allow all for authenticated" ON public.utility_audit;
DROP POLICY IF EXISTS "auth_vendor_invoices" ON public.vendor_invoices;
DROP POLICY IF EXISTS "auth_vendors" ON public.vendors;
DROP POLICY IF EXISTS "Authenticated users can manage work_order_photos" ON public.work_order_photos;
DROP POLICY IF EXISTS "auth_wo_photos" ON public.work_order_photos;
DROP POLICY IF EXISTS "auth_work_orders" ON public.work_orders;
DROP POLICY IF EXISTS "auth_ledger" ON public.ledger_entries_legacy_table;

-- --- {public} "Allow all" (anon-key cross-company leak on core data tables)
DROP POLICY IF EXISTS "Allow all" ON public.messages;
DROP POLICY IF EXISTS "Allow all" ON public.payments;
DROP POLICY IF EXISTS "Allow all" ON public.properties;
DROP POLICY IF EXISTS "Allow all" ON public.tenants;
DROP POLICY IF EXISTS "Allow all" ON public.work_orders;
DROP POLICY IF EXISTS "Allow all" ON public.utilities;
DROP POLICY IF EXISTS "Allow all" ON public.ledger_entries_legacy_table;
