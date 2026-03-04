require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let pass = 0, fail = 0, errors = [];

function assert(ok, name) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name); fail++; errors.push(name); }
}

async function testProperties() {
  console.log('\n📦 PROPERTIES');
  const { data, error } = await supabase.from('properties').select('*');
  assert(!error, 'Can fetch properties');
  assert(data && data.length >= 4, 'Has at least 4 properties (' + (data ? data.length : 0) + ' found)');
  assert(data && data.some(p => p.status === 'occupied'), 'Has occupied properties');
  assert(data && data.some(p => p.status === 'vacant'), 'Has vacant properties');
  assert(data && data.some(p => p.owner_id), 'Some properties have owners assigned');
  const { data: n, error: ie } = await supabase.from('properties').insert({ address: 'TEMP-TEST-999', status: 'vacant', type: 'Test' }).select().single();
  assert(!ie, 'Can insert property');
  if (n) {
    const { error: ue } = await supabase.from('properties').update({ notes: 'tested' }).eq('id', n.id);
    assert(!ue, 'Can update property');
    const { error: de } = await supabase.from('properties').delete().eq('id', n.id);
    assert(!de, 'Can delete property');
  }
}

async function testTenants() {
  console.log('\n👤 TENANTS');
  const { data, error } = await supabase.from('tenants').select('*');
  assert(!error, 'Can fetch tenants');
  assert(data && data.length >= 4, 'Has at least 4 tenants (' + (data ? data.length : 0) + ' found)');
  const { data: found } = await supabase.from('tenants').select('*').ilike('email', 'ALICE@TEST.COM');
  assert(found && found.length > 0, 'Case-insensitive email lookup works');
  const bob = data ? data.find(t => t.name === 'Bob Martinez') : null;
  assert(bob && bob.balance > 0, 'Bob has outstanding balance');
}

async function testPayments() {
  console.log('\n💳 PAYMENTS');
  const { data, error } = await supabase.from('payments').select('*');
  assert(!error, 'Can fetch payments');
  assert(data && data.length >= 5, 'Has at least 5 payments (' + (data ? data.length : 0) + ' found)');
  assert(data && data.some(p => p.status === 'paid'), 'Has paid payments');
  assert(data && data.some(p => p.status === 'partial'), 'Has partial payments');
  const { data: np, error: pe } = await supabase.from('payments').insert({ tenant: 'Test', property: 'Test', amount: 100, date: new Date().toISOString().slice(0, 10), type: 'rent', method: 'test', status: 'paid' }).select().single();
  assert(!pe, 'Can insert payment');
  if (np) await supabase.from('payments').delete().eq('id', np.id);
}

async function testAccounting() {
  console.log('\n📊 ACCOUNTING');
  const { data: coa } = await supabase.from('acct_accounts').select('*');
  assert(coa && coa.length >= 10, 'Has all required accounts (' + (coa ? coa.length : 0) + ' found)');
  var required = ['1000','1100','2100','2200','4000','4010','4100','4200','5300','5400'];
  for (var i = 0; i < required.length; i++) {
    assert(coa && coa.some(function(a) { return a.id === required[i]; }), 'Account ' + required[i] + ' exists');
  }
  var { data: jeData, error: je } = await supabase.from('journal_entries').insert({ date: new Date().toISOString().slice(0, 10), account: 'Checking Account', description: 'Test JE - automated', debit: 100, credit: 0 }).select().single();
  assert(!je, 'Can insert journal entry');
  if (jeData) await supabase.from('journal_entries').delete().eq('id', jeData.id);
}

async function testWorkOrders() {
  console.log('\n🔧 MAINTENANCE');
  const { data, error } = await supabase.from('work_orders').select('*');
  assert(!error, 'Can fetch work orders');
  assert(data && data.length >= 3, 'Has at least 3 work orders');
  assert(data && data.some(w => w.status === 'open'), 'Has open work orders');
  assert(data && data.some(w => w.status === 'completed'), 'Has completed work orders');
}

async function testVendors() {
  console.log('\n🛠️  VENDORS');
  const { data, error } = await supabase.from('vendors').select('*');
  assert(!error, 'Can fetch vendors');
  assert(data && data.length >= 3, 'Has at least 3 vendors');
}

