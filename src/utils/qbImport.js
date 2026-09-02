// ============ QUICKBOOKS LEDGER IMPORT — PARSER ============
//
// Pure parsing/normalizing layer for QuickBooks Online report exports.
// No Supabase, no React, no side effects — everything here is a pure
// function over an ExcelJS workbook, so it can be unit-tested directly
// against the real .xlsx files (see tests/qb-import.test.js).
//
// QBO emits two report shapes that we accept, and they are NOT the same:
//
//   "Transaction Report"      (Assets, Liabilities, Equity exports)
//     36 columns, has an explicit `Account Name` column carrying the full
//     colon-delimited path, e.g. "Investment Asset:1 1 Barberry Ct".
//
//   "Profit and Loss Detail"  (P&L export)
//     24 columns, NO `Account Name` column. The account is only knowable
//     from a nested section stack in column 1:
//         Ordinary Income/Expenses > Income > Rental Income
//     which conveniently also tells us the account TYPE.
//
// Both shapes interleave data rows with group headers and "Total for X"
// subtotal rows. The rule that cleanly separates them, verified against
// every row of the user's real exports, is:
//
//     a row is a DATA row if and only if its `Transaction date`
//     matches MM/DD/YYYY
//
// That single test rejects exactly the group headers, the "Total for X"
// rows, the trailing "Accrual Basis <timestamp>" footer each file
// carries, and a stray "Other Income" header that QBO leaks into the
// date column. Nothing else is needed.

import ExcelJS from "exceljs";

// Section labels in a P&L Detail report. These are structural — they
// name a section, never an account — so they update the section stack
// instead of becoming the current account. Anything in column 1 that
// isn't one of these (and isn't a "Total for") is an account name.
export const PL_SECTIONS = new Set([
  "Ordinary Income/Expenses",
  "Income",
  "Cost of Goods Sold",
  "Gross Profit",
  "Expenses",
  "Other Income",
  "Other Expenses",
  "Other Income/Expense",
  "Net Income",
  "Net Operating Income",
  "Net Ordinary Income",
  "Net Other Income",
]);

// A P&L section maps directly onto one of our account types.
const PL_SECTION_TYPE = {
  "Income": "Revenue",
  "Other Income": "Other Income",
  "Cost of Goods Sold": "Cost of Goods Sold",
  "Expenses": "Expense",
  "Other Expenses": "Other Expense",
};

// The account groups a file can contain. The user picks this per file on
// the upload step; a Transaction Report doesn't state its own type
// anywhere, so guessing from account names is unreliable and we ask.
export const QB_FILE_GROUPS = [
  { id: "asset", label: "Assets", type: "Asset" },
  { id: "liability", label: "Liabilities & Equity", type: "Liability" },
  { id: "equity", label: "Equity", type: "Equity" },
  { id: "pl", label: "Profit & Loss", type: null }, // type comes from sections
];

const DATA_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const TOTAL_ROW = /^Total for /i;

// ---- cell reading -------------------------------------------------

// ExcelJS hands back a bare value, a formula object, a rich-text object
// or a hyperlink object depending on how the cell was authored. QBO
// exports contain all of these (the "Total for" rows are formulas).
export function cellText(cell) {
  if (!cell) return "";
  let v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v.result !== undefined) v = v.result;
    else if (v.text !== undefined) v = v.text;
    else if (Array.isArray(v.richText)) v = v.richText.map(t => t.text).join("");
    else if (v instanceof Date) return v.toISOString().slice(0, 10);
    else return "";
  }
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

export function cellNumber(cell) {
  const raw = cellText(cell);
  if (!raw) return 0;
  // QBO writes plain numbers, but be tolerant of $ and thousands commas
  // and of parenthesised negatives if the export was re-saved by Excel.
  const neg = /^\(.*\)$/.test(raw);
  const n = parseFloat(raw.replace(/[$,()\s]/g, ""));
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}

// ---- header discovery ---------------------------------------------

// Returns { rowNumber, map } where map is header-label -> column index.
// QBO puts a 3-row title block above the header, but the offset varies
// by report, so scan rather than assume row 5.
export function findHeaderRow(worksheet, maxScan = 12) {
  const limit = Math.min(maxScan, worksheet.rowCount);
  for (let r = 1; r <= limit; r++) {
    const row = worksheet.getRow(r);
    let found = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cellText(cell) === "Transaction date") found = true;
    });
    if (found) {
      const map = {};
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const label = cellText(cell);
        // First occurrence wins: QBO repeats "Account name" (lowercase n)
        // as a separate column from "Account Name" in some exports.
        if (label && map[label] === undefined) map[label] = col;
      });
      return { rowNumber: r, map };
    }
  }
  return { rowNumber: 0, map: {} };
}

// "Transaction Report" carries the account per row; "Profit and Loss
// Detail" does not and must be reconstructed from section headers.
export function detectShape(headerMap) {
  return headerMap["Account Name"] ? "transaction-report" : "pl-detail";
}

// ---- account typing -----------------------------------------------

