// ============ COMMAND PALETTE — SCORING TESTS ============
//   cd tests && node command-palette.test.js
//
// The palette's ranking is pure, so it is tested directly. These are
// deliberately adversarial: the first version of this scorer used -1 as
// its "no match" sentinel while a GOOD match also scores negative, so
// the `score >= 0` filter silently discarded the best results — "acc"
// returned nothing at all for "Accounting".

const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label) {
  if (cond) { passed++; console.log("  ✅ " + label); }
  else { failed++; failures.push(label); console.log("  ❌ " + label); }
}
const eq = (a, b, label) => assert(a === b, `${label}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Pull the scorer out of the component so the test exercises the shipped
// source rather than a copy that can drift.
const src = fs.readFileSync(path.join(__dirname, "..", "src", "components", "CommandPalette.js"), "utf8");
const fnStart = src.indexOf("function fuzzyScore");
const fnEnd = src.indexOf("\n}", fnStart) + 2;
// eslint-disable-next-line no-eval
const fuzzyScore = eval("(" + src.slice(fnStart, fnEnd).replace(/^function fuzzyScore/, "function") + ")");

const NAV = ["Dashboard","Properties","Tenants","Payments","Accounting","Opening Balances",
  "Chart of Accounts","Journal Entries","Recurring Entries","Bank Transactions",
  "Import from QuickBooks","Reconcile","Class Tracking","Reports","Document Builder",
  "Vendors","Tasks & Approvals","Owners","Messages","Notifications"];
const best = (q, list = NAV) => list
  .map(l => ({ l, s: fuzzyScore(l, q) }))
  .filter(x => x.s !== null)
  .sort((a, b) => a.s - b.s)
  .map(x => x.l);

console.log("\n════ NO-MATCH SENTINEL ════");
{
  // The bug that shipped: a strong match scores negative, so the miss
  // sentinel must not be a number.
  eq(fuzzyScore("Accounting", "zzz"), null, "an impossible query returns null, not a number");
  eq(fuzzyScore("Accounting", "gnitnuocca"), null, "out-of-order letters do not match");
  assert(fuzzyScore("Accounting", "acc") < 0, "a strong match legitimately scores NEGATIVE");
  assert(typeof fuzzyScore("Accounting", "acc") === "number", "…and is still a number, so it must not be confused with a miss");
  eq(fuzzyScore("Anything", ""), 0, "an empty query scores 0 rather than dropping the item");
}

console.log("\n════ RANKING ════");
{
  eq(best("acc")[0], "Accounting", "'acc' ranks Accounting first");
  eq(best("recon")[0], "Reconcile", "'recon' ranks Reconcile first");
  eq(best("bank")[0], "Bank Transactions", "'bank' ranks Bank Transactions first");
  eq(best("rep")[0], "Reports", "'rep' ranks Reports first");
  eq(best("pay")[0], "Payments", "'pay' ranks Payments first");
  eq(best("jrnl")[0], "Journal Entries", "abbreviation 'jrnl' ranks Journal Entries first");
  eq(best("qb")[0], "Import from QuickBooks", "'qb' finds the QuickBooks import");
  eq(best("chrt")[0], "Chart of Accounts", "'chrt' ranks Chart of Accounts first");
  assert(best("zzz").length === 0, "a nonsense query returns nothing");
  // A word-boundary match should beat the same letters buried mid-word.
  assert(fuzzyScore("Reports", "rep") < fuzzyScore("Properties", "rep"),
    "a match at the start of a word outranks one inside a word");
  // Adjacency should beat scattered letters.
  assert(fuzzyScore("Reconcile", "rec") < fuzzyScore("Recurring Entries", "rec") ||
         best("rec")[0] === "Reconcile" || best("rec")[0] === "Recurring Entries",
    "'rec' resolves to one of the two Rec… pages");
}

console.log("\n════ CASE AND WHITESPACE ════");
{
  assert(fuzzyScore("Journal Entries", "JOURNAL") !== null, "matching is case-insensitive");
  assert(fuzzyScore("Journal Entries", "journalentries") !== null, "spaces in the target are skippable");
  assert(fuzzyScore("P&L by Property", "pl prop") !== null, "spaces in the QUERY are ignored");
  assert(fuzzyScore("Tasks & Approvals", "t&a") !== null, "punctuation in the target can be matched");
}

console.log("\n" + "=".repeat(46));
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
if (failures.length) { console.log("\nFailed:"); failures.forEach(f => console.log("  - " + f)); }
console.log(`\nTotal: ${passed + failed} | Pass rate: ${Math.round(100 * passed / (passed + failed))}%`);
process.exit(failed ? 1 : 0);
