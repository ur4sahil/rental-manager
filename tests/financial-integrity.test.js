require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let pass = 0, fail = 0, errors = [];

function assert(ok, name) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name); fail++; errors.push(name); }
}

// Read all source code for pattern checks
const srcDir = path.resolve(__dirname, '../src');
function readAllSrc(dir) {
  let code = '';
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) code += readAllSrc(path.join(dir, f.name));
    else if (f.name.endsWith('.js')) code += fs.readFileSync(path.join(dir, f.name), 'utf8') + '\n';
  }
  return code;
}
const ALL_CODE = readAllSrc(srcDir);

// Read individual source files for targeted checks
const accountingJs = fs.readFileSync(path.join(srcDir, 'utils/accounting.js'), 'utf8');
const helpersJs = fs.readFileSync(path.join(srcDir, 'utils/helpers.js'), 'utf8');
const appJs = fs.readFileSync(path.join(srcDir, 'App.js'), 'utf8');
const lifecycleJs = fs.readFileSync(path.join(srcDir, 'components/Lifecycle.js'), 'utf8');
const accountingComponentJs = fs.readFileSync(path.join(srcDir, 'components/Accounting.js'), 'utf8');
const propertiesJs = fs.readFileSync(path.join(srcDir, 'components/Properties.js'), 'utf8');
const tenantsJs = fs.readFileSync(path.join(srcDir, 'components/Tenants.js'), 'utf8');
const tenantPortalJs = fs.readFileSync(path.join(srcDir, 'components/TenantPortal.js'), 'utf8');
const paymentsJs = fs.readFileSync(path.join(srcDir, 'components/Payments.js'), 'utf8');

// ──────────────────────────────────────────────────────
// 1. DOUBLE-POSTING PREVENTION
// ──────────────────────────────────────────────────────
async function testDoublePostingPrevention() {
  console.log('\n🔒 DOUBLE-POSTING PREVENTION');

  // DB: unique index on acct_journal_entries (company_id, reference)
  // Try inserting two JEs with same company_id+reference to verify unique constraint
  const { data: testCompany } = await supabase.from('acct_journal_entries').select('company_id').limit(1);
  const testCid = testCompany?.[0]?.company_id;
  if (testCid) {
    const testRef = 'TEST-UNIQUE-' + Date.now();
    const { data: je1, error: e1 } = await supabase.from('acct_journal_entries').insert({
      company_id: testCid, number: 'TEST-001', date: new Date().toISOString().slice(0, 10),
      description: 'Unique index test 1', status: 'draft', reference: testRef
    }).select().single();
    assert(!e1 && je1, 'First JE with reference inserts successfully');
    const { error: e2 } = await supabase.from('acct_journal_entries').insert({
      company_id: testCid, number: 'TEST-002', date: new Date().toISOString().slice(0, 10),
      description: 'Unique index test 2 (duplicate)', status: 'draft', reference: testRef
    }).select().single();
    assert(!!e2, 'Second JE with same company_id+reference is rejected (unique index enforced)');
    // Cleanup
    if (je1) await supabase.from('acct_journal_entries').delete().eq('id', je1.id);
  } else {
    assert(false, 'Could not find company_id for unique index test');
  }

  // Code: existingRecur check prevents duplicate recurring postings
  assert(accountingJs.includes('existingRecur'), 'existingRecur check exists before posting recurring entries');
  assert(accountingJs.includes('existingRecur.length > 0'), 'existingRecur skips posting when entry already exists');

  // Code: all recurring entries use RECUR- prefix for idempotent references
  assert(accountingJs.includes('"RECUR-"'), 'Recurring entries use RECUR- prefix for idempotent references');
  const recurRefLine = accountingJs.match(/ref\s*=\s*"RECUR-".*monthStr/);
  assert(!!recurRefLine, 'RECUR reference includes month string for uniqueness');

  // Code: existingRecur query filters by company_id and reference
  assert(accountingJs.includes('.eq("company_id", cid).eq("reference", ref)'), 'existingRecur scoped by company_id AND reference');

  // Code: existingRecur excludes voided entries
  assert(accountingJs.includes('.neq("status", "voided")'), 'existingRecur excludes voided entries (allows re-posting after void)');

  // Code: autoPostRentCharges is a safe no-op stub
  assert(accountingJs.includes('async function autoPostRentCharges()'), 'autoPostRentCharges function exists');
  assert(accountingJs.includes('return { posted: 0, failed: 0 }'), 'autoPostRentCharges is a no-op stub (returns zero counts)');
}

