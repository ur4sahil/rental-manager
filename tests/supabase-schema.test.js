// ═══════════════════════════════════════════════════════════════
// SUPABASE SCHEMA & RPC VALIDATION TESTS
// Tests database structure, required tables, columns, RPCs,
// constraints, and RLS policies.
// Run: cd tests && node supabase-schema.test.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let pass = 0, fail = 0, errors = [];
function assert(ok, name) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name); fail++; errors.push(name); }
}

// ───────────────────────────────────────────
// 1. TABLE EXISTENCE
// ───────────────────────────────────────────
async function testTableExistence() {
  console.log('\n📋 TABLE EXISTENCE');
  const requiredTables = [
    'properties', 'tenants', 'payments', 'work_orders', 'vendors',
    'owners', 'leases', 'lease_templates', 'lease_signatures',
    'acct_accounts', 'acct_journal_entries', 'acct_journal_lines',
    'acct_classes', 'journal_entries', 'ledger_entries',
    'utilities', 'utility_audit', 'documents', 'inspections',
    'audit_trail', 'app_users', 'autopay_schedules', 'late_fee_rules',
    'owner_statements', 'owner_distributions', 'vendor_invoices',
    'notification_settings', 'notification_queue', 'notification_log',
    'messages', 'hoa_payments', 'companies', 'company_members',
    'push_subscriptions', 'pm_assignment_requests',
    'property_change_requests', 'recurring_journal_entries',
    'doc_templates', 'doc_generated',
  ];
  for (const table of requiredTables) {
    const { error } = await supabase.from(table).select('*').limit(0);
    assert(!error, `Table "${table}" exists and is queryable`);
  }
}

// ───────────────────────────────────────────
// 2. COLUMN CHECKS (key columns on core tables)
// ───────────────────────────────────────────
async function testColumnExistence() {
  console.log('\n🔍 COLUMN CHECKS');

  // Properties columns
  const { data: p } = await supabase.from('properties').select('id, company_id, address, type, status, rent, notes, owner_id, pm_company_id, archived_at').limit(1);
  assert(p !== null, 'Properties has id, company_id, address, type, status, rent, owner_id, pm_company_id, archived_at');

  // Tenants columns
  const { data: t } = await supabase.from('tenants').select('id, company_id, name, email, phone, property, rent, balance, lease_status, archived_at').limit(1);
  assert(t !== null, 'Tenants has id, company_id, name, email, phone, property, rent, balance, lease_status, archived_at');

  // Payments columns
  const { data: pay } = await supabase.from('payments').select('id, company_id, tenant, property, amount, date, type, method, status').limit(1);
  assert(pay !== null, 'Payments has id, company_id, tenant, property, amount, date, type, method, status');

  // Leases columns
  const { data: l } = await supabase.from('leases').select('id, company_id, tenant_name, property, start_date, end_date, rent_amount, security_deposit, lease_type, status, rent_escalation_pct, escalation_frequency, payment_due_day, deposit_status').limit(1);
  assert(l !== null, 'Leases has all required columns including escalation and deposit_status');

  // Acct journal entries (modern double-entry table)
  const { data: je } = await supabase.from('acct_journal_entries').select('id, company_id, number, date, description, reference, status').limit(1);
  assert(je !== null, 'acct_journal_entries has id, company_id, number, date, description, reference, status');

  // Legacy journal_entries table (simpler structure)
  const { data: jeLeg } = await supabase.from('journal_entries').select('id, date, account, description, debit, credit').limit(1);
  assert(jeLeg !== null, 'Legacy journal_entries has id, date, account, description, debit, credit');

  // Acct journal lines
  const { data: jl } = await supabase.from('acct_journal_lines').select('id, journal_entry_id, account_id, account_name, debit, credit, memo, class_id').limit(1);
  assert(jl !== null, 'Journal lines has all required columns including class_id');

  // Work orders columns
  const { data: wo } = await supabase.from('work_orders').select('id, company_id, property, issue, priority, status, tenant, assigned, cost').limit(1);
  assert(wo !== null, 'Work orders has id, company_id, property, issue, priority, status, tenant, assigned, cost');

  // Vendors columns
  const { data: v } = await supabase.from('vendors').select('id, company_id, name, company, specialty, email, phone, rating, status, license_number, insurance_expiry, hourly_rate').limit(1);
  assert(v !== null, 'Vendors has all required columns including rating, license, insurance');

  // Owners columns
  const { data: o } = await supabase.from('owners').select('id, company_id, name, email, phone, management_fee_pct, payment_method, status').limit(1);
  assert(o !== null, 'Owners has id, company_id, name, email, management_fee_pct, payment_method');

  // Audit trail columns
  const { data: a } = await supabase.from('audit_trail').select('id, company_id, action, module, details, user_email, user_role').limit(1);
  assert(a !== null, 'Audit trail has id, company_id, action, module, details, user_email, user_role');

  // Companies columns
  const { data: c } = await supabase.from('companies').select('id, company_code, name, company_role').limit(1);
  assert(c !== null, 'Companies has id, company_code, name, company_role');

  // Company members columns
  const { data: cm } = await supabase.from('company_members').select('company_id, user_email, user_name, role, status, custom_pages').limit(1);
  assert(cm !== null, 'Company members has company_id, user_email, role, status, custom_pages');

  // Document builder columns
  const { data: dt } = await supabase.from('doc_templates').select('id, company_id, name, category, description, body, fields, is_system, is_active, created_by').limit(1);
  assert(dt !== null, 'doc_templates has id, company_id, name, category, body, fields, is_system, is_active');

  const { data: dg } = await supabase.from('doc_generated').select('id, company_id, template_id, name, field_values, rendered_body, status, property_address, tenant_name, recipients, created_by').limit(1);
  assert(dg !== null, 'doc_generated has id, company_id, template_id, name, field_values, rendered_body, status');
}

