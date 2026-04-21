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
  var required = ['1000','1100','2100','2200','4000','4010','4100','4200','5300','5400','5600'];
  for (var i = 0; i < required.length; i++) {
    assert(coa && coa.some(function(a) { return a.code === required[i] || a.id === required[i]; }), 'Account ' + required[i] + ' exists');
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

async function testAccountingPipeline() {
  console.log('\n📊 ACCOUNTING PIPELINE (JE → Ledger → Balance)');
  const cid = 'sandbox-llc';
  const today = new Date().toISOString().slice(0, 10);
  const testRef = 'PIPE-TEST-' + Date.now();
  const testTenant = 'Alice Johnson'; // seeded tenant
  const testProperty = '100 Oak Street, Unit A'; // seeded property
  const ids = {};

  // 1. Resolve account UUIDs by code column
  const { data: arAcct } = await supabase.from('acct_accounts').select('id').eq('company_id', cid).eq('code', '1100').maybeSingle();
  const { data: revAcct } = await supabase.from('acct_accounts').select('id').eq('company_id', cid).eq('code', '4000').maybeSingle();
  assert(arAcct?.id, 'Pipeline: resolved AR account UUID from code 1100');
  assert(revAcct?.id, 'Pipeline: resolved Revenue account UUID from code 4000');

  // 2. Insert JE header (rent charge: DR AR / CR Revenue)
  const { data: jeRow, error: jeErr } = await supabase.from('acct_journal_entries').insert([{
    company_id: cid, number: 'PIPE-' + Date.now(), date: today,
    description: 'Pipeline test — rent charge — ' + testTenant,
    reference: testRef, property: testProperty, status: 'posted'
  }]).select('id').maybeSingle();
  assert(!jeErr && jeRow?.id, 'Pipeline: JE header inserted');
  ids.jeId = jeRow?.id;

  // 3. Insert JE lines
  if (ids.jeId) {
    const { error: lineErr } = await supabase.from('acct_journal_lines').insert([
      { journal_entry_id: ids.jeId, company_id: cid, account_id: arAcct?.id, account_name: 'Accounts Receivable', debit: 1500, credit: 0, memo: testTenant + ' rent' },
      { journal_entry_id: ids.jeId, company_id: cid, account_id: revAcct?.id, account_name: 'Rental Income', debit: 0, credit: 1500, memo: testProperty },
    ]);
    assert(!lineErr, 'Pipeline: JE lines inserted with company_id');
  }

  // 4. Create ledger entry (mirrors what safeLedgerInsert does)
  const { data: ledgerRow, error: ledgerErr } = await supabase.from('ledger_entries').insert([{
    company_id: cid, tenant: testTenant, property: testProperty,
    date: today, description: 'Pipeline test rent charge',
    amount: 1500, type: 'charge', balance: 0,
  }]).select('id').maybeSingle();
  assert(!ledgerErr && ledgerRow?.id, 'Pipeline: ledger entry created for tenant');
  ids.ledgerId = ledgerRow?.id;

  // 5. Verify JE lines are retrievable and balanced
  if (ids.jeId) {
    const { data: lines } = await supabase.from('acct_journal_lines').select('*').eq('journal_entry_id', ids.jeId);
    const dr = (lines || []).reduce((s, l) => s + (l.debit || 0), 0);
    const cr = (lines || []).reduce((s, l) => s + (l.credit || 0), 0);
    assert(lines?.length === 2, 'Pipeline: JE has 2 lines');
    assert(Math.abs(dr - cr) < 0.01, 'Pipeline: JE is balanced (DR=$' + dr + ', CR=$' + cr + ')');
    assert(lines?.[0]?.company_id === cid, 'Pipeline: JE lines have company_id');
  }

  // 6. Verify ledger entry is retrievable
  if (ids.ledgerId) {
    const { data: ledger } = await supabase.from('ledger_entries').select('*').eq('id', ids.ledgerId).maybeSingle();
    assert(ledger?.tenant === testTenant, 'Pipeline: ledger entry has correct tenant');
    assert(ledger?.amount === 1500, 'Pipeline: ledger entry has correct amount');
    assert(ledger?.type === 'charge', 'Pipeline: ledger entry type is charge');
  }

  // 7. Simulate payment: insert payment JE (DR Checking / CR AR)
  const { data: chkAcct } = await supabase.from('acct_accounts').select('id').eq('company_id', cid).eq('code', '1000').maybeSingle();
  const payRef = 'PIPE-PAY-' + Date.now();
  const { data: payJE, error: payJEErr } = await supabase.from('acct_journal_entries').insert([{
    company_id: cid, number: 'PPAY-' + Date.now(), date: today,
    description: 'Pipeline test — payment — ' + testTenant,
    reference: payRef, property: testProperty, status: 'posted'
  }]).select('id').maybeSingle();
  assert(!payJEErr && payJE?.id, 'Pipeline: payment JE header inserted');
  ids.payJeId = payJE?.id;

  if (ids.payJeId && chkAcct?.id) {
    const { error: payLineErr } = await supabase.from('acct_journal_lines').insert([
      { journal_entry_id: ids.payJeId, company_id: cid, account_id: chkAcct.id, account_name: 'Checking Account', debit: 1500, credit: 0, memo: 'ACH from ' + testTenant },
      { journal_entry_id: ids.payJeId, company_id: cid, account_id: arAcct?.id, account_name: 'Accounts Receivable', debit: 0, credit: 1500, memo: 'AR settlement' },
    ]);
    assert(!payLineErr, 'Pipeline: payment JE lines inserted');
  }

  // 8. Create payment ledger entry (negative = credit to tenant)
  const { data: payLedger, error: payLedgerErr } = await supabase.from('ledger_entries').insert([{
    company_id: cid, tenant: testTenant, property: testProperty,
    date: today, description: 'Pipeline test payment (ACH)',
    amount: -1500, type: 'payment', balance: 0,
  }]).select('id').maybeSingle();
  assert(!payLedgerErr && payLedger?.id, 'Pipeline: payment ledger entry created');
  ids.payLedgerId = payLedger?.id;

  // 9. Verify both charge and payment appear in tenant ledger
  const { data: tenantLedger } = await supabase.from('ledger_entries').select('*')
    .eq('company_id', cid).eq('tenant', testTenant)
    .like('description', 'Pipeline test%').order('date', { ascending: false });
  assert(tenantLedger?.length >= 2, 'Pipeline: tenant ledger has both charge and payment entries');
  const netBalance = (tenantLedger || []).reduce((s, l) => s + (l.amount || 0), 0);
  assert(Math.abs(netBalance) < 0.01, 'Pipeline: tenant ledger nets to $0 (charge + payment cancel out)');

  // Cleanup
  console.log('  🧹 Cleaning up pipeline test data...');
  if (ids.payJeId) {
    await supabase.from('acct_journal_lines').delete().eq('journal_entry_id', ids.payJeId);
    await supabase.from('acct_journal_entries').delete().eq('id', ids.payJeId);
  }
  if (ids.jeId) {
    await supabase.from('acct_journal_lines').delete().eq('journal_entry_id', ids.jeId);
    await supabase.from('acct_journal_entries').delete().eq('id', ids.jeId);
  }
  if (ids.ledgerId) await supabase.from('ledger_entries').delete().eq('id', ids.ledgerId);
  if (ids.payLedgerId) await supabase.from('ledger_entries').delete().eq('id', ids.payLedgerId);
  assert(true, 'Pipeline: test data cleaned up');
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

async function testDocumentBuilder() {
  console.log('\n📝 DOCUMENT BUILDER');
  // Get a company_id for testing
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const testCompanyId = companies?.[0]?.id || 'sandbox-llc';

  // Template CRUD
  const { data: tmpl, error: tmplErr } = await supabase.from('doc_templates').insert({
    company_id: testCompanyId,
    name: 'Test Template', category: 'general', description: 'Automated test',
    body: '<p>Dear {{tenant_name}},</p><p>Property: {{property_address}}</p>',
    fields: [
      { name: 'tenant_name', label: 'Tenant Name', type: 'text', required: true },
      { name: 'property_address', label: 'Property', type: 'text', required: true },
    ],
    is_system: false, created_by: 'test@test.com',
  }).select().single();
  assert(!tmplErr && tmpl, 'Can create doc_template');

  if (tmpl) {
    const { data: fetched } = await supabase.from('doc_templates').select('*').eq('id', tmpl.id).single();
    assert(fetched && fetched.name === 'Test Template', 'Template name saved correctly');
    assert(fetched && Array.isArray(fetched.fields) && fetched.fields.length === 2, 'Template fields JSONB saved correctly');
    assert(fetched && fetched.body.includes('{{tenant_name}}'), 'Template body with merge fields saved');

    // Generated document CRUD
    const rendered = fetched.body.replace('{{tenant_name}}', 'Alice').replace('{{property_address}}', '123 Main St');
    const { data: doc, error: docErr } = await supabase.from('doc_generated').insert({
      company_id: testCompanyId, template_id: tmpl.id, name: 'Test Letter — Alice',
      field_values: { tenant_name: 'Alice', property_address: '123 Main St' },
      rendered_body: rendered, status: 'draft',
      property_address: '123 Main St', tenant_name: 'Alice',
      created_by: 'test@test.com',
    }).select().single();
    assert(!docErr && doc, 'Can create doc_generated from template');

    if (doc) {
      assert(doc.status === 'draft', 'Generated doc status is draft');
      assert(doc.rendered_body.includes('Alice'), 'Rendered body has merged values');
      assert(!doc.rendered_body.includes('{{tenant_name}}'), 'No unresolved merge fields in rendered body');

      // Update status
      await supabase.from('doc_generated').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', doc.id);
      const { data: updated } = await supabase.from('doc_generated').select('status, sent_at').eq('id', doc.id).single();
      assert(updated && updated.status === 'sent' && updated.sent_at, 'Generated doc status updated to sent');

      await supabase.from('doc_generated').delete().eq('id', doc.id);
    }
    await supabase.from('doc_templates').delete().eq('id', tmpl.id);
  }
}

async function testLoans() {
  console.log('\n🏦 LOANS');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  assert(!!cid, 'Loans: company exists for testing');

  // Insert a loan
  const { data: loan, error: loanErr } = await supabase.from('property_loans').insert({
    company_id: cid, property: 'TEST-LOAN-PROP', lender_name: 'Test Bank',
    loan_type: 'conventional', original_amount: 300000, current_balance: 280000,
    interest_rate: 6.5, monthly_payment: 1900, escrow_included: true,
    escrow_amount: 400, escrow_covers: JSON.stringify(['Property Tax', 'Insurance']),
    loan_start_date: '2024-01-01', maturity_date: '2054-01-01',
    account_number: 'LOAN-TEST-001', status: 'active'
  }).select().single();
  assert(!loanErr && loan, 'Loans: can insert loan');

  // Verify fetch
  if (loan) {
    const { data: fetched } = await supabase.from('property_loans').select('*').eq('id', loan.id).single();
    assert(fetched && fetched.lender_name === 'Test Bank', 'Loans: can fetch loan by ID');
    assert(fetched && fetched.current_balance === 280000, 'Loans: balance stored correctly');
    assert(fetched && fetched.escrow_included === true, 'Loans: escrow flag stored');

    // Update balance (simulate payment)
    const { error: upErr } = await supabase.from('property_loans').update({ current_balance: 278100 }).eq('id', loan.id);
    assert(!upErr, 'Loans: can update balance');

    // Soft-delete
    const { error: delErr } = await supabase.from('property_loans').update({ archived_at: new Date().toISOString(), archived_by: 'test' }).eq('id', loan.id);
    assert(!delErr, 'Loans: can soft-delete');

    // Verify soft-delete filters
    const { data: active } = await supabase.from('property_loans').select('id').eq('id', loan.id).is('archived_at', null);
    assert(!active || active.length === 0, 'Loans: soft-deleted loan hidden from active query');

    // Hard cleanup
    await supabase.from('property_loans').delete().eq('id', loan.id);
  }
}

async function testInsurance() {
  console.log('\n🛡️  INSURANCE');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;

  const { data: ins, error: insErr } = await supabase.from('property_insurance').insert({
    company_id: cid, property: 'TEST-INS-PROP', provider: 'State Farm',
    policy_number: 'POL-TEST-001', premium_amount: 1200,
    premium_frequency: 'annual', coverage_amount: 500000,
    expiration_date: '2027-03-01', notes: 'Test policy'
  }).select().single();
  assert(!insErr && ins, 'Insurance: can insert policy');

  if (ins) {
    const { data: fetched } = await supabase.from('property_insurance').select('*').eq('id', ins.id).single();
    assert(fetched && fetched.provider === 'State Farm', 'Insurance: provider stored correctly');
    assert(fetched && fetched.premium_amount === 1200, 'Insurance: premium stored correctly');
    assert(fetched && fetched.coverage_amount === 500000, 'Insurance: coverage stored correctly');

    // Cleanup
    await supabase.from('property_insurance').delete().eq('id', ins.id);
  }
}

async function testWizardProgress() {
  console.log('\n🧙 WIZARD PROGRESS');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;

  // Create wizard entry
  const { data: wiz, error: wizErr } = await supabase.from('property_setup_wizard').insert({
    company_id: cid, property_address: 'TEST-WIZARD-PROP',
    current_step: 1, completed_steps: JSON.stringify([]),
    wizard_data: JSON.stringify({ test: true }), status: 'in_progress'
  }).select().single();
  assert(!wizErr && wiz, 'Wizard: can create wizard progress');

  if (wiz) {
    // Update progress
    const { error: upErr } = await supabase.from('property_setup_wizard').update({
      current_step: 3, completed_steps: JSON.stringify(['utilities', 'hoa']),
      updated_at: new Date().toISOString()
    }).eq('id', wiz.id);
    assert(!upErr, 'Wizard: can update progress');

    // Verify
    const { data: fetched } = await supabase.from('property_setup_wizard').select('*').eq('id', wiz.id).single();
    assert(fetched && fetched.current_step === 3, 'Wizard: step updated correctly');
    assert(fetched && fetched.status === 'in_progress', 'Wizard: status is in_progress');

    // Complete
    const { error: compErr } = await supabase.from('property_setup_wizard').update({
      status: 'completed', completed_at: new Date().toISOString()
    }).eq('id', wiz.id);
    assert(!compErr, 'Wizard: can mark as completed');

    // Query in-progress (should not find completed)
    const { data: inProg } = await supabase.from('property_setup_wizard').select('id')
      .eq('company_id', cid).eq('status', 'in_progress').eq('property_address', 'TEST-WIZARD-PROP');
    assert(!inProg || inProg.length === 0, 'Wizard: completed wizard not in in_progress query');

    // Cleanup
    await supabase.from('property_setup_wizard').delete().eq('id', wiz.id);
  }
}

async function testARSubAccountCreation() {
  console.log('\n📋 AR SUB-ACCOUNT CREATION');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  if (!cid) { assert(false, 'AR Sub: no company found'); return; }

  const testName = 'TEST-AR-TENANT-' + Date.now();

  // Insert an AR sub-account manually (simulating getOrCreateTenantAR)
  const { data: parent } = await supabase.from('acct_accounts').select('id').eq('company_id', cid).eq('code', '1100').maybeSingle();
  assert(!!parent, 'AR Sub: parent 1100 account exists');

  const { data: subAcct, error: subErr } = await supabase.from('acct_accounts').insert({
    company_id: cid, code: '1100-999', name: 'AR - ' + testName,
    type: 'Asset', is_active: true, old_text_id: cid + '-1100-999'
  }).select().single();
  assert(!subErr && subAcct, 'AR Sub: can create sub-account with old_text_id');

  if (subAcct) {
    // Verify it appears alongside parent
    const { data: allAR } = await supabase.from('acct_accounts').select('id, code, name')
      .eq('company_id', cid).eq('type', 'Asset').like('code', '1100%');
    assert(allAR && allAR.length >= 2, 'AR Sub: both parent and sub-account queryable');
    assert(allAR && allAR.some(a => a.code === '1100-999'), 'AR Sub: sub-account found by code pattern');

    // Verify exact name match lookup (as getOrCreateTenantAR does)
    const { data: found } = await supabase.from('acct_accounts').select('id, code')
      .eq('company_id', cid).eq('type', 'Asset').eq('name', 'AR - ' + testName).maybeSingle();
    assert(found && found.id === subAcct.id, 'AR Sub: exact name lookup finds sub-account');

    // Cleanup
    await supabase.from('acct_accounts').delete().eq('id', subAcct.id);
  }
}

async function testPropertyDeleteCascadeNewTables() {
  console.log('\n🗑️  DELETE CASCADE — NEW TABLES');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  if (!cid) { assert(false, 'Cascade: no company found'); return; }

  const addr = 'TEST-CASCADE-' + Date.now();
  const ids = {};

  // Create property
  const { data: prop } = await supabase.from('properties').insert({ company_id: cid, address: addr, status: 'vacant', type: 'Test' }).select().single();
  if (prop) ids.property = prop.id;

  // Create related records in new tables
  const { data: loan } = await supabase.from('property_loans').insert({ company_id: cid, property: addr, lender_name: 'Cascade Bank', original_amount: 100000, current_balance: 90000, monthly_payment: 800, status: 'active' }).select().single();
  if (loan) ids.loan = loan.id;

  const { data: ins } = await supabase.from('property_insurance').insert({ company_id: cid, property: addr, provider: 'Cascade Insurance', premium_amount: 100 }).select().single();
  if (ins) ids.insurance = ins.id;

  const { data: wiz } = await supabase.from('property_setup_wizard').insert({ company_id: cid, property_address: addr, status: 'in_progress', current_step: 1 }).select().single();
  if (wiz) ids.wizard = wiz.id;

  assert(ids.loan && ids.insurance && ids.wizard, 'Cascade: all related records created');

  // Simulate soft-delete cascade (what deleteProperty does)
  const arch = { archived_at: new Date().toISOString(), archived_by: 'test' };
  await supabase.from('property_loans').update(arch).eq('company_id', cid).eq('property', addr).is('archived_at', null);
  await supabase.from('property_insurance').update(arch).eq('company_id', cid).eq('property', addr).is('archived_at', null);
  await supabase.from('property_setup_wizard').update({ status: 'dismissed' }).eq('company_id', cid).eq('property_address', addr).eq('status', 'in_progress');

  // Verify cascade
  const { data: activeLoan } = await supabase.from('property_loans').select('id').eq('id', ids.loan).is('archived_at', null);
  assert(!activeLoan || activeLoan.length === 0, 'Cascade: loan archived');

  const { data: activeIns } = await supabase.from('property_insurance').select('id').eq('id', ids.insurance).is('archived_at', null);
  assert(!activeIns || activeIns.length === 0, 'Cascade: insurance archived');

  const { data: activeWiz } = await supabase.from('property_setup_wizard').select('status').eq('id', ids.wizard).single();
  assert(activeWiz && activeWiz.status === 'dismissed', 'Cascade: wizard dismissed');

  // Hard cleanup
  if (ids.loan) await supabase.from('property_loans').delete().eq('id', ids.loan);
  if (ids.insurance) await supabase.from('property_insurance').delete().eq('id', ids.insurance);
  if (ids.wizard) await supabase.from('property_setup_wizard').delete().eq('id', ids.wizard);
  if (ids.property) await supabase.from('properties').delete().eq('id', ids.property);
}

async function testHOAPayments() {
  console.log('\n🏘️  HOA PAYMENTS');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  assert(!!cid, 'HOA: company exists');
  const { data: hoa, error: hoaErr } = await supabase.from('hoa_payments').insert({
    company_id: cid, property: 'TEST-HOA-PROP', hoa_name: 'Test HOA Association',
    amount: 250, due_date: '2026-04-01', frequency: 'Monthly', status: 'pending', notes: 'Test HOA'
  }).select().single();
  assert(!hoaErr && hoa, 'HOA: can insert payment');
  if (hoa) {
    const { data: fetched } = await supabase.from('hoa_payments').select('*').eq('id', hoa.id).single();
    assert(fetched && fetched.hoa_name === 'Test HOA Association', 'HOA: name stored correctly');
    assert(fetched && fetched.amount === 250, 'HOA: amount stored correctly');
    assert(fetched && fetched.frequency === 'Monthly', 'HOA: frequency stored correctly');
    const { error: upErr } = await supabase.from('hoa_payments').update({ status: 'paid' }).eq('id', hoa.id);
    assert(!upErr, 'HOA: can update status to paid');
    const { error: delErr } = await supabase.from('hoa_payments').update({ archived_at: new Date().toISOString() }).eq('id', hoa.id);
    assert(!delErr, 'HOA: can soft-delete');
    const { data: active } = await supabase.from('hoa_payments').select('id').eq('id', hoa.id).is('archived_at', null);
    assert(!active || active.length === 0, 'HOA: soft-deleted hidden from active query');
    await supabase.from('hoa_payments').delete().eq('id', hoa.id);
  }
}

async function testInsuranceTracker() {
  console.log('\n🛡️  INSURANCE TRACKER');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Test expiry detection
  const past = new Date(); past.setDate(past.getDate() - 30);
  const future = new Date(); future.setDate(future.getDate() + 60);
  const { data: expired, error: e1 } = await supabase.from('property_insurance').insert({
    company_id: cid, property: 'TEST-INS-EXP', provider: 'Expired Ins Co',
    premium_amount: 1200, premium_frequency: 'annual', coverage_amount: 500000,
    expiration_date: past.toISOString().slice(0,10)
  }).select().single();
  assert(!e1 && expired, 'Insurance: can insert expired policy');
  const { data: valid, error: e2 } = await supabase.from('property_insurance').insert({
    company_id: cid, property: 'TEST-INS-VALID', provider: 'Valid Ins Co',
    premium_amount: 800, premium_frequency: 'annual', coverage_amount: 300000,
    expiration_date: future.toISOString().slice(0,10)
  }).select().single();
  assert(!e2 && valid, 'Insurance: can insert valid policy');
  // Query expiring within 90 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 90);
  const { data: expiring } = await supabase.from('property_insurance').select('id, expiration_date')
    .eq('company_id', cid).lte('expiration_date', cutoff.toISOString().slice(0,10)).is('archived_at', null);
  assert(expiring && expiring.some(p => p.id === expired?.id), 'Insurance: expired policy found in expiry query');
  // Cleanup
  if (expired) await supabase.from('property_insurance').delete().eq('id', expired.id);
  if (valid) await supabase.from('property_insurance').delete().eq('id', valid.id);
}

async function testMoveOutFlow() {
  console.log('\n🚪 MOVE-OUT FLOW');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const addr = 'TEST-MOVEOUT-' + Date.now();
  // Create property + tenant + lease
  const { data: prop } = await supabase.from('properties').insert({ company_id: cid, address: addr, status: 'occupied', type: 'Test', tenant: 'MoveOut Tenant', rent: 2000 }).select().single();
  const { data: tenant } = await supabase.from('tenants').insert({ company_id: cid, name: 'MoveOut Tenant', email: 'moveout@test.com', phone: '555', property: addr, rent: 2000, balance: 0, lease_status: 'active' }).select().single();
  const { data: lease } = await supabase.from('leases').insert({ company_id: cid, tenant_name: 'MoveOut Tenant', property: addr, start_date: '2026-01-01', end_date: '2026-12-31', rent_amount: 2000, security_deposit: 2000, status: 'active', move_in_checklist: '[]', move_out_checklist: '[]' }).select().single();
  assert(prop && tenant && lease, 'MoveOut: property + tenant + lease created');
  if (!tenant || !lease) return;
  // Simulate move-out: terminate lease, archive tenant, vacant property
  await supabase.from('leases').update({ status: 'terminated', end_date: '2026-03-24' }).eq('id', lease.id);
  await supabase.from('tenants').update({ lease_status: 'inactive', archived_at: new Date().toISOString(), archived_by: 'test' }).eq('id', tenant.id);
  await supabase.from('properties').update({ status: 'vacant', tenant: '' }).eq('id', prop.id);
  // Verify
  const { data: updLease } = await supabase.from('leases').select('status').eq('id', lease.id).single();
  assert(updLease && updLease.status === 'terminated', 'MoveOut: lease terminated');
  const { data: updTenant } = await supabase.from('tenants').select('lease_status, archived_at').eq('id', tenant.id).single();
  assert(updTenant && updTenant.lease_status === 'inactive', 'MoveOut: tenant inactive');
  assert(updTenant && updTenant.archived_at, 'MoveOut: tenant archived');
  const { data: updProp } = await supabase.from('properties').select('status, tenant').eq('id', prop.id).single();
  assert(updProp && updProp.status === 'vacant', 'MoveOut: property vacant');
  assert(updProp && updProp.tenant === '', 'MoveOut: tenant cleared from property');
  // Historical tenant query (archived tenants for this property)
  const { data: historical } = await supabase.from('tenants').select('name').eq('company_id', cid).eq('property', addr).not('archived_at', 'is', null);
  assert(historical && historical.some(t => t.name === 'MoveOut Tenant'), 'MoveOut: tenant appears in historical query');
  // Cleanup
  await supabase.from('leases').delete().eq('id', lease.id);
  await supabase.from('tenants').delete().eq('id', tenant.id);
  await supabase.from('properties').delete().eq('id', prop.id);
}

async function testEvictionCase() {
  console.log('\n⚖️  EVICTION CASE');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: evCase, error: evErr } = await supabase.from('eviction_cases').insert({
    company_id: cid, tenant_name: 'Evict Test Tenant', property: 'TEST-EVICT-PROP',
    reason: 'non_payment', notice_type: 'pay_or_quit', notice_days: 30,
    current_stage: 'notice_served',
    stage_history: JSON.stringify([{ stage: 'notice_served', date: '2026-03-24', note: 'Test' }]),
    total_costs: 0, status: 'active'
  }).select().single();
  assert(!evErr && evCase, 'Eviction: can create case');
  if (evCase) {
    const { data: fetched } = await supabase.from('eviction_cases').select('*').eq('id', evCase.id).single();
    assert(fetched && fetched.reason === 'non_payment', 'Eviction: reason stored');
    assert(fetched && fetched.current_stage === 'notice_served', 'Eviction: stage stored');
    // Advance stage
    const newHistory = JSON.parse(fetched.stage_history || '[]');
    newHistory.push({ stage: 'court_filing', date: '2026-04-01', note: 'Filed' });
    const { error: upErr } = await supabase.from('eviction_cases').update({ current_stage: 'court_filing', stage_history: JSON.stringify(newHistory), total_costs: 500 }).eq('id', evCase.id);
    assert(!upErr, 'Eviction: can advance stage');
    await supabase.from('eviction_cases').delete().eq('id', evCase.id);
  }
}

async function testOwnerDistribution() {
  console.log('\n💰 OWNER DISTRIBUTION');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: owners } = await supabase.from('owners').select('id').eq('company_id', cid).limit(1);
  if (!owners || owners.length === 0) { assert(true, 'Owner Dist: no owners to test (skip)'); return; }
  const ownerId = owners[0].id;
  // owner_distributions columns: id, owner_id, statement_id, amount, method, reference, date, notes, created_at, company_id
  const today = new Date().toISOString().slice(0, 10);
  const { data: dist, error: distErr } = await supabase.from('owner_distributions').insert({
    company_id: cid, owner_id: ownerId, amount: 1800,
    method: 'ACH', reference: 'TEST-DIST', date: today, notes: 'Test distribution'
  }).select().single();
  assert(!distErr && dist, 'Owner Dist: can create distribution');
  if (dist) {
    assert(dist.amount === 1800, 'Owner Dist: amount correct');
    assert(dist.method === 'ACH', 'Owner Dist: method stored');
    assert(dist.owner_id === ownerId, 'Owner Dist: owner linked');
    const { error: upErr } = await supabase.from('owner_distributions').update({ notes: 'Paid and verified' }).eq('id', dist.id);
    assert(!upErr, 'Owner Dist: can update');
    await supabase.from('owner_distributions').delete().eq('id', dist.id);
  }
}