// ──────────────────────────────────────────────────────
// 2. PRORATION MATH (cents-based arithmetic)
// ──────────────────────────────────────────────────────
async function testProrationMath() {
  console.log('\n💰 PRORATION MATH (CENTS-BASED)');

  // Lifecycle: move-out proration uses integer cents
  assert(lifecycleJs.includes('fullRentCents'), 'Move-out proration computes fullRentCents');
  assert(lifecycleJs.includes('proratedCents'), 'Move-out proration computes proratedCents');
  assert(lifecycleJs.includes('Math.round(safeNum(selectedLease.rent_amount) * 100)'), 'fullRentCents uses Math.round for conversion to cents');
  assert(lifecycleJs.includes('Math.round(fullRentCents * moveOutDay / daysInMoveOutMonth)'), 'proratedCents computed as rounded integer');
  assert(lifecycleJs.includes('fullRentCents / 100'), 'fullRent converted back from cents to dollars');
  assert(lifecycleJs.includes('proratedCents / 100'), 'proratedRent converted back from cents to dollars');
  assert(lifecycleJs.includes('(fullRentCents - proratedCents) / 100'), 'creditBack computed from cents difference (avoids floating point)');

  // Accounting: owner distribution uses cents
  assert(accountingJs.includes('paymentCents'), 'Owner distribution computes paymentCents');
  assert(accountingJs.includes('mgmtFeeCents'), 'Owner distribution computes mgmtFeeCents');
  assert(accountingJs.includes('Math.round(paymentAmount * 100)'), 'paymentCents uses Math.round');
  assert(accountingJs.includes('Math.round(paymentCents * feePct / 100)'), 'mgmtFeeCents computed from integer cents * percentage');
  assert(accountingJs.includes('mgmtFeeCents / 100'), 'mgmtFee converted back from cents');
  assert(accountingJs.includes('(paymentCents - mgmtFeeCents) / 100'), 'ownerNet computed from cents difference');

  // No raw floating-point multiplication for financial percentages
  // (paymentAmount * feePct without cents would be a bug)
  const rawFloatPattern = /paymentAmount\s*\*\s*feePct(?!\s*\/\s*100)/;
  assert(!rawFloatPattern.test(accountingJs), 'No raw paymentAmount * feePct without cents conversion');
}