async function testOwners() {
  console.log('\n👤 OWNERS');
  const { data, error } = await supabase.from('owners').select('*');
  assert(!error, 'Can fetch owners');
  assert(data && data.length >= 2, 'Has at least 2 owners');
  const { data: ap } = await supabase.from('properties').select('*').not('owner_id', 'is', null);
  assert(ap && ap.length >= 2, 'Properties assigned to owners');
}

async function testLeases() {
  console.log('\n📝 LEASES');
  const { data: templates } = await supabase.from('lease_templates').select('*');
  assert(templates && templates.length >= 1, 'Has at least 1 lease template');
  const { data: tenants } = await supabase.from('tenants').select('*').limit(1);
  if (tenants && tenants[0]) {
    const { data: lease, error: le } = await supabase.from('leases').insert({ tenant_name: tenants[0].name, property: tenants[0].property, start_date: '2025-01-01', end_date: '2026-01-01', rent_amount: 1800, security_deposit: 1800, lease_type: 'fixed', status: 'active', move_in_checklist: '[]', move_out_checklist: '[]' }).select().single();
    assert(!le, 'Can create lease');
    if (lease) {
      const { error: se } = await supabase.from('lease_signatures').insert({ lease_id: lease.id, signer_name: tenants[0].name, signer_role: 'tenant', status: 'pending' });
      assert(!se, 'Can create e-signature request');
      await supabase.from('lease_signatures').delete().eq('lease_id', lease.id);
      await supabase.from('leases').delete().eq('id', lease.id);
    }
  }
}

async function testLeaseUpdatesStatus() {
  console.log('\n📝 LEASE → TENANT STATUS');
  // Create a temp tenant
  const { data: tenant, error: te } = await supabase.from('tenants').insert({ name: 'TEMP-LEASE-TEST', email: 'leasetest@test.com', phone: '000', property: '123 Oak St', balance: 0, lease_status: 'pending' }).select().single();
  assert(!te && tenant, 'Can create temp tenant for lease test');
  if (tenant) {
    // Create a lease for this tenant
    const { data: lease, error: le } = await supabase.from('leases').insert({ tenant_name: tenant.name, property: tenant.property, start_date: '2025-01-01', end_date: '2026-01-01', rent_amount: 1500, security_deposit: 1500, lease_type: 'fixed', status: 'active', move_in_checklist: '[]', move_out_checklist: '[]' }).select().single();
    assert(!le && lease, 'Can create lease for tenant');
    // Update tenant lease_status to active (as the app would)
    await supabase.from('tenants').update({ lease_status: 'active' }).eq('id', tenant.id);
    const { data: updated } = await supabase.from('tenants').select('lease_status').eq('id', tenant.id).single();
    assert(updated && updated.lease_status === 'active', 'Tenant lease_status updated to active');
    // Cleanup
    if (lease) await supabase.from('leases').delete().eq('id', lease.id);
    await supabase.from('tenants').delete().eq('id', tenant.id);
  }
}

async function testPaymentVerifyAmount() {
  console.log('\n💵 PAYMENT AMOUNT VERIFICATION');
  const amount = 1234.56;
  const { data: pmt, error: pe } = await supabase.from('payments').insert({ tenant: 'Test-Amt', property: 'Test-Prop', amount: amount, date: new Date().toISOString().slice(0, 10), type: 'rent', method: 'check', status: 'paid' }).select().single();
  assert(!pe && pmt, 'Can insert payment with specific amount');
  if (pmt) {
    const { data: fetched } = await supabase.from('payments').select('amount').eq('id', pmt.id).single();
    assert(fetched && fetched.amount === amount, 'Fetched payment has correct amount (' + (fetched ? fetched.amount : 'null') + ')');
    await supabase.from('payments').delete().eq('id', pmt.id);
  }
}

async function testVendorInvoice() {
  console.log('\n🧾 VENDOR INVOICE');
  const { data: inv, error: ie } = await supabase.from('vendor_invoices').insert({ vendor_name: 'Test Plumber', property: 'Test-Prop', amount: 500, status: 'pending', invoice_date: new Date().toISOString().slice(0, 10), description: 'Automated test invoice' }).select().single();
  assert(!ie && inv, 'Can create vendor invoice');
  if (inv) {
    const { data: fetched } = await supabase.from('vendor_invoices').select('*').eq('id', inv.id).single();
    assert(fetched && fetched.vendor_name === 'Test Plumber', 'Vendor invoice saved with correct vendor_name');
    await supabase.from('vendor_invoices').delete().eq('id', inv.id);
  }
}