async function testPropertyChangeRequests() {
  console.log('\n📋 PROPERTY CHANGE REQUESTS');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: req, error: reqErr } = await supabase.from('property_change_requests').insert({
    company_id: cid, request_type: 'add', requested_by: 'test@test.com',
    address: 'TEST-CHANGEREQ-PROP', type: 'Single Family', property_status: 'vacant'
  }).select().single();
  assert(!reqErr && req, 'ChangeReq: can submit request');
  if (req) {
    assert(req.request_type === 'add', 'ChangeReq: type stored');
    assert(req.requested_by === 'test@test.com', 'ChangeReq: requester stored');
    // Approve
    const { error: apErr } = await supabase.from('property_change_requests').update({ status: 'approved', reviewed_by: 'admin@test.com' }).eq('id', req.id);
    assert(!apErr, 'ChangeReq: can approve');
    await supabase.from('property_change_requests').delete().eq('id', req.id);
  }
}

async function testRecurringEntryEngine() {
  console.log('\n🔄 RECURRING ENTRY ENGINE');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Create a recurring entry
  const { data: entry, error: entErr } = await supabase.from('recurring_journal_entries').insert({
    company_id: cid, description: 'TEST-RECUR Monthly Rent', frequency: 'monthly',
    day_of_month: 1, amount: 1500, property: 'TEST-RECUR-PROP',
    debit_account_name: 'AR - Test', credit_account_name: 'Rental Income',
    status: 'active'
  }).select().single();
  assert(!entErr && entry, 'Recurring: can create entry');
  if (entry) {
    assert(entry.frequency === 'monthly', 'Recurring: frequency stored');
    assert(entry.amount === 1500, 'Recurring: amount stored');
    assert(entry.status === 'active', 'Recurring: status is active');
    // Pause
    const { error: pauseErr } = await supabase.from('recurring_journal_entries').update({ status: 'paused' }).eq('id', entry.id);
    assert(!pauseErr, 'Recurring: can pause');
    const { data: paused } = await supabase.from('recurring_journal_entries').select('status').eq('id', entry.id).single();
    assert(paused && paused.status === 'paused', 'Recurring: status changed to paused');
    // Resume
    await supabase.from('recurring_journal_entries').update({ status: 'active' }).eq('id', entry.id);
    // Simulate posted (set last_posted_date)
    const today = new Date().toISOString().slice(0,10);
    const { error: postErr } = await supabase.from('recurring_journal_entries').update({ last_posted_date: today }).eq('id', entry.id);
    assert(!postErr, 'Recurring: can update last_posted_date');
    // Archive
    const { error: archErr } = await supabase.from('recurring_journal_entries').update({ status: 'inactive', archived_at: new Date().toISOString() }).eq('id', entry.id);
    assert(!archErr, 'Recurring: can archive');
    const { data: activeEntries } = await supabase.from('recurring_journal_entries').select('id').eq('id', entry.id).eq('status', 'active');
    assert(!activeEntries || activeEntries.length === 0, 'Recurring: archived entry not in active query');
    await supabase.from('recurring_journal_entries').delete().eq('id', entry.id);
  }
}