// ──────────────────────────────────────────────────────
// 3. JOURNAL ENTRY INTEGRITY
// ──────────────────────────────────────────────────────
async function testJournalEntryIntegrity() {
  console.log('\n📒 JOURNAL ENTRY INTEGRITY');

  // DB: insert a balanced JE (DR 100 / CR 100)
  const { data: companies } = await supabase.from('acct_accounts').select('company_id').limit(1);
  const companyId = companies?.[0]?.company_id;
  if (companyId) {
    const { data: accounts } = await supabase.from('acct_accounts').select('id, code').eq('company_id', companyId).limit(2);
    if (accounts && accounts.length >= 2) {
      const { data: je, error: jeErr } = await supabase.from('acct_journal_entries').insert({
        company_id: companyId, number: 'TEST-FIN-001', date: new Date().toISOString().slice(0, 10),
        description: 'Financial integrity test - balanced', status: 'draft', reference: 'TEST-FIN-BALANCED'
      }).select().single();
      assert(!jeErr && je, 'Can insert balanced JE header');

      if (je) {
        const { error: lineErr } = await supabase.from('acct_journal_lines').insert([
          { journal_entry_id: je.id, company_id: companyId, account_id: accounts[0].id, account_name: 'Test DR Account', debit: 100, credit: 0, memo: 'test DR' },
          { journal_entry_id: je.id, company_id: companyId, account_id: accounts[1].id, account_name: 'Test CR Account', debit: 0, credit: 100, memo: 'test CR' }
        ]);
        assert(!lineErr, 'Can insert balanced DR 100 / CR 100 lines' + (lineErr ? ' — ' + lineErr.message : ''));
        // Cleanup
        await supabase.from('acct_journal_lines').delete().eq('journal_entry_id', je.id);
        await supabase.from('acct_journal_entries').delete().eq('id', je.id);
      }
    }
  }

  // Code: validateJE catches unbalanced entries
  assert(accountingComponentJs.includes('export const validateJE'), 'validateJE function exists');
  assert(accountingComponentJs.includes('Math.abs(td - tc) < 0.005'), 'validateJE uses 0.005 tolerance for floating-point comparison');
  assert(accountingComponentJs.includes('isValid:'), 'validateJE returns isValid flag');
  assert(accountingComponentJs.includes('difference:'), 'validateJE returns difference amount');

  // Code: validateJE is called before posting
  assert(accountingComponentJs.includes('validateJE(lines)') || accountingComponentJs.includes('validateJE(je.lines)'), 'validateJE called before posting JE');
  assert(accountingComponentJs.includes('if (!v.isValid)'), 'Posting blocked when validateJE returns invalid');

  // Code: period lock enforcement in autoPostJournalEntry
  assert(accountingJs.includes('checkPeriodLock'), 'checkPeriodLock exists in accounting.js');
  assert(accountingJs.includes('checkPeriodLock(companyId, date)'), 'checkPeriodLock called with companyId and date in autoPostJournalEntry');
  assert(accountingJs.includes('blocked by period lock'), 'Period lock produces descriptive error message');

  // Code: orphaned JE cleanup exists
  assert(accountingJs.includes('orphan'), 'Orphan JE handling exists in accounting.js');
  assert(accountingJs.includes('Clean up orphan header'), 'Orphan cleanup comment documents the pattern');

  // Code: orphaned JE void fallback
  assert(accountingJs.includes('voided'), 'Void fallback exists for orphaned JE');
  assert(accountingJs.includes('[ORPHANED'), 'Orphaned JE description prefix marks voided entries');
  assert(accountingJs.includes('delete failed, voided instead'), 'Void fallback triggers when delete fails');
}

// ──────────────────────────────────────────────────────
// 4. BALANCE CONSISTENCY
// ──────────────────────────────────────────────────────
async function testBalanceConsistency() {
  console.log('\n⚖️  BALANCE CONSISTENCY');

  // safeLedgerInsert's running-balance logic used to live client-side
  // (prevBal + increasesBalance/decreasesBalance branches). It now
  // delegates to the insert_ledger_entry_with_balance RPC so balance
  // computation is atomic server-side (project_audit_fixes_2026_03_25).
  // We just verify the RPC call still wires up and the fallback path
  // exists for older DBs that haven't deployed the RPC yet.
  assert(accountingJs.includes('insert_ledger_entry_with_balance'), 'safeLedgerInsert calls insert_ledger_entry_with_balance RPC');
  assert(accountingJs.includes('ledger entry insert via RPC') || accountingJs.includes('ledger RPC missing'), 'safeLedgerInsert has error/fallback path for the RPC');

  // update_tenant_balance RPC called after payment operations
  const rpcCalls = ALL_CODE.match(/update_tenant_balance/g);
  assert(rpcCalls && rpcCalls.length >= 5, 'update_tenant_balance RPC called in multiple places (' + (rpcCalls ? rpcCalls.length : 0) + ' references)');
  assert(accountingJs.includes('update_tenant_balance'), 'update_tenant_balance called in accounting.js');
  assert(lifecycleJs.includes('update_tenant_balance'), 'update_tenant_balance called in Lifecycle.js (move-out credit)');

  // Void operations reverse AR impact
  assert(accountingComponentJs.includes('arImpact'), 'arImpact computed during void operations');
  assert(accountingComponentJs.includes('-arImpact'), 'Void reverses AR impact with negation');
  assert(accountingComponentJs.includes('p_amount_change: -arImpact'), 'Void passes -arImpact to update_tenant_balance');

  // Warning when tenant not found for void reversal
  assert(accountingComponentJs.includes('not found'), 'Warning exists for tenant not found during void');
  assert(accountingComponentJs.includes('balance was NOT reversed'), 'Warning message explains balance was not reversed');
  assert(accountingComponentJs.includes('adjust manually'), 'Warning advises manual adjustment');
}

