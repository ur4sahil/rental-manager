// The server-side accounting aggregates must agree with the in-browser
// computation they replace, to the cent, on real data.
//
// Run: cd tests && node report-parity.test.js
//
// WHY THIS EXISTS
//
// acct_balance_index() and acct_account_ledger() were written to reproduce
// buildBalanceIndex() and getGeneralLedger() from src/utils/acctReports.js.
// "Written to reproduce" is a claim, and a wrong one would not announce
// itself: a P&L or a balance sheet computed from a subtly different filter
// still renders a confident, well-formatted, wrong number.
//
// So this test recomputes the JavaScript semantics INDEPENDENTLY here --
// deliberately transcribed from acctReports.js rather than imported, so a
// change to that file cannot silently redefine what "correct" means -- and
// asserts the SQL matches.
//
// The semantics being pinned, from buildBalanceIndex():
//   * posted entries only
//   * per account_id, summing debit and credit
//   * an optional date filter on the ENTRY's date
// and from getGeneralLedger():
//   * running balance signed by the account's normal balance
//   * debit-normal types: Asset, Cost of Goods Sold, Expense, Other Expense
require("dotenv").config();
require("./sandbox-env"); // must precede any use of process.env.SUPABASE_*
const { createClient } = require("@supabase/supabase-js");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
function assert(ok, name, detail) {
  if (ok) { console.log("  ✅ " + name); pass++; }
  else { console.log("  ❌ " + name + (detail ? " — " + detail : "")); fail++; }
}

// Exactly the rule in acctReports.js. Transcribed, not imported.
const DEBIT_NORMAL = ["Asset", "Cost of Goods Sold", "Expense", "Other Expense"];
const safeNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Money compared at half a cent: the browser sums IEEE doubles and Postgres
// sums numeric, so exact equality is the wrong test -- the question is
// whether they agree as MONEY.
const money = (a, b) => Math.abs(safeNum(a) - safeNum(b)) < 0.005;

// Page through every row; .range() caps at 1000 and a silent truncation
// here would make the two sides "agree" about a ledger neither has read.
// PostgREST caps a result set at 1000 rows -- for RPCs too. A set-returning
// function that is read in one shot therefore TRUNCATES silently, which is
// how this test first caught acct_account_ledger returning 1000 of an
// account's 2903 lines and a closing balance that was simply wrong.
async function allRpc(fn, args) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.rpc(fn, args).range(from, from + 999);
    if (error) throw new Error(`${fn}: ${error.message}`);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

async function all(table, select, apply) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).range(from, from + 999).order("id");
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || !data.length) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

