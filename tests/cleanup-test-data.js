require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function cleanup() {
  console.log('Cleaning up test data...');
  var testTenants = ['Alice Johnson', 'Bob Martinez', 'Carol Williams', 'Dave Thompson'];
  var testVendors = ['Mike Plumber', 'CoolAir HVAC', 'QuickPaint LLC'];
  var testOwners = ['robert@test.com', 'sarah@test.com'];
  var testProps = ['100 Oak Street', '200 Maple Ave', '300 Pine Road', '400 Cedar Lane', 'TEMP-TEST', 'E2E Test'];

  await supabase.from('lease_signatures').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  for (var t of testTenants) { await supabase.from('leases').delete().eq('tenant_name', t); }
  for (var e of testOwners) {
    var r = await supabase.from('owners').select('id').eq('email', e).maybeSingle();
    if (r.data) { await supabase.from('owner_distributions').delete().eq('owner_id', r.data.id); await supabase.from('owner_statements').delete().eq('owner_id', r.data.id); }
  }
  for (var t of testTenants) { await supabase.from('payments').delete().eq('tenant', t); }
  await supabase.from('payments').delete().eq('tenant', 'Test');
  for (var p of testProps) { await supabase.from('work_orders').delete().ilike('property', p + '%'); }
  for (var p of testProps) { await supabase.from('utilities').delete().ilike('property', p + '%'); }
  for (var v of testVendors) { await supabase.from('vendors').delete().eq('name', v); }
  for (var t of testTenants) { await supabase.from('tenants').delete().eq('name', t); }
  for (var p of testProps) { await supabase.from('properties').delete().ilike('address', p + '%'); }
  for (var e of testOwners) { await supabase.from('owners').delete().eq('email', e); }
  await supabase.from('audit_trail').delete().eq('user_email', 'test@test.com');
  await supabase.from('journal_entries').delete().ilike('description', 'Test%');
  console.log('Done! Run "node seed-test-data.js" to re-seed.');
}
cleanup().catch(console.error);