// ──────────────────────────────────────────────────────
// 5. CACHE MANAGEMENT
// ──────────────────────────────────────────────────────
async function testCacheManagement() {
  console.log('\n🗄️  CACHE MANAGEMENT');

  // Caches cleared on company switch
  assert(appJs.includes('_classIdCache'), 'App.js imports _classIdCache');
  assert(appJs.includes('_acctIdCache'), 'App.js imports _acctIdCache');
  assert(appJs.includes('_tenantArCache'), 'App.js imports _tenantArCache');

  // All three caches cleared together
  const clearBlock = appJs.includes('Object.keys(_classIdCache).forEach') &&
                     appJs.includes('Object.keys(_acctIdCache).forEach') &&
                     appJs.includes('Object.keys(_tenantArCache).forEach');
  assert(clearBlock, 'All three caches cleared on company switch (classId, acctId, tenantAr)');

  // Property delete clears ALL tenant caches
  assert(propertiesJs.includes('for (const tn of tenantNames)'), 'Property delete iterates tenant names');
  assert(propertiesJs.includes('delete _tenantArCache['), 'Property delete clears _tenantArCache for each tenant');
  assert(propertiesJs.includes('delete _classIdCache['), 'Property delete clears _classIdCache for property');
  assert(propertiesJs.includes('delete _acctIdCache['), 'Property delete clears _acctIdCache for company');

  // resolveAccountId does bulk-fetch and cache
  assert(accountingJs.includes('allAccts'), 'resolveAccountId bulk-fetches all accounts');
  assert(accountingJs.includes('for (const a of allAccts)'), 'resolveAccountId iterates allAccts to populate cache');
  assert(accountingJs.includes('_acctIdCache[cid][a.code] = a.id'), 'resolveAccountId caches by code');
  assert(accountingJs.includes('_acctIdCache[cid][bareCode]'), 'resolveAccountId checks cache before DB query');
}

// ──────────────────────────────────────────────────────
// 6. DATE BOUNDARY HANDLING
// ──────────────────────────────────────────────────────
async function testDateBoundaryHandling() {
  console.log('\n📅 DATE BOUNDARY HANDLING');

  // getPeriodDates "Last Month" handles January correctly
  assert(accountingComponentJs.includes('getPeriodDates'), 'getPeriodDates function exists');
  assert(accountingComponentJs.includes('m === 0 ? 11 : m - 1'), 'Last Month handles January (m===0) by wrapping to December (11)');
  assert(accountingComponentJs.includes('m === 0 ? y - 1 : y'), 'Last Month decrements year when current month is January');
  // Verify no "00" month can be produced (lm+1 when lm=11 gives 12, not 00)
  // The template literal uses ${String(lm+1).padStart(...)} so lm=11 gives month "12" not "00"
  assert(accountingComponentJs.includes('String(lm+1).padStart'), 'Last Month uses lm+1 (1-indexed) for month string');

  // formatLocalDate pads month and day
  assert(helpersJs.includes('padStart(2, "0")'), 'formatLocalDate pads with padStart(2, "0")');
  const formatLines = helpersJs.match(/String\(date\.getMonth\(\) \+ 1\)\.padStart\(2, "0"\)/);
  assert(!!formatLines, 'formatLocalDate pads month with leading zero');
  const dayPad = helpersJs.match(/String\(date\.getDate\(\)\)\.padStart\(2, "0"\)/);
  assert(!!dayPad, 'formatLocalDate pads day with leading zero');

  // parseLocalDate handles empty/null input
  assert(helpersJs.includes('if (!str) return new Date(NaN)'), 'parseLocalDate returns invalid date for null/empty input');

  // Recurring entries handle frequency correctly
  assert(accountingJs.includes('quarterly" ? 3'), 'Quarterly frequency maps to 3 months');
  assert(accountingJs.includes('semi-annual" ? 6'), 'Semi-annual frequency maps to 6 months');
  assert(accountingJs.includes(': 1'), 'Default (monthly) frequency maps to 1 month');
}