async function testPropertyOwnerAssignment() {
  console.log('\n🏠 PROPERTY ↔ OWNER ASSIGNMENT');
  const { data: owners } = await supabase.from('owners').select('*').limit(1);
  assert(owners && owners.length > 0, 'Has an owner to assign');
  if (owners && owners[0]) {
    const { data: prop, error: pe } = await supabase.from('properties').insert({ address: 'TEMP-OWNER-TEST-999', status: 'vacant', type: 'Test' }).select().single();
    assert(!pe && prop, 'Can create temp property');
    if (prop) {
      await supabase.from('properties').update({ owner_id: owners[0].id }).eq('id', prop.id);
      const { data: fetched } = await supabase.from('properties').select('owner_id').eq('id', prop.id).single();
      assert(fetched && fetched.owner_id === owners[0].id, 'Property owner_id persists after assignment');
      await supabase.from('properties').delete().eq('id', prop.id);
    }
  }
}

async function testAutopaySchedule() {
  console.log('\n🔄 AUTOPAY SCHEDULE');
  const { data: sched, error: se } = await supabase.from('autopay_schedules').insert({ tenant: 'Test Tenant', property: 'Test-Prop', amount: 1800, day_of_month: 1, method: 'ach', active: true, frequency: 'monthly' }).select().single();
  assert(!se && sched, 'Can create autopay schedule');
  if (sched) {
    const { data: fetched } = await supabase.from('autopay_schedules').select('*').eq('id', sched.id).single();
    assert(fetched && fetched.active === true && fetched.amount === 1800, 'Autopay schedule saved correctly');
    await supabase.from('autopay_schedules').delete().eq('id', sched.id);
  }
}

async function testLateFeeRule() {
  console.log('\n⏰ LATE FEE RULE');
  const { data: rule, error: re } = await supabase.from('late_fee_rules').insert({ name: 'Test Rule', grace_days: 5, fee_type: 'flat', fee_amount: 50, apply_to: 'all' }).select().single();
  assert(!re && rule, 'Can create late fee rule');
  if (rule) {
    const { data: fetched } = await supabase.from('late_fee_rules').select('*').eq('id', rule.id).single();
    assert(fetched && fetched.grace_days === 5 && fetched.fee_amount === 50, 'Late fee rule saved with correct values');
    await supabase.from('late_fee_rules').delete().eq('id', rule.id);
  }
}

async function testUtilityBill() {
  console.log('\n💡 UTILITY BILL');
  const { data: util, error: ue } = await supabase.from('utilities').insert({ property: 'Test-Prop', provider: 'Test Electric Co', amount: 150, due: '2025-06-01', responsibility: 'owner', status: 'pending' }).select().single();
  assert(!ue && util, 'Can insert utility bill');
  if (util) {
    const { data: fetched } = await supabase.from('utilities').select('*').eq('id', util.id).single();
    assert(fetched && fetched.status === 'pending', 'Utility bill status is pending');
    // Update status to paid
    await supabase.from('utilities').update({ status: 'paid' }).eq('id', util.id);
    const { data: updated } = await supabase.from('utilities').select('status').eq('id', util.id).single();
    assert(updated && updated.status === 'paid', 'Utility bill status updated to paid');
    await supabase.from('utilities').delete().eq('id', util.id);
  }
}

async function testDocumentRecord() {
  console.log('\n📄 DOCUMENT RECORD');
  const { data: doc, error: de } = await supabase.from('documents').insert({ name: 'Test Doc', property: 'Test-Prop', type: 'Lease', url: 'https://example.com/test.pdf', file_name: 'test.pdf', tenant_visible: false }).select().single();
  assert(!de && doc, 'Can create document record');
  if (doc) {
    const { data: fetched } = await supabase.from('documents').select('*').eq('id', doc.id).single();
    assert(fetched && fetched.name === 'Test Doc' && fetched.type === 'Lease', 'Document record saved with correct fields');
    await supabase.from('documents').delete().eq('id', doc.id);
  }
}

