// Bank reconciliation must use the arithmetic every accountant already knows.
//
// What this replaces could not reconcile anything, and the reason was in the
// schema: bank_reconciliations had no account_id. Three bank feeds, one
// undifferentiated pile, so "the prior period's ending balance" -- the figure
// the whole exercise hangs from -- had no answer. The table held zero rows
// and that was not a coincidence.
//
// The model, from QuickBooks:
//
//     beginning balance = the PRIOR completed reconciliation's ending balance
//     cleared balance   = beginning + cleared debits - cleared credits
//     difference        = statement ending balance - cleared balance   -> 0.00
//
// and from Xero, for the always-on health figure:
//
//     statement balance + outstanding receipts - outstanding payments
//         = balance in the books
//
// The old code compared the typed statement balance against the account's
// ENTIRE posted history, 2023 to today. Reconciling September measured a
// September bank figure against three years of books, so it could not come
// out right however carefully the month was ticked. On 1402 that showed as a
// $112,107.85 book balance against a $94.43 statement.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}
const money = n => Math.round(n * 100) / 100;

console.log("\n=== RECONCILIATION ===\n");

// ---- the arithmetic, stated once and tested directly ---------------------
// Mirrors saveReconciliation. Kept here as a spec: if the component drifts
// from it, the source assertions further down fail and say so.
function reconcile({ beginning, items, statementEnding }) {
  const cleared = items.filter(i => i.reconciled);
  const clearedMovement = cleared.reduce((s, i) => s + i.amount, 0);
  const clearedBalance = money(beginning + clearedMovement);
  const difference = money(statementEnding - clearedBalance);
  return {
    clearedBalance, difference,
    balanced: Math.abs(difference) < 0.005,
    outstanding: items.filter(i => !i.reconciled).reduce((s, i) => s + i.amount, 0),
    status: Math.abs(difference) < 0.005 ? "reconciled" : "discrepancy",
  };
}

// A clean month: everything on the statement cleared.
let r = reconcile({
  beginning: 1000,
  items: [{ amount: 500, reconciled: true }, { amount: -200, reconciled: true }],
  statementEnding: 1300,
});
assert("a month where everything cleared balances to zero",
  r.balanced && r.clearedBalance === 1300 && r.difference === 0,
  JSON.stringify(r));

// An uncleared cheque is not an error. It is outstanding, and the statement
// still balances without it -- this is the case the old code got wrong, by
// treating anything unticked as part of the difference.
r = reconcile({
  beginning: 1000,
  items: [{ amount: 500, reconciled: true }, { amount: -200, reconciled: false }],
  statementEnding: 1500,
});
assert("an outstanding item does not break the balance",
  r.balanced && r.outstanding === -200,
  "a cheque written but not yet presented belongs to the next period, not to this difference");

// The beginning balance is load-bearing: ignore it and every period after the
// first is wrong by the whole prior balance.
const withOpening = reconcile({ beginning: 1000, items: [{ amount: 500, reconciled: true }], statementEnding: 1500 });
const withoutOpening = reconcile({ beginning: 0, items: [{ amount: 500, reconciled: true }], statementEnding: 1500 });
assert("dropping the beginning balance breaks the difference by exactly that amount",
  withOpening.balanced && !withoutOpening.balanced && withoutOpening.difference === 1000,
  "which is why it is stored and carried, not recomputed");

// Starting from zero, as chosen for these books: the first period's opening
// is 0 and everything before it is simply outstanding.
r = reconcile({ beginning: 0, items: [{ amount: 94.43, reconciled: true }], statementEnding: 94.43 });
assert("a first-ever reconciliation starts from zero and can still balance",
  r.balanced, JSON.stringify(r));

// Money is decimal; floats are not. 0.1 + 0.2 must not open a discrepancy.
r = reconcile({
  beginning: 0.1,
  items: [{ amount: 0.2, reconciled: true }],
  statementEnding: 0.3,
});
assert("float noise does not manufacture a discrepancy",
  r.balanced && r.difference === 0,
  "0.1 + 0.2 === 0.30000000000000004; rounding to cents before comparing is the whole point");

