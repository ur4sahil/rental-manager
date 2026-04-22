// ═══════════════════════════════════════════════════════════════
// OPENING BALANCE — data-layer tests
// ═══════════════════════════════════════════════════════════════
// Covers the postOpeningBalanceJE helper + the idempotency
// guarantee the unique index provides. Runs directly against the
// Supabase Postgres instance in tests/.env.
//
// Run: cd tests && node opening-balance.test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const COMPANY_ID = 'sandbox-llc';

let pass = 0, fail = 0, errors = [];
function assert(ok, name) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name); fail++; errors.push(name); }
}

// Helper: mirror the client-side plug math so the test can verify
// the DR/CR totals land the way the helper intends.
function buildLines(balances) {
  const DR = new Set(['Asset', 'Expense']);
  const lines = [];
  let totalDR = 0, totalCR = 0;
  for (const b of balances) {
    if (Math.abs(b.amount) < 0.005) continue;
    const nativeDR = DR.has(b.type);
    const onDebit = (nativeDR && b.amount >= 0) || (!nativeDR && b.amount < 0);
    const abs = Math.abs(b.amount);
    lines.push({ account_id: b.code, debit: onDebit ? abs : 0, credit: onDebit ? 0 : abs });
    if (onDebit) totalDR += abs; else totalCR += abs;
  }
  return { lines, totalDR, totalCR };
}

async function cleanup() {
  // Remove any prior opening-balance JE so each test starts fresh.
  const { data: prior } = await supabase.from('acct_journal_entries')
    .select('id').eq('company_id', COMPANY_ID)
    .eq('reference', 'OPENING-BALANCE-' + COMPANY_ID);
  for (const je of (prior || [])) {
    await supabase.from('acct_journal_lines').delete().eq('journal_entry_id', je.id);
    await supabase.from('acct_journal_entries').delete().eq('id', je.id);
  }
}

async function ensureAccounts() {
  // Make sure Sandbox has the accounts we're about to post to.
  const required = [
    ['1000', 'Checking Account', 'Asset'],
    ['1100', 'Accounts Receivable', 'Asset'],
    ['2100', 'Security Deposits Held', 'Liability'],
    ['3000', 'Opening Balance Equity', 'Equity'],
    ['3100', "Owner's Equity", 'Equity'],
  ];
  const { data: existing } = await supabase.from('acct_accounts').select('code').eq('company_id', COMPANY_ID);
  const have = new Set((existing || []).map(a => a.code));
  for (const [code, name, type] of required) {
    if (have.has(code)) continue;
    await supabase.from('acct_accounts').insert([{
      company_id: COMPANY_ID, code, name, type, is_active: true,
      old_text_id: COMPANY_ID + '-' + code,
    }]);
  }
}

// ─── 1. Math — DR/CR totals + plug direction ─────────────────────
function testMath() {
  console.log('\n🧮 DR/CR totals + OBE plug');
  // $10k checking (asset +) + $2k AR (asset +) + $3k deposits held
  // (liab +) + $5k owner's equity (equity +).
  // DR = 12k (assets). CR = 8k (liab+equity). Plug = +4k → credit OBE.
  const { totalDR, totalCR } = buildLines([
    { code: '1000', name: 'Checking', type: 'Asset', amount: 10000 },
    { code: '1100', name: 'AR', type: 'Asset', amount: 2000 },
    { code: '2100', name: 'Deposits', type: 'Liability', amount: 3000 },
    { code: '3100', name: 'Owners Eq', type: 'Equity', amount: 5000 },
  ]);
  assert(Math.abs(totalDR - 12000) < 0.005, 'Debits total $12,000');
  assert(Math.abs(totalCR - 8000) < 0.005, 'Credits total $8,000');
  assert(Math.abs((totalDR - totalCR) - 4000) < 0.005, 'Plug = +$4,000 (credit OBE)');

  // Contra case: accumulated depreciation entered as -8000 on an
  // Asset account should land on the CREDIT side.
  const { lines } = buildLines([
    { code: '1500', name: 'Fixed Asset', type: 'Asset', amount: 50000 },
    { code: '1599', name: 'Accum Depreciation', type: 'Asset', amount: -8000 },
  ]);
  const accDep = lines.find(l => l.account_id === '1599');
  assert(accDep.credit === 8000 && accDep.debit === 0, 'Negative asset → credit side (accumulated depreciation pattern)');
}

