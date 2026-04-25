// Move-Out Wizard + per-lease AR coverage. Mixes:
//   - static analysis of src/components/Lifecycle.js + utils/accounting.js
//   - live DB checks against Smith Properties LLC
//
// Run: cd tests && node move-out-and-ar.test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const COMPANY_ID = 'dce4974d-afa9-4e65-afdf-1189b815195d'; // Smith Properties LLC
let pass = 0, fail = 0;
function assert(ok, name, detail) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); fail++; }
}

const lifecycleJs = fs.readFileSync(path.join(__dirname, '../src/components/Lifecycle.js'), 'utf8');
const accountingUtilsJs = fs.readFileSync(path.join(__dirname, '../src/utils/accounting.js'), 'utf8');

(async () => {
console.log('\nMove-Out Wizard + Per-Lease AR');
console.log('================================');

// ─── 1. Move-Out posting model invariants ───────────────────
console.log('\n1. Move-Out posting model invariants');
assert(/Deposit transferred to ledger/.test(lifecycleJs), 'Deposit-transfer JE description present');
assert(/`DEP-TFR-/.test(lifecycleJs), 'DEP-TFR-<id> reference used');
assert(!/DEP-RTN-/.test(lifecycleJs), 'No DEP-RTN- (cash-refund) reference left');
// Scope to MoveOutWizard body — extract from "function MoveOutWizard"
// to "function EvictionWorkflow" so the eviction stage-cost JE
// (which legitimately credits 1000 Checking for actual legal fees)
// doesn't false-positive.
const moveOutBody = lifecycleJs.split(/function\s+EvictionWorkflow\b/)[0];
const moveOutOnly = moveOutBody.split(/function\s+MoveOutWizard\b/).slice(1).join('');
assert(!/account_id: "1000"[\s\S]{0,80}Checking/.test(moveOutOnly),
  'No DR/CR to 1000 Checking inside MoveOutWizard (no auto cash refund)',
  'cash refund leaked into wizard');
// Strip comments before the "no refund wording" check — a comment
// referencing the old behavior is fine, an actual JE description
// or memo is not.
const moveOutCodeOnly = moveOutOnly.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert(!/Deposit refund to|Security deposit returned/.test(moveOutCodeOnly),
  'No "Deposit refund / returned" wording in MoveOutWizard executable code');
assert(/getOrCreateTenantAR\(cid, tName, selectedTenant\.id\)/.test(lifecycleJs), 'Waive credit hits tenant AR sub-account');
assert(/account_id: "5500", account_name: "Bad Debt Expense"/.test(lifecycleJs), 'Bad Debt Expense (5500) is the DR side of write-off');
assert(/netOwed = .*outstandingBalance.*depositAmount.*totalDeductions/s.test(lifecycleJs.replace(/\n/g, ' ')) ||
  /netOwed = Math.round\(\(outstandingBalance - depositAmount \+ totalDeductions\)/.test(lifecycleJs),
  'Waive netOwed formula = outstanding − deposit + deductions');
assert(!/queueNotification\("deposit_returned"/.test(lifecycleJs), 'deposit_returned notification NOT queued (no auto-refund)');

// ─── 2. Move-Out reads balance live from GL on tenant select ─
console.log('\n2. selectTenant reads balance from GL');
assert(/setOutstandingBalance\(/.test(lifecycleJs), 'outstandingBalance is state, not derived from selectedTenant.balance');
assert(/acct_journal_lines[\s\S]{0,400}neq\("acct_journal_entries\.status", "voided"\)/.test(lifecycleJs),
  'GL query excludes voided JEs');
assert(/getOrCreateTenantAR|acct_accounts.*tenant_id|name.*"AR - "/.test(lifecycleJs), 'AR sub-account resolution path present');

// ─── 3. Per-lease AR — getOrCreateTenantAR keys by tenant_id ─
console.log('\n3. getOrCreateTenantAR per-lease keying');
assert(/cacheKey = `\$\{companyId\}::\$\{tenantId \|\| tenantName\}`/.test(accountingUtilsJs),
  'Cache key uses tenantId, not bare name');
assert(/eq\("tenant_id", tenantId\)\.maybeSingle/.test(accountingUtilsJs),
  'Lookup by acct_accounts.tenant_id first');
assert(/shortProp|split\(","\)\[0\]/.test(accountingUtilsJs), 'New per-lease account name includes short property');
assert(/acct_accounts.*tenant_id: tenantId/.test(accountingUtilsJs), 'New AR sub-account populates tenant_id');

// ─── 4. Live DB: Smith's per-lease AR is wired correctly ─────
console.log('\n4. Live data — Smith Sahil per-lease AR');
const { data: sahilTenants } = await sb.from('tenants')
  .select('id, name, property, balance, archived_at')
  .eq('company_id', COMPANY_ID).eq('name', 'Sahil Agarwal');
assert(sahilTenants && sahilTenants.length >= 2, '≥2 Sahil Agarwal tenant rows at Smith', `got ${sahilTenants?.length}`);

const activeS = (sahilTenants || []).filter(t => !t.archived_at);
for (const t of activeS) {
  const { data: arById } = await sb.from('acct_accounts')
    .select('id, code, name, tenant_id').eq('company_id', COMPANY_ID)
    .eq('type', 'Asset').eq('tenant_id', t.id).maybeSingle();
  assert(!!arById, `tenant ${t.id} has its own AR sub-account (tenant_id keyed)`, t.property);
  if (arById) {
    const propShort = (t.property || '').split(',')[0].trim();
    assert(arById.name.includes(propShort), `AR account name includes property "${propShort}"`, arById.name);
    // Confirm GL balance == tenants.balance
    const { data: lines } = await sb.from('acct_journal_lines')
      .select('debit, credit, acct_journal_entries!inner(status)')
      .eq('company_id', COMPANY_ID).eq('account_id', arById.id)
      .neq('acct_journal_entries.status', 'voided');
    const glBal = (lines || []).reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
    assert(Math.abs(glBal - Number(t.balance || 0)) < 0.01,
      `tenant ${t.id} stored balance == GL`, `stored=${t.balance} GL=${glBal}`);
  }
}

// ─── 5. tenants.balance NOT stale across active tenants ─────
console.log('\n5. tenants.balance == GL for every active tenant at Smith');
const { data: actives } = await sb.from('tenants').select('id, name, property, balance').eq('company_id', COMPANY_ID).is('archived_at', null);
let staleCount = 0;
for (const t of (actives || [])) {
  // find AR by tenant_id then by name
  let arId = null;
  const { data: byId } = await sb.from('acct_accounts').select('id').eq('company_id', COMPANY_ID).eq('type', 'Asset').eq('tenant_id', t.id).maybeSingle();
  arId = byId?.id || null;
  if (!arId) {
    const { data: byName } = await sb.from('acct_accounts').select('id').eq('company_id', COMPANY_ID).eq('type', 'Asset').eq('name', 'AR - ' + t.name).maybeSingle();
    arId = byName?.id || null;
  }
  if (!arId) continue;
  const { data: lines } = await sb.from('acct_journal_lines')
    .select('debit, credit, acct_journal_entries!inner(status)')
    .eq('company_id', COMPANY_ID).eq('account_id', arId)
    .neq('acct_journal_entries.status', 'voided');
  const glBal = (lines || []).reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
  if (Math.abs(glBal - Number(t.balance || 0)) >= 0.01) staleCount++;
}
assert(staleCount === 0, 'No stale tenants.balance vs GL across active Smith tenants', `${staleCount} tenants drift`);

console.log('\n================================');
console.log(`✅ Passed: ${pass}`);
console.log(`❌ Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
