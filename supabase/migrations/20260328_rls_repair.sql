-- ============================================================
-- Role-Aware RLS: Tenant/Owner data isolation at database level
-- ============================================================
-- Policies are OR'd per operation: a user matching ANY policy gets access.
-- Strategy:
--   Policy 1 (staff): admin/office_assistant/accountant/maintenance → all company data
--   Policy 2 (tenant_self): tenant role → only their own rows
--   Policy 3 (owner_self): owner role → only their own rows
-- ============================================================

-- Helper functions (CREATE OR REPLACE is safe if they already exist)
CREATE OR REPLACE FUNCTION is_company_staff(p_company_id TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND (auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email()))
    AND status = 'active'
    AND role NOT IN ('tenant', 'owner')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION is_company_member(p_company_id TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM company_members
    WHERE company_id = p_company_id
    AND (auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email()))
    AND status = 'active'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_tenant_name(p_company_id TEXT)
RETURNS TEXT AS $$
  SELECT t.name FROM tenants t
  JOIN company_members cm ON cm.company_id = t.company_id AND lower(cm.user_email) = lower(t.email)
  WHERE cm.company_id = p_company_id
  AND (cm.auth_user_id = auth.uid() OR lower(cm.user_email) = lower(auth.email()))
  AND cm.status = 'active' AND cm.role = 'tenant' AND t.archived_at IS NULL
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_owner_id(p_company_id TEXT)
RETURNS UUID AS $$
  SELECT o.id FROM owners o
  JOIN company_members cm ON cm.company_id = o.company_id AND lower(cm.user_email) = lower(o.email)
  WHERE cm.company_id = p_company_id
  AND (cm.auth_user_id = auth.uid() OR lower(cm.user_email) = lower(auth.email()))
  AND cm.status = 'active' AND cm.role = 'owner'
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Enable RLS on all tables (safe to re-run)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE autopay_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_order_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE acct_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE acct_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE acct_journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE acct_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_trail ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE late_fee_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hoa_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE utilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE lease_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;

-- Drop ALL existing policies that may have been partially applied
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE policyname LIKE '%_staff'
       OR policyname LIKE '%_tenant%'
       OR policyname LIKE '%_owner%'
       OR policyname LIKE '%_self'
       OR policyname LIKE 'cm_%'
       OR policyname LIKE 'notif_inbox_%'
  ) LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- Also drop the old doc builder policies if they still exist
DROP POLICY IF EXISTS "doc_templates_company" ON doc_templates;
DROP POLICY IF EXISTS "doc_generated_company" ON doc_generated;

-- ============================================================
-- Re-create all policies cleanly
-- ============================================================

-- TENANTS
CREATE POLICY "tenants_staff" ON tenants FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "tenants_self" ON tenants FOR SELECT USING (
  lower(email) = lower(auth.email()) AND is_company_member(company_id)
);

-- PAYMENTS
CREATE POLICY "payments_staff" ON payments FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "payments_tenant_read" ON payments FOR SELECT USING (tenant = get_tenant_name(company_id));
CREATE POLICY "payments_tenant_insert" ON payments FOR INSERT WITH CHECK (tenant = get_tenant_name(company_id));

-- WORK ORDERS
CREATE POLICY "work_orders_staff" ON work_orders FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "work_orders_tenant_read" ON work_orders FOR SELECT USING (tenant = get_tenant_name(company_id));
CREATE POLICY "work_orders_tenant_insert" ON work_orders FOR INSERT WITH CHECK (tenant = get_tenant_name(company_id));

-- DOCUMENTS
CREATE POLICY "documents_staff" ON documents FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "documents_tenant" ON documents FOR SELECT USING (
  tenant_visible = true AND lower(tenant) = lower(coalesce(get_tenant_name(company_id), ''))
);

-- LEASES
CREATE POLICY "leases_staff" ON leases FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "leases_tenant" ON leases FOR SELECT USING (tenant_name = get_tenant_name(company_id));

-- MESSAGES
CREATE POLICY "messages_staff" ON messages FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "messages_tenant" ON messages FOR ALL USING (tenant = get_tenant_name(company_id));

-- AUTOPAY SCHEDULES
CREATE POLICY "autopay_staff" ON autopay_schedules FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "autopay_tenant" ON autopay_schedules FOR ALL USING (tenant = get_tenant_name(company_id));

-- WORK ORDER PHOTOS
CREATE POLICY "wo_photos_staff" ON work_order_photos FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "wo_photos_tenant" ON work_order_photos FOR SELECT USING (
  EXISTS (SELECT 1 FROM work_orders wo WHERE wo.id::text = work_order_photos.work_order_id::text AND wo.tenant = get_tenant_name(wo.company_id))
);

-- OWNERS
CREATE POLICY "owners_staff" ON owners FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "owners_self" ON owners FOR SELECT USING (lower(email) = lower(auth.email()) AND is_company_member(company_id));

-- PROPERTIES
CREATE POLICY "properties_staff" ON properties FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "properties_owner" ON properties FOR SELECT USING (owner_id = get_owner_id(company_id));
CREATE POLICY "properties_tenant" ON properties FOR SELECT USING (
  address IN (SELECT property FROM tenants WHERE name = get_tenant_name(properties.company_id) AND company_id = properties.company_id AND archived_at IS NULL)
);

-- OWNER STATEMENTS
CREATE POLICY "owner_stmts_staff" ON owner_statements FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "owner_stmts_self" ON owner_statements FOR SELECT USING (owner_id = get_owner_id(company_id));

-- OWNER DISTRIBUTIONS
CREATE POLICY "owner_dist_staff" ON owner_distributions FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "owner_dist_self" ON owner_distributions FOR SELECT USING (owner_id = get_owner_id(company_id));

-- STAFF-ONLY TABLES
CREATE POLICY "vendors_staff" ON vendors FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "vendor_inv_staff" ON vendor_invoices FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "acct_accounts_staff" ON acct_accounts FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "acct_je_staff" ON acct_journal_entries FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "acct_jl_staff" ON acct_journal_lines FOR ALL USING (
  EXISTS (SELECT 1 FROM acct_journal_entries je WHERE je.id = acct_journal_lines.journal_entry_id AND is_company_staff(je.company_id))
);
CREATE POLICY "acct_classes_staff" ON acct_classes FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "ledger_staff" ON ledger_entries FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "audit_staff" ON audit_trail FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "app_users_staff" ON app_users FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "late_fees_staff" ON late_fee_rules FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "hoa_staff" ON hoa_payments FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "utilities_staff" ON utilities FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "util_accts_staff" ON utility_accounts FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "inspections_staff" ON inspections FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "recurring_je_staff" ON recurring_journal_entries FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "lease_tmpl_staff" ON lease_templates FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "notif_settings_staff" ON notification_settings FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "notif_log_staff" ON notification_log FOR ALL USING (is_company_staff(company_id));

-- DOC BUILDER (replace old generic policies)
CREATE POLICY "doc_templates_staff" ON doc_templates FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "doc_generated_staff" ON doc_generated FOR ALL USING (is_company_staff(company_id));
CREATE POLICY "doc_generated_tenant" ON doc_generated FOR SELECT USING (tenant_name = get_tenant_name(company_id));

-- COMPANY MEMBERS (users can read their own, staff can manage)
CREATE POLICY "cm_read_own" ON company_members FOR SELECT USING (
  auth_user_id = auth.uid() OR lower(user_email) = lower(auth.email())
);
CREATE POLICY "cm_staff_all" ON company_members FOR ALL USING (is_company_staff(company_id));