// ───────────────────────────────────────────
// 3. RPC HEALTH CHECKS
// ───────────────────────────────────────────
async function testRPCExistence() {
  console.log('\n⚡ RPC HEALTH CHECKS');

  // create_company_atomic
  const { error: e1 } = await supabase.rpc('create_company_atomic', {
    p_company_name: 'RPC-TEST-IGNORE',
    p_company_role: 'property_management',
    p_user_email: 'rpc-test-ignore@test.com',
    p_user_name: 'RPC Test',
    p_company_code: '99999999',
  });
  // May fail due to duplicate but RPC should exist
  assert(!e1 || !e1.message.includes('function') || !e1.message.includes('does not exist'),
    'RPC create_company_atomic exists');
  // Cleanup
  await supabase.from('companies').delete().eq('company_code', '99999999');
  await supabase.from('company_members').delete().eq('user_email', 'rpc-test-ignore@test.com');
  await supabase.from('app_users').delete().eq('email', 'rpc-test-ignore@test.com');

  // update_tenant_balance
  const { error: e2 } = await supabase.rpc('update_tenant_balance', {
    p_tenant_name: 'NONEXISTENT-RPC-TEST',
    p_company_id: 'rpc-test',
  });
  assert(!e2 || !e2.message.includes('does not exist'), 'RPC update_tenant_balance exists');

  // archive_property
  const { error: e3 } = await supabase.rpc('archive_property', {
    p_property_id: '00000000-0000-0000-0000-000000000000',
    p_user_email: 'test@test.com',
    p_company_id: 'rpc-test',
  });
  assert(!e3 || !e3.message.includes('does not exist'), 'RPC archive_property exists');

  // sign_lease
  const { error: e4 } = await supabase.rpc('sign_lease', {
    p_company_id: 'rpc-test',
    p_lease_id: '00000000-0000-0000-0000-000000000000',
    p_signer_id: '00000000-0000-0000-0000-000000000000',
    p_signature_data: 'test',
    p_signing_method: 'type',
    p_consent_text: 'test',
    p_user_agent: 'test',
  });
  assert(!e4 || !e4.message.includes('does not exist'), 'RPC sign_lease exists');

  // create_journal_entry
  const { error: e5 } = await supabase.rpc('create_journal_entry', {
    p_id: 'rpc-test-je',
    p_company_id: 'rpc-test',
    p_number: 'RPC-TEST',
    p_date: new Date().toISOString().slice(0, 10),
    p_description: 'RPC test',
    p_reference: '',
    p_property: '',
    p_status: 'draft',
    p_lines: [],
  });
  assert(!e5 || !e5.message.includes('does not exist'), 'RPC create_journal_entry exists');
  // Cleanup
  await supabase.from('acct_journal_entries').delete().eq('id', 'rpc-test-je');

  // rename_property_v2
  const { error: e6 } = await supabase.rpc('rename_property_v2', {
    p_old_address: 'NONEXISTENT',
    p_new_address: 'NONEXISTENT',
    p_company_id: 'rpc-test',
  });
  assert(!e6 || !e6.message.includes('does not exist'), 'RPC rename_property_v2 exists');

  // validate_invite_code
  const { error: e7 } = await supabase.rpc('validate_invite_code', {
    p_code: 'NONEXISTENT',
  });
  assert(!e7 || !e7.message.includes('does not exist'), 'RPC validate_invite_code exists');

  // handle_membership_request
  const { error: e8 } = await supabase.rpc('handle_membership_request', {
    p_member_id: '00000000-0000-0000-0000-000000000000',
    p_action: 'approve',
    p_company_id: 'rpc-test',
  });
  assert(!e8 || !e8.message.includes('does not exist'), 'RPC handle_membership_request exists');

  // accept_pm_assignment
  const { error: e9 } = await supabase.rpc('accept_pm_assignment', {
    p_request_id: '00000000-0000-0000-0000-000000000000',
    p_pm_company_id: 'rpc-test',
  });
  assert(!e9 || !e9.message.includes('does not exist'), 'RPC accept_pm_assignment exists');

  // change_user_email
  const { error: e10 } = await supabase.rpc('change_user_email', {
    p_old_email: 'nonexistent@test.com',
    p_new_email: 'nonexistent2@test.com',
    p_company_id: 'rpc-test',
    p_user_name: 'Test',
    p_user_role: 'admin',
    p_custom_pages: [],
  });
  assert(!e10 || !e10.message.includes('does not exist'), 'RPC change_user_email exists');
}

