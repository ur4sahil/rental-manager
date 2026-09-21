// Accounting computation: balances, report data, formatting, validation.
//
// Extracted from Accounting.js, which was 5,446 lines and holds 41 of the
// app's 62 tables. None of this is React -- it is arithmetic over journal
// entries -- so it does not belong in a component file, and keeping it
// there is part of why that file became the place everything lands.
//
// Every function here is pure: same inputs, same output, no Supabase and
// no component state. That is what makes report figures testable without
// a browser.
import { safeNum, parseLocalDate, formatLocalDate } from "./helpers";

// --- Accounting Utility Functions ---
export const DEFAULT_ACCOUNT_TYPES = ["Asset","Liability","Equity","Revenue","Cost of Goods Sold","Expense","Other Income","Other Expense"];
export const DEFAULT_ACCOUNT_SUBTYPES = {
  Asset: ["Bank","Accounts Receivable","Other Current Asset","Fixed Asset","Other Asset"],
  Liability: ["Accounts Payable","Credit Card","Other Current Liability","Long Term Liability"],
  Equity: ["Owners Equity","Retained Earnings","Common Stock"],
  Revenue: ["Rental Income","Other Primary Income","Service Income"],
  "Cost of Goods Sold": ["Cost of Goods Sold","Supplies & Materials"],
  Expense: ["Advertising & Marketing","Auto","Bank Charges","Depreciation","Insurance","Maintenance & Repairs","Meals & Entertainment","Office Supplies","Professional Fees","Property Tax","Rent & Lease","Utilities","Wages & Salaries","Other Expense"],
  "Other Income": ["Interest Earned","Late Fees","Other Miscellaneous Income"],
  "Other Expense": ["Depreciation","Other Miscellaneous Expense"],
};

// ---------------------------------------------------------------------------
// SUB-LEDGER ORDERING
//
// Accounts are fetched .order("code"), and a sub-account's code is assigned
// sequentially when it is created -- getOrCreateTenantAR takes the highest
// 1100-* and adds one. So the sub-ledger under a parent came out in the order
// the tenants happened to be created, which is not alphabetical and reads as
// unsorted. It LOOKED sorted at the top of Sigma's balance sheet only because
// that first run of tenants arrived in one alphabetical import; every tenant
// added since is appended wherever creation order put them.
//
// Parents stay in CODE order -- 1000 Checking before 1100 AR before 2100
// Deposits is the accounting convention, and the reports build their sections
// around it. Only the sub-accounts beneath each parent are alphabetised.
//
// A sub-account is identified the same way the rest of the app identifies one:
// a parent_id, or a dash in the code ("1100-017"). The part before the dash is
// the parent's code, which is what keeps each sub-ledger with its own parent
// instead of merging them all into one alphabetical run.
const baseCode = a => {
  const code = String(a?.code || "");
  const dash = code.indexOf("-");
  const base = dash > 0 ? code.slice(0, dash) : code;
  // No code at all sorts LAST, matching Postgres's NULLS LAST under
  // .order("code") -- so this does not hoist unnumbered accounts up the report.
  return base || "\uffff";
};
const isSubAccount = a => !!a?.parent_id || String(a?.code || "").includes("-");

// Case-insensitive and digit-aware, so "amanda mathews" files with "Amanda
// Mathews" and "(2508 ...)" comes before "(11455 ...)" rather than after it.
const byName = (a, b) =>
  String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { sensitivity: "base", numeric: true });

export const sortAccountsForReport = (list) => [...(list || [])].sort((a, b) => {
  const c = baseCode(a).localeCompare(baseCode(b), undefined, { numeric: true });
  if (c !== 0) return c;
  // Parent above its own sub-ledger.
  const sa = isSubAccount(a) ? 1 : 0, sb = isSubAccount(b) ? 1 : 0;
  if (sa !== sb) return sa - sb;
  return byName(a, b);
});