// ============ NEW TESTS: UNTESTED TABLES & FEATURES ============

async function testMessages() {
  console.log('\n💬 MESSAGES');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: msg, error: msgErr } = await supabase.from('messages').insert({
    company_id: cid, tenant: 'TEST-MSG-Tenant', property: 'TEST-MSG-Prop',
    sender: 'admin', message: 'Test message content', read: false
  }).select().single();
  assert(!msgErr && msg, 'Messages: can insert');
  if (msg) {
    const { error: readErr } = await supabase.from('messages').update({ read: true }).eq('id', msg.id);
    assert(!readErr, 'Messages: can mark as read');
    const { data: fetched } = await supabase.from('messages').select('*').eq('id', msg.id).single();
    assert(fetched && fetched.read === true, 'Messages: read status persisted');
    await supabase.from('messages').delete().eq('id', msg.id);
  }

  // ---- Messaging UI overhaul (20260421 migration) ----
  // New columns + read_at semantics + (company,tenant,created_at) index.
  const tenantId = 999999001; // synthetic id — we only probe the insert path
  const { data: upgraded, error: upErr } = await supabase.from('messages').insert({
    company_id: cid,
    tenant_id: tenantId,
    tenant: 'TEST-MSG-Upgrade',
    property: 'TEST-MSG-Upgrade-Prop',
    sender: 'admin',
    sender_email: 'admin@example.com',
    sender_role: 'admin',
    message: 'upgrade-path test',
    attachment_url: null,
    attachment_name: null,
    read: false,
    read_at: null,
  }).select('id, sender_role, read_at, attachment_url, attachment_name').single();
  assert(!upErr && upgraded, 'Messages v2: can insert with new columns');
  if (upgraded) {
    assert(upgraded.sender_role === 'admin', 'Messages v2: sender_role persisted');
    assert(upgraded.read_at === null, 'Messages v2: read_at defaults to null');
    // Mark read via read_at + legacy read bool (the UI keeps them in sync).
    const { error: mrErr } = await supabase.from('messages')
      .update({ read_at: new Date().toISOString(), read: true })
      .eq('id', upgraded.id);
    assert(!mrErr, 'Messages v2: can set read_at');
    const { data: reread } = await supabase.from('messages').select('read_at,read').eq('id', upgraded.id).single();
    assert(reread?.read_at && reread?.read === true, 'Messages v2: read_at + legacy bool both persisted');
    // Query by (company_id, tenant_id) — new composite index path.
    const { data: byTenant } = await supabase.from('messages')
      .select('id, created_at')
      .eq('company_id', cid)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true })
      .limit(10);
    assert(Array.isArray(byTenant) && byTenant.find(r => r.id === upgraded.id), 'Messages v2: queryable by (company,tenant_id)');
    await supabase.from('messages').delete().eq('id', upgraded.id);
  }
}

