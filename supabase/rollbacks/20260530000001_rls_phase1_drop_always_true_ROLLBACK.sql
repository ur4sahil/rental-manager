-- ROLLBACK for 20260530000001_rls_phase1_drop_always_true.sql
-- Recreates the exact legacy always-true policies that were dropped, in case
-- Phase 1 breaks a live access path. Run this in the Supabase SQL editor (or
-- via apply_migration) to restore the pre-Phase-1 state. NOT auto-applied.
-- ⚠️ This REOPENS the cross-company leak — use only to unblock, then re-fix.

-- {authenticated} auth_* (ALL = USING(true) WITH CHECK(true))
CREATE POLICY "auth_acct_accounts" ON public.acct_accounts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_acct_classes" ON public.acct_classes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_acct_journal_entries" ON public.acct_journal_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_acct_journal_lines" ON public.acct_journal_lines FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_audit_trail" ON public.audit_trail FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can manage autopay_schedules" ON public.autopay_schedules FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_autopay" ON public.autopay_schedules FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_bank_recon" ON public.bank_reconciliations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can manage documents" ON public.documents FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_documents" ON public.documents FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_inspections" ON public.inspections FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can manage late_fee_rules" ON public.late_fee_rules FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_latefees" ON public.late_fee_rules FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_lease_sigs" ON public.lease_signatures FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_lease_templates" ON public.lease_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_leases" ON public.leases FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_messages" ON public.messages FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_notif_log" ON public.notification_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_notif_settings" ON public.notification_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_payments" ON public.payments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_properties" ON public.properties FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_property_change_requests" ON public.property_change_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_utilities" ON public.utilities FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for authenticated" ON public.utility_audit FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_vendor_invoices" ON public.vendor_invoices FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_vendors" ON public.vendors FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can manage work_order_photos" ON public.work_order_photos FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_wo_photos" ON public.work_order_photos FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_work_orders" ON public.work_orders FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_ledger" ON public.ledger_entries_legacy_table FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- {public} "Allow all" (ALL = USING(true), no WITH CHECK on the originals)
CREATE POLICY "Allow all" ON public.messages FOR ALL TO public USING (true);
CREATE POLICY "Allow all" ON public.payments FOR ALL TO public USING (true);
CREATE POLICY "Allow all" ON public.properties FOR ALL TO public USING (true);
CREATE POLICY "Allow all" ON public.tenants FOR ALL TO public USING (true);
CREATE POLICY "Allow all" ON public.work_orders FOR ALL TO public USING (true);
CREATE POLICY "Allow all" ON public.utilities FOR ALL TO public USING (true);
CREATE POLICY "Allow all" ON public.ledger_entries_legacy_table FOR ALL TO public USING (true);
