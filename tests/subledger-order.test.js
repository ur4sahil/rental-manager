// Sub-ledgers under a parent account must read alphabetically.
//
// Accounts are fetched .order("code"), and a sub-account's code is assigned
// sequentially at creation time, so the sub-ledger came out in the order the
// tenants happened to be created. On Sigma's balance sheet the first stretch
// looked sorted -- those tenants arrived in one alphabetical import -- and
// then broke completely at the point where later tenants were appended.
// Loads the REAL comparator out of acctReports.js rather than restating it
// here. src/ is ESM with extensionless imports, which plain node cannot
// resolve, and a transcribed copy would silently stop testing the shipped
// code the moment someone edited it. So the four declarations are lifted
// verbatim from source and evaluated. If they are renamed or removed, this
// throws rather than passing against a stale copy.
const fs = require("fs");
const path = require("path");
const reportSrc = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "acctReports.js"), "utf8");
const sortAccountsForReport = (() => {
  // The comparator and its three helpers are contiguous in acctReports.js.
  // Take that block verbatim and evaluate it, so this tests the SHIPPED code
  // rather than a transcription that could drift away from it. src/ is ESM
  // with extensionless imports, which plain node cannot resolve, hence the
  // slice instead of a require.
  const from = reportSrc.indexOf("const baseCode =");
  const decl = reportSrc.indexOf("export const sortAccountsForReport =");
  if (from < 0 || decl < 0) throw new Error("acctReports.js no longer declares baseCode / sortAccountsForReport");
  // "\n});" at line start -- the body contains "true });" inline, which a
  // bare indexOf("});") would cut at.
  const to = reportSrc.indexOf("\n});", decl) + 4;
  const block = reportSrc.slice(from, to).replace(/^export /gm, "");
  // eslint-disable-next-line no-new-func
  return new Function(block + "\nreturn sortAccountsForReport;")();
})();

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}
const names = l => l.map(a => a.name);

console.log("\n=== SUB-LEDGER ORDERING ===\n");

// ---- the exact rows from the screenshot, in the order they rendered -------
const screenshot = [
  "Satara Wedge", "Shanetta Richardson", "Shelly Karriem", "Shiniqua Jackson",
  "Tamika Ford", "TAMIKA PARKER", "Taneka Artwell", "Toni Tillman", "VIOLA JONES",
  "Stanley Ibe", "Razelle Collins (2501 B Kent Town Pl)",
  "Tanesha Chaunte (6958 Hawthorne St)", "Geanine Reaves (6972 Hawthorne St)",
  "Derrick Robinson-El (2508 Kent Village Dr)", "Delisa Davis (6974 Hawthorne St)",
  "Abayomi Asokeji (6978 Hawthorne St)", "Amanda Mathews (6980 Hawthorne St)",
  "Michelle Moore (2608 B Kent Village Dr)", "Kimella Rodgers (6870 Hawthorne St)",
  "amanda mathews (8693 Greenbelt)", "Roseline Obadimu",
].map((n, i) => ({ id: "s" + i, name: "AR - " + n, code: "1100-" + String(i + 1).padStart(3, "0") }));

const sorted = names(sortAccountsForReport(screenshot)).map(n => n.replace("AR - ", ""));

assert("the screenshot's rows come out alphabetical",
  JSON.stringify(sorted) === JSON.stringify([...sorted].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))),
  "got:\n     " + sorted.join("\n     "));

assert("a name buried mid-list by creation order moves to the front",
  sorted[0].toLowerCase().startsWith("abayomi"),
  "Abayomi Asokeji was 16th by code; got '" + sorted[0] + "' first");

// ---- case must not split a name away from its twin --------------------
// "amanda mathews (8693 Greenbelt)" and "Amanda Mathews (6980 Hawthorne St)"
// are different accounts with the same person's name in different case.
const aIdx = sorted.findIndex(n => n.toLowerCase().startsWith("amanda mathews"));
assert("case-insensitive: the two Amanda Mathews rows sit together",
  sorted[aIdx + 1] && sorted[aIdx + 1].toLowerCase().startsWith("amanda mathews"),
  "a case-sensitive sort files lowercase after Z; got " + JSON.stringify(sorted.slice(0, 4)));

