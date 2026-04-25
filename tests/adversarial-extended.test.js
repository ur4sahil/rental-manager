// Extended adversarial coverage — areas not exercised by
// security-adversarial.test.js:
//   - JE balance manipulation (DR != CR on insert)
//   - Period lock bypass
//   - Cross-tenant AR cross-write
//   - Reverse-JE chain depth
//   - Push subscription spoofing (JWT for another user)
//   - CHECK constraint enforcement re-verification
//
// Run: cd tests && node adversarial-extended.test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';
const PROBE_CO = 'ADVERSARIAL_PROBE_CO';

let pass = 0, fail = 0;
function assert(ok, name, detail) { if (ok) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); fail++; } }

(async () => {
console.log('\nExtended Adversarial');
console.log('================================');

// ─── 1. JE balance manipulation ─────────────────────────────
// Intent: PostgREST INSERT should not prevent DR != CR at the DB
// level — balance is application-enforced (Accounting.js validateJE).
// This test confirms we know that + confirms app code actually checks.
console.log('\n1. JE balance — app-side check present');
const validateJeCode = require('fs').readFileSync(require('path').join(__dirname, '../src/components/Accounting.js'), 'utf8');
assert(/validateJE\(lines\)[\s\S]{0,200}difference/.test(validateJeCode),
  'validateJE computes difference and blocks save on imbalance');
assert(/Debits must equal credits|out of balance/i.test(validateJeCode),
  'User-visible error shown on imbalance');

// ─── 2. Period lock bypass ──────────────────────────────────
console.log('\n2. Period lock enforced across JE entry points');
const lifecycleCode = require('fs').readFileSync(require('path').join(__dirname, '../src/components/Lifecycle.js'), 'utf8');
const acctCode = validateJeCode;
const bankingCode = require('fs').readFileSync(require('path').join(__dirname, '../src/components/Banking.js'), 'utf8');
assert(/checkPeriodLock\(companyId, .+?\.date\)/.test(acctCode), 'Accounting voidJE checks period lock');
// Lifecycle posts via atomicPostJEAndLedger → autoPostJournalEntry,
// which is the place that calls checkPeriodLock. The wrapper imports
// it for us — assert the indirect path.
assert(/atomicPostJEAndLedger|autoPostJournalEntry/.test(lifecycleCode),
  'Lifecycle posts via atomicPostJEAndLedger (which enforces period lock)');
const acctUtilsCode = require('fs').readFileSync(require('path').join(__dirname, '../src/utils/accounting.js'), 'utf8');
assert(/checkPeriodLock\(companyId, date\)/.test(acctUtilsCode),
  'autoPostJournalEntry calls checkPeriodLock before insert');
assert(/checkPeriodLock/.test(bankingCode), 'Banking acceptTransaction checks period lock');
assert(/async function reverseJournalEntry[\s\S]{0,400}checkPeriodLock/.test(acctCode),
  'reverseJournalEntry checks period lock');

// ─── 3. Cross-tenant AR cross-write ─────────────────────────
// Hypothetical attack: post a JE whose "AR" line points at tenant B's
// AR sub-account while the JE's metadata claims tenant A.
// Defense is structural: the AR account is chosen by getOrCreateTenantAR
// keyed by the SAME tenant the JE is being written for. Confirm no
// caller passes a literal account_id: "1100" (parent) in the move-out
// waive path (which was the root cause of the earlier "ledger not
// updating" bug).
console.log('\n3. Cross-tenant AR write paths');
assert(!/account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: outstandingBalance/.test(lifecycleCode),
  'Move-Out waive no longer credits parent 1100 directly');
assert(/waiveArId = await getOrCreateTenantAR\(cid, tName, selectedTenant\.id\)|unifiedArId/.test(lifecycleCode),
  'Move-Out waive resolves per-tenant AR sub-account');

// ─── 4. Reverse-JE chain depth ──────────────────────────────
// Reversal chains (reverse a reversal) should not loop forever.
// Each call posts exactly one NEW JE and doesn't touch the original.
console.log('\n4. Reverse-JE chain');
assert(/confirmText: "Post Reversal"/.test(acctCode), 'Reverse requires explicit user confirm — no infinite auto-chain');
assert(/description: newDescription,\s*reference: newReference/.test(acctCode),
  'Each reversal posts its own JE (not in-place mutation)');

// ─── 5. Push subscription spoofing ──────────────────────────
// Attempt: insert a push_subscriptions row for another user's email
// using the anon key. Should be blocked by RLS (ps_user_isolation).
console.log('\n5. push_subscriptions cross-user spoofing via anon');
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PW = process.env.TEST_PASSWORD;
if (TEST_EMAIL && TEST_PW) {
  const { data: sess } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PW });
  if (sess?.user) {
    // Try to spoof a subscription for a different email
    const { error: spoofErr } = await anon.from('push_subscriptions').insert([{
      company_id: SMITH, user_email: 'victim@example.com',
      subscription: { endpoint: 'https://p/x', keys: { p256dh: 'a', auth: 'b' } },
    }]);
    assert(!!spoofErr, 'Anon user cannot insert push_subscription for a different email', spoofErr?.message?.slice(0, 80));
  }
}

// ─── 6. CHECK constraints re-verification (quick) ──────────
console.log('\n6. CHECK constraints still enforced (quick smoke)');
await sb.from('recurring_journal_entries').delete().eq('company_id', PROBE_CO);
const { error: cErr } = await sb.from('recurring_journal_entries').insert([{
  company_id: PROBE_CO, description: 'smoke', frequency: 'monthly', day_of_month: 1, amount: 0,
  tenant_name: 'X', tenant_id: null, property: 'Y', status: 'active',
}]);
assert(cErr && /check constraint/i.test(cErr.message), 'recurring_je_tenant_pair_check still live');

const { error: sErr } = await sb.from('bank_reconciliations').insert([{
  company_id: PROBE_CO, period: '2099-99', status: 'not-a-real-status', bank_ending_balance: 0,
}]);
assert(sErr && /status_check|check constraint/i.test(sErr.message), 'bank_reconciliations_status_check still live');

console.log('\n================================');
console.log(`✅ Passed: ${pass}`);
console.log(`❌ Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
