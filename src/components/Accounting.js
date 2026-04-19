import React, { useState, useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import ExcelJS from "exceljs";
import { supabase } from "../supabase";
import { Input, Textarea, Select, Btn, AccountPicker } from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, CLASS_COLORS, pickColor, formatCurrency, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { safeLedgerInsert, checkPeriodLock, autoPostRecurringEntries, getPropertyClassId, resolveAccountId, getOrCreateTenantAR } from "../utils/accounting";
import { Spinner, PropertySelect } from "./shared";
import { BankTransactions } from "./Banking";

// ============ RECURRING JOURNAL ENTRIES ============
export function RecurringJournalEntries({ companyId, addNotification, userProfile }) {
  const [entries, setEntries] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);
  const [form, setForm] = useState({
  description: "", frequency: "monthly", day_of_month: 1, amount: "",
  tenant_name: "", property: "", debit_account_id: "1200", debit_account_name: "Accounts Receivable",
  credit_account_id: "4000", credit_account_name: "Rental Income",
  late_fee_enabled: true, grace_period_days: companySettings.late_fee_grace_days || 5, late_fee_amount: companySettings.late_fee_amount || 50,
  });

  useEffect(() => { fetchEntries(); fetchTenants(); }, [companyId]);
  async function fetchTenants() {
  const { data } = await supabase.from("tenants").select("id, name, property, rent").eq("company_id", companyId).is("archived_at", null).order("name");
  setTenants(data || []);
  }

  async function fetchEntries() {
  setLoading(true);
  const { data } = await supabase.from("recurring_journal_entries").select("*")
  .eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }).limit(200);
  setEntries(data || []);
  setLoading(false);
  }

  async function saveEntry() {
  if (!form.description.trim() || !form.amount) { showToast("Description and amount are required.", "error"); return; }
  const payload = {
  company_id: companyId,
  description: form.description, frequency: form.frequency,
  day_of_month: Number(form.day_of_month) || 1, amount: Number(form.amount),
  tenant_name: form.tenant_name, property: form.property,
  debit_account_id: form.debit_account_id, debit_account_name: form.debit_account_name,
  credit_account_id: form.credit_account_id, credit_account_name: form.credit_account_name,
  status: "active", late_fee_enabled: form.late_fee_enabled,
  grace_period_days: Number(form.grace_period_days) || 5,
  late_fee_amount: Number(form.late_fee_amount) || 0,
  next_post_date: new Date(new Date().getFullYear(), new Date().getMonth() + 1, Number(form.day_of_month) || 1).toISOString().split("T")[0],
  created_by: userProfile?.email || "",
  };
  if (editingEntry) {
  const { error } = await supabase.from("recurring_journal_entries").update(payload).eq("id", editingEntry.id).eq("company_id", companyId);
  if (error) { pmError("PM-4007", { raw: error, context: "updating recurring journal entry" }); return; }
  addNotification("✏️", "Updated recurring entry: " + form.description);
  } else {
  const { error } = await supabase.from("recurring_journal_entries").insert([payload]);
  if (error) { pmError("PM-4008", { raw: error, context: "creating recurring journal entry" }); return; }
  addNotification("🔄", "Created recurring entry: " + form.description);
  }
  setShowForm(false); setEditingEntry(null);
  setForm({ description: "", frequency: "monthly", day_of_month: 1, amount: "", tenant_name: "", property: "", debit_account_id: "1200", debit_account_name: "Accounts Receivable", credit_account_id: "4000", credit_account_name: "Rental Income", late_fee_enabled: true, grace_period_days: companySettings.late_fee_grace_days || 5, late_fee_amount: companySettings.late_fee_amount || 50 });
  fetchEntries();
  }

  async function toggleStatus(entry) {
  const newStatus = entry.status === "active" ? "paused" : "active";
  const { error } = await supabase.from("recurring_journal_entries").update({ status: newStatus }).eq("id", entry.id).eq("company_id", companyId);
  if (error) { pmError("PM-4009", { raw: error, context: "toggling recurring entry status" }); return; }
  addNotification(newStatus === "active" ? "▶️" : "⏸️", (newStatus === "active" ? "Resumed" : "Paused") + ": " + entry.description);
  fetchEntries();
  }

  async function deleteEntry(entry) {
  if (!await showConfirm({ message: "Delete this recurring entry? This cannot be undone.", variant: "danger", confirmText: "Delete" })) return;
  const { error } = await supabase.from("recurring_journal_entries").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", entry.id).eq("company_id", companyId);
  if (error) { pmError("PM-4010", { raw: error, context: "deleting recurring journal entry" }); return; }
  addNotification("🗑️", "Deleted: " + entry.description);
  fetchEntries();
  }

  async function runNow() {
  if (!await showConfirm({ message: "Post all active recurring entries for this month now?" })) return;
  const result = await autoPostRecurringEntries(companyId);
  if (result?.posted > 0) { addNotification("⚡", "Posted " + result.posted + " entry(ies)"); showToast("Posted " + result.posted + " recurring entry(ies)", "success"); }
  else showToast("No new entries to post this period", "info");
  fetchEntries();
  }

  if (loading) return <Spinner />;

  const active = entries.filter(e => e.status === "active");
  const paused = entries.filter(e => e.status === "paused");

  return (
  <div>
  <div className="flex items-center justify-between mb-4">
  <div>
  <div className="text-sm text-subtle-500">{active.length} active · {paused.length} paused</div>
  </div>
  <div className="flex gap-2">
  <Btn variant="warning-fill" size="xs" onClick={runNow}>⚡ Post Now</Btn>
  <Btn onClick={() => { setEditingEntry(null); setForm({ description: "", frequency: "monthly", day_of_month: 1, amount: "", tenant_name: "", property: "", debit_account_id: "1200", debit_account_name: "Accounts Receivable", credit_account_id: "4000", credit_account_name: "Rental Income", late_fee_enabled: true, grace_period_days: companySettings.late_fee_grace_days || 5, late_fee_amount: companySettings.late_fee_amount || 50 }); setShowForm(true); }} variant="primary" size="xs">+ Add Entry</Btn>
  </div>
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-subtle-700 mb-3">{editingEntry ? "Edit Recurring Entry" : "New Recurring Entry"}</h3>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
  <div className="col-span-2"><label className="text-xs text-subtle-500 mb-1 block">Description *</label><Input value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Monthly rent — John Doe — 123 Main St" /></div>
  <div><label className="text-xs text-subtle-500 mb-1 block">Amount *</label><Input type="number" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} /></div>
  <div><label className="text-xs text-subtle-500 mb-1 block">Day of Month</label><Input type="number" min="1" max="28" value={form.day_of_month} onChange={e => setForm({...form, day_of_month: e.target.value})} /></div>
  <div><label className="text-xs text-subtle-500 mb-1 block">Tenant</label><Select value={form.tenant_name} onChange={e => { const t = tenants.find(x => x.name === e.target.value); setForm({...form, tenant_name: e.target.value, property: t?.property || form.property, amount: t?.rent ? String(t.rent) : form.amount }); }} ><option value="">Select tenant...</option>{tenants.map(t => <option key={t.id} value={t.name}>{t.name} — {t.property?.split(",")[0]}</option>)}</Select></div>
  <div><label className="text-xs text-subtle-500 mb-1 block">Property</label><PropertySelect value={form.property} onChange={v => setForm({...form, property: v})} companyId={companyId} /></div>
  <div><label className="text-xs text-subtle-500 mb-1 block">Debit Account</label><Input value={form.debit_account_name} onChange={e => setForm({...form, debit_account_name: e.target.value})} /></div>
  <div><label className="text-xs text-subtle-500 mb-1 block">Credit Account</label><Input value={form.credit_account_name} onChange={e => setForm({...form, credit_account_name: e.target.value})} /></div>
  <div className="col-span-2 bg-warn-50 rounded-lg p-3">
  <div className="flex items-center gap-2 mb-2">
  <input type="checkbox" checked={form.late_fee_enabled} onChange={e => setForm({...form, late_fee_enabled: e.target.checked})} />
  <span className="text-xs font-semibold text-warn-700">Enable Auto Late Fees</span>
  </div>
  {form.late_fee_enabled && (
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs text-subtle-500 mb-1 block">Grace Period (days)</label><Input type="number" value={form.grace_period_days} onChange={e => setForm({...form, grace_period_days: e.target.value})} /></div>
  <div><label className="text-xs text-subtle-500 mb-1 block">Late Fee ($)</label><Input type="number" value={form.late_fee_amount} onChange={e => setForm({...form, late_fee_amount: e.target.value})} /></div>
  </div>
  )}
  </div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveEntry}>{editingEntry ? "Update" : "Create"}</Btn>
  <Btn variant="slate" onClick={() => { setShowForm(false); setEditingEntry(null); }}>Cancel</Btn>
  </div>
  </div>
  )}

  {entries.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-subtle-100">
  <div className="text-4xl mb-3">🔄</div>
  <div className="text-subtle-500 font-medium">No recurring entries</div>
  <div className="text-xs text-subtle-400 mt-1">Recurring entries are created automatically when you add a tenant, or you can add them manually.</div>
  </div>
  ) : (
  <div className="space-y-2">
  {entries.map(e => (
  <div key={e.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (e.status === "paused" ? "opacity-60 border-subtle-200" : "border-subtle-100")}>
  <div className="flex items-center gap-4">
  <div className="flex-1">
  <div className="font-semibold text-subtle-800 text-sm">{e.description}</div>
  <div className="text-xs text-subtle-400 mt-0.5">
  {e.tenant_name && <span>{e.tenant_name} · </span>}
  {e.property && <span>{e.property} · </span>}
  Day {e.day_of_month} · {e.frequency}
  {e.late_fee_enabled && <span> · Late fee: ${safeNum(e.late_fee_amount)} after {e.grace_period_days}d</span>}
  </div>
  </div>
  <div className="text-lg font-bold text-subtle-800">${safeNum(e.amount).toLocaleString()}</div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (e.status === "active" ? "bg-positive-100 text-positive-700" : "bg-subtle-100 text-subtle-500")}>{e.status}</span>
  <div className="flex gap-1">
  <button onClick={() => toggleStatus(e)} className={"text-xs px-2 py-1 rounded-lg " + (e.status === "active" ? "text-warn-600 hover:bg-warn-50" : "text-positive-600 hover:bg-positive-50")}>{e.status === "active" ? "⏸ Pause" : "▶ Resume"}</button>
  <button onClick={() => { setEditingEntry(e); setForm({ description: e.description, frequency: e.frequency, day_of_month: e.day_of_month, amount: e.amount, tenant_name: e.tenant_name || "", property: e.property || "", debit_account_id: e.debit_account_id || "1200", debit_account_name: e.debit_account_name || "Accounts Receivable", credit_account_id: e.credit_account_id || "4000", credit_account_name: e.credit_account_name || "Rental Income", late_fee_enabled: e.late_fee_enabled !== false, grace_period_days: e.grace_period_days || 5, late_fee_amount: e.late_fee_amount || 50 }); setShowForm(true); }} className="text-xs text-brand-600 px-2 py-1 rounded-lg hover:bg-brand-50">Edit</button>
  <button onClick={() => deleteEntry(e)} className="text-xs text-danger-500 px-2 py-1 rounded-lg hover:bg-danger-50">Delete</button>
  </div>
  </div>
  {e.next_post_date && <div className="text-xs text-subtle-400 mt-2">Next post: {e.next_post_date}</div>}
  </div>
  ))}
  </div>
  )}
  </div>
  );
}

// ============ ACCOUNTING (QuickBooks-Style with Supabase) ============

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

export const getPLData = (accounts, journalEntries, startDate, endDate, classId = null) => {
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
  const getBalance = (aid, atype) => balanceFromIndex(filteredIndex, aid, atype);
  const revenue = accounts.filter(a => revTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => a.amount !== 0);
  const expenses = accounts.filter(a => expTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => a.amount !== 0);
  const totalRevenue = revenue.reduce((s, a) => s + a.amount, 0);
  const totalExpenses = expenses.reduce((s, a) => s + a.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
  }
  const { index } = buildBalanceIndex(journalEntries, je => je.date >= startDate && je.date <= endDate);
  const getBalance = (aid, atype) => balanceFromIndex(index, aid, atype);
  const revenue = accounts.filter(a => revTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => a.amount !== 0);
  const expenses = accounts.filter(a => expTypes.includes(a.type) && a.is_active).map(a => ({ ...a, amount: getBalance(a.id, a.type) })).filter(a => a.amount !== 0);
  const totalRevenue = revenue.reduce((s, a) => s + a.amount, 0);
  const totalExpenses = expenses.reduce((s, a) => s + a.amount, 0);
  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses };
};

export const getBalanceSheetData = (accounts, journalEntries, asOfDate) => {
  const filtered = journalEntries.filter(je => je.status === "posted" && je.date <= asOfDate);
  const { index } = buildBalanceIndex(filtered);
  const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
  const assets = accounts.filter(a => a.type === "Asset" && a.is_active).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) }));
  const liabilities = accounts.filter(a => a.type === "Liability" && a.is_active).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) }));
  const equity = accounts.filter(a => a.type === "Equity" && a.is_active).map(a => ({ ...a, amount: balanceFromIndex(index, a.id, a.type) }));
  let netIncome = 0;
  for (const [aid, entry] of Object.entries(index)) {
  const acct = acctMap[aid]; if (!acct) continue;
  if (["Revenue","Other Income"].includes(acct.type)) netIncome += entry.credit - entry.debit;
  if (["Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) netIncome -= entry.debit - entry.credit;
  }

  // Build AR sub-ledger and aging using dynamic AR account IDs
  const arAccountIds = new Set(accounts.filter(a => a.name === "Accounts Receivable").map(a => a.id));
  const arSubLedger = {};
  filtered.forEach(je => {
  (je.lines || []).filter(l => arAccountIds.has(l.account_id)).forEach(l => {
  // Extract tenant name from memo (format: "TenantName rent 2025-06" or "TenantName — PropertyAddr")
  const memo = l.memo || je.description || "";
  let tenantKey = "Unassigned";
  // Try to extract tenant from "Rent charge — TenantName — Property — Month"
  const descMatch = je.description ? je.description.match(/(?:Rent charge|Payment received|AR Settlement|Security deposit).*?—\s*([^—]+?)(?:\s*—|$)/) : null;
  // Try memo format "TenantName rent YYYY-MM"
  const memoMatch = memo.match(/^(.+?)\s+(?:rent|payment|deposit)/i);
  if (descMatch) tenantKey = descMatch[1].trim();
  else if (memoMatch) tenantKey = memoMatch[1].trim();
  else if (memo && memo !== "") tenantKey = memo.split(" ")[0] + " " + (memo.split(" ")[1] || "");

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

  // Per-tenant aging
  const memo = l.memo || je.description || "";
  const descMatch = je.description ? je.description.match(/(?:Rent charge|Payment|Late fee|Rent accrual).*?—\s*([^—]+?)(?:\s*—|$)/) : null;
  const memoMatch = memo.match(/^(.+?)\s+(?:rent|payment|AR|Late)/i);
  let tenantKey = descMatch ? descMatch[1].trim() : memoMatch ? memoMatch[1].trim() : "Unassigned";
  if (!arAgingByTenant[tenantKey]) arAgingByTenant[tenantKey] = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0, total: 0 };
  arAgingByTenant[tenantKey][bucket] += amount;
  arAgingByTenant[tenantKey].total += amount;
  });
  });

  return { assets, liabilities, equity, totalAssets: assets.reduce((s,a) => s + a.amount, 0), totalLiabilities: liabilities.reduce((s,a) => s + a.amount, 0), totalEquity: equity.reduce((s,a) => s + a.amount, 0) + netIncome, netIncome, arByTenant, arAging, arAgingByTenant };
};

