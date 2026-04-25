// Verifies that autoPostRecurringEntries updates tenants.balance
// now that recurring_journal_entries.tenant_id is bigint + populated.
// Static checks + live spot-check that the same-name-different-
// property case is resolved correctly.
//
// Run: cd tests && node recurring-balance-sync.test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

let pass = 0, fail = 0;
function assert(ok, name, detail) { if (ok) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); fail++; } }

const acctUtils = fs.readFileSync(path.join(__dirname, '../src/utils/accounting.js'), 'utf8');
const sharedJs  = fs.readFileSync(path.join(__dirname, '../src/components/shared.js'),  'utf8');

(async () => {
console.log('\nRecurring → tenants.balance sync');
console.log('================================');

// ─── 1. autoPostRecurringEntries source-level shape ─────────
console.log('\n1. autoPostRecurringEntries gate + invariant alarm');
assert(/if \(entry\.tenant_id && entry\.debit_account_id\)/.test(acctUtils),
  'Gated on tenant_id && debit_account_id (no stealthy bypass)');
assert(/recurring entry has tenant_name but no tenant_id/.test(acctUtils),
  'pmError fires on invariant violation (visible, not silent)');
assert(/update_tenant_balance/.test(acctUtils), 'update_tenant_balance RPC called');

// ─── 2. RecurringEntryModal writes tenant_id as bigint ──────
console.log('\n2. RecurringEntryModal writer');
assert(/payload\.tenant_id = Number\(entry\.tenantId\)/.test(sharedJs),
  'shared.js casts tenantId to Number before insert (no UUID guard)');
assert(!/isUUID\(String\(entry\.tenantId\)\)/.test(sharedJs),
  'Old UUID guard removed');

// ─── 3. Live — every non-null recurring tenant_id points at a real tenant ───
console.log('\n3. Live — tenant_id referential integrity');
const { data: recurs } = await sb.from('recurring_journal_entries')
  .select('id, company_id, tenant_id, tenant_name, property').not('tenant_id', 'is', null);
const tenantIds = [...new Set((recurs || []).map(r => r.tenant_id))];
const { data: tenants } = await sb.from('tenants').select('id, name, property, company_id').in('id', tenantIds);
const byId = Object.fromEntries((tenants || []).map(t => [t.id, t]));
let orphans = 0, wrongCo = 0, nameMismatch = 0;
for (const r of (recurs || [])) {
  const t = byId[r.tenant_id];
  if (!t) { orphans++; continue; }
  if (t.company_id !== r.company_id) wrongCo++;
  if (t.name !== r.tenant_name) nameMismatch++;
}
assert(orphans === 0, 'All recurring tenant_ids resolve to a tenants row', `${orphans} orphaned`);
assert(wrongCo === 0, 'Tenant company_id matches recurring company_id', `${wrongCo} cross-company`);
assert(nameMismatch === 0, 'Tenant name matches recurring tenant_name', `${nameMismatch} mismatches`);

// ─── 4. Live — Smith: zero rows violate the tenant_name/tenant_id pair invariant ───
console.log('\n4. Live — Smith invariant clean');
const { data: violators } = await sb.from('recurring_journal_entries')
  .select('id').eq('company_id', SMITH).not('tenant_name', 'is', null).neq('tenant_name', '').is('tenant_id', null);
assert((violators?.length || 0) === 0,
  'Zero Smith recurring rows with tenant_name set and tenant_id null', `${violators?.length || 0} violators`);

// ─── 5. Live — Smith: Sahil's three recurring rows attribute to three distinct tenant_ids ───
console.log('\n5. Live — Smith Sahil recurring rows');
const { data: sahilRecurs } = await sb.from('recurring_journal_entries')
  .select('id, tenant_id, property').eq('company_id', SMITH).eq('tenant_name', 'Sahil Agarwal');
const distinct = new Set((sahilRecurs || []).map(r => r.tenant_id));
assert(distinct.size >= 2, 'At least two distinct tenant_ids on Sahil recurring rows', `distinct=${distinct.size}`);

console.log('\n================================');
console.log(`✅ Passed: ${pass}`);
console.log(`❌ Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