// An account is Equity rather than Liability when its name says so —
// QBO exports "Opening Balance Equity" and "<Owner>'s Equity" inside the
// Liabilities report because both are credit-normal balance sheet
// accounts.
export function inferAccountType({ shape, section, fileType, accountPath }) {
  if (shape === "pl-detail") {
    return PL_SECTION_TYPE[section] || "Expense";
  }
  if (fileType === "Liability" && /\bequity\b/i.test(accountPath || "")) {
    return "Equity";
  }
  return fileType || "Asset";
}

// ---- workbook parsing ---------------------------------------------

// Parse one QBO export. `group` is the id from QB_FILE_GROUPS telling us
// which account group this file holds (ignored for pl-detail, which
// derives type from its own sections).
//
// Returns { shape, title, group, rows, warnings, rejected }.
// Never throws on bad content — malformed rows land in `warnings` so the
// wizard can still show a preview.
export async function parseWorkbook(data, filename = "", group = "asset") {
  const wb = new ExcelJS.Workbook();
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    await wb.xlsx.load(data);
  } else {
    await wb.xlsx.readFile(data); // node/test path
  }
  const ws = wb.worksheets[0];
  const warnings = [];
  if (!ws) {
    return { shape: null, title: "", group, filename, rows: [], warnings: ["Workbook has no sheets."], rejected: 0 };
  }

  const title = cellText(ws.getRow(2).getCell(1));
  const { rowNumber: hdrRow, map: hdr } = findHeaderRow(ws);
  if (!hdrRow) {
    return {
      shape: null, title, group, filename, rows: [], rejected: 0,
      warnings: ["Could not find a 'Transaction date' header row — is this a QuickBooks report export?"],
    };
  }

  const shape = detectShape(hdr);
  const groupDef = QB_FILE_GROUPS.find(g => g.id === group) || QB_FILE_GROUPS[0];
  const fileType = groupDef.type;

  const txt = (row, label) => (hdr[label] ? cellText(row.getCell(hdr[label])) : "");
  const num = (row, label) => (hdr[label] ? cellNumber(row.getCell(hdr[label])) : 0);

  const rows = [];
  let currentAccount = "";
  let currentSection = "";
  let rejected = 0;

  for (let r = hdrRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const col1 = cellText(row.getCell(1));
    const date = txt(row, "Transaction date");

    // Structural row: header, section, subtotal, or footer.
    if (!DATA_DATE.test(date)) {
      if (col1 && !TOTAL_ROW.test(col1)) {
        if (PL_SECTIONS.has(col1)) currentSection = col1;
        else currentAccount = col1;
      }
      if (date) rejected++; // a non-conforming date, e.g. the Accrual Basis footer
      continue;
    }

    const accountPath =
      shape === "transaction-report"
        ? (txt(row, "Account Name") || currentAccount)
        : currentAccount;

    if (!accountPath) {
      warnings.push(`Row ${r}: no account could be determined; row skipped.`);
      rejected++;
      continue;
    }

    const debit = num(row, "Debit");
    const credit = num(row, "Credit");
    const txnId = txt(row, "Transaction ID");
    if (!txnId) {
      warnings.push(`Row ${r}: missing Transaction ID; row skipped.`);
      rejected++;
      continue;
    }

    rows.push({
      sourceFile: filename,
      sourceRow: r,
      shape,
      accountPath,
      accountType: inferAccountType({ shape, section: currentSection, fileType, accountPath }),
      section: currentSection,
      // QBO writes MM/DD/YYYY; store ISO so it sorts and inserts directly.
      date: `${date.slice(6, 10)}-${date.slice(0, 2)}-${date.slice(3, 5)}`,
      txnType: txt(row, "Transaction type"),
      num: txt(row, "Num"),
      name: txt(row, "Name"),
      description: txt(row, "Description"),
      memo: txt(row, "Memo"),
      splitAccount: txt(row, "Item split account"),
      debit,
      credit,
      property: txt(row, "Property"),
      customer: txt(row, "Customer"),
      vendor: txt(row, "Vendor"),
      txnId,
    });
  }

  return { shape, title, group, filename, rows, warnings, rejected };
}

// ---- transaction grouping -----------------------------------------