(async () => {
  console.log("\nReport parity — server aggregates vs in-browser computation");
  console.log("================================================================");

  // Pick the company with the most journal lines: the widest surface, and
  // the one whose slowness started this work.
  const { data: entriesAll, error: eErr } = await sb
    .from("acct_journal_entries").select("company_id").limit(20000);
  if (eErr) { console.error("could not read entries:", eErr.message); process.exit(1); }
  const byCo = {};
  for (const e of entriesAll || []) byCo[e.company_id] = (byCo[e.company_id] || 0) + 1;
  const COMPANY = Object.entries(byCo).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!COMPANY) { console.error("no companies with journal entries"); process.exit(1); }
  console.log(`\ncompany under test: ${COMPANY} (${byCo[COMPANY]} entries)`);

  // ─── the browser's view of the ledger ────────────────────────────────
  const entries = await all("acct_journal_entries", "id,date,status,number,company_id",
    q => q.eq("company_id", COMPANY));
  const lines = await all("acct_journal_lines", "id,journal_entry_id,account_id,debit,credit,class_id,company_id",
    q => q.eq("company_id", COMPANY));
  const accounts = await all("acct_accounts", "id,name,code,type,company_id",
    q => q.eq("company_id", COMPANY));
  console.log(`loaded ${entries.length} entries, ${lines.length} lines, ${accounts.length} accounts`);
  assert(lines.length > 0, "there are journal lines to compare");

  const entryById = {};
  for (const e of entries) entryById[e.id] = e;
  const acctById = {};
  for (const a of accounts) acctById[a.id] = a;

  // buildBalanceIndex(), transcribed.
  function clientIndex(filterFn) {
    const idx = {};
    for (const l of lines) {
      const je = entryById[l.journal_entry_id];
      if (!je || je.status !== "posted") continue;
      if (filterFn && !filterFn(je)) continue;
      if (!l.account_id) continue;
      if (!idx[l.account_id]) idx[l.account_id] = { debit: 0, credit: 0 };
      idx[l.account_id].debit += safeNum(l.debit);
      idx[l.account_id].credit += safeNum(l.credit);
    }
    return idx;
  }

  async function serverIndex(start, end) {
    const data = await allRpc("acct_balance_index",
      { p_company_id: COMPANY, p_start: start, p_end: end });
    const idx = {};
    for (const r of data || []) {
      if (!r.account_id) continue;
      if (!idx[r.account_id]) idx[r.account_id] = { debit: 0, credit: 0 };
      idx[r.account_id].debit += safeNum(r.debit);
      idx[r.account_id].credit += safeNum(r.credit);
    }
    return idx;
  }

  function compareIndexes(label, a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let mismatched = 0, worst = null;
    for (const k of keys) {
      const x = a[k] || { debit: 0, credit: 0 };
      const y = b[k] || { debit: 0, credit: 0 };
      if (!money(x.debit, y.debit) || !money(x.credit, y.credit)) {
        mismatched++;
        if (!worst) worst = `${acctById[k]?.code || k} ${acctById[k]?.name || ""}: ` +
          `browser DR ${x.debit}/CR ${x.credit} vs server DR ${y.debit}/CR ${y.credit}`;
      }
    }
    assert(mismatched === 0,
      `${label}: all ${keys.size} accounts agree`,
      mismatched ? `${mismatched} differ, e.g. ${worst}` : "");
  }

  // ─── 1. all time ─────────────────────────────────────────────────────
  console.log("\n1. Balance index, all time");
  compareIndexes("all time", clientIndex(null), await serverIndex(null, null));

  // ─── 2. as-of, the balance sheet / trial balance filter ──────────────
  console.log("\n2. Balance index, as-of a date (balance sheet / trial balance)");
  const dates = entries.map(e => e.date).filter(Boolean).sort();
  const asOf = dates[Math.floor(dates.length / 2)];
  compareIndexes(`as of ${asOf}`, clientIndex(je => je.date <= asOf), await serverIndex(null, asOf));

  // ─── 3. a date RANGE, the P&L filter ─────────────────────────────────
  console.log("\n3. Balance index, date range (P&L)");
  const from = dates[Math.floor(dates.length / 4)];
  const to = dates[Math.floor((dates.length * 3) / 4)];
  compareIndexes(`${from}..${to}`,
    clientIndex(je => je.date >= from && je.date <= to),
    await serverIndex(from, to));

  // ─── 4. an empty range must be empty, not everything ─────────────────
  // The filter being dropped server-side is the failure that would make a
  // one-day P&L silently report the whole year.
  console.log("\n4. Balance index, a range with no entries");
  const emptyIdx = await serverIndex("1900-01-01", "1900-12-31");
  assert(Object.keys(emptyIdx).length === 0,
    "a range containing no entries returns nothing",
    `got ${Object.keys(emptyIdx).length} accounts`);

  // ─── 5. the ledger's running balance ─────────────────────────────────
  console.log("\n5. Account ledger, running balance");
  // An account with a decent number of lines, so the running total is
  // actually exercised rather than trivially correct.
  const linesPerAccount = {};
  for (const l of lines) {
    const je = entryById[l.journal_entry_id];
    if (!je || je.status !== "posted") continue;
    linesPerAccount[l.account_id] = (linesPerAccount[l.account_id] || 0) + 1;
  }
  const busiest = Object.entries(linesPerAccount).sort((a, b) => b[1] - a[1])[0];
  if (!busiest) {
    assert(false, "found an account with posted lines to test");
  } else {
    const [accountId, count] = busiest;
    const acct = acctById[accountId];
    let led = null, lErr = null;
    try { led = await allRpc("acct_account_ledger",
      { p_company_id: COMPANY, p_account_ids: [accountId], p_start: null, p_end: null }); }
    catch (e) { lErr = e; }
    assert(!lErr, "acct_account_ledger returns without error", lErr?.message);

    assert((led || []).length === count,
      `ledger returns every posted line for ${acct?.code || accountId} (${count})`,
      `got ${(led || []).length}`);

    const idx = clientIndex(null)[accountId] || { debit: 0, credit: 0 };
    const ledDr = (led || []).reduce((s, r) => s + safeNum(r.debit), 0);
    const ledCr = (led || []).reduce((s, r) => s + safeNum(r.credit), 0);
    assert(money(ledDr, idx.debit) && money(ledCr, idx.credit),
      "ledger totals equal the balance index for the same account",
      `ledger DR ${ledDr}/CR ${ledCr} vs index DR ${idx.debit}/CR ${idx.credit}`);

    // getGeneralLedger's rule: the closing balance is the signed net.
    const dir = DEBIT_NORMAL.includes(acct?.type) ? "debit" : "credit";
    const expectedClosing = dir === "debit" ? idx.debit - idx.credit : idx.credit - idx.debit;
    const closing = (led || []).length ? safeNum(led[led.length - 1].balance) : 0;
    assert(money(closing, expectedClosing),
      `closing balance matches the ${dir}-normal net for a ${acct?.type}`,
      `got ${closing}, expected ${expectedClosing}`);

    // Every step must equal the previous plus this row's signed movement.
    let running = 0, stepErrors = 0;
    for (const r of led || []) {
      running += dir === "debit"
        ? safeNum(r.debit) - safeNum(r.credit)
        : safeNum(r.credit) - safeNum(r.debit);
      if (!money(running, r.balance)) stepErrors++;
    }
    assert(stepErrors === 0,
      "every row's running balance is the previous plus its own movement",
      `${stepErrors} of ${(led || []).length} rows disagree`);
  }

  // ─── 6. multi-account ledgers restart per account ────────────────────
  // A combined ledger must be a STACK of ledgers. A single running total
  // across accounts adds cash to receivables to income and means nothing.
  console.log("\n6. Multi-account ledger partitions per account");
  const top = Object.entries(linesPerAccount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
  if (top.length >= 2) {
    let multi = null, mErr = null;
    try { multi = await allRpc("acct_account_ledger",
      { p_company_id: COMPANY, p_account_ids: top, p_start: null, p_end: null }); }
    catch (e) { mErr = e; }
    assert(!mErr, "multi-account ledger returns without error", mErr?.message);
    const perAccountFirst = {};
    for (const r of multi || []) {
      if (perAccountFirst[r.account_id] === undefined) perAccountFirst[r.account_id] = safeNum(r.balance);
    }
    let restarts = 0;
    for (const id of top) {
      const idx = clientIndex(null)[id];
      if (!idx) continue;
      const a = acctById[id];
      const dir = DEBIT_NORMAL.includes(a?.type) ? "debit" : "credit";
      // The first row of each account's block is that row's own movement,
      // not a continuation of the previous account's total.
      const firstRow = (multi || []).find(r => String(r.account_id) === String(id));
      if (!firstRow) continue;
      const own = dir === "debit"
        ? safeNum(firstRow.debit) - safeNum(firstRow.credit)
        : safeNum(firstRow.credit) - safeNum(firstRow.debit);
      if (money(perAccountFirst[id], own)) restarts++;
    }
    assert(restarts === top.filter(id => clientIndex(null)[id]).length,
      `each of the ${top.length} accounts restarts its own running balance`,
      `${restarts} restarted`);
  } else {
    console.log("  (skipped — fewer than two accounts with posted lines)");
  }

  console.log(`\n================================================================`);
  console.log(`✅ Passed: ${pass}`);
  console.log(`❌ Failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("\nFATAL:", e.message); process.exit(1); });