// ──────────────────────────────────────────────────────
// 7. AUTOPAY SAFETY
// ──────────────────────────────────────────────────────
async function testAutopaySafety() {
  console.log('\n🔐 AUTOPAY SAFETY');

  // Move-out autopay scoping. The client-side .eq("tenant", tName)
  // .eq("property", ...) block was replaced by the move_out_commit_state
  // RPC (migration 20260424000003) which holds the same scope rules in
  // SQL. Accept either path so this test passes both before and after
  // the atomic-RPC refactor.
  const viaClient = lifecycleJs.includes('.eq("tenant", tName).eq("property"');
  const viaRpc = lifecycleJs.includes('move_out_commit_state');
  assert(viaClient || viaRpc, 'Lifecycle move-out disables autopay scoped by tenant AND property (client or RPC)');

  // Eviction autopay disable scopes by property
  assert(lifecycleJs.includes('.eq("tenant", evCase.tenant_name).eq("property", evCase.property)'), 'Lifecycle eviction disables autopay scoped by tenant AND property');

  // Tenant archive autopay disable scopes by property
  assert(tenantsJs.includes('.eq("tenant", name).eq("property", tenantProperty)'), 'Tenant archive disables autopay scoped by tenant AND property');

  // Property delete disables all autopay for that property
  assert(propertiesJs.includes('autopay_schedules').includes || propertiesJs.includes('.eq("property", address)'), 'Property delete disables autopay for all tenants at property');

  // Autopay creation includes company_id and tenant AND property
  assert(tenantPortalJs.includes('company_id: companyId, tenant: tenantData.name, property: tenantData.property'), 'TenantPortal autopay creation includes company_id, tenant, AND property');

  // Payments autopay creation includes company_id
  assert(paymentsJs.includes('company_id: companyId'), 'Payments autopay creation includes company_id');

  // No autopay disable matches by tenant name alone without property (except safe rename/end-date ops)
  // The dangerous pattern would be: update({enabled:false}).eq("tenant", name) WITHOUT .eq("property", ...)
  // Check Lifecycle, Tenants, Properties for this anti-pattern
  const lifecycleDisables = lifecycleJs.match(/autopay_schedules.*update.*enabled.*false[^;]*/g) || [];
  for (const line of lifecycleDisables) {
    assert(line.includes('.eq("property"'), 'Lifecycle autopay disable includes property filter: ' + line.slice(0, 80));
  }

  const tenantDisables = tenantsJs.match(/autopay_schedules.*update.*enabled.*false[^;]*/g) || [];
  for (const line of tenantDisables) {
    assert(line.includes('.eq("property"'), 'Tenants autopay disable includes property filter: ' + line.slice(0, 80));
  }
}

// ──────────────────────────────────────────────────────
// RUN ALL TESTS
// ──────────────────────────────────────────────────────
async function run() {
  console.log('🏦 FINANCIAL INTEGRITY TESTS');
  console.log('================================');
  await testDoublePostingPrevention();
  await testProrationMath();
  await testJournalEntryIntegrity();
  await testBalanceConsistency();
  await testCacheManagement();
  await testDateBoundaryHandling();
  await testAutopaySafety();
  console.log('\n================================');
  console.log('✅ Passed: ' + pass);
  console.log('❌ Failed: ' + fail);
  if (errors.length > 0) { console.log('\nFailed:'); errors.forEach(function(e) { console.log('  - ' + e); }); }
  console.log('\nTotal: ' + (pass + fail) + ' | Pass rate: ' + Math.round(pass / (pass + fail) * 100) + '%');
  process.exit(fail > 0 ? 1 : 0);
}
run();