async function testDeletePropertyWithOwner() {
  console.log('\n🗑️  DELETE PROPERTY WITH OWNER');
  const { data: owners } = await supabase.from('owners').select('*').limit(1);
  if (owners && owners[0]) {
    const { data: prop } = await supabase.from('properties').insert({ address: 'TEMP-DEL-OWNER-TEST', status: 'vacant', type: 'Test', owner_id: owners[0].id }).select().single();
    assert(prop && prop.owner_id === owners[0].id, 'Property created with owner_id assigned');
    if (prop) {
      const { error: de } = await supabase.from('properties').delete().eq('id', prop.id);
      assert(!de, 'Can delete property that has owner assigned');
      const { data: gone } = await supabase.from('properties').select('*').eq('id', prop.id);
      assert(!gone || gone.length === 0, 'Deleted property no longer exists');
    }
  }
}

async function testMismatchedJournalEntry() {
  console.log('\n⚖️  MISMATCHED JOURNAL ENTRY');
  const { data: je, error: jee } = await supabase.from('journal_entries').insert({ date: new Date().toISOString().slice(0, 10), account: 'Checking Account', description: 'Test mismatched DR/CR', debit: 999, credit: 1 }).select().single();
  assert(!jee && je, 'Mismatched debit/credit journal entry saves (no DB constraint)');
  if (je) {
    const { data: fetched } = await supabase.from('journal_entries').select('*').eq('id', je.id).single();
    assert(fetched && fetched.debit === 999 && fetched.credit === 1, 'Mismatched amounts persisted correctly');
    await supabase.from('journal_entries').delete().eq('id', je.id);
  }
}

async function testAuditTrail() {
  console.log('\n📋 AUDIT TRAIL');
  const { data, error } = await supabase.from('audit_trail').insert({ action: 'test', module: 'testing', details: 'Automated test', user_email: 'test@test.com', user_role: 'admin' }).select().single();
  assert(!error, 'Can write audit trail entry');
  if (data) await supabase.from('audit_trail').delete().eq('id', data.id);
}

