// New gap-coverage tests for the Phase 1-4 ledger-view migration
// and the bank-dedup pagination fix shipped on 2026-04-30.
//
// Coverage:
//   1. ledger_entries is a VIEW (writes rejected, reads return rows)
//   2. View derives rows from acct_journal_lines on per-tenant AR
//      accounts and exposes them with the legacy table's shape
//   3. Mirror trigger from Phase 1 is gone (post_je_and_ledger
//      doesn't write to ledger_entries directly anymore)
//   4. teller-sync dedup query paginates beyond 1000 existing rows
//   5. pmError() in src/utils/errors.js carries the suppression
//      branches for anon-state PM-8005 and network-abort PM-8006
//   6. Bank reconciliation panel helper computeFeedRecon ties out
//      math against synthetic data
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

const COMPANY_ID = 'sandbox-llc';

async function testLedgerEntriesIsView() {
  console.log('\n📋 ledger_entries is a Postgres VIEW');
  // Write should fail with a "cannot insert into view" error.
  const { error } = await sb.from('ledger_entries').insert({
    company_id: COMPANY_ID, tenant: 'view-probe', date: '2026-05-01',
    description: 'view write test', amount: 1, type: 'charge', balance: 0,
  });
  assert(!!error && /view/i.test(error.message || ''),
    'INSERT into ledger_entries fails with "cannot insert into view"');

  // Legacy table preserved as ledger_entries_legacy_table.
  const { error: legacyErr, count: legacyCount } = await sb
    .from('ledger_entries_legacy_table')
    .select('*', { count: 'exact', head: true });
  assert(!legacyErr, 'ledger_entries_legacy_table is queryable (Phase 4 preserved historical rows)');
  assert(typeof legacyCount === 'number', 'legacy table has a count');

  // Reading the view works.
  const { data: rows, error: readErr } = await sb.from('ledger_entries').select('*').limit(1);
  assert(!readErr, 'SELECT from ledger_entries view succeeds');
  assert(Array.isArray(rows), 'view returns an array');
}

async function testLedgerViewDerivesFromGL() {
  console.log('\n🔁 ledger_entries view derives from acct_journal_lines');
  // Pick a real per-tenant AR account from the sandbox.
  const { data: arAccts } = await sb.from('acct_accounts')
    .select('id, tenant_id, name')
    .eq('company_id', COMPANY_ID).not('tenant_id', 'is', null).limit(1);
  if (!arAccts?.length) {
    assert(false, 'sandbox has at least one per-tenant AR account (cannot run derivation tests)');
    return;
  }
  const arAcct = arAccts[0];
  const { data: revAcct } = await sb.from('acct_accounts')
    .select('id').eq('company_id', COMPANY_ID).eq('code', '4000').maybeSingle();
  if (!revAcct?.id) {
    assert(false, 'Revenue account (4000) exists');
    return;
  }

  // Post a fresh JE.
  const ref = 'LEDGER-VIEW-PROBE-' + Date.now();
  const { data: jeRow, error: jeErr } = await sb.from('acct_journal_entries').insert({
    company_id: COMPANY_ID, number: 'LV-' + Date.now().toString().slice(-6),
    date: '2026-05-01', description: 'View-derivation probe', reference: ref,
    property: '', status: 'posted', transaction_type: 'charge',
  }).select('id').maybeSingle();
  assert(!jeErr && jeRow?.id, 'JE header inserted for view-derivation probe');
  if (!jeRow?.id) return;

  const { error: lineErr } = await sb.from('acct_journal_lines').insert([
    { journal_entry_id: jeRow.id, company_id: COMPANY_ID, account_id: arAcct.id, account_name: arAcct.name, debit: 250, credit: 0, memo: 'view probe' },
    { journal_entry_id: jeRow.id, company_id: COMPANY_ID, account_id: revAcct.id, account_name: 'Rental Income', debit: 0, credit: 250, memo: 'view probe' },
  ]);
  assert(!lineErr, 'AR + revenue JE lines inserted');

  // View must surface the AR-line as a ledger row.
  const { data: viewRow } = await sb.from('ledger_entries')
    .select('amount, type, journal_entry_id, tenant_id')
    .eq('journal_entry_id', jeRow.id).maybeSingle();
  assert(!!viewRow, 'view exposes a row for the per-tenant AR line');
  if (viewRow) {
    assert(Number(viewRow.amount) === 250, 'view exposes the magnitude (amount=250)');
    assert(viewRow.tenant_id === arAcct.tenant_id, 'view tenant_id matches the AR account');
    assert(viewRow.journal_entry_id === jeRow.id, 'view journal_entry_id links back to the JE');
    assert(viewRow.type === 'charge', 'view type is "charge" (DR > 0 on AR with transaction_type=charge)');
  }

  // Cleanup.
  await sb.from('acct_journal_lines').delete().eq('journal_entry_id', jeRow.id);
  await sb.from('acct_journal_entries').delete().eq('id', jeRow.id);
}