// Build dynamic types/subtypes from existing accounts + defaults
export const getAccountTypes = (accounts) => {
  const types = new Set(DEFAULT_ACCOUNT_TYPES);
  (accounts || []).forEach(a => { if (a.type) types.add(a.type); });
  return [...types];
};
export const getAccountSubtypes = (accounts, type) => {
  const subs = new Set(DEFAULT_ACCOUNT_SUBTYPES[type] || []);
  (accounts || []).filter(a => a.type === type && a.subtype).forEach(a => subs.add(a.subtype));
  return [...subs];
};
export const ACCOUNT_TYPES = DEFAULT_ACCOUNT_TYPES; // kept for backward compat in non-dynamic contexts
export const ACCOUNT_SUBTYPES = DEFAULT_ACCOUNT_SUBTYPES;
export const DEBIT_NORMAL = ["Asset","Cost of Goods Sold","Expense","Other Expense"];
export const acctFmt = (amount, showSign = false) => {
  const abs = Math.abs(amount);
  const str = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(abs);
  if (showSign && amount < 0) return `(${str})`;
  if (amount < 0) return `-${str}`;
  return str;
};
export const acctFmtDate = (d) => { if (!d) return ""; const [y,m,dd] = d.split("-"); return `${m}/${dd}/${y}`; };
export const acctToday = () => formatLocalDate(new Date());
export const getNormalBalance = (type) => DEBIT_NORMAL.includes(type) ? "debit" : "credit";

// Build a single-pass index of account balances from journal lines — O(n) instead of O(accounts × lines)
export const buildBalanceIndex = (journalEntries, filterFn = null) => {
  const index = {};
  const classIndex = {};
  for (const je of journalEntries) {
  if (je.status !== "posted") continue;
  if (filterFn && !filterFn(je)) continue;
  for (const l of (je.lines || [])) {
  const aid = l.account_id;
  if (!index[aid]) index[aid] = { debit: 0, credit: 0 };
  index[aid].debit += safeNum(l.debit);
  index[aid].credit += safeNum(l.credit);
  if (l.class_id) {
  const ck = aid + "_" + l.class_id;
  if (!classIndex[ck]) classIndex[ck] = { debit: 0, credit: 0 };
  classIndex[ck].debit += safeNum(l.debit);
  classIndex[ck].credit += safeNum(l.credit);
  }
  }
  }
  return { index, classIndex };
};

export const balanceFromIndex = (idx, accountId, accountType) => {
  const entry = idx[accountId];
  if (!entry) return 0;
  const nb = getNormalBalance(accountType);
  return nb === "debit" ? entry.debit - entry.credit : entry.credit - entry.debit;
};

export const calcAccountBalance = (accountId, journalEntries, account) => {
  const { index } = buildBalanceIndex(journalEntries);
  return balanceFromIndex(index, accountId, account.type);
};

export const calcAllBalances = (accounts, journalEntries) => {
  const { index } = buildBalanceIndex(journalEntries);
  return accounts.map(a => ({ ...a, computedBalance: balanceFromIndex(index, a.id, a.type) }));
};