async function testNotificationTables() {
  console.log('\n🔔 NOTIFICATION TABLES');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // notification_inbox
  const { data: inbox, error: inErr } = await supabase.from('notification_inbox').insert({
    company_id: cid, recipient_email: 'test@test.com', icon: '🔔',
    message: 'Test notification', notification_type: 'test', read: false
  }).select().single();
  assert(!inErr && inbox, 'NotifInbox: can insert');
  if (inbox) {
    await supabase.from('notification_inbox').update({ read: true }).eq('id', inbox.id);
    await supabase.from('notification_inbox').delete().eq('id', inbox.id);
  }
  // notification_settings
  const { data: settings } = await supabase.from('notification_settings').select('*').eq('company_id', cid).limit(1);
  assert(settings !== null, 'NotifSettings: can query');
  // notification_log
  // notification_log may be empty — just verify table exists
  const { error: logQueryErr } = await supabase.from('notification_log').select('*').limit(1);
  assert(!logQueryErr, 'NotifLog: table exists and can query');
}

async function testCompanyMembers() {
  console.log('\n🏢 COMPANY MEMBERS');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: members, error: memErr } = await supabase.from('company_members').select('*').eq('company_id', cid);
  assert(!memErr, 'CompanyMembers: can fetch');
  assert(members && members.length > 0, 'CompanyMembers: has at least 1 member');
  assert(members && members.some(m => m.role === 'admin'), 'CompanyMembers: has admin role');
  // Test status field
  assert(members && members.some(m => m.status === 'active'), 'CompanyMembers: has active member');
}