// ─── 2. Idempotency via unique reference index ───────────────────
async function testIdempotency() {
  console.log('\n🔒 Idempotency via unique reference');
  await cleanup();
  await ensureAccounts();

  const date = '2024-12-31';
  const ref = 'OPENING-BALANCE-' + COMPANY_ID;
  const ckId = (await supabase.from('acct_accounts').select('id').eq('company_id', COMPANY_ID).eq('code', '1000').maybeSingle()).data?.id;
  const eqId = (await supabase.from('acct_accounts').select('id').eq('company_id', COMPANY_ID).eq('code', '3100').maybeSingle()).data?.id;

  // First post
  const { data: first, error: err1 } = await supabase.from('acct_journal_entries').insert([{
    company_id: COMPANY_ID, number: 'JE-OB-TEST-1', date, reference: ref,
    description: 'Opening balance test', status: 'posted',
  }]).select('id').maybeSingle();
  assert(!err1 && first?.id, 'First opening JE inserts');
  if (first?.id) {
    await supabase.from('acct_journal_lines').insert([
      { journal_entry_id: first.id, company_id: COMPANY_ID, account_id: ckId, debit: 10000, credit: 0 },
      { journal_entry_id: first.id, company_id: COMPANY_ID, account_id: eqId, debit: 0, credit: 10000 },
    ]);
  }

  // Second post with same reference — must be rejected by the unique index
  const { error: err2 } = await supabase.from('acct_journal_entries').insert([{
    company_id: COMPANY_ID, number: 'JE-OB-TEST-2', date, reference: ref,
    description: 'Opening balance retry', status: 'posted',
  }]);
  assert(!!err2, 'Second insert with same reference is rejected');
  assert(/unique|idx_je_company_reference_unique|duplicate|23505/i.test(err2?.message || err2?.code || ''), 'Rejection error is a uniqueness violation');

  // Exactly one opening JE exists
  const { data: allOB } = await supabase.from('acct_journal_entries').select('id').eq('company_id', COMPANY_ID).eq('reference', ref);
  assert(allOB?.length === 1, 'Exactly one opening JE exists for this company');

  await cleanup();
}

// ─── 3. Balanced JE: DR === CR after plug ────────────────────────
async function testBalanced() {
  console.log('\n⚖️ DR/CR balance with OBE plug');
  await cleanup();
  await ensureAccounts();

  // Unbalanced input — only assets, no liab/equity. Plug should
  // cover the full DR total on the credit side.
  const { lines, totalDR, totalCR } = buildLines([
    { code: '1000', name: 'Checking', type: 'Asset', amount: 15000 },
  ]);
  const diff = totalDR - totalCR;
  if (Math.abs(diff) >= 0.005) {
    if (diff > 0) lines.push({ account_id: '3000', debit: 0, credit: diff });
    else lines.push({ account_id: '3000', debit: -diff, credit: 0 });
  }
  const sumDR = lines.reduce((s, l) => s + l.debit, 0);
  const sumCR = lines.reduce((s, l) => s + l.credit, 0);
  assert(Math.abs(sumDR - sumCR) < 0.005, 'JE is balanced after plug added');
  assert(lines.some(l => l.account_id === '3000' && l.credit === 15000), 'OBE plug on credit side equals unbalanced asset total');
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  OPENING BALANCE TESTS');
  console.log('═══════════════════════════════════════════════════════════════');
  testMath();
  await testIdempotency();
  await testBalanced();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('  Failures:'); errors.forEach(e => console.log('    • ' + e)); }
  console.log('═══════════════════════════════════════════════════════════════');
  process.exit(fail > 0 ? 1 : 0);
})();