// preIndex, when given, is exactly what buildBalanceIndex(...).index would
// have returned for this period -- { [accountId]: { debit, credit } } -- but
// summed by the DATABASE instead of over every journal line in the browser.
// The caller is responsible for having applied the class filter to it, which
// is why the classId branch below also honours it.
//
// Optional and defaulted, so every existing call site keeps the old
// behaviour untouched. tests/report-parity.test.js asserts the two paths
// produce identical figures on real data.
export const getPLData = (accounts, journalEntries, startDate, endDate, classId = null, includeZeros = false, preIndex = null) => {
  const revTypes = ["Revenue","Other Income"];
  const expTypes = ["Expense","Cost of Goods Sold","Other Expense"];
  if (classId) {
  // Class-filtered P&L: rebuild index from scratch using only lines matching the class
  // This correctly handles JEs where some lines have the class and others don't
  const filteredIndex = {};
  for (const je of journalEntries) {
  if (je.status !== "posted" || je.date < startDate || je.date > endDate) continue;
  for (const l of (je.lines || [])) {
  if (l.class_id !== classId) continue; // Only include lines for this class
  const aid = l.account_id;
  if (!filteredIndex[aid]) filteredIndex[aid] = { debit: 0, credit: 0 };
  filteredIndex[aid].debit += safeNum(l.debit);
  filteredIndex[aid].credit += safeNum(l.credit);
  }
  }
  const getBalance = (aid, atype) => balanceFromIndex(preIndex || filteredIndex, aid, atype);
  const revenue = sortAccountsForReport(accounts.filter(a => revTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => includeZeros || a.amount !== 0));
  const expenses = sortAccountsForReport(accounts.filter(a => expTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => includeZeros || a.amount !== 0));
  const totalRevenue = revenue.reduce((s, a) => s + a.amount, 0);
  const totalExpenses = expenses.reduce((s, a) => s + a.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
  }
  const { index } = preIndex ? { index: preIndex } : buildBalanceIndex(journalEntries, je => je.date >= startDate && je.date <= endDate);
  const getBalance = (aid, atype) => balanceFromIndex(index, aid, atype);
  const revenue = sortAccountsForReport(accounts.filter(a => revTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => includeZeros || a.amount !== 0));
  const expenses = sortAccountsForReport(accounts.filter(a => expTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => includeZeros || a.amount !== 0));
  const totalRevenue = revenue.reduce((s, a) => s + a.amount, 0);
  const totalExpenses = expenses.reduce((s, a) => s + a.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
};

// preIndex: same contract as getPLData, for the as-of range (everything up
// to and including asOfDate).
export const getBalanceSheetData = (accounts, journalEntries, asOfDate, preIndex = null) => {
  const filtered = preIndex ? [] : journalEntries.filter(je => je.status === "posted" && je.date <= asOfDate);
  const { index } = preIndex ? { index: preIndex } : buildBalanceIndex(filtered);
  const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
  // Include an inactive account when it still carries a balance. Its offsetting
  // activity is always counted in Net Income (below), so dropping it from the
  // Asset/Liability/Equity totals is what made the report read "Out of Balance"
  // even though the books balanced. A deactivated account should be at $0 (a DB
  // trigger now enforces that on write), but showing any stray balance here
  // keeps the statement self-consistent instead of silently unbalanced.
  const bsFilter = (type) => (a) => a.type === type && (a.is_active || Math.abs(balanceFromIndex(index, a.id, a.type)) > 0.005);
  const assets = sortAccountsForReport(accounts.filter(bsFilter("Asset")).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) })));
  const liabilities = sortAccountsForReport(accounts.filter(bsFilter("Liability")).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) })));
  const equity = sortAccountsForReport(accounts.filter(bsFilter("Equity")).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) })));
  let netIncome = 0;
  for (const [aid, entry] of Object.entries(index)) {
  const acct = acctMap[aid]; if (!acct) continue;
  if (["Revenue","Other Income"].includes(acct.type)) netIncome += entry.credit - entry.debit;
  if (["Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) netIncome -= entry.debit - entry.credit;
  }

  // Build AR sub-ledger and aging using ALL AR-class accounts. The
  // app uses two patterns:
  //   • One bare "Accounts Receivable" account (legacy)
  //   • Per-tenant sub-accounts named "AR - <Tenant Name> (<property>)"
  //     created by getOrCreateTenantAR with .tenant_id set
  // The previous filter matched only the bare-name account, so every
  // per-tenant AR posting (the bulk of real activity) was invisible
  // to the AR Aging report and fell through to "Unassigned" via the
  // description-regex fallback.
  const arAccounts = accounts.filter(a =>
    a.name === "Accounts Receivable" ||
    a.name?.startsWith("AR - ") ||
    (a.code || "").startsWith("1100")
  );
  const arAccountIds = new Set(arAccounts.map(a => a.id));
  // Per-account tenant attribution. Per-tenant AR sub-accounts are
  // named "AR - <Tenant Name> (<property>)" — parsing the name avoids
  // taking a dependency on the `tenants` collection (not in this
  // function's scope) while still resolving every per-tenant account.
  const acctIdToTenantName = new Map();
  for (const a of arAccounts) {
    if (a.name?.startsWith("AR - ")) {
      const m = a.name.match(/^AR - (.+?)(?:\s*\(|$)/);
      if (m) acctIdToTenantName.set(a.id, m[1].trim());
    }
  }

  // Description-regex fallback for the bare "Accounts Receivable"
  // account, which doesn't carry a tenant_id. Tries the live
  // patterns we see in real data: "Monthly rent — Tenant — …",
  // "Bad debt write-off — Tenant", "Security deposit — Tenant",
  // "First month rent — Tenant", "Prorated rent (…) — Tenant — …".
  const tenantFromDesc = (description, memo) => {
    const desc = description || memo || "";
    // Look for "<verb-or-phrase> — <Tenant> — <maybe property>"
    const m = desc.match(/—\s*([A-Z][^—]*?)(?:\s*—|$)/);
    if (m) return m[1].trim();
    return null;
  };

  const arSubLedger = {};
  filtered.forEach(je => {
  (je.lines || []).filter(l => arAccountIds.has(l.account_id)).forEach(l => {
  let tenantKey = acctIdToTenantName.get(l.account_id) || tenantFromDesc(je.description, l.memo) || "Unassigned";
  if (!arSubLedger[tenantKey]) arSubLedger[tenantKey] = { debits: 0, credits: 0 };
  arSubLedger[tenantKey].debits += safeNum(l.debit);
  arSubLedger[tenantKey].credits += safeNum(l.credit);
  });
  });
  const arByTenant = Object.entries(arSubLedger).map(([tenant, bal]) => ({
  tenant, balance: bal.debits - bal.credits
  })).filter(t => Math.abs(t.balance) > 0.01).sort((a, b) => b.balance - a.balance);

  // AR Aging: bucket by how old the charges are
  const today = new Date();
  const arAging = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
  const arAgingByTenant = {};
  filtered.forEach(je => {
  (je.lines || []).filter(l => arAccountIds.has(l.account_id) && (safeNum(l.debit) > 0 || safeNum(l.credit) > 0)).forEach(l => {
  const jeDate = parseLocalDate(je.date);
  const daysDiff = Math.floor((today - jeDate) / 86400000);
  // Net amount: debits increase AR, credits decrease AR
  const amount = safeNum(l.debit) - safeNum(l.credit);
  const bucket = daysDiff < 30 ? "current" : daysDiff < 60 ? "days30" : daysDiff < 90 ? "days60" : daysDiff < 120 ? "days90" : "over90";
  arAging[bucket] += amount;

  // Per-tenant aging — use account_id → tenant_id mapping first;
  // fall back to description regex for the legacy bare AR account.
  const tenantKey = acctIdToTenantName.get(l.account_id) || tenantFromDesc(je.description, l.memo) || "Unassigned";
  if (!arAgingByTenant[tenantKey]) arAgingByTenant[tenantKey] = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0, total: 0 };
  arAgingByTenant[tenantKey][bucket] += amount;
  arAgingByTenant[tenantKey].total += amount;
  });
  });

  // Normalize arAgingByTenant to an array — every consumer (the AR
  // Aging Summary report at line 2616, getCollectionsReport at 1573,
  // and the AR aging Excel export at 2123) calls .filter() / .map() on
  // it. A bare object trips ".filter is not a function" → ErrorBoundary
  // (PM-8009) when the user clicks "AR Aging Summary".
  const arAgingByTenantArr = Object.entries(arAgingByTenant).map(([tenant, agg]) => ({ tenant, ...agg }));
  return { assets, liabilities, equity, totalAssets: assets.reduce((s,a) => s + a.amount, 0), totalLiabilities: liabilities.reduce((s,a) => s + a.amount, 0), totalEquity: equity.reduce((s,a) => s + a.amount, 0) + netIncome, netIncome, arByTenant, arAging, arAgingByTenant: arAgingByTenantArr };
};

// preIndex: same contract as getPLData, for everything up to endDate.
export const getTrialBalance = (accounts, journalEntries, endDate, preIndex = null) => {
  const { index } = preIndex ? { index: preIndex } : buildBalanceIndex(journalEntries, je => je.date <= endDate);
  return sortAccountsForReport(accounts.filter(a => a.is_active)).map(a => {
  const entry = index[a.id];
  const net = entry ? entry.debit - entry.credit : 0;
  return { ...a, debitBalance: net > 0 ? net : 0, creditBalance: net < 0 ? Math.abs(net) : 0 };
  // Balances are running float sums, so an account that nets to exactly zero
  // in the DB lands on ~1e-10 in JS and survives an exact "!== 0" test — it
  // then renders as a spurious $0.00 row. Use the same half-cent tolerance
  // the rest of this file uses (see validateJE / opening balances).
  }).filter(a => a.debitBalance >= 0.005 || a.creditBalance >= 0.005);
};

export const getGeneralLedger = (accountId, accounts, journalEntries) => {
  const account = accounts.find(a => a.id === accountId);
  if (!account) return [];
  const nb = getNormalBalance(account.type);
  let running = 0;
  const lines = [];
  journalEntries.filter(je => je.status === "posted").sort((a,b) => a.date.localeCompare(b.date)).forEach(je => {
  (je.lines || []).filter(l => l.account_id === accountId).forEach(l => {
  running += nb === "debit" ? safeNum(l.debit) - safeNum(l.credit) : safeNum(l.credit) - safeNum(l.debit);
  lines.push({ date: je.date, jeId: je.id, jeNumber: je.number || "", description: je.description, reference: je.reference, memo: l.memo, debit: safeNum(l.debit), credit: safeNum(l.credit), balance: running });
  });
  });
  return lines;
};

export const getClassReport = (accounts, journalEntries, classes, startDate, endDate) => {
  const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
  const classData = {};
  for (const je of journalEntries) {
  if (je.status !== "posted" || je.date < startDate || je.date > endDate) continue;
  for (const l of (je.lines || [])) {

  if (!l.class_id) continue;

  if (!classData[l.class_id]) classData[l.class_id] = { revenue: 0, expenses: 0 };
  const acct = acctMap[l.account_id]; if (!acct) continue;

  if (["Revenue","Other Income"].includes(acct.type)) classData[l.class_id].revenue += safeNum(l.credit) - safeNum(l.debit);
  if (["Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) classData[l.class_id].expenses += safeNum(l.debit) - safeNum(l.credit);
  }
  }
  return classes.map(cls => {
  const d = classData[cls.id] || { revenue: 0, expenses: 0 };
  return { ...cls, revenue: d.revenue, expenses: d.expenses, netIncome: d.revenue - d.expenses };
  });
};

export const validateJE = (lines) => {
  const td = lines.reduce((s,l) => s + safeNum(l.debit), 0);
  const tc = lines.reduce((s,l) => s + safeNum(l.credit), 0);
  return { isValid: Math.abs(td - tc) < 0.005, totalDebit: td, totalCredit: tc, difference: Math.abs(td - tc) };
};

export const nextAccountCode = (accounts, type) => {
  const ranges = { Asset:{s:1000,e:1999}, Liability:{s:2000,e:2999}, Equity:{s:3000,e:3999}, Revenue:{s:4000,e:4999}, "Cost of Goods Sold":{s:5000,e:5099}, Expense:{s:5000,e:6999}, "Other Income":{s:7000,e:7999}, "Other Expense":{s:8000,e:8999} };
  const r = ranges[type] || {s:9000,e:9999};
  const existing = accounts.map(a => parseInt(a.code || "0")).filter(n => !isNaN(n) && n >= r.s && n <= r.e);
  return String((existing.length > 0 ? Math.max(...existing) : r.s - 10) + 10);
};
// Backward compat alias
export const nextAccountId = nextAccountCode;

export const getPeriodDates = (period) => {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  switch(period) {
  case "This Month": return { start: `${y}-${String(m+1).padStart(2,"0")}-01`, end: formatLocalDate(new Date(y,m+1,0)) };
  case "Last Month": { const lm = m === 0 ? 11 : m - 1; const ly = m === 0 ? y - 1 : y; return { start: `${ly}-${String(lm+1).padStart(2,"0")}-01`, end: formatLocalDate(new Date(ly,lm+1,0)) }; }
  case "This Quarter": { const q = Math.floor(m/3); return { start: `${y}-${String(q*3+1).padStart(2,"0")}-01`, end: formatLocalDate(new Date(y,q*3+3,0)) }; }
  case "This Year": return { start: `${y}-01-01`, end: `${y}-12-31` };
  case "Last Year": return { start: `${y-1}-01-01`, end: `${y-1}-12-31` };
  default: return { start: `${y}-01-01`, end: `${y}-12-31` };
  }
};

export const PERIODS = ["This Month","Last Month","This Quarter","This Year","Last Year","Custom"];