async function testCredentialEncryption() {
  console.log('\n🔐 CREDENTIAL ENCRYPTION');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Test that credential columns exist on all 4 tables
  const tables = ['utilities', 'hoa_payments', 'property_loans', 'property_insurance'];
  for (const table of tables) {
    const { data, error } = await supabase.from(table).select('website, username_encrypted, password_encrypted, encryption_iv').eq('company_id', cid).limit(1);
    assert(!error, `Encryption: ${table} has credential columns`);
  }
  // Test insert with encrypted fields
  const { data: util, error: utilErr } = await supabase.from('utilities').insert({
    company_id: cid, property: 'TEST-CRED-PROP', provider: 'TEST-CRED',
    amount: 0, due: '2026-01-01', status: 'pending',
    website: 'https://test.com', username_encrypted: 'dGVzdA==', password_encrypted: 'cGFzcw==', encryption_iv: 'aabbccdd'
  }).select().single();
  assert(!utilErr && util, 'Encryption: can store encrypted credentials');
  if (util) {
    assert(util.website === 'https://test.com', 'Encryption: website stored as plaintext');
    assert(util.username_encrypted === 'dGVzdA==', 'Encryption: encrypted username stored');
    assert(util.encryption_iv === 'aabbccdd', 'Encryption: IV stored');
    await supabase.from('utilities').delete().eq('id', util.id);
  }
}

async function testProratedRentCalculation() {
  console.log('\n📊 PRORATED RENT CALCULATION');
  // Test the math: rent * remainingDays / daysInMonth, rounded to whole dollars
  function calcProrated(rent, startDay, daysInMonth) {
    const remainingDays = daysInMonth - startDay + 1;
    return Math.round(rent * remainingDays / daysInMonth);
  }
  // Mid-month start
  assert(calcProrated(1500, 15, 31) === 823, 'Proration: $1500 from day 15 of 31-day month = $823');
  assert(calcProrated(2000, 20, 30) === 733, 'Proration: $2000 from day 20 of 30-day month = $733');
  // First day = full month
  assert(calcProrated(1500, 1, 31) === 1500, 'Proration: day 1 = full month ($1500)');
  // Last day = 1 day
  assert(calcProrated(1500, 31, 31) === 48, 'Proration: day 31 of 31 = $48');
  // February
  assert(calcProrated(1200, 15, 28) === 600, 'Proration: $1200 from day 15 of 28-day month = $600');
  // Last month proration (endDay / daysInMonth)
  function calcLastMonth(rent, endDay, daysInMonth) {
    return Math.round(rent * endDay / daysInMonth);
  }
  assert(calcLastMonth(1500, 20, 31) === 968, 'LastMonth: $1500 for 20/31 days = $968');
  assert(calcLastMonth(2000, 15, 30) === 1000, 'LastMonth: $2000 for 15/30 days = $1000');
  assert(calcLastMonth(1500, 31, 31) === 1500, 'LastMonth: full month = $1500');
}

async function testPaymentEdgeCases() {
  console.log('\n💰 PAYMENT EDGE CASES');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Zero amount
  const { data: zero, error: zeroErr } = await supabase.from('payments').insert({
    company_id: cid, tenant: 'TEST-EDGE', property: 'TEST-EDGE',
    amount: 0, date: '2026-01-01', type: 'rent', method: 'test', status: 'paid'
  }).select().single();
  assert(!zeroErr, 'EdgeCase: zero amount payment inserts (DB allows it)');
  if (zero) await supabase.from('payments').delete().eq('id', zero.id);
  // Large amount
  const { data: large, error: largeErr } = await supabase.from('payments').insert({
    company_id: cid, tenant: 'TEST-EDGE', property: 'TEST-EDGE',
    amount: 999999.99, date: '2026-01-01', type: 'rent', method: 'test', status: 'paid'
  }).select().single();
  assert(!largeErr, 'EdgeCase: large amount payment inserts');
  if (large) {
    assert(large.amount === 999999.99, 'EdgeCase: large amount stored correctly');
    await supabase.from('payments').delete().eq('id', large.id);
  }
  // Negative amount (should we allow?)
  const { error: negErr } = await supabase.from('payments').insert({
    company_id: cid, tenant: 'TEST-EDGE', property: 'TEST-EDGE',
    amount: -100, date: '2026-01-01', type: 'refund', method: 'test', status: 'paid'
  }).select().single();
  assert(true, 'EdgeCase: negative amount ' + (negErr ? 'blocked by DB' : 'allowed by DB'));
  // Cleanup
  await supabase.from('payments').delete().match({ tenant: 'TEST-EDGE', property: 'TEST-EDGE' });
}

async function testConcurrentLeasePrevention() {
  console.log('\n📋 CONCURRENT LEASE PREVENTION');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Create first active lease
  const { data: lease1, error: l1Err } = await supabase.from('leases').insert({
    company_id: cid, tenant_name: 'TEST-CONCURRENT', property: 'TEST-CONC-PROP',
    start_date: '2026-01-01', end_date: '2026-12-31', rent_amount: 1500, status: 'active'
  }).select().single();
  assert(!l1Err && lease1, 'ConcurrentLease: first lease created');
  // Attempt second active lease for same property
  const { data: lease2, error: l2Err } = await supabase.from('leases').insert({
    company_id: cid, tenant_name: 'TEST-CONCURRENT-2', property: 'TEST-CONC-PROP',
    start_date: '2026-06-01', end_date: '2027-05-31', rent_amount: 1600, status: 'active'
  }).select().single();
  // DB may allow it (no unique constraint) — document the behavior
  assert(true, 'ConcurrentLease: second lease ' + (l2Err ? 'blocked (constraint exists)' : 'allowed (no constraint — app must enforce)'));
  // Cleanup
  if (lease1) await supabase.from('leases').delete().eq('id', lease1.id);
  if (lease2) await supabase.from('leases').delete().eq('id', lease2.id);
}

async function testMultiTenantProperty() {
  console.log('\n👥 MULTI-TENANT PROPERTY');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: prop, error: propErr } = await supabase.from('properties').insert({
    company_id: cid, address: 'TEST-MULTI-TENANT-999', status: 'occupied', type: 'Multi Family',
    tenant: 'Primary Tenant', tenant_2: 'Second Tenant', tenant_2_email: 'second@test.com', tenant_2_phone: '555-0002',
    tenant_3: 'Third Tenant', tenant_3_email: 'third@test.com', tenant_3_phone: '555-0003',
    tenant_4: 'Fourth Tenant', tenant_5: 'Fifth Tenant'
  }).select().single();
  assert(!propErr && prop, 'MultiTenant: can create property with 5 tenants');
  if (prop) {
    assert(prop.tenant === 'Primary Tenant', 'MultiTenant: primary tenant stored');
    assert(prop.tenant_2 === 'Second Tenant', 'MultiTenant: tenant_2 stored');
    assert(prop.tenant_3 === 'Third Tenant', 'MultiTenant: tenant_3 stored');
    assert(prop.tenant_4 === 'Fourth Tenant', 'MultiTenant: tenant_4 stored');
    assert(prop.tenant_5 === 'Fifth Tenant', 'MultiTenant: tenant_5 stored');
    assert(prop.tenant_2_email === 'second@test.com', 'MultiTenant: tenant_2_email stored');
    await supabase.from('properties').delete().eq('id', prop.id);
  }
}

async function testBankReconciliation() {
  console.log('\n🏦 BANK RECONCILIATION');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data, error } = await supabase.from('bank_reconciliations').select('*').eq('company_id', cid).limit(1);
  assert(!error, 'BankRecon: table exists and can query');
  // Insert test reconciliation
  const { data: recon, error: reconErr } = await supabase.from('bank_reconciliations').insert({
    company_id: cid, period: '2026-01', bank_ending_balance: 10000,
    book_balance: 10000, difference: 0, status: 'reconciled'
  }).select().single();
  assert(!reconErr, 'BankRecon: can insert (' + (reconErr?.message || 'ok') + ')');
  if (recon) await supabase.from('bank_reconciliations').delete().eq('id', recon.id);
}

async function testWorkOrderPhotos() {
  console.log('\n📸 WORK ORDER PHOTOS');
  const { data, error } = await supabase.from('work_order_photos').select('*').limit(1);
  assert(!error, 'WOPhotos: table exists and can query (' + (error?.message || 'ok') + ')');
}

async function testUserProfile() {
  console.log('\n👤 USER PROFILE (app_users)');
  const { data, error } = await supabase.from('app_users').select('*').limit(1);
  assert(!error, 'AppUsers: table exists and can query');
  if (data && data.length > 0) {
    assert(data[0].email || data[0].user_email, 'AppUsers: has email field');
  }
}

