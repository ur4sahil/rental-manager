-- Core indexes for multi-tenant query performance
-- All active queries filter by company_id; most also filter by status or archived_at

-- Properties
CREATE INDEX IF NOT EXISTS idx_properties_company ON properties(company_id);
CREATE INDEX IF NOT EXISTS idx_properties_company_archived ON properties(company_id, archived_at);

-- Tenants
CREATE INDEX IF NOT EXISTS idx_tenants_company ON tenants(company_id);
CREATE INDEX IF NOT EXISTS idx_tenants_company_archived ON tenants(company_id, archived_at);

-- Payments
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_company_status ON payments(company_id, status);
CREATE INDEX IF NOT EXISTS idx_payments_company_date ON payments(company_id, date);

-- Leases
CREATE INDEX IF NOT EXISTS idx_leases_company ON leases(company_id);
CREATE INDEX IF NOT EXISTS idx_leases_company_status ON leases(company_id, status);

-- Work Orders
CREATE INDEX IF NOT EXISTS idx_work_orders_company ON work_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_work_orders_company_status ON work_orders(company_id, status);

-- Audit Trail (grows continuously — index on created_at for time-range queries)
CREATE INDEX IF NOT EXISTS idx_audit_trail_company ON audit_trail(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_trail_company_created ON audit_trail(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_company_module ON audit_trail(company_id, module);

-- Ledger Entries
CREATE INDEX IF NOT EXISTS idx_ledger_entries_company ON ledger_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_company_tenant ON ledger_entries(company_id, tenant);

-- Journal Entries
CREATE INDEX IF NOT EXISTS idx_acct_je_company ON acct_journal_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_acct_je_company_date ON acct_journal_entries(company_id, date);
CREATE INDEX IF NOT EXISTS idx_acct_jl_entry ON acct_journal_lines(journal_entry_id);

-- Utilities
CREATE INDEX IF NOT EXISTS idx_utilities_company ON utilities(company_id);
CREATE INDEX IF NOT EXISTS idx_utilities_company_status ON utilities(company_id, status);

-- Documents
CREATE INDEX IF NOT EXISTS idx_documents_company ON documents(company_id);

-- Vendors
CREATE INDEX IF NOT EXISTS idx_vendors_company ON vendors(company_id);

-- Owners
CREATE INDEX IF NOT EXISTS idx_owners_company ON owners(company_id);

-- Notification Queue (processed by background worker)
CREATE INDEX IF NOT EXISTS idx_notif_queue_status ON notification_queue(status, created_at);

-- Company Members (role lookups)
CREATE INDEX IF NOT EXISTS idx_company_members_user ON company_members(auth_user_id, status);
CREATE INDEX IF NOT EXISTS idx_company_members_email ON company_members(email, status);

-- Autopay Schedules
CREATE INDEX IF NOT EXISTS idx_autopay_company ON autopay_schedules(company_id);

-- Late Fee Rules
CREATE INDEX IF NOT EXISTS idx_late_fee_rules_company ON late_fee_rules(company_id);