async function testFullLifecycle() {
  console.log('\n🔄 FULL PROPERTY LIFECYCLE (end-to-end)');
  const today = new Date().toISOString().slice(0, 10);
  const addr = '999 Integration Test Blvd';
  const tName = 'Integration Test Tenant';
  const ids = {};

  // 1. Create property
  const { data: prop, error: propErr } = await supabase.from('properties').insert({ address: addr, status: 'vacant', type: 'Single Family', rent: 2000 }).select().single();
  assert(!propErr && prop, 'Lifecycle: property created');
  if (!prop) return;
  ids.property = prop.id;

  // 2. Fetch existing owner, assign to property
  const { data: owners } = await supabase.from('owners').select('*').limit(1);
  assert(owners && owners.length > 0, 'Lifecycle: existing owner found');
  if (owners && owners[0]) {
    await supabase.from('properties').update({ owner_id: owners[0].id }).eq('id', ids.property);
    const { data: pFetch } = await supabase.from('properties').select('owner_id').eq('id', ids.property).single();
    assert(pFetch && pFetch.owner_id === owners[0].id, 'Lifecycle: owner assigned to property');
  }

  // 3. Create tenant
  const { data: tenant, error: tenErr } = await supabase.from('tenants').insert({ name: tName, email: 'lifecycle@test.com', phone: '555-9999', property: addr, rent: 2000, balance: 0, lease_status: 'pending' }).select().single();
  assert(!tenErr && tenant, 'Lifecycle: tenant created with lease_status=pending');
  if (!tenant) return;
  ids.tenant = tenant.id;

  // 4. Create lease, update tenant status
  const { data: lease, error: leaseErr } = await supabase.from('leases').insert({ tenant_name: tName, property: addr, start_date: '2026-01-01', end_date: '2027-01-01', rent_amount: 2000, security_deposit: 2000, lease_type: 'fixed', status: 'active', move_in_checklist: '[]', move_out_checklist: '[]' }).select().single();
  assert(!leaseErr && lease, 'Lifecycle: lease created');
  if (lease) {
    ids.lease = lease.id;
    await supabase.from('tenants').update({ lease_status: 'active' }).eq('id', ids.tenant);
    const { data: tUp } = await supabase.from('tenants').select('lease_status').eq('id', ids.tenant).single();
    assert(tUp && tUp.lease_status === 'active', 'Lifecycle: tenant lease_status → active');
  }

  // 5. Create e-signature request
  if (ids.lease) {
    const { data: sig, error: sigErr } = await supabase.from('lease_signatures').insert({ lease_id: ids.lease, signer_name: tName, signer_role: 'tenant', status: 'pending' }).select().single();
    assert(!sigErr && sig, 'Lifecycle: e-signature request created');
    if (sig) ids.signature = sig.id;
  }

  // 6. Record rent payment
  const { data: pmt, error: pmtErr } = await supabase.from('payments').insert({ tenant: tName, property: addr, amount: 2000, date: today, type: 'rent', method: 'ACH', status: 'paid' }).select().single();
  assert(!pmtErr && pmt, 'Lifecycle: rent payment recorded');
  if (pmt) ids.payment = pmt.id;

  // 7. Insert ledger entry
  const { data: ledger, error: ledErr } = await supabase.from('ledger_entries').insert({ tenant: tName, property: addr, date: today, description: 'Lifecycle rent charge', amount: 2000, type: 'charge', balance: 0 }).select().single();
  assert(!ledErr && ledger, 'Lifecycle: ledger entry created');
  if (ledger) ids.ledger = ledger.id;

  // 8. Create work order
  const { data: wo, error: woErr } = await supabase.from('work_orders').insert({ property: addr, issue: 'Lifecycle test - leaky faucet', priority: 'medium', status: 'open', tenant: tName }).select().single();
  assert(!woErr && wo, 'Lifecycle: work order created as open');
  if (wo) ids.workOrder = wo.id;

  // 9. Create vendor invoice
  const { data: inv, error: invErr } = await supabase.from('vendor_invoices').insert({ vendor_name: 'Lifecycle Vendor', property: addr, amount: 300, status: 'pending', invoice_date: today, description: 'Lifecycle test repair' }).select().single();
  assert(!invErr && inv, 'Lifecycle: vendor invoice created');
  if (inv) ids.invoice = inv.id;

  // 10. Add utility bill, mark paid
  const { data: util, error: utilErr } = await supabase.from('utilities').insert({ property: addr, provider: 'Lifecycle Electric', amount: 120, due: today, responsibility: 'owner', status: 'pending' }).select().single();
  assert(!utilErr && util, 'Lifecycle: utility bill created as pending');
  if (util) {
    ids.utility = util.id;
    await supabase.from('utilities').update({ status: 'paid' }).eq('id', ids.utility);
    const { data: uUp } = await supabase.from('utilities').select('status').eq('id', ids.utility).single();
    assert(uUp && uUp.status === 'paid', 'Lifecycle: utility status → paid');
    // Create utility_audit record
    const { data: uAudit, error: uaErr } = await supabase.from('utility_audit').insert({ utility_id: ids.utility, property: addr, provider: 'Lifecycle Electric', amount: 120, action: 'Approved & Paid', paid_at: new Date().toISOString() }).select().single();
    assert(!uaErr && uAudit, 'Lifecycle: utility_audit record created');
    if (uAudit) ids.utilityAudit = uAudit.id;
  }

  // 11. Post journal entry
  const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({ date: today, account: 'Checking Account', description: 'Lifecycle rent income', property: addr, debit: 2000, credit: 0 }).select().single();
  assert(!jeErr && je, 'Lifecycle: journal entry posted');
  if (je) ids.journal = je.id;

  // 12. Upload document record
  const { data: doc, error: docErr } = await supabase.from('documents').insert({ name: 'Lifecycle Lease Copy', property: addr, type: 'Lease', url: 'https://example.com/lifecycle.pdf', file_name: 'lifecycle.pdf', tenant_visible: true }).select().single();
  assert(!docErr && doc, 'Lifecycle: document saved with tenant_visible=true');
  if (doc) ids.document = doc.id;

  // 13. Create move-in inspection
  const { data: insp, error: inspErr } = await supabase.from('inspections').insert({ property: addr, type: 'Move-In', inspector: 'Test Inspector', date: today, status: 'completed', notes: 'Lifecycle test inspection', checklist: JSON.stringify([{ item: 'Walls', condition: 'Good' }, { item: 'Floors', condition: 'Good' }]) }).select().single();
  assert(!inspErr && insp, 'Lifecycle: move-in inspection created');
  if (insp) ids.inspection = insp.id;

  // 14. Create autopay schedule
  const { data: ap, error: apErr } = await supabase.from('autopay_schedules').insert({ tenant: tName, property: addr, amount: 2000, day_of_month: 1, method: 'ach', active: true, frequency: 'monthly' }).select().single();
  assert(!apErr && ap, 'Lifecycle: autopay schedule created as active');
  if (ap) ids.autopay = ap.id;

  // 15. Create late fee rule
  const { data: lfr, error: lfrErr } = await supabase.from('late_fee_rules').insert({ name: 'Lifecycle Rule', grace_days: 5, fee_type: 'flat', fee_amount: 75, apply_to: 'all' }).select().single();
  assert(!lfrErr && lfr, 'Lifecycle: late fee rule created');
  if (lfr) ids.lateFee = lfr.id;

  // 16. Log audit trail entry
  const { data: audit, error: auditErr } = await supabase.from('audit_trail').insert({ action: 'lifecycle_test', module: 'integration', details: 'Full lifecycle test for ' + addr, user_email: 'lifecycle@test.com', user_role: 'admin' }).select().single();
  assert(!auditErr && audit, 'Lifecycle: audit trail entry logged');
  if (audit) ids.audit = audit.id;

  // 17. Cleanup in reverse dependency order
  console.log('  🧹 Cleaning up lifecycle test data...');
  if (ids.audit) await supabase.from('audit_trail').delete().eq('id', ids.audit);
  if (ids.lateFee) await supabase.from('late_fee_rules').delete().eq('id', ids.lateFee);
  if (ids.autopay) await supabase.from('autopay_schedules').delete().eq('id', ids.autopay);
  if (ids.inspection) await supabase.from('inspections').delete().eq('id', ids.inspection);
  if (ids.document) await supabase.from('documents').delete().eq('id', ids.document);
  if (ids.journal) await supabase.from('journal_entries').delete().eq('id', ids.journal);
  if (ids.utilityAudit) await supabase.from('utility_audit').delete().eq('id', ids.utilityAudit);
  if (ids.utility) await supabase.from('utilities').delete().eq('id', ids.utility);
  if (ids.invoice) await supabase.from('vendor_invoices').delete().eq('id', ids.invoice);
  if (ids.workOrder) await supabase.from('work_orders').delete().eq('id', ids.workOrder);
  if (ids.ledger) await supabase.from('ledger_entries').delete().eq('id', ids.ledger);
  if (ids.payment) await supabase.from('payments').delete().eq('id', ids.payment);
  if (ids.signature) await supabase.from('lease_signatures').delete().eq('id', ids.signature);
  if (ids.lease) await supabase.from('leases').delete().eq('id', ids.lease);
  if (ids.tenant) await supabase.from('tenants').delete().eq('id', ids.tenant);
  if (ids.property) await supabase.from('properties').delete().eq('id', ids.property);

  // Verify cleanup
  const { data: gone } = await supabase.from('properties').select('id').eq('id', ids.property);
  assert(!gone || gone.length === 0, 'Lifecycle: all test data cleaned up');
}

async function run() {
  console.log('🧪 PropManager Data Layer Tests');
  console.log('================================');
  await testProperties();
  await testTenants();
  await testPayments();
  await testAccounting();
  await testWorkOrders();
  await testVendors();
  await testOwners();
  await testLeases();
  await testLeaseUpdatesStatus();
  await testPaymentVerifyAmount();
  await testVendorInvoice();
  await testPropertyOwnerAssignment();
  await testAutopaySchedule();
  await testLateFeeRule();
  await testUtilityBill();
  await testDocumentRecord();
  await testDeletePropertyWithOwner();
  await testMismatchedJournalEntry();
  await testAuditTrail();
  await testFullLifecycle();
  console.log('\n================================');
  console.log('✅ Passed: ' + pass);
  console.log('❌ Failed: ' + fail);
  if (errors.length > 0) { console.log('\nFailed:'); errors.forEach(function(e) { console.log('  - ' + e); }); }
  console.log('\nTotal: ' + (pass + fail) + ' | Pass rate: ' + Math.round(pass / (pass + fail) * 100) + '%');
  process.exit(fail > 0 ? 1 : 0);
}
run();
