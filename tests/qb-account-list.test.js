// The QuickBooks Account List import — the OPTIONAL half of the QB import.
//
// Run: cd tests && node qb-account-list.test.js
//
// The Account List is QuickBooks' own report stating every account's Type
// and Detail Type. Supplying it is optional; when it is absent the
// importer infers types from account names instead. That fallback is
// measurably worse -- on these books the name rules misclassified 36 of
// 164 balance-sheet accounts -- so the whole point of this file is to
// prove BOTH paths work: the list wins when present, and the import
// still completes without it.
//
// qb-import.test.js has 125 tests and none of them touch this path.
const path = require("path");
const os = require("os");
const fs = require("fs");
const ExcelJS = require(path.join(__dirname, "..", "node_modules", "exceljs"));

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

// A workbook shaped exactly like QuickBooks' Reports → Account List
// export: a title row, a blank row, then the header.
async function makeAccountList(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Sigma Housing LLC"]);
  ws.addRow([]);
  ws.addRow(["Account Name", "Type", "Detail Type", "Balance"]);
  rows.forEach(r => ws.addRow(r));
  const f = path.join(os.tmpdir(), `qb-acct-list-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  await wb.xlsx.writeFile(f);
  return f;
}

(async () => {
  const qb = await import(path.join(__dirname, "..", "src", "utils", "qbImport.js"));
  const tmp = [];

  // ---- shape detection -------------------------------------------
  assert("an Account List is recognised by its headers",
    qb.isAccountListShape(["Account Name", "Type", "Detail Type", "Balance"]));

  assert("a transaction report is NOT mistaken for an Account List",
    !qb.isAccountListShape(["Transaction date", "Account Name", "Type", "Amount"]),
    "a transaction report also has Account Name and Type — the date column is what separates them");

  assert("headers are matched case-insensitively",
    qb.isAccountListShape(["ACCOUNT NAME", "type", "Detail Type"]));

  assert("a workbook with no Type column is not an Account List",
    !qb.isAccountListShape(["Account Name", "Balance"]));

  // Against the real exports, if they are still on disk.
  const realFiles = ["Assets.xlsx", "Liability.xlsx", "PL.xlsx"]
    .map(f => path.join(os.homedir(), "Downloads", f))
    .filter(f => fs.existsSync(f));
  if (realFiles.length) {
    let anyMisread = false;
    for (const f of realFiles) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(f);
      const ws = wb.worksheets[0];
      const hdr = qb.findHeaderRow(ws);
      const headers = hdr ? Object.keys(hdr.map || {}) : [];
      if (headers.length && qb.isAccountListShape(headers)) anyMisread = true;
    }
    assert(`the ${realFiles.length} real QuickBooks exports are not misread as Account Lists`, !anyMisread);
  } else {
    console.log("⏭️  real QuickBooks exports not on disk — skipping that check");
  }

  // ---- parsing ----------------------------------------------------
  const f1 = await makeAccountList([
    ["Sigma Checking",                         "Bank",                      "Checking",              12000],
    ["Accounts Receivable",                    "Accounts receivable (A/R)", "Accounts Receivable",    3400],
    ["Investment Asset",                       "Fixed Assets",              "Buildings",            250000],
    ["Investment Asset:1 1 Barberry Ct",       "Fixed Assets",              "Buildings",             90000],
    ["Utopia Atlantic Checking",               "Other Current Assets",      "Loans To Others",        5000],
    ["BOA Loan 4412",                          "Other Current Liabilities", "Other Current Liab",   -80000],
    ["Owner's Equity",                         "Equity",                    "Owners Equity",             0],
    ["Rental Income",                          "Income",                    "Sales of Product Income",   0],
    ["Repairs & Maintenance",                  "Expenses",                  "Repairs & Maintenance",     0],
  ]);
  tmp.push(f1);
  const { accounts: list, warnings } = await qb.parseAccountList(f1);

  assert("every row is parsed", list.size === 9, `got ${list.size}`);
  assert("parsing a clean list produces no warnings", warnings.length === 0, JSON.stringify(warnings));

  assert("a Bank account maps to Asset / Bank",
    list.get("Sigma Checking")?.type === "Asset" && list.get("Sigma Checking")?.subtype === "Bank");

  assert("QuickBooks wins over the name: 'Utopia Atlantic Checking' is NOT a bank",
    list.get("Utopia Atlantic Checking")?.subtype === "Other Current Asset",
    "got " + list.get("Utopia Atlantic Checking")?.subtype +
    " — the name says Checking, QuickBooks says Other Current Assets");

  assert("a loan QuickBooks calls Other Current Liabilities is not promoted to Long Term",
    list.get("BOA Loan 4412")?.subtype === "Other Current Liability",
    "got " + list.get("BOA Loan 4412")?.subtype);

  assert("Income maps to Revenue",
    list.get("Rental Income")?.type === "Revenue");

  assert("sub-accounts are keyed on their full colon path",
    list.has("Investment Asset:1 1 Barberry Ct"));

  // ---- unknown / malformed input ----------------------------------
  const f2 = await makeAccountList([
    ["Mystery Account", "Some Type QuickBooks Invented", "", 0],
    ["", "Bank", "Checking", 0],
  ]);
  tmp.push(f2);
  const bad = await qb.parseAccountList(f2);
  assert("an unrecognised QuickBooks type does not throw", !!bad.accounts);
  assert("an unrecognised type is reported rather than silently guessed",
    bad.warnings.length > 0 || !bad.accounts.get("Mystery Account")?.type,
    "warnings: " + JSON.stringify(bad.warnings));
  assert("a nameless row is not imported", !bad.accounts.has(""));

  // ---- the plan: with the list, and without it --------------------
  // The shape parseWorkbook emits: accountPath / accountType / debit /
  // credit / sourceFile. buildAccountInventory sorts on accountType and
  // will throw on a hand-built row that omits it.
  const rows = [
    { sourceFile: "Assets.xlsx", accountPath: "Sigma Checking",
      accountType: "Asset", debit: 100, credit: 0 },
    { sourceFile: "Assets.xlsx", accountPath: "Utopia Atlantic Checking",
      accountType: "Asset", debit: 0, credit: 100 },
  ];

  const withList = qb.buildImportPlan({ rows, existingAccounts: [], accountList: list });
  const withoutList = qb.buildImportPlan({ rows, existingAccounts: [], accountList: null });

  assert("the import plan is produced WITHOUT an Account List — it is optional",
    Array.isArray(withoutList.accounts) && withoutList.accounts.length > 0,
    "this is the whole point: the list must never be mandatory");

  assert("the import plan is also produced WITH an Account List",
    Array.isArray(withList.accounts) && withList.accounts.length > 0);

  const pick = (plan, p) => plan.accounts.find(a => a.path === p);
  const withL = pick(withList, "Utopia Atlantic Checking");
  const noL = pick(withoutList, "Utopia Atlantic Checking");

  if (withL && noL) {
    assert("with the list, the account is marked as classified BY the list",
      /Account List/i.test(withL.classifiedBy || ""), "got " + withL.classifiedBy);
    assert("without the list, the account is marked as INFERRED, so guesses are visible",
      /inferred/i.test(noL.classifiedBy || ""), "got " + noL.classifiedBy);
    assert("the list actually changes the answer for a misleadingly-named account",
      withL.subtype !== noL.subtype,
      `with list: ${withL.subtype}, without: ${noL.subtype} — if these match, the list is having no effect`);
  } else {
    assert("the plan contains the accounts under test", false,
      "paths present: " + withList.accounts.map(a => a.path).join(", "));
  }

  tmp.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
  console.log(`\n✅ Passed: ${passed}   ❌ Failed: ${failed}`);
  console.log(`Total: ${passed + failed} | Pass rate: ${Math.round(passed / (passed + failed) * 100)}%`);
  process.exit(failed ? 1 : 0);
})();
