// ============ QUICKBOOKS IMPORT — PARSER TESTS ============
//   cd tests && node qb-import.test.js
//
// Two layers:
//   1. Synthetic workbooks built in-memory — always run, and deliberately
//      adversarial: malformed dates, missing ids, formula cells, subtotal
//      rows, section headers leaking into the date column, float dust.
//   2. Assertions against the user's real QBO exports in ~/Downloads,
//      skipped with a notice when those files aren't present.

const path = require("path");
const os = require("os");
const fs = require("fs");
const ExcelJS = require(path.join(__dirname, "..", "node_modules", "exceljs"));

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label) {
  if (cond) { passed++; console.log("  ✅ " + label); }
  else { failed++; failures.push(label); console.log("  ❌ " + label); }
}
function assertEq(actual, expected, label) {
  assert(actual === expected, `${label}  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function near(a, b, eps = 0.005) { return Math.abs(a - b) < eps; }

// ---- synthetic workbook builder ------------------------------------
// Mirrors the real QBO layout: 3 title rows, a header row, then group
// headers / data rows / "Total for" rows, and an "Accrual Basis" footer.
const TR_HEADERS = ["", "Transaction date", "Transaction type", "Num", "Name", "Description",
  "Account Name", "Item split account", "Amount", "Balance", "Debit", "Credit",
  "Property", "Customer", "Vendor", "Memo", "Transaction ID"];
const PL_HEADERS = ["", "Transaction date", "Transaction type", "Num", "Name", "Property",
  "Class full name", "Description", "Item split account", "Amount", "Balance", "Vendor",
  "Debit", "Customer", "Transaction ID", "Credit", "Memo"];

async function buildWorkbook(headers, title, rows, file) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Test Co"]);
  ws.addRow([title]);
  ws.addRow(["January, 2023-December, 2025"]);
  ws.addRow([]);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(file);
  return file;
}
// helper: positional row for the TR layout
function trRow({ date = "", type = "", num = "", name = "", desc = "", account = "",
  split = "", amount = "", balance = "", debit = "", credit = "", property = "",
  customer = "", vendor = "", memo = "", txnId = "", col1 = "" } = {}) {
  return [col1, date, type, num, name, desc, account, split, amount, balance,
    debit, credit, property, customer, vendor, memo, txnId];
}
function plRow({ date = "", type = "", num = "", name = "", property = "", cls = "",
  desc = "", split = "", amount = "", balance = "", vendor = "", debit = "",
  customer = "", txnId = "", credit = "", memo = "", col1 = "" } = {}) {
  return [col1, date, type, num, name, property, cls, desc, split, amount, balance,
    vendor, debit, customer, txnId, credit, memo];
}

(async () => {
  const qb = await import(path.join(__dirname, "..", "src", "utils", "qbImport.js"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qbimp-"));

  console.log("\n════ 1. CELL READING ════");
  {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("s");
    const row = ws.addRow([]);
    row.getCell(1).value = { formula: "A1+A2", result: 1234.5 };
    row.getCell(2).value = { richText: [{ text: "Total for " }, { text: "Rent" }] };
    row.getCell(3).value = null;
    row.getCell(4).value = "  padded  ";
    row.getCell(5).value = { text: "linked", hyperlink: "http://x" };
    assertEq(qb.cellText(row.getCell(1)), "1234.5", "formula cell reads its result");
    assertEq(qb.cellText(row.getCell(2)), "Total for Rent", "rich text is concatenated");
    assertEq(qb.cellText(row.getCell(3)), "", "null cell reads as empty string");
    assertEq(qb.cellText(row.getCell(4)), "padded", "whitespace is trimmed");
    assertEq(qb.cellText(row.getCell(5)), "linked", "hyperlink cell reads its text");
    assertEq(qb.cellText(undefined), "", "undefined cell does not throw");
    assertEq(qb.cellNumber(row.getCell(1)), 1234.5, "cellNumber reads a formula result");
    assertEq(qb.cellNumber(row.getCell(3)), 0, "empty cell is numerically 0, not NaN");
    const r2 = ws.addRow([]);
    r2.getCell(1).value = "$1,234.56"; r2.getCell(2).value = "(500.00)"; r2.getCell(3).value = "abc";
    assertEq(qb.cellNumber(r2.getCell(1)), 1234.56, "currency formatting is stripped");
    assertEq(qb.cellNumber(r2.getCell(2)), -500, "parenthesised value is negative");
    assertEq(qb.cellNumber(r2.getCell(3)), 0, "non-numeric text is 0, never NaN");
  }

  console.log("\n════ 2. SHAPE + HEADER DETECTION ════");
  {
    const f = await buildWorkbook(TR_HEADERS, "Transaction Report", [
      trRow({ col1: "Checking" }),
      trRow({ date: "01/05/2023", type: "Deposit", account: "Checking", debit: 100, txnId: "1" }),
    ], path.join(tmp, "tr.xlsx"));
    const p = await qb.parseWorkbook(f, "tr.xlsx", "asset");
    assertEq(p.shape, "transaction-report", "Account Name column ⇒ transaction-report");
    assertEq(p.title, "Transaction Report", "title is read from row 2");

    const f2 = await buildWorkbook(PL_HEADERS, "Profit and Loss Detail", [
      plRow({ col1: "Income" }), plRow({ col1: "Rental Income" }),
      plRow({ date: "01/05/2023", type: "Journal Entry", credit: 100, txnId: "1" }),
    ], path.join(tmp, "pl.xlsx"));
    const p2 = await qb.parseWorkbook(f2, "pl.xlsx", "pl");
    assertEq(p2.shape, "pl-detail", "no Account Name column ⇒ pl-detail");
    assertEq(p2.rows[0].accountPath, "Rental Income", "P&L account comes from the section stack");
    assertEq(p2.rows[0].accountType, "Revenue", "Income section ⇒ Revenue");

    // A workbook with no recognisable header must not throw.
    const wb3 = new ExcelJS.Workbook(); wb3.addWorksheet("s").addRow(["junk"]);
    const f3 = path.join(tmp, "junk.xlsx"); await wb3.xlsx.writeFile(f3);
    const p3 = await qb.parseWorkbook(f3, "junk.xlsx", "asset");
    assertEq(p3.rows.length, 0, "unrecognisable workbook yields no rows");
    assert(p3.warnings.length > 0, "unrecognisable workbook reports a warning instead of throwing");
  }

  console.log("\n════ 3. ROW FILTERING (the MM/DD/YYYY rule) ════");
  {
    const f = await buildWorkbook(TR_HEADERS, "Transaction Report", [
      trRow({ col1: "Checking" }),
      trRow({ date: "01/05/2023", type: "Deposit", account: "Checking", debit: 100, txnId: "10" }),
      trRow({ col1: "Total for Checking", debit: 100 }),                       // subtotal
      trRow({ date: "2023-01-05", type: "Deposit", account: "X", txnId: "11" }),// ISO ⇒ not QBO data
      trRow({ date: "1/5/2023", type: "Deposit", account: "X", txnId: "12" }), // unpadded ⇒ rejected
      trRow({ date: "Accrual Basis Wednesday, September 02, 2026", type: "Accrual Basis ...", txnId: "" }),
      trRow({ date: "01/06/2023", type: "Deposit", account: "Checking", debit: 50, txnId: "" }), // no id
    ], path.join(tmp, "filter.xlsx"));
    const p = await qb.parseWorkbook(f, "filter.xlsx", "asset");
    assertEq(p.rows.length, 1, "only the one well-formed data row survives");
    assertEq(p.rows[0].txnId, "10", "the surviving row is the right one");
    assert(p.warnings.some(w => /Transaction ID/.test(w)), "a row missing Transaction ID is reported");
    assert(!p.rows.some(r => r.accountPath.startsWith("Total for")), "'Total for' never becomes an account");
  }

  console.log("\n════ 4. ACCOUNT TYPING ════");
  {
    assertEq(qb.inferAccountType({ shape: "pl-detail", section: "Income" }), "Revenue", "Income ⇒ Revenue");
    assertEq(qb.inferAccountType({ shape: "pl-detail", section: "Cost of Goods Sold" }), "Cost of Goods Sold", "COGS section ⇒ COGS");
    assertEq(qb.inferAccountType({ shape: "pl-detail", section: "Expenses" }), "Expense", "Expenses ⇒ Expense");
    assertEq(qb.inferAccountType({ shape: "pl-detail", section: "" }), "Expense", "unknown P&L section falls back to Expense");
    assertEq(qb.inferAccountType({ shape: "transaction-report", fileType: "Asset", accountPath: "Checking" }), "Asset", "asset file ⇒ Asset");
    assertEq(qb.inferAccountType({ shape: "transaction-report", fileType: "Liability", accountPath: "Lima One Loan" }), "Liability", "liability file ⇒ Liability");
    assertEq(qb.inferAccountType({ shape: "transaction-report", fileType: "Liability", accountPath: "Opening Balance Equity" }), "Equity", "equity named account inside the liability file ⇒ Equity");
    assertEq(qb.inferAccountType({ shape: "transaction-report", fileType: "Liability", accountPath: "Shruti's Equity" }), "Equity", "possessive equity name ⇒ Equity");
    assertEq(qb.inferAccountType({ shape: "transaction-report", fileType: "Liability", accountPath: "Equityvest Loan" }), "Liability", "'Equityvest' is not a word-boundary match ⇒ stays Liability");
  }

  console.log("\n════ 5. TRANSACTION GROUPING ════");
  {
    const rows = [
      { txnId: "5", date: "2023-03-01", txnType: "Journal Entry", num: "9", description: "Rent", debit: 100, credit: 0, property: "A St", accountPath: "AR", accountType: "Asset" },
      { txnId: "5", date: "2023-03-01", txnType: "Journal Entry", num: "9", description: "Rent", debit: 0, credit: 100, property: "A St", accountPath: "Rental Income", accountType: "Revenue" },
      { txnId: "6", date: "2023-02-01", txnType: "Deposit", num: "", description: "", debit: 40, credit: 0, property: "", accountPath: "Checking", accountType: "Asset" },
    ];
    const g = qb.groupTransactions(rows);
    assertEq(g.transactions.length, 2, "lines collapse into one entry per Transaction ID");
    assertEq(g.transactions[0].date, "2023-02-01", "entries are sorted by date ascending");
    assertEq(g.transactions[0].reference, "QB-6", "reference is QB-<Transaction ID>");
    const five = g.transactions.find(t => t.txnId === "5");
    assert(five.balanced, "a matched DR/CR pair is balanced");
    assertEq(five.lines.length, 2, "both lines are attached to their entry");
    assertEq(five.property, "A St", "entry property comes from its first line carrying one");
    assert(five.description.includes("Journal Entry") && five.description.includes("#9"), "description combines type and Num");
    assertEq(g.unbalanced.length, 1, "the one-sided entry is flagged unbalanced");
    assertEq(g.totals.entries, 2, "totals.entries counts entries, not lines");
    assertEq(g.totals.lines, 3, "totals.lines counts source lines");
    assertEq(g.totals.debit, 140, "total debit is summed");
    assertEq(g.totals.credit, 100, "total credit is summed");
    assertEq(g.totals.dateFrom, "2023-02-01", "dateFrom is the earliest entry");
    assertEq(g.totals.dateTo, "2023-03-01", "dateTo is the latest entry");

    // Float dust must not create phantom imbalances.
    const dust = qb.groupTransactions([
      { txnId: "7", date: "2023-01-01", txnType: "JE", debit: 0.1 + 0.2, credit: 0, accountPath: "A", accountType: "Asset" },
      { txnId: "7", date: "2023-01-01", txnType: "JE", debit: 0, credit: 0.3, accountPath: "B", accountType: "Revenue" },
    ]);
    assert(dust.transactions[0].balanced, "0.1+0.2 vs 0.3 is treated as balanced, not float-dust imbalance");
    assertEq(qb.groupTransactions([]).transactions.length, 0, "empty input yields no transactions");
  }

  console.log("\n════ 6. TENANT AR DETECTION ════");
  {
    const customers = ["Alexus Goines", "ANA PRECIADO", "Brittany Thomas"];
    assert(qb.suggestTenantAR("Alexus Goines", customers), "exact customer name is detected as tenant AR");
    assertEq(qb.suggestTenantAR("Ana Preciado", customers).customer, "ANA PRECIADO", "match is case-insensitive");
    assertEq(qb.suggestTenantAR("OLD - Brittany Thomas", customers).customer, "Brittany Thomas", "the OLD - prefix is ignored");
    assertEq(qb.suggestTenantAR("Housing Rent Receivable", customers), null,
      "a non-customer account is NOT claimed as tenant AR (the substring-matcher false positive)");
    assertEq(qb.suggestTenantAR("Loan Escrows:Escrow 904", customers), null, "a sub-account path is never tenant AR");
    assertEq(qb.suggestTenantAR("", customers), null, "empty account name is not tenant AR");
  }

  console.log("\n════ 7. INVENTORIES + TRIAL BALANCE ════");
  {
    const rows = [
      { accountPath: "Investment Asset:1 Barberry", accountType: "Asset", debit: 100, credit: 0, property: "1 Barberry", customer: "", vendor: "V1", sourceFile: "a" },
      { accountPath: "Investment Asset:1 Barberry", accountType: "Asset", debit: 50, credit: 0, property: "1 Barberry", customer: "", vendor: "", sourceFile: "a" },
      { accountPath: "Rental Income", accountType: "Revenue", debit: 0, credit: 150, property: "", customer: "C1", vendor: "", sourceFile: "p" },
    ];
    const inv = qb.buildAccountInventory(rows);
    assertEq(inv.length, 2, "inventory has one entry per distinct account path");
    const ia = inv.find(a => a.path.startsWith("Investment"));
    assertEq(ia.lineCount, 2, "line counts are aggregated per account");
    assertEq(ia.net, 150, "net is debit minus credit");
    assertEq(ia.parent, "Investment Asset", "colon path yields a parent");
    assertEq(ia.leaf, "1 Barberry", "colon path yields a leaf");
    const ents = qb.buildEntityInventory(rows);
    assertEq(ents.properties.length, 1, "distinct properties are collected");
    assertEq(ents.customers.length, 1, "distinct customers are collected");
    assertEq(ents.vendors.length, 1, "distinct vendors are collected");
    assertEq(ents.properties[0].lineCount, 2, "entity line counts are aggregated");
    const tb = qb.buildTrialBalance(rows);
    assertEq(tb.debit, 150, "trial balance total debit");
    assertEq(tb.credit, 150, "trial balance total credit");
    assertEq(tb.difference, 0, "a balanced set differences to zero");
    assertEq(tb.byType[0].type, "Asset", "trial balance is ordered Asset first");
  }

  console.log("\n════ 8. CODE ASSIGNMENT + PLAN ════");
  {
    // Reserved codes must be unreachable: resolveAccountId() maps bare
    // 4-digit codes by convention, so a generated account landing on
    // 4000 would hijack every future rent posting.
    const many = [];
    for (let i = 0; i < 60; i++) many.push({ path: "Acct " + i, type: "Revenue", role: "normal" });
    const { codes } = qb.assignAccountCodes(many, new Set());
    const generated = [...codes.values()].map(c => c.code);
    assertEq(generated.filter(c => qb.RESERVED_CODES.has(c)).length, 0,
      "no generated code collides with a reserved code");
    assertEq(new Set(generated).size, generated.length, "all generated codes are unique");
    assert(generated.every(c => parseInt(c, 10) >= 4500), "Revenue codes start at the 4500 block, clear of 4000-4200");

    // Existing codes in the company are also avoided.
    const { codes: c2 } = qb.assignAccountCodes(
      [{ path: "A", type: "Asset", role: "normal" }, { path: "B", type: "Asset", role: "normal" }],
      new Set(["1500"]));
    const asset = [...c2.values()].map(c => c.code);
    assert(!asset.includes("1500"), "an already-taken code is skipped");

    // Parent:Child becomes PARENT-NNN so the COA tree renders nested.
    const { codes: c3 } = qb.assignAccountCodes([
      { path: "Conventus Loan:CV Loan - 4620", parent: "Conventus Loan", type: "Liability", role: "normal" },
      { path: "Conventus Loan:CV Loan - 4747", parent: "Conventus Loan", type: "Liability", role: "normal" },
    ], new Set());
    const kids = [...c3.values()];
    assert(kids.every(k => k.code.includes("-")), "child accounts get a dashed code");
    assertEq(kids[0].parentCode, kids[1].parentCode, "siblings share one parent code");
    assert(kids[0].code.startsWith(kids[0].parentCode + "-"), "child code is prefixed by its parent code");

    // Tenant AR always lands under 1100 regardless of its QB parent.
    const { codes: c4 } = qb.assignAccountCodes(
      [{ path: "Jane Doe", type: "Asset", role: "tenant_ar" }], new Set());
    assertEq([...c4.values()][0].code, "1100-001", "tenant AR uses the 1100-NNN format");
    assertEq([...c4.values()][0].parentCode, "1100", "tenant AR hangs off Accounts Receivable");

    // Suggestion ranking: the real-world pair that defeats fuzzy matching.
    const existing = [{ id: "u1", code: "1110", name: "BOFA - 0822" }, { id: "u2", code: "4000", name: "Rental Income" }];
    const s1 = qb.suggestAccountMatch({ leaf: "Rental Income", path: "Rental Income" }, existing);
    assertEq(s1.score, 1, "exact name match scores 1");
    const s2 = qb.suggestAccountMatch({ leaf: "Sigma ACH - 0822", path: "Sigma ACH - 0822" }, existing);
    assertEq(s2 && s2.accountId, "u1", "Sigma ACH - 0822 matches BOFA - 0822 on the account number");
    assert(s2.reason.includes("0822"), "the match explains itself via the account number");
    const s3 = qb.suggestAccountMatch({ leaf: "Sigma Management Fee", path: "Sigma Management Fee" }, existing);
    assertEq(s3, null, "sharing the word 'Sigma' alone is NOT a match");
  }

  console.log("\n════ 9. ENTRIES PAYLOAD ════");
  {
    const txns = [
      { reference: "QB-1", date: "2023-01-01", description: "Rent", property: "A St", txnType: "Journal Entry", balanced: true,
        lines: [ { accountPath: "AR:Jane", debit: 100, credit: 0, property: "A St", memo: "m", customer: "Jane", vendor: "" },
                 { accountPath: "Rental Income", debit: 0, credit: 100, property: "A St", memo: "", customer: "", vendor: "" } ] },
      { reference: "QB-2", date: "2023-01-02", description: "Odd", property: "", txnType: "Deposit", balanced: false,
        lines: [ { accountPath: "Rental Income", debit: 0, credit: 50, property: "", memo: "", customer: "", vendor: "" } ] },
    ];
    const maps = { accountIdByPath: { "AR:Jane": "a1", "Rental Income": "a2" }, classIdByName: { "A St": "c1" }, vendorIdByName: {} };
    const bal = qb.buildEntriesPayload({ transactions: txns, ...maps });
    assertEq(bal.length, 1, "unbalanced transactions are excluded by default");
    assertEq(bal[0].lines.length, 2, "balanced entry keeps both lines");
    assertEq(bal[0].lines[0].classId, "c1", "property resolves to a class id");
    assertEq(bal[0].lines[0].customerName, "Jane", "customer is carried for entity attribution");
    const withUnb = qb.buildEntriesPayload({ transactions: txns, ...maps, includeUnbalanced: true });
    assertEq(withUnb.length, 2, "unbalanced can be opted in");
    // An account the user chose to skip drops its line, and an entry
    // left with no lines is omitted entirely rather than posted empty.
    const skipped = qb.buildEntriesPayload({ transactions: txns, accountIdByPath: {}, classIdByName: {}, vendorIdByName: {} });
    assertEq(skipped.length, 0, "entries whose accounts were all skipped are omitted");
  }

  console.log("\n════ 9b. NEVER EMIT A HALF ENTRY ════");
  {
    // This is the regression that matters most. An earlier version
    // dropped a line whose account was unmapped and posted the REST of
    // the entry, producing one-sided journal entries that looked real —
    // 4,510 of them, and a $7.4m imbalance, in a live company.
    const txns = [{
      reference: "QB-9", date: "2023-01-01", description: "Rent", property: "", txnType: "JE", balanced: true,
      lines: [
        { accountPath: "AR:Jane", debit: 100, credit: 0, property: "", memo: "", customer: "", vendor: "" },
        { accountPath: "Rental Income", debit: 0, credit: 100, property: "", memo: "", customer: "", vendor: "" },
      ],
    }];
    // Only one of the two accounts resolves — the P&L side is missing,
    // exactly what happens when the P&L export hasn't been loaded.
    const out = qb.buildEntriesPayload({
      transactions: txns,
      accountIdByPath: { "AR:Jane": "a1" },
      classIdByName: {}, vendorIdByName: {},
    });
    assertEq(out.length, 0, "an entry with an unresolvable account is NOT posted at all");
    assertEq(out.dropped.length, 1, "the skipped transaction is reported, not silently discarded");
    assertEq(out.dropped[0].accountPath, "Rental Income", "the report names the account that could not be resolved");

    // With both sides mapped it posts normally, both lines intact.
    const ok = qb.buildEntriesPayload({
      transactions: txns,
      accountIdByPath: { "AR:Jane": "a1", "Rental Income": "a2" },
      classIdByName: {}, vendorIdByName: {},
    });
    assertEq(ok.length, 1, "with every account resolved the entry posts");
    assertEq(ok[0].lines.length, 2, "and keeps both of its legs");
    assertEq(ok.dropped.length, 0, "nothing is reported as dropped");
  }

  console.log("\n════ 9c. STANDARD ACCOUNT SLOTS ════");
  {
    // A small ledger shaped like the real one: one deposit liability, two
    // bank accounts with different activity, rent, late fees, repairs,
    // utilities, interest, several loans, and a tenant receivable.
    let txn = 0;
    const rows = [];
    const line = (accountPath, accountType, debit, credit, extra = {}) =>
      rows.push({ accountPath, accountType, debit, credit, customer: "", property: "1 Main St", vendor: "", sourceFile: "t", txnId: String(++txn), ...extra });
    for (let i = 0; i < 5; i++) line("Checking Atlantic - 5248", "Asset", 100, 0);
    for (let i = 0; i < 2; i++) line("Utopia Atlantic Checking", "Asset", 10, 0);
    line("Security Deposit", "Liability", 0, 1500);
    line("Rental Income", "Revenue", 0, 1600);
    line("Late Fees", "Revenue", 0, 75);
    line("Repairs & Maintenance", "Expense", 200, 0);
    line("Utilities", "Expense", 90, 0);
    line("Interest Paid", "Expense", 400, 0);
    line("CV Loan - 4620", "Liability", 0, 90000);
    line("Conventus Loan:CV Loan - 4747", "Liability", 0, 80000);
    line("Conventus Loan:CV Loan - 4801", "Liability", 0, 70000);
    for (let i = 0; i < 3; i++) line("Jane Doe", "Asset", 1600, 0, { customer: "Jane Doe" });
    const plan = qb.buildImportPlan({ rows });
    const acct = p => plan.accounts.find(a => a.path === p);
    const slot = c => plan.standardSlots.find(s => s.code === c);

    // Clear winners take the app's own code.
    assertEq(acct("Security Deposit").code, "2100", "QB 'Security Deposit' takes 2100, the code every deposit posts to");
    assertEq(acct("Checking Atlantic - 5248").code, "1000", "the busier checking account takes 1000");
    assert(acct("Utopia Atlantic Checking").code !== "1000" && /^15\d\d$/.test(acct("Utopia Atlantic Checking").code),
      "the quieter checking account keeps a generated 15xx code");
    assert(/most activity: 5 lines/.test(slot("1000").how), "the bank choice explains itself by line counts");
    assertEq(acct("Rental Income").code, "4000", "Rental Income takes 4000");
    assertEq(acct("Late Fees").code, "4010", "'Late Fees' takes 4010");
    assertEq(acct("Repairs & Maintenance").code, "5300", "Repairs & Maintenance takes 5300");
    assertEq(acct("Utilities").code, "5400", "Utilities takes 5400");
    assertEq(acct("Interest Paid").code, "5600", "the single interest/loan-payment expense takes 5600");
    assertEq(acct("Security Deposit").leaf, "Security Deposit", "the QuickBooks name is kept");
    assertEq(acct("Security Deposit").parentCode, null, "a slotted account has no generated parent");
    // Loans are liabilities and stay liabilities.
    assert(/^25\d\d$/.test(acct("CV Loan - 4620").code), "a loan liability keeps a generated 25xx code");
    assert(acct("Conventus Loan:CV Loan - 4747").code.includes("-"), "a sub-account keeps its PARENT-NNN code");
    // Tenant AR stays under 1100.
    assertEq(acct("Jane Doe").role, "tenant_ar", "the customer-named receivable is still tenant AR");
    assertEq(acct("Jane Doe").code, "1100-001", "tenant AR still lands under 1100");
    // No collisions: each code used once, and no generated code is a standard one.
    const codes = plan.accounts.map(a => a.code);
    assertEq(new Set(codes).size, codes.length, "every planned account has a distinct code");
    assert(plan.accounts.filter(a => !a.standardCode).every(a => !qb.STANDARD_CODES.has(a.code)),
      "only slotted accounts carry a standard code");
    assertEq(plan.accounts.filter(a => a.standardCode).length, 7, "seven accounts are slotted");
    assert(!qb.STANDARD_CODES.has("1100"), "1100 (tenant AR parent) is never a slot");

    // Every candidate for a role that ties is left alone.
    const tie = qb.buildImportPlan({ rows: [
      ...["A", "B"].flatMap(n => [1, 2].map(i => ({ accountPath: "Bank " + n + " Checking", accountType: "Asset", debit: 1, credit: 0, txnId: n + i, sourceFile: "t" }))),
      { accountPath: "Rent - Building A", accountType: "Revenue", debit: 0, credit: 1, txnId: "r1", sourceFile: "t" },
      { accountPath: "Rent - Building B", accountType: "Revenue", debit: 0, credit: 1, txnId: "r2", sourceFile: "t" },
      { accountPath: "Legal Expenses", accountType: "Expense", debit: 1, credit: 0, txnId: "l1", sourceFile: "t" },
      { accountPath: "Legal & Professional Services", accountType: "Expense", debit: 1, credit: 0, txnId: "l2", sourceFile: "t" },
    ] });
    const tslot = c => tie.standardSlots.find(s => s.code === c);
    assertEq(tslot("1000").status, "unassigned", "two checking accounts with equal activity: 1000 is NOT guessed");
    assertEq(tslot("1000").candidates.length, 2, "both tied bank accounts are listed as candidates");
    assertEq(tslot("4000").status, "unassigned", "two 'Rent - <building>' incomes: 4000 is NOT guessed");
    assertEq(tslot("5610").status, "unassigned", "two legal expense accounts: 5610 is NOT guessed");
    assert(tie.accounts.every(a => !qb.STANDARD_CODES.has(a.code)), "no tied candidate lands on a standard code");
    assert(tie.accounts.every(a => !a.standardCode), "no tied candidate is marked as slotted");

    // An exact standard name settles a tie; a mere mention does not.
    const exact = qb.buildImportPlan({ rows: [
      { accountPath: "Rental Income", accountType: "Revenue", debit: 0, credit: 1, txnId: "1", sourceFile: "t" },
      { accountPath: "Rent - Parking", accountType: "Revenue", debit: 0, credit: 5, txnId: "2", sourceFile: "t" },
      { accountPath: "Rent - Parking", accountType: "Revenue", debit: 0, credit: 5, txnId: "3", sourceFile: "t" },
    ] });
    assertEq(exact.accounts.find(a => a.path === "Rental Income").code, "4000", "exact name 'Rental Income' wins the tie over 'Rent - Parking'");
    assert(exact.accounts.find(a => a.path === "Rent - Parking").code !== "4000", "the other rent account keeps a generated code");

    // Tenant receivables are never candidates, whatever they look like.
    const direct = qb.assignStandardRoles([
      { path: "Joe Checking - 1234", leaf: "Joe Checking - 1234", type: "Asset", subtype: "Bank", role: "tenant_ar", lineCount: 999, action: "create" },
      { path: "Ops Checking", leaf: "Ops Checking", type: "Asset", subtype: "Bank", role: "normal", lineCount: 3, action: "create" },
    ]);
    assertEq(direct.byPath.get("Ops Checking")?.code, "1000", "a real bank wins 1000 even against a busier tenant AR");
    assert(!direct.byPath.has("Joe Checking - 1234"), "a tenant AR account is never slotted");
    const onlyAr = qb.assignStandardRoles([
      { path: "Joe Checking - 1234", leaf: "Joe Checking - 1234", type: "Asset", subtype: "Bank", role: "tenant_ar", lineCount: 9, action: "create" },
    ]);
    assertEq(onlyAr.slots.find(s => s.code === "1000").status, "none", "with only a tenant AR, 1000 has no candidate at all");

    // Parents and sub-accounts keep the QB hierarchy.
    const tree = qb.assignStandardRoles([
      { path: "Utilities", leaf: "Utilities", type: "Expense", role: "normal", lineCount: 4, action: "create" },
      { path: "Utilities:Water", leaf: "Water", parent: "Utilities", type: "Expense", role: "normal", lineCount: 4, action: "create" },
    ]);
    assertEq(tree.byPath.size, 0, "neither a parent nor a sub-account is moved into a slot");

    // An app default already on the code: replaced only when EMPTY.
    const emptyDefault = [{ id: "d2100", code: "2100", name: "Security Deposits Held", lineCount: 0 }];
    const pe = qb.buildImportPlan({ rows, existingAccounts: emptyDefault });
    const sd = pe.accounts.find(a => a.path === "Security Deposit");
    assertEq(sd.code, "2100", "with an EMPTY default on 2100 the QB account still takes 2100");
    assertEq(sd.replaceAccountId, "d2100", "and takes over that empty default instead of colliding");
    assertEq(sd.action, "create", "the takeover rides the normal create path (server re-checks the zero lines)");
    assert(/took over the empty/.test(pe.standardSlots.find(s => s.code === "2100").how), "the summary says it took over the empty default");

    const usedDefault = [{ id: "d2100", code: "2100", name: "Security Deposits Held", lineCount: 7 }];
    const pu = qb.buildImportPlan({ rows, existingAccounts: usedDefault });
    const sd2 = pu.accounts.find(a => a.path === "Security Deposit");
    assert(sd2.code !== "2100" && /^25\d\d$/.test(sd2.code), "a default WITH lines is left alone; QB account keeps a generated code");
    assert(!sd2.replaceAccountId && !sd2.standardCode, "nothing is marked to replace or slot");
    assertEq(pu.standardSlots.find(s => s.code === "2100").status, "unassigned", "the slot is reported unassigned");
    assert(/7 journal lines/.test(pu.standardSlots.find(s => s.code === "2100").reason), "and the reason names the lines it has");

    const unknownDefault = [{ id: "d2100", code: "2100", name: "Security Deposits Held" }];
    const pk = qb.buildImportPlan({ rows, existingAccounts: unknownDefault });
    assert(pk.accounts.find(a => a.path === "Security Deposit").code !== "2100",
      "a default whose line count is unknown is treated as in use, never taken over");

    // An existing account of the same name is used as it always was.
    const named = [{ id: "d4000", code: "4000", name: "Rental Income", lineCount: 0 }];
    const pn = qb.buildImportPlan({ rows, existingAccounts: named });
    const ri = pn.accounts.find(a => a.path === "Rental Income");
    assertEq(ri.action, "map", "QB 'Rental Income' still maps by name onto the existing 4000");
    assertEq(ri.targetAccountId, "d4000", "onto that very account");
    assertEq(pn.standardSlots.find(s => s.code === "4000").status, "assigned", "and the summary counts 4000 as filled");

    // Summary text.
    const d = qb.describeStandardSlots(plan.standardSlots, plan.accounts);
    assert(d.text.includes('2100 Security Deposits Held <- QuickBooks "Security Deposit"'), "summary line: which QB account became 2100");
    assert(d.absent.some(s => s.code === "4200"), "roles QuickBooks has nothing for are listed as absent");
    const skippedPlan = { ...plan, accounts: plan.accounts.map(a => a.path === "Utilities" ? { ...a, action: "skip" } : a) };
    const ds = qb.describeStandardSlots(plan.standardSlots, skippedPlan.accounts);
    assert(ds.unassigned.some(s => s.code === "5400" && /skip/.test(s.reason)), "an account skipped on the Accounts step is reported unassigned");
    const dt = qb.describeStandardSlots(tie.standardSlots, tie.accounts);
    assert(dt.text.some(t => t.startsWith("1000 Checking Account: not assigned") && t.includes("Bank A Checking")),
      "an ambiguous slot is listed as not assigned, with its candidates");
  }

  console.log("\n════ 9d. NOTHING RE-SEEDS A PARALLEL STANDARD ACCOUNT ════");
  {
    const root = path.join(__dirname, "..");
    const read = f => fs.readFileSync(path.join(root, f), "utf8");
    const accountingSrc = read("src/utils/accounting.js");

    // The role table is the app's own chart: same codes, same names.
    const map = JSON.parse("{" + accountingSrc.match(/export const _acctCodeToName = \{([^}]*)\}/)[1] + "}");
    const expected = Object.entries(map).filter(([c]) => c !== "1100");
    assertEq(qb.STANDARD_ACCOUNT_ROLES.length, expected.length, "one role per _acctCodeToName code except 1100");
    assert(expected.every(([c, n]) => qb.STANDARD_ACCOUNT_ROLES.some(r => r.code === c && r.name === n)),
      "every role carries the exact code and name from _acctCodeToName");
    assert([...qb.STANDARD_CODES].every(c => qb.RESERVED_CODES.has(c)), "every standard code is also reserved from generation");

    // The server's allow-list matches the client's role table.
    const impl = read("api/_qb-import-impl.js");
    const serverCodes = new Set(impl.match(/const STANDARD_CODES = new Set\(\[([^\]]*)\]/)[1].match(/"\d{4}"/g).map(s => s.slice(1, -1)));
    assert(serverCodes.size === qb.STANDARD_CODES.size && [...serverCodes].every(c => qb.STANDARD_CODES.has(c)),
      "api/_qb-import-impl.js STANDARD_CODES equals the client's");
    // Standard accounts never go through the ignore-duplicates upsert, which
    // would silently post QB history into whatever already sits on the code.
    assert(/const plainAccounts = accounts\.filter\(a => !\(a && a\.standardCode\)\)/.test(impl) && /plainAccounts\.map\(accountRow\)/.test(impl),
      "server upserts only NON-standard accounts with ignoreDuplicates");
    assert(/acct_journal_lines[\s\S]{0,200}count: "exact"[\s\S]{0,200}account_id", existing\.id/.test(impl) && /return bad\(res, 409, st\.conflict\)/.test(impl),
      "server refuses (409) to take over a standard account that has journal lines");

    // ensureDefaultAccounts skips a code that is already taken, whatever its
    // name -- so an imported "Security Deposit" on 2100 is not duplicated
    // by a "Security Deposits Held" insert on the next login.
    const ensure = accountingSrc.slice(accountingSrc.indexOf("export async function ensureDefaultAccounts"));
    assert(/!existingCodes\.has\(String\(a\.code\)\)/.test(ensure.slice(0, 3000)), "ensureDefaultAccounts skips any code that already exists");
    // resolveAccountId finds an account by its code before it would create one.
    const resolve = accountingSrc.slice(accountingSrc.indexOf("export async function resolveAccountId"), accountingSrc.indexOf("// ============ TENANT AR SUB-ACCOUNT"));
    const byCode = resolve.indexOf("if (a.code) _acctIdCache[cid][a.code] = a.id;");
    const create = resolve.indexOf('from("acct_accounts").insert');
    assert(byCode > 0 && create > byCode && /if \(_acctIdCache\[cid\]\[bareCode\]\) return _acctIdCache\[cid\]\[bareCode\];\s*\/\/ Auto-create/.test(resolve),
      "resolveAccountId returns the account on the code before it would auto-create one");
    // The Accounting page seeds its chart only into a company with NO accounts.
    const acctPage = read("src/components/Accounting.js");
    assert(/if \(accounts\.length === 0\) \{\s*const defaults = \[/.test(acctPage), "the Accounting page seeds defaults only when the company has no accounts");
    // The wizard's SQL resolver looks up by code first.
    const wiz = read("supabase/baseline/schema.sql");
    const wizAt = wiz.indexOf("FUNCTION \"public\".\"_wizard_resolve_account\"");
    const wizFn = wizAt >= 0 ? wiz.slice(wizAt) : "";
    assert(/SELECT id INTO v_id FROM (public\.)?"?acct_accounts"? WHERE company_id = p_company_id AND code = p_code/i.test(wizFn.slice(0, 1500)),
      "_wizard_resolve_account returns the account on the code before inserting");
  }

  console.log("\n════ 10. REAL QUICKBOOKS EXPORTS ════");
  {
    const dl = path.join(os.homedir(), "Downloads");
    const files = [
      { f: path.join(dl, "Assets1.xlsx"), group: "asset" },
      { f: path.join(dl, "Liability.xlsx"), group: "liability" },
      { f: path.join(dl, "PL.xlsx"), group: "pl" },
    ];
    if (!files.every(x => fs.existsSync(x.f))) {
      console.log("  ⏭  skipped — real exports not present in ~/Downloads");
    } else {
      const parsed = [];
      for (const { f, group } of files) parsed.push(await qb.parseWorkbook(f, path.basename(f), group));
      const all = parsed.flatMap(p => p.rows);

      assertEq(parsed[0].shape, "transaction-report", "Assets1.xlsx parses as a Transaction Report");
      assertEq(parsed[2].shape, "pl-detail", "PL.xlsx parses as a P&L Detail report");
      assertEq(all.length, 14238, "total data rows across the three real exports");

      const g = qb.groupTransactions(all);
      assertEq(g.totals.entries, 6654, "distinct journal entries");
      assertEq(g.totals.dateFrom, "2023-01-01", "earliest transaction date");
      assertEq(g.totals.dateTo, "2025-12-31", "latest transaction date");
      // Totals are $19,200 HIGHER on each side than this test used to
      // assert, and that is the fix, not a regression.
      //
      // This test previously expected 24 unbalanced entries and even
      // described them: "The 24 are 12 offsetting pairs for one property,
      // all $1,600." Twelve one-sided $1,600 pairs for a single tenant was
      // written down as expected behaviour and never questioned. It was a
      // defect: each transaction had lost the leg that lived in an account
      // QuickBooks had DELETED, and buildEntriesPayload then refused to
      // post any of them -- correctly, since a one-sided entry silently
      // unbalances the books, but the result was 24 transactions missing
      // from the ledger and a bank account short by $19,200.
      //
      // groupTransactions now reconstructs that leg from the account
      // QuickBooks names in "Item split account", or from the Customer
      // when the P&L Detail leaves the split column empty. So the pairs
      // balance, they post, and the totals rise by the $19,200 that was
      // being dropped on each side.
      assert(near(g.totals.debit, 48689612.24), `total debits are 48,689,612.24 (got ${g.totals.debit})`);
      assert(near(g.totals.credit, 48689612.24), `total credits are 48,689,612.24 (got ${g.totals.credit})`);
      assert(near(g.totals.difference, 0), `the ledger balances to zero (got ${g.totals.difference})`);
      assertEq(g.totals.balancedEntries, 6654, "every entry balances individually");
      assertEq(g.totals.unbalancedEntries, 0, "no entry is left one-sided");

      // The repair itself, asserted rather than assumed.
      const rebuilt = g.transactions.filter(t => t.reconstructedLeg);
      assertEq(rebuilt.length, 24, "24 legs were reconstructed from a deleted account");
      assertEq(new Set(rebuilt.map(t => t.reconstructedLeg)).size, 1,
        "all reconstructed legs belong to one account");
      assert(rebuilt.every(t => t.balanced), "every reconstructed entry balances");
      assert(rebuilt.every(t => t.lines.length === 2), "each reconstructed entry has exactly two legs");
      const recon = rebuilt.flatMap(t => t.lines.filter(l => l.reconstructedFromSplit));
      assertEq(recon.length, 24, "one reconstructed line per entry");
      assert(near(recon.reduce((n, l) => n + l.debit, 0), 19200), "reconstructed debits total $19,200");
      assert(near(recon.reduce((n, l) => n + l.credit, 0), 19200), "reconstructed credits total $19,200");
      // Both routes must be exercised: the deposits name the account, the
      // rent entries only name the customer.
      assertEq(recon.filter(l => l.reconstructedFrom === "split account").length, 12,
        "12 legs came from Item split account");
      assertEq(recon.filter(l => l.reconstructedFrom === "customer").length, 12,
        "12 legs came from the Customer column");
      // And the revived account must reach the plan, or nothing is created
      // for it and the entry is dropped again for the original reason.
      const invAll = qb.buildAccountInventory(g.rowsWithReconstructed);
      const invList = Array.isArray(invAll) ? invAll : [...invAll.values()];
      const revived = invList.filter(a => a.path === [...new Set(rebuilt.map(t => t.reconstructedLeg))][0]);
      assertEq(revived.length, 1, "the revived account appears in the account inventory");
      assertEq(revived[0].lineCount, 24, "the revived account carries all 24 lines");

      // No transaction may span two dates or two types — the grouping premise.
      const spanning = g.transactions.filter(t => new Set(t.lines.map(l => l.date)).size > 1);
      assertEq(spanning.length, 0, "no transaction spans more than one date");
      const multiType = g.transactions.filter(t => new Set(t.lines.map(l => l.txnType)).size > 1);
      assertEq(multiType.length, 0, "no transaction spans more than one transaction type");
      assertEq(new Set(g.transactions.map(t => t.reference)).size, 6654, "every reference is unique");

      const accounts = qb.buildAccountInventory(all);
      assertEq(accounts.length, 193, "distinct accounts discovered");
      const byType = {};
      accounts.forEach(a => { byType[a.type] = (byType[a.type] || 0) + 1; });
      assertEq(byType.Asset, 128, "Asset accounts");
      assertEq(byType.Liability, 27, "Liability accounts");
      assertEq(byType.Equity, 3, "Equity accounts");
      assertEq(byType.Revenue, 6, "Revenue accounts");
      assertEq(byType.Expense, 26, "Expense accounts");
      assertEq(byType["Cost of Goods Sold"], 3, "Cost of Goods Sold accounts");

      // Investment Asset sub-accounts are exactly the group that was
      // missing from the first partial export.
      const investment = accounts.filter(a => a.parent === "Investment Asset");
      assertEq(investment.length, 39, "Investment Asset sub-accounts");
      assert(near(investment.reduce((s, a) => s + a.net, 0), 7721034.66),
        "Investment Asset net book value is 7,721,034.66 — the gap the partial export left");

      const ents = qb.buildEntityInventory(all);
      assertEq(ents.properties.length, 41, "distinct properties");
      assertEq(ents.customers.length, 65, "distinct customers");
      assertEq(ents.vendors.length, 82, "distinct vendors");

      const custNames = ents.customers.map(c => c.name);
      const arCount = accounts.filter(a => a.type === "Asset" && qb.suggestTenantAR(a.path, custNames)).length;
      assertEq(arCount, 54, "asset accounts identified as per-tenant receivables");

      // The reconstructed set, matching what the import UI now shows: a
      // revived leg is a real line that will be posted, so a trial balance
      // omitting it disagrees with the import by exactly the recovered
      // amount.
      // Standard slots on the real books (no Account List, empty company).
      const realPlan = qb.buildImportPlan({ rows: g.rowsWithReconstructed });
      const got = Object.fromEntries(realPlan.standardSlots.filter(s => s.status === "assigned").map(s => [s.code, s.qbPath]));
      assertEq(got["1000"], "Sigma Housing LLC - 6027", "real books: the busiest bank account (2,412 lines) takes 1000");
      assertEq(got["2100"], "Security Deposit", "real books: Security Deposit takes 2100");
      assertEq(got["4000"], "Rental Income", "real books: Rental Income takes 4000");
      assertEq(got["4010"], "Late Fee Income", "real books: Late Fee Income takes 4010");
      assertEq(got["5300"], "Repairs & Maintenance", "real books: Repairs & Maintenance takes 5300");
      assertEq(got["5400"], "Utilities", "real books: Utilities takes 5400");
      assertEq(realPlan.standardSlots.find(s => s.code === "5610").status, "unassigned",
        "real books: two legal expense accounts, so 5610 is left unassigned rather than guessed");
      assert(realPlan.accounts.filter(a => a.role === "tenant_ar").every(a => a.code.startsWith("1100-")),
        "real books: every tenant receivable still lands under 1100");

      const tb = qb.buildTrialBalance(g.rowsWithReconstructed);
      assert(near(tb.difference, 0), `trial balance differences to zero (got ${tb.difference})`);
      assert(near(tb.debit, 48689612.24), "trial balance debit total matches");
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n" + "=".repeat(46));
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  if (failures.length) { console.log("\nFailed:"); failures.forEach(f => console.log("  - " + f)); }
  console.log(`\nTotal: ${passed + failed} | Pass rate: ${Math.round(100 * passed / (passed + failed))}%`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