// Collapse parsed lines into journal entries. A QBO Transaction ID is
// the natural JE key: verified against the real exports, no transaction
// spans more than one date or one transaction type, so the grouping is
// unambiguous and every QB transaction becomes exactly one JE.
export function groupTransactions(rows) {
  const byId = new Map();
  for (const row of rows) {
    let t = byId.get(row.txnId);
    if (!t) {
      t = {
        txnId: row.txnId,
        reference: `QB-${row.txnId}`,
        date: row.date,
        txnType: row.txnType,
        num: row.num,
        lines: [],
        debit: 0,
        credit: 0,
      };
      byId.set(row.txnId, t);
    }
    t.lines.push(row);
    t.debit += row.debit;
    t.credit += row.credit;
    // Earliest date wins if a file ever disagrees; keeps JEs deterministic.
    if (row.date < t.date) t.date = row.date;
  }

  const transactions = [];
  const unbalanced = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (const t of byId.values()) {
    t.imbalance = round2(t.debit - t.credit);
    t.balanced = Math.abs(t.imbalance) < 0.005;
    t.description = buildDescription(t);
    t.property = (t.lines.find(l => l.property) || {}).property || "";
    totalDebit += t.debit;
    totalCredit += t.credit;
    transactions.push(t);
    if (!t.balanced) unbalanced.push(t);
  }

  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    transactions,
    unbalanced,
    totals: {
      entries: transactions.length,
      lines: rows.length,
      debit: round2(totalDebit),
      credit: round2(totalCredit),
      difference: round2(totalDebit - totalCredit),
      balancedEntries: transactions.length - unbalanced.length,
      unbalancedEntries: unbalanced.length,
      unbalancedNet: round2(unbalanced.reduce((s, t) => s + t.imbalance, 0)),
      dateFrom: transactions.length ? transactions[0].date : "",
      dateTo: transactions.length ? transactions[transactions.length - 1].date : "",
    },
  };
}

// "Journal Entry #113 Rent for the month of January 2023". Falls back
// through the fields QBO actually populates: Description covers 93% of
// rows, Name 60%, Num 33%.
function buildDescription(t) {
  const first = t.lines[0] || {};
  const detail = first.description || first.name || first.memo || "";
  const parts = [t.txnType, t.num ? `#${t.num}` : "", detail].filter(Boolean);
  const s = parts.join(" ").replace(/\s+/g, " ").trim();
  return (s || "QuickBooks import").slice(0, 300);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---- inventories for the mapping UI --------------------------------

// One entry per distinct QB account, with the totals the mapping step
// shows so the user can sanity-check before committing.
export function buildAccountInventory(rows) {
  const map = new Map();
  for (const row of rows) {
    let a = map.get(row.accountPath);
    if (!a) {
      a = {
        path: row.accountPath,
        parent: row.accountPath.includes(":") ? row.accountPath.split(":")[0] : "",
        leaf: row.accountPath.split(":").pop(),
        type: row.accountType,
        lineCount: 0,
        debit: 0,
        credit: 0,
        sourceFiles: new Set(),
      };
      map.set(row.accountPath, a);
    }
    a.lineCount++;
    a.debit += row.debit;
    a.credit += row.credit;
    a.sourceFiles.add(row.sourceFile);
  }
  return [...map.values()]
    .map(a => ({
      ...a,
      debit: round2(a.debit),
      credit: round2(a.credit),
      net: round2(a.debit - a.credit),
      sourceFiles: [...a.sourceFiles],
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
}

export function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/^old\s*-\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Many QB "asset accounts" are really per-tenant receivables — the
// account is literally named after the customer. Detect that so those
// become AR sub-accounts (acct_accounts.tenant_id) instead of ordinary
// assets.
//
// EXACT normalized match only, deliberately. A substring matcher was
// tried against the real data and produced false positives (it claimed
// "Housing Rent Receivable" was a tenant), so anything looser is offered
// to the user as a suggestion to confirm, never applied silently.
export function suggestTenantAR(accountPath, customers) {
  if (!accountPath || accountPath.includes(":")) return null;
  const target = normalizeName(accountPath);
  if (!target) return null;
  for (const c of customers) {
    if (normalizeName(c) === target) return { customer: c, confidence: "exact" };
  }
  return null;
}

// Distinct Property / Customer / Vendor values, for the mapping steps.
export function buildEntityInventory(rows) {
  const properties = new Map();
  const customers = new Map();
  const vendors = new Map();
  const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const row of rows) {
    bump(properties, row.property);
    bump(customers, row.customer);
    bump(vendors, row.vendor);
  }
  const toList = m => [...m.entries()]
    .map(([name, lineCount]) => ({ name, lineCount }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { properties: toList(properties), customers: toList(customers), vendors: toList(vendors) };
}

// Roll the parsed lines into a by-type trial balance — the number the
// user checks before committing, and the one the post-import
// verification asserts against.
export function buildTrialBalance(rows) {
  const byType = new Map();
  for (const row of rows) {
    let t = byType.get(row.accountType);
    if (!t) { t = { type: row.accountType, accounts: new Set(), lines: 0, debit: 0, credit: 0 }; byType.set(row.accountType, t); }
    t.accounts.add(row.accountPath);
    t.lines++;
    t.debit += row.debit;
    t.credit += row.credit;
  }
  const order = ["Asset", "Liability", "Equity", "Revenue", "Cost of Goods Sold", "Expense", "Other Income", "Other Expense"];
  const list = [...byType.values()]
    .map(t => ({ type: t.type, accounts: t.accounts.size, lines: t.lines, debit: round2(t.debit), credit: round2(t.credit), net: round2(t.debit - t.credit) }))
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const debit = round2(list.reduce((s, t) => s + t.debit, 0));
  const credit = round2(list.reduce((s, t) => s + t.credit, 0));
  return { byType: list, debit, credit, difference: round2(debit - credit) };
}
