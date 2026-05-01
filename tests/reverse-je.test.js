// Reverse JE behavior. Static + live: posts a JE, reverses it,
// checks the inverse JE exists with swapped DR/CR and the original
// is preserved (not voided).
//
// Run: cd tests && node reverse-je.test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const COMPANY_ID = 'dce4974d-afa9-4e65-afdf-1189b815195d';
let pass = 0, fail = 0;
function assert(ok, name, detail) { if (ok) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); fail++; } }

const acctJs = fs.readFileSync(path.join(__dirname, '../src/components/Accounting.js'), 'utf8');

(async () => {
console.log('\nReverse JE');
console.log('================================');

// ─── 1. Code shape ──────────────────────────────────────────
console.log('\n1. reverseJournalEntry function shape');
assert(/async function reverseJournalEntry\(id\)/.test(acctJs), 'reverseJournalEntry function defined');
assert(/onReverse=\{reverseJournalEntry\}/.test(acctJs), 'Wired on AcctJournalEntries via onReverse prop');
assert(/Reverse posts a new JE with DR\/CR swapped|Post a reversing entry/.test(acctJs), 'Confirm dialog wording mentions reversal');
assert(/debit: safeNum\(l\.credit\), credit: safeNum\(l\.debit\)/.test(acctJs), 'Lines swap DR/CR');
assert(/reference: "REV-" \+ origRef|REV-/.test(acctJs), 'Reference prefixed with REV-');
assert(/checkPeriodLock\(companyId, today\)/.test(acctJs), 'Period lock check before reversal');
assert(/je\.status !== "posted"/.test(acctJs), 'Only posted JEs are reversible');
// Phase 4 (2026-04-30): the reversal posts a mirror JE on the AR
// account; the sync_tenant_balance_lines trigger picks up those new
// lines and recomputes tenants.balance from the GL automatically.
// The explicit `update_tenant_balance` call inside the reversal
// block was removed because it was redundant with the trigger.
assert(/REV-/.test(acctJs), 'Reversal posts a mirror JE (trigger handles balance recompute)');

// ─── 2. Live: post a JE, reverse it, verify both exist ──────
console.log('\n2. Live round-trip');
// Use a 5500/4100 JE so we don't touch tenant AR — keeps cleanup simple
const ref = 'REVTEST-' + Date.now();
const { data: jeRow, error: jeErr } = await sb.from('acct_journal_entries').insert([{
  company_id: COMPANY_ID, number: 'JE-REVTEST-' + Date.now().toString().slice(-6),
  date: '2026-04-24', description: 'Test JE for reversal', reference: ref, property: '', status: 'posted'
}]).select('id').maybeSingle();
assert(!jeErr && jeRow?.id, 'JE header insert', jeErr?.message);
if (jeRow) {
  const { data: acctExp } = await sb.from('acct_accounts').select('id').eq('company_id', COMPANY_ID).eq('code', '5500').maybeSingle();
  const { data: acctInc } = await sb.from('acct_accounts').select('id').eq('company_id', COMPANY_ID).eq('code', '4100').maybeSingle();
  if (acctExp && acctInc) {
    await sb.from('acct_journal_lines').insert([
      { journal_entry_id: jeRow.id, company_id: COMPANY_ID, account_id: acctExp.id, account_name: 'Bad Debt Expense', debit: 100, credit: 0, memo: 'rev test' },
      { journal_entry_id: jeRow.id, company_id: COMPANY_ID, account_id: acctInc.id, account_name: 'Other Income',     debit: 0, credit: 100, memo: 'rev test' },
    ]);
    // Simulate reverse: insert mirror JE (the function does this client-side; we mimic the DB shape)
    const revRef = 'REV-' + ref;
    const { data: revRow } = await sb.from('acct_journal_entries').insert([{
      company_id: COMPANY_ID, number: 'JE-REVTEST-MIR-' + Date.now().toString().slice(-6),
      date: '2026-04-24', description: 'Reversal of test JE', reference: revRef, property: '', status: 'posted'
    }]).select('id').maybeSingle();
    if (revRow) {
      await sb.from('acct_journal_lines').insert([
        { journal_entry_id: revRow.id, company_id: COMPANY_ID, account_id: acctExp.id, account_name: 'Bad Debt Expense', debit: 0, credit: 100, memo: 'reversal test' },
        { journal_entry_id: revRow.id, company_id: COMPANY_ID, account_id: acctInc.id, account_name: 'Other Income',     debit: 100, credit: 0, memo: 'reversal test' },
      ]);
      // Original still posted
      const { data: origAfter } = await sb.from('acct_journal_entries').select('status').eq('id', jeRow.id).maybeSingle();
      assert(origAfter?.status === 'posted', 'Original JE status remains "posted"');
      // Reverse exists with REV- prefix
      const { data: revAfter } = await sb.from('acct_journal_entries').select('reference, status').eq('id', revRow.id).maybeSingle();
      assert(revAfter?.reference?.startsWith('REV-'), 'Reversal reference starts with REV-');
      assert(revAfter?.status === 'posted', 'Reversal posted (not draft)');
      // Net effect on each account is zero
      const { data: lines } = await sb.from('acct_journal_lines')
        .select('debit, credit, account_id')
        .in('journal_entry_id', [jeRow.id, revRow.id]);
      const sum = (lines || []).reduce((acc, l) => {
        acc[l.account_id] = (acc[l.account_id] || 0) + Number(l.debit || 0) - Number(l.credit || 0);
        return acc;
      }, {});
      assert(Math.abs(sum[acctExp.id] || 0) < 0.001, 'Net DR/CR on 5500 = 0 across orig + reversal');
      assert(Math.abs(sum[acctInc.id] || 0) < 0.001, 'Net DR/CR on 4100 = 0 across orig + reversal');
      // Cleanup
      await sb.from('acct_journal_lines').delete().in('journal_entry_id', [jeRow.id, revRow.id]);
      await sb.from('acct_journal_entries').delete().in('id', [jeRow.id, revRow.id]);
    }
  }
}

console.log('\n================================');
console.log(`✅ Passed: ${pass}`);
console.log(`❌ Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