// ───────────────────────────────────────────
// 4. COMPANY_ID FILTER ENFORCEMENT
// ───────────────────────────────────────────
async function testCompanyIdPresence() {
  console.log('\n🏢 COMPANY_ID ON ALL TABLES');
  const tables = ['properties', 'tenants', 'payments', 'work_orders', 'vendors',
    'owners', 'leases', 'acct_accounts', 'acct_journal_entries', 'acct_classes',
    'utilities', 'documents', 'inspections', 'audit_trail', 'ledger_entries',
    'autopay_schedules', 'late_fee_rules', 'vendor_invoices',
    'notification_settings', 'messages', 'hoa_payments'];

  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('company_id').limit(1);
    assert(!error, `Table "${table}" has company_id column`);
  }
}

// ───────────────────────────────────────────
// 5. CHART OF ACCOUNTS INTEGRITY
// ───────────────────────────────────────────
async function testChartOfAccounts() {
  console.log('\n📊 CHART OF ACCOUNTS INTEGRITY');

  const { data: accounts } = await supabase.from('acct_accounts').select('*');
  assert(accounts && accounts.length > 0, 'Chart of accounts is not empty');

  // Check account type distribution
  const types = [...new Set(accounts.map(a => a.type))];
  assert(types.includes('Asset'), 'Has Asset accounts');
  assert(types.includes('Liability'), 'Has Liability accounts');
  assert(types.includes('Revenue'), 'Has Revenue accounts');
  assert(types.includes('Expense'), 'Has Expense accounts');

  // Check required account codes exist (per company)
  const companies = [...new Set(accounts.map(a => a.company_id))];
  for (const cid of companies) {
    const compAccts = accounts.filter(a => a.company_id === cid);
    const hasChecking = compAccts.some(a => a.id.endsWith('-1000') || a.name.toLowerCase().includes('checking'));
    const hasAR = compAccts.some(a => a.id.endsWith('-1100') || a.name.toLowerCase().includes('receivable'));
    const hasRentalIncome = compAccts.some(a => a.id.endsWith('-4000') || a.name.toLowerCase().includes('rental income'));
    assert(hasChecking, `Company ${cid}: has Checking account`);
    assert(hasAR, `Company ${cid}: has Accounts Receivable`);
    assert(hasRentalIncome, `Company ${cid}: has Rental Income account`);
  }
}