assert("case-insensitive: TAMIKA PARKER files under T, not before A",
  sorted.findIndex(n => n === "TAMIKA PARKER") > sorted.findIndex(n => n === "Satara Wedge"),
  "uppercase names must not sort ahead of the whole list");

// ---- digits in the property suffix compare as numbers ------------------
const nums = [
  { id: "n1", code: "1100-1", name: "AR - Same Name (11455 Abbotswood Ct)" },
  { id: "n2", code: "1100-2", name: "AR - Same Name (2508 Kent Village Dr)" },
].sort(() => 0);
assert("2508 sorts before 11455 (numeric, not lexical)",
  names(sortAccountsForReport(nums))[0].includes("2508"),
  "lexically '11455' < '2508'; numerically it is not");

// ---- parents keep CODE order; only the sub-ledger is alphabetised ------
// 1000 Checking must stay above 1100 AR whatever the letters say.
const mixed = [
  { id: "p2", code: "1100", name: "Accounts Receivable" },
  { id: "s2", code: "1100-002", name: "AR - Bob" },
  { id: "s1", code: "1100-001", name: "AR - Alice" },
  { id: "p1", code: "1000", name: "Zions Bank Checking" },
  { id: "p3", code: "2100", name: "Security Deposits Held" },
];
const mo = names(sortAccountsForReport(mixed));
assert("parents stay in code order, not alphabetical",
  JSON.stringify(mo) === JSON.stringify([
    "Zions Bank Checking", "Accounts Receivable", "AR - Alice", "AR - Bob", "Security Deposits Held",
  ]), "got: " + JSON.stringify(mo));

assert("a parent sits above its own sub-ledger",
  mo.indexOf("Accounts Receivable") < mo.indexOf("AR - Alice"));

// ---- each sub-ledger stays under ITS OWN parent ------------------------
const two = [
  { id: "a", code: "1100-002", name: "AR - Zoe" },
  { id: "b", code: "2100-001", name: "Deposit - Alice" },
  { id: "c", code: "1100-001", name: "AR - Adam" },
  { id: "d", code: "2100-002", name: "Deposit - Zack" },
];
assert("two sub-ledgers do not merge into one alphabetical run",
  JSON.stringify(names(sortAccountsForReport(two))) ===
  JSON.stringify(["AR - Adam", "AR - Zoe", "Deposit - Alice", "Deposit - Zack"]),
  "got: " + JSON.stringify(names(sortAccountsForReport(two))));

// ---- accounts with no code keep sorting last (Postgres NULLS LAST) -----
const uncoded = [
  { id: "u", name: "Uncoded Account" },
  { id: "c", code: "1000", name: "Checking" },
];
assert("an uncoded account is not hoisted to the top",
  names(sortAccountsForReport(uncoded))[0] === "Checking",
  "matches the .order(\"code\") NULLS LAST behaviour it replaces");

// ---- the comparator must not mutate its input -------------------------
const orig = [{ id: "1", code: "1100-002", name: "AR - Zoe" }, { id: "2", code: "1100-001", name: "AR - Adam" }];
const snapshot = names(orig);
sortAccountsForReport(orig);
assert("sorting does not mutate the caller's array",
  JSON.stringify(names(orig)) === JSON.stringify(snapshot),
  "an in-place sort would reorder the accounts list shared by every report");

// ---- degenerate input -------------------------------------------------
assert("null and undefined are handled", 
  sortAccountsForReport(null).length === 0 && sortAccountsForReport(undefined).length === 0);
assert("a row with no name does not throw",
  sortAccountsForReport([{ id: "x", code: "1100-1" }, { id: "y", code: "1100-2", name: "AR - A" }]).length === 2);

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