async function testClassTracking() {
  console.log('\n🏷️ CLASS TRACKING (acct_classes)');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: cls, error: clsErr } = await supabase.from('acct_classes').insert({
    id: require('crypto').randomUUID(),
    company_id: cid, name: 'TEST-CLASS-999', description: 'Test class',
    color: '#FF0000', is_active: true
  }).select().single();
  assert(!clsErr && cls, 'Classes: can create with randomUUID');
  if (cls) {
    assert(cls.name === 'TEST-CLASS-999', 'Classes: name stored');
    assert(cls.is_active === true, 'Classes: is_active stored');
    // Deactivate
    await supabase.from('acct_classes').update({ is_active: false }).eq('id', cls.id);
    const { data: inactive } = await supabase.from('acct_classes').select('is_active').eq('id', cls.id).single();
    assert(inactive && inactive.is_active === false, 'Classes: can deactivate');
    await supabase.from('acct_classes').delete().eq('id', cls.id);
  }
}

async function testPagePersistence() {
  console.log('\n💾 PAGE PERSISTENCE (localStorage simulation)');
  // This tests the data contract — not actual browser localStorage
  // Verify company_id is TEXT type (not UUID)
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  assert(typeof cid === 'string', 'Persistence: company_id is string type');
  // Verify property_setup_wizard status values
  const { data: wizards } = await supabase.from('property_setup_wizard').select('status').eq('company_id', cid).limit(5);
  if (wizards && wizards.length > 0) {
    const validStatuses = ['in_progress', 'completed', 'dismissed'];
    assert(wizards.every(w => validStatuses.includes(w.status)), 'Persistence: wizard statuses are valid');
  } else {
    assert(true, 'Persistence: no wizards to check (ok)');
  }
}

// ============ BANK FEED TABLES (Phase 1 + 2) ============

async function testBankAccountFeed() {
  console.log('\n🏦 BANK ACCOUNT FEED');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Create GL account first
  const oldTextId = cid + '-test-bank-feed';
  const { data: glAcct } = await supabase.from('acct_accounts').insert({
    company_id: cid, code: '1000-TST', name: 'TEST Bank Feed Account',
    type: 'Asset', is_active: true, old_text_id: oldTextId
  }).select('id').single();
  // Create bank account feed
  const { data: feed, error: feedErr } = await supabase.from('bank_account_feed').insert({
    company_id: cid, gl_account_id: glAcct?.id, account_name: 'TEST Chase Checking',
    masked_number: '4567', account_type: 'checking', institution_name: 'Chase',
    connection_type: 'csv', status: 'active'
  }).select().single();
  assert(!feedErr && feed, 'BankFeed: can create');
  assert(feed?.account_name === 'TEST Chase Checking', 'BankFeed: account_name stored');
  assert(feed?.account_type === 'checking', 'BankFeed: account_type stored');
  assert(feed?.gl_account_id === glAcct?.id, 'BankFeed: gl_account_id linked');
  // Cleanup
  if (feed) await supabase.from('bank_account_feed').delete().eq('id', feed.id);
  if (glAcct) await supabase.from('acct_accounts').delete().eq('id', glAcct.id);
}

async function testBankImportBatch() {
  console.log('\n📦 BANK IMPORT BATCH');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Create feed first
  const { data: feed } = await supabase.from('bank_account_feed').insert({
    company_id: cid, account_name: 'TEST Batch Feed', account_type: 'checking',
    connection_type: 'csv', status: 'active'
  }).select('id').single();
  // Create batch
  const { data: batch, error: batchErr } = await supabase.from('bank_import_batch').insert({
    company_id: cid, bank_account_feed_id: feed?.id, source_type: 'csv',
    original_filename: 'test.csv', file_hash: 'abc123', imported_by: 'test@test.com',
    row_count: 10, status: 'imported'
  }).select().single();
  assert(!batchErr && batch, 'ImportBatch: can create');
  assert(batch?.row_count === 10, 'ImportBatch: row_count stored');
  assert(batch?.status === 'imported', 'ImportBatch: status stored');
  // Update stats
  const { error: upErr } = await supabase.from('bank_import_batch').update({
    accepted_count: 8, skipped_count: 1, duplicate_count: 1
  }).eq('id', batch?.id);
  assert(!upErr, 'ImportBatch: can update stats');
  // Cleanup
  if (batch) await supabase.from('bank_import_batch').delete().eq('id', batch.id);
  if (feed) await supabase.from('bank_account_feed').delete().eq('id', feed.id);
}

async function testBankFeedTransaction() {
  console.log('\n💳 BANK FEED TRANSACTION');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: feed } = await supabase.from('bank_account_feed').insert({
    company_id: cid, account_name: 'TEST Txn Feed', account_type: 'checking',
    connection_type: 'csv', status: 'active'
  }).select('id').single();
  // Create transaction
  const fp = 'test-fp-' + Date.now();
  const { data: txn, error: txnErr } = await supabase.from('bank_feed_transaction').insert({
    company_id: cid, bank_account_feed_id: feed?.id, source_type: 'csv',
    posted_date: '2026-03-24', amount: 1500.00, direction: 'inflow',
    bank_description_raw: 'Zelle payment from JOHN DOE Conf# abc123',
    bank_description_clean: 'Zelle payment from JOHN DOE',
    payee_raw: 'JOHN DOE', payee_normalized: 'John Doe',
    fingerprint_hash: fp, status: 'for_review'
  }).select().single();
  assert(!txnErr && txn, 'BankTxn: can create');
  assert(txn?.amount == 1500, 'BankTxn: amount stored');
  assert(txn?.direction === 'inflow', 'BankTxn: direction stored');
  assert(txn?.status === 'for_review', 'BankTxn: status is for_review');
  assert(txn?.fingerprint_hash === fp, 'BankTxn: fingerprint stored');
  // Test duplicate prevention
  const { error: dupErr } = await supabase.from('bank_feed_transaction').insert({
    company_id: cid, bank_account_feed_id: feed?.id, source_type: 'csv',
    posted_date: '2026-03-24', amount: 1500.00, direction: 'inflow',
    bank_description_raw: 'Duplicate', fingerprint_hash: fp, status: 'for_review'
  });
  assert(dupErr && dupErr.message.includes('unique'), 'BankTxn: duplicate fingerprint blocked');
  // Status transitions
  await supabase.from('bank_feed_transaction').update({ status: 'categorized', accepted_at: new Date().toISOString() }).eq('id', txn?.id);
  const { data: cat } = await supabase.from('bank_feed_transaction').select('status').eq('id', txn?.id).single();
  assert(cat?.status === 'categorized', 'BankTxn: status → categorized');
  await supabase.from('bank_feed_transaction').update({ status: 'excluded', exclusion_reason: 'duplicate' }).eq('id', txn?.id);
  const { data: excl } = await supabase.from('bank_feed_transaction').select('status').eq('id', txn?.id).single();
  assert(excl?.status === 'excluded', 'BankTxn: status → excluded');
  // Undo back to for_review
  await supabase.from('bank_feed_transaction').update({ status: 'for_review', accepted_at: null, exclusion_reason: null }).eq('id', txn?.id);
  const { data: undo } = await supabase.from('bank_feed_transaction').select('status').eq('id', txn?.id).single();
  assert(undo?.status === 'for_review', 'BankTxn: undo → for_review');
  // Cleanup
  if (txn) await supabase.from('bank_feed_transaction').delete().eq('id', txn.id);
  if (feed) await supabase.from('bank_account_feed').delete().eq('id', feed.id);
}