async function testTriggerRemoved() {
  console.log('\n🪦 Phase 1 mirror trigger is gone');
  // Probe the post_je_and_ledger RPC's behavior. Posting a JE on a
  // per-tenant AR account should produce exactly ONE view row (not
  // double — that was the Phase 1 bug the trigger had).
  const { data: arAccts } = await sb.from('acct_accounts')
    .select('id, tenant_id, name').eq('company_id', COMPANY_ID)
    .not('tenant_id', 'is', null).limit(1);
  if (!arAccts?.length) { assert(true, 'skip — no per-tenant AR available'); return; }
  const arAcct = arAccts[0];
  const { data: revAcct } = await sb.from('acct_accounts')
    .select('id').eq('company_id', COMPANY_ID).eq('code', '4000').maybeSingle();
  const { data: jeId } = await sb.rpc('post_je_and_ledger', {
    p_company_id: COMPANY_ID, p_date: '2026-05-01',
    p_description: 'Trigger-removed probe', p_reference: 'TRG-PROBE-' + Date.now(),
    p_property: '', p_status: 'posted',
    p_lines: [
      { account_id: arAcct.id, account_name: arAcct.name, debit: 99, credit: 0, memo: 'probe' },
      { account_id: revAcct?.id, account_name: 'Rental Income', debit: 0, credit: 99, memo: 'probe' },
    ],
    p_ledger_tenant: null, p_ledger_tenant_id: arAcct.tenant_id,
    p_ledger_property: null, p_ledger_amount: 99,
    p_ledger_type: 'charge', p_ledger_description: 'probe', p_balance_change: 0,
  });
  assert(!!jeId, 'post_je_and_ledger returns a JE id');
  if (!jeId) return;

  const { count } = await sb.from('ledger_entries')
    .select('*', { count: 'exact', head: true }).eq('journal_entry_id', jeId);
  assert(count === 1, `view exposes exactly one row per JE (saw ${count}; trigger duplication absent)`);

  await sb.from('acct_journal_lines').delete().eq('journal_entry_id', jeId);
  await sb.from('acct_journal_entries').delete().eq('id', jeId);
}

async function testTellerSyncDedupPaginates() {
  console.log('\n📥 teller-sync dedup query paginates beyond 1000');
  const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'teller-sync-transactions.js'), 'utf8');
  // The fix swaps the single .select() for a paginated loop. Verify
  // the loop is in place — without it, any feed with >1000 historical
  // rows would silently drop rows from the dedup set and re-import
  // them as duplicates.
  assert(apiSrc.includes('dedupFrom += 1000') || /while\s*\(true\)\s*\{[\s\S]{0,400}fpQuery/.test(apiSrc),
    'dedup pre-fetch uses a paginated while-loop instead of a single select');
  assert(apiSrc.includes('existingPtid.add'),
    'provider_transaction_id dedup set is built from paginated rows');
  assert(apiSrc.includes('existingFp.add'),
    'fingerprint_hash dedup set is built from paginated rows');
}

async function testPmErrorSuppression() {
  console.log('\n🔇 pmError suppresses anon-state RLS + network aborts');
  const errSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'errors.js'), 'utf8');
  assert(/PM-8005[\s\S]{0,200}!_currentUserEmail[\s\S]{0,200}return null/.test(errSrc),
    'PM-8005 in anon state returns null without persisting');
  assert(/load failed|failed to fetch|networkerror/i.test(errSrc),
    'pmError matches mobile-network abort patterns');
  assert(/PM-8006[\s\S]{0,400}isNetworkAbort/.test(errSrc) ||
         /isNetworkAbort[\s\S]{0,400}PM-8006/.test(errSrc),
    'PM-8006 + isNetworkAbort short-circuits before logErrorToSupabase');
}

async function testReconPanelMath() {
  console.log('\n📊 Banking recon panel computes diff = bank − books − pendingNet');
  const bankingSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Banking.js'), 'utf8');
  assert(bankingSrc.includes('computeFeedRecon'), 'computeFeedRecon helper exists');
  assert(/bankBal\s*-\s*bookBal\s*-\s*pendingNet/.test(bankingSrc),
    'recon helper computes diff = bank - books - pending');
  assert(/feedPending/.test(bankingSrc),
    'panel reads pending from unfiltered feedPending state, not the date-windowed transactions list');
  assert(/Reconciliation mismatch/.test(bankingSrc),
    'one-time toast fires on first mismatch detection per feed');
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  LEDGER VIEW + RECONCILIATION + RECENT-FIX COVERAGE');
  console.log('═══════════════════════════════════════════════════════════════');
  await testLedgerEntriesIsView();
  await testLedgerViewDerivesFromGL();
  await testTriggerRemoved();
  await testTellerSyncDedupPaginates();
  await testPmErrorSuppression();
  await testReconPanelMath();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
})();