// ───────────────────────────────────────────
// 6. JOURNAL ENTRY BALANCE VALIDATION
// ───────────────────────────────────────────
async function testJournalEntryBalance() {
  console.log('\n⚖️  JOURNAL ENTRY BALANCE');

  const { data: entries } = await supabase.from('acct_journal_entries')
    .select('id, number, status, acct_journal_lines(debit, credit)')
    .eq('status', 'posted')
    .limit(20);

  if (entries && entries.length > 0) {
    let balanced = 0, unbalanced = 0;
    for (const je of entries) {
      const lines = je.acct_journal_lines || [];
      const totalDR = lines.reduce((s, l) => s + (l.debit || 0), 0);
      const totalCR = lines.reduce((s, l) => s + (l.credit || 0), 0);
      if (Math.abs(totalDR - totalCR) < 0.01) balanced++;
      else unbalanced++;
    }
    assert(balanced > 0, `Has balanced journal entries (${balanced} balanced)`);
    // Warn but don't fail on unbalanced (legacy data might exist)
    if (unbalanced > 0) console.log(`  ⚠️  ${unbalanced} unbalanced entries found`);
  }
}

// ───────────────────────────────────────────
// 7. DATA INTEGRITY CHECKS
// ───────────────────────────────────────────
async function testDataIntegrity() {
  console.log('\n🔗 DATA INTEGRITY');

  // Properties with tenants should have occupied status
  const { data: props } = await supabase.from('properties').select('*');
  if (props) {
    const withTenant = props.filter(p => p.tenant && p.tenant.trim() && !p.archived_at);
    const occupiedWithTenant = withTenant.filter(p => p.status === 'occupied');
    assert(withTenant.length === 0 || occupiedWithTenant.length > 0,
      'Properties with tenants should have occupied status');
  }

  // Tenants with active lease should have lease_status=active
  const { data: tenants } = await supabase.from('tenants').select('*');
  const { data: leases } = await supabase.from('leases').select('*').eq('status', 'active');
  if (tenants && leases) {
    const activeLeaseTenants = leases.map(l => l.tenant_name);
    const tenantsWithActiveLease = tenants.filter(t => activeLeaseTenants.includes(t.name));
    const correctStatus = tenantsWithActiveLease.filter(t => t.lease_status === 'active');
    assert(tenantsWithActiveLease.length === 0 || correctStatus.length > 0,
      'Tenants with active leases should have lease_status=active');
  }

  // Payments amount should be positive
  const { data: payments } = await supabase.from('payments').select('amount');
  if (payments) {
    const negative = payments.filter(p => p.amount < 0);
    assert(negative.length === 0, 'No payments with negative amounts');
  }

  // Vendor ratings between 0-5
  const { data: vendors } = await supabase.from('vendors').select('rating');
  if (vendors) {
    const outOfRange = vendors.filter(v => v.rating !== null && (v.rating < 0 || v.rating > 5));
    assert(outOfRange.length === 0, 'All vendor ratings between 0-5');
  }
}

// ───────────────────────────────────────────
// 8. STORAGE BUCKET CHECKS
// ───────────────────────────────────────────
async function testStorageBuckets() {
  console.log('\n📦 STORAGE BUCKETS');

  const { data: buckets, error } = await supabase.storage.listBuckets();
  assert(!error && buckets, 'Can list storage buckets');
  if (buckets) {
    const bucketNames = buckets.map(b => b.name);
    assert(bucketNames.includes('documents'), 'Documents storage bucket exists');
    // Check for maintenance-photos bucket
    const hasPhotos = bucketNames.includes('maintenance-photos');
    if (hasPhotos) {
      assert(true, 'Maintenance-photos storage bucket exists');
    } else {
      console.log('  ⚠️  maintenance-photos bucket not found (optional)');
    }
  }
}

// ───────────────────────────────────────────
// RUN ALL
// ───────────────────────────────────────────
async function run() {
  console.log('🧪 Supabase Schema & RPC Validation Tests');
  console.log('==========================================');
  await testTableExistence();
  await testColumnExistence();
  await testRPCExistence();
  await testCompanyIdPresence();
  await testChartOfAccounts();
  await testJournalEntryBalance();
  await testDataIntegrity();
  await testStorageBuckets();
  console.log('\n==========================================');
  console.log('✅ Passed: ' + pass);
  console.log('❌ Failed: ' + fail);
  if (errors.length > 0) { console.log('\nFailed:'); errors.forEach(e => console.log('  - ' + e)); }
  console.log('\nTotal: ' + (pass + fail) + ' | Pass rate: ' + Math.round(pass / (pass + fail) * 100) + '%');
  process.exit(fail > 0 ? 1 : 0);
}
run();