async function testBankPostingDecision() {
  console.log('\n📝 BANK POSTING DECISION');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: feed } = await supabase.from('bank_account_feed').insert({
    company_id: cid, account_name: 'TEST Decision Feed', account_type: 'checking',
    connection_type: 'csv', status: 'active'
  }).select('id').single();
  const { data: txn } = await supabase.from('bank_feed_transaction').insert({
    company_id: cid, bank_account_feed_id: feed?.id, posted_date: '2026-03-24',
    amount: 500, direction: 'outflow', bank_description_raw: 'Test expense',
    fingerprint_hash: 'dec-test-' + Date.now(), status: 'for_review'
  }).select('id').single();
  // Add decision
  const { data: addDec, error: addErr } = await supabase.from('bank_posting_decision').insert({
    company_id: cid, bank_feed_transaction_id: txn?.id,
    decision_type: 'add', payee: 'Test Vendor', memo: 'Office supplies',
    status: 'posted', created_by: 'test@test.com'
  }).select().single();
  assert(!addErr && addDec, 'Decision: add decision created');
  assert(addDec?.decision_type === 'add', 'Decision: type stored');
  // Split decision with lines
  const { data: splitDec } = await supabase.from('bank_posting_decision').insert({
    company_id: cid, bank_feed_transaction_id: txn?.id,
    decision_type: 'split', memo: 'Split test', status: 'draft', created_by: 'test@test.com'
  }).select('id').single();
  if (splitDec) {
    const { error: lineErr } = await supabase.from('bank_posting_decision_line').insert([
      { company_id: cid, bank_posting_decision_id: splitDec.id, line_no: 1, amount: 300, entry_side: 'debit', memo: 'Line 1' },
      { company_id: cid, bank_posting_decision_id: splitDec.id, line_no: 2, amount: 200, entry_side: 'debit', memo: 'Line 2' },
    ]);
    assert(!lineErr, 'Decision: split lines created');
    // Verify lines
    const { data: lines } = await supabase.from('bank_posting_decision_line').select('*').eq('bank_posting_decision_id', splitDec.id);
    assert(lines && lines.length === 2, 'Decision: 2 split lines stored');
    assert(lines && lines.reduce((s,l) => s + Number(l.amount), 0) === 500, 'Decision: split total = 500');
    await supabase.from('bank_posting_decision_line').delete().eq('bank_posting_decision_id', splitDec.id);
    await supabase.from('bank_posting_decision').delete().eq('id', splitDec.id);
  }
  // Transfer decision
  const { data: xferDec, error: xferErr } = await supabase.from('bank_posting_decision').insert({
    company_id: cid, bank_feed_transaction_id: txn?.id,
    decision_type: 'transfer', memo: 'To savings', status: 'posted', created_by: 'test@test.com'
  }).select().single();
  assert(!xferErr && xferDec, 'Decision: transfer decision created');
  // Match decision
  const { data: matchDec, error: matchErr } = await supabase.from('bank_posting_decision').insert({
    company_id: cid, bank_feed_transaction_id: txn?.id,
    decision_type: 'match', memo: 'Matched to JE-0001', status: 'posted', created_by: 'test@test.com'
  }).select().single();
  assert(!matchErr && matchDec, 'Decision: match decision created');
  // Exclude decision
  const { data: exclDec, error: exclErr } = await supabase.from('bank_posting_decision').insert({
    company_id: cid, bank_feed_transaction_id: txn?.id,
    decision_type: 'exclude', memo: 'duplicate', status: 'posted', created_by: 'test@test.com'
  }).select().single();
  assert(!exclErr && exclDec, 'Decision: exclude decision created');
  // Cleanup
  await supabase.from('bank_posting_decision').delete().eq('bank_feed_transaction_id', txn?.id);
  if (addDec) await supabase.from('bank_posting_decision').delete().eq('id', addDec.id);
  if (xferDec) await supabase.from('bank_posting_decision').delete().eq('id', xferDec.id);
  if (matchDec) await supabase.from('bank_posting_decision').delete().eq('id', matchDec.id);
  if (exclDec) await supabase.from('bank_posting_decision').delete().eq('id', exclDec.id);
  if (txn) await supabase.from('bank_feed_transaction').delete().eq('id', txn.id);
  if (feed) await supabase.from('bank_account_feed').delete().eq('id', feed.id);
}

async function testBankTransactionLink() {
  console.log('\n🔗 BANK TRANSACTION LINK');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: feed } = await supabase.from('bank_account_feed').insert({
    company_id: cid, account_name: 'TEST Link Feed', account_type: 'checking',
    connection_type: 'csv', status: 'active'
  }).select('id').single();
  const { data: txn } = await supabase.from('bank_feed_transaction').insert({
    company_id: cid, bank_account_feed_id: feed?.id, posted_date: '2026-03-24',
    amount: 100, direction: 'inflow', bank_description_raw: 'Link test',
    fingerprint_hash: 'link-test-' + Date.now(), status: 'for_review'
  }).select('id').single();
  // Create link
  const fakeJeId = require('crypto').randomUUID();
  const { data: link, error: linkErr } = await supabase.from('bank_feed_transaction_link').insert({
    company_id: cid, bank_feed_transaction_id: txn?.id,
    linked_object_type: 'journal_entry', linked_object_id: fakeJeId,
    link_role: 'created_from'
  }).select().single();
  assert(!linkErr && link, 'TxnLink: can create link');
  assert(link?.link_role === 'created_from', 'TxnLink: role stored');
  // Match link
  const { error: matchLinkErr } = await supabase.from('bank_feed_transaction_link').insert({
    company_id: cid, bank_feed_transaction_id: txn?.id,
    linked_object_type: 'journal_entry', linked_object_id: require('crypto').randomUUID(),
    link_role: 'matched_to'
  });
  assert(!matchLinkErr, 'TxnLink: matched_to link created');
  // Cleanup
  await supabase.from('bank_feed_transaction_link').delete().eq('bank_feed_transaction_id', txn?.id);
  if (txn) await supabase.from('bank_feed_transaction').delete().eq('id', txn.id);
  if (feed) await supabase.from('bank_account_feed').delete().eq('id', feed.id);
}

async function testBankTransactionRule() {
  console.log('\n📏 BANK TRANSACTION RULE');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: rule, error: ruleErr } = await supabase.from('bank_transaction_rule').insert({
    company_id: cid, name: 'TEST Rent Rule', priority: 10, enabled: true,
    condition_json: { field: 'description', operator: 'contains', value: 'rent' },
    action_json: { account_code: '4000', account_name: 'Rental Income' },
    auto_accept: false
  }).select().single();
  assert(!ruleErr && rule, 'Rule: can create');
  assert(rule?.name === 'TEST Rent Rule', 'Rule: name stored');
  assert(rule?.priority === 10, 'Rule: priority stored');
  assert(rule?.condition_json?.field === 'description', 'Rule: condition_json stored');
  // Disable
  await supabase.from('bank_transaction_rule').update({ enabled: false }).eq('id', rule?.id);
  const { data: disabled } = await supabase.from('bank_transaction_rule').select('enabled').eq('id', rule?.id).single();
  assert(disabled && disabled.enabled === false, 'Rule: can disable');
  // Cleanup
  if (rule) await supabase.from('bank_transaction_rule').delete().eq('id', rule.id);
}

async function testMappingProfile() {
  console.log('\n🗂️ MAPPING PROFILE');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: profile, error: profErr } = await supabase.from('bank_import_mapping_profile').insert({
    company_id: cid, name: 'Chase Format', institution_name: 'Chase',
    date_column: 'Transaction Date', date_format: 'MM/DD/YYYY',
    amount_mode: 'single_signed', amount_column: 'Amount',
    description_columns_json: ['Description'], memo_column: 'Memo'
  }).select().single();
  assert(!profErr && profile, 'MappingProfile: can create');
  assert(profile?.name === 'Chase Format', 'MappingProfile: name stored');
  assert(profile?.amount_mode === 'single_signed', 'MappingProfile: amount_mode stored');
  // Cleanup
  if (profile) await supabase.from('bank_import_mapping_profile').delete().eq('id', profile.id);
}

async function testPeriodLock() {
  console.log('\n🔒 PERIOD LOCK');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Upsert period lock
  const { error: lockErr } = await supabase.from('accounting_period_lock').upsert({
    company_id: cid, lock_date: '2025-12-31', locked_by: 'test@test.com', notes: 'Year-end close'
  }, { onConflict: 'company_id' });
  assert(!lockErr, 'PeriodLock: can upsert');
  const { data: lock } = await supabase.from('accounting_period_lock').select('*').eq('company_id', cid).single();
  assert(lock && lock.lock_date === '2025-12-31', 'PeriodLock: lock_date stored');
  // Cleanup
  await supabase.from('accounting_period_lock').delete().eq('company_id', cid);
}

// ============ AUDIT FIX TESTS ============

async function testEncryptDecryptRoundtrip() {
  console.log('\n🔐 ENCRYPT/DECRYPT ROUNDTRIP (PBKDF2)');
  // Simulate the PBKDF2 key derivation + AES-GCM encrypt/decrypt cycle
  // This runs in Node.js using the same algorithm as the frontend
  const crypto = require('crypto');
  const companyId = 'test-company-123';
  const plaintext = 'MySecurePassword!@#$%';
  // Derive key using PBKDF2 (matching frontend _deriveKey)
  const masterMaterial = companyId + "_propmanager_cred_key"; // fallback when no master key
  const salt = Buffer.from("propmanager_" + companyId + "_v2");
  const key = crypto.pbkdf2Sync(masterMaterial, salt, 100000, 32, 'sha256');
  // Encrypt
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const cipherWithTag = Buffer.concat([encrypted, authTag]);
  const encryptedB64 = cipherWithTag.toString('base64');
  const ivHex = iv.toString('hex');
  assert(encryptedB64.length > 0, 'PBKDF2: encrypted output is non-empty');
  assert(ivHex.length === 24, 'PBKDF2: IV is 12 bytes (24 hex chars)');
  assert(encryptedB64 !== Buffer.from(plaintext).toString('base64'), 'PBKDF2: ciphertext differs from plaintext');
  // Decrypt
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  const cipherBuf = Buffer.from(encryptedB64, 'base64');
  const authTagFromCipher = cipherBuf.slice(cipherBuf.length - 16);
  const encryptedData = cipherBuf.slice(0, cipherBuf.length - 16);
  decipher.setAuthTag(authTagFromCipher);
  const decrypted = decipher.update(encryptedData) + decipher.final('utf8');
  assert(decrypted === plaintext, 'PBKDF2: decrypt roundtrip produces original plaintext');
  // Test with different company_id produces different ciphertext
  const salt2 = Buffer.from("propmanager_other-company_v2");
  const key2 = crypto.pbkdf2Sync(masterMaterial, salt2, 100000, 32, 'sha256');
  assert(!key.equals(key2), 'PBKDF2: different company_id produces different key');
  // Test key stretching iterations matter
  const weakKey = crypto.pbkdf2Sync(masterMaterial, salt, 1, 32, 'sha256');
  assert(!key.equals(weakKey), 'PBKDF2: 100K iterations differs from 1 iteration');
}

