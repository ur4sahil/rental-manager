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
      assert(near(g.totals.debit, 48670412.24), `total debits are 48,670,412.24 (got ${g.totals.debit})`);
      assert(near(g.totals.credit, 48670412.24), `total credits are 48,670,412.24 (got ${g.totals.credit})`);
      assert(near(g.totals.difference, 0), `the ledger balances to zero (got ${g.totals.difference})`);
      assertEq(g.totals.balancedEntries, 6630, "entries that balance individually");
      assertEq(g.totals.unbalancedEntries, 24, "entries that do not balance individually");
      assert(near(g.totals.unbalancedNet, 0), `the unbalanced entries net to zero (got ${g.totals.unbalancedNet})`);

      // The 24 are 12 offsetting pairs for one property, all $1,600.
      const unb = g.unbalanced;
      assert(unb.every(t => Math.abs(Math.abs(t.imbalance) - 1600) < 0.005), "every unbalanced entry is $1,600");
      assertEq(unb.filter(t => t.imbalance > 0).length, 12, "12 unbalanced entries are debit-heavy");
      assertEq(unb.filter(t => t.imbalance < 0).length, 12, "12 unbalanced entries are credit-heavy");
      assertEq(new Set(unb.map(t => t.lines[0].property)).size, 1, "all unbalanced entries are for a single property");

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

      const tb = qb.buildTrialBalance(all);
      assert(near(tb.difference, 0), `trial balance differences to zero (got ${tb.difference})`);
      assert(near(tb.debit, 48670412.24), "trial balance debit total matches");
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
