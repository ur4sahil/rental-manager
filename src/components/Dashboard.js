import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { PageHeader } from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, formatCurrency, priorityColors } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { Badge, StatCard, Spinner } from "./shared";

// ============ DASHBOARD ============
function Dashboard({ companySettings = {}, notifications, setPage, companyId, addNotification, showToast, showConfirm }) {
  const [properties, setProperties] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [payments, setPayments] = useState([]);
  const [utilities, setUtilities] = useState([]);
  const [hoaDue, setHoaDue] = useState([]);
  const [loading, setLoading] = useState(true);

  const [acctRevenue, setAcctRevenue] = useState(0);
  const [acctExpenses, setAcctExpenses] = useState(0);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);


  useEffect(() => {
  async function fetchData() {
  const [p, t, w, pay, u] = await Promise.all([
  supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("work_orders").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("payments").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("utilities").select("*").eq("company_id", companyId).is("archived_at", null),
  ]);
  // Also fetch PM-managed properties from other companies
  const { data: managedProps } = await supabase.from("properties").select("*").eq("pm_company_id", companyId).is("archived_at", null).limit(500);
  const allProps = (p.data || []).map(x => ({ ...x, _ownership: "owned" }));
  (managedProps || []).forEach(mp => { if (!allProps.find(x => x.id === mp.id)) allProps.push({ ...mp, _ownership: "managed", _readOnly: true }); });
  setProperties(allProps);
  setTenants(t.data || []);
  setWorkOrders(w.data || []);
  setPayments(pay.data || []);
  setUtilities(u.data || []);
  // Fetch upcoming HOA payments (due within 14 days)
  const fourteenDays = new Date(Date.now() + (companySettings.hoa_upcoming_window_days || 14) * 86400000).toISOString().slice(0, 10);
  const { data: hoaData } = await supabase.from("hoa_payments").select("*").eq("company_id", companyId).eq("status", "unpaid").is("archived_at", null).lte("due_date", fourteenDays).order("due_date", { ascending: true });
  setHoaDue(hoaData || []);
  // Count pending approvals (lightweight — full data loaded on Tasks page)
  try {
  const [propReqs, docExceptions, memberReqs] = await Promise.all([
  supabase.from("property_change_requests").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "pending"),
  supabase.from("doc_exception_requests").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "pending"),
  supabase.from("company_members").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "pending"),
  ]);
  setPendingApprovalCount((propReqs.count || 0) + (docExceptions.count || 0) + (memberReqs.count || 0));
  } catch (e) { pmError("PM-8006", { raw: e, context: "approval count fetch", silent: true }); }
  // Pull financials from accounting module (journal entries are the GL source of truth,
  // but dashboard stats also reference payments/tenants tables for quick metrics)
  try {
  const { data: jeHeaders } = await supabase.from("acct_journal_entries").select("id").eq("company_id", companyId).eq("status", "posted");
  const jeIds = (jeHeaders || []).map(j => j.id);
  const { data: jeLines } = jeIds.length > 0 ? await supabase.from("acct_journal_lines").select("account_id, debit, credit").eq("company_id", companyId).in("journal_entry_id", jeIds) : { data: [] };
  const { data: accounts } = await supabase.from("acct_accounts").select("id, type").eq("company_id", companyId);
  if (jeLines && accounts) {
  const acctMap = {};
  accounts.forEach(a => { acctMap[a.id] = (a.type || "").toLowerCase(); });
  let rev = 0, exp = 0;
  jeLines.forEach(l => {
  const type = acctMap[l.account_id];
  if (type === "revenue" || type === "other income" || type === "income") rev += safeNum(l.credit) - safeNum(l.debit);
  if (type === "expense" || type === "cost of goods sold" || type === "other expense") exp += safeNum(l.debit) - safeNum(l.credit);
  });
  setAcctRevenue(rev);
  setAcctExpenses(exp);
  }
  } catch(e) { pmError("PM-4002", { raw: e, context: "dashboard accounting fetch", silent: true }); }
  setLoading(false);
  }
  fetchData();
  }, [companyId]);

  if (loading) return <Spinner />;

  const occupied = properties.filter(p => p.status === "occupied").length;
  const dashMonth = formatLocalDate(new Date()).slice(0, 7);
  const totalRent = payments.filter(p => p.type === "rent" && p.status === "paid" && p.date?.startsWith(dashMonth)).reduce((s, p) => s + safeNum(p.amount), 0);
  const delinquent = tenants.filter(t => t.balance > 0).length;
  const openWO = workOrders.filter(w => w.status !== "completed").length;

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <PageHeader title="Dashboard" />
  </div>

  {/* Notifications accessible via bell icon in header */}

  <div className="grid grid-cols-2 gap-3 mb-4 md:grid-cols-4">
  <StatCard onClick={() => setPage("properties")} label="Occupancy" value={`${occupied}/${properties.length}`} sub={`${properties.length ? Math.round(occupied / properties.length * 100) : 0}% occupied`} color="text-positive-600" />
  <StatCard onClick={() => setPage("accounting")} label="Revenue (Acctg)" value={`${formatCurrency(acctRevenue)}`} sub="from journal entries" color="text-info-600" />
  <StatCard onClick={() => setPage("accounting")} label="Expenses (Acctg)" value={`${formatCurrency(acctExpenses)}`} sub="from journal entries" color="text-danger-500" />
  <StatCard onClick={() => setPage("accounting")} label="Net Income" value={`$${(acctRevenue - acctExpenses).toLocaleString()}`} sub="revenue - expenses" color={acctRevenue - acctExpenses >= 0 ? "text-success-600" : "text-danger-600"} />
  </div>
  <div className="grid grid-cols-2 gap-3 mb-6 md:grid-cols-4">
  <StatCard onClick={() => setPage("payments")} label="Rent Collected" value={`${formatCurrency(totalRent)}`} sub="payments table" color="text-brand-600" />
  <StatCard onClick={() => setPage("tenants")} label="Delinquent" value={delinquent} sub="tenants with balance" color="text-notice-500" />
  <StatCard onClick={() => setPage("maintenance")} label="Open Work Orders" value={openWO} sub={`${workOrders.filter(w => w.priority === "emergency").length} emergency`} color="text-notice-500" />
  <StatCard onClick={() => setPage("utilities")} label="Pending Utilities" value={utilities.filter(u => u.status === "pending").length} sub="awaiting payment" color="text-caution-600" />
  </div>
  {/* Tasks & Approvals summary — click to go to full page */}
  {(() => {
  const taskCount = tenants.filter(t => t.doc_status === "pending_docs").length
  + tenants.filter(t => t.balance > 0).length
  + workOrders.filter(w => w.priority === "emergency" && w.status !== "completed").length
  + tenants.filter(t => { const end = t.lease_end_date || t.move_out; if (!end) return false; const days = Math.ceil((parseLocalDate(end) - new Date()) / 86400000); return days > 0 && days <= 30; }).length
  + hoaDue.length + pendingApprovalCount;
  return taskCount > 0 ? (
  <div onClick={() => setPage("tasks")} className="bg-warn-50 rounded-3xl shadow-card border border-warn-200 p-4 mb-6 cursor-pointer hover:bg-warn-100 transition-colors flex items-center justify-between">
  <div className="flex items-center gap-3">
  <div className="w-10 h-10 bg-warn-200 text-warn-800 rounded-full flex items-center justify-center font-bold text-lg">{taskCount}</div>
  <div>
  <div className="font-manrope font-bold text-warn-800">Tasks & Approvals</div>
  <div className="text-xs text-warn-600">{pendingApprovalCount > 0 ? pendingApprovalCount + " awaiting approval \u00b7 " : ""}{taskCount - pendingApprovalCount} pending tasks</div>
  </div>
  </div>
  <span className="material-icons-outlined text-warn-500">arrow_forward</span>
  </div>
  ) : null;
  })()}

  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Lease Expirations</h3>
  {tenants.filter(t => (t.lease_end_date || t.move_out) && parseLocalDate(t.lease_end_date || t.move_out) >= new Date() && Math.ceil((parseLocalDate(t.lease_end_date || t.move_out) - new Date()) / 86400000) <= 90).map(t => (
  <div key={t.id} className="flex justify-between items-center py-2 border-b border-brand-50/50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{t.name}</div>
  <div className="text-xs text-neutral-400">{t.property}</div>
  </div>
  <div className="text-sm text-notice-500 font-semibold">{t.move_out}</div>
  </div>
  ))}
  {tenants.filter(t => t.move_out).length === 0 && <div className="text-sm text-neutral-400 text-center py-4">No upcoming expirations</div>}
  </div>
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Recent Maintenance</h3>
  {workOrders.slice(0, 3).map(w => (
  <div key={w.id} className="flex justify-between items-center py-2 border-b border-brand-50/50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{w.issue}</div>
  <div className="text-xs text-neutral-400">{w.property}</div>
  </div>
  <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${priorityColors[w.priority]}`}>{w.priority}</span>
  </div>
  ))}
  </div>
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Utilities Due</h3>
  {utilities.filter(u => u.status === "pending").map(u => (
  <div key={u.id} className="flex justify-between items-center py-2 border-b border-brand-50/50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{u.provider}</div>
  <div className="text-xs text-neutral-400">{u.property} \u00b7 {u.responsibility}</div>
  </div>
  <div className="text-right">
  <div className="text-sm font-semibold text-neutral-800">${u.amount}</div>
  <Badge status={u.status} />
  </div>
  </div>
  ))}
  {utilities.filter(u => u.status === "pending").length === 0 && <div className="text-sm text-neutral-400 text-center py-4">No pending utilities</div>}
  </div>
  {hoaDue.length > 0 && (
  <div className="bg-white rounded-3xl shadow-card border border-warn-100 p-4">
  <h3 className="font-semibold text-warn-700 mb-3"><span className="material-icons-outlined text-sm align-middle mr-1">holiday_village</span>HOA Payments Due</h3>
  {hoaDue.map(h => {
  const daysLeft = Math.ceil((new Date(h.due_date).getTime() - Date.now()) / 86400000);
  return (
  <div key={h.id} className="flex justify-between items-center py-2 border-b border-warn-50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{h.hoa_name}</div>
  <div className="text-xs text-neutral-400">{h.property}</div>
  </div>
  <div className="text-right">
  <div className="text-sm font-semibold text-warn-700">${safeNum(h.amount).toLocaleString()}</div>
  <div className={`text-xs ${daysLeft <= 3 ? "text-danger-500 font-bold" : "text-warn-500"}`}>{daysLeft <= 0 ? "OVERDUE" : `${daysLeft}d left`}</div>
  </div>
  </div>);
  })}
  </div>
  )}
  {/* Voucher Re-examination Alerts */}
  {(() => { const reexamTenants = tenants.filter(t => t.is_voucher && t.reexam_date && Math.ceil((new Date(t.reexam_date).getTime() - Date.now()) / 86400000) <= (companySettings.voucher_reexam_window_days || 120) && Math.ceil((new Date(t.reexam_date).getTime() - Date.now()) / 86400000) >= -30); return reexamTenants.length > 0 ? (
  <div className="bg-white rounded-3xl shadow-card border border-highlight-200 p-4">
  <h3 className="font-semibold text-highlight-700 mb-3"><span className="material-icons-outlined text-sm align-middle mr-1">event</span>Voucher Re-examination Due</h3>
  {reexamTenants.map(t => {
  const daysLeft = Math.ceil((new Date(t.reexam_date).getTime() - Date.now()) / 86400000);
  return (
  <div key={t.id} className="flex justify-between items-center py-2 border-b border-highlight-50 last:border-0">
  <div>
  <div className="text-sm font-medium text-neutral-800">{t.name} <span className="text-xs bg-highlight-100 text-highlight-700 px-1.5 py-0.5 rounded-full ml-1">Voucher</span></div>
  <div className="text-xs text-neutral-400">{t.property}{t.voucher_number ? " \u00b7 " + t.voucher_number : ""}</div>
  </div>
  <div className="text-right">
  <div className="text-sm font-semibold">{t.reexam_date}</div>
  <div className={`text-xs font-bold ${daysLeft <= 0 ? "text-danger-600" : daysLeft <= 30 ? "text-danger-500" : daysLeft <= 60 ? "text-warn-600" : "text-highlight-600"}`}>{daysLeft <= 0 ? "OVERDUE" : `${daysLeft} days left`}</div>
  </div>
  </div>);
  })}
  </div>
  ) : null; })()}
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Net Operating Income</h3>
  <div className="space-y-2">
  {[
  ["Gross Rent Collected", `${formatCurrency(totalRent)}`, "text-positive-600"],
  ["Maintenance Costs", `-$${workOrders.reduce((s, w) => s + safeNum(w.cost), 0).toLocaleString()}`, "text-danger-500"],
  ["Utility Expenses", `-$${utilities.reduce((s, u) => s + safeNum(u.amount), 0).toLocaleString()}`, "text-danger-500"],
  ["NOI", `$${(totalRent - workOrders.reduce((s, w) => s + safeNum(w.cost), 0) - utilities.reduce((s, u) => s + safeNum(u.amount), 0)).toLocaleString()}`, "text-info-700 font-bold"],
  ].map(([l, v, c]) => (
  <div key={l} className="flex justify-between">
  <span className="text-sm text-neutral-500">{l}</span>
  <span className={`text-sm ${c}`}>{v}</span>
  </div>
  ))}
  </div>
  </div>
  </div>
  </div>
  );
}

export { Dashboard };