// Only zero earns the word.
r = reconcile({ beginning: 0, items: [{ amount: 100, reconciled: true }], statementEnding: 100.01 });
assert("a one-cent gap is a discrepancy, not a reconciliation",
  !r.balanced && r.status === "discrepancy",
  "recording a near-miss as reconciled makes a wrong balance the starting point for every period after it");

// ---- the component must implement that spec ------------------------------
const acctSrc = fs.readFileSync(path.join(__dirname, "..", "src", "components", "Accounting.js"), "utf8");
const save = acctSrc.slice(acctSrc.indexOf("async function saveReconciliation"));
const start = acctSrc.slice(acctSrc.indexOf("async function startReconciliation"));

assert("the beginning balance is READ from the prior reconciliation",
  /from\("bank_reconciliations"\)[\s\S]{0,400}?eq\("status", "reconciled"\)[\s\S]{0,200}?lt\("period", reconPeriod\)/.test(start),
  "recomputing it lets an edit to an already-reconciled transaction move a closed period's starting point");

assert("the prior reconciliation is scoped to THIS account",
  /eq\("account_id", acct\.id\)/.test(start),
  "without account_id, three bank feeds share one history and the carry-forward is whichever row sorts first");

assert("cleared balance = beginning + cleared movement",
  /clearedBalance = Math\.round\(\(safeNum\(beginningBalance\) \+ clearedMovement\)/.test(save),
  "this is the QuickBooks definition; anything else is not a reconciliation");

assert("difference = statement ending - cleared balance",
  /const diff = Math\.round\(\(bankBal - clearedBalance\)/.test(save),
  "comparing against all-time books measured a September statement against three years of ledger");

assert("the books are no longer summed over all time",
  !/acct_journal_entries!inner\(status, date\)[\s\S]{0,200}bookBal/.test(save) && !/const bookBal =/.test(save),
  "the all-time sum is what produced $112,107.85 against a $94.43 statement");

assert('only a zero difference is recorded as "reconciled"',
  /const status = balanced \? "reconciled" : "discrepancy"/.test(save),
  "a softer word makes a wrong balance permanent, because the next period carries it");

assert("saving an unbalanced period asks first",
  /The difference is not zero/.test(save),
  "silently recording a discrepancy is how one gets carried forward unnoticed");

assert("the stored row carries the whole model",
  ["account_id:", "beginning_balance:", "cleared_balance:", "statement_date:", "cleared_count:"]
    .every(k => save.includes(k)),
  "a reconciliation that does not record its own inputs cannot be audited or reproduced");

assert("re-running a month corrects it rather than stacking a second row",
  /onConflict: "company_id,account_id,period"/.test(save),
  "two rows for one period means the next beginning-balance lookup picks one arbitrarily");

assert("the screen shows the same sum the save records",
  /clearedBalanceUi = Math\.round\(\(safeNum\(beginningBalance\) \+ reconciledTotal\)/.test(acctSrc)
    && /diffUi = Math\.round\(\(Number\(bankBalance \|\| 0\) - clearedBalanceUi\)/.test(acctSrc),
  "a screen saying balanced while the record says discrepancy is worse than either");

assert("the period's lines are read by date, not by an id list",
  /acct_journal_entries!inner\(id, date, description, reference, status\)/.test(start)
    && !/in\("journal_entry_id", entryIds\)/.test(start),
  "the id-list form hit PostgREST's 1000-row cap and the .in() limit, both silently");

// ---- as at a date, not for a window --------------------------------------
// A statement closes on a date and you tick what had cleared by then --
// including a cheque written in October that cleared in December. Filtering
// to the statement's own month hid exactly those: reconciling 31 Dec 2025
// showed ten December entries and nothing before, so every older uncleared
// item was invisible and the difference could never close.
assert("items are everything up to the statement date",
  /lte\("acct_journal_entries\.date", asAt\)/.test(start)
    && !/gte\("acct_journal_entries\.date"/.test(start),
  "a lower bound turns a reconciliation into a period report and hides older uncleared items");

assert("already-reconciled lines are excluded",
  /or\("reconciled\.is\.null,reconciled\.eq\.false"\)/.test(start),
  "they sit inside the beginning balance; showing them again invites double-counting");

assert("the statement date is the as-at date",
  /const stmtDate = reconRange\.asAt/.test(save),
  "storing a month end after reconciling to the 16th records a date nobody reconciled to");

// ---- the balance snapshot ------------------------------------------------
const plaidSrc = fs.readFileSync(path.join(__dirname, "..", "api", "plaid-sync-transactions.js"), "utf8");
assert("every sync records what the bank said, and when",
  /from\("bank_balance_snapshot"\)\.insert\(snapshots\)/.test(plaidSrc),
  "bank_balance_current is overwritten each sync, destroying the figure a closed period must be reconciled against");

assert("the snapshot takes company_id from the connection, not the feed",
  /company_id: conn\.company_id, bank_account_feed_id: feed\.id/.test(plaidSrc),
  "the feeds query selects only id/plaid_account_id/status, so feed.company_id is undefined and company_id is NOT NULL");

assert("a failed snapshot never fails the sync",
  /snapErr[\s\S]{0,120}console\.error/.test(plaidSrc),
  "the transactions are the point; the audit trail must not be able to block them");

// ---- the migration -------------------------------------------------------
const mig = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations",
  "20260916100000_reconciliation_from_the_ground_up.sql"), "utf8");
assert("bank_reconciliations gains the account it reconciles",
  /add column if not exists account_id uuid references public\.acct_accounts\(id\)/.test(mig),
  "its absence is the root cause: no account means no per-account carry-forward");

assert("one reconciliation per account per period is enforced in the database",
  /create unique index if not exists bank_reconciliations_account_period_uniq/.test(mig),
  "application-level uniqueness is not uniqueness");

assert("the snapshot table is row-level secured and service-write only",
  /alter table public\.bank_balance_snapshot enable row level security/.test(mig)
    && /for all to service_role/.test(mig),
  "balances are company data; only the sync worker writes them");

// ---- the 1000-row ceiling, which returns plausible data instead of an error
// PostgREST caps an unpaged select at 1000 rows server-side. .limit(n) is a
// client hint and does not raise it. The ledger's opening balance shipped with
// .limit(20000) and got exactly 1000 of 1590's 1516 pre-2026 lines -- in date
// order, stopping at 2025-10-07 -- so it opened at 45,291.34 instead of
// 40,921.73 and the ledger closed 4,369.61 above the balance sheet.
//
// The same ceiling had been removed from the reconciler hours earlier. A cap
// that fails by returning a believable number is reintroduced this easily, so
// it is asserted rather than remembered.
const lineQueries = [...acctSrc.matchAll(/from\("acct_journal_lines"\)[\s\S]{0,700}?(?=\n\s*(?:if|const|\}|await|return))/g)]
  .map(m => m[0]);
const unpagedWithLimit = lineQueries.filter(q => /\.limit\(\s*\d{4,}\s*\)/.test(q));
assert("no acct_journal_lines query relies on .limit() to beat the row cap",
  unpagedWithLimit.length === 0,
  unpagedWithLimit.length
    ? "found " + unpagedWithLimit.length + ": " + unpagedWithLimit[0].slice(0, 150)
    : "");

assert("the ledger's opening balance is read in pages",
  /fetchAllPaged\([\s\S]{0,400}?lt\("acct_journal_entries\.date", start\)/.test(acctSrc),
  "an opening balance short by a thousand rows still looks like a balance");


console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