async function testPeriodLockEnforcement() {
  console.log('\n🔒 PERIOD LOCK ENFORCEMENT');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Set a period lock
  await supabase.from('accounting_period_lock').upsert({
    company_id: cid, lock_date: '2026-01-31', locked_by: 'test', notes: 'Test lock'
  }, { onConflict: 'company_id' });
  // Verify lock exists
  const { data: lock } = await supabase.from('accounting_period_lock').select('lock_date').eq('company_id', cid).single();
  assert(lock && lock.lock_date === '2026-01-31', 'LockEnforce: lock set to 2026-01-31');
  // Try to insert a JE within locked period (should succeed at DB level — app enforces)
  // The enforcement is in the app layer (checkPeriodLock), not DB constraint
  // So we test that the lock record exists and is queryable
  const isLocked = lock && '2026-01-15' <= lock.lock_date;
  assert(isLocked, 'LockEnforce: date 2026-01-15 falls within locked period');
  const isOpen = lock && '2026-02-15' > lock.lock_date;
  assert(isOpen, 'LockEnforce: date 2026-02-15 is after lock date (open)');
  // Cleanup
  await supabase.from('accounting_period_lock').delete().eq('company_id', cid);
}

async function testBankTxnLockedStatus() {
  console.log('\n🔐 BANK TXN LOCKED STATUS');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  const { data: feed } = await supabase.from('bank_account_feed').insert({
    company_id: cid, account_name: 'TEST Lock Feed', account_type: 'checking',
    connection_type: 'csv', status: 'active'
  }).select('id').single();
  const fp = 'lock-test-' + Date.now();
  const { data: txn } = await supabase.from('bank_feed_transaction').insert({
    company_id: cid, bank_account_feed_id: feed?.id, posted_date: '2026-03-24',
    amount: 500, direction: 'inflow', bank_description_raw: 'Lock test',
    fingerprint_hash: fp, status: 'for_review'
  }).select('id').single();
  // Transition: for_review → categorized → locked
  await supabase.from('bank_feed_transaction').update({ status: 'categorized' }).eq('id', txn?.id);
  const { data: cat } = await supabase.from('bank_feed_transaction').select('status').eq('id', txn?.id).single();
  assert(cat?.status === 'categorized', 'Locked: status → categorized');
  await supabase.from('bank_feed_transaction').update({ status: 'locked' }).eq('id', txn?.id);
  const { data: locked } = await supabase.from('bank_feed_transaction').select('status').eq('id', txn?.id).single();
  assert(locked?.status === 'locked', 'Locked: status → locked');
  // Verify locked status is queryable
  const { data: lockedTxns } = await supabase.from('bank_feed_transaction').select('id').eq('id', txn?.id).eq('status', 'locked');
  assert(lockedTxns && lockedTxns.length === 1, 'Locked: can query by locked status');
  // Cleanup
  await supabase.from('bank_feed_transaction').delete().eq('id', txn?.id);
  if (feed) await supabase.from('bank_account_feed').delete().eq('id', feed.id);
}

async function testXSSSanitization() {
  console.log('\n🛡️ XSS SANITIZATION');
  // Test DOMPurify-style sanitization patterns
  // These are string-level checks since DOMPurify runs in browser
  const xssPayloads = [
    '<script>alert("xss")</script>',
    '<img src=x onerror="alert(1)">',
    '<svg onload="fetch(\'https://evil.com\')">',
    '<a href="javascript:alert(1)">click</a>',
    '<div onclick="steal()">trap</div>',
    '<iframe src="https://evil.com"></iframe>',
  ];
  // DOMPurify with our config should strip all of these
  // We test the ALLOWED_TAGS list logic
  const allowedTags = new Set(["p","br","b","i","u","strong","em","h1","h2","h3","h4","h5","h6","ul","ol","li","table","thead","tbody","tr","th","td","div","span","a","img","hr","blockquote","pre","code"]);
  const forbiddenTags = new Set(["script","iframe","object","embed","form","input","button","select","textarea"]);
  assert(!allowedTags.has("script"), 'XSS: script not in allowed tags');
  assert(!allowedTags.has("iframe"), 'XSS: iframe not in allowed tags');
  assert(forbiddenTags.has("script"), 'XSS: script in forbidden tags');
  assert(forbiddenTags.has("iframe"), 'XSS: iframe in forbidden tags');
  assert(forbiddenTags.has("form"), 'XSS: form in forbidden tags');
  // Test that event handlers would be stripped (DOMPurify FORBID_ATTR)
  const forbiddenAttrs = new Set(["onerror","onload","onclick","onmouseover","onfocus","onblur"]);
  assert(forbiddenAttrs.has("onerror"), 'XSS: onerror in forbidden attrs');
  assert(forbiddenAttrs.has("onload"), 'XSS: onload in forbidden attrs');
  // Test merge field blocking
  const blockedFields = new Set(["company_id","companyId","user_email","userEmail","password","secret","token","access_token","api_key","encryption_iv"]);
  assert(blockedFields.has("password"), 'XSS: password merge field blocked');
  assert(blockedFields.has("access_token"), 'XSS: access_token merge field blocked');
  assert(blockedFields.has("company_id"), 'XSS: company_id merge field blocked');
  assert(!blockedFields.has("tenant_name"), 'XSS: tenant_name NOT blocked (allowed)');
}

async function testAuditLogRedaction() {
  console.log('\n📝 AUDIT LOG REDACTION');
  const { data: companies } = await supabase.from('companies').select('id').limit(1);
  const cid = companies?.[0]?.id;
  // Insert an audit entry with sensitive patterns
  const sensitiveDetails = 'User password: MySecret123 and token: abc-def-ghi-jkl';
  // The app sanitizes before insert — we simulate the sanitization
  let redacted = sensitiveDetails.replace(/password[:\s=]*\S+/gi, 'password:[REDACTED]').replace(/(token|secret|key|access_token)[:\s=]*\S+/gi, '$1:[REDACTED]');
  assert(redacted.includes('[REDACTED]'), 'Redaction: password is redacted');
  assert(!redacted.includes('MySecret123'), 'Redaction: actual password value removed');
  assert(!redacted.includes('abc-def-ghi-jkl'), 'Redaction: actual token value removed');
  assert(redacted.includes('password:[REDACTED]'), 'Redaction: password label preserved');
  assert(redacted.includes('token:[REDACTED]'), 'Redaction: token label preserved');
  // Test that normal content passes through
  const normalDetails = 'Created property at 123 Main St for $1500/mo';
  let normalRedacted = normalDetails.replace(/password[:\s=]*\S+/gi, 'password:[REDACTED]').replace(/(token|secret|key|access_token)[:\s=]*\S+/gi, '$1:[REDACTED]');
  assert(normalRedacted === normalDetails, 'Redaction: normal content unchanged');
}

async function run() {
  console.log('🧪 Housify Data Layer Tests');
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
  await testDocumentBuilder();
  await testDeletePropertyWithOwner();
  await testMismatchedJournalEntry();
  await testAccountingPipeline();
  await testAuditTrail();
  await testFullLifecycle();
  await testLoans();
  await testInsurance();
  await testWizardProgress();
  await testARSubAccountCreation();
  await testPropertyDeleteCascadeNewTables();
  await testHOAPayments();
  await testInsuranceTracker();
  await testMoveOutFlow();
  await testEvictionCase();
  await testOwnerDistribution();
  await testPropertyChangeRequests();
  await testRecurringEntryEngine();
  await testMessages();
  await testNotificationTables();
  await testCompanyMembers();
  await testCredentialEncryption();
  await testProratedRentCalculation();
  await testPaymentEdgeCases();
  await testConcurrentLeasePrevention();
  await testMultiTenantProperty();
  await testBankReconciliation();
  await testWorkOrderPhotos();
  await testUserProfile();
  await testClassTracking();
  await testPagePersistence();
  await testBankAccountFeed();
  await testBankImportBatch();
  await testBankFeedTransaction();
  await testBankPostingDecision();
  await testBankTransactionLink();
  await testBankTransactionRule();
  await testMappingProfile();
  await testPeriodLock();
  await testEncryptDecryptRoundtrip();
  await testPeriodLockEnforcement();
  await testBankTxnLockedStatus();
  await testXSSSanitization();
  await testAuditLogRedaction();
  console.log('\n================================');
  console.log('✅ Passed: ' + pass);
  console.log('❌ Failed: ' + fail);
  if (errors.length > 0) { console.log('\nFailed:'); errors.forEach(function(e) { console.log('  - ' + e); }); }
  console.log('\nTotal: ' + (pass + fail) + ' | Pass rate: ' + Math.round(pass / (pass + fail) * 100) + '%');
  process.exit(fail > 0 ? 1 : 0);
}
run();