export const getTrialBalance = (accounts, journalEntries, endDate) => {
  const { index } = buildBalanceIndex(journalEntries, je => je.date <= endDate);
  return accounts.filter(a => a.is_active).map(a => {
  const entry = index[a.id];
  const net = entry ? entry.debit - entry.credit : 0;
  return { ...a, debitBalance: net > 0 ? net : 0, creditBalance: net < 0 ? Math.abs(net) : 0 };
  }).filter(a => a.debitBalance !== 0 || a.creditBalance !== 0);
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

export const nextJENumber = (journalEntries) => {
  const nums = journalEntries.map(je => parseInt(je.number.replace("JE-",""),10)).filter(n => !isNaN(n));
  return `JE-${String((nums.length > 0 ? Math.max(...nums) : 0) + 1).padStart(4,"0")}`;
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

// ============ ACCOUNT LEDGER VIEW ============
// Full-screen drill-down showing every JE line for one or more accounts.
// Clickable from COA, P&L, Balance Sheet, Trial Balance, JE lines, Dashboard.
export function AccountLedgerView({ accountIds, accounts, journalEntries, title, onClose, onViewJE }) {
  const [period, setPeriod] = useState("This Year");
  const [customDates, setCustomDates] = useState({ start: `${new Date().getFullYear()}-01-01`, end: `${new Date().getFullYear()}-12-31` });
  const [propertyFilter, setPropertyFilter] = useState("");
  const { start, end } = period === "Custom" ? customDates : getPeriodDates(period);

  // Build ledger lines for all selected accounts
  const ids = Array.isArray(accountIds) ? accountIds : [accountIds];
  const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
  const acctNames = ids.map(id => acctMap[id]?.name || "Unknown").join(", ");
  const acctCodes = ids.map(id => acctMap[id]?.code || "").filter(Boolean).join(", ");

  // Determine normal balance direction for running total
  const primaryType = acctMap[ids[0]]?.type || "Asset";
  const nb = getNormalBalance(primaryType);

  let running = 0;
  const allLines = [];
  const sortedJEs = journalEntries.filter(je => je.status === "posted").sort((a, b) => a.date.localeCompare(b.date) || (a.id || "").localeCompare(b.id || ""));
  for (const je of sortedJEs) {
  if (je.date < start || je.date > end) continue;
  if (propertyFilter && je.property !== propertyFilter) continue;
  for (const l of (je.lines || [])) {
  if (!ids.includes(l.account_id)) continue;
  const dr = safeNum(l.debit);
  const cr = safeNum(l.credit);
  running += nb === "debit" ? dr - cr : cr - dr;
  allLines.push({ date: je.date, number: je.number, jeId: je.id, description: je.description, reference: je.reference, property: je.property, memo: l.memo, accountName: acctMap[l.account_id]?.name || "", debit: dr, credit: cr, balance: running });
  }
  }

  // Properties for filter dropdown
  const properties = [...new Set(journalEntries.filter(je => je.property).map(je => je.property))].sort();

  function exportCSV() {
  const rows = [["Date", "JE #", "Description", "Reference", "Property", "Memo", "Debit", "Credit", "Balance"]];
  allLines.forEach(l => rows.push([l.date, l.number, l.description, l.reference, l.property, l.memo, l.debit.toFixed(2), l.credit.toFixed(2), l.balance.toFixed(2)]));
  const csv = rows.map(r => r.map(c => '"' + String(c || "").replace(/"/g, '""') + '"').join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `ledger_${acctCodes || "combined"}_${start}_${end}.csv`; a.click();
  URL.revokeObjectURL(url);
  }

  return (
  <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[60] flex items-end sm:items-center justify-center sm:p-4">
  <div className="bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl w-full sm:max-w-5xl h-[95vh] sm:max-h-[90vh] flex flex-col">
  {/* Header */}
  <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-brand-50">
  <div className="min-w-0 flex-1">
  <h3 className="text-base sm:text-lg font-manrope font-bold text-neutral-800 truncate">{title || acctNames}</h3>
  {acctCodes && <p className="text-xs text-neutral-400">Account {acctCodes} · {allLines.length} entries</p>}
  </div>
  <div className="flex items-center gap-2 shrink-0 ml-2">
  <button onClick={exportCSV} className="text-xs bg-neutral-100 text-neutral-500 px-3 py-1.5 rounded-xl hover:bg-neutral-200 hidden sm:block">Export CSV</button>
  <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-xl text-neutral-400 hover:bg-neutral-100"><span className="material-icons-outlined text-lg">close</span></button>
  </div>
  </div>
  {/* Filters */}
  <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 px-4 sm:px-6 py-2 sm:py-3 border-b border-brand-50 bg-neutral-50/50 overflow-x-auto">
  {PERIODS.map(p => <button key={p} onClick={() => setPeriod(p)} className={`text-xs px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-xl border font-medium whitespace-nowrap ${period === p ? "bg-neutral-800 text-white border-neutral-800" : "bg-white text-neutral-400 border-brand-100"}`}>{p}</button>)}
  {period === "Custom" && <><Input type="date" value={customDates.start} onChange={e => setCustomDates(d => ({...d, start: e.target.value}))} className="text-xs w-auto" /><span className="text-xs text-neutral-400">to</span><Input type="date" value={customDates.end} onChange={e => setCustomDates(d => ({...d, end: e.target.value}))} className="text-xs w-auto" /></>}
  {properties.length > 1 && <Select filter value={propertyFilter} onChange={e => setPropertyFilter(e.target.value)} className="text-xs py-1.5 rounded-xl"><option value="">All Properties</option>{properties.map(p => <option key={p} value={p}>{p.split(",")[0]}</option>)}</Select>}
  </div>
  {/* Summary bar */}
  <div className="flex flex-wrap items-center gap-3 sm:gap-6 px-4 sm:px-6 py-2 border-b border-brand-50 text-xs text-neutral-500">
  <span>DR: <strong className="text-neutral-800 font-mono">{acctFmt(allLines.reduce((s, l) => s + l.debit, 0))}</strong></span>
  <span>CR: <strong className="text-neutral-800 font-mono">{acctFmt(allLines.reduce((s, l) => s + l.credit, 0))}</strong></span>
  <span>Bal: <strong className={`font-mono ${running >= 0 ? "text-neutral-800" : "text-danger-600"}`}>{acctFmt(running, true)}</strong></span>
  <button onClick={exportCSV} className="text-xs text-brand-600 hover:underline sm:hidden ml-auto">Export</button>
  </div>
  {/* Mobile: Card view */}
  <div className="flex-1 overflow-auto sm:hidden">
  {allLines.length === 0 && <div className="px-4 py-8 text-center text-neutral-400">No transactions found for this period</div>}
  {allLines.map((l, i) => (
  <div key={i} className="border-b border-neutral-100 px-4 py-3 cursor-pointer hover:bg-positive-50/40 transition-colors active:bg-positive-50" onClick={() => onViewJE && onViewJE(l.jeId)}>
  <div className="flex justify-between items-start mb-1">
  <div className="text-xs text-neutral-500">{l.date}</div>
  <div className={`font-mono text-sm font-semibold ${l.balance < 0 ? "text-danger-600" : "text-neutral-800"}`}>{acctFmt(l.balance, true)}</div>
  </div>
  <div className="text-sm text-neutral-700 mb-1 leading-tight">{l.description}</div>
  {l.memo && <div className="text-xs text-neutral-400 mb-1">{l.memo}</div>}
  <div className="flex items-center gap-3 text-xs">
  {l.debit > 0 && <span className="text-success-600">DR {acctFmt(l.debit)}</span>}
  {l.credit > 0 && <span className="text-danger-500">CR {acctFmt(l.credit)}</span>}
  {l.property && <span className="text-neutral-400">{l.property.split(",")[0]}</span>}
  <span className="text-positive-600 font-mono ml-auto">{l.number || "—"}</span>
  </div>
  </div>
  ))}
  </div>
  {/* Desktop: Table view */}
  <div className="flex-1 overflow-auto hidden sm:block">
  <table className="w-full text-sm">
  <thead className="bg-brand-50/30 text-xs text-neutral-400 uppercase sticky top-0">
  <tr>
  <th className="px-4 py-2.5 text-left">Date</th>
  <th className="px-3 py-2.5 text-left">JE #</th>
  <th className="px-3 py-2.5 text-left">Description</th>
  <th className="px-3 py-2.5 text-left">Ref</th>
  {ids.length > 1 && <th className="px-3 py-2.5 text-left">Account</th>}
  <th className="px-3 py-2.5 text-left">Property</th>
  <th className="px-3 py-2.5 text-right">Debit</th>
  <th className="px-3 py-2.5 text-right">Credit</th>
  <th className="px-3 py-2.5 text-right">Balance</th>
  </tr>
  </thead>
  <tbody>
  {allLines.map((l, i) => (
  <tr key={i} className="border-t border-neutral-100 hover:bg-positive-50/40 transition-colors cursor-pointer" onClick={() => onViewJE && onViewJE(l.jeId)}>
  <td className="px-4 py-2 text-xs text-neutral-500 whitespace-nowrap">{l.date}</td>
  <td className="px-3 py-2 text-xs text-positive-600 font-mono">{l.number || "—"}</td>
  <td className="px-3 py-2 text-neutral-700 text-xs max-w-xs truncate" title={l.description + (l.memo ? " | " + l.memo : "")}>{l.description}{l.memo && <span className="text-neutral-400 ml-1">({l.memo})</span>}</td>
  <td className="px-3 py-2 text-xs text-neutral-400 font-mono">{(() => { const r = l.reference || ""; if (r.startsWith("BANK-")) return "Bank Import"; if (r.startsWith("XFER-")) return "Bank Transfer"; return r || "—"; })()}</td>
  {ids.length > 1 && <td className="px-3 py-2 text-xs text-neutral-500">{l.accountName}</td>}
  <td className="px-3 py-2 text-xs text-neutral-400">{l.property?.split(",")[0] || "—"}</td>
  <td className="px-3 py-2 text-right font-mono text-xs">{l.debit > 0 ? acctFmt(l.debit) : ""}</td>
  <td className="px-3 py-2 text-right font-mono text-xs">{l.credit > 0 ? acctFmt(l.credit) : ""}</td>
  <td className={`px-3 py-2 text-right font-mono text-xs font-semibold ${l.balance < 0 ? "text-danger-600" : "text-neutral-800"}`}>{acctFmt(l.balance, true)}</td>
  </tr>
  ))}
  {allLines.length === 0 && <tr><td colSpan={ids.length > 1 ? 9 : 8} className="px-4 py-8 text-center text-neutral-400">No transactions found for this period</td></tr>}
  </tbody>
  </table>
  </div>
  </div>
  </div>
  );
}

// --- Accounting Sub-Components ---

export function AcctModal({ isOpen, onClose, title, children, size = "md" }) {
  useEffect(() => { const h = e => { if (e.key === "Escape") onClose(); }; if (isOpen) document.addEventListener("keydown", h); return () => document.removeEventListener("keydown", h); }, [isOpen, onClose]);
  if (!isOpen) return null;
  const sizes = { sm:"max-w-md", md:"max-w-xl", lg:"max-w-3xl", xl:"max-w-5xl" };
  return (
  <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background:"rgba(0,0,0,0.5)" }} onClick={e => e.target === e.currentTarget && onClose()}>
  <div className={`bg-white rounded-xl shadow-sm border border-neutral-200 w-full ${sizes[size]} flex flex-col`} style={{ maxHeight:"90vh" }}>
  <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 shrink-0">
  <h2 className="text-lg font-manrope font-bold text-neutral-900">{title}</h2>
  <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-xl text-neutral-400 hover:bg-brand-50/50 transition-colors"><span className="material-icons-outlined text-lg">close</span></button>
  </div>
  <div className="overflow-y-auto flex-1 px-6 py-4">{children}</div>
  </div>
  </div>
  );
}

export function AcctTypeBadge({ type }) {
  const map = { Asset:"bg-info-50 text-info-700", Liability:"bg-danger-50 text-danger-700", Equity:"bg-accent-50 text-accent-700", Revenue:"bg-success-50 text-success-700", Expense:"bg-notice-50 text-notice-700", "Cost of Goods Sold":"bg-notice-50 text-notice-700", "Other Income":"bg-success-50 text-success-700", "Other Expense":"bg-notice-50 text-notice-700" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[type] || "bg-neutral-100 text-neutral-700"}`}>{type}</span>;
}

export function AcctStatusBadge({ status }) {
  const map = { posted: "bg-success-50 text-success-700", draft: "bg-warn-50 text-warn-700", voided: "bg-danger-50 text-danger-700" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${map[status] || "bg-neutral-100 text-neutral-700"}`}>{status}</span>;
}

// --- Chart of Accounts Sub-Page ---
export function AcctChartOfAccounts({ accounts, journalEntries, onAdd, onUpdate, onToggle, onDelete, onOpenLedger }) {
  const [modal, setModal] = useState(null);
  const [filter, setFilter] = useState("All");
  const [showInactive, setShowInactive] = useState(false);
  const [form, setForm] = useState({ name:"", type:"Asset", subtype:"Bank", description:"", customType:"", customSubtype:"" });

  const dynamicTypes = getAccountTypes(accounts);
  const dynamicSubtypes = getAccountSubtypes(accounts, form.type === "__custom__" ? form.customType : form.type);

  const withBalances = calcAllBalances(accounts, journalEntries);
  const filtered = withBalances.filter(a => {
  if (!showInactive && !a.is_active) return false;
  if (filter !== "All" && a.type !== filter) return false;
  return true;
  });

  // Build hierarchy: group by type, then nest sub-accounts under parents
  const grouped = {};
  filtered.forEach(a => { if (!grouped[a.type]) grouped[a.type] = []; grouped[a.type].push(a); });
  // Sort accounts within each type: parents first (no dash in code), then sub-accounts
  Object.keys(grouped).forEach(type => {
  const parentAccts = grouped[type].filter(a => !a.parent_id && !(a.code || "").includes("-"));
  const subAccts = grouped[type].filter(a => a.parent_id || (a.code || "").includes("-"));
  // Build ordered list: parent followed by its sub-accounts
  const ordered = [];
  parentAccts.forEach(parent => {
  ordered.push(parent);
  subAccts.filter(s => s.parent_id === parent.id || (s.code || "").startsWith((parent.code || "") + "-")).forEach(sub => ordered.push({ ...sub, _isSubAccount: true }));
  });
  // Add any orphan sub-accounts not matched to a parent
  subAccts.filter(s => !ordered.find(o => o.id === s.id)).forEach(s => ordered.push({ ...s, _isSubAccount: true }));
  grouped[type] = ordered;
  });

  const openAdd = () => { setForm({ name:"", type:"Asset", subtype:"Bank", description:"", customType:"", customSubtype:"" }); setModal("add"); };
  const openEdit = (a) => { setForm({ name: a.name, type: a.type, subtype: a.subtype, description: a.description || "", customType:"", customSubtype:"" }); setModal(a); };

  const saveAccount = async () => {
  if (!form.name.trim()) return;
  const finalType = form.type === "__custom__" ? form.customType.trim() : form.type;
  const finalSubtype = form.subtype === "__custom__" ? form.customSubtype.trim() : form.subtype;
  if (!finalType) { showToast("Please enter an account type.", "error"); return; }
  if (modal === "add") {
  const newCode = nextAccountCode(accounts, finalType);
  await onAdd({ code: newCode, name: form.name, type: finalType, subtype: finalSubtype || "", description: form.description, balance: 0, is_active: true });
  } else {
  await onUpdate({ ...modal, name: form.name, type: finalType, subtype: finalSubtype || "", description: form.description });
  }
  setModal(null);
  };

  const allTypes = [...new Set([...dynamicTypes, ...Object.keys(grouped)])];
  const typeOrder = [...DEFAULT_ACCOUNT_TYPES, ...allTypes.filter(t => !DEFAULT_ACCOUNT_TYPES.includes(t))];

  return (
  <div className="space-y-4">
  <div className="flex items-center justify-between mb-4">
  <div>
  <h3 className="text-lg font-semibold text-neutral-900">Chart of Accounts</h3>
  <p className="text-sm text-neutral-400">Manage your account structure</p>
  </div>
  <div className="flex gap-2">
  <button onClick={() => setShowInactive(!showInactive)} className={`text-xs px-3 py-1.5 rounded-lg border ${showInactive ? "bg-brand-50 border-brand-200" : "border-brand-100 text-neutral-400"}`}>{showInactive ? "Hide Inactive" : "Show Inactive"}</button>
  <Btn variant="success-fill" size="sm" onClick={openAdd}>+ New Account</Btn>
  </div>
  </div>
  <div className="flex flex-wrap gap-2 mb-4">
  {["All", ...typeOrder.filter((t, i, a) => a.indexOf(t) === i)].map(t => (
  <button key={t} onClick={() => setFilter(t)} className={`text-xs px-3 py-1.5 rounded-lg border font-medium ${filter === t ? "bg-positive-600 text-white border-positive-600" : "bg-white text-neutral-500 border-neutral-200 hover:border-positive-300"}`}>{t}</button>
  ))}
  </div>
  {typeOrder.filter((t, i, a) => a.indexOf(t) === i).map(type => {
  const accts = grouped[type];
  if (!accts?.length) return null;
  return (
  <div key={type} className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-hidden mb-3">
  <div className="px-5 py-3 bg-neutral-50 flex items-center justify-between">
  <div className="flex items-center gap-2"><AcctTypeBadge type={type} /><span className="text-xs text-neutral-400">{accts.length} accounts</span></div>
  <span className="font-mono text-xs font-semibold text-neutral-500">{acctFmt(accts.filter(a=>a.is_active).reduce((s,a)=>s+a.computedBalance,0))}</span>
  </div>
  <table className="w-full text-sm">
  <thead className="text-xs text-neutral-500 uppercase tracking-wider bg-neutral-50 font-semibold"><tr><th className="px-5 py-3 text-left">Number</th><th className="px-5 py-3 text-left">Name</th><th className="px-5 py-3 text-left">Subtype</th><th className="px-5 py-3 text-right">Balance</th><th className="px-5 py-3 w-20">Actions</th></tr></thead>
  <tbody>
  {accts.map(a => (
  <tr key={a.id} className={`border-t border-neutral-100 hover:bg-positive-50/40 transition-colors cursor-pointer ${a._isSubAccount ? "bg-neutral-50/40" : ""}`} onClick={() => onOpenLedger && onOpenLedger([a.id], (a.code ? a.code + " " : "") + a.name)}>
  <td className={`py-3 font-mono text-xs text-neutral-400 ${a._isSubAccount ? "pl-8 pr-5" : "px-5"}`}>{a._isSubAccount ? "└ " : ""}{a.code || "—"}</td>
  <td className={`px-5 py-3 ${a._isSubAccount ? "text-sm text-neutral-600" : "font-medium"} ${!a.is_active ? "text-neutral-400 line-through" : a._isSubAccount ? "" : "text-neutral-800"}`}>{a.name}</td>
  <td className="px-5 py-3 text-xs text-neutral-400">{a.subtype || ""}</td>
  <td className={`px-5 py-3 text-right font-mono text-sm ${a.computedBalance < 0 ? "text-danger-600" : "text-neutral-800"}`}>{acctFmt(a.computedBalance, true)}</td>
  <td className="px-5 py-3 text-center flex items-center gap-2 justify-center">
  <button onClick={e => { e.stopPropagation(); openEdit(a); }} className="text-neutral-400 hover:text-brand-600 text-xs" title="Edit account"><span className="material-icons-outlined text-sm">edit</span></button>
  <button onClick={e => { e.stopPropagation(); onToggle(a.id, a.is_active); }} className="text-neutral-400 hover:text-neutral-700 text-xs" title={a.is_active ? "Deactivate" : "Activate"}>{a.is_active ? "🟢" : "⚪"}</button>
  {onDelete && a.computedBalance === 0 && <button onClick={e => { e.stopPropagation(); onDelete(a.id); }} className="text-neutral-300 hover:text-danger-600 text-xs" title="Delete account"><span className="material-icons-outlined text-sm">delete</span></button>}
  </td>
  </tr>
  ))}
  </tbody>
  </table>
  </div>
  );
  })}
  <AcctModal isOpen={!!modal} onClose={() => setModal(null)} title={modal === "add" ? "New Account" : "Edit Account"} size="md">
  <div className="space-y-3">
  <div><label className="text-xs font-medium text-neutral-500">Account Name *</label><Input value={form.name} onChange={e => setForm({...form, name:e.target.value})} className="mt-1" placeholder="e.g. Operating Checking" /></div>
  <div className="grid grid-cols-2 gap-3">
  <div>
  <label className="text-xs font-medium text-neutral-500">Type *</label>
  <Select value={form.type} onChange={e => { const v = e.target.value; setForm({...form, type: v, subtype: v === "__custom__" ? "" : (getAccountSubtypes(accounts, v)[0] || ""), customType: v === "__custom__" ? form.customType : "" }); }} className="mt-1">
  {dynamicTypes.map(t => <option key={t} value={t}>{t}</option>)}
  <option value="__custom__">+ Add Custom Type...</option>
  </Select>
  {form.type === "__custom__" && <Input value={form.customType} onChange={e => setForm({...form, customType: e.target.value})} className="mt-1 bg-brand-50" placeholder="Enter new account type" autoFocus />}
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-500">Subtype</label>
  <Select value={form.subtype} onChange={e => setForm({...form, subtype: e.target.value, customSubtype: e.target.value === "__custom__" ? form.customSubtype : ""})} className="mt-1">
  {(form.type === "__custom__" ? [] : dynamicSubtypes).map(s => <option key={s} value={s}>{s}</option>)}
  <option value="__custom__">+ Add Custom Subtype...</option>
  <option value="">None</option>
  </Select>
  {form.subtype === "__custom__" && <Input value={form.customSubtype} onChange={e => setForm({...form, customSubtype: e.target.value})} className="mt-1 bg-brand-50" placeholder="Enter new subtype" />}
  </div>
  </div>
  <div><label className="text-xs font-medium text-neutral-500">Description</label><Textarea value={form.description} onChange={e => setForm({...form, description:e.target.value})} className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm mt-1" rows={2} /></div>
  <div className="flex justify-end gap-2 pt-2">
  <Btn variant="slate" onClick={() => setModal(null)}>Cancel</Btn>
  <Btn variant="success-fill" onClick={saveAccount}>{modal === "add" ? "Create" : "Save"}</Btn>
  </div>
  </div>
  </AcctModal>
  </div>
  );
}

// --- Journal Entries Sub-Page ---
export function AcctJournalEntries({ accounts, journalEntries, classes, tenants = [], vendors = [], onAdd, onUpdate, onPost, onVoid, companyId, onOpenLedger, initialViewJEId, autoOpenAdd, showToast, onCloseJEDetail }) {
  const [modal, setModal] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [searchProperty, setSearchProperty] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [properties, setProperties] = useState([]);
  const [form, setForm] = useState({ date: acctToday(), description: "", reference: "", property: "", lines: [{ account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }, { account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"" }] });
  const [showNewAcct, setShowNewAcct] = useState(null); // line index that triggered it
  const [newAcctForm, setNewAcctForm] = useState({ code: "", name: "", type: "Expense" });

  useEffect(() => { if (!companyId) return; supabase.from("properties").select("address").eq("company_id", companyId).is("archived_at", null).then(r => setProperties((r.data || []).map(p => p.address))); }, [companyId]);

  // Auto-open a specific JE when navigating from ledger drill-down
  useEffect(() => {
  if (initialViewJEId && journalEntries.length > 0) {
  const je = journalEntries.find(j => j.id === initialViewJEId);
  if (je) setModal({ mode: "view", je });
  }
  }, [initialViewJEId, journalEntries.length]);

  // Auto-open "New JE" modal when navigated from Record Payment
  useEffect(() => { if (autoOpenAdd) openAdd(); }, [autoOpenAdd]);

  const filtered = [...journalEntries].sort((a,b) => b.date.localeCompare(a.date))
  .filter(je => filterStatus === "all" || je.status === filterStatus)
  .filter(je => !searchProperty || (je.property || "").toLowerCase().includes(searchProperty.toLowerCase()))
  .filter(je => !dateFrom || je.date >= dateFrom)
  .filter(je => !dateTo || je.date <= dateTo);
  const counts = { all: journalEntries.length, posted: journalEntries.filter(j=>j.status==="posted").length, draft: journalEntries.filter(j=>j.status==="draft").length, voided: journalEntries.filter(j=>j.status==="voided").length };

  // Get unique properties from existing JEs for the filter dropdown
  const jeProperties = [...new Set(journalEntries.map(je => je.property).filter(Boolean))].sort();

  const EMPTY_JE_LINE = { account_id:"", account_name:"", debit:"", credit:"", class_id:"", memo:"", entity_type:"", entity_id:"", entity_name:"" };
  const openAdd = () => {
  setForm({ date: acctToday(), description: "", reference: "", property: "", lines: [{ ...EMPTY_JE_LINE }, { ...EMPTY_JE_LINE }] });
  setModal("add");
  };

  const openEdit = (je) => {
  setForm({ date: je.date, description: je.description, reference: je.reference || "", property: je.property || "", lines: (je.lines || []).map(l => ({ ...l, debit: l.debit || "", credit: l.credit || "" })) });
  setModal({ mode: "edit", je });
  };

  const openView = (je) => setModal({ mode: "view", je });

  const openDuplicate = (je) => {
  setForm({ date: acctToday(), description: je.description || "", reference: je.reference || "", property: je.property || "", lines: (je.lines || []).map(l => ({ account_id: l.account_id, account_name: l.account_name, debit: l.debit || "", credit: l.credit || "", class_id: l.class_id || "", memo: l.memo || "", entity_type: l.entity_type || "", entity_id: l.entity_id || "", entity_name: l.entity_name || "" })) });
  setModal("add");
  };

  const setLine = (i, k, v) => {
  if (k === "account_id" && v === "__new__") { setShowNewAcct(i); setNewAcctForm({ code: "", name: "", type: "Expense" }); return; }
  const lines = [...form.lines];
  lines[i] = { ...lines[i], [k]: v };
  if (k === "account_id") { const acct = accounts.find(a => a.id === v); lines[i].account_name = acct?.name || ""; }
  setForm(f => ({ ...f, lines }));
  };

  async function createInlineAccount() {
    if (!newAcctForm.name.trim()) { showToast("Account name is required.", "error"); return; }
    const code = newAcctForm.code.trim() || nextAccountCode(accounts, newAcctForm.type);
    const { data: newAcct, error } = await supabase.from("acct_accounts").insert([{
      company_id: companyId, code, name: newAcctForm.name.trim(), type: newAcctForm.type,
      is_active: true, old_text_id: companyId + "-" + code
    }]).select("id, code, name, type").maybeSingle();
    if (error) { pmError("PM-4006", { raw: error, context: "create inline account" }); return; }
    if (newAcct && showNewAcct !== null) {
      const lines = [...form.lines];
      lines[showNewAcct] = { ...lines[showNewAcct], account_id: newAcct.id, account_name: newAcct.name };
      setForm(f => ({ ...f, lines }));
    }
    showToast(`Account "${newAcctForm.name}" created.`, "success");
    setShowNewAcct(null);
    // Trigger parent refresh to pick up new account
    if (typeof onAdd === "function") { /* onAdd is for JE, not account creation */ }
  }

  const addLine = () => setForm(f => ({ ...f, lines: [...f.lines, { ...EMPTY_JE_LINE }] }));
  const removeLine = (i) => { if (form.lines.length <= 2) return; setForm(f => ({ ...f, lines: f.lines.filter((_,idx) => idx !== i) })); };

  const totalDebit = form.lines.reduce((s,l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCredit = form.lines.reduce((s,l) => s + (parseFloat(l.credit) || 0), 0);
  const validation = validateJE(form.lines.filter(l => l.account_id));

  const saveEntry = async (status) => {
  if (!form.description.trim() || !validation.isValid) return;
  const lines = form.lines.filter(l => l.account_id).map(l => ({ ...l, debit: parseFloat(l.debit) || 0, credit: parseFloat(l.credit) || 0 }));
  if (modal === "add") {
  await onAdd({ ...form, lines, status });
  } else if (modal?.mode === "edit") {
  await onUpdate({ ...modal.je, ...form, lines, status: status || modal.je.status });
  }
  setModal(null);
  };

  const JEFormUI = () => (
  <div className="space-y-4">
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-500">Date *</label><Input type="date" value={form.date} onChange={e => setForm({...form, date:e.target.value})} className="mt-1" /></div>
  <div><label className="text-xs font-medium text-neutral-500">Reference</label><Input value={form.reference} onChange={e => setForm({...form, reference:e.target.value})} className="mt-1" placeholder="Invoice #, Check #..." /></div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-500">Description *</label><Input value={form.description} onChange={e => setForm({...form, description:e.target.value})} className="mt-1" placeholder="What is this entry for?" /></div>
  </div>
  {/* Property is selected per-line via Class, not at header level */}
  <input type="hidden" value={form.property} />
  <div className="flex items-center justify-between mb-2">
  <p className="text-xs font-semibold text-neutral-500 uppercase">Journal Entry Lines</p>
  <button onClick={addLine} className="text-xs text-neutral-600 hover:text-neutral-800">+ Add Line</button>
  </div>
  {showNewAcct !== null && (
  <div className="bg-brand-50 rounded-xl p-3 mb-3 border-2 border-brand-400 shadow-lg">
  <div className="text-xs font-semibold text-brand-700 mb-2">Create New Account (for line {showNewAcct + 1})</div>
  <div className="grid grid-cols-3 gap-2">
  <div><label className="text-xs text-neutral-500 block mb-1">Type *</label><Select value={newAcctForm.type} onChange={e => setNewAcctForm({...newAcctForm, type: e.target.value})} className="text-xs">{ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</Select></div>
  <div><label className="text-xs text-neutral-500 block mb-1">Code</label><Input value={newAcctForm.code} onChange={e => setNewAcctForm({...newAcctForm, code: e.target.value})} placeholder="Auto" className="text-xs" /></div>
  <div><label className="text-xs text-neutral-500 block mb-1">Name *</label><Input value={newAcctForm.name} onChange={e => setNewAcctForm({...newAcctForm, name: e.target.value})} placeholder="e.g. Office Supplies" className="text-xs" /></div>
  </div>
  <div className="flex gap-2 mt-2"><Btn size="sm" onClick={createInlineAccount}>Create & Select</Btn><Btn size="sm" variant="ghost" onClick={() => setShowNewAcct(null)}>Cancel</Btn></div>
  </div>
  )}
  <div className="rounded-xl border border-brand-100 overflow-x-auto">
  <table className="w-full text-sm">
  <thead><tr className="bg-neutral-50 border-b border-neutral-200"><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500 w-44">Account</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500 w-28">Class</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500 w-32">Tenant/Vendor</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500 min-w-[120px]">Memo</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500 w-24">Debit</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500 w-24">Credit</th><th className="px-3 py-2 w-8" /></tr></thead>
  <tbody>
  {form.lines.map((line, i) => (
  <tr key={i} className="border-b border-neutral-100">
  <td className="px-2 py-1.5"><AccountPicker value={line.account_id} onChange={v => setLine(i,"account_id",v)} accounts={accounts} accountTypes={ACCOUNT_TYPES} showNewOption className="px-2 py-1.5 bg-white" /></td>
  <td className="px-2 py-1.5"><Select value={line.class_id || ""} onChange={e => { setLine(i,"class_id",e.target.value||null); const cls = classes.find(c=>c.id===e.target.value); if (cls && !form.property) setForm(f=>({...f, property: cls.name})); }} className="px-2 py-1.5 text-xs bg-white"><option value="">No Class</option>{classes.filter(c=>c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>
  <td className="px-2 py-1.5"><Select value={line.entity_id ? `${line.entity_type}:${line.entity_id}` : ""} onChange={e => { const val = e.target.value; if (!val) { setForm(f => { const lines = [...f.lines]; lines[i] = { ...lines[i], entity_type: "", entity_id: "", entity_name: "" }; return { ...f, lines }; }); return; } const [type, id] = val.split(":"); const name = type === "customer" ? tenants.find(t => t.id === id)?.name : vendors.find(v => v.id === id)?.name; setForm(f => { const lines = [...f.lines]; lines[i] = { ...lines[i], entity_type: type, entity_id: id, entity_name: name || "" }; return { ...f, lines }; }); }} className="px-2 py-1.5 text-xs bg-white"><option value="">None</option><optgroup label="Tenants">{tenants.map(t => <option key={t.id} value={`customer:${t.id}`}>{t.name}</option>)}</optgroup><optgroup label="Vendors">{vendors.map(v => <option key={v.id} value={`vendor:${v.id}`}>{v.name}</option>)}</optgroup></Select></td>
  <td className="px-2 py-1.5"><input type="text" value={line.memo||""} onChange={e => setLine(i,"memo",e.target.value)} placeholder="Optional..." className="w-full border border-brand-100 rounded-lg px-2 py-1.5 text-xs bg-white focus:border-brand-300 focus:outline-none" /></td>
  <td className="px-2 py-1.5"><input type="text" inputMode="decimal" value={line.debit} onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ""); setForm(f => { const lines = [...f.lines]; lines[i] = { ...lines[i], debit: v, ...(v ? { credit: "" } : {}) }; return { ...f, lines }; }); }} placeholder="0.00" className="w-full border border-brand-100 rounded-2xl px-2 py-1.5 text-xs text-right bg-white font-mono focus:border-brand-300 focus:outline-none" /></td>
  <td className="px-2 py-1.5"><input type="text" inputMode="decimal" value={line.credit} onChange={e => { const v = e.target.value.replace(/[^0-9.]/g, ""); setForm(f => { const lines = [...f.lines]; lines[i] = { ...lines[i], credit: v, ...(v ? { debit: "" } : {}) }; return { ...f, lines }; }); }} placeholder="0.00" className="w-full border border-brand-100 rounded-2xl px-2 py-1.5 text-xs text-right bg-white font-mono focus:border-brand-300 focus:outline-none" /></td>
  <td className="px-2 py-1.5"><button onClick={() => removeLine(i)} disabled={form.lines.length<=2} className="text-neutral-300 hover:text-danger-500 disabled:opacity-20">✕</button></td>
  </tr>
  ))}
  </tbody>
  <tfoot><tr className="bg-neutral-50 border-t border-neutral-200"><td colSpan={4} className="px-3 py-2 text-xs font-semibold text-neutral-500 text-right">Totals</td><td className={`px-3 py-2 text-xs font-mono font-bold text-right ${validation.isValid?"text-success-700":"text-danger-600"}`}>{acctFmt(totalDebit)}</td><td className={`px-3 py-2 text-xs font-mono font-bold text-right ${validation.isValid?"text-success-700":"text-danger-600"}`}>{acctFmt(totalCredit)}</td><td /></tr></tfoot>
  </table>
  </div>
  {!validation.isValid && totalDebit > 0 && totalCredit > 0 && <div className="text-xs text-danger-600 bg-danger-50 rounded-2xl px-3 py-2">⚠ Out of balance by {acctFmt(validation.difference)}</div>}
  {validation.isValid && totalDebit > 0 && <div className="text-xs text-success-600 bg-success-50 rounded-2xl px-3 py-2">✓ Balanced — {acctFmt(totalDebit)}</div>}
  <div className="flex justify-between pt-2">
  <Btn variant="slate" onClick={() => setModal(null)}>Cancel</Btn>
  <div className="flex gap-2">
  <Btn variant="success-fill" onClick={() => saveEntry("posted")} disabled={!form.description || !validation.isValid}>Post Entry</Btn>
  </div>
  </div>
  </div>
  );

  return (
  <div className="space-y-4">
  <div className="flex items-center justify-between mb-4">
  <div><h3 className="text-lg font-semibold text-neutral-900">Journal Entries</h3><p className="text-sm text-neutral-400">Record and manage financial transactions</p></div>
  <Btn variant="success-fill" size="sm" onClick={openAdd}>+ New Entry</Btn>
  </div>
  <div className="flex gap-2 mb-4">
  {[{k:"all",l:`All (${counts.all})`},{k:"posted",l:`Posted (${counts.posted})`},{k:"draft",l:`Drafts (${counts.draft})`},{k:"voided",l:`Voided (${counts.voided})`}].map(f => (
  <button key={f.k} onClick={() => setFilterStatus(f.k)} className={`text-xs px-3 py-1.5 rounded-lg border font-medium ${filterStatus === f.k ? "bg-positive-600 text-white border-positive-600" : "bg-white text-neutral-500 border-neutral-200 hover:border-positive-300"}`}>{f.l}</button>
  ))}
  <Select filter value={searchProperty} onChange={e => setSearchProperty(e.target.value)} className="text-xs py-1.5 rounded-xl ml-auto">
  <option value="">All Properties</option>
  {jeProperties.map(p => <option key={p} value={p}>{p.split(",")[0]}</option>)}
  </Select>
  <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg border border-neutral-200 bg-white text-neutral-500" title="From date" />
  <span className="text-xs text-neutral-400">to</span>
  <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="text-xs px-2 py-1.5 rounded-lg border border-neutral-200 bg-white text-neutral-500" title="To date" />
  {(dateFrom || dateTo) && <button onClick={() => { setDateFrom(""); setDateTo(""); }} className="text-xs text-danger-400 hover:text-danger-600">Clear</button>}
  </div>
  <div className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-hidden">
  <table className="w-full text-sm">
  <thead className="text-xs text-neutral-500 uppercase tracking-wider bg-neutral-50 font-semibold"><tr><th className="px-5 py-3 text-left">Entry #</th><th className="px-5 py-3 text-left">Date</th><th className="px-5 py-3 text-left">Property</th><th className="px-5 py-3 text-left">Description</th><th className="px-5 py-3 text-left">Source</th><th className="px-5 py-3 text-left">Status</th><th className="px-5 py-3 text-right">Amount</th><th className="px-5 py-3">Actions</th></tr></thead>
  <tbody>
  {filtered.map(je => {
  const total = (je.lines || []).reduce((s,l) => s + safeNum(l.debit), 0);
  return (
  <tr key={je.id} className="border-t border-neutral-100 hover:bg-positive-50/40 transition-colors cursor-pointer" onClick={() => openView(je)}>
  <td className="px-5 py-3 font-mono text-xs font-semibold text-neutral-700">{je.number}</td>
  <td className="px-5 py-3 text-neutral-500">{acctFmtDate(je.date)}</td>
  <td className="px-5 py-3 text-xs text-neutral-500">{je.property || "—"}</td>
  <td className="px-5 py-3 font-medium text-neutral-800">{je.description}</td>
  <td className="px-5 py-3 text-xs text-neutral-400">{(() => { const r = je.reference || ""; if (r.startsWith("BANK-")) return "Bank Import"; if (r.startsWith("XFER-")) return "Bank Transfer"; if (r.startsWith("SPLIT-")) return "Bank Split"; if (r.startsWith("PAY-")) return "Payment"; if (r.startsWith("STRIPE-")) return "Stripe"; if (r.startsWith("RECUR-")) return "Recurring"; if (r.startsWith("DEP-")) return "Deposit"; if (r.startsWith("PRORENT-")) return "Prorated Rent"; if (r.startsWith("RENT-")) return "Rent Charge"; if (r.startsWith("LATEFEE-")) return "Late Fee"; if (r.startsWith("VINV-")) return "Vendor Invoice"; if (r.startsWith("WO-")) return "Work Order"; if (r.startsWith("DEPRET-")) return "Deposit Return"; if (r.startsWith("DEPFORF-")) return "Deposit Forfeiture"; if (r.startsWith("MOVEOUT-")) return "Move-Out"; if (r) return "Manual"; return "—"; })()}</td>
  <td className="px-5 py-3"><AcctStatusBadge status={je.status} /></td>
  <td className="px-5 py-3 text-right font-mono text-sm font-semibold">{acctFmt(total)}</td>
  <td className="px-5 py-3 text-center">
  <div className="flex gap-1 justify-center" onClick={e => e.stopPropagation()}>
  {je.status === "draft" && <button onClick={() => onPost(je.id)} className="bg-success-50 text-success-700 px-3 py-1.5 rounded-lg border border-success-200 hover:bg-success-100 text-xs">Post</button>}
  {je.status === "posted" && <button onClick={() => onVoid(je.id)} className="bg-danger-50 text-danger-600 px-3 py-1.5 rounded-lg border border-danger-200 hover:bg-danger-100 text-xs">Void</button>}
  {je.status !== "voided" && <button onClick={() => openEdit(je)} className="text-xs text-brand-600 hover:underline">Edit</button>}
  <button onClick={() => openDuplicate(je)} className="text-xs text-neutral-400 hover:text-neutral-700 hover:underline">Duplicate</button>
  </div>
  </td>
  </tr>
  );
  })}
  {filtered.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-neutral-400">No journal entries found</td></tr>}
  </tbody>
  </table>
  </div>
  {/* Add/Edit Modal */}
  <AcctModal isOpen={modal === "add" || modal?.mode === "edit"} onClose={() => setModal(null)} title={modal === "add" ? "New Journal Entry" : `Edit: ${modal?.je?.number}`} size="xl">
  {JEFormUI()}
  </AcctModal>
  {/* View Modal */}
  {modal?.mode === "view" && (
  <AcctModal isOpen={true} onClose={() => { setModal(null); if (onCloseJEDetail) onCloseJEDetail(); }} title={`Journal Entry: ${modal.je.number}`} size="xl">
  <div className="space-y-4">
  <div className="grid grid-cols-3 gap-3 bg-neutral-50 rounded-xl p-4">
  <div><p className="text-xs text-neutral-400">Entry #</p><p className="font-mono font-semibold">{modal.je.number}</p></div>
  <div><p className="text-xs text-neutral-400">Date</p><p className="font-semibold">{acctFmtDate(modal.je.date)}</p></div>
  <div><p className="text-xs text-neutral-400">Property</p><p className="font-semibold">{modal.je.property || "—"}</p></div>
  <div className="col-span-2"><p className="text-xs text-neutral-400">Description</p><p className="font-semibold">{modal.je.description}</p></div>
  <div><p className="text-xs text-neutral-400">Status</p><AcctStatusBadge status={modal.je.status} /></div>
  </div>
  <table className="w-full text-sm rounded-xl border border-neutral-200 overflow-hidden">
  <thead><tr className="bg-neutral-50"><th className="px-5 py-3 text-left text-xs font-semibold text-neutral-500">Account</th><th className="px-5 py-3 text-left text-xs font-semibold text-neutral-500">Class</th><th className="px-5 py-3 text-left text-xs font-semibold text-neutral-500">Tenant/Vendor</th><th className="px-5 py-3 text-left text-xs font-semibold text-neutral-500">Memo</th><th className="px-5 py-3 text-right text-xs font-semibold text-neutral-500">Debit</th><th className="px-5 py-3 text-right text-xs font-semibold text-neutral-500">Credit</th></tr></thead>
  <tbody>
  {(modal.je.lines || []).map((l,i) => {
  const cls = classes.find(c => c.id === l.class_id);
  return (
  <tr key={i} className="border-t border-neutral-100">
  <td className="px-5 py-3">{(() => { const acct = accounts.find(a => a.id === l.account_id); const code = acct?.code || ""; const name = l.account_name || acct?.name || "Unknown Account"; return <>{code && <span className="font-mono text-xs text-neutral-400 mr-1">{code}</span>}{name}</>; })()}</td>
  <td className="px-4 py-2 text-xs">{cls ? <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{background:cls.color}} />{cls.name}</span> : "—"}</td>
  <td className="px-4 py-2 text-xs text-neutral-500">{l.entity_name ? <span>{l.entity_type === "vendor" ? "V: " : "C: "}{l.entity_name}</span> : "—"}</td>
  <td className="px-4 py-2 text-xs text-neutral-400">{l.memo || "—"}</td>
  <td className="px-4 py-2 text-right font-mono">{safeNum(l.debit) > 0 ? acctFmt(l.debit) : ""}</td>
  <td className="px-4 py-2 text-right font-mono">{safeNum(l.credit) > 0 ? acctFmt(l.credit) : ""}</td>
  </tr>
  );
  })}
  </tbody>
  </table>
  <div className="flex gap-2">
  {modal.je.status === "draft" && <button onClick={() => { onPost(modal.je.id); setModal(null); }} className="bg-success-50 text-success-700 px-3 py-1.5 rounded-lg border border-success-200 hover:bg-success-100 text-xs">Post</button>}
  {modal.je.status === "posted" && <button onClick={() => { onVoid(modal.je.id); setModal(null); }} className="bg-danger-50 text-danger-600 px-3 py-1.5 rounded-lg border border-danger-200 hover:bg-danger-100 text-xs">Void</button>}
  {modal.je.status !== "voided" && <button onClick={() => openEdit(modal.je)} className="bg-neutral-200 text-neutral-700 text-xs px-3 py-1.5 rounded-lg">Edit</button>}
  <button onClick={() => { openDuplicate(modal.je); }} className="bg-neutral-100 text-neutral-500 text-xs px-3 py-1.5 rounded-lg hover:bg-neutral-200">Duplicate</button>
  </div>
  </div>
  </AcctModal>
  )}
  </div>
  );
}

// --- Class Tracking Sub-Page ---
export function AcctClassTracking({ accounts, journalEntries, classes, onAdd, onUpdate, onToggle, onOpenLedger }) {
  const [modal, setModal] = useState(null);
  const [period, setPeriod] = useState("This Year");
  const [form, setForm] = useState({ name:"", description:"", color:"#3B82F6" });
  const COLORS = CLASS_COLORS;

  const { start, end } = getPeriodDates(period);
  const classReport = getClassReport(accounts, journalEntries, classes, start, end);
  const activeReport = classReport.filter(c => c.is_active);
  const totalRev = activeReport.reduce((s,c) => s + c.revenue, 0);
  const totalExp = activeReport.reduce((s,c) => s + c.expenses, 0);
  const totalNet = activeReport.reduce((s,c) => s + c.netIncome, 0);

  const openAdd = () => { setForm({ name:"", description:"", color:"#3B82F6" }); setModal("add"); };
  const openEdit = (cls) => { setForm({ name: cls.name, description: cls.description || "", color: cls.color || "#3B82F6" }); setModal({ mode:"edit", cls }); };

  const saveClass = async () => {
  if (!form.name.trim()) return;
  if (modal === "add") {
  await onAdd({ id: crypto.randomUUID(), ...form, is_active: true });
  } else {
  await onUpdate({ ...modal.cls, ...form });
  }
  setModal(null);
  };

  return (
  <div className="space-y-4">
  <div className="flex items-center justify-between mb-4">
  <div><h3 className="text-lg font-semibold text-neutral-900">Class Tracking</h3><p className="text-sm text-neutral-400">Track by unit, property, or department</p></div>
  <Btn variant="success-fill" size="sm" onClick={openAdd}>+ New Class</Btn>
  </div>
  <div className="flex flex-wrap gap-2 mb-4">
  {PERIODS.map(p => <button key={p} onClick={() => setPeriod(p)} className={`text-xs px-3 py-1.5 rounded-lg border font-medium ${period === p ? "bg-positive-600 text-white border-positive-600" : "bg-white text-neutral-500 border-neutral-200 hover:border-positive-300"}`}>{p}</button>)}
  </div>
  <div className="grid grid-cols-3 gap-3 mb-4">
  <div className="bg-success-50 border border-success-100 rounded-xl p-4"><p className="text-xs text-success-600 font-medium">Revenue</p><p className="text-xl font-bold text-success-800 font-mono mt-1">{acctFmt(totalRev)}</p></div>
  <div className="bg-danger-50 border border-danger-100 rounded-xl p-4"><p className="text-xs text-danger-600 font-medium">Expenses</p><p className="text-xl font-bold text-danger-800 font-mono mt-1">{acctFmt(totalExp)}</p></div>
  <div className={`border rounded-xl p-4 ${totalNet >= 0 ? "bg-info-50 border-info-100" : "bg-notice-50 border-notice-100"}`}><p className={`text-xs font-medium ${totalNet >= 0 ? "text-info-600" : "text-notice-600"}`}>Net Income</p><p className={`text-xl font-bold font-mono mt-1 ${totalNet >= 0 ? "text-info-800" : "text-notice-800"}`}>{acctFmt(totalNet, true)}</p></div>
  </div>
  <div className="bg-white rounded-xl shadow-sm border border-neutral-200 overflow-hidden">
  <table className="w-full text-sm">
  <thead className="text-xs text-neutral-500 uppercase tracking-wider bg-neutral-50 font-semibold"><tr><th className="px-5 py-3 text-left">Class</th><th className="px-5 py-3 text-left">Description</th><th className="px-5 py-3 text-right">Revenue</th><th className="px-5 py-3 text-right">Expenses</th><th className="px-5 py-3 text-right">Net Income</th><th className="px-5 py-3 w-16" /></tr></thead>
  <tbody>
  {classReport.map(c => (
  <tr key={c.id} className="border-t border-neutral-100 hover:bg-positive-50/40 transition-colors">
  <td className="px-5 py-3"><div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{background:c.color}} /><span className={`font-medium ${!c.is_active?"text-neutral-400 line-through":"text-neutral-800"}`}>{c.name}</span></div></td>
  <td className="px-5 py-3 text-xs text-neutral-400">{c.description}</td>
  <td className="px-5 py-3 text-right font-mono text-sm text-success-700">{c.revenue > 0 ? acctFmt(c.revenue) : "—"}</td>
  <td className="px-5 py-3 text-right font-mono text-sm text-danger-600">{c.expenses > 0 ? acctFmt(c.expenses) : "—"}</td>
  <td className={`px-5 py-3 text-right font-mono text-sm font-bold ${c.netIncome >= 0 ? "text-info-700" : "text-danger-700"}`}>{acctFmt(c.netIncome, true)}</td>
  <td className="px-5 py-3 flex gap-1"><button onClick={() => openEdit(c)} className="text-xs text-brand-600 hover:underline">Edit</button><button onClick={() => onToggle(c.id, c.is_active)} className="text-xs">{c.is_active ? "🟢" : "⚪"}</button></td>
  </tr>
  ))}
  </tbody>
  </table>
  </div>
  <AcctModal isOpen={!!modal} onClose={() => setModal(null)} title={modal === "add" ? "New Class" : "Edit Class"} size="sm">
  <div className="space-y-3">
  <div><label className="text-xs font-medium text-neutral-500">Name *</label><Input placeholder="e.g. 123 Main St" value={form.name} onChange={e => setForm({...form,name:e.target.value})} className="mt-1" /></div>
  <div><label className="text-xs font-medium text-neutral-500">Description</label><Textarea value={form.description} onChange={e => setForm({...form,description:e.target.value})} className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm mt-1" rows={2} /></div>
  <div><label className="text-xs font-medium text-neutral-500 block mb-2">Color</label><div className="flex gap-2 flex-wrap">{COLORS.map(c => <button key={c} type="button" onClick={() => setForm({...form,color:c})} className={`w-7 h-7 rounded-full border-2 ${form.color===c?"border-subtle-800 scale-110":"border-transparent"}`} style={{background:c}} />)}</div></div>
  <div className="flex justify-end gap-2 pt-2">
  <Btn variant="slate" onClick={() => setModal(null)}>Cancel</Btn>
  <Btn variant="success-fill" onClick={saveClass}>{modal === "add" ? "Create" : "Save"}</Btn>
  </div>
  </div>
  </AcctModal>
  </div>
  );
}

// --- Reports Center (QuickBooks-style) ---
export function AcctReports({ accounts, journalEntries, classes, companyName, companyId, userProfile, showToast, onOpenLedger }) {
  const [activeView, setActiveView] = useState("catalog"); // catalog | viewer
  const [currentReport, setCurrentReport] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [catalogTab, setCatalogTab] = useState("standard"); // standard | favorites | custom
  const [favorites, setFavorites] = useState(() => { try { const s = localStorage.getItem(`report_favorites_${companyId}`); return s ? JSON.parse(s) : []; } catch (e) { pmError("PM-4012", { raw: e, context: "reading report favorites from localStorage", silent: true }); return []; } });
  const [collapsedCats, setCollapsedCats] = useState({});

  // Report config (shared toolbar state)
  const [period, setPeriod] = useState("This Year");
  const [customDates, setCustomDates] = useState({ start: `${new Date().getFullYear()}-01-01`, end: `${new Date().getFullYear()}-12-31` });
  const [asOfDate, setAsOfDate] = useState(acctToday());
  const [compareTo, setCompareTo] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState(accounts[0]?.id || "");
  const [showIncome, setShowIncome] = useState(true);
  const [showExpenses, setShowExpenses] = useState(true);
  const [showAssets, setShowAssets] = useState(true);
  const [showLiabilities, setShowLiabilities] = useState(true);
  const [showEquity, setShowEquity] = useState(true);
  const [showARSub, setShowARSub] = useState(false);
  const [glColumns, setGlColumns] = useState(() => { try { const s = localStorage.getItem("gl_columns"); return s ? JSON.parse(s) : { date: true, entry: true, description: true, memo: true, debit: true, credit: true, balance: true }; } catch (e) { pmError("PM-4013", { raw: e, context: "reading GL column prefs from localStorage", silent: true }); return { date: true, entry: true, description: true, memo: true, debit: true, credit: true, balance: true }; } });
  const [showColPicker, setShowColPicker] = useState(false);
  const toggleGlCol = (col) => { const next = { ...glColumns, [col]: !glColumns[col] }; setGlColumns(next); try { localStorage.setItem("gl_columns", JSON.stringify(next)); } catch (e) { pmError("PM-4014", { raw: e, context: "saving GL column prefs to localStorage", silent: true }); } };

  // Extra data for property reports (fetched on demand)
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [leases, setLeases] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [licenses, setLicenses] = useState([]);
  const [extraDataLoaded, setExtraDataLoaded] = useState(false);

  async function loadExtraData() {
    if (extraDataLoaded) return;
    const [propRes, tenRes, leaseRes, woRes, licRes] = await Promise.all([
      supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null),
      supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null),
      supabase.from("leases").select("*").eq("company_id", companyId),
      supabase.from("work_orders").select("*").eq("company_id", companyId).is("archived_at", null),
      supabase.from("property_licenses").select("*").eq("company_id", companyId).is("archived_at", null),
    ]);
    setProperties(propRes.data || []);
    setTenants(tenRes.data || []);
    setLeases(leaseRes.data || []);
    setWorkOrders(woRes.data || []);
    setLicenses(licRes.data || []);
    setExtraDataLoaded(true);
  }

  const computedDates = period === "Custom" ? customDates : getPeriodDates(period);
  const start = computedDates.start;
  const end = computedDates.end;

  // Toggle favorite
  function toggleFavorite(reportId) {
    const next = favorites.includes(reportId) ? favorites.filter(f => f !== reportId) : [...favorites, reportId];
    setFavorites(next);
    try { localStorage.setItem(`report_favorites_${companyId}`, JSON.stringify(next)); } catch (e) { pmError("PM-4015", { raw: e, context: "saving report favorites to localStorage", silent: true }); }
    // Also try to save to DB for cross-device sync
    if (userProfile?.email) {
      supabase.from("app_users").update({ preferences: { report_favorites: next } }).eq("company_id", companyId).ilike("email", userProfile.email).then(() => {}).catch((e) => { pmError("PM-4016", { raw: e, context: "syncing report favorites to DB", silent: true }); });
    }
  }

  // --- Report Catalog Definition ---
  const REPORT_CATALOG = [
    { category: "Business Overview", icon: "insights", reports: [
      { id: "pl", title: "Profit & Loss", description: "Income vs expenses for a period", icon: "trending_up" },
      { id: "pl_by_class", title: "P&L by Property", description: "P&L broken out by property", icon: "apartment" },
      { id: "pl_compare", title: "P&L Comparison", description: "Side-by-side P&L for two periods", icon: "compare_arrows" },
      { id: "bs", title: "Balance Sheet", description: "Assets, liabilities, equity as-of date", icon: "account_balance" },
      { id: "cash_flow", title: "Cash Flow Statement", description: "Cash inflows/outflows by activity", icon: "water_drop" },
      { id: "budget_vs_actual", title: "Budget vs. Actuals", description: "Compare budgeted to actual amounts", icon: "track_changes" },
    ]},
    { category: "Who Owes You", icon: "people", reports: [
      { id: "ar_aging_summary", title: "AR Aging Summary", description: "Outstanding AR bucketed by age", icon: "timer" },
      { id: "ar_aging_detail", title: "AR Aging Detail", description: "Per-tenant AR aging breakdown", icon: "timer" },
      { id: "customer_balance_summary", title: "Tenant Balance Summary", description: "Total balance per tenant", icon: "people" },
      { id: "open_invoices", title: "Open Invoices", description: "Unpaid rent charges with days outstanding", icon: "receipt_long" },
      { id: "collections", title: "Collections Report", description: "Most overdue tenants with contact info", icon: "gavel" },
    ]},
    { category: "What You Owe", icon: "money_off", reports: [
      { id: "ap_aging_summary", title: "AP Aging Summary", description: "Amounts owed to vendors by age", icon: "schedule" },
      { id: "unpaid_bills", title: "Unpaid Bills", description: "Outstanding vendor invoices", icon: "money_off" },
      { id: "vendor_balance_summary", title: "Vendor Balance Summary", description: "Total owed per vendor", icon: "store" },
    ]},
    { category: "Expenses & Vendors", icon: "receipt", reports: [
      { id: "expenses_by_category", title: "Expenses by Category", description: "Expenses grouped by account type", icon: "category" },
      { id: "expenses_by_vendor", title: "Expenses by Vendor", description: "Total expenses per vendor/payee", icon: "receipt" },
    ]},
    { category: "For My Accountant", icon: "calculate", reports: [
      { id: "tb", title: "Trial Balance", description: "All account balances (debit/credit)", icon: "balance" },
      { id: "gl", title: "General Ledger", description: "Transaction detail for a single account", icon: "menu_book" },
      { id: "journal", title: "Journal", description: "All journal entries with full lines", icon: "edit_note" },
      { id: "txn_by_date", title: "Transaction List by Date", description: "Every posted transaction sorted by date", icon: "list_alt" },
      { id: "account_list", title: "Account Listing", description: "Chart of Accounts as a report", icon: "format_list_numbered" },
      { id: "audit_log", title: "Audit Log", description: "Who did what and when", icon: "history" },
      { id: "recon_summary", title: "Reconciliation Summary", description: "Bank reconciliation status history", icon: "check_circle" },
    ]},
    { category: "Property Performance", icon: "real_estate_agent", reports: [
      { id: "rent_roll", title: "Rent Roll", description: "All units with tenant, rent, lease dates", icon: "real_estate_agent" },
      { id: "vacancy", title: "Vacancy Report", description: "Vacant properties with days vacant", icon: "door_front" },
      { id: "lease_expirations", title: "Lease Expirations", description: "Leases expiring soon", icon: "event_upcoming" },
      { id: "rent_collection", title: "Rent Collection", description: "Charged vs collected vs outstanding", icon: "payments" },
      { id: "work_orders_summary", title: "Work Order Summary", description: "Work orders by status, property, cost", icon: "build" },
      { id: "security_deposits", title: "Security Deposit Ledger", description: "Deposits held per tenant", icon: "savings" },
      { id: "noi_by_property", title: "NOI by Property", description: "Net Operating Income per property", icon: "insights" },
      { id: "license_compliance", title: "License Compliance", description: "All property licenses & expirations", icon: "verified" },
    ]},
  ];

  const allReports = REPORT_CATALOG.flatMap(c => c.reports);

  function openReport(report) {
    setCurrentReport(report);
    setActiveView("viewer");
    // Load extra data for property reports
    if (["rent_roll","vacancy","lease_expirations","rent_collection","work_orders_summary","security_deposits","collections","noi_by_property","license_compliance"].includes(report.id)) {
      loadExtraData();
    }
    if (report.id === "audit_log") { getAuditLog(start, end).then(d => setAuditData(d)); }
    if (report.id === "recon_summary") { getReconSummary().then(d => setReconData(d)); }
    if (report.id === "budget_vs_actual") { fetchBudgets(start.slice(0, 7)); }
  }

  // --- Computation Functions (NEW reports) ---
  function getJournalReport(startDate, endDate) {
    return journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate)
      .sort((a,b) => a.date.localeCompare(b.date) || (a.number||"").localeCompare(b.number||""))
      .map(je => ({ jeId: je.id, jeNumber: je.number, date: je.date, description: je.description, reference: je.reference, lines: (je.lines||[]).map(l => ({ accountName: l.account_name, memo: l.memo, debit: safeNum(l.debit), credit: safeNum(l.credit) })) }));
  }

  function getTransactionsByDate(startDate, endDate) {
    const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
    const rows = [];
    journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate).forEach(je => {
      (je.lines||[]).forEach(l => {
        const acct = acctMap[l.account_id];
        rows.push({ date: je.date, jeNumber: je.number, accountName: acct?.name || l.account_name, accountType: acct?.type || "", description: je.description, memo: l.memo, debit: safeNum(l.debit), credit: safeNum(l.credit) });
      });
    });
    return rows.sort((a,b) => a.date.localeCompare(b.date));
  }

  function getExpensesByCategory(startDate, endDate) {
    const plData = getPLData(accounts, journalEntries, startDate, endDate, classFilter || null);
    const total = plData.totalExpenses || 1;
    return plData.expenses.map(a => ({ ...a, percentage: Math.round(a.amount / total * 100) })).sort((a,b) => b.amount - a.amount);
  }

  function getRentRoll() {
    return properties.map(p => {
      const t = tenants.find(t => t.property === p.address && t.lease_status === "active");
      const l = leases.find(l => l.property === p.address && l.status === "active");
      return { property: p.address, tenant: t?.name || "VACANT", rent: safeNum(p.rent), leaseStart: l?.start_date || p.lease_start || "", leaseEnd: l?.end_date || p.lease_end || "", status: p.status, deposit: safeNum(p.security_deposit) };
    }).sort((a,b) => a.property.localeCompare(b.property));
  }

  function getVacancyReport() {
    return properties.filter(p => p.status === "vacant" || !p.tenant).map(p => {
      const lastLease = leases.filter(l => l.property === p.address).sort((a,b) => (b.end_date||"").localeCompare(a.end_date||""))[0];
      const moveOut = lastLease?.end_date ? parseLocalDate(lastLease.end_date) : null;
      const daysVacant = moveOut ? Math.max(0, Math.floor((new Date() - moveOut) / 86400000)) : 0;
      return { property: p.address, lastTenant: lastLease?.tenant_name || "—", moveOutDate: lastLease?.end_date || "—", daysVacant, lastRent: safeNum(p.rent), estimatedLost: Math.round(daysVacant * safeNum(p.rent) / 30) };
    });
  }

  function getLeaseExpirations(windowDays = 90) {
    const today = new Date();
    return leases.filter(l => l.status === "active" && l.end_date).map(l => {
      const end = parseLocalDate(l.end_date);
      const days = Math.ceil((end - today) / 86400000);
      return { tenant: l.tenant_name, property: l.property, leaseStart: l.start_date, leaseEnd: l.end_date, daysUntilExpiration: days, rent: safeNum(l.rent_amount) };
    }).filter(l => l.daysUntilExpiration <= windowDays && l.daysUntilExpiration >= 0).sort((a,b) => a.daysUntilExpiration - b.daysUntilExpiration);
  }

  const LIC_TYPE_LABELS = { rental_license: "Rental License", rental_registration: "Rental Registration", lead_paint: "Lead Paint Certificate", lead_risk_assessment: "Lead Risk Assessment", fire_inspection: "Fire Inspection Certificate", bbl: "Business License (DC BBL)", other: "Other" };
  function getLicenseCompliance() {
    const today = new Date();
    const propById = Object.fromEntries(properties.map(p => [p.id, p.address]));
    return licenses.map(lic => {
      const expiry = parseLocalDate(lic.expiry_date);
      const daysUntil = Math.ceil((expiry - today) / 86400000);
      return {
        property: propById[lic.property_id] || "(unknown)",
        type: LIC_TYPE_LABELS[lic.license_type] || lic.license_type_custom || lic.license_type,
        number: lic.license_number || "",
        jurisdiction: lic.jurisdiction || "",
        issueDate: lic.issue_date || "",
        expiryDate: lic.expiry_date,
        daysUntil,
        status: daysUntil < 0 ? "expired" : (lic.status === "pending_renewal" ? "pending_renewal" : (daysUntil <= 30 ? "urgent" : (daysUntil <= 90 ? "soon" : "active"))),
        fee: safeNum(lic.fee_amount),
        notes: lic.notes || "",
      };
    }).sort((a, b) => a.daysUntil - b.daysUntil);
  }

  function getWorkOrderSummary(startDate, endDate) {
    const wos = workOrders.filter(w => w.created >= startDate && w.created <= endDate);
    const byStatus = { open: wos.filter(w => w.status === "open").length, in_progress: wos.filter(w => w.status === "in_progress").length, completed: wos.filter(w => w.status === "completed").length };
    const totalCost = wos.reduce((s, w) => s + safeNum(w.cost), 0);
    return { byStatus, totalCost, total: wos.length, items: wos.map(w => ({ ...w, daysOpen: Math.floor((new Date() - new Date(w.created)) / 86400000) })) };
  }

  function getNOIByProperty(startDate, endDate) {
    const classReport = getClassReport(accounts, journalEntries, classes, startDate, endDate);
    return Object.entries(classReport).map(([name, data]) => ({
      property: name, revenue: data.revenue || 0, expenses: data.expenses || 0, noi: (data.revenue || 0) - (data.expenses || 0),
      noiMargin: data.revenue ? Math.round(((data.revenue - data.expenses) / data.revenue) * 100) : 0
    })).sort((a,b) => b.noi - a.noi);
  }

  function getCashFlowData(startDate, endDate) {
    const plData = getPLData(accounts, journalEntries, startDate, endDate, null);
    const bsStart = getBalanceSheetData(accounts, journalEntries, startDate);
    const bsEnd = getBalanceSheetData(accounts, journalEntries, endDate);
    const arChange = bsEnd.totalAR - bsStart.totalAR || (bsEnd.assets.find(a=>a.name?.includes("Receivable"))?.amount||0) - (bsStart.assets.find(a=>a.name?.includes("Receivable"))?.amount||0);
    const bankStart = bsStart.assets.filter(a => a.subtype === "Bank" || a.name?.includes("Checking") || a.name?.includes("Savings")).reduce((s,a)=>s+a.amount,0);
    const bankEnd = bsEnd.assets.filter(a => a.subtype === "Bank" || a.name?.includes("Checking") || a.name?.includes("Savings")).reduce((s,a)=>s+a.amount,0);
    const operating = [{ name: "Net Income", amount: plData.netIncome }, { name: "Change in Accounts Receivable", amount: -arChange }];
    const opTotal = operating.reduce((s,i) => s + i.amount, 0);
    return { netIncome: plData.netIncome, operating: { items: operating, total: opTotal }, investing: { items: [], total: 0 }, financing: { items: [], total: 0 }, netChange: bankEnd - bankStart, beginningCash: bankStart, endingCash: bankEnd };
  }

  // --- Phase B Computation Functions ---

  function getOpenInvoices(asOfDate) {
    const arIds = new Set(accounts.filter(a => a.name?.includes("Accounts Receivable") || (a.code||"").startsWith("1100")).map(a => a.id));
    const tenantCharges = {};
    journalEntries.filter(je => je.status === "posted" && je.date <= asOfDate).sort((a,b) => a.date.localeCompare(b.date)).forEach(je => {
      (je.lines||[]).filter(l => arIds.has(l.account_id)).forEach(l => {
        const desc = je.description || ""; const parts = desc.split(" — ");
        const tenant = parts.length >= 2 ? parts[1].trim() : l.memo?.split(" ")[0] || "Unknown";
        if (!tenantCharges[tenant]) tenantCharges[tenant] = [];
        if (safeNum(l.debit) > 0) tenantCharges[tenant].push({ date: je.date, description: desc, amount: safeNum(l.debit), paid: 0 });
        if (safeNum(l.credit) > 0) { const unpaid = tenantCharges[tenant].filter(c => c.amount - c.paid > 0.01); let rem = safeNum(l.credit); for (const c of unpaid) { const apply = Math.min(rem, c.amount - c.paid); c.paid += apply; rem -= apply; if (rem <= 0) break; } }
      });
    });
    const today = new Date();
    return Object.entries(tenantCharges).flatMap(([tenant, charges]) => charges.filter(c => c.amount - c.paid > 0.01).map(c => ({
      tenant, date: c.date, description: c.description, originalAmount: c.amount, amountPaid: c.paid, amountDue: Math.round((c.amount - c.paid) * 100) / 100,
      daysOutstanding: Math.floor((today - parseLocalDate(c.date)) / 86400000)
    }))).sort((a,b) => b.daysOutstanding - a.daysOutstanding);
  }

  function getCollectionsReport(asOfDate) {
    const aging = bsData.arAgingByTenant || [];
    return aging.map(t => {
      const total = (t.current||0) + (t.days30||0) + (t.days60||0) + (t.days90||0) + (t.over90||0);
      if (Math.abs(total) < 0.01) return null;
      const tenant = tenants.find(tn => tn.name === t.tenant);
      const severity = (t.over90||0) > 0 ? "critical" : (t.days60||0) > 0 ? "warning" : "normal";
      return { tenant: t.tenant, email: tenant?.email || "", phone: tenant?.phone || "", property: tenant?.property || "", current: t.current||0, days30: t.days30||0, days60: t.days60||0, days90: t.days90||0, over90: t.over90||0, total, severity };
    }).filter(Boolean).sort((a,b) => b.total - a.total);
  }

  function getCustomerBalanceDetail(asOfDate) {
    const arIds = new Set(accounts.filter(a => a.name?.includes("Accounts Receivable") || (a.code||"").startsWith("1100")).map(a => a.id));
    const byTenant = {};
    journalEntries.filter(je => je.status === "posted" && je.date <= asOfDate).sort((a,b) => a.date.localeCompare(b.date)).forEach(je => {
      (je.lines||[]).filter(l => arIds.has(l.account_id)).forEach(l => {
        const desc = je.description || ""; const parts = desc.split(" — ");
        const tenant = parts.length >= 2 ? parts[1].trim() : l.memo?.split(" ")[0] || "Unknown";
        if (!byTenant[tenant]) byTenant[tenant] = { transactions: [], balance: 0 };
        const amt = safeNum(l.debit) - safeNum(l.credit);
        byTenant[tenant].balance += amt;
        byTenant[tenant].transactions.push({ date: je.date, jeNumber: je.number, description: desc, debit: safeNum(l.debit), credit: safeNum(l.credit), balance: byTenant[tenant].balance });
      });
    });
    return Object.entries(byTenant).filter(([,d]) => Math.abs(d.balance) > 0.01).map(([name, d]) => ({ name, transactions: d.transactions, totalBalance: d.balance })).sort((a,b) => b.totalBalance - a.totalBalance);
  }

  function getExpensesByVendor(startDate, endDate) {
    const expenseTypes = new Set(["Expense","Cost of Goods Sold","Other Expense"]);
    const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
    const byVendor = {};
    let grandTotal = 0;
    journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate).forEach(je => {
      (je.lines||[]).forEach(l => {
        const acct = acctMap[l.account_id];
        if (!acct || !expenseTypes.has(acct.type)) return;
        const amt = safeNum(l.debit) - safeNum(l.credit);
        if (amt <= 0) return;
        const vendor = je.description?.split(" — ")[0]?.replace(/^(Maintenance|Manual charge|Bulk charge):\s*/i, "").trim() || l.memo?.split(":")[0]?.trim() || "Uncategorized";
        if (!byVendor[vendor]) byVendor[vendor] = { total: 0, accounts: {} };
        byVendor[vendor].total += amt;
        byVendor[vendor].accounts[acct.name] = (byVendor[vendor].accounts[acct.name] || 0) + amt;
        grandTotal += amt;
      });
    });
    return Object.entries(byVendor).map(([vendor, d]) => ({
      vendor, total: d.total, percentage: grandTotal > 0 ? Math.round(d.total / grandTotal * 100) : 0,
      accounts: Object.entries(d.accounts).map(([name, amount]) => ({ name, amount }))
    })).sort((a,b) => b.total - a.total);
  }

  function getSecurityDepositLedger(asOfDate) {
    const depIds = new Set(accounts.filter(a => a.name?.includes("Security Deposit") || (a.code||"").startsWith("2100")).map(a => a.id));
    const byTenant = {};
    journalEntries.filter(je => je.status === "posted" && je.date <= asOfDate).sort((a,b) => a.date.localeCompare(b.date)).forEach(je => {
      (je.lines||[]).filter(l => depIds.has(l.account_id)).forEach(l => {
        const desc = je.description || ""; const parts = desc.split(" — ");
        const tenant = parts.length >= 2 ? parts[1].trim() : "Unknown";
        if (!byTenant[tenant]) byTenant[tenant] = { received: 0, returned: 0, property: "" };
        byTenant[tenant].received += safeNum(l.credit);
        byTenant[tenant].returned += safeNum(l.debit);
        if (parts.length >= 3) byTenant[tenant].property = parts[2].trim();
      });
    });
    return Object.entries(byTenant).map(([tenant, d]) => ({ tenant, received: d.received, returned: d.returned, netHeld: d.received - d.returned, property: d.property })).filter(t => Math.abs(t.netHeld) > 0.01).sort((a,b) => b.netHeld - a.netHeld);
  }

  function getLateFeeReport(startDate, endDate) {
    const byTenant = {};
    journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate && (je.description||"").toLowerCase().includes("late fee")).forEach(je => {
      const parts = (je.description || "").split(" — ");
      const tenant = parts.length >= 2 ? parts[1].trim() : "Unknown";
      if (!byTenant[tenant]) byTenant[tenant] = { assessed: 0, collected: 0, count: 0 };
      (je.lines||[]).forEach(l => {
        if (safeNum(l.debit) > 0) { byTenant[tenant].assessed += safeNum(l.debit); byTenant[tenant].count++; }
        if (safeNum(l.credit) > 0) byTenant[tenant].collected += safeNum(l.credit);
      });
    });
    return Object.entries(byTenant).map(([tenant, d]) => ({ tenant, feesAssessed: d.assessed, feesCollected: d.collected, feesOutstanding: d.assessed - d.collected, count: d.count })).sort((a,b) => b.feesOutstanding - a.feesOutstanding);
  }

  function getOwnerDistributions(startDate, endDate) {
    const distJEs = journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate && ((je.reference||"").startsWith("ODIST-") || (je.description||"").toLowerCase().includes("distribution")));
    return distJEs.map(je => {
      const total = (je.lines||[]).reduce((s,l) => s + safeNum(l.debit), 0);
      return { date: je.date, description: je.description, reference: je.reference, amount: total, jeNumber: je.number };
    }).sort((a,b) => b.date.localeCompare(a.date));
  }

  function getRentCollectionSummary(startDate, endDate) {
    const classReport = getClassReport(accounts, journalEntries, classes, startDate, endDate);
    const arIds = new Set(accounts.filter(a => (a.code||"").startsWith("1100")).map(a => a.id));
    const byProperty = Object.entries(classReport).map(([property, data]) => {
      const charged = data.revenue || 0;
      const cls = classes.find(c => c.name === property);
      let collected = 0;
      if (cls) {
        journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate && (je.description||"").toLowerCase().includes("payment")).forEach(je => {
          (je.lines||[]).filter(l => arIds.has(l.account_id) && l.class_id === cls.id && safeNum(l.credit) > 0).forEach(l => { collected += safeNum(l.credit); });
        });
      }
      return { property, charged, collected, outstanding: charged - collected, collectionRate: charged > 0 ? Math.round(collected / charged * 100) : 0 };
    });
    const totals = { charged: byProperty.reduce((s,p) => s + p.charged, 0), collected: byProperty.reduce((s,p) => s + p.collected, 0), outstanding: byProperty.reduce((s,p) => s + p.outstanding, 0) };
    totals.collectionRate = totals.charged > 0 ? Math.round(totals.collected / totals.charged * 100) : 0;
    return { byProperty, totals };
  }

  function getTransactionsByAccount(startDate, endDate) {
    const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
    const byAccount = {};
    journalEntries.filter(je => je.status === "posted" && je.date >= startDate && je.date <= endDate).forEach(je => {
      (je.lines||[]).forEach(l => {
        const acct = acctMap[l.account_id];
        const name = acct?.name || l.account_name || "Unknown";
        if (!byAccount[name]) byAccount[name] = { type: acct?.type || "", code: acct?.code || "", transactions: [] };
        byAccount[name].transactions.push({ date: je.date, jeNumber: je.number, description: je.description, memo: l.memo, debit: safeNum(l.debit), credit: safeNum(l.credit) });
      });
    });
    return Object.entries(byAccount).sort((a,b) => (a[1].code||"").localeCompare(b[1].code||"")).map(([name, d]) => ({ name, ...d }));
  }

  // --- Phase C Computation Functions ---

  function getAPAgingData(asOfDate) {
    const apIds = new Set(accounts.filter(a => a.type === "Liability" && (a.name?.includes("Accounts Payable") || a.name?.includes("Payable") || (a.code||"").startsWith("2000"))).map(a => a.id));
    if (apIds.size === 0) return { summary: { current: 0, days30: 0, days60: 0, days90: 0, over90: 0, total: 0 }, byVendor: {} };
    const today = new Date();
    const byVendor = {};
    const summary = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0, total: 0 };
    journalEntries.filter(je => je.status === "posted" && je.date <= asOfDate).forEach(je => {
      (je.lines||[]).filter(l => apIds.has(l.account_id)).forEach(l => {
        const amount = safeNum(l.credit) - safeNum(l.debit); // credits increase AP
        if (Math.abs(amount) < 0.01) return;
        const vendor = je.description?.split(" — ")[0]?.trim() || l.memo?.split(":")[0]?.trim() || "Unknown";
        const daysDiff = Math.floor((today - parseLocalDate(je.date)) / 86400000);
        const bucket = daysDiff < 30 ? "current" : daysDiff < 60 ? "days30" : daysDiff < 90 ? "days60" : daysDiff < 120 ? "days90" : "over90";
        if (!byVendor[vendor]) byVendor[vendor] = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0, total: 0 };
        byVendor[vendor][bucket] += amount;
        byVendor[vendor].total += amount;
        summary[bucket] += amount;
        summary.total += amount;
      });
    });
    return { summary, byVendor };
  }

  function getUnpaidBills() {
    // Derive from vendor_invoices if available, otherwise from AP JE lines
    const bills = [];
    journalEntries.filter(je => je.status === "posted" && ((je.reference||"").startsWith("VINV-") || (je.description||"").toLowerCase().includes("invoice"))).forEach(je => {
      const total = (je.lines||[]).reduce((s,l) => s + safeNum(l.credit), 0);
      if (total > 0) {
        const vendor = je.description?.split(" — ")[0]?.trim() || "Unknown";
        bills.push({ vendor, date: je.date, description: je.description, amount: total, reference: je.reference, jeNumber: je.number });
      }
    });
    return bills.sort((a,b) => a.date.localeCompare(b.date));
  }

  function getVendorBalanceSummary(asOfDate) {
    const { byVendor } = getAPAgingData(asOfDate);
    return Object.entries(byVendor).filter(([,d]) => Math.abs(d.total) > 0.01).map(([vendor, d]) => ({ vendor, ...d })).sort((a,b) => b.total - a.total);
  }

  async function getAuditLog(startDate, endDate) {
    const { data } = await supabase.from("audit_trail").select("*").eq("company_id", companyId).gte("created_at", startDate + "T00:00:00").lte("created_at", endDate + "T23:59:59").order("created_at", { ascending: false }).limit(500);
    return data || [];
  }

  async function getReconSummary() {
    const { data } = await supabase.from("bank_reconciliations").select("*").eq("company_id", companyId).order("created_at", { ascending: false });
    return data || [];
  }

  // Audit/recon data (fetched on demand)
  const [auditData, setAuditData] = useState([]);
  const [reconData, setReconData] = useState([]);
  const [budgets, setBudgets] = useState([]);
  const [showBudgetEditor, setShowBudgetEditor] = useState(false);
  const [budgetMonth, setBudgetMonth] = useState(acctToday().slice(0, 7));
  const [customReports, setCustomReports] = useState(() => { try { const s = localStorage.getItem(`custom_reports_${companyId}`); return s ? JSON.parse(s) : []; } catch (e) { pmError("PM-4017", { raw: e, context: "reading custom reports from localStorage", silent: true }); return []; } });
  const [saveReportName, setSaveReportName] = useState("");

  // --- Phase D: Budget, Custom Reports, PDF ---

  async function fetchBudgets(month) {
    const { data } = await supabase.from("budgets").select("*").eq("company_id", companyId).eq("period", month);
    setBudgets(data || []);
  }

  async function saveBudget(accountId, accountName, amount) {
    if (!guardSubmit("saveBudget", accountId)) return;
    try {
      const { error } = await supabase.from("budgets").upsert({
        company_id: companyId, account_id: accountId, account_name: accountName,
        period: budgetMonth, amount: Number(amount) || 0
      }, { onConflict: "company_id,account_id,period" });
      if (error) { pmError("PM-4011", { raw: error, context: "saving budget" }); return; }
      fetchBudgets(budgetMonth);
    } finally { guardRelease("saveBudget", accountId); }
  }

  function getBudgetVsActual(startDate, endDate) {
    const plData = getPLData(accounts, journalEntries, startDate, endDate, classFilter || null);
    const budgetMap = {};
    budgets.forEach(b => { budgetMap[b.account_id] = safeNum(b.amount); });
    // Calculate number of months in range for monthly budget scaling
    const months = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / (30 * 86400000)));
    const allAccounts = [...plData.revenue, ...plData.expenses];
    return allAccounts.map(a => {
      const monthlyBudget = budgetMap[a.id] || 0;
      const periodBudget = monthlyBudget * months;
      const variance = a.amount - periodBudget;
      const variancePct = periodBudget > 0 ? Math.round(variance / periodBudget * 100) : 0;
      return { ...a, budget: periodBudget, variance, variancePct, isExpense: plData.expenses.some(e => e.id === a.id) };
    }).filter(a => a.amount !== 0 || a.budget !== 0);
  }

  function saveCustomReport() {
    if (!saveReportName.trim() || !currentReport) return;
    const config = { id: shortId(), name: saveReportName.trim(), reportId: currentReport.id, reportTitle: currentReport.title, period, customDates, asOfDate, compareTo, classFilter, selectedAccountId, savedAt: new Date().toISOString() };
    const next = [...customReports, config];
    setCustomReports(next);
    try { localStorage.setItem(`custom_reports_${companyId}`, JSON.stringify(next)); } catch (e) { pmError("PM-4018", { raw: e, context: "saving custom report config to localStorage", silent: true }); }
    setSaveReportName("");
    showToast("Report configuration saved.", "success");
  }

  function deleteCustomReport(configId) {
    const next = customReports.filter(c => c.id !== configId);
    setCustomReports(next);
    try { localStorage.setItem(`custom_reports_${companyId}`, JSON.stringify(next)); } catch (e) { pmError("PM-4019", { raw: e, context: "saving custom report config to localStorage", silent: true }); }
  }

  function loadCustomReport(config) {
    setPeriod(config.period || "This Year");
    if (config.customDates) setCustomDates(config.customDates);
    if (config.asOfDate) setAsOfDate(config.asOfDate);
    if (config.compareTo) setCompareTo(config.compareTo);
    if (config.classFilter) setClassFilter(config.classFilter);
    if (config.selectedAccountId) setSelectedAccountId(config.selectedAccountId);
    const report = allReports.find(r => r.id === config.reportId);
    if (report) openReport(report);
  }

  function exportPDF() {
    if (!currentReport) return;
    const content = document.querySelector("[data-report-content]");
    if (!content) { showToast("Nothing to export.", "info"); return; }
    const clone = content.cloneNode(true);
    clone.querySelectorAll(".material-icons-outlined, .material-icons").forEach(el => el.remove());
    Array.from(clone.childNodes).forEach(n => { if (n.nodeType === 3 && /^\s*[\)\}\(\{]*\s*$/.test(n.textContent)) n.remove(); });
    const baseCss = `body{font-family:Arial,sans-serif;margin:30px 40px;color:#1e293b;font-size:13px}
*{box-sizing:border-box}
.flex{display:flex}.items-center{align-items:center}.justify-between{justify-content:space-between}.justify-center{justify-content:center}.gap-1{gap:4px}.gap-2{gap:8px}.gap-3{gap:12px}
.text-center{text-align:center}.text-right{text-align:right}.text-left{text-align:left}
.text-xs{font-size:11px}.text-sm{font-size:13px}.text-base{font-size:15px}.text-lg{font-size:17px}
.font-mono{font-family:ui-monospace,SFMono-Regular,monospace}.font-bold{font-weight:700}.font-black{font-weight:900}.font-semibold{font-weight:600}.font-medium{font-weight:500}
.tabular-nums{font-variant-numeric:tabular-nums}
.uppercase{text-transform:uppercase}.tracking-widest{letter-spacing:0.1em}.tracking-wider{letter-spacing:0.05em}
.border-t{border-top:1px solid #e5e7eb}.border-b{border-bottom:1px solid #e5e7eb}.border-t-2{border-top:2px solid #1e293b}.border-b-2{border-bottom:2px solid #1e293b}
.py-1{padding-top:4px;padding-bottom:4px}.py-1\\.5{padding-top:6px;padding-bottom:6px}.py-2{padding-top:8px;padding-bottom:8px}.py-3{padding-top:12px;padding-bottom:12px}
.mt-1{margin-top:4px}.mt-2{margin-top:8px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}.mb-1{margin-bottom:4px}.mb-2{margin-bottom:8px}.mb-4{margin-bottom:16px}.mb-6{margin-bottom:24px}
.rounded{border-radius:4px}
.text-neutral-400{color:#94a3b8}.text-neutral-500{color:#64748b}.text-neutral-700{color:#334155}.text-neutral-800{color:#1e293b}.text-neutral-900{color:#0f172a}
.text-success-700{color:#15803d}.text-danger-600{color:#dc2626}
table{width:100%;border-collapse:collapse}th,td{padding:6px 10px;border-bottom:1px solid #e5e7eb}th{background:#f8fafc;font-size:11px;text-transform:uppercase;color:#64748b;font-weight:600}
.whitespace-nowrap{white-space:nowrap}.min-w-48{min-width:12rem}
.px-3{padding-left:12px;padding-right:12px}.px-4{padding-left:16px;padding-right:16px}.px-5{padding-left:20px;padding-right:20px}
.hidden,[class*="cursor-pointer"]{cursor:default}
.grid{display:grid}.grid-cols-4{grid-template-columns:repeat(4,1fr)}`;

    // For wide columnar reports (P&L by Property), split into pages
    const table = clone.querySelector("table");
    const isWideReport = currentReport.id === "pl_by_class" && table;
    if (isWideReport) {
      const headerRow = table.querySelector("thead tr");
      const bodyRows = table.querySelectorAll("tbody tr");
      const allThs = headerRow ? Array.from(headerRow.children) : [];
      const propCount = allThs.length - 1; // first column is label
      const COLS_PER_PAGE = 8;
      const headerHtml = clone.querySelector(".text-center.mb-6")?.outerHTML || "";
      let pages = "";
      for (let i = 0; i < propCount; i += COLS_PER_PAGE) {
        const colIndices = [0]; // always include label column
        for (let c = i + 1; c <= Math.min(i + COLS_PER_PAGE, propCount); c++) colIndices.push(c);
        const pageLabel = `Properties ${i + 1}–${Math.min(i + COLS_PER_PAGE, propCount)} of ${propCount}`;
        let tbl = "<table><thead><tr>";
        colIndices.forEach(ci => { tbl += allThs[ci] ? `<th${ci === 0 ? ' style="text-align:left;min-width:180px"' : ' style="text-align:right;min-width:90px"'}>${allThs[ci].textContent}</th>` : ""; });
        tbl += "</tr></thead><tbody>";
        bodyRows.forEach(row => {
          const tds = Array.from(row.children);
          const colSpanTd = tds.length === 1 && tds[0].getAttribute("colspan");
          if (colSpanTd) {
            tbl += `<tr><td colspan="${colIndices.length}" style="padding:8px 12px;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;background:#f8fafc">${tds[0].textContent}</td></tr>`;
          } else {
            tbl += "<tr>";
            colIndices.forEach(ci => {
              const td = tds[ci];
              if (td) {
                const style = ci === 0 ? td.style.cssText : "text-align:right;font-family:ui-monospace,monospace;font-size:11px;";
                const fw = td.classList.contains("font-bold") || td.classList.contains("font-black") ? "font-weight:700;" : "";
                const color = td.classList.contains("text-danger-600") ? "color:#dc2626;" : "";
                tbl += `<td style="${style}${fw}${color}">${td.textContent}</td>`;
              }
            });
            tbl += "</tr>";
          }
        });
        tbl += "</tbody></table>";
        pages += `<div style="page-break-after:always">${headerHtml}<p style="text-align:center;font-size:11px;color:#94a3b8;margin-bottom:16px">${pageLabel}</p>${tbl}</div>`;
      }
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;border:0;visibility:hidden;";
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open();
      doc.write(`<!DOCTYPE html><html><head><title> </title><style>${baseCss}\n@media print{body{margin:10px 20px}@page{size:landscape;margin:0.25in 0.4in}}</style></head><body>${pages}</body></html>`);
      doc.close();
      setTimeout(() => { iframe.contentWindow.print(); setTimeout(() => document.body.removeChild(iframe), 1000); }, 500);
      return;
    }

    const safeBody = DOMPurify.sanitize(clone.innerHTML);
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`<!DOCTYPE html><html><head><title> </title><style>${baseCss}\n@media print{body{margin:10px 20px}@page{size:auto;margin:0.25in 0.4in}}</style></head><body>${safeBody}</body></html>`);
    doc.close();
    setTimeout(() => { iframe.contentWindow.print(); setTimeout(() => document.body.removeChild(iframe), 1000); }, 500);
  }

  // --- Excel Export (xlsx with formulas, sections, formatting) ---
  async function exportExcel() {
    if (!currentReport) return;
    const id = currentReport.id;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(currentReport.title);
    const $ = (n) => typeof n === "number" ? n : safeNum(n); // ensure numeric
    const money = '"$"#,##0.00';
    const pct = '0.0"%"';
    const colLetter = (c) => { let s = ""; while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); } return s; };

    // Style helpers
    const boldFont = { bold: true };
    const headerFont = { bold: true, size: 12 };
    const sectionFont = { bold: true, color: { argb: "FF64748B" }, size: 10 };
    const titleFont = { bold: true, size: 14 };
    const totalFont = { bold: true, size: 11 };
    const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
    const sectionFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
    const thinBorder = { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } };
    const thickBorder = { top: { style: "medium", color: { argb: "FF1E293B" } }, bottom: { style: "medium", color: { argb: "FF1E293B" } } };

    function addTitle(title, subtitle, dateRange) {
      const r1 = ws.addRow([companyName]); r1.getCell(1).font = titleFont;
      const r2 = ws.addRow([title]); r2.getCell(1).font = headerFont;
      if (subtitle) { const r3 = ws.addRow([subtitle]); r3.getCell(1).font = { italic: true, color: { argb: "FF64748B" } }; }
      if (dateRange) { const r4 = ws.addRow([dateRange]); r4.getCell(1).font = { color: { argb: "FF94A3B8" }, size: 10 }; }
      ws.addRow([]);
    }
    function addSectionHeader(label, colCount) {
      const r = ws.addRow([label]); r.getCell(1).font = sectionFont; r.getCell(1).fill = sectionFill;
      for (let i = 2; i <= colCount; i++) r.getCell(i).fill = sectionFill;
    }
    function styleHeaderRow(row, colCount) {
      for (let i = 1; i <= colCount; i++) { row.getCell(i).font = boldFont; row.getCell(i).fill = headerFill; row.getCell(i).border = thinBorder; }
    }
    function styleTotalRow(row, colCount, thick) {
      for (let i = 1; i <= colCount; i++) { row.getCell(i).font = totalFont; if (thick) row.getCell(i).border = thickBorder; }
    }

    try {
    // ===================== PROFIT & LOSS =====================
    if (id === "pl") {
      const d = getPLData(accounts, journalEntries, start, end, classFilter || null);
      addTitle("Profit & Loss", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Account", "Amount"]); styleHeaderRow(hr, 2);
      ws.getColumn(2).numFmt = money; ws.getColumn(1).width = 40; ws.getColumn(2).width = 18;
      // Income
      addSectionHeader("INCOME", 2);
      const incStart = ws.rowCount + 1;
      d.revenue.filter(a => a.amount !== 0).forEach(a => { const r = ws.addRow([`  ${a.name}`, $(a.amount)]); r.getCell(2).numFmt = money; });
      const incEnd = ws.rowCount;
      const tiRow = ws.addRow(["Total Income", incEnd >= incStart ? { formula: `SUM(B${incStart}:B${incEnd})` } : 0]);
      tiRow.getCell(2).numFmt = money; styleTotalRow(tiRow, 2, false);
      ws.addRow([]);
      // Expenses
      addSectionHeader("EXPENSES", 2);
      const expStart = ws.rowCount + 1;
      d.expenses.filter(a => a.amount !== 0).forEach(a => { const r = ws.addRow([`  ${a.name}`, $(a.amount)]); r.getCell(2).numFmt = money; });
      const expEnd = ws.rowCount;
      const teRow = ws.addRow(["Total Expenses", expEnd >= expStart ? { formula: `SUM(B${expStart}:B${expEnd})` } : 0]);
      teRow.getCell(2).numFmt = money; styleTotalRow(teRow, 2, false);
      ws.addRow([]);
      const niRow = ws.addRow(["Net Income", { formula: `B${tiRow.number}-B${teRow.number}` }]);
      niRow.getCell(2).numFmt = money; styleTotalRow(niRow, 2, true);

    // ===================== P&L BY PROPERTY =====================
    } else if (id === "pl_by_class") {
      const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
      const propData = {}; const accountsUsed = new Set();
      for (const je of journalEntries) {
        if (je.status !== "posted" || je.date < start || je.date > end) continue;
        for (const l of (je.lines || [])) {
          if (!l.class_id) continue; const acct = acctMap[l.account_id]; if (!acct) continue;
          if (!["Revenue","Other Income","Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) continue;
          if (!propData[l.class_id]) propData[l.class_id] = {};
          if (!propData[l.class_id][l.account_id]) propData[l.class_id][l.account_id] = 0;
          if (["Revenue","Other Income"].includes(acct.type)) propData[l.class_id][l.account_id] += safeNum(l.credit) - safeNum(l.debit);
          else propData[l.class_id][l.account_id] += safeNum(l.debit) - safeNum(l.credit);
          accountsUsed.add(l.account_id);
        }
      }
      const props = classes.filter(c => propData[c.id]).sort((a,b) => a.name.localeCompare(b.name));
      const val = (cid, aid) => propData[cid]?.[aid] || 0;
      const incomeAccts = accounts.filter(a => ["Revenue","Other Income"].includes(a.type) && accountsUsed.has(a.id)).sort((a,b) => a.code.localeCompare(b.code));
      const expenseAccts = accounts.filter(a => ["Expense","Cost of Goods Sold","Other Expense"].includes(a.type) && accountsUsed.has(a.id)).sort((a,b) => a.code.localeCompare(b.code));
      const nc = props.length + 1;
      addTitle("Profit & Loss by Property", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Account", ...props.map(p => p.name)]); styleHeaderRow(hr, nc);
      ws.getColumn(1).width = 30;
      for (let i = 2; i <= nc; i++) { ws.getColumn(i).width = 16; ws.getColumn(i).numFmt = money; }
      // Income
      addSectionHeader("INCOME", nc);
      const incStartRow = ws.rowCount + 1;
      incomeAccts.forEach(a => { const r = ws.addRow([`  ${a.name}`, ...props.map(p => $(val(p.id, a.id)) || 0)]); for (let i = 2; i <= nc; i++) r.getCell(i).numFmt = money; });
      const incEndRow = ws.rowCount;
      const tiR = ws.addRow(["Total Income"]);
      for (let i = 2; i <= nc; i++) { tiR.getCell(i).value = incEndRow >= incStartRow ? { formula: `SUM(${colLetter(i)}${incStartRow}:${colLetter(i)}${incEndRow})` } : 0; tiR.getCell(i).numFmt = money; }
      styleTotalRow(tiR, nc, false);
      ws.addRow([]);
      // Expenses
      addSectionHeader("EXPENSES", nc);
      const expStartRow = ws.rowCount + 1;
      expenseAccts.forEach(a => { const r = ws.addRow([`  ${a.name}`, ...props.map(p => $(val(p.id, a.id)) || 0)]); for (let i = 2; i <= nc; i++) r.getCell(i).numFmt = money; });
      const expEndRow = ws.rowCount;
      const teR = ws.addRow(["Total Expenses"]);
      for (let i = 2; i <= nc; i++) { teR.getCell(i).value = expEndRow >= expStartRow ? { formula: `SUM(${colLetter(i)}${expStartRow}:${colLetter(i)}${expEndRow})` } : 0; teR.getCell(i).numFmt = money; }
      styleTotalRow(teR, nc, false);
      ws.addRow([]);
      // Net Income = Total Income - Total Expenses
      const niR = ws.addRow(["Net Income"]);
      for (let i = 2; i <= nc; i++) { niR.getCell(i).value = { formula: `${colLetter(i)}${tiR.number}-${colLetter(i)}${teR.number}` }; niR.getCell(i).numFmt = money; }
      styleTotalRow(niR, nc, true);

    // ===================== P&L COMPARISON =====================
    } else if (id === "pl_compare") {
      const d1 = getPLData(accounts, journalEntries, start, end, classFilter || null);
      const compareEnd = start; const cStart = new Date(start); cStart.setFullYear(cStart.getFullYear() - 1);
      const d2 = getPLData(accounts, journalEntries, formatLocalDate(cStart), compareEnd, classFilter || null);
      addTitle("P&L Comparison", null, `${acctFmtDate(start)} – ${acctFmtDate(end)} vs Prior Year`);
      const hr = ws.addRow(["Account", "Current", "Prior", "Change", "% Change"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 35; [2,3,4].forEach(c => { ws.getColumn(c).width = 16; ws.getColumn(c).numFmt = money; }); ws.getColumn(5).width = 12; ws.getColumn(5).numFmt = pct;
      addSectionHeader("INCOME", 5);
      d1.revenue.filter(a => a.amount !== 0).forEach(a => {
        const prior = d2.revenue.find(b => b.id === a.id)?.amount || 0;
        const rn = ws.rowCount + 1;
        const r = ws.addRow([`  ${a.name}`, $(a.amount), $(prior), { formula: `B${rn}-C${rn}` }, prior !== 0 ? { formula: `D${rn}/C${rn}*100` } : 0]);
        [2,3,4].forEach(c => r.getCell(c).numFmt = money); r.getCell(5).numFmt = pct;
      });
      const tiR = ws.addRow(["Total Income", $(d1.totalRevenue), $(d2.totalRevenue), { formula: `B${ws.rowCount}-C${ws.rowCount}` }]);
      [2,3,4].forEach(c => tiR.getCell(c).numFmt = money); styleTotalRow(tiR, 5, false);
      ws.addRow([]); addSectionHeader("EXPENSES", 5);
      d1.expenses.filter(a => a.amount !== 0).forEach(a => {
        const prior = d2.expenses.find(b => b.id === a.id)?.amount || 0;
        const rn = ws.rowCount + 1;
        const r = ws.addRow([`  ${a.name}`, $(a.amount), $(prior), { formula: `B${rn}-C${rn}` }, prior !== 0 ? { formula: `D${rn}/C${rn}*100` } : 0]);
        [2,3,4].forEach(c => r.getCell(c).numFmt = money); r.getCell(5).numFmt = pct;
      });
      const teR = ws.addRow(["Total Expenses", $(d1.totalExpenses), $(d2.totalExpenses), { formula: `B${ws.rowCount}-C${ws.rowCount}` }]);
      [2,3,4].forEach(c => teR.getCell(c).numFmt = money); styleTotalRow(teR, 5, false);
      ws.addRow([]);
      const niR = ws.addRow(["Net Income", { formula: `B${tiR.number}-B${teR.number}` }, { formula: `C${tiR.number}-C${teR.number}` }, { formula: `B${ws.rowCount}-C${ws.rowCount}` }]);
      [2,3,4].forEach(c => niR.getCell(c).numFmt = money); styleTotalRow(niR, 5, true);

    // ===================== BALANCE SHEET =====================
    } else if (id === "bs") {
      const d = getBalanceSheetData(accounts, journalEntries, asOfDate);
      addTitle("Balance Sheet", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Account", "Amount"]); styleHeaderRow(hr, 2);
      ws.getColumn(1).width = 40; ws.getColumn(2).width = 18; ws.getColumn(2).numFmt = money;
      addSectionHeader("ASSETS", 2);
      const aStart = ws.rowCount + 1;
      d.assets.filter(a => a.amount !== 0).forEach(a => { ws.addRow([`  ${a.name}`, $(a.amount)]).getCell(2).numFmt = money; });
      const aEnd = ws.rowCount;
      const taR = ws.addRow(["Total Assets", aEnd >= aStart ? { formula: `SUM(B${aStart}:B${aEnd})` } : 0]); taR.getCell(2).numFmt = money; styleTotalRow(taR, 2, false);
      ws.addRow([]);
      addSectionHeader("LIABILITIES", 2);
      const lStart = ws.rowCount + 1;
      d.liabilities.filter(a => a.amount !== 0).forEach(a => { ws.addRow([`  ${a.name}`, $(a.amount)]).getCell(2).numFmt = money; });
      const lEnd = ws.rowCount;
      const tlR = ws.addRow(["Total Liabilities", lEnd >= lStart ? { formula: `SUM(B${lStart}:B${lEnd})` } : 0]); tlR.getCell(2).numFmt = money; styleTotalRow(tlR, 2, false);
      ws.addRow([]);
      addSectionHeader("EQUITY", 2);
      const eStart = ws.rowCount + 1;
      d.equity.filter(a => a.amount !== 0).forEach(a => { ws.addRow([`  ${a.name}`, $(a.amount)]).getCell(2).numFmt = money; });
      if (d.netIncome !== 0) ws.addRow(["  Net Income (Current Period)", $(d.netIncome)]).getCell(2).numFmt = money;
      const eEnd = ws.rowCount;
      const teqR = ws.addRow(["Total Equity", eEnd >= eStart ? { formula: `SUM(B${eStart}:B${eEnd})` } : 0]); teqR.getCell(2).numFmt = money; styleTotalRow(teqR, 2, false);
      ws.addRow([]);
      const tlEqR = ws.addRow(["Total Liabilities & Equity", { formula: `B${tlR.number}+B${teqR.number}` }]); tlEqR.getCell(2).numFmt = money; styleTotalRow(tlEqR, 2, true);

    // ===================== GENERAL LEDGER =====================
    } else if (id === "gl") {
      const glLines = getGeneralLedger(selectedAccountId, accounts, journalEntries).filter(l => l.date >= start && l.date <= end);
      addTitle("General Ledger", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Date", "Entry", "Description", "Memo", "Debit", "Credit", "Balance"]); styleHeaderRow(hr, 7);
      ws.getColumn(1).width = 12; ws.getColumn(2).width = 10; ws.getColumn(3).width = 35; ws.getColumn(4).width = 25;
      [5,6,7].forEach(c => { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; });
      glLines.forEach(l => { const r = ws.addRow([l.date, l.jeNumber || "", l.description, l.memo || "", $(l.debit), $(l.credit), $(l.balance)]); [5,6,7].forEach(c => r.getCell(c).numFmt = money); });
      ws.addRow([]);
      const totR = ws.addRow(["", "", "", "Totals", { formula: `SUM(E${hr.number+1}:E${ws.rowCount-1})` }, { formula: `SUM(F${hr.number+1}:F${ws.rowCount-1})` }, ""]);
      [5,6].forEach(c => totR.getCell(c).numFmt = money); styleTotalRow(totR, 7, true);

    // ===================== TRIAL BALANCE =====================
    } else if (id === "tb") {
      const tbData = getTrialBalance(accounts, journalEntries, start, end);
      addTitle("Trial Balance", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Code", "Account", "Debit", "Credit"]); styleHeaderRow(hr, 4);
      ws.getColumn(1).width = 10; ws.getColumn(2).width = 35; [3,4].forEach(c => { ws.getColumn(c).width = 16; ws.getColumn(c).numFmt = money; });
      const dStart = ws.rowCount + 1;
      tbData.filter(a => a.debitBalance !== 0 || a.creditBalance !== 0).forEach(a => {
        const r = ws.addRow([a.code || "", a.name, $(a.debitBalance), $(a.creditBalance)]); [3,4].forEach(c => r.getCell(c).numFmt = money);
      });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "Totals", dEnd >= dStart ? { formula: `SUM(C${dStart}:C${dEnd})` } : 0, dEnd >= dStart ? { formula: `SUM(D${dStart}:D${dEnd})` } : 0]);
      [3,4].forEach(c => totR.getCell(c).numFmt = money); styleTotalRow(totR, 4, true);

    // ===================== CASH FLOW =====================
    } else if (id === "cash_flow") {
      const cf = getCashFlowData(start, end);
      addTitle("Cash Flow Statement", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Item", "Amount"]); styleHeaderRow(hr, 2);
      ws.getColumn(1).width = 40; ws.getColumn(2).width = 18; ws.getColumn(2).numFmt = money;
      if (cf && typeof cf === "object") {
        Object.entries(cf).forEach(([section, items]) => {
          if (Array.isArray(items)) { addSectionHeader(section, 2); items.forEach(i => { ws.addRow([`  ${i.name || i.label || ""}`, $(i.amount || i.value || 0)]).getCell(2).numFmt = money; }); }
        });
      }

    // ===================== AR AGING SUMMARY =====================
    } else if (id === "ar_aging_summary") {
      const bsData = getBalanceSheetData(accounts, journalEntries, asOfDate);
      addTitle("AR Aging Summary", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Tenant", "Current", "1-30", "31-60", "61-90", "Over 90", "Total"]); styleHeaderRow(hr, 7);
      ws.getColumn(1).width = 30; for (let c = 2; c <= 7; c++) { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; }
      const dStart = ws.rowCount + 1;
      (bsData.arAgingByTenant || []).filter(t => t.total !== 0).forEach(t => {
        const r = ws.addRow([t.tenant, $(t.current), $(t.days30), $(t.days60), $(t.days90), $(t.over90), { formula: `SUM(B${ws.rowCount+1}:F${ws.rowCount+1})` }]);
        // Fix: formula refs point to current row, need to adjust after addRow
        r.getCell(7).value = { formula: `SUM(B${r.number}:F${r.number})` };
        for (let c = 2; c <= 7; c++) r.getCell(c).numFmt = money;
      });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["Totals"]); for (let c = 2; c <= 7; c++) { totR.getCell(c).value = dEnd >= dStart ? { formula: `SUM(${colLetter(c)}${dStart}:${colLetter(c)}${dEnd})` } : 0; totR.getCell(c).numFmt = money; }
      styleTotalRow(totR, 7, true);

    // ===================== CUSTOMER BALANCE SUMMARY =====================
    } else if (id === "customer_balance_summary") {
      const bsData = getBalanceSheetData(accounts, journalEntries, asOfDate);
      addTitle("Tenant Balance Summary", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Tenant", "Balance"]); styleHeaderRow(hr, 2);
      ws.getColumn(1).width = 35; ws.getColumn(2).width = 16; ws.getColumn(2).numFmt = money;
      const dStart = ws.rowCount + 1;
      (bsData.arByTenant || []).filter(t => t.balance !== 0).forEach(t => { ws.addRow([t.tenant, $(t.balance)]).getCell(2).numFmt = money; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["Total", dEnd >= dStart ? { formula: `SUM(B${dStart}:B${dEnd})` } : 0]); totR.getCell(2).numFmt = money; styleTotalRow(totR, 2, true);

    // ===================== OPEN INVOICES =====================
    } else if (id === "open_invoices") {
      const data = getOpenInvoices(asOfDate);
      addTitle("Open Invoices", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Tenant", "Date", "Description", "Original", "Paid", "Due", "Days Out"]); styleHeaderRow(hr, 7);
      ws.getColumn(1).width = 25; ws.getColumn(2).width = 12; ws.getColumn(3).width = 30;
      [4,5,6].forEach(c => { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; }); ws.getColumn(7).width = 10;
      const dStart = ws.rowCount + 1;
      data.forEach(i => { const r = ws.addRow([i.tenant, i.date, i.description, $(i.originalAmount), $(i.amountPaid), $(i.amountDue), i.daysOutstanding]); [4,5,6].forEach(c => r.getCell(c).numFmt = money); });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "", "Totals"]); [4,5,6].forEach(c => { totR.getCell(c).value = dEnd >= dStart ? { formula: `SUM(${colLetter(c)}${dStart}:${colLetter(c)}${dEnd})` } : 0; totR.getCell(c).numFmt = money; });
      styleTotalRow(totR, 7, true);

    // ===================== COLLECTIONS =====================
    } else if (id === "collections") {
      const data = getCollectionsReport(asOfDate);
      addTitle("Collections Report", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Tenant", "Property", "Email", "Phone", "Current", "1-30", "31-60", "61-90", "Over 90", "Total"]); styleHeaderRow(hr, 10);
      ws.getColumn(1).width = 25; ws.getColumn(2).width = 20; ws.getColumn(3).width = 25; ws.getColumn(4).width = 15;
      for (let c = 5; c <= 10; c++) { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; }
      data.forEach(t => { const r = ws.addRow([t.tenant, t.property, t.email, t.phone, $(t.current), $(t.days30), $(t.days60), $(t.days90), $(t.over90), { formula: `SUM(E${ws.rowCount+1}:I${ws.rowCount+1})` }]); r.getCell(10).value = { formula: `SUM(E${r.number}:I${r.number})` }; for (let c = 5; c <= 10; c++) r.getCell(c).numFmt = money; });

    // ===================== AP AGING SUMMARY =====================
    } else if (id === "ap_aging_summary") {
      const apData = getAPAgingData(asOfDate);
      addTitle("AP Aging Summary", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Vendor", "Current", "1-30", "31-60", "61-90", "Over 90", "Total"]); styleHeaderRow(hr, 7);
      ws.getColumn(1).width = 30; for (let c = 2; c <= 7; c++) { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; }
      const dStart = ws.rowCount + 1;
      Object.entries(apData.byVendor || {}).forEach(([vendor, d]) => {
        const r = ws.addRow([vendor, $(d.current), $(d.days30), $(d.days60), $(d.days90), $(d.over90)]); r.getCell(7).value = { formula: `SUM(B${r.number}:F${r.number})` };
        for (let c = 2; c <= 7; c++) r.getCell(c).numFmt = money;
      });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["Totals"]); for (let c = 2; c <= 7; c++) { totR.getCell(c).value = dEnd >= dStart ? { formula: `SUM(${colLetter(c)}${dStart}:${colLetter(c)}${dEnd})` } : 0; totR.getCell(c).numFmt = money; }
      styleTotalRow(totR, 7, true);

    // ===================== UNPAID BILLS =====================
    } else if (id === "unpaid_bills") {
      const data = getUnpaidBills();
      addTitle("Unpaid Bills", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Date", "Vendor", "Description", "Reference", "Amount"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 12; ws.getColumn(2).width = 25; ws.getColumn(3).width = 35; ws.getColumn(4).width = 12; ws.getColumn(5).width = 16; ws.getColumn(5).numFmt = money;
      const dStart = ws.rowCount + 1;
      data.forEach(b => { ws.addRow([b.date, b.vendor, b.description, b.jeNumber || "", $(b.amount)]).getCell(5).numFmt = money; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "", "", "Total", dEnd >= dStart ? { formula: `SUM(E${dStart}:E${dEnd})` } : 0]); totR.getCell(5).numFmt = money; styleTotalRow(totR, 5, true);

    // ===================== VENDOR BALANCE SUMMARY =====================
    } else if (id === "vendor_balance_summary") {
      const data = getVendorBalanceSummary(asOfDate);
      addTitle("Vendor Balance Summary", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Vendor", "Current", "1-30", "31-60", "61-90", "Over 90", "Total"]); styleHeaderRow(hr, 7);
      ws.getColumn(1).width = 30; for (let c = 2; c <= 7; c++) { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; }
      const dStart = ws.rowCount + 1;
      data.forEach(v => { const r = ws.addRow([v.vendor, $(v.current), $(v.days30), $(v.days60), $(v.days90), $(v.over90)]); r.getCell(7).value = { formula: `SUM(B${r.number}:F${r.number})` }; for (let c = 2; c <= 7; c++) r.getCell(c).numFmt = money; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["Totals"]); for (let c = 2; c <= 7; c++) { totR.getCell(c).value = dEnd >= dStart ? { formula: `SUM(${colLetter(c)}${dStart}:${colLetter(c)}${dEnd})` } : 0; totR.getCell(c).numFmt = money; }
      styleTotalRow(totR, 7, true);

    // ===================== EXPENSES BY CATEGORY =====================
    } else if (id === "expenses_by_category") {
      const data = getExpensesByCategory(start, end);
      addTitle("Expenses by Category", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Category", "Amount", "% of Total"]); styleHeaderRow(hr, 3);
      ws.getColumn(1).width = 35; ws.getColumn(2).width = 16; ws.getColumn(2).numFmt = money; ws.getColumn(3).width = 12; ws.getColumn(3).numFmt = pct;
      const dStart = ws.rowCount + 1;
      data.forEach(e => { const r = ws.addRow([e.name, $(e.amount), $(e.percentage)]); r.getCell(2).numFmt = money; r.getCell(3).numFmt = pct; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["Total", dEnd >= dStart ? { formula: `SUM(B${dStart}:B${dEnd})` } : 0, 100]); totR.getCell(2).numFmt = money; totR.getCell(3).numFmt = pct; styleTotalRow(totR, 3, true);

    // ===================== EXPENSES BY VENDOR =====================
    } else if (id === "expenses_by_vendor") {
      const data = getExpensesByVendor(start, end);
      addTitle("Expenses by Vendor", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Vendor", "Amount", "% of Total"]); styleHeaderRow(hr, 3);
      ws.getColumn(1).width = 35; ws.getColumn(2).width = 16; ws.getColumn(2).numFmt = money; ws.getColumn(3).width = 12; ws.getColumn(3).numFmt = pct;
      const dStart = ws.rowCount + 1;
      data.forEach(e => { const r = ws.addRow([e.vendor, $(e.total), $(e.percentage)]); r.getCell(2).numFmt = money; r.getCell(3).numFmt = pct; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["Total", dEnd >= dStart ? { formula: `SUM(B${dStart}:B${dEnd})` } : 0, 100]); totR.getCell(2).numFmt = money; totR.getCell(3).numFmt = pct; styleTotalRow(totR, 3, true);

    // ===================== RENT ROLL =====================
    } else if (id === "rent_roll") {
      const data = getRentRoll();
      addTitle("Rent Roll", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Property", "Tenant", "Rent", "Deposit", "Lease Start", "Lease End", "Status"]); styleHeaderRow(hr, 7);
      ws.getColumn(1).width = 30; ws.getColumn(2).width = 25; ws.getColumn(3).width = 14; ws.getColumn(3).numFmt = money; ws.getColumn(4).width = 14; ws.getColumn(4).numFmt = money;
      ws.getColumn(5).width = 12; ws.getColumn(6).width = 12; ws.getColumn(7).width = 12;
      const dStart = ws.rowCount + 1;
      data.forEach(r => { const row = ws.addRow([r.property, r.tenant, $(r.rent), $(r.deposit || 0), r.leaseStart, r.leaseEnd, r.status]); row.getCell(3).numFmt = money; row.getCell(4).numFmt = money; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "Total Rent", dEnd >= dStart ? { formula: `SUM(C${dStart}:C${dEnd})` } : 0]); totR.getCell(3).numFmt = money; styleTotalRow(totR, 7, true);

    // ===================== VACANCY =====================
    } else if (id === "vacancy") {
      const data = getVacancyReport();
      addTitle("Vacancy Report", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Property", "Last Tenant", "Move Out", "Days Vacant", "Last Rent", "Est. Lost Revenue"]); styleHeaderRow(hr, 6);
      ws.getColumn(1).width = 30; ws.getColumn(2).width = 20; ws.getColumn(3).width = 12; ws.getColumn(4).width = 14; ws.getColumn(5).width = 14; ws.getColumn(5).numFmt = money; ws.getColumn(6).width = 18; ws.getColumn(6).numFmt = money;
      const dStart = ws.rowCount + 1;
      data.forEach(v => { const r = ws.addRow([v.property, v.lastTenant || "—", v.moveOutDate || "—", v.daysVacant, $(v.lastRent || 0), $(v.estimatedLost || 0)]); r.getCell(5).numFmt = money; r.getCell(6).numFmt = money; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "", "", "", "", dEnd >= dStart ? { formula: `SUM(F${dStart}:F${dEnd})` } : 0]); totR.getCell(6).numFmt = money; styleTotalRow(totR, 6, true);

    // ===================== LICENSE COMPLIANCE =====================
    } else if (id === "license_compliance") {
      const data = getLicenseCompliance();
      addTitle("License Compliance Report", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Property", "Type", "Number", "Jurisdiction", "Issue Date", "Expiry Date", "Days Until", "Status", "Fee"]); styleHeaderRow(hr, 9);
      ws.getColumn(1).width = 32; ws.getColumn(2).width = 22; ws.getColumn(3).width = 16; ws.getColumn(4).width = 26; ws.getColumn(5).width = 12; ws.getColumn(6).width = 12; ws.getColumn(7).width = 10; ws.getColumn(8).width = 16; ws.getColumn(9).width = 12; ws.getColumn(9).numFmt = money;
      const dStart = ws.rowCount + 1;
      data.forEach(r => { const row = ws.addRow([r.property, r.type, r.number || "—", r.jurisdiction || "—", r.issueDate || "—", r.expiryDate, r.daysUntil, r.status.replace("_", " "), $(r.fee || 0)]); row.getCell(9).numFmt = money; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "", "", "", "", "", "", "TOTAL FEES", dEnd >= dStart ? { formula: `SUM(I${dStart}:I${dEnd})` } : 0]); totR.getCell(9).numFmt = money; styleTotalRow(totR, 9, true);

    // ===================== LEASE EXPIRATIONS =====================
    } else if (id === "lease_expirations") {
      const data = getLeaseExpirations(90);
      addTitle("Lease Expirations", null, "Next 90 Days");
      const hr = ws.addRow(["Tenant", "Property", "Lease End", "Days Until", "Rent"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 25; ws.getColumn(2).width = 30; ws.getColumn(3).width = 12; ws.getColumn(4).width = 12; ws.getColumn(5).width = 14; ws.getColumn(5).numFmt = money;
      data.forEach(l => { ws.addRow([l.tenant, l.property, l.leaseEnd, l.daysUntilExpiration, $(l.rent)]).getCell(5).numFmt = money; });

    // ===================== RENT COLLECTION =====================
    } else if (id === "rent_collection") {
      const data = getRentCollectionSummary(start, end);
      addTitle("Rent Collection Summary", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Property", "Charged", "Collected", "Outstanding", "Collection Rate"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 30; [2,3,4].forEach(c => { ws.getColumn(c).width = 16; ws.getColumn(c).numFmt = money; }); ws.getColumn(5).width = 14; ws.getColumn(5).numFmt = pct;
      const dStart = ws.rowCount + 1;
      (data.byProperty || []).forEach(p => {
        const rn = ws.rowCount + 1;
        const r = ws.addRow([p.property, $(p.charged), $(p.collected), { formula: `B${rn}-C${rn}` }, p.charged > 0 ? { formula: `C${rn}/B${rn}*100` } : 0]);
        [2,3,4].forEach(c => r.getCell(c).numFmt = money); r.getCell(5).numFmt = pct;
      });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["Totals"]); [2,3].forEach(c => { totR.getCell(c).value = dEnd >= dStart ? { formula: `SUM(${colLetter(c)}${dStart}:${colLetter(c)}${dEnd})` } : 0; totR.getCell(c).numFmt = money; });
      totR.getCell(4).value = { formula: `B${totR.number}-C${totR.number}` }; totR.getCell(4).numFmt = money;
      totR.getCell(5).value = { formula: `IF(B${totR.number}=0,0,C${totR.number}/B${totR.number}*100)` }; totR.getCell(5).numFmt = pct;
      styleTotalRow(totR, 5, true);

    // ===================== WORK ORDER SUMMARY =====================
    } else if (id === "work_orders_summary") {
      const data = getWorkOrderSummary(start, end);
      addTitle("Work Order Summary", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Property", "Issue", "Status", "Cost", "Days Open"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 25; ws.getColumn(2).width = 35; ws.getColumn(3).width = 14; ws.getColumn(4).width = 14; ws.getColumn(4).numFmt = money; ws.getColumn(5).width = 12;
      const dStart = ws.rowCount + 1;
      (data.items || []).forEach(w => { ws.addRow([w.property, w.issue, w.status, $(w.cost || 0), w.daysOpen || 0]).getCell(4).numFmt = money; });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "", "Total Cost", dEnd >= dStart ? { formula: `SUM(D${dStart}:D${dEnd})` } : 0, ""]); totR.getCell(4).numFmt = money; styleTotalRow(totR, 5, true);

    // ===================== SECURITY DEPOSITS =====================
    } else if (id === "security_deposits") {
      const data = getSecurityDepositLedger(asOfDate);
      addTitle("Security Deposit Ledger", null, `As of ${acctFmtDate(asOfDate)}`);
      const hr = ws.addRow(["Tenant", "Property", "Received", "Returned", "Net Held"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 25; ws.getColumn(2).width = 25; [3,4,5].forEach(c => { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; });
      const dStart = ws.rowCount + 1;
      data.forEach(d => {
        const rn = ws.rowCount + 1;
        const r = ws.addRow([d.tenant, d.property, $(d.received), $(d.returned), { formula: `C${rn}-D${rn}` }]);
        [3,4,5].forEach(c => r.getCell(c).numFmt = money);
      });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "Totals"]); [3,4,5].forEach(c => { totR.getCell(c).value = dEnd >= dStart ? { formula: `SUM(${colLetter(c)}${dStart}:${colLetter(c)}${dEnd})` } : 0; totR.getCell(c).numFmt = money; });
      styleTotalRow(totR, 5, true);

    // ===================== NOI BY PROPERTY =====================
    } else if (id === "noi_by_property") {
      const data = getNOIByProperty(start, end);
      addTitle("NOI by Property", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Property", "Revenue", "Expenses", "NOI", "NOI Margin"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 30; [2,3,4].forEach(c => { ws.getColumn(c).width = 16; ws.getColumn(c).numFmt = money; }); ws.getColumn(5).width = 14; ws.getColumn(5).numFmt = pct;
      const dStart = ws.rowCount + 1;
      data.forEach(p => {
        const rn = ws.rowCount + 1;
        const r = ws.addRow([p.property, $(p.revenue), $(p.expenses), { formula: `B${rn}-C${rn}` }, p.revenue > 0 ? { formula: `D${rn}/B${rn}*100` } : 0]);
        [2,3,4].forEach(c => r.getCell(c).numFmt = money); r.getCell(5).numFmt = pct;
      });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["Totals"]); [2,3].forEach(c => { totR.getCell(c).value = dEnd >= dStart ? { formula: `SUM(${colLetter(c)}${dStart}:${colLetter(c)}${dEnd})` } : 0; totR.getCell(c).numFmt = money; });
      totR.getCell(4).value = { formula: `B${totR.number}-C${totR.number}` }; totR.getCell(4).numFmt = money;
      totR.getCell(5).value = { formula: `IF(B${totR.number}=0,0,D${totR.number}/B${totR.number}*100)` }; totR.getCell(5).numFmt = pct;
      styleTotalRow(totR, 5, true);

    // ===================== TRANSACTIONS BY DATE =====================
    } else if (id === "txn_by_date") {
      const data = getTransactionsByDate(start, end);
      addTitle("Transaction List by Date", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Date", "Entry", "Account", "Type", "Description", "Memo", "Debit", "Credit"]); styleHeaderRow(hr, 8);
      ws.getColumn(1).width = 12; ws.getColumn(2).width = 10; ws.getColumn(3).width = 25; ws.getColumn(4).width = 14; ws.getColumn(5).width = 30; ws.getColumn(6).width = 20;
      [7,8].forEach(c => { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; });
      const dStart = ws.rowCount + 1;
      data.forEach(t => { const r = ws.addRow([t.date, t.jeNumber || "", t.accountName, t.accountType || "", t.description, t.memo || "", $(t.debit), $(t.credit)]); [7,8].forEach(c => r.getCell(c).numFmt = money); });
      const dEnd = ws.rowCount;
      const totR = ws.addRow(["", "", "", "", "", "Totals", dEnd >= dStart ? { formula: `SUM(G${dStart}:G${dEnd})` } : 0, dEnd >= dStart ? { formula: `SUM(H${dStart}:H${dEnd})` } : 0]);
      [7,8].forEach(c => totR.getCell(c).numFmt = money); styleTotalRow(totR, 8, true);

    // ===================== JOURNAL =====================
    } else if (id === "journal") {
      const data = getJournalReport(start, end);
      addTitle("Journal", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Date", "Entry", "Description", "Account", "Memo", "Debit", "Credit"]); styleHeaderRow(hr, 7);
      ws.getColumn(1).width = 12; ws.getColumn(2).width = 10; ws.getColumn(3).width = 30; ws.getColumn(4).width = 25; ws.getColumn(5).width = 20;
      [6,7].forEach(c => { ws.getColumn(c).width = 14; ws.getColumn(c).numFmt = money; });
      data.forEach(je => {
        (je.lines || []).forEach((l, i) => {
          const r = ws.addRow([i === 0 ? je.date : "", i === 0 ? je.jeNumber : "", i === 0 ? je.description : "", l.accountName, l.memo || "", $(l.debit), $(l.credit)]);
          [6,7].forEach(c => r.getCell(c).numFmt = money);
          if (i === 0) { r.getCell(1).font = boldFont; r.getCell(2).font = boldFont; r.getCell(3).font = boldFont; }
        });
      });

    // ===================== ACCOUNT LISTING =====================
    } else if (id === "account_list") {
      addTitle("Chart of Accounts", null, "");
      const hr = ws.addRow(["Code", "Name", "Type", "Subtype", "Active"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 12; ws.getColumn(2).width = 35; ws.getColumn(3).width = 16; ws.getColumn(4).width = 16; ws.getColumn(5).width = 10;
      accounts.sort((a,b) => (a.code||"").localeCompare(b.code||"")).forEach(a => {
        ws.addRow([a.code || "", a.name, a.type, a.subtype || "", a.is_active ? "Yes" : "No"]);
      });

    // ===================== BUDGET VS ACTUAL =====================
    } else if (id === "budget_vs_actual") {
      const data = getBudgetVsActual(start, end);
      addTitle("Budget vs. Actuals", null, `${acctFmtDate(start)} – ${acctFmtDate(end)}`);
      const hr = ws.addRow(["Account", "Budget", "Actual", "Variance", "% Used"]); styleHeaderRow(hr, 5);
      ws.getColumn(1).width = 35; [2,3,4].forEach(c => { ws.getColumn(c).width = 16; ws.getColumn(c).numFmt = money; }); ws.getColumn(5).width = 12; ws.getColumn(5).numFmt = pct;
      if (Array.isArray(data)) {
        data.forEach(d => {
          const rn = ws.rowCount + 1;
          const r = ws.addRow([d.name || d.account, $(d.budget || 0), $(d.actual || 0), { formula: `C${rn}-B${rn}` }, d.budget ? { formula: `C${rn}/B${rn}*100` } : 0]);
          [2,3,4].forEach(c => r.getCell(c).numFmt = money); r.getCell(5).numFmt = pct;
        });
      }

    } else {
      showToast("Export not available for this report.", "info"); return;
    }

    // Download
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${currentReport.id}-${acctToday()}.xlsx`; a.click();
    URL.revokeObjectURL(a.href);
    } catch (e) { console.error("Excel export error:", e); showToast("Export failed: " + e.message, "error"); }
  }

  // --- Print ---
  function printReport() { window.print(); }

  // ============ RENDER ============
  // CATALOG VIEW
  if (activeView === "catalog") {
    const filteredReports = searchQuery ? allReports.filter(r => r.title.toLowerCase().includes(searchQuery.toLowerCase()) || r.description.toLowerCase().includes(searchQuery.toLowerCase())) : null;
    const favReports = allReports.filter(r => favorites.includes(r.id));
    return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div><h3 className="text-lg font-semibold text-neutral-900">Reports</h3><p className="text-sm text-neutral-400">Run financial and property reports</p></div>
      </div>

      {/* Search */}
      <div className="relative mb-5">
        <span className="material-icons-outlined absolute left-3 top-1/2 -tranneutral-y-1/2 text-neutral-300">search</span>
        <input type="text" placeholder="Find report by name..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-3 border border-neutral-200 rounded-xl text-sm bg-white focus:ring-2 focus:ring-positive-200 focus:border-positive-400 transition-all" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-neutral-200">
        {[["standard","Standard Reports"],["favorites",`Favorites (${favReports.length})`],["custom","Custom Reports"]].map(([id,label]) => (
          <button key={id} onClick={() => setCatalogTab(id)} className={`px-4 py-2 text-sm font-medium border-b-2 ${catalogTab === id ? "border-positive-600 text-positive-700" : "border-transparent text-neutral-400 hover:text-neutral-600"}`}>{label}</button>
        ))}
      </div>

      {/* Search results */}
      {searchQuery && filteredReports && (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {filteredReports.map(r => (
        <div key={r.id} onClick={() => openReport(r)} className="group cursor-pointer border border-neutral-200 rounded-xl p-4 hover:border-positive-300 hover:shadow-md transition-all bg-white">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="material-icons-outlined text-neutral-400 group-hover:text-positive-600 text-xl">{r.icon}</span>
              <div><p className="text-sm font-semibold text-neutral-800 group-hover:text-positive-700">{r.title}</p><p className="text-xs text-neutral-400 mt-0.5">{r.description}</p></div>
            </div>
            <button onClick={e => { e.stopPropagation(); toggleFavorite(r.id); }} className="text-neutral-300 hover:text-warn-400"><span className="material-icons-outlined text-lg">{favorites.includes(r.id) ? "star" : "star_outline"}</span></button>
          </div>
        </div>
        ))}
        {filteredReports.length === 0 && <p className="col-span-4 text-center text-neutral-400 py-8">No reports match "{searchQuery}"</p>}
      </div>
      )}

      {/* Favorites tab */}
      {!searchQuery && catalogTab === "favorites" && (
      <div>{favReports.length === 0 ? <div className="text-center py-12 text-neutral-400"><span className="material-icons-outlined text-4xl mb-2 block">star_outline</span><p className="text-sm">No favorite reports yet. Click the star on any report to add it here.</p></div> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {favReports.map(r => (
          <div key={r.id} onClick={() => openReport(r)} className="group cursor-pointer border border-neutral-200 rounded-xl p-4 hover:border-positive-300 hover:shadow-md transition-all bg-white">
            <div className="flex items-start justify-between"><div className="flex items-center gap-3"><span className="material-icons-outlined text-neutral-400 group-hover:text-positive-600 text-xl">{r.icon}</span><div><p className="text-sm font-semibold text-neutral-800 group-hover:text-positive-700">{r.title}</p><p className="text-xs text-neutral-400 mt-0.5">{r.description}</p></div></div>
            <button onClick={e => { e.stopPropagation(); toggleFavorite(r.id); }} className="text-warn-400 hover:text-warn-500"><span className="material-icons-outlined text-lg">star</span></button></div>
          </div>))}
        </div>
      )}</div>
      )}

      {/* Custom reports tab */}
      {!searchQuery && catalogTab === "custom" && (
      <div>{customReports.length === 0 ? <div className="text-center py-12 text-neutral-400"><span className="material-icons-outlined text-4xl mb-2 block">tune</span><p className="text-sm">No saved report configurations yet.</p><p className="text-xs mt-1">Open any report, configure filters, then click "Save Config" in the toolbar.</p></div> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {customReports.map(c => (
          <div key={c.id} className="group border border-neutral-200 rounded-xl p-4 hover:border-positive-300 hover:shadow-md transition-all bg-white">
            <div className="flex items-start justify-between">
              <div className="cursor-pointer flex-1" onClick={() => loadCustomReport(c)}>
                <p className="text-sm font-semibold text-neutral-800 group-hover:text-positive-700">{c.name}</p>
                <p className="text-xs text-neutral-400 mt-0.5">{c.reportTitle} · {c.period}</p>
                <p className="text-xs text-neutral-300 mt-0.5">Saved {new Date(c.savedAt).toLocaleDateString()}</p>
              </div>
              <button onClick={() => deleteCustomReport(c.id)} className="text-neutral-300 hover:text-danger-500"><span className="material-icons-outlined text-sm">close</span></button>
            </div>
          </div>
          ))}
        </div>
      )}</div>
      )}

      {/* Standard reports — categorized */}
      {!searchQuery && catalogTab === "standard" && REPORT_CATALOG.map(cat => (
      <div key={cat.category} className="mb-6">
        <button onClick={() => setCollapsedCats(prev => ({...prev, [cat.category]: !prev[cat.category]}))} className="flex items-center gap-2 w-full text-left mb-3">
          <span className="material-icons-outlined text-sm text-neutral-400">{collapsedCats[cat.category] ? "chevron_right" : "expand_more"}</span>
          <h3 className="text-xs font-bold text-neutral-500 uppercase tracking-wider">{cat.category}</h3>
          <span className="text-xs text-neutral-300 ml-1">({cat.reports.length})</span>
        </button>
        {!collapsedCats[cat.category] && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {cat.reports.map(r => (
          <div key={r.id} onClick={() => openReport(r)} className="group cursor-pointer border border-neutral-200 rounded-xl p-4 hover:border-positive-300 hover:shadow-md transition-all bg-white">
            <div className="flex items-start justify-between"><div className="flex items-center gap-3"><span className="material-icons-outlined text-neutral-400 group-hover:text-positive-600 text-xl">{r.icon}</span><div><p className="text-sm font-semibold text-neutral-800 group-hover:text-positive-700">{r.title}</p><p className="text-xs text-neutral-400 mt-0.5">{r.description}</p></div></div>
            <button onClick={e => { e.stopPropagation(); toggleFavorite(r.id); }} className={favorites.includes(r.id) ? "text-warn-400 hover:text-warn-500" : "text-neutral-300 hover:text-warn-400"}><span className="material-icons-outlined text-lg">{favorites.includes(r.id) ? "star" : "star_outline"}</span></button></div>
          </div>))}
        </div>
        )}
      </div>
      ))}
    </div>
    );
  }

  // VIEWER VIEW
  const reportId = currentReport?.id;

  // Compute data based on report type
  const plData = getPLData(accounts, journalEntries, start, end, classFilter || null);
  let compareData = null;
  if (compareTo === "prior_period") { const ms = new Date(end).getTime() - new Date(start).getTime(); compareData = getPLData(accounts, journalEntries, formatLocalDate(new Date(new Date(start).getTime() - ms)), formatLocalDate(new Date(new Date(end).getTime() - ms)), classFilter || null); }
  if (compareTo === "prior_year") { const y = new Date(start).getFullYear(); compareData = getPLData(accounts, journalEntries, start.replace(String(y), String(y-1)), end.replace(String(y), String(y-1)), classFilter || null); }
  const bsData = getBalanceSheetData(accounts, journalEntries, asOfDate);
  const bsBalanced = Math.abs(bsData.totalAssets - (bsData.totalLiabilities + bsData.totalEquity)) < 0.01;
  const tbData = getTrialBalance(accounts, journalEntries, asOfDate);
  const allGlLines = getGeneralLedger(selectedAccountId, accounts, journalEntries);
  const glLines = allGlLines.filter(l => l.date >= start && l.date <= end);
  const glAccount = accounts.find(a => a.id === selectedAccountId);

  // Toolbar filter visibility
  const SHOW_PERIOD = true;
  const SHOW_AS_OF = ["bs","tb","ar_aging_summary","ar_aging_detail","customer_balance_summary","security_deposits"].includes(reportId);
  const SHOW_COMPARE = ["pl","pl_by_class","bs"].includes(reportId);
  const SHOW_CLASS = ["pl","pl_compare","expenses_by_category","gl","noi_by_property","rent_collection"].includes(reportId);
  const SHOW_ACCOUNT = reportId === "gl";

  return (
  <div>
    {/* Viewer Header */}
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <button onClick={() => setActiveView("catalog")} className="text-sm text-neutral-400 hover:text-neutral-700 flex items-center gap-1"><span className="material-icons-outlined text-sm">arrow_back</span>Back to Reports</button>
        <h3 className="text-lg font-semibold text-neutral-900">{currentReport?.title}</h3>
      </div>
      <div className="flex gap-2">
        <button onClick={() => toggleFavorite(reportId)} className={favorites.includes(reportId) ? "text-warn-400" : "text-neutral-300 hover:text-warn-400"}><span className="material-icons-outlined text-lg">{favorites.includes(reportId) ? "star" : "star_outline"}</span></button>
        <button onClick={exportExcel} className="text-xs bg-neutral-100 text-neutral-500 px-3 py-1.5 rounded-lg hover:bg-neutral-200 flex items-center gap-1"><span className="material-icons-outlined text-sm">download</span>Export</button>
        <button onClick={exportPDF} className="text-xs bg-neutral-100 text-neutral-500 px-3 py-1.5 rounded-lg hover:bg-neutral-200 flex items-center gap-1"><span className="material-icons-outlined text-sm">picture_as_pdf</span>PDF</button>
        <button onClick={printReport} className="text-xs bg-neutral-100 text-neutral-500 px-3 py-1.5 rounded-lg hover:bg-neutral-200 flex items-center gap-1"><span className="material-icons-outlined text-sm">print</span>Print</button>
      </div>
    </div>

    {/* Toolbar */}
    <div className="bg-neutral-50 rounded-xl p-4 mb-4 flex flex-wrap gap-3 items-end">
      {SHOW_PERIOD && (
      <div><label className="text-xs text-neutral-500 block mb-1">Period</label>
        <Select value={period} onChange={e => setPeriod(e.target.value)} className="py-1.5">
          {["This Month","Last Month","This Quarter","Last Quarter","This Year","Last Year","Custom"].map(p => <option key={p}>{p}</option>)}
        </Select></div>
      )}
      {period === "Custom" && <>
        <div><label className="text-xs text-neutral-500 block mb-1">From</label><Input type="date" value={start} onChange={e => setCustomDates({...customDates, start: e.target.value})} className="w-36" /></div>
        <div><label className="text-xs text-neutral-500 block mb-1">To</label><Input type="date" value={end} onChange={e => setCustomDates({...customDates, end: e.target.value})} className="w-36" /></div>
      </>}
      {SHOW_AS_OF && <div><label className="text-xs text-neutral-500 block mb-1">As of</label><Input type="date" value={asOfDate} onChange={e => setAsOfDate(e.target.value)} className="w-36" /></div>}
      {SHOW_COMPARE && <div><label className="text-xs text-neutral-500 block mb-1">Compare to</label><select value={compareTo} onChange={e => setCompareTo(e.target.value)} className="border border-neutral-200 rounded-lg px-3 py-1.5 text-sm bg-white"><option value="">No comparison</option><option value="prior_period">Prior Period</option><option value="prior_year">Prior Year</option></select></div>}
      {SHOW_CLASS && <div><label className="text-xs text-neutral-500 block mb-1">Property</label><select value={classFilter} onChange={e => setClassFilter(e.target.value)} className="border border-neutral-200 rounded-lg px-3 py-1.5 text-sm bg-white"><option value="">All Properties</option>{classes.filter(c=>c.is_active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
      {SHOW_ACCOUNT && <div><label className="text-xs text-neutral-500 block mb-1">Account</label><select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)} className="border border-neutral-200 rounded-lg px-3 py-1.5 text-sm bg-white min-w-48">{accounts.filter(a=>a.is_active).map(a => <option key={a.id} value={a.id}>{a.code||"•"} {a.name}</option>)}</select></div>}
      <div className="flex items-end gap-2 ml-auto">
        <input type="text" value={saveReportName} onChange={e => setSaveReportName(e.target.value)} placeholder="Save as..." className="border border-neutral-200 rounded-lg px-3 py-1.5 text-sm w-32" />
        <Btn variant="success-fill" size="sm" className="disabled:opacity-40 whitespace-nowrap" onClick={saveCustomReport} disabled={!saveReportName.trim()}>Save Config</Btn>
      </div>
    </div>

    {/* Report Content */}
    <div className="bg-white rounded-xl shadow-sm border border-neutral-200 p-6" data-report-content>

    {/* P&L */}
    {reportId === "pl" && (
    <div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Profit & Loss</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      <div className="cursor-pointer hover:bg-neutral-50 rounded py-1 flex items-center gap-1" onClick={() => setShowIncome(!showIncome)}><span className="material-icons-outlined text-sm text-neutral-400">{showIncome ? "expand_more" : "chevron_right"}</span><span className="text-sm font-bold text-neutral-900">Income</span></div>
      {showIncome && plData.revenue.filter(a => a.amount !== 0).map(a => <div key={a.id} className="flex justify-between py-1 cursor-pointer hover:bg-positive-50/30 rounded" style={{paddingLeft:24}} onClick={() => onOpenLedger && onOpenLedger([a.id], a.name)}><span className="text-sm text-neutral-700">{a.name}</span><span className="font-mono text-sm tabular-nums">{acctFmt(a.amount)}</span></div>)}
      {showIncome && <div className="flex justify-between py-1.5 border-t border-neutral-300 font-bold mt-1" style={{paddingLeft:24}}><span className="text-sm">Total Income</span><span className="font-mono text-sm tabular-nums">{acctFmt(plData.totalRevenue)}</span></div>}
      <div className="flex justify-between py-2 border-t-2 border-neutral-800 font-black mt-2"><span className="text-sm">Gross Profit</span><span className="font-mono text-sm tabular-nums">{acctFmt(plData.totalRevenue)}</span></div>
      <div className="cursor-pointer hover:bg-neutral-50 rounded py-1 mt-3 flex items-center gap-1" onClick={() => setShowExpenses(!showExpenses)}><span className="material-icons-outlined text-sm text-neutral-400">{showExpenses ? "expand_more" : "chevron_right"}</span><span className="text-sm font-bold text-neutral-900">Expenses</span></div>
      {showExpenses && plData.expenses.filter(a => a.amount !== 0).map(a => <div key={a.id} className="flex justify-between py-1 cursor-pointer hover:bg-positive-50/30 rounded" style={{paddingLeft:24}} onClick={() => onOpenLedger && onOpenLedger([a.id], a.name)}><span className="text-sm text-neutral-700">{a.name}</span><span className="font-mono text-sm tabular-nums">{acctFmt(a.amount)}</span></div>)}
      {showExpenses && <div className="flex justify-between py-1.5 border-t border-neutral-300 font-bold mt-1" style={{paddingLeft:24}}><span className="text-sm">Total Expenses</span><span className="font-mono text-sm tabular-nums">{acctFmt(plData.totalExpenses)}</span></div>}
      <div className="flex justify-between py-3 border-t-2 border-b-2 border-neutral-800 font-black mt-3"><span className="text-sm">NET INCOME</span><span className={`font-mono text-sm tabular-nums ${plData.netIncome < 0 ? "text-danger-600" : ""}`}>{acctFmt(plData.netIncome)}</span></div>
      <div className="text-xs text-neutral-400 mt-4 flex justify-between"><span>Accrual basis</span><span>{new Date().toLocaleString()}</span></div>
    </div>
    )}

    {/* Balance Sheet — reuse existing QB-style */}
    {reportId === "bs" && (() => {
    const bankAccounts = bsData.assets.filter(a => a.subtype === "Bank" || a.name?.includes("Checking") || a.name?.includes("Savings"));
    const arParentAccounts = bsData.assets.filter(a => (a.name === "Accounts Receivable" || (a.code || "") === "1100") && !(a.code || "").includes("-"));
    const arSubAccounts = bsData.assets.filter(a => (a.code || "").startsWith("1100-"));
    const arAllIds = new Set([...arParentAccounts, ...arSubAccounts].map(a => a.id));
    const otherAssets = bsData.assets.filter(a => !bankAccounts.includes(a) && !arAllIds.has(a.id));
    const BSRow = ({ name, amount, indent = 0, bold, total, onClick, italic }) => (<div className={`flex justify-between py-1 ${total ? "border-t border-neutral-300 font-bold mt-1" : ""} ${bold ? "font-semibold" : ""} ${onClick ? "cursor-pointer hover:bg-info-50/50 rounded" : ""}`} style={{ paddingLeft: indent * 24 }} onClick={onClick}><span className={`text-sm ${total ? "text-neutral-900" : "text-neutral-700"} ${italic ? "italic" : ""}`}>{name}</span><span className={`font-mono text-sm tabular-nums ${amount < 0 ? "text-danger-600" : total ? "text-neutral-900" : "text-neutral-700"}`}>{acctFmt(amount, true)}</span></div>);
    const BSSection = ({ title, children, show, toggle, total, totalLabel }) => (<div className="mb-2"><div className="cursor-pointer hover:bg-neutral-50 rounded py-1 flex items-center gap-1" onClick={toggle}><span className="material-icons-outlined text-sm text-neutral-400">{show ? "expand_more" : "chevron_right"}</span><span className="text-sm font-bold text-neutral-900">{title}</span></div>{show && children}{show && total !== undefined && (<div className="flex justify-between py-1.5 border-t border-b border-neutral-300 font-bold mt-1" style={{ paddingLeft: 24 }}><span className="text-sm text-neutral-900">{totalLabel || "Total " + title}</span><span className="font-mono text-sm text-neutral-900 tabular-nums">{acctFmt(total)}</span></div>)}</div>);
    return (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Balance Sheet</p><p className="text-sm text-neutral-500 mt-1">As of {acctFmtDate(asOfDate)}</p><div className="mt-2">{bsBalanced ? <span className="text-xs text-success-600 bg-success-50 px-3 py-1 rounded-full">Balanced</span> : <span className="text-xs text-danger-600 bg-danger-50 px-3 py-1 rounded-full">Out of Balance</span>}</div></div>
      <div className="flex justify-end mb-2 border-b border-neutral-200 pb-1"><span className="text-xs font-semibold text-neutral-500 uppercase">Total</span></div>
      <BSSection title="Assets" show={showAssets} toggle={() => setShowAssets(!showAssets)} total={bsData.totalAssets} totalLabel="TOTAL ASSETS">{bankAccounts.length > 0 && <div className="mb-1"><div className="text-xs font-semibold text-neutral-500 uppercase tracking-wide py-1" style={{paddingLeft:24}}>Bank Accounts</div>{bankAccounts.map(a => <BSRow key={a.id} name={a.name} amount={a.amount} indent={2} onClick={() => onOpenLedger && onOpenLedger([a.id], a.name)} />)}<div className="flex justify-between py-1 border-t border-neutral-200 font-semibold" style={{paddingLeft:48}}><span className="text-xs text-neutral-700">Total for Bank Accounts</span><span className="font-mono text-xs text-neutral-900 tabular-nums">{acctFmt(bankAccounts.reduce((s,a)=>s+a.amount,0))}</span></div></div>}{(arParentAccounts.length > 0 || arSubAccounts.length > 0) && <div className="mb-1"><div className="cursor-pointer text-xs font-semibold text-neutral-500 uppercase tracking-wide py-1 flex items-center gap-1" style={{paddingLeft:24}} onClick={() => setShowARSub(!showARSub)}><span className="material-icons-outlined text-xs">{showARSub ? "expand_more" : "chevron_right"}</span>Accounts Receivable</div>{showARSub && arSubAccounts.filter(a=>a.amount!==0).map(a => <BSRow key={a.id} name={a.name.replace("AR - ","")} amount={a.amount} indent={3} onClick={() => onOpenLedger && onOpenLedger([a.id], a.name)} />)}<div className="flex justify-between py-1 border-t border-neutral-200 font-semibold" style={{paddingLeft:48}}><span className="text-xs text-neutral-700">Total for AR</span><span className="font-mono text-xs text-neutral-900 tabular-nums">{acctFmt(arSubAccounts.length > 0 ? arSubAccounts.reduce((s,a)=>s+a.amount,0) : arParentAccounts.reduce((s,a)=>s+a.amount,0))}</span></div></div>}{otherAssets.filter(a=>a.amount!==0).map(a => <BSRow key={a.id} name={a.name} amount={a.amount} indent={1} onClick={() => onOpenLedger && onOpenLedger([a.id], a.name)} />)}</BSSection>
      <BSSection title="Liabilities" show={showLiabilities} toggle={() => setShowLiabilities(!showLiabilities)} total={bsData.totalLiabilities} totalLabel="Total Liabilities">{bsData.liabilities.filter(a=>a.amount!==0).map(a => <BSRow key={a.id} name={a.name} amount={a.amount} indent={1} onClick={() => onOpenLedger && onOpenLedger([a.id], a.name)} />)}</BSSection>
      <BSSection title="Equity" show={showEquity} toggle={() => setShowEquity(!showEquity)} total={bsData.totalEquity} totalLabel="Total Equity">{bsData.equity.filter(a=>a.amount!==0).map(a => <BSRow key={a.id} name={a.name} amount={a.amount} indent={1} onClick={() => onOpenLedger && onOpenLedger([a.id], a.name)} />)}{bsData.netIncome !== 0 && <BSRow name="Net Income (Current Period)" amount={bsData.netIncome} indent={1} italic />}</BSSection>
      <div className="flex justify-between py-3 border-t-2 border-b-2 border-neutral-800 mt-4 font-black"><span className="text-sm">TOTAL LIABILITIES AND EQUITY</span><span className="font-mono text-sm tabular-nums">{acctFmt(bsData.totalLiabilities + bsData.totalEquity)}</span></div>
      <div className="text-xs text-neutral-400 mt-4 flex justify-between"><span>Accrual basis</span><span>{new Date().toLocaleString()}</span></div>
    </div>);
    })()}

    {/* Trial Balance */}
    {reportId === "tb" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Trial Balance</p><p className="text-sm text-neutral-500 mt-1">As of {acctFmtDate(asOfDate)}</p></div>
      <table className="w-full text-sm"><thead className="bg-neutral-50 border-b border-neutral-200"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Account</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Debit</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Credit</th></tr></thead>
      <tbody>{tbData.filter(a => a.debitBalance !== 0 || a.creditBalance !== 0).map(a => <tr key={a.id} className="border-t border-neutral-100 hover:bg-positive-50/30 cursor-pointer" onClick={() => { setSelectedAccountId(a.id); setCurrentReport({ id: "gl", title: "General Ledger" }); }}><td className="px-4 py-2 text-neutral-700">{a.code ? a.code + " " : ""}{a.name}</td><td className="px-4 py-2 text-right font-mono">{a.debitBalance > 0 ? acctFmt(a.debitBalance) : ""}</td><td className="px-4 py-2 text-right font-mono">{a.creditBalance > 0 ? acctFmt(a.creditBalance) : ""}</td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td className="px-4 py-2">TOTALS</td><td className="px-4 py-2 text-right font-mono">{acctFmt(tbData.reduce((s,a) => s + a.debitBalance, 0))}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(tbData.reduce((s,a) => s + a.creditBalance, 0))}</td></tr></tfoot></table>
    </div>)}

    {/* General Ledger */}
    {reportId === "gl" && glAccount && (<div>
      <div className="text-center mb-4"><p className="text-xs text-neutral-400 uppercase tracking-widest">General Ledger</p><h4 className="text-base font-bold text-neutral-900 mt-1">{glAccount.name}</h4><p className="text-sm text-neutral-400">#{glAccount.code} · {glAccount.type}</p><p className="text-sm text-neutral-400">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {glLines.length > 0 && <div className="flex justify-end mb-3"><div className="text-right"><p className="text-xs text-neutral-400">Ending Balance</p><p className="font-mono font-bold">{acctFmt(glLines[glLines.length-1].balance, true)}</p></div></div>}
      <div className="flex justify-end mb-2 relative"><button onClick={() => setShowColPicker(!showColPicker)} className="text-xs bg-neutral-100 text-neutral-500 px-3 py-1.5 rounded-lg hover:bg-neutral-200 flex items-center gap-1"><span className="material-icons-outlined text-sm">view_column</span>Columns</button>{showColPicker && <div className="absolute right-0 top-8 bg-white border border-neutral-200 rounded-xl shadow-lg p-3 z-20 w-48">{[["date","Date"],["entry","Entry #"],["description","Description"],["memo","Memo"],["debit","Debit"],["credit","Credit"],["balance","Balance"]].map(([id,label]) => <label key={id} className="flex items-center gap-2 py-1 cursor-pointer text-sm text-neutral-700"><input type="checkbox" checked={glColumns[id]} onChange={() => toggleGlCol(id)} className="accent-brand-600" />{label}</label>)}</div>}</div>
      <table className="w-full text-sm border border-neutral-200 rounded-xl overflow-hidden"><thead className="bg-neutral-50"><tr>{glColumns.date && <th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Date</th>}{glColumns.entry && <th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Entry #</th>}{glColumns.description && <th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Description</th>}{glColumns.memo && <th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Memo</th>}{glColumns.debit && <th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Debit</th>}{glColumns.credit && <th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Credit</th>}{glColumns.balance && <th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Balance</th>}</tr></thead>
      <tbody>{glLines.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-neutral-400">No transactions</td></tr> : glLines.map((l,i) => <tr key={l.jeId+"-"+i} className="border-t border-neutral-100 hover:bg-positive-50/40">{glColumns.date && <td className="px-4 py-2 text-xs text-neutral-400">{acctFmtDate(l.date)}</td>}{glColumns.entry && <td className="px-4 py-2 font-mono text-xs text-brand-600">{l.jeNumber||"—"}</td>}{glColumns.description && <td className="px-4 py-2 text-neutral-700">{l.description}</td>}{glColumns.memo && <td className="px-4 py-2 text-xs text-neutral-400">{l.memo||"—"}</td>}{glColumns.debit && <td className="px-4 py-2 text-right font-mono">{l.debit > 0 ? acctFmt(l.debit) : ""}</td>}{glColumns.credit && <td className="px-4 py-2 text-right font-mono">{l.credit > 0 ? acctFmt(l.credit) : ""}</td>}{glColumns.balance && <td className={`px-4 py-2 text-right font-mono font-semibold ${l.balance < 0 ? "text-danger-600" : ""}`}>{acctFmt(l.balance, true)}</td>}</tr>)}</tbody></table>
    </div>)}

    {/* AR Aging Summary */}
    {reportId === "ar_aging_summary" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">AR Aging Summary</p><p className="text-sm text-neutral-500 mt-1">As of {acctFmtDate(asOfDate)}</p></div>
      <table className="w-full text-sm"><thead className="bg-neutral-50 border-b border-neutral-200"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Tenant</th><th className="px-4 py-2 text-right text-xs font-semibold text-success-600">Current</th><th className="px-4 py-2 text-right text-xs font-semibold text-warn-600">1-30</th><th className="px-4 py-2 text-right text-xs font-semibold text-notice-600">31-60</th><th className="px-4 py-2 text-right text-xs font-semibold text-danger-600">61-90</th><th className="px-4 py-2 text-right text-xs font-semibold text-danger-800">91+</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-700">Total</th></tr></thead>
      <tbody>{(bsData.arAgingByTenant || []).filter(t => Math.abs(t.current + t.days30 + t.days60 + t.days90 + t.over90) > 0.01).map((t,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{t.tenant}</td><td className="px-4 py-2 text-right font-mono">{t.current ? acctFmt(t.current) : ""}</td><td className="px-4 py-2 text-right font-mono">{t.days30 ? acctFmt(t.days30) : ""}</td><td className="px-4 py-2 text-right font-mono">{t.days60 ? acctFmt(t.days60) : ""}</td><td className="px-4 py-2 text-right font-mono">{t.days90 ? acctFmt(t.days90) : ""}</td><td className="px-4 py-2 text-right font-mono">{t.over90 ? acctFmt(t.over90) : ""}</td><td className="px-4 py-2 text-right font-mono font-semibold">{acctFmt(t.current + t.days30 + t.days60 + t.days90 + t.over90)}</td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td className="px-4 py-2">TOTALS</td><td className="px-4 py-2 text-right font-mono">{acctFmt(bsData.arAging?.current||0)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(bsData.arAging?.days30||0)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(bsData.arAging?.days60||0)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(bsData.arAging?.days90||0)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(bsData.arAging?.over90||0)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt((bsData.arAging?.current||0)+(bsData.arAging?.days30||0)+(bsData.arAging?.days60||0)+(bsData.arAging?.days90||0)+(bsData.arAging?.over90||0))}</td></tr></tfoot></table>
    </div>)}

    {/* Tenant Balance Summary */}
    {reportId === "customer_balance_summary" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Tenant Balance Summary</p></div>
      <table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Tenant</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Balance</th></tr></thead>
      <tbody>{(bsData.arByTenant||[]).map((t,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{t.tenant}</td><td className={`px-4 py-2 text-right font-mono font-semibold ${t.balance < 0 ? "text-positive-600" : t.balance > 0 ? "text-danger-600" : ""}`}>{acctFmt(t.balance, true)}</td></tr>)}</tbody></table>
    </div>)}

    {/* Journal */}
    {reportId === "journal" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Journal</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {getJournalReport(start, end).map(je => <div key={je.jeId} className="mb-4 border border-neutral-100 rounded-lg p-3"><div className="flex justify-between items-start mb-2"><div><span className="font-mono text-xs text-brand-600 mr-2">{je.jeNumber}</span><span className="text-sm font-semibold text-neutral-800">{je.description}</span></div><span className="text-xs text-neutral-400">{acctFmtDate(je.date)}</span></div>
      <table className="w-full text-xs"><tbody>{je.lines.map((l,i) => <tr key={i} className="border-t border-neutral-50"><td className="py-1 text-neutral-600">{l.accountName}</td><td className="py-1 text-neutral-400">{l.memo||""}</td><td className="py-1 text-right font-mono">{l.debit > 0 ? acctFmt(l.debit) : ""}</td><td className="py-1 text-right font-mono">{l.credit > 0 ? acctFmt(l.credit) : ""}</td></tr>)}</tbody></table></div>)}
    </div>)}

    {/* Transaction List by Date */}
    {reportId === "txn_by_date" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Transaction List by Date</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      <table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Date</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Entry</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Account</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Description</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Debit</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Credit</th></tr></thead>
      <tbody>{getTransactionsByDate(start, end).map((t,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-3 py-1.5 text-xs text-neutral-400">{t.date}</td><td className="px-3 py-1.5 text-xs text-brand-600 font-mono">{t.jeNumber||""}</td><td className="px-3 py-1.5 text-neutral-700">{t.accountName}</td><td className="px-3 py-1.5 text-xs text-neutral-500">{t.description}</td><td className="px-3 py-1.5 text-right font-mono">{t.debit > 0 ? acctFmt(t.debit) : ""}</td><td className="px-3 py-1.5 text-right font-mono">{t.credit > 0 ? acctFmt(t.credit) : ""}</td></tr>)}</tbody></table>
    </div>)}

    {/* Account Listing */}
    {reportId === "account_list" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Account Listing</p></div>
      <table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Code</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Tenant/Vendor</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Type</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Subtype</th><th className="px-4 py-2 text-center text-xs font-semibold text-neutral-500">Active</th></tr></thead>
      <tbody>{accounts.sort((a,b) => (a.code||"").localeCompare(b.code||"")).map(a => <tr key={a.id} className="border-t border-neutral-100"><td className="px-4 py-2 font-mono text-xs text-neutral-600">{a.code||"—"}</td><td className="px-4 py-2 text-neutral-800">{a.name}</td><td className="px-4 py-2 text-neutral-500">{a.type}</td><td className="px-4 py-2 text-xs text-neutral-400">{a.subtype||"—"}</td><td className="px-4 py-2 text-center">{a.is_active ? "✓" : "✗"}</td></tr>)}</tbody></table>
    </div>)}

    {/* Expenses by Category */}
    {reportId === "expenses_by_category" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Expenses by Category</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {(() => { const data = getExpensesByCategory(start, end); return (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Category</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Amount</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500 w-48">% of Total</th></tr></thead>
      <tbody>{data.map(a => <tr key={a.id} className="border-t border-neutral-100 cursor-pointer hover:bg-positive-50/30" onClick={() => onOpenLedger && onOpenLedger([a.id], a.name)}><td className="px-4 py-2 text-neutral-700">{a.name}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(a.amount)}</td><td className="px-4 py-2"><div className="flex items-center gap-2"><div className="flex-1 bg-neutral-100 rounded-full h-2"><div className="bg-positive-500 rounded-full h-2" style={{width: Math.min(100, a.percentage) + "%"}} /></div><span className="text-xs text-neutral-500 w-8">{a.percentage}%</span></div></td></tr>)}</tbody></table>); })()}
    </div>)}

    {/* P&L by Property — columnar QBO-style */}
    {reportId === "pl_by_class" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Profit and Loss by Property</p><p className="text-xs text-neutral-400 mt-1">{acctFmtDate(start)} – {acctFmtDate(end)}</p></div>
      {(() => {
        const acctMap = {}; accounts.forEach(a => { acctMap[a.id] = a; });
        // Gather all properties (classes) that have data
        const propData = {}; // { classId: { accountId: amount } }
        const accountsUsed = new Set();
        for (const je of journalEntries) {
          if (je.status !== "posted" || je.date < start || je.date > end) continue;
          for (const l of (je.lines || [])) {
            if (!l.class_id) continue;
            const acct = acctMap[l.account_id]; if (!acct) continue;
            if (!["Revenue","Other Income","Expense","Cost of Goods Sold","Other Expense"].includes(acct.type)) continue;
            if (!propData[l.class_id]) propData[l.class_id] = {};
            if (!propData[l.class_id][l.account_id]) propData[l.class_id][l.account_id] = 0;
            if (["Revenue","Other Income"].includes(acct.type)) propData[l.class_id][l.account_id] += safeNum(l.credit) - safeNum(l.debit);
            else propData[l.class_id][l.account_id] += safeNum(l.debit) - safeNum(l.credit);
            accountsUsed.add(l.account_id);
          }
        }
        const props = classes.filter(c => propData[c.id]).sort((a,b) => a.name.localeCompare(b.name));
        if (props.length === 0) return <p className="text-center py-8 text-neutral-400">No property data for this period</p>;
        // Group accounts by category
        const incomeAccts = accounts.filter(a => a.type === "Revenue" && accountsUsed.has(a.id)).sort((a,b) => a.code.localeCompare(b.code));
        const otherIncomeAccts = accounts.filter(a => a.type === "Other Income" && accountsUsed.has(a.id)).sort((a,b) => a.code.localeCompare(b.code));
        const cogsAccts = accounts.filter(a => a.type === "Cost of Goods Sold" && accountsUsed.has(a.id)).sort((a,b) => a.code.localeCompare(b.code));
        const expenseAccts = accounts.filter(a => a.type === "Expense" && accountsUsed.has(a.id)).sort((a,b) => a.code.localeCompare(b.code));
        const otherExpAccts = accounts.filter(a => a.type === "Other Expense" && accountsUsed.has(a.id)).sort((a,b) => a.code.localeCompare(b.code));
        const val = (classId, acctId) => propData[classId]?.[acctId] || 0;
        const sumGroup = (classId, group) => group.reduce((s, a) => s + val(classId, a.id), 0);
        const fmtCell = (v) => v === 0 ? "–" : acctFmt(Math.abs(v));
        const cellCls = "px-3 py-1.5 text-right font-mono text-xs whitespace-nowrap";
        const labelCls = "px-3 py-1.5 text-sm text-neutral-700 whitespace-nowrap";
        const boldLabelCls = "px-3 py-1.5 text-sm font-bold text-neutral-900 whitespace-nowrap";
        const boldCellCls = "px-3 py-1.5 text-right font-mono text-xs font-bold whitespace-nowrap";
        const sectionCls = "px-3 py-2 text-xs font-semibold text-neutral-500 uppercase tracking-wider bg-neutral-50";
        const renderRow = (label, getVal, bold, borderTop, acctId) => (
          <tr key={label} className={borderTop ? "border-t border-neutral-300" : "border-t border-neutral-50"}>
            <td className={bold ? boldLabelCls : labelCls} style={!bold ? { paddingLeft: 24 } : {}}>{label}</td>
            {props.map(p => { const v = getVal(p.id); return <td key={p.id} className={`${bold ? boldCellCls : cellCls}${acctId ? " cursor-pointer hover:bg-positive-50/30" : ""}`} onClick={acctId && v !== 0 ? () => onOpenLedger && onOpenLedger([acctId], label) : undefined}>{fmtCell(v)}</td>; })}
          </tr>
        );
        return (
        <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse min-w-max">
        <thead><tr className="bg-neutral-50 border-b border-neutral-200">
          <th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500 sticky left-0 bg-neutral-50 min-w-48"></th>
          {props.map(p => <th key={p.id} className="px-3 py-2 text-right text-xs font-semibold text-neutral-700 min-w-28">{p.name.split(",")[0]}</th>)}
        </tr></thead>
        <tbody>
          {/* Income */}
          {incomeAccts.length > 0 && <tr><td colSpan={props.length + 1} className={sectionCls}>Income</td></tr>}
          {incomeAccts.map(a => renderRow(a.name, cid => val(cid, a.id), false, false, a.id))}
          {renderRow("Total for Income", cid => sumGroup(cid, incomeAccts), true, true)}

          {/* COGS */}
          {cogsAccts.length > 0 && <tr><td colSpan={props.length + 1} className={sectionCls}>Cost of Goods Sold</td></tr>}
          {cogsAccts.map(a => renderRow(a.name, cid => -val(cid, a.id), false, false, a.id))}
          {cogsAccts.length > 0 && renderRow("Total COGS", cid => sumGroup(cid, cogsAccts), true, true)}

          {/* Gross Profit */}
          {renderRow("Gross Profit", cid => sumGroup(cid, incomeAccts) - sumGroup(cid, cogsAccts), true, true)}

          {/* Expenses */}
          {expenseAccts.length > 0 && <tr><td colSpan={props.length + 1} className={sectionCls}>Expenses</td></tr>}
          {expenseAccts.map(a => renderRow(a.name, cid => val(cid, a.id), false, false, a.id))}
          {renderRow("Total for Expenses", cid => sumGroup(cid, expenseAccts), true, true)}

          {/* Net Operating Income */}
          {renderRow("Net Operating Income", cid => sumGroup(cid, incomeAccts) - sumGroup(cid, cogsAccts) - sumGroup(cid, expenseAccts), true, true)}

          {/* Other Income/Expense */}
          {(otherIncomeAccts.length > 0 || otherExpAccts.length > 0) && <>
            {otherIncomeAccts.map(a => renderRow(a.name, cid => val(cid, a.id), false, false, a.id))}
            {otherExpAccts.map(a => renderRow(a.name, cid => -val(cid, a.id), false, false, a.id))}
            {renderRow("Net Other Income", cid => sumGroup(cid, otherIncomeAccts) - sumGroup(cid, otherExpAccts), true, true)}
          </>}

          {/* Net Income */}
          <tr className="border-t-2 border-neutral-800">
            <td className="px-3 py-2 text-sm font-black text-neutral-900">Net Income</td>
            {props.map(p => {
              const ni = sumGroup(p.id, [...incomeAccts, ...otherIncomeAccts]) - sumGroup(p.id, [...cogsAccts, ...expenseAccts, ...otherExpAccts]);
              return <td key={p.id} className={`px-3 py-2 text-right font-mono text-xs font-black ${ni < 0 ? "text-danger-600" : ""}`}>{fmtCell(ni)}</td>;
            })}
          </tr>
        </tbody>
        </table>
        </div>
        );
      })()}
    </div>)}

    {/* Cash Flow */}
    {reportId === "cash_flow" && (() => { const cf = getCashFlowData(start, end); return (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Statement of Cash Flows</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      <div className="text-sm font-bold text-neutral-900 py-1">Operating Activities</div>
      {cf.operating.items.map((item,i) => <div key={i} className="flex justify-between py-1" style={{paddingLeft:24}}><span className="text-sm text-neutral-700">{item.name}</span><span className="font-mono text-sm tabular-nums">{acctFmt(item.amount, true)}</span></div>)}
      <div className="flex justify-between py-1.5 border-t border-neutral-300 font-bold" style={{paddingLeft:24}}><span className="text-sm">Net Cash from Operations</span><span className="font-mono text-sm tabular-nums">{acctFmt(cf.operating.total)}</span></div>
      <div className="flex justify-between py-3 border-t-2 border-b-2 border-neutral-800 font-black mt-4"><span className="text-sm">NET CHANGE IN CASH</span><span className="font-mono text-sm tabular-nums">{acctFmt(cf.netChange, true)}</span></div>
      <div className="flex justify-between py-1 mt-2"><span className="text-sm text-neutral-500">Beginning Cash</span><span className="font-mono text-sm">{acctFmt(cf.beginningCash)}</span></div>
      <div className="flex justify-between py-1 font-bold"><span className="text-sm">Ending Cash</span><span className="font-mono text-sm">{acctFmt(cf.endingCash)}</span></div>
    </div>); })()}

    {/* Rent Roll */}
    {reportId === "rent_roll" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Rent Roll</p></div>
      {(() => { const data = getRentRoll(); const occ = data.filter(r=>r.status==="occupied").length; return (<><div className="grid grid-cols-4 gap-3 mb-4"><div className="bg-neutral-50 rounded-lg p-3 text-center"><div className="text-lg font-bold">{data.length}</div><div className="text-xs text-neutral-400">Total Units</div></div><div className="bg-success-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-success-700">{occ}</div><div className="text-xs text-neutral-400">Occupied</div></div><div className="bg-danger-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-danger-600">{data.length-occ}</div><div className="text-xs text-neutral-400">Vacant</div></div><div className="bg-info-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-info-700">{acctFmt(data.reduce((s,r)=>s+r.rent,0))}</div><div className="text-xs text-neutral-400">Monthly Rent</div></div></div>
      <table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Tenant</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Rent</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Lease End</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Status</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-3 py-2 text-neutral-700">{r.property}</td><td className="px-3 py-2">{r.tenant === "VACANT" ? <span className="text-danger-500 font-medium">VACANT</span> : r.tenant}</td><td className="px-3 py-2 text-right font-mono">{r.rent > 0 ? acctFmt(r.rent) : "—"}</td><td className="px-3 py-2 text-xs text-neutral-400">{r.leaseEnd||"—"}</td><td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${r.status==="occupied"?"bg-success-100 text-success-700":r.status==="vacant"?"bg-danger-100 text-danger-600":"bg-warn-100 text-warn-700"}`}>{r.status}</span></td></tr>)}</tbody></table></>); })()}
    </div>)}

    {/* NOI by Property */}
    {reportId === "noi_by_property" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">NOI by Property</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {(() => { const data = getNOIByProperty(start, end); return (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Revenue</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Expenses</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">NOI</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Margin</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.property}</td><td className="px-4 py-2 text-right font-mono text-success-700">{acctFmt(r.revenue)}</td><td className="px-4 py-2 text-right font-mono text-danger-600">{acctFmt(r.expenses)}</td><td className={`px-4 py-2 text-right font-mono font-bold ${r.noi < 0 ? "text-danger-600" : "text-success-700"}`}>{acctFmt(r.noi)}</td><td className="px-4 py-2 text-right text-sm">{r.noiMargin}%</td></tr>)}</tbody></table>); })()}
    </div>)}

    {/* Vacancy Report */}
    {reportId === "vacancy" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Vacancy Report</p></div>
      {(() => { const data = getVacancyReport(); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No vacant properties</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Last Tenant</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Days Vacant</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Est. Lost Revenue</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.property}</td><td className="px-4 py-2 text-neutral-500">{r.lastTenant}</td><td className="px-4 py-2 text-right font-mono">{r.daysVacant}</td><td className="px-4 py-2 text-right font-mono text-danger-600">{acctFmt(r.estimatedLost)}</td></tr>)}</tbody></table>); })()}
    </div>)}

    {/* License Compliance */}
    {reportId === "license_compliance" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">License Compliance Report</p><p className="text-xs text-neutral-400 mt-0.5">As of {acctFmtDate(asOfDate)}</p></div>
      {(() => { const data = getLicenseCompliance(); if (data.length === 0) return <p className="text-center py-8 text-neutral-400">No licenses on file</p>;
        const counts = data.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
        return (<>
        <div className="grid grid-cols-5 gap-3 mb-4">
          <div className="bg-neutral-50 rounded-lg p-3 text-center"><div className="text-lg font-bold">{data.length}</div><div className="text-xs text-neutral-400">Total</div></div>
          <div className="bg-success-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-success-600">{counts.active || 0}</div><div className="text-xs text-neutral-400">Active</div></div>
          <div className="bg-warn-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-warn-600">{counts.soon || 0}</div><div className="text-xs text-neutral-400">≤90d</div></div>
          <div className="bg-danger-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-danger-500">{counts.urgent || 0}</div><div className="text-xs text-neutral-400">≤30d</div></div>
          <div className="bg-danger-100 rounded-lg p-3 text-center"><div className="text-lg font-bold text-danger-700">{counts.expired || 0}</div><div className="text-xs text-neutral-400">Expired</div></div>
        </div>
        <table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Type</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Number</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Jurisdiction</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Expiry</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Days</th><th className="px-3 py-2 text-center text-xs font-semibold text-neutral-500">Status</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Fee</th></tr></thead>
        <tbody>{data.map((r, i) => <tr key={i} className="border-t border-neutral-100"><td className="px-3 py-2 text-neutral-700 max-w-48 truncate">{r.property}</td><td className="px-3 py-2 text-neutral-600">{r.type}</td><td className="px-3 py-2 text-xs text-neutral-500">{r.number || "—"}</td><td className="px-3 py-2 text-xs text-neutral-500">{r.jurisdiction || "—"}</td><td className="px-3 py-2 text-xs text-neutral-500">{r.expiryDate}</td><td className={`px-3 py-2 text-right font-mono ${r.daysUntil < 0 ? "text-danger-700 font-bold" : r.daysUntil <= 30 ? "text-danger-500 font-semibold" : r.daysUntil <= 90 ? "text-warn-600" : ""}`}>{r.daysUntil < 0 ? `${r.daysUntil}` : r.daysUntil}</td><td className="px-3 py-2 text-center"><span className={`text-xs px-2 py-0.5 rounded-full ${r.status === "expired" ? "bg-danger-100 text-danger-700" : r.status === "urgent" ? "bg-danger-50 text-danger-600" : r.status === "soon" ? "bg-warn-50 text-warn-700" : r.status === "pending_renewal" ? "bg-brand-50 text-brand-700" : "bg-success-50 text-success-700"}`}>{r.status.replace("_", " ")}</span></td><td className="px-3 py-2 text-right font-mono">{r.fee ? acctFmt(r.fee) : "—"}</td></tr>)}</tbody>
        <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td colSpan={7} className="px-3 py-2">TOTAL FEES</td><td className="px-3 py-2 text-right font-mono">{acctFmt(data.reduce((s, r) => s + r.fee, 0))}</td></tr></tfoot></table>
        </>);
      })()}
    </div>)}

    {/* Lease Expirations */}
    {reportId === "lease_expirations" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Lease Expiration Schedule</p></div>
      {(() => { const data = getLeaseExpirations(180); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No leases expiring in the next 180 days</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Tenant</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Lease End</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Days Left</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Rent</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.tenant}</td><td className="px-4 py-2 text-neutral-500">{r.property}</td><td className="px-4 py-2 text-neutral-500">{r.leaseEnd}</td><td className={`px-4 py-2 text-right font-mono ${r.daysUntilExpiration <= 30 ? "text-danger-600 font-bold" : r.daysUntilExpiration <= 60 ? "text-warn-600" : ""}`}>{r.daysUntilExpiration}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(r.rent)}</td></tr>)}</tbody></table>); })()}
    </div>)}

    {/* Work Order Summary */}
    {reportId === "work_orders_summary" && (() => { const data = getWorkOrderSummary(start, end); return (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Work Order Summary</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      <div className="grid grid-cols-4 gap-3 mb-4"><div className="bg-neutral-50 rounded-lg p-3 text-center"><div className="text-lg font-bold">{data.total}</div><div className="text-xs text-neutral-400">Total</div></div><div className="bg-warn-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-warn-600">{data.byStatus.open}</div><div className="text-xs text-neutral-400">Open</div></div><div className="bg-highlight-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-highlight-600">{data.byStatus.in_progress}</div><div className="text-xs text-neutral-400">In Progress</div></div><div className="bg-success-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-success-600">{data.byStatus.completed}</div><div className="text-xs text-neutral-400">Completed</div></div></div>
      <table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Issue</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Status</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Cost</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Days</th></tr></thead>
      <tbody>{data.items.map(w => <tr key={w.id} className="border-t border-neutral-100"><td className="px-3 py-2 text-neutral-700">{w.property}</td><td className="px-3 py-2 text-neutral-600">{w.issue}</td><td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded-full ${w.status==="open"?"bg-warn-100 text-warn-700":w.status==="in_progress"?"bg-highlight-100 text-highlight-700":"bg-success-100 text-success-700"}`}>{w.status}</span></td><td className="px-3 py-2 text-right font-mono">{w.cost ? acctFmt(w.cost) : "—"}</td><td className="px-3 py-2 text-right font-mono text-neutral-500">{w.daysOpen}</td></tr>)}</tbody></table>
    </div>); })()}

    {/* Open Invoices */}
    {reportId === "open_invoices" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Open Invoices / Unpaid Charges</p><p className="text-sm text-neutral-500 mt-1">As of {acctFmtDate(asOfDate)}</p></div>
      {(() => { const data = getOpenInvoices(asOfDate); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No unpaid charges</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Tenant</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Date</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Description</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Original</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Paid</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Due</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Days</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-3 py-2 text-neutral-700">{r.tenant}</td><td className="px-3 py-2 text-xs text-neutral-400">{r.date}</td><td className="px-3 py-2 text-xs text-neutral-500 max-w-48 truncate">{r.description}</td><td className="px-3 py-2 text-right font-mono">{acctFmt(r.originalAmount)}</td><td className="px-3 py-2 text-right font-mono text-success-600">{acctFmt(r.amountPaid)}</td><td className="px-3 py-2 text-right font-mono font-semibold text-danger-600">{acctFmt(r.amountDue)}</td><td className={`px-3 py-2 text-right font-mono ${r.daysOutstanding > 60 ? "text-danger-600 font-bold" : r.daysOutstanding > 30 ? "text-warn-600" : ""}`}>{r.daysOutstanding}</td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td colSpan={5} className="px-3 py-2">TOTAL</td><td className="px-3 py-2 text-right font-mono text-danger-600">{acctFmt(data.reduce((s,r)=>s+r.amountDue,0))}</td><td></td></tr></tfoot></table>); })()}
    </div>)}

    {/* Collections Report */}
    {reportId === "collections" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Collections Report</p></div>
      {(() => { const data = getCollectionsReport(asOfDate); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No outstanding balances</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Tenant</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Contact</th><th className="px-3 py-2 text-right text-xs font-semibold text-neutral-500">Total Owed</th><th className="px-3 py-2 text-center text-xs font-semibold text-neutral-500">Severity</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-3 py-2 text-neutral-700 font-medium">{r.tenant}</td><td className="px-3 py-2 text-xs text-neutral-500">{r.property}</td><td className="px-3 py-2 text-xs text-neutral-400">{r.email && <span className="block">{r.email}</span>}{r.phone && <span>{r.phone}</span>}</td><td className="px-3 py-2 text-right font-mono font-bold text-danger-600">{acctFmt(r.total)}</td><td className="px-3 py-2 text-center"><span className={`text-xs px-2 py-0.5 rounded-full ${r.severity==="critical"?"bg-danger-100 text-danger-700":r.severity==="warning"?"bg-warn-100 text-warn-700":"bg-neutral-100 text-neutral-500"}`}>{r.severity}</span></td></tr>)}</tbody></table>); })()}
    </div>)}

    {/* Customer Balance Detail */}
    {reportId === "customer_balance_detail" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Tenant Balance Detail</p></div>
      {(() => { const data = getCustomerBalanceDetail(asOfDate); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No tenant balances</p> : data.map(t => (<div key={t.name} className="mb-6"><div className="flex justify-between items-center border-b border-neutral-200 pb-1 mb-2"><span className="text-sm font-bold text-neutral-800">{t.name}</span><span className={`font-mono text-sm font-bold ${t.totalBalance < 0 ? "text-positive-600" : "text-danger-600"}`}>{acctFmt(t.totalBalance, true)}</span></div>
      <table className="w-full text-xs"><thead><tr><th className="px-2 py-1 text-left text-neutral-400">Date</th><th className="px-2 py-1 text-left text-neutral-400">Entry</th><th className="px-2 py-1 text-left text-neutral-400">Description</th><th className="px-2 py-1 text-right text-neutral-400">Debit</th><th className="px-2 py-1 text-right text-neutral-400">Credit</th><th className="px-2 py-1 text-right text-neutral-400">Balance</th></tr></thead>
      <tbody>{t.transactions.map((tx,i) => <tr key={i} className="border-t border-neutral-50"><td className="px-2 py-1 text-neutral-400">{tx.date}</td><td className="px-2 py-1 text-brand-600 font-mono">{tx.jeNumber||""}</td><td className="px-2 py-1 text-neutral-600 truncate max-w-40">{tx.description}</td><td className="px-2 py-1 text-right font-mono">{tx.debit > 0 ? acctFmt(tx.debit) : ""}</td><td className="px-2 py-1 text-right font-mono">{tx.credit > 0 ? acctFmt(tx.credit) : ""}</td><td className={`px-2 py-1 text-right font-mono font-semibold ${tx.balance < 0 ? "text-positive-600" : ""}`}>{acctFmt(tx.balance, true)}</td></tr>)}</tbody></table></div>)); })()}
    </div>)}

    {/* Expenses by Vendor */}
    {reportId === "expenses_by_vendor" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Expenses by Vendor</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {(() => { const data = getExpensesByVendor(start, end); return (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Vendor</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Amount</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500 w-48">% of Total</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.vendor}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(r.total)}</td><td className="px-4 py-2"><div className="flex items-center gap-2"><div className="flex-1 bg-neutral-100 rounded-full h-2"><div className="bg-notice-500 rounded-full h-2" style={{width: Math.min(100, r.percentage) + "%"}} /></div><span className="text-xs text-neutral-500 w-8">{r.percentage}%</span></div></td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td className="px-4 py-2">TOTAL</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.reduce((s,r)=>s+r.total,0))}</td><td></td></tr></tfoot></table>); })()}
    </div>)}

    {/* Security Deposit Ledger */}
    {reportId === "security_deposits" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Security Deposit Ledger</p><p className="text-sm text-neutral-500 mt-1">As of {acctFmtDate(asOfDate)}</p></div>
      {(() => { const data = getSecurityDepositLedger(asOfDate); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No security deposits held</p> : (<><table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Tenant</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Received</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Returned</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Net Held</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.tenant}</td><td className="px-4 py-2 text-xs text-neutral-500">{r.property}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(r.received)}</td><td className="px-4 py-2 text-right font-mono text-danger-600">{r.returned > 0 ? acctFmt(r.returned) : ""}</td><td className="px-4 py-2 text-right font-mono font-bold">{acctFmt(r.netHeld)}</td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td colSpan={4} className="px-4 py-2">TOTAL HELD</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.reduce((s,r)=>s+r.netHeld,0))}</td></tr></tfoot></table></>); })()}
    </div>)}

    {/* Late Fee Report */}
    {reportId === "late_fees" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Late Fee Report</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {(() => { const data = getLateFeeReport(start, end); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No late fees in this period</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Tenant</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Assessed</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Collected</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Outstanding</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Count</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.tenant}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(r.feesAssessed)}</td><td className="px-4 py-2 text-right font-mono text-success-600">{acctFmt(r.feesCollected)}</td><td className="px-4 py-2 text-right font-mono font-bold text-danger-600">{r.feesOutstanding > 0 ? acctFmt(r.feesOutstanding) : ""}</td><td className="px-4 py-2 text-right">{r.count}</td></tr>)}</tbody></table>); })()}
    </div>)}

    {/* Owner Distributions */}
    {reportId === "owner_distributions" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Owner Distribution Report</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {(() => { const data = getOwnerDistributions(start, end); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No distributions in this period</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Date</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Entry</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Description</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Amount</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-400">{r.date}</td><td className="px-4 py-2 font-mono text-xs text-brand-600">{r.jeNumber||""}</td><td className="px-4 py-2 text-neutral-700">{r.description}</td><td className="px-4 py-2 text-right font-mono font-semibold">{acctFmt(r.amount)}</td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td colSpan={3} className="px-4 py-2">TOTAL DISTRIBUTED</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.reduce((s,r)=>s+r.amount,0))}</td></tr></tfoot></table>); })()}
    </div>)}

    {/* Rent Collection Summary */}
    {reportId === "rent_collection" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Rent Collection Summary</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {(() => { const data = getRentCollectionSummary(start, end); return (<><div className="grid grid-cols-4 gap-3 mb-4"><div className="bg-info-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-info-700">{acctFmt(data.totals.charged)}</div><div className="text-xs text-neutral-400">Charged</div></div><div className="bg-success-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-success-700">{acctFmt(data.totals.collected)}</div><div className="text-xs text-neutral-400">Collected</div></div><div className="bg-danger-50 rounded-lg p-3 text-center"><div className="text-lg font-bold text-danger-600">{acctFmt(data.totals.outstanding)}</div><div className="text-xs text-neutral-400">Outstanding</div></div><div className="bg-neutral-50 rounded-lg p-3 text-center"><div className="text-lg font-bold">{data.totals.collectionRate}%</div><div className="text-xs text-neutral-400">Collection Rate</div></div></div>
      <table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Property</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Charged</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Collected</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Outstanding</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Rate</th></tr></thead>
      <tbody>{data.byProperty.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.property}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(r.charged)}</td><td className="px-4 py-2 text-right font-mono text-success-600">{acctFmt(r.collected)}</td><td className="px-4 py-2 text-right font-mono text-danger-600">{r.outstanding > 0 ? acctFmt(r.outstanding) : ""}</td><td className="px-4 py-2 text-right">{r.collectionRate}%</td></tr>)}</tbody></table></>); })()}
    </div>)}

    {/* Transaction Detail by Account */}
    {reportId === "txn_by_account" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Transaction Detail by Account</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      {getTransactionsByAccount(start, end).map(acct => (<div key={acct.name} className="mb-4"><div className="bg-neutral-50 px-3 py-2 rounded-lg font-semibold text-sm text-neutral-800 flex justify-between"><span>{acct.code ? acct.code + " " : ""}{acct.name}</span><span className="text-xs text-neutral-400">{acct.type}</span></div>
      <table className="w-full text-xs mb-2"><tbody>{acct.transactions.map((t,i) => <tr key={i} className="border-t border-neutral-50"><td className="px-3 py-1 text-neutral-400 w-20">{t.date}</td><td className="px-3 py-1 text-brand-600 font-mono w-16">{t.jeNumber||""}</td><td className="px-3 py-1 text-neutral-600">{t.description}</td><td className="px-3 py-1 text-right font-mono w-20">{t.debit > 0 ? acctFmt(t.debit) : ""}</td><td className="px-3 py-1 text-right font-mono w-20">{t.credit > 0 ? acctFmt(t.credit) : ""}</td></tr>)}</tbody></table></div>))}
    </div>)}

    {/* P&L Comparison */}
    {reportId === "pl_compare" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Profit & Loss Comparison</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}{compareData ? " vs Prior" : ""}</p></div>
      {!compareData && <p className="text-center py-4 text-warn-600 text-sm">Select "Compare to" in the toolbar above to see a comparison.</p>}
      <table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Account</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Current</th>{compareData && <th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Prior</th>}{compareData && <th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Change</th>}</tr></thead>
      <tbody><tr className="bg-neutral-50 font-bold"><td className="px-4 py-2" colSpan={compareData ? 4 : 2}>Income</td></tr>
      {plData.revenue.filter(a=>a.amount!==0).map(a => { const prior = compareData?.revenue.find(p=>p.id===a.id); return <tr key={a.id} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700 pl-8">{a.name}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(a.amount)}</td>{compareData && <td className="px-4 py-2 text-right font-mono text-neutral-400">{prior ? acctFmt(prior.amount) : "—"}</td>}{compareData && <td className={`px-4 py-2 text-right font-mono ${a.amount-(prior?.amount||0) > 0 ? "text-success-600" : a.amount-(prior?.amount||0) < 0 ? "text-danger-600" : ""}`}>{acctFmt(a.amount - (prior?.amount||0), true)}</td>}</tr>; })}
      <tr className="border-t border-neutral-300 font-bold"><td className="px-4 py-2 pl-8">Total Income</td><td className="px-4 py-2 text-right font-mono">{acctFmt(plData.totalRevenue)}</td>{compareData && <td className="px-4 py-2 text-right font-mono text-neutral-400">{acctFmt(compareData.totalRevenue)}</td>}{compareData && <td className="px-4 py-2 text-right font-mono">{acctFmt(plData.totalRevenue - compareData.totalRevenue, true)}</td>}</tr>
      <tr className="bg-neutral-50 font-bold"><td className="px-4 py-2" colSpan={compareData ? 4 : 2}>Expenses</td></tr>
      {plData.expenses.filter(a=>a.amount!==0).map(a => { const prior = compareData?.expenses.find(p=>p.id===a.id); return <tr key={a.id} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700 pl-8">{a.name}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(a.amount)}</td>{compareData && <td className="px-4 py-2 text-right font-mono text-neutral-400">{prior ? acctFmt(prior.amount) : "—"}</td>}{compareData && <td className={`px-4 py-2 text-right font-mono ${a.amount-(prior?.amount||0) < 0 ? "text-success-600" : a.amount-(prior?.amount||0) > 0 ? "text-danger-600" : ""}`}>{acctFmt(a.amount - (prior?.amount||0), true)}</td>}</tr>; })}
      <tr className="border-t border-neutral-300 font-bold"><td className="px-4 py-2 pl-8">Total Expenses</td><td className="px-4 py-2 text-right font-mono">{acctFmt(plData.totalExpenses)}</td>{compareData && <td className="px-4 py-2 text-right font-mono text-neutral-400">{acctFmt(compareData.totalExpenses)}</td>}{compareData && <td className="px-4 py-2 text-right font-mono">{acctFmt(plData.totalExpenses - compareData.totalExpenses, true)}</td>}</tr>
      <tr className="border-t-2 border-b-2 border-neutral-800 font-black"><td className="px-4 py-2">NET INCOME</td><td className="px-4 py-2 text-right font-mono">{acctFmt(plData.netIncome)}</td>{compareData && <td className="px-4 py-2 text-right font-mono text-neutral-400">{acctFmt(compareData.netIncome)}</td>}{compareData && <td className={`px-4 py-2 text-right font-mono ${plData.netIncome-compareData.netIncome > 0 ? "text-success-600" : "text-danger-600"}`}>{acctFmt(plData.netIncome - compareData.netIncome, true)}</td>}</tr>
      </tbody></table>
    </div>)}

    {/* AP Aging Summary */}
    {reportId === "ap_aging_summary" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">AP Aging Summary</p><p className="text-sm text-neutral-500 mt-1">As of {acctFmtDate(asOfDate)}</p></div>
      {(() => { const data = getAPAgingData(asOfDate); const vendors = Object.entries(data.byVendor).filter(([,d]) => Math.abs(d.total) > 0.01); return vendors.length === 0 ? <p className="text-center py-8 text-neutral-400">No outstanding payables</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Vendor</th><th className="px-4 py-2 text-right text-xs font-semibold text-success-600">Current</th><th className="px-4 py-2 text-right text-xs font-semibold text-warn-600">1-30</th><th className="px-4 py-2 text-right text-xs font-semibold text-notice-600">31-60</th><th className="px-4 py-2 text-right text-xs font-semibold text-danger-600">61-90</th><th className="px-4 py-2 text-right text-xs font-semibold text-danger-800">91+</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-700">Total</th></tr></thead>
      <tbody>{vendors.map(([vendor, d]) => <tr key={vendor} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{vendor}</td><td className="px-4 py-2 text-right font-mono">{d.current ? acctFmt(d.current) : ""}</td><td className="px-4 py-2 text-right font-mono">{d.days30 ? acctFmt(d.days30) : ""}</td><td className="px-4 py-2 text-right font-mono">{d.days60 ? acctFmt(d.days60) : ""}</td><td className="px-4 py-2 text-right font-mono">{d.days90 ? acctFmt(d.days90) : ""}</td><td className="px-4 py-2 text-right font-mono">{d.over90 ? acctFmt(d.over90) : ""}</td><td className="px-4 py-2 text-right font-mono font-semibold">{acctFmt(d.total)}</td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td className="px-4 py-2">TOTALS</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.summary.current)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.summary.days30)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.summary.days60)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.summary.days90)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.summary.over90)}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.summary.total)}</td></tr></tfoot></table>); })()}
    </div>)}

    {/* Unpaid Bills */}
    {reportId === "unpaid_bills" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Unpaid Bills</p></div>
      {(() => { const data = getUnpaidBills(); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No unpaid bills found</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Date</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Vendor</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Description</th><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Ref</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Amount</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-400 text-xs">{r.date}</td><td className="px-4 py-2 text-neutral-700">{r.vendor}</td><td className="px-4 py-2 text-xs text-neutral-500 truncate max-w-48">{r.description}</td><td className="px-4 py-2 font-mono text-xs text-brand-600">{r.jeNumber||""}</td><td className="px-4 py-2 text-right font-mono font-semibold">{acctFmt(r.amount)}</td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td colSpan={4} className="px-4 py-2">TOTAL</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.reduce((s,r)=>s+r.amount,0))}</td></tr></tfoot></table>); })()}
    </div>)}

    {/* Vendor Balance Summary */}
    {reportId === "vendor_balance_summary" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Vendor Balance Summary</p><p className="text-sm text-neutral-500 mt-1">As of {acctFmtDate(asOfDate)}</p></div>
      {(() => { const data = getVendorBalanceSummary(asOfDate); return data.length === 0 ? <p className="text-center py-8 text-neutral-400">No outstanding vendor balances</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Vendor</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Balance</th></tr></thead>
      <tbody>{data.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.vendor}</td><td className="px-4 py-2 text-right font-mono font-semibold">{acctFmt(r.total)}</td></tr>)}</tbody>
      <tfoot><tr className="border-t-2 border-neutral-800 font-bold"><td className="px-4 py-2">TOTAL OWED</td><td className="px-4 py-2 text-right font-mono">{acctFmt(data.reduce((s,r)=>s+r.total,0))}</td></tr></tfoot></table>); })()}
    </div>)}

    {/* Audit Log */}
    {reportId === "audit_log" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Audit Log</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      <button onClick={async () => { const d = await getAuditLog(start, end); setAuditData(d); }} className="text-xs bg-neutral-100 text-neutral-500 px-3 py-1.5 rounded-lg hover:bg-neutral-200 mb-3">Refresh</button>
      {auditData.length === 0 ? <p className="text-center py-8 text-neutral-400">No audit entries in this period</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Time</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">User</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Module</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Action</th><th className="px-3 py-2 text-left text-xs font-semibold text-neutral-500">Details</th></tr></thead>
      <tbody>{auditData.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-3 py-2 text-xs text-neutral-400 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td><td className="px-3 py-2 text-xs text-neutral-600">{r.user_email}</td><td className="px-3 py-2 text-xs"><span className="bg-neutral-100 text-neutral-600 px-1.5 py-0.5 rounded">{r.module}</span></td><td className="px-3 py-2 text-xs"><span className={`px-1.5 py-0.5 rounded ${r.action==="create"?"bg-success-100 text-success-700":r.action==="delete"?"bg-danger-100 text-danger-600":r.action==="update"?"bg-info-100 text-info-700":"bg-neutral-100 text-neutral-600"}`}>{r.action}</span></td><td className="px-3 py-2 text-xs text-neutral-500 max-w-64 truncate">{r.details}</td></tr>)}</tbody></table>)}
    </div>)}

    {/* Reconciliation Summary */}
    {reportId === "recon_summary" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Reconciliation Summary</p></div>
      <button onClick={async () => { const d = await getReconSummary(); setReconData(d); }} className="text-xs bg-neutral-100 text-neutral-500 px-3 py-1.5 rounded-lg hover:bg-neutral-200 mb-3">Refresh</button>
      {reconData.length === 0 ? <p className="text-center py-8 text-neutral-400">No reconciliations found</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Period</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Bank Balance</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Book Balance</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Difference</th><th className="px-4 py-2 text-center text-xs font-semibold text-neutral-500">Status</th></tr></thead>
      <tbody>{reconData.map((r,i) => <tr key={i} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{r.period}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(safeNum(r.bank_ending_balance))}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(safeNum(r.book_balance))}</td><td className={`px-4 py-2 text-right font-mono ${Math.abs(safeNum(r.difference)) < 0.01 ? "text-success-600" : "text-danger-600"}`}>{acctFmt(safeNum(r.difference))}</td><td className="px-4 py-2 text-center"><span className={`text-xs px-2 py-0.5 rounded-full ${r.status==="reconciled"?"bg-success-100 text-success-700":"bg-warn-100 text-warn-700"}`}>{r.status}</span></td></tr>)}</tbody></table>)}
    </div>)}

    {/* Budget vs Actuals */}
    {reportId === "budget_vs_actual" && (<div>
      <div className="text-center mb-6"><h4 className="text-lg font-bold text-neutral-900">{companyName}</h4><p className="text-sm text-neutral-500 mt-1">Budget vs. Actuals</p><p className="text-sm text-neutral-500 mt-1">{acctFmtDate(start)} through {acctFmtDate(end)}</p></div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setShowBudgetEditor(!showBudgetEditor)} className="text-xs bg-brand-100 text-brand-700 px-3 py-1.5 rounded-lg hover:bg-brand-200 font-semibold">{showBudgetEditor ? "Hide Budget Editor" : "Edit Budgets"}</button>
        <div><label className="text-xs text-neutral-500 mr-1">Budget Month:</label><input type="month" value={budgetMonth} onChange={e => { setBudgetMonth(e.target.value); fetchBudgets(e.target.value); }} className="border border-neutral-200 rounded-lg px-2 py-1 text-sm" /></div>
      </div>
      {showBudgetEditor && (<div className="bg-brand-50 rounded-xl p-4 mb-4 max-h-64 overflow-y-auto">
        <p className="text-xs font-semibold text-brand-700 mb-2">Set Monthly Budget for {budgetMonth}</p>
        <div className="space-y-1">{accounts.filter(a => a.is_active && ["Revenue","Expense","Cost of Goods Sold","Other Income","Other Expense"].includes(a.type)).sort((a,b) => (a.code||"").localeCompare(b.code||"")).map(a => {
          const existing = budgets.find(b => b.account_id === a.id);
          return <div key={a.id} className="flex items-center gap-2"><span className="text-xs text-neutral-600 w-48 truncate">{a.code||"•"} {a.name}</span><input type="number" defaultValue={existing?.amount || ""} onBlur={e => { if (e.target.value) saveBudget(a.id, a.name, e.target.value); }} placeholder="0.00" className="border border-brand-200 rounded-lg px-2 py-1 text-xs w-24 text-right font-mono" /></div>;
        })}</div>
      </div>)}
      {(() => { const data = getBudgetVsActual(start, end); const hasAnyBudget = data.some(a => a.budget > 0); return !hasAnyBudget ? <p className="text-center py-8 text-neutral-400">No budgets set. Click "Edit Budgets" to set monthly amounts.</p> : (<table className="w-full text-sm"><thead className="bg-neutral-50"><tr><th className="px-4 py-2 text-left text-xs font-semibold text-neutral-500">Account</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Actual</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Budget</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Variance ($)</th><th className="px-4 py-2 text-right text-xs font-semibold text-neutral-500">Variance (%)</th></tr></thead>
      <tbody>{data.filter(a => a.budget > 0).map(a => { const favorable = a.isExpense ? a.variance < 0 : a.variance > 0; return <tr key={a.id} className="border-t border-neutral-100"><td className="px-4 py-2 text-neutral-700">{a.name}</td><td className="px-4 py-2 text-right font-mono">{acctFmt(a.amount)}</td><td className="px-4 py-2 text-right font-mono text-neutral-400">{acctFmt(a.budget)}</td><td className={`px-4 py-2 text-right font-mono font-semibold ${favorable ? "text-success-600" : "text-danger-600"}`}>{acctFmt(a.variance, true)}</td><td className={`px-4 py-2 text-right ${favorable ? "text-success-600" : "text-danger-600"}`}>{a.variancePct > 0 ? "+" : ""}{a.variancePct}%</td></tr>; })}</tbody></table>); })()}
    </div>)}

    </div>
  </div>
  );
}

export function csvParseText(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const parseRow = (line) => { const result=[]; let cur="",inQ=false; for(let i=0;i<line.length;i++){const ch=line[i]; if(ch==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}else if(ch===","&&!inQ){result.push(cur.trim());cur="";}else cur+=ch;} result.push(cur.trim()); return result; };
  let hIdx=0; for(let i=0;i<Math.min(5,lines.length);i++){if(lines[i].includes(",")){hIdx=i;break;}}
  const headers = parseRow(lines[hIdx]).map(h=>h.replace(/^"|"$/g,"").trim());
  const rows=[]; for(let i=hIdx+1;i<lines.length;i++){const line=lines[i].trim();if(!line||line.startsWith("#"))continue;const vals=parseRow(line);if(vals.length<2)continue;const obj={};headers.forEach((h,idx)=>{obj[h]=(vals[idx]||"").replace(/^"|"$/g,"").trim();});rows.push(obj);}
  return {headers,rows};
}

export const KNOWN_BANK_FORMATS = [
  { name: "Chase", headers: ["Details","Posting Date","Description","Amount","Type","Balance","Check or Slip #"], mapping: { date:"Posting Date", description:"Description", amount:"Amount", memo:"Details", check_number:"Check or Slip #" } },
  { name: "Bank of America", headers: ["Date","Description","Amount","Running Bal."], mapping: { date:"Date", description:"Description", amount:"Amount" } },
  { name: "Wells Fargo", headers: ["Date","Amount","*","Description"], mapping: { date:"Date", description:"Description", amount:"Amount" } },
  { name: "Citibank", headers: ["Status","Date","Description","Debit","Credit"], mapping: { date:"Date", description:"Description", debit:"Debit", credit:"Credit" } },
  { name: "Capital One", headers: ["Transaction Date","Posted Date","Card No.","Description","Category","Debit","Credit"], mapping: { date:"Transaction Date", description:"Description", debit:"Debit", credit:"Credit" } },
  { name: "US Bank", headers: ["Date","Transaction","Name","Memo","Amount"], mapping: { date:"Date", description:"Name", amount:"Amount", memo:"Memo" } },
];

export function csvDetectFormat(headers) {
  const norm = headers.map(h=>h.toLowerCase().trim());
  for(const fmt of KNOWN_BANK_FORMATS){const fh=fmt.headers.map(h=>h.toLowerCase().trim());if(fh.filter(h=>h&&norm.includes(h)).length>=2)return fmt;}
  return null;
}

export function csvParseAmount(rawAmt,rawDebit,rawCredit) {
  const clean=(s)=>{if(!s)return 0;s=String(s).trim().replace(/[$,\s]/g,"");const neg=s.startsWith("(")||s.startsWith("-");s=s.replace(/[()]/g,"").replace(/^-/,"");const v=parseFloat(s)||0;return neg?-v:v;};
  if(rawDebit!==undefined||rawCredit!==undefined){const d=clean(rawDebit),c=clean(rawCredit);if(c>0)return c;if(d>0)return -d;return 0;}
  return clean(rawAmt);
}

export function csvParseDate(raw) {
  if(!raw)return "";raw=String(raw).trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(raw))return raw.substring(0,10);
  const mdy=raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);if(mdy)return `${mdy[3]}-${mdy[1].padStart(2,"0")}-${mdy[2].padStart(2,"0")}`;
  const mdy2=raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);if(mdy2){const yr=parseInt(mdy2[3])>50?"19"+mdy2[3]:"20"+mdy2[3];return `${yr}-${mdy2[1].padStart(2,"0")}-${mdy2[2].padStart(2,"0")}`;}
  try{const d=new Date(raw);if(!isNaN(d))return d.toISOString().slice(0,10);}catch(_e){pmError("PM-8006",{raw:_e,context:"date parsing fallback",silent:true});}
  return raw;
}

export function csvBuildFingerprint(feedId, date, amount, description) {
  const norm = (description || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 100);
  return `${feedId}|${date}|${Math.round(amount * 100)}|${norm}`;
}

export function Accounting({ companySettings = {}, companyId, activeCompany, addNotification, userProfile, showToast, showConfirm, initialAction }) {
  const [acctAccounts, setAcctAccounts] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]);
  const [acctClasses, setAcctClasses] = useState([]);
  const [acctTenants, setAcctTenants] = useState([]);
  const [acctVendors, setAcctVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(initialAction === "newJE" ? "journal" : "overview");
  const [ledgerView, setLedgerView] = useState(null); // { accountIds: [], title: "" }
  const [viewJEId, setViewJEId] = useState(null); // JE ID to auto-open in journal tab
  const [pendingLedgerReturn, setPendingLedgerReturn] = useState(null); // { accountIds, title } — restore ledger after viewing JE
  const companyName = activeCompany?.name || "My Company";

  useEffect(() => { fetchAll(); }, [companyId]);

  async function fetchAll() {
  setLoading(true);
  try {
  const [acctsRes, jesRes, clsRes, tenantsRes, vendorsRes] = await Promise.all([
  supabase.from("acct_accounts").select("*").eq("company_id", companyId).order("code"),
  supabase.from("acct_journal_entries").select("*").eq("company_id", companyId).order("date", { ascending: false }),
  supabase.from("acct_classes").select("*").eq("company_id", companyId).order("name"),
  supabase.from("tenants").select("id, name, property").eq("company_id", companyId).is("archived_at", null).order("name"),
  supabase.from("vendors").select("id, name").eq("company_id", companyId).is("archived_at", null).order("name"),
  ]);
  // Normalize account types to PascalCase (DB may have lowercase from older seeds)
  const _typeNorm = { asset: "Asset", liability: "Liability", equity: "Equity", revenue: "Revenue", expense: "Expense", income: "Revenue", "other income": "Other Income", "other expense": "Other Expense", "cost of goods sold": "Cost of Goods Sold" };
  let accounts = (acctsRes.data || []).map(a => ({ ...a, type: _typeNorm[(a.type || "").toLowerCase()] || a.type }));
  const jeHeaders = jesRes.data || [];
  const classes = clsRes.data || [];

  // Ensure default chart of accounts exists (creates if missing)
  if (accounts.length === 0) {
  const defaults = [
  { code: "1000", name: "Checking Account", type: "Asset", is_active: true },
  { code: "1100", name: "Accounts Receivable", type: "Asset", is_active: true },
  { code: "2100", name: "Security Deposits Held", type: "Liability", is_active: true },
  { code: "2200", name: "Owner Distributions Payable", type: "Liability", is_active: true },
  { code: "4000", name: "Rental Income", type: "Revenue", is_active: true },
  { code: "4010", name: "Late Fee Income", type: "Revenue", is_active: true },
  { code: "4100", name: "Other Income", type: "Revenue", is_active: true },
  { code: "4200", name: "Management Fee Income", type: "Revenue", is_active: true },
  { code: "5300", name: "Repairs & Maintenance", type: "Expense", is_active: true },
  { code: "5400", name: "Utilities Expense", type: "Expense", is_active: true },
  ];
  for (const acct of defaults) {
  const oldTextId = companyId + "-" + acct.code;
  const { error: insErr } = await supabase.from("acct_accounts").insert([{ ...acct, company_id: companyId, old_text_id: oldTextId }]);
  if (insErr) pmError("PM-4006", { raw: insErr, context: "default account insert for " + acct.code, silent: true });
  }
  const { data: freshAccts, error: fetchErr } = await supabase.from("acct_accounts").select("*").eq("company_id", companyId).order("code");
  // Default accounts created (debug removed)
  accounts = (freshAccts || []).map(a => ({ ...a, type: _typeNorm[(a.type || "").toLowerCase()] || a.type }));
  if (accounts.length === 0) pmError("PM-4006", { raw: { message: "No accounts created" }, context: "create default chart of accounts" });
  }

  // Fetch all journal lines for this company's JEs and attach to entries
  if (jeHeaders.length > 0) {
  const jeIds = jeHeaders.map(je => je.id);
  const { data: allLines } = await supabase.from("acct_journal_lines").select("*").in("journal_entry_id", jeIds);
  const linesByJE = {};
  (allLines || []).forEach(l => { if (!linesByJE[l.journal_entry_id]) linesByJE[l.journal_entry_id] = []; linesByJE[l.journal_entry_id].push(l); });
  jeHeaders.forEach(je => { je.lines = linesByJE[je.id] || []; });
  }

  // Auto-sync property classes (only on first load, not every re-fetch)
  if (!window._propClassesSynced || window._propClassesSyncedFor !== companyId) {
  const { data: allProps } = await supabase.from("properties").select("id, address, type, rent").eq("company_id", companyId);
  if (allProps && allProps.length > 0) {
  const existingNames = new Set(classes.map(c => c.name));
  const colors = ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"];
  const missing = allProps.filter(p => !existingNames.has(p.address));
  if (missing.length > 0) {
  const newClasses = missing.map(p => ({
  id: crypto.randomUUID(),
  name: p.address,
  description: `${p.type || "Property"} · ${formatCurrency(p.rent || 0)}/mo`,
  color: pickColor(p.address),
  is_active: true,
  company_id: companyId,
  }));
  await supabase.from("acct_classes").upsert(newClasses, { onConflict: "company_id,name" });
  // Re-fetch classes after sync
  const { data: updatedClasses } = await supabase.from("acct_classes").select("*").eq("company_id", companyId).order("name");
  if (updatedClasses) classes.splice(0, classes.length, ...updatedClasses);
  }
  }
  } // end _propClassesSynced guard

  // Backfill: create AR sub-accounts for active tenants missing them (runs once)
  if (!window._tenantArBackfilled || window._tenantArBackfilledFor !== companyId) {
  window._tenantArBackfilled = true;
  window._tenantArBackfilledFor = companyId;
  const { data: activeTenants } = await supabase.from("tenants").select("id, name").eq("company_id", companyId).eq("lease_status", "active").is("archived_at", null);
  if (activeTenants && activeTenants.length > 0) {
  const existingArNames = new Set(accounts.filter(a => (a.code || "").startsWith("1100-")).map(a => (a.name || "").toLowerCase()));
  const missing = activeTenants.filter(t => !existingArNames.has("ar - " + (t.name || "").toLowerCase()));
  for (const t of missing) {
  await getOrCreateTenantAR(companyId, t.name, t.id);
  }
  if (missing.length > 0) {
  // Re-fetch accounts to include newly created sub-accounts
  const { data: refreshedAccts } = await supabase.from("acct_accounts").select("*").eq("company_id", companyId).order("code");
  if (refreshedAccts) accounts = refreshedAccts.map(a => ({ ...a, type: _typeNorm[(a.type || "").toLowerCase()] || a.type }));
  }
  }
  }

  // Backfill: patch missing class_id on JE lines using authoritative property→class_id lookup
  if (!window._classIdBackfilled || window._classIdBackfilledFor !== companyId) {
  window._classIdBackfilled = true;
  window._classIdBackfilledFor = companyId;
  let patched = 0;
  for (const je of jeHeaders) {
  if (!je.property || !je.lines) continue;
  const nullLines = je.lines.filter(l => !l.class_id);
  if (nullLines.length === 0) continue;
  // Use the authoritative lookup: property address → properties.class_id
  const classId = await getPropertyClassId(je.property, companyId);
  if (classId) {
  for (const l of nullLines) {
  await supabase.from("acct_journal_lines").update({ class_id: classId }).eq("id", l.id).eq("company_id", companyId);
  l.class_id = classId;
  patched++;
  }
  }
  }
  if (patched > 0) console.info("[accounting] Backfilled class_id on " + patched + " JE lines");
  }

  // Backfill: renumber old JEs with hash-style numbers (JE-MN2L16YX → JE-0001)
  if (!window._jeRenumbered || window._jeRenumberedFor !== companyId) {
  window._jeRenumbered = true;
  window._jeRenumberedFor = companyId;
  const oldFormatJEs = jeHeaders.filter(je => je.number && !/^JE-\d{4,}$/.test(je.number)).sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.created_at || "").localeCompare(b.created_at || ""));
  if (oldFormatJEs.length > 0) {
  // Find the highest existing sequential number
  const seqNums = jeHeaders.map(je => { const m = (je.number || "").match(/^JE-(\d+)$/); return m ? parseInt(m[1]) : 0; });
  let nextNum = Math.max(0, ...seqNums) + 1;
  for (const je of oldFormatJEs) {
  const newNumber = "JE-" + String(nextNum).padStart(4, "0");
  await supabase.from("acct_journal_entries").update({ number: newNumber }).eq("id", je.id).eq("company_id", companyId);
  je.number = newNumber;
  nextNum++;
  }
  }
  }

  setAcctAccounts(accounts);
  setJournalEntries(jeHeaders);
  setAcctClasses(classes);
  setAcctTenants(tenantsRes.data || []);
  setAcctVendors(vendorsRes.data || []);
  } finally { setLoading(false); }
  }

  // --- Account CRUD ---
  async function addAccount(acct) {
  if (!guardSubmit("addAccount")) return;
  try {
  const { error } = await supabase.from("acct_accounts").insert([{ ...acct, company_id: companyId, old_text_id: companyId + "-" + (acct.code || shortId()) }]);
  if (error) { pmError("PM-4006", { raw: error, context: "create account" }); return; }
  fetchAll();
  } finally { guardRelease("addAccount"); }
  }
  async function updateAccount(acct) {
  const { id } = acct;
  const { error } = await supabase.from("acct_accounts").update({
  name: acct.name, type: acct.type, subtype: acct.subtype,
  is_active: acct.is_active, description: acct.description || ""
  }).eq("company_id", companyId).eq("id", id);
  if (error) { pmError("PM-4006", { raw: error, context: "update account" }); return; }
  fetchAll();
  }
  async function toggleAccount(id, currentActive) {
  if (currentActive) {
  const { data: refs } = await supabase.from("acct_journal_lines").select("id").eq("account_id", id).eq("company_id", companyId).limit(1);
  if (refs?.length > 0 && !await showConfirm({ message: "This account has journal entries. Deactivating will hide it from reports but existing entries remain. Continue?" })) return;
  }
  const { error: _err3877 } = await supabase.from("acct_accounts").update({ is_active: !currentActive }).eq("company_id", companyId).eq("id", id);
  if (_err3877) { showToast("Error updating acct_accounts: " + _err3877.message, "error"); return; }
  fetchAll();
  }
  async function deleteGLAccount(id) {
  // Safety: check for journal entries
  const { data: jeRefs } = await supabase.from("acct_journal_lines").select("id").eq("account_id", id).eq("company_id", companyId).limit(1);
  if (jeRefs?.length > 0) { showToast("Cannot delete: account has journal entries. Deactivate instead.", "error"); return; }
  // Safety: check for linked ACTIVE bank feed (disconnected feeds don't block deletion)
  const { data: feedRefs } = await supabase.from("bank_account_feed").select("id").eq("gl_account_id", id).eq("company_id", companyId).eq("status", "active").limit(1);
  if (feedRefs?.length > 0) { showToast("Cannot delete: account is linked to an active bank feed. Disconnect the feed first.", "error"); return; }
  // Unlink any inactive feeds referencing this account
  await supabase.from("bank_account_feed").update({ gl_account_id: null }).eq("gl_account_id", id).eq("company_id", companyId).neq("status", "active");
  const acct = acctAccounts.find(a => a.id === id);
  if (!await showConfirm({ message: `Permanently delete account ${acct?.code || ""} ${acct?.name || ""}? This cannot be undone.` })) return;
  const { error } = await supabase.from("acct_accounts").delete().eq("id", id).eq("company_id", companyId);
  if (error) { showToast("Error deleting account: " + error.message, "error"); return; }
  // Hard deletes of chart-of-account rows deserve a trail — an auditor
  // who later asks "where did account 5700 go?" needs to see this.
  logAudit("delete", "accounting", `Permanently deleted account ${acct?.code || ""} ${acct?.name || ""}`, String(id), userProfile?.email, userRole, companyId);
  showToast("Account deleted.", "success");
  fetchAll();
  }

  // --- Journal Entry CRUD ---
  async function addJournalEntry(data) {
  if (!guardSubmit("addJournalEntry")) return;
  try {
  const { lines, ...header } = data;
  // Period lock check
  if (await checkPeriodLock(companyId, header.date)) { showToast("Cannot post to a locked accounting period (" + header.date + ").", "error"); return; }
  // Validate DR/CR balance
  if (lines?.length > 0) {
  const v = validateJE(lines);
  if (!v.isValid) { showToast("Journal entry is out of balance by $" + v.difference.toFixed(2) + ". Debits must equal credits.", "error"); return; }
  }
  const number = nextJENumber(journalEntries);
  // Direct insert — no RPC
  const { data: jeRow, error: headerErr } = await supabase.from("acct_journal_entries").insert([{
  company_id: companyId, number, date: header.date, description: header.description,
  reference: header.reference || "", property: header.property || "", status: header.status || "draft"
  }]).select("id").maybeSingle();
  if (headerErr || !jeRow) { showToast("Error creating journal entry: " + (headerErr?.message || "No ID returned"), "error"); return; }
  if (lines?.length > 0) {
  const { error: linesErr } = await supabase.from("acct_journal_lines").insert(lines.map(l => ({
  journal_entry_id: jeRow.id, company_id: companyId,
  account_id: l.account_id, account_name: l.account_name,
  debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || "",
  entity_type: l.entity_type || null, entity_id: l.entity_id || null, entity_name: l.entity_name || null
  })));
  if (linesErr) {
  { const { error: _delErr } = await supabase.from("acct_journal_entries").delete().eq("id", jeRow.id).eq("company_id", companyId); if (_delErr) pmError("PM-4002", { raw: _delErr, context: "orphaned JE header cleanup", silent: true }); }
  showToast("Error creating journal entry lines: " + linesErr.message, "error");
  return;
  }
  }
  fetchAll();
  } finally { guardRelease("addJournalEntry"); }
  }
  async function updateJournalEntry(data) {
  const { id, lines, ...header } = data;
  delete header.created_at;
  // Period lock check
  if (await checkPeriodLock(companyId, header.date)) { showToast("Cannot edit a journal entry in a locked period.", "error"); return; }
  // Validate debit/credit balance before saving
  if (lines?.length > 0) {
  const v = validateJE(lines);
  if (!v.isValid) { showToast("Journal entry is out of balance by $" + v.difference.toFixed(2) + ". Debits must equal credits.", "error"); return; }
  }
  delete header.number;
  // Save old lines before deleting so we can restore on failure
  const { data: oldLines } = await supabase.from("acct_journal_lines").select("*").eq("journal_entry_id", id);
  await supabase.from("acct_journal_entries").update({ date: header.date, description: header.description, reference: header.reference || "", property: header.property || "", status: header.status }).eq("company_id", companyId).eq("id", id);
  // Replace lines
  const { error: _err3930 } = await supabase.from("acct_journal_lines").delete().eq("journal_entry_id", id).eq("company_id", companyId);
  if (_err3930) { pmError("PM-4003", { raw: _err3930, context: "acct_journal_lines delete before re-insert" }); fetchAll(); return; }
  if (lines?.length > 0) {
  const { error: linesErr } = await supabase.from("acct_journal_lines").insert(lines.map(l => ({ journal_entry_id: id, company_id: companyId, account_id: l.account_id, account_name: l.account_name, debit: safeNum(l.debit), credit: safeNum(l.credit), class_id: l.class_id || null, memo: l.memo || "", entity_type: l.entity_type || null, entity_id: l.entity_id || null, entity_name: l.entity_name || null })));
  if (linesErr) {
  pmError("PM-4003", { raw: linesErr, context: "update journal lines failed, restoring" });
  if (oldLines?.length > 0) {
  await supabase.from("acct_journal_lines").insert(oldLines.map(l => ({ journal_entry_id: id, company_id: companyId, account_id: l.account_id, account_name: l.account_name, debit: l.debit, credit: l.credit, class_id: l.class_id, memo: l.memo, entity_type: l.entity_type, entity_id: l.entity_id, entity_name: l.entity_name })));
  }
  showToast("Error updating journal lines: " + linesErr.message, "error");
  fetchAll();
  return;
  }
  }
  fetchAll();
  }
  async function postJournalEntry(id) {
  if (!guardSubmit("postJE", id)) return;
  try {
  const je = journalEntries.find(j => j.id === id);
  if (!je?.lines || je.lines.length === 0) { showToast("Cannot post a journal entry with no lines.", "error"); return; }
  const v = validateJE(je.lines);
  if (!v.isValid) { showToast("Cannot post: journal entry is out of balance by $" + v.difference.toFixed(2), "error"); return; }
  const { error: _err3952 } = await supabase.from("acct_journal_entries").update({ status: "posted" }).eq("company_id", companyId).eq("id", id);
  if (_err3952) { showToast("Error updating acct_journal_entries: " + _err3952.message, "error"); return; }
  fetchAll();
  } finally { guardRelease("postJE", id); }
  }
  async function voidJournalEntry(id) {
  if (!guardSubmit("voidJE", id)) return;
  try {
  const je = journalEntries.find(j => j.id === id);
  // Period lock check
  if (je && await checkPeriodLock(companyId, je.date)) { showToast("Cannot void a journal entry in a locked period (" + je.date + ").", "error"); return; }
  const { error: voidErr } = await supabase.from("acct_journal_entries").update({ status: "voided" }).eq("company_id", companyId).eq("id", id);
  if (voidErr) { showToast("Error voiding entry: " + voidErr.message, "error"); return; }
  showToast("Journal entry voided.", "success");
  // Reverse tenant balance based on JE type
  if (je) {
  const { data: jeLines } = await supabase.from("acct_journal_lines").select("*").eq("journal_entry_id", id);
  const arAccountIds = new Set(acctAccounts.filter(a => a.name === "Accounts Receivable").map(a => a.id));
  const descParts = (je.description || "").split(" — ");
  const tenantName = descParts.length >= 2 ? descParts[1] : "";

  if (tenantName.trim()) {
  const { data: tenantRow } = await supabase.from("tenants").select("id, balance").ilike("name", escapeFilterValue(tenantName.trim())).eq("company_id", companyId).is("archived_at", null).maybeSingle();

  if (!tenantRow) {
  showToast(`Warning: Tenant "${tenantName}" not found — balance was NOT reversed. Please adjust manually if needed.`, "warning");
  pmError("PM-6002", { raw: { message: "Tenant not found for void balance reversal: " + tenantName }, context: "void JE balance lookup", silent: true });
  }
  if (tenantRow && jeLines) {
  const arImpact = jeLines.filter(l => arAccountIds.has(l.account_id))
  .reduce((s, l) => s + safeNum(l.debit) - safeNum(l.credit), 0);

  if (Math.abs(arImpact) > 0.01) {
  try {
  const { error: balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantRow.id, p_amount_change: -arImpact });
  if (balErr) showToast("Balance update failed: " + balErr.message + ". Please verify the tenant balance.", "error");
  } catch (e) { pmError("PM-6002", { raw: e, context: "void balance RPC", silent: true }); }
  await safeLedgerInsert({ company_id: companyId,
  tenant: tenantName.trim(), property: je.property || "",
  date: formatLocalDate(new Date()),
  description: "Voided: " + (je.description || "").slice(0, 60),
  amount: -arImpact, type: "void", balance: 0,
  });
  }
  }
  }
  }
  fetchAll();
  } catch (e) { showToast("Error voiding entry: " + e.message, "error"); } finally { guardRelease("voidJE", id); }
  }

  // --- Class CRUD ---
  async function addClass(cls) {
  if (!guardSubmit("addClass")) return;
  try {
  const { error } = await supabase.from("acct_classes").insert([{ ...cls, company_id: companyId }]);
  if (error) { pmError("PM-4010", { raw: error, context: "create accounting class" }); return; }
  fetchAll();
  } finally { guardRelease("addClass"); }
  }
  async function updateClass(cls) {
  const { id } = cls;
  const { error } = await supabase.from("acct_classes").update({
  name: cls.name, type: cls.type, is_active: cls.is_active,
  description: cls.description || "", color: cls.color || "#3B82F6"
  }).eq("company_id", companyId).eq("id", id);
  if (error) { pmError("PM-4010", { raw: error, context: "update accounting class" }); return; }
  fetchAll();
  }
  async function toggleClass(id, currentActive) {
  const { error: _err4013 } = await supabase.from("acct_classes").update({ is_active: !currentActive }).eq("company_id", companyId).eq("id", id);
  if (_err4013) { showToast("Error updating acct_classes: " + _err4013.message, "error"); return; }
  fetchAll();
  }

  if (loading) return <Spinner />;

  // --- Overview Dashboard Data ---
  const { start: ytdStart, end: ytdEnd } = getPeriodDates("This Year");
  const plData = getPLData(acctAccounts, journalEntries, ytdStart, ytdEnd);
  const bsData = getBalanceSheetData(acctAccounts, journalEntries, ytdEnd);
  const pendingCount = journalEntries.filter(j => j.status === "draft").length;

  const acctSidebarItems = [
  { section: "OVERVIEW", items: [{ id: "overview", label: "Dashboard", icon: "dashboard" }] },
  { section: "TRANSACTIONS", items: [
    { id: "coa", label: "Chart of Accounts", icon: "account_balance" },
    { id: "journal", label: "Journal Entries", icon: "receipt_long", badge: pendingCount },
    { id: "recurring", label: "Recurring Entries", icon: "autorenew" },
  ]},
  { section: "BANKING", items: [
    { id: "bankimport", label: "Bank Transactions", icon: "account_balance" },
    { id: "reconcile", label: "Reconcile", icon: "account_balance_wallet" },
  ]},
  { section: "ANALYSIS", items: [
    { id: "classes", label: "Class Tracking", icon: "category" },
    { id: "reports", label: "Reports", icon: "assessment" },
  ]},
  ];

  return (
  <div className="flex flex-col md:flex-row gap-0 -mx-4 md:-mx-6 -mt-2">
  {/* Left Sidebar Nav — desktop */}
  <div className="hidden md:block w-56 shrink-0 border-r border-neutral-200 bg-white min-h-[calc(100vh-180px)] py-4 px-2">
  {acctSidebarItems.map(group => (
  <div key={group.section}>
    <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-semibold px-3 mt-4 mb-1">{group.section}</p>
    {group.items.map(item => (
      <button key={item.id} onClick={() => setActiveTab(item.id)} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === item.id ? "bg-positive-50 text-positive-700 border-l-3 border-positive-600" : "text-neutral-600 hover:bg-neutral-50"}`}>
        <span className="material-icons-outlined text-lg">{item.icon}</span>
        <span className="truncate">{item.label}</span>
        {item.badge > 0 && <span className="ml-auto bg-warn-100 text-warn-700 text-xs px-1.5 py-0.5 rounded-full">{item.badge}</span>}
      </button>
    ))}
  </div>
  ))}
  </div>

  {/* Mobile horizontal tab bar */}
  <div className="md:hidden flex gap-2 px-4 py-2 border-b border-neutral-200 overflow-x-auto w-full bg-white">
  {acctSidebarItems.flatMap(g => g.items).map(item => (
    <button key={item.id} onClick={() => setActiveTab(item.id)} className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${activeTab === item.id ? "bg-positive-50 text-positive-700" : "text-neutral-500 hover:bg-neutral-50"}`}>
      <span className="material-icons-outlined text-base">{item.icon}</span>
      {item.label}
      {item.badge > 0 && <span className="ml-1 bg-warn-100 text-warn-700 text-xs px-1.5 py-0.5 rounded-full">{item.badge}</span>}
    </button>
  ))}
  </div>

  {/* Content Area */}
  <div className="flex-1 min-w-0 px-4 md:px-6 py-2">

  {activeTab === "overview" && (
  <div>
  {/* QuickBooks-style metric cards */}
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
    <div className="bg-white rounded-xl border border-neutral-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-neutral-500">Total Revenue</span>
        <span className="w-10 h-10 rounded-lg bg-success-50 flex items-center justify-center">
          <span className="material-icons-outlined text-success-600 text-xl">trending_up</span>
        </span>
      </div>
      <p className="text-2xl font-bold text-neutral-900 font-mono">{acctFmt(plData.totalRevenue)}</p>
      <p className="text-xs text-neutral-400 mt-1">Year to date</p>
    </div>
    <div className="bg-white rounded-xl border border-neutral-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-neutral-500">Total Expenses</span>
        <span className="w-10 h-10 rounded-lg bg-danger-50 flex items-center justify-center">
          <span className="material-icons-outlined text-danger-600 text-xl">trending_down</span>
        </span>
      </div>
      <p className="text-2xl font-bold text-neutral-900 font-mono">{acctFmt(plData.totalExpenses)}</p>
      <p className="text-xs text-neutral-400 mt-1">Year to date</p>
    </div>
    <div className="bg-white rounded-xl border border-neutral-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-neutral-500">Net Income</span>
        <span className="w-10 h-10 rounded-lg bg-info-50 flex items-center justify-center">
          <span className="material-icons-outlined text-info-600 text-xl">account_balance</span>
        </span>
      </div>
      <p className={`text-2xl font-bold font-mono ${plData.netIncome >= 0 ? "text-neutral-900" : "text-danger-600"}`}>{acctFmt(plData.netIncome)}</p>
      <p className="text-xs text-neutral-400 mt-1">Year to date</p>
    </div>
    <div className="bg-white rounded-xl border border-neutral-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-neutral-500">Total Assets</span>
        <span className="w-10 h-10 rounded-lg bg-accent-50 flex items-center justify-center">
          <span className="material-icons-outlined text-accent-600 text-xl">business</span>
        </span>
      </div>
      <p className="text-2xl font-bold text-neutral-900 font-mono">{acctFmt(bsData.totalAssets)}</p>
      <p className="text-xs text-neutral-400 mt-1">Balance sheet</p>
    </div>
  </div>

  {/* Quick Actions */}
  <div className="flex gap-3 mb-6 overflow-x-auto">
    <button onClick={() => setActiveTab("journal")} className="flex items-center gap-2 bg-white border border-neutral-200 rounded-xl px-4 py-3 text-sm text-neutral-700 hover:border-positive-300 hover:shadow-sm transition-all whitespace-nowrap">
      <span className="material-icons-outlined text-positive-600 text-lg">add_circle</span>
      New Journal Entry
    </button>
    <button onClick={() => setActiveTab("recurring")} className="flex items-center gap-2 bg-white border border-neutral-200 rounded-xl px-4 py-3 text-sm text-neutral-700 hover:border-positive-300 hover:shadow-sm transition-all whitespace-nowrap">
      <span className="material-icons-outlined text-positive-600 text-lg">autorenew</span>
      Recurring Entries
    </button>
    <button onClick={() => setActiveTab("reports")} className="flex items-center gap-2 bg-white border border-neutral-200 rounded-xl px-4 py-3 text-sm text-neutral-700 hover:border-positive-300 hover:shadow-sm transition-all whitespace-nowrap">
      <span className="material-icons-outlined text-positive-600 text-lg">assessment</span>
      Run Reports
    </button>
  </div>

  {/* Two-column layout: Recent Entries + Summary */}
  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
    {/* Left: Recent Transactions (2/3) */}
    <div className="lg:col-span-2 bg-white rounded-xl border border-neutral-200">
      <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-100">
        <h3 className="font-semibold text-neutral-800">Recent Journal Entries</h3>
        <button onClick={() => setActiveTab("journal")} className="text-xs text-positive-600 hover:underline">View All</button>
      </div>
      <div className="divide-y divide-neutral-100">
        {journalEntries.slice(0, 8).map(je => {
        const total = (je.lines || []).reduce((s,l) => s + safeNum(l.debit), 0);
        return (
          <div key={je.id} className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50 transition-colors">
            <div className="flex items-center gap-3">
              <span className={`w-2.5 h-2.5 rounded-full ${je.status==="posted"?"bg-success-400":je.status==="draft"?"bg-warn-400":"bg-neutral-300"}`} />
              <div>
                <p className="text-sm text-neutral-700">{je.description}</p>
                <p className="text-xs text-neutral-400">{je.number} · {je.date}{je.property ? " · " + je.property.split(",")[0] : ""}</p>
              </div>
            </div>
            <div className="text-right">
              <span className="font-mono text-sm font-semibold text-neutral-800">{acctFmt(total)}</span>
              <div className="mt-0.5"><AcctStatusBadge status={je.status} /></div>
            </div>
          </div>
        );
        })}
        {journalEntries.length === 0 && <p className="text-sm text-neutral-400 text-center py-8">No journal entries yet</p>}
      </div>
    </div>

    {/* Right: Account Summary + Pending (1/3) */}
    <div className="space-y-4">
      {pendingCount > 0 && (
      <div className="bg-warn-50 border border-warn-200 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <span className="material-icons-outlined text-warn-600 text-lg">pending_actions</span>
          <span className="font-semibold text-warn-800 text-sm">Pending Actions</span>
        </div>
        <p className="text-sm text-warn-700">{pendingCount} draft journal {pendingCount === 1 ? "entry" : "entries"} awaiting review</p>
        <button onClick={() => setActiveTab("journal")} className="text-xs text-warn-700 font-semibold hover:underline mt-2">Review Now →</button>
      </div>
      )}
      <div className="bg-white rounded-xl border border-neutral-200">
        <div className="px-5 py-4 border-b border-neutral-100">
          <h3 className="font-semibold text-neutral-800">Account Summary</h3>
        </div>
        <div className="p-4 space-y-2">
          {["Asset","Liability","Equity","Revenue","Expense"].map(type => {
          const total = calcAllBalances(acctAccounts, journalEntries).filter(a => a.type === type && a.is_active).reduce((s,a) => s + a.computedBalance, 0);
          const colors = { Asset: "bg-info-500", Liability: "bg-danger-500", Equity: "bg-accent-500", Revenue: "bg-success-500", Expense: "bg-notice-500" };
          return (
            <div key={type} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-neutral-50">
              <div className="flex items-center gap-2.5">
                <span className={`w-2.5 h-2.5 rounded-full ${colors[type]}`} />
                <span className="text-sm text-neutral-700">{type}</span>
              </div>
              <span className={`font-mono text-sm font-semibold ${total < 0 ? "text-danger-600" : "text-neutral-800"}`}>{acctFmt(total, true)}</span>
            </div>
          );
          })}
        </div>
      </div>
    </div>
  </div>
  </div>
  )}

  {activeTab === "recurring" && <RecurringJournalEntries companyId={companyId} addNotification={addNotification} userProfile={userProfile} />}
  {activeTab === "coa" && <AcctChartOfAccounts accounts={acctAccounts} journalEntries={journalEntries} onAdd={addAccount} onUpdate={updateAccount} onToggle={toggleAccount} onDelete={deleteGLAccount} onOpenLedger={(ids, title) => setLedgerView({ accountIds: ids, title })} />}
  {activeTab === "journal" && <AcctJournalEntries accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} tenants={acctTenants} vendors={acctVendors} onAdd={addJournalEntry} onUpdate={updateJournalEntry} onPost={postJournalEntry} onVoid={voidJournalEntry} companyId={companyId} showToast={showToast} onOpenLedger={(ids, title) => setLedgerView({ accountIds: ids, title })} initialViewJEId={viewJEId} autoOpenAdd={initialAction === "newJE"} onCloseJEDetail={() => { if (pendingLedgerReturn) { setLedgerView(pendingLedgerReturn); setPendingLedgerReturn(null); setViewJEId(null); } }} />}
  {activeTab === "bankimport" && <BankTransactions accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} tenants={acctTenants} vendors={acctVendors} companyId={companyId} showToast={showToast} showConfirm={showConfirm} userProfile={userProfile} onRefreshAccounting={fetchAll} />}
  {activeTab === "reconcile" && <AcctBankReconciliation accounts={acctAccounts} journalEntries={journalEntries} companyId={companyId} showToast={showToast} showConfirm={showConfirm} userProfile={userProfile} />}
  {activeTab === "classes" && <AcctClassTracking accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} onAdd={addClass} onUpdate={updateClass} onToggle={toggleClass} onOpenLedger={(ids, title) => setLedgerView({ accountIds: ids, title })} />}
  {activeTab === "reports" && <AcctReports accounts={acctAccounts} journalEntries={journalEntries} classes={acctClasses} companyName={companyName} companyId={companyId} userProfile={userProfile} showToast={showToast} onOpenLedger={(ids, title) => setLedgerView({ accountIds: ids, title })} />}
  {/* Account Ledger Drill-Down */}
  {ledgerView && <AccountLedgerView accountIds={ledgerView.accountIds} accounts={acctAccounts} journalEntries={journalEntries} title={ledgerView.title} onClose={() => { setLedgerView(null); setPendingLedgerReturn(null); }} onViewJE={(jeId) => { setPendingLedgerReturn({ accountIds: ledgerView.accountIds, title: ledgerView.title }); setLedgerView(null); setViewJEId(jeId); setActiveTab("journal"); }} />}

  </div>
  </div>
  );
}
export function AcctBankReconciliation({ accounts, journalEntries, companyId, showToast, showConfirm, userProfile }) {
  const [reconPeriod, setReconPeriod] = useState(formatLocalDate(new Date()).slice(0, 7));
  const [bankBalance, setBankBalance] = useState("");
  const [reconItems, setReconItems] = useState([]);
  const [reconciliations, setReconciliations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showReconcile, setShowReconcile] = useState(false);
  const [viewRecon, setViewRecon] = useState(null);
  // Period lock
  const [periodLock, setPeriodLock] = useState(null);
  const [lockDate, setLockDate] = useState("");
  const [reconTab, setReconTab] = useState("reconcile"); // reconcile | period_lock

  useEffect(() => { fetchRecons(); fetchPeriodLock(); }, [companyId]);

  async function fetchPeriodLock() {
    const { data } = await supabase.from("accounting_period_lock").select("*").eq("company_id", companyId).maybeSingle();
    setPeriodLock(data);
    if (data?.lock_date) setLockDate(data.lock_date);
  }

  async function savePeriodLock() {
    if (!lockDate) { showToast("Please select a lock date.", "error"); return; }
    if (!await showConfirm({ message: `Lock all accounting periods through ${lockDate}? No transactions on or before this date can be posted, edited, or voided.`, confirmText: "Lock Period" })) return;
    const { error } = await supabase.from("accounting_period_lock").upsert({
      company_id: companyId, lock_date: lockDate, locked_by: userProfile?.email || "", notes: "Locked through " + lockDate
    }, { onConflict: "company_id" });
    if (error) { pmError("PM-4011", { raw: error, context: "lock accounting period" }); return; }
    logAudit("update", "accounting", `Period locked through ${lockDate}`, "", userProfile?.email, "", companyId);
    showToast(`Accounting period locked through ${lockDate}.`, "success");
    fetchPeriodLock();
  }

  async function removePeriodLock() {
    if (!await showConfirm({ message: "Remove the period lock? This will allow modifications to previously locked periods.", variant: "danger", confirmText: "Remove Lock" })) return;
    await supabase.from("accounting_period_lock").delete().eq("company_id", companyId);
    logAudit("update", "accounting", "Period lock removed", "", userProfile?.email, "", companyId);
    showToast("Period lock removed.", "success");
    setPeriodLock(null); setLockDate("");
  }

  async function fetchRecons() {
  const { data } = await supabase.from("bank_reconciliations").select("*").eq("company_id", companyId).order("created_at", { ascending: false });
  setReconciliations(data || []);
  setLoading(false);
  }

  async function startReconciliation() {
  if (!bankBalance || isNaN(Number(bankBalance))) { showToast("Please enter the bank ending balance.", "error"); return; }
  const startDate = reconPeriod + "-01";
  const endObj = parseLocalDate(startDate); endObj.setMonth(endObj.getMonth() + 1); endObj.setDate(0);
  const endDate = formatLocalDate(endObj);

  // Pull all journal lines hitting the Checking Account (1000) in this period
  const { data: entries } = await supabase.from("acct_journal_entries").select("id, date, description, reference, status").eq("company_id", companyId).gte("date", startDate).lte("date", endDate).eq("status", "posted");
  if (!entries || entries.length === 0) { showToast("No posted journal entries found for " + reconPeriod, "error"); return; }

  const entryIds = entries.map(e => e.id);
  const { data: lines } = await supabase.from("acct_journal_lines").select("*").in("journal_entry_id", entryIds).eq("account_name", "Checking Account");
  if (!lines || lines.length === 0) { showToast("No checking account transactions found for " + reconPeriod, "error"); return; }

  // Build reconciliation items
  const items = lines.map(l => {
  const entry = entries.find(e => e.id === l.journal_entry_id);
  const amount = safeNum(l.debit) - safeNum(l.credit);
  return {
  id: l.id,
  journal_entry_id: l.journal_entry_id,
  date: entry?.date || "",
  description: entry?.description || "",
  reference: entry?.reference || "",
  amount: amount,
  memo: l.memo || "",
  reconciled: l.reconciled || false,
  };
  }).sort((a, b) => a.date.localeCompare(b.date));

  setReconItems(items);
  setShowReconcile(true);
  }

  function autoMatchItems(items) {
  // Auto-match: check items where amount + date match patterns
  // Match rent payments (round amounts on 1st of month)
  // Match bank import references
  const matched = items.map(item => {
  const abs = Math.abs(item.amount);
  const ref = (item.reference || "").toLowerCase();
  const desc = (item.description || "").toLowerCase();
  // Auto-reconcile rent payments, stripe payments, and bank imports
  if (ref.startsWith("rent-auto") || ref.startsWith("pay-") || ref.startsWith("stripe-") || ref.startsWith("import-")) {
  return { ...item, reconciled: true, autoMatched: true };
  }
  // Auto-reconcile if description contains common patterns
  if (desc.includes("rent payment") || desc.includes("rent charge") || desc.includes("late fee") || desc.includes("security deposit")) {
  return { ...item, reconciled: true, autoMatched: true };
  }
  return item;
  });
  const matchCount = matched.filter(m => m.autoMatched).length;
  setReconItems(matched);
  if (matchCount > 0) showToast(`Auto-matched ${matchCount} of ${matched.length} items based on reference and description patterns.`, "success");
  else showToast("No auto-matches found. Please reconcile items manually.", "success");
  }

  function toggleReconItem(index) {
  const updated = [...reconItems];
  updated[index].reconciled = !updated[index].reconciled;
  setReconItems(updated);
  }

  function toggleAllRecon() {
  const allChecked = reconItems.every(i => i.reconciled);
  setReconItems(reconItems.map(i => ({ ...i, reconciled: !allChecked })));
  }

  async function saveReconciliation() {
  if (!guardSubmit("saveReconciliation")) return;
  try {
  const reconciledTotal = reconItems.filter(i => i.reconciled).reduce((s, i) => s + safeNum(i.amount), 0);
  const unreconciledTotal = reconItems.filter(i => !i.reconciled).reduce((s, i) => s + safeNum(i.amount), 0);

  // Calculate book balance from all checking account entries (scoped to this company)
  const cJeIds = journalEntries.filter(j => j.status === "posted").map(j => j.id);
  const { data: allLines } = cJeIds.length > 0
  ? await supabase.from("acct_journal_lines").select("debit, credit, account_id").eq("account_name", "Checking Account").in("journal_entry_id", cJeIds)
  : { data: [] };
  // Also include lines matched by checking account UUID (in case account was renamed)
  const checkingAcctId = await resolveAccountId("1000", companyId);
  const { data: idLines } = (cJeIds.length > 0 && checkingAcctId)
  ? await supabase.from("acct_journal_lines").select("debit, credit, account_id").eq("account_id", checkingAcctId).in("journal_entry_id", cJeIds)
  : { data: [] };
  const allCheckingLines = [...(allLines || [])];
  (idLines || []).forEach(l => { if (!allCheckingLines.find(x => x === l)) allCheckingLines.push(l); });
  const bookBal = allCheckingLines.reduce((s, l) => s + safeNum(l.debit) - safeNum(l.credit), 0);
  const bankBal = Number(bankBalance);
  const diff = Math.round((bankBal - bookBal) * 100) / 100;
  const allItemsReconciled = reconItems.every(i => i.reconciled);
  const status = Math.abs(diff) < 0.01 && allItemsReconciled ? "reconciled" : Math.abs(diff) < 0.01 && !allItemsReconciled ? "pending_items" : "discrepancy";

  // Save reconciliation record
  const { error } = await supabase.from("bank_reconciliations").insert([{ company_id: companyId,
  period: reconPeriod,
  bank_ending_balance: bankBal,
  book_balance: Math.round(bookBal * 100) / 100,
  difference: diff,
  status: status,
  reconciled_items: JSON.stringify(reconItems.filter(i => i.reconciled)),
  unreconciled_items: JSON.stringify(reconItems.filter(i => !i.reconciled)),
  reconciled_by: "",
  }]);
  if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }

  // Mark journal lines as reconciled in DB
  const reconIds = reconItems.filter(i => i.reconciled).map(i => i.id);
  if (reconIds.length > 0) {
  const today = formatLocalDate(new Date());
  // Verify these lines belong to this company's JEs before marking reconciled
  const validJeIds = new Set((journalEntries || []).map(j => j.id));
  const { data: checkLines } = await supabase.from("acct_journal_lines").select("id, journal_entry_id").in("id", reconIds);
  const safeIds = (checkLines || []).filter(l => validJeIds.has(l.journal_entry_id)).map(l => l.id);
  // Double-scope: filter by safe IDs AND by this company's JE IDs
  if (safeIds.length > 0) {
  const validJeIdArr = Array.from(validJeIds);
  const { error: reconErr } = await supabase.from("acct_journal_lines")
  .update({ reconciled: true, reconciled_date: today })
  .in("id", safeIds)
  .in("journal_entry_id", validJeIdArr);
  if (reconErr) { showToast("Reconciliation update failed: " + reconErr.message, "error"); return; }
  }
  }

  // Lock bank feed transactions that were reconciled in this period
  const startDate = reconPeriod + "-01";
  const endObj2 = parseLocalDate(startDate); endObj2.setMonth(endObj2.getMonth() + 1); endObj2.setDate(0);
  const endDate2 = formatLocalDate(endObj2);
  const { error: lockErr } = await supabase.from("bank_feed_transaction")
    .update({ status: "locked" })
    .eq("company_id", companyId)
    .in("status", ["categorized", "matched", "posted"])
    .gte("posted_date", startDate).lte("posted_date", endDate2);
  if (lockErr) pmError("PM-5006", { raw: lockErr, context: "lock bank feed transactions", silent: true });

  logAudit("create", "bank_reconciliation", "Bank reconciliation for " + reconPeriod + " — diff: $" + diff + (status === "reconciled" ? " (balanced)" : " (discrepancy)"), "", userProfile?.email || "", "", companyId);
  setShowReconcile(false);
  setBankBalance("");
  setReconItems([]);
  fetchRecons();
  } finally { guardRelease("saveReconciliation"); }
  }

  if (loading) return <Spinner />;

  const reconciledCount = reconItems.filter(i => i.reconciled).length;
  const reconciledTotal = reconItems.filter(i => i.reconciled).reduce((s, i) => s + safeNum(i.amount), 0);
  const unreconciledTotal = reconItems.filter(i => !i.reconciled).reduce((s, i) => s + safeNum(i.amount), 0);

  return (
  <div>
  {/* Tabs: Reconcile / Period Lock */}
  <div className="flex gap-1 mb-4 border-b border-neutral-200">
    {[["reconcile", "Reconcile"], ["period_lock", "Period Lock"]].map(([id, label]) => (
      <button key={id} onClick={() => setReconTab(id)} className={`px-4 py-2 text-sm font-medium border-b-2 ${reconTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-500"}`}>{label}</button>
    ))}
  </div>

  {/* Period Lock Tab */}
  {reconTab === "period_lock" && (
  <div className="space-y-4">
    <div className="bg-white rounded-xl border border-neutral-200 p-5">
      <h3 className="font-semibold text-neutral-800 mb-1">Accounting Period Lock</h3>
      <p className="text-sm text-neutral-400 mb-4">Lock past periods to prevent any changes to transactions on or before the lock date.</p>
      {periodLock ? (
      <div className="bg-danger-50 border border-danger-200 rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-danger-800">Period locked through {periodLock.lock_date}</div>
            <div className="text-xs text-danger-600 mt-1">Locked by {periodLock.locked_by || "admin"} on {new Date(periodLock.locked_at).toLocaleDateString()}</div>
            {periodLock.notes && <div className="text-xs text-danger-500 mt-1">{periodLock.notes}</div>}
          </div>
          <Btn variant="danger" size="sm" onClick={removePeriodLock}>Remove Lock</Btn>
        </div>
      </div>
      ) : (
      <div className="bg-success-50 border border-success-200 rounded-xl p-4 mb-4">
        <div className="text-sm text-success-800">No period lock active. All periods are open for modifications.</div>
      </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div><label className="text-xs font-medium text-neutral-500 block mb-1">Lock Date</label>
          <Input type="date" value={lockDate} onChange={e => setLockDate(e.target.value)} className="w-40" /></div>
        <div className="flex items-end"><Btn variant="danger-fill" className="w-full" onClick={savePeriodLock} disabled={!lockDate}>Lock Period</Btn></div>
      </div>
      <div className="mt-3 text-xs text-neutral-400">
        <strong>What gets locked:</strong> No journal entries can be posted, edited, or voided with a date on or before the lock date. Bank feed transactions in locked periods cannot be accepted or undone. Recurring entries will skip locked periods.
      </div>
    </div>
  </div>
  )}

  {/* Reconcile Tab */}
  {reconTab === "reconcile" && !showReconcile && !viewRecon && (
  <div>
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-5">
  <h3 className="font-manrope font-semibold text-neutral-800 mb-3">Start Bank Reconciliation</h3>
  <div className="grid grid-cols-3 gap-3">
  <div><label className="text-xs text-neutral-400 mb-1 block">Month</label><Input placeholder="Enter name" type="month" value={reconPeriod} onChange={e => setReconPeriod(e.target.value)} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Bank Ending Balance ($)</label><Input type="number" step="0.01" value={bankBalance} onChange={e => setBankBalance(e.target.value)} placeholder="Enter from bank statement" /></div>
  <div className="flex items-end"><Btn className="w-full" onClick={startReconciliation}>Begin Reconciliation</Btn></div>
  </div>
  </div>

  <h3 className="font-semibold text-neutral-700 mb-3">Previous Reconciliations</h3>
  <div className="space-y-2">
  {reconciliations.map(r => {
  const sc = { reconciled: "bg-positive-100 text-positive-700", in_progress: "bg-warn-100 text-warn-700", discrepancy: "bg-danger-100 text-danger-700" };
  return (
  <div key={r.id} className="bg-white rounded-3xl border border-brand-50 px-4 py-3 flex justify-between items-center cursor-pointer hover:border-brand-200" onClick={() => setViewRecon(r)}>
  <div>
  <div className="text-sm font-medium text-neutral-800">{r.period}</div>
  <div className="text-xs text-neutral-400">{new Date(r.created_at).toLocaleDateString()}</div>
  </div>
  <div className="flex items-center gap-3">
  <div className="text-right text-xs">
  <div>Bank: <span className="font-bold">${safeNum(r.bank_ending_balance).toLocaleString()}</span></div>
  <div>Book: <span className="font-bold">${safeNum(r.book_balance).toLocaleString()}</span></div>
  </div>
  <div className="text-right">
  {Math.abs(r.difference) > 0.01 && <div className="text-xs font-bold text-danger-600">Diff: ${safeNum(r.difference).toLocaleString()}</div>}
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[r.status] || "")}>{r.status.replace("_"," ")}</span>
  </div>
  </div>
  </div>
  );
  })}
  {reconciliations.length === 0 && <div className="text-center py-8 text-neutral-400">No reconciliations yet</div>}
  </div>
  </div>
  )}

  {viewRecon && (
  <div>
  <Btn variant="ghost" size="sm" onClick={() => setViewRecon(null)}>← Back</Btn>
  <div className="bg-white rounded-3xl border border-brand-50 p-5">
  <div className="flex justify-between items-start mb-4">
  <div><h3 className="font-semibold text-neutral-800">Reconciliation — {viewRecon.period}</h3><div className="text-xs text-neutral-400">{new Date(viewRecon.created_at).toLocaleDateString()}</div></div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (viewRecon.status === "reconciled" ? "bg-positive-100 text-positive-700" : "bg-danger-100 text-danger-700")}>{viewRecon.status}</span>
  </div>
  <div className="grid grid-cols-3 gap-3 mb-4">
  <div className="bg-info-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Bank Balance</div><div className="text-lg font-bold text-info-700">${safeNum(viewRecon.bank_ending_balance).toLocaleString()}</div></div>
  <div className="bg-brand-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Book Balance</div><div className="text-lg font-bold text-brand-700">${safeNum(viewRecon.book_balance).toLocaleString()}</div></div>
  <div className={"rounded-lg p-3 text-center " + (Math.abs(viewRecon.difference) < 0.01 ? "bg-positive-50" : "bg-danger-50")}><div className="text-xs text-neutral-400">Difference</div><div className={"text-lg font-bold " + (Math.abs(viewRecon.difference) < 0.01 ? "text-positive-700" : "text-danger-600")}>${safeNum(viewRecon.difference).toLocaleString()}</div></div>
  </div>
  {(() => { let items = []; try { items = JSON.parse(viewRecon.unreconciled_items || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse reconciliation items", silent: true }); } return items.length > 0 ? (
  <div><div className="font-semibold text-danger-700 text-sm mb-2">Unreconciled Items ({items.length})</div>
  {items.map((it, i) => (<div key={i} className="flex justify-between text-xs py-1 border-b border-brand-50/50"><span className="text-neutral-500">{it.date} — {it.description}</span><span className="font-bold">${it.amount.toLocaleString()}</span></div>))}
  </div>) : null; })()}
  </div>
  </div>
  )}

  {showReconcile && (
  <div>
  <div className="flex justify-between items-center mb-4">
  <div>
  <h3 className="font-semibold text-neutral-800">Reconcile — {reconPeriod}</h3>
  <div className="text-xs text-neutral-400">Bank balance: ${Number(bankBalance).toLocaleString()} · Check items that match your bank statement</div>
  </div>
  <Btn variant="ghost" onClick={() => { setShowReconcile(false); setReconItems([]); }}>Cancel</Btn>
  </div>

  <div className="grid grid-cols-3 gap-3 mb-4">
  <div className="bg-positive-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Reconciled ({reconciledCount})</div><div className="text-lg font-bold text-positive-700">${reconciledTotal.toLocaleString()}</div></div>
  <div className="bg-warn-50 rounded-lg p-3 text-center"><div className="text-xs text-neutral-400">Unreconciled ({reconItems.length - reconciledCount})</div><div className="text-lg font-bold text-warn-700">${unreconciledTotal.toLocaleString()}</div></div>
  <div className={"rounded-lg p-3 text-center " + (Math.abs(Number(bankBalance) - reconciledTotal) < 0.01 ? "bg-positive-50" : "bg-danger-50")}><div className="text-xs text-neutral-400">Remaining Diff</div><div className={"text-lg font-bold " + (Math.abs(Number(bankBalance) - reconciledTotal) < 0.01 ? "text-positive-700" : "text-danger-600")}>${(Number(bankBalance) - reconciledTotal).toLocaleString()}</div></div>
  </div>

  <div className="mb-3 flex items-center gap-2">
  <Btn variant="secondary" size="sm" onClick={toggleAllRecon}>{reconItems.every(i => i.reconciled) ? "Uncheck All" : "Check All"}</Btn>
  <Btn variant="success-fill" size="xs" onClick={() => autoMatchItems(reconItems)}>⚡ Auto-Match</Btn>
  <span className="text-xs text-neutral-400">{reconItems.length} transactions</span>
  </div>

  <div className="space-y-1 mb-4">
  {reconItems.map((item, i) => (
  <div key={i} onClick={() => toggleReconItem(i)} className={"flex items-center gap-3 px-4 py-2.5 rounded-lg cursor-pointer border " + (item.reconciled ? "bg-positive-50 border-positive-200" : "bg-white border-subtle-100 hover:bg-brand-50/30")}>
  <span className={"w-5 h-5 rounded border flex items-center justify-center text-xs flex-shrink-0 " + (item.reconciled ? "bg-positive-500 border-positive-500 text-white" : "border-brand-200")}>{item.reconciled ? "✓" : ""}</span>
  <div className="flex-1 min-w-0">
  <div className="text-sm text-neutral-800 truncate">{item.description}</div>
  <div className="text-xs text-neutral-400">{item.date} · {item.reference} · {item.memo}</div>
  </div>
  <div className={"text-sm font-bold flex-shrink-0 " + (item.amount >= 0 ? "text-positive-600" : "text-danger-600")}>{item.amount >= 0 ? "+" : ""}${item.amount.toLocaleString()}</div>
  </div>
  ))}
  </div>

  <Btn size="lg" className="px-8" onClick={saveReconciliation}>Save Reconciliation</Btn>
  </div>
  )}
  </div>
  );
}
