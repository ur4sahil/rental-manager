// Database-level invariants added this week. Confirms the live DB
// rejects rows that violate the constraints, rather than trusting
// application code to keep them consistent.
//
//   - recurring_journal_entries: (tenant_name null-or-empty) =
//     (tenant_id null)  [CHECK recurring_je_tenant_pair_check]
//   - bank_reconciliations.status ∈ {reconciled, in_progress,
//     discrepancy, pending_items, reopened}
//   - bank_reconciliations.bank_ending_balance NOT NULL
//   - push_subscriptions UNIQUE (company_id, user_email)
//   - recurring_journal_entries.tenant_id is bigint (not uuid)
//   - acct_accounts.tenant_id is bigint (not uuid)
//
// Run: cd tests && node schema-invariants.test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const PROBE_CO = 'SCHEMA_PROBE_CO';
let pass = 0, fail = 0;
function assert(ok, name, detail) { if (ok) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); fail++; } }

(async () => {
console.log('\nSchema Invariants');
console.log('================================');

// ─── 1. recurring_journal_entries tenant_pair CHECK ─────────
console.log('\n1. recurring_journal_entries CHECK (tenant_name ⇔ tenant_id)');
// Cleanup any prior probes
await sb.from('recurring_journal_entries').delete().eq('company_id', PROBE_CO);

// 1a. tenant_name set, tenant_id null → should fail
const { error: e1a } = await sb.from('recurring_journal_entries').insert([{
  company_id: PROBE_CO, description: 'probe', frequency: 'monthly', day_of_month: 1, amount: 0,
  tenant_name: 'Probe Tenant', tenant_id: null, property: 'Probe Prop', status: 'active',
}]);
assert(e1a && /recurring_je_tenant_pair_check|check constraint/i.test(e1a.message),
  'Reject: tenant_name set, tenant_id null', e1a?.message?.slice(0, 80));

// 1b. tenant_name null, tenant_id set → should fail
const { error: e1b } = await sb.from('recurring_journal_entries').insert([{
  company_id: PROBE_CO, description: 'probe', frequency: 'monthly', day_of_month: 1, amount: 0,
  tenant_name: null, tenant_id: 999999999, property: 'Probe', status: 'active',
}]);
assert(e1b && /recurring_je_tenant_pair_check|check constraint/i.test(e1b.message),
  'Reject: tenant_name null, tenant_id set');

// 1c. both null → should succeed (property-level recurring)
const { data: ok1c, error: e1c } = await sb.from('recurring_journal_entries').insert([{
  company_id: PROBE_CO, description: 'probe property-level', frequency: 'monthly', day_of_month: 1, amount: 0,
  tenant_name: null, tenant_id: null, property: 'Probe', status: 'active',
}]).select('id').maybeSingle();
assert(!e1c && ok1c?.id, 'Accept: both null (property-level)', e1c?.message);
if (ok1c?.id) await sb.from('recurring_journal_entries').delete().eq('id', ok1c.id);

// 1d. both set → should succeed (tenant rent)
const { data: ok1d, error: e1d } = await sb.from('recurring_journal_entries').insert([{
  company_id: PROBE_CO, description: 'probe tenant', frequency: 'monthly', day_of_month: 1, amount: 0,
  tenant_name: 'Probe', tenant_id: 999999998, property: 'Probe', status: 'active',
}]).select('id').maybeSingle();
assert(!e1d && ok1d?.id, 'Accept: both set (tenant rent)', e1d?.message);
if (ok1d?.id) await sb.from('recurring_journal_entries').delete().eq('id', ok1d.id);

// 1e. empty-string tenant_name + null tenant_id → should succeed
//     (constraint treats '' as null-equivalent)
const { data: ok1e, error: e1e } = await sb.from('recurring_journal_entries').insert([{
  company_id: PROBE_CO, description: 'probe empty name', frequency: 'monthly', day_of_month: 1, amount: 0,
  tenant_name: '', tenant_id: null, property: 'Probe', status: 'active',
}]).select('id').maybeSingle();
assert(!e1e && ok1e?.id, 'Accept: empty tenant_name + null tenant_id', e1e?.message);
if (ok1e?.id) await sb.from('recurring_journal_entries').delete().eq('id', ok1e.id);

// ─── 2. bank_reconciliations status + NOT NULL balance ──────
console.log('\n2. bank_reconciliations CHECK + NOT NULL');

// 2a. status='foo' → reject
const { error: e2a } = await sb.from('bank_reconciliations').insert([{
  company_id: PROBE_CO, period: '2099-01', status: 'foo', bank_ending_balance: 0,
}]);
assert(e2a && /status_check|check constraint/i.test(e2a.message),
  'Reject invalid status "foo"');

// 2b. Each valid status accepted
for (const v of ['reconciled', 'in_progress', 'discrepancy', 'pending_items', 'reopened']) {
  const { data: ok, error: err } = await sb.from('bank_reconciliations').insert([{
    company_id: PROBE_CO, period: '2099-01', status: v, bank_ending_balance: 0,
  }]).select('id').maybeSingle();
  assert(!err && ok?.id, `Accept status "${v}"`, err?.message);
  if (ok?.id) await sb.from('bank_reconciliations').delete().eq('id', ok.id);
}

// 2c. bank_ending_balance null → reject
const { error: e2c } = await sb.from('bank_reconciliations').insert([{
  company_id: PROBE_CO, period: '2099-02', status: 'reconciled',
}]);
assert(e2c && /bank_ending_balance|not-null/i.test(e2c.message),
  'Reject null bank_ending_balance');

// ─── 3. push_subscriptions UNIQUE(company_id, user_email) ───
console.log('\n3. push_subscriptions UNIQUE');
await sb.from('push_subscriptions').delete().eq('company_id', PROBE_CO);
const dummy = { endpoint: 'https://p.com/x', keys: { p256dh: 'a', auth: 'b' } };
const { data: ps1 } = await sb.from('push_subscriptions').insert([{
  company_id: PROBE_CO, user_email: 'uniq@test.com', subscription: dummy,
}]).select('id').maybeSingle();
assert(!!ps1, 'First push subscription inserts');
// Try direct insert of duplicate — should fail
const { error: dupErr } = await sb.from('push_subscriptions').insert([{
  company_id: PROBE_CO, user_email: 'uniq@test.com', subscription: dummy,
}]);
assert(dupErr && /unique|duplicate/i.test(dupErr.message),
  'Reject duplicate (company_id, user_email) insert', dupErr?.message?.slice(0, 80));
// Upsert with onConflict should succeed
const { error: upErr } = await sb.from('push_subscriptions').upsert([{
  company_id: PROBE_CO, user_email: 'uniq@test.com', subscription: dummy,
}], { onConflict: 'company_id,user_email' });
assert(!upErr, 'Upsert with onConflict="company_id,user_email" succeeds', upErr?.message);
await sb.from('push_subscriptions').delete().eq('company_id', PROBE_CO);

// ─── 4. tenant_id column types are bigint ───────────────────
console.log('\n4. Column types (bigint, not uuid)');
// Attempting to write a uuid into a bigint column errors with a type
// complaint that names bigint / integer, NOT "invalid uuid".
const { error: tyRecur } = await sb.from('recurring_journal_entries').insert([{
  company_id: PROBE_CO, description: 'type probe', frequency: 'monthly', day_of_month: 1, amount: 0,
  tenant_name: 'probe', tenant_id: '00000000-0000-0000-0000-000000000000', property: 'Probe', status: 'active',
}]);
assert(tyRecur && /bigint|integer|invalid input syntax for type bigint/i.test(tyRecur.message),
  'recurring_journal_entries.tenant_id is bigint', tyRecur?.message?.slice(0, 100));

const { error: tyAcct } = await sb.from('acct_accounts').insert([{
  company_id: PROBE_CO, code: 'TYPE-PROBE', name: 'TP', type: 'Asset', is_active: true, old_text_id: 'tp',
  tenant_id: '00000000-0000-0000-0000-000000000000',
}]);
assert(tyAcct && /bigint|integer|invalid input syntax for type bigint/i.test(tyAcct.message),
  'acct_accounts.tenant_id is bigint', tyAcct?.message?.slice(0, 100));

console.log('\n================================');
console.log(`✅ Passed: ${pass}`);
console.log(`❌ Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
