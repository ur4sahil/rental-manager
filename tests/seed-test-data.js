require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// All test data scoped to this company
const COMPANY_ID = 'sandbox-llc';

async function seedTestData() {
  console.log('🌱 Seeding test data for company: ' + COMPANY_ID + '\n');

  // ─── 1. Properties ───
  const properties = [
    { address: '100 Oak Street, Unit A', type: 'Single Family', status: 'occupied', rent: 1800, notes: 'Test property 1', company_id: COMPANY_ID },
    { address: '200 Maple Ave, Apt 2B', type: 'Apartment', status: 'occupied', rent: 1200, notes: 'Test property 2', company_id: COMPANY_ID },
    { address: '300 Pine Road', type: 'Townhouse', status: 'vacant', rent: 2200, notes: 'Test property 3', company_id: COMPANY_ID },
    { address: '400 Cedar Lane, #101', type: 'Condo', status: 'occupied', rent: 1500, notes: 'Test property 4', company_id: COMPANY_ID },
  ];
  const { data: propData, error: propErr } = await supabase.from('properties').insert(properties).select();
  if (propErr) { console.error('❌ Properties:', propErr.message); return; }
  console.log('✅ ' + propData.length + ' properties created');

  // ─── 2. Tenants ───
  const tenants = [
    { name: 'Alice Johnson', email: 'alice@test.com', phone: '555-0101', property: '100 Oak Street, Unit A', rent: 1800, balance: 0, lease_status: 'active', company_id: COMPANY_ID },
    { name: 'Bob Martinez', email: 'bob@test.com', phone: '555-0102', property: '200 Maple Ave, Apt 2B', rent: 1200, balance: 250, lease_status: 'active', company_id: COMPANY_ID },
    { name: 'Carol Williams', email: 'carol@test.com', phone: '555-0103', property: '400 Cedar Lane, #101', rent: 1500, balance: 0, lease_status: 'active', company_id: COMPANY_ID },
    { name: 'Dave Thompson', email: 'dave@test.com', phone: '555-0104', property: '300 Pine Road', rent: 2200, balance: 3200, lease_status: 'inactive', company_id: COMPANY_ID },
  ];
  const { data: tenData, error: tenErr } = await supabase.from('tenants').insert(tenants).select();
  if (tenErr) { console.error('❌ Tenants:', tenErr.message); return; }
  console.log('✅ ' + tenData.length + ' tenants created');

  // ─── 3. Accounting Accounts (acct_accounts) ───
  const accounts = [
    { id: COMPANY_ID + '-1000', name: 'Checking Account', type: 'Asset', subtype: 'Bank', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-1100', name: 'Accounts Receivable', type: 'Asset', subtype: 'Accounts Receivable', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-2100', name: 'Security Deposits Held', type: 'Liability', subtype: 'Other Current Liability', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-2200', name: 'Owner Distributions Payable', type: 'Liability', subtype: 'Other Current Liability', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-3000', name: 'Owner Equity', type: 'Equity', subtype: 'Owner Equity', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-4000', name: 'Rental Income', type: 'Revenue', subtype: 'Rental Income', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-4010', name: 'Late Fee Income', type: 'Revenue', subtype: 'Other Primary Income', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-4100', name: 'Other Income', type: 'Revenue', subtype: 'Other Primary Income', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-4200', name: 'Management Fee Income', type: 'Revenue', subtype: 'Service Income', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-5300', name: 'Repairs & Maintenance', type: 'Expense', subtype: 'Maintenance & Repairs', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-5400', name: 'Utilities', type: 'Expense', subtype: 'Utilities', is_active: true, company_id: COMPANY_ID },
    { id: COMPANY_ID + '-5500', name: 'HOA Fees', type: 'Expense', subtype: 'Other Expense', is_active: true, company_id: COMPANY_ID },
  ];
  for (const acc of accounts) {
    await supabase.from('acct_accounts').upsert(acc, { onConflict: 'id' });
  }
  console.log('✅ ' + accounts.length + ' acct_accounts upserted');

  // ─── 4. Accounting Classes (acct_classes) ───
  const classes = propData.map((p, i) => ({
    id: `PROP-${p.id}`,
    name: p.address,
    description: `${p.type} · $${p.rent}/mo`,
    color: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444'][i],
    is_active: true,
    company_id: COMPANY_ID,
  }));
  for (const cls of classes) {
    await supabase.from('acct_classes').upsert(cls, { onConflict: 'id' });
  }
  console.log('✅ ' + classes.length + ' acct_classes created');

  // ─── 5. Payments ───
  const today = new Date().toISOString().slice(0, 10);
  const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const payments = [
    { tenant: 'Alice Johnson', property: '100 Oak Street, Unit A', amount: 1800, date: lastMonth, type: 'rent', method: 'ACH', status: 'paid', company_id: COMPANY_ID },
    { tenant: 'Alice Johnson', property: '100 Oak Street, Unit A', amount: 1800, date: today, type: 'rent', method: 'ACH', status: 'paid', company_id: COMPANY_ID },
    { tenant: 'Bob Martinez', property: '200 Maple Ave, Apt 2B', amount: 1200, date: lastMonth, type: 'rent', method: 'credit_card', status: 'paid', company_id: COMPANY_ID },
    { tenant: 'Bob Martinez', property: '200 Maple Ave, Apt 2B', amount: 950, date: today, type: 'rent', method: 'credit_card', status: 'partial', company_id: COMPANY_ID },
    { tenant: 'Carol Williams', property: '400 Cedar Lane, #101', amount: 1500, date: today, type: 'rent', method: 'check', status: 'paid', company_id: COMPANY_ID },
  ];
  const { data: payData, error: payErr } = await supabase.from('payments').insert(payments).select();
  if (payErr) { console.error('❌ Payments:', payErr.message); return; }
  console.log('✅ ' + payData.length + ' payments created');

  // ─── 6. Work Orders ───
  const workOrders = [
    { property: '100 Oak Street, Unit A', issue: 'Leaking faucet in kitchen', priority: 'normal', status: 'open', tenant: 'Alice Johnson', assigned: 'Mike Plumber', company_id: COMPANY_ID },
    { property: '200 Maple Ave, Apt 2B', issue: 'AC not cooling', priority: 'emergency', status: 'in_progress', tenant: 'Bob Martinez', assigned: 'CoolAir HVAC', company_id: COMPANY_ID },
    { property: '300 Pine Road', issue: 'Paint touch-up before listing', priority: 'low', status: 'completed', tenant: '', assigned: 'QuickPaint LLC', cost: 450, company_id: COMPANY_ID },
  ];
  const { data: woData, error: woErr } = await supabase.from('work_orders').insert(workOrders).select();
  if (woErr) { console.error('❌ Work orders:', woErr.message); return; }
  console.log('✅ ' + woData.length + ' work orders created');

  // ─── 7. Vendors ───
  const vendors = [
    { name: 'Mike Plumber', company: 'Mikes Plumbing', specialty: 'Plumbing', email: 'mike@plumbing.com', phone: '555-0201', rating: 5, status: 'active', license_number: 'PLB-12345', company_id: COMPANY_ID },
    { name: 'CoolAir HVAC', company: 'CoolAir Inc', specialty: 'HVAC', email: 'service@coolair.com', phone: '555-0202', rating: 4, status: 'active', license_number: 'HVAC-67890', company_id: COMPANY_ID },
    { name: 'QuickPaint LLC', company: 'QuickPaint', specialty: 'Painting', email: 'info@quickpaint.com', phone: '555-0203', rating: 4, status: 'active', company_id: COMPANY_ID },
  ];
  const { data: venData, error: venErr } = await supabase.from('vendors').insert(vendors).select();
  if (venErr) { console.error('❌ Vendors:', venErr.message); return; }
  console.log('✅ ' + venData.length + ' vendors created');

  // ─── 8. Owners ───
  const owners = [
    { name: 'Robert Chen', email: 'robert@test.com', phone: '555-0301', company: 'Chen Properties LLC', management_fee_pct: 10, payment_method: 'ACH', status: 'active', company_id: COMPANY_ID },
    { name: 'Sarah Kim', email: 'sarah@test.com', phone: '555-0302', company: '', management_fee_pct: 8, payment_method: 'check', status: 'active', company_id: COMPANY_ID },
  ];
  const { data: ownData, error: ownErr } = await supabase.from('owners').upsert(owners, { onConflict: 'email' }).select();
  if (ownErr) { console.error('❌ Owners:', ownErr.message); return; }
  console.log('✅ ' + ownData.length + ' owners created');

  // Assign owners to properties
  if (ownData[0] && propData[0]) {
    await supabase.from('properties').update({ owner_id: ownData[0].id, owner_name: 'Robert Chen' }).eq('id', propData[0].id);
    await supabase.from('properties').update({ owner_id: ownData[0].id, owner_name: 'Robert Chen' }).eq('id', propData[1].id);
  }
  if (ownData[1] && propData[2]) {
    await supabase.from('properties').update({ owner_id: ownData[1].id, owner_name: 'Sarah Kim' }).eq('id', propData[2].id);
    await supabase.from('properties').update({ owner_id: ownData[1].id, owner_name: 'Sarah Kim' }).eq('id', propData[3].id);
  }
  console.log('✅ Properties assigned to owners');

  // ─── 9. Lease Templates ───
  const { error: tmplErr } = await supabase.from('lease_templates').upsert([
    { name: 'Standard 12-Month', description: 'Standard residential lease', clauses: 'No pets without approval. No smoking. Quiet hours 10pm-7am.', special_terms: '', default_deposit_months: 1, default_lease_months: 12, default_escalation_pct: 3, payment_due_day: 1, company_id: COMPANY_ID },
  ], { onConflict: 'name' });
  if (tmplErr && !tmplErr.message.includes('duplicate')) console.error('❌ Templates:', tmplErr.message);
  else console.log('✅ Lease template created');

  // ─── 10. Utilities ───
  const utilities = [
    { property: '100 Oak Street, Unit A', provider: 'City Water', amount: 85, due: today, responsibility: 'owner', status: 'paid', company_id: COMPANY_ID },
    { property: '200 Maple Ave, Apt 2B', provider: 'PowerGrid Electric', amount: 142, due: today, responsibility: 'tenant', status: 'pending', company_id: COMPANY_ID },
  ];
  const { error: utilErr } = await supabase.from('utilities').insert(utilities);
  if (utilErr) console.error('❌ Utilities:', utilErr.message);
  else console.log('✅ Utility bills created');

  // ─── 11. Journal Entries (acct_journal_entries + acct_journal_lines) ───
  const jeId = `je-seed-${Date.now()}`;
  const { error: jeErr } = await supabase.from('acct_journal_entries').insert([{
    id: jeId,
    number: 'JE-SEED-001',
    date: today,
    description: 'Rent payment — Alice Johnson — 100 Oak Street, Unit A',
    reference: 'PAY-SEED-001',
    status: 'posted',
    company_id: COMPANY_ID,
  }]);
  if (jeErr) { console.error('❌ Journal Entry:', jeErr.message); }
  else {
    await supabase.from('acct_journal_lines').insert([
      { journal_entry_id: jeId, account_id: COMPANY_ID + '-1000', account_name: 'Checking Account', debit: 1800, credit: 0, memo: 'ACH from Alice Johnson' },
      { journal_entry_id: jeId, account_id: COMPANY_ID + '-4000', account_name: 'Rental Income', debit: 0, credit: 1800, memo: 'Alice Johnson — 100 Oak Street, Unit A' },
    ]);
    console.log('✅ Journal entry with lines created');
  }

  // ─── 12. Ledger Entries ───
  // Phase 4: ledger_entries is a VIEW derived from acct_journal_lines
  // on per-tenant AR accounts. No direct seed needed — the JE above
  // (when posted to a per-tenant AR) automatically surfaces in the
  // view. Skipping the direct insert.
  console.log('ℹ️  Ledger entries skipped (view-derived in Phase 4)');

  // ─── 13. Messages ───
  const { error: msgErr } = await supabase.from('messages').insert([
    { tenant: 'Alice Johnson', property: '100 Oak Street, Unit A', sender: 'admin', message: 'Welcome to your new home!', read: false, company_id: COMPANY_ID },
  ]);
  if (msgErr) console.error('❌ Messages:', msgErr.message);
  else console.log('✅ Messages created');

  // ─── 14. Inspections ───
  const { error: inspErr } = await supabase.from('inspections').insert([
    { property: '100 Oak Street, Unit A', type: 'Move-In', inspector: 'Test Inspector', date: today, status: 'completed', notes: 'All good', checklist: JSON.stringify({ 'Walls': { pass: true, notes: '' }, 'Floors': { pass: true, notes: '' } }), company_id: COMPANY_ID },
  ]);
  if (inspErr) console.error('❌ Inspections:', inspErr.message);
  else console.log('✅ Inspections created');

  // ─── 15. App Users ───
  const { error: appUserErr } = await supabase.from('app_users').upsert([
    { email: 'admin@propmanager.com', name: 'Admin User', role: 'admin', company_id: COMPANY_ID },
  ], { onConflict: 'email' });
  if (appUserErr) console.error('❌ App Users:', appUserErr.message);
  else console.log('✅ App users created');

  // ─── 16. Audit Trail ───
  const { error: auditErr } = await supabase.from('audit_trail').insert([
    { action: 'create', module: 'properties', details: 'Seed data created', user_email: 'admin@propmanager.com', user_role: 'admin', company_id: COMPANY_ID },
  ]);
  if (auditErr) console.error('❌ Audit trail:', auditErr.message);
  else console.log('✅ Audit trail entry created');

  // ─── 17. HOA Payments ───
  const { error: hoaErr } = await supabase.from('hoa_payments').insert([
    { property: '400 Cedar Lane, #101', hoa_name: 'Cedar HOA', amount: 350, frequency: 'monthly', status: 'unpaid', company_id: COMPANY_ID },
  ]);
  if (hoaErr) console.error('❌ HOA Payments:', hoaErr.message);
  else console.log('✅ HOA payment created');

  // ─── 18. Notification Settings ───
  const { error: nsErr } = await supabase.from('notification_settings').upsert([
    { event_type: 'rent_due', enabled: true, days_before: 3, template: 'Rent is due in {{days}} days.', company_id: COMPANY_ID },
  ], { onConflict: 'event_type,company_id' });
  if (nsErr) console.error('❌ Notification Settings:', nsErr.message);
  else console.log('✅ Notification settings created');

  console.log('\n🎉 Test data seeding complete!');
}

seedTestData().catch(console.error);
