import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Btn, Select, PageHeader } from "../ui";
import { safeNum, formatLocalDate, formatCurrency, escapeFilterValue, exportToCSV, parseLocalDate } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { atomicPostJEAndLedger, checkAccrualExists, getPropertyClassId, autoOwnerDistribution } from "../utils/accounting";
import { StatCard, Spinner, PropertySelect, generatePaymentReceipt } from "./shared";

function Payments({ addNotification, userProfile, userRole, companyId, showToast, showConfirm, setPage }) {
  const [payTab, setPayTab] = useState("payments");
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [paySearch, setPaySearch] = useState("");
  const [payDateFrom, setPayDateFrom] = useState("");
  const [payDateTo, setPayDateTo] = useState("");

  useEffect(() => { fetchPayments(); }, [companyId, payDateFrom, payDateTo, paySearch]);

  async function fetchPayments() {
  setLoading(true);
  // Fetch payment-type JEs: PAY-, STRIPE-, or payment-related descriptions
  let query = supabase.from("acct_journal_entries").select("*, lines:acct_journal_lines(*)")
    .eq("company_id", companyId).eq("status", "posted")
    .or("reference.like.PAY-%,reference.like.STRIPE-%,reference.like.DEPRET-%,description.ilike.%payment%");
  if (payDateFrom) query = query.gte("date", payDateFrom);
  if (payDateTo) query = query.lte("date", payDateTo);
  if (paySearch) query = query.or(`description.ilike.%${escapeFilterValue(paySearch)}%,property.ilike.%${escapeFilterValue(paySearch)}%`);
  const { data } = await query.order("date", { ascending: false }).limit(200);
  // Transform JEs into payment-like rows
  const paymentRows = (data || []).map(je => {
    const debitTotal = (je.lines || []).reduce((s, l) => s + safeNum(l.debit), 0);
    // Extract tenant from description: "Payment received — TenantName — Property"
    const descParts = (je.description || "").split("—").map(s => s.trim());
    const tenant = descParts.length >= 2 ? descParts[1] : "";
    // Derive the payment method from structured signals rather than loose
    // substring hits against description. The old chain matched "ach"
    // first, so "ACH checking acct payment" → ACH and "Check from
    // ACH-favored customer" also → ACH even though the second is a
    // paper check. Preference order now:
    //   1. reference prefix (STRIPE- → Stripe)
    //   2. lines[].memo "via <method>" pattern (set by Autopay runNow)
    //   3. word-boundary match on description ordered specific → general
    //   4. PAY- reference fallback → Manual
    let method = "Journal Entry";
    const descLower = (je.description || "").toLowerCase();
    const lineMemos = (je.lines || []).map(l => (l.memo || "").toLowerCase()).join(" | ");
    const viaMatch = lineMemos.match(/\bvia\s+(ach|stripe|check|cash|card|wire|zelle|venmo)\b/);
    if (je.reference?.startsWith("STRIPE-")) method = "Stripe";
    else if (viaMatch) method = viaMatch[1].toUpperCase() === "ACH" ? "ACH" : (viaMatch[1][0].toUpperCase() + viaMatch[1].slice(1));
    else if (/\bstripe\b/.test(descLower)) method = "Stripe";
    else if (/\bach\b/.test(descLower)) method = "ACH";
    else if (/\bwire\b/.test(descLower)) method = "Wire";
    else if (/\bzelle\b/.test(descLower)) method = "Zelle";
    else if (/\bvenmo\b/.test(descLower)) method = "Venmo";
    else if (/\bcheck\b/.test(descLower)) method = "Check";
    else if (/\bcash\b/.test(descLower)) method = "Cash";
    else if (/\bcard\b/.test(descLower)) method = "Card";
    else if (je.reference?.startsWith("PAY-") || je.reference?.startsWith("APAY-")) method = "Manual";
    // Determine type
    let type = "payment";
    if ((je.description || "").toLowerCase().includes("deposit")) type = "deposit";
    else if ((je.description || "").toLowerCase().includes("late fee")) type = "late_fee";
    else if ((je.description || "").toLowerCase().includes("rent")) type = "rent";
    return {
      id: je.id, tenant, property: je.property || "", amount: debitTotal,
      date: je.date, type, method, status: "posted",
      description: je.description, reference: je.reference, number: je.number,
    };
  }).filter(p => p.amount > 0);
  setPayments(paymentRows);
  setLoading(false);
  }

  if (loading) return <Spinner />;

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <PageHeader title="Payments" />
  <div className="flex gap-2">
  <Btn variant="secondary" onClick={() => exportToCSV(payments, [
  { label: "Date", key: "date" }, { label: "Tenant", key: "tenant" },
  { label: "Property", key: "property" }, { label: "Amount", key: "amount" },
  { label: "Type", key: "type" }, { label: "Method", key: "method" },
  { label: "Reference", key: "reference" },
  ], "payments-export", showToast)}>
  <span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export
  </Btn>
  <Btn variant="success-fill" onClick={() => setPage("accounting", "newJE")}>
  <span className="material-icons-outlined text-sm">add_circle</span>Record Payment
  </Btn>
  </div>
  </div>

  <div className="flex gap-1 mb-4 border-b border-brand-50">
  {[["payments", "Payments"], ["autopay", "Autopay & Recurring"]].map(([id, label]) => (
  <button key={id} onClick={() => setPayTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (payTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-500")}>{label}</button>
  ))}
  </div>

  {payTab === "autopay" && <Autopay addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} showToast={showToast} showConfirm={showConfirm} />}
  {payTab === "payments" && (<>
  <div className="grid grid-cols-2 gap-3 mb-5">
  <StatCard label="Total Collected" value={formatCurrency(payments.reduce((s, p) => s + p.amount, 0))} color="text-positive-600" sub="From journal entries" />
  <StatCard label="Transactions" value={payments.length} color="text-brand-600" sub="Posted payments" />
  </div>

  <div className="flex flex-wrap gap-2 mb-4">
  <Input placeholder="Search tenant or property..." value={paySearch} onChange={e => setPaySearch(e.target.value)} className="w-64" />
  <Input type="date" value={payDateFrom} onChange={e => setPayDateFrom(e.target.value)} title="From date" className="w-40" />
  <Input type="date" value={payDateTo} onChange={e => setPayDateTo(e.target.value)} title="To date" className="w-40" />
  {(paySearch || payDateFrom || payDateTo) && (
  <Btn variant="danger" size="xs" onClick={() => { setPaySearch(""); setPayDateFrom(""); setPayDateTo(""); }}>Clear</Btn>
  )}
  </div>

  <div className="bg-white rounded-3xl shadow-card border border-brand-50 overflow-hidden">
  <table className="w-full text-sm">
  <thead className="bg-neutral-50 text-xs text-neutral-500 uppercase tracking-wider">
  <tr>
  <th className="px-4 py-3 text-left">Date</th>
  <th className="px-4 py-3 text-left">JE #</th>
  <th className="px-4 py-3 text-left">Tenant</th>
  <th className="px-4 py-3 text-left">Property</th>
  <th className="px-4 py-3 text-right">Amount</th>
  <th className="px-4 py-3 text-left">Type</th>
  <th className="px-4 py-3 text-left">Method</th>
  <th className="px-4 py-3"></th>
  </tr>
  </thead>
  <tbody>
  {payments.map(p => (
  <tr key={p.id} className="border-t border-neutral-100 hover:bg-positive-50/40 transition-colors">
  <td className="px-4 py-3 text-neutral-500">{p.date}</td>
  <td className="px-4 py-3 font-mono text-xs text-positive-600">{p.number || "—"}</td>
  <td className="px-4 py-3 font-medium text-neutral-800">{p.tenant || "—"}</td>
  <td className="px-4 py-3 text-neutral-400 text-xs">{p.property?.split(",")[0] || "—"}</td>
  <td className="px-4 py-3 text-right font-semibold font-mono text-positive-600">{formatCurrency(p.amount)}</td>
  <td className="px-4 py-3 capitalize text-neutral-500 text-xs">{p.type?.replace("_", " ")}</td>
  <td className="px-4 py-3 text-neutral-400 text-xs">{p.method}</td>
  <td className="px-4 py-3">
  <Btn variant="success-fill" size="xs" onClick={() => generatePaymentReceipt({ tenant: p.tenant, property: p.property, amount: p.amount, date: p.date, method: p.method, type: p.type })} className="py-0.5">Receipt</Btn>
  </td>
  </tr>
  ))}
  </tbody>
  </table>
  {payments.length === 0 && <div className="text-center py-8 text-neutral-400 text-sm">No payment transactions found</div>}
  </div>
  </>)}
  </div>
  );
}
function Autopay({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [schedules, setSchedules] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tenant: "", property: "", amount: "", frequency: "monthly", day_of_month: "1", start_date: "", end_date: "", method: "ACH", enabled: true });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
  try {
  const [s, t] = await Promise.all([
  supabase.from("autopay_schedules").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }),
  supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null),
  ]);
  setSchedules(s.data || []);
  setTenants(t.data || []);
  } catch {
  setSchedules([]);
  setTenants([]);
  }
  setLoading(false);
  }

  async function saveSchedule() {
  if (!guardSubmit("saveSchedule")) return;
  try {
  if (!form.tenant) { showToast("Please select a tenant.", "error"); return; }
  if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { showToast("Please enter a valid positive amount.", "error"); return; }
  if (!form.start_date) { showToast("Start date is required.", "error"); return; }
  if (!form.day_of_month || Number(form.day_of_month) < 1 || Number(form.day_of_month) > 31 || isNaN(Number(form.day_of_month))) { showToast("Day of month must be between 1 and 31.", "error"); return; }
  const { error } = await supabase.from("autopay_schedules").insert([{ ...form, amount: Number(form.amount), company_id: companyId }]);
  if (error) { pmError("PM-6001", { raw: error, context: "save autopay schedule" }); return; }
  addNotification("🔄", `Autopay schedule created for ${form.tenant}`);
  logAudit("create", "autopay", `Autopay created: ${form.tenant} $${form.amount}/mo at ${form.property}`, "", userProfile?.email, userRole, companyId);
  setShowForm(false);
  setForm({ tenant: "", property: "", amount: "", frequency: "monthly", day_of_month: "1", start_date: "", end_date: "", method: "ACH", enabled: true });
  fetchData();
  } finally { guardRelease("saveSchedule"); }
  }

  async function toggleActive(s) {
  if (!guardSubmit("toggleAutopay", s.id)) return;
  try {
  const newState = !s.enabled;
  const { error: togErr } = await supabase.from("autopay_schedules").update({ enabled: newState }).eq("company_id", companyId).eq("id", s.id);
  if (togErr) { showToast("Error toggling autopay: " + togErr.message, "error"); return; }
  addNotification("🔄", `Autopay ${newState ? "activated" : "paused"} for ${s.tenant}`);
  logAudit("update", "autopay", `Autopay ${newState ? "enabled" : "disabled"}: ${s.tenant}`, s.id, userProfile?.email, userRole, companyId);
  fetchData();
  } finally { guardRelease("toggleAutopay", s.id); }
  }

  async function deleteSchedule(id, tenant) {
  if (!guardSubmit("deleteSchedule")) return;
  try {
  if (!await showConfirm({ message: `Delete autopay schedule for ${tenant}?`, variant: "danger", confirmText: "Delete" })) return;
  await supabase.from("autopay_schedules").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
  logAudit("delete", "autopay", `Autopay archived: ${tenant}`, id, userProfile?.email, userRole, companyId);
  fetchData();
  } finally { guardRelease("deleteSchedule"); }
  }

  async function runNow(s) {
  if (!guardSubmit("runNow", s.id)) return;
  try {
  if (!s.amount || safeNum(s.amount) <= 0) { showToast("Invalid autopay amount.", "error"); return; }
  const today = formatLocalDate(new Date());
  const amt = safeNum(s.amount);
  // Look up tenant FIRST — we need tenant_id for the deterministic JE
  // reference so the unique index on (company_id, reference) catches
  // double-posts. Scoping by (name, property) avoids the same-name
  // collision bug that sent autopay to the wrong tenant before. Uses
  // ilike for case-insensitive matching — the schedule row stored
  // whatever casing the user typed, which may have drifted from the
  // tenant row if the tenant was later renamed ("alice johnson" vs
  // "Alice Johnson" otherwise silently produces tenantRow=null).
  const { data: tenantRow } = await supabase.from("tenants")
    .select("id, name, balance, email")
    .ilike("name", escapeFilterValue(s.tenant || ""))
    .eq("company_id", companyId)
    .eq("property", s.property)
    .maybeSingle();
  // Prefer the tenant row's current name over the schedule's stored
  // name — the schedule row isn't kept in sync when a tenant is
  // renamed, so payments + JE memos used to freeze the old name
  // forever. Falls back to the schedule value when no tenant row
  // matched (shouldn't happen after the runNow lookup, but safe).
  const tenantDisplayName = tenantRow?.name || s.tenant;
  // Duplicate guard — by tenant_id + date + method when possible, else fall back to name.
  let dupQ = supabase.from("payments").select("id").eq("company_id", companyId).eq("date", today).eq("method", s.method).limit(1);
  dupQ = tenantRow?.id ? dupQ.eq("tenant_id", tenantRow.id) : dupQ.eq("tenant", s.tenant).eq("property", s.property);
  const { data: todayPay } = await dupQ;
  if (todayPay?.length > 0) {
    if (!await showConfirm({ message: "A payment from " + s.tenant + " was already recorded today. Run again?" })) return;
  }
  const { error } = await supabase.from("payments").insert([{ company_id: companyId, tenant: tenantDisplayName, tenant_id: tenantRow?.id || null, property: s.property, amount: s.amount, type: "rent", method: s.method, status: "paid", date: today }]);
  if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }
  const classId = await getPropertyClassId(s.property, companyId);
  const month = today.slice(0, 7);
  const hasAccrual = await checkAccrualExists(companyId, month, tenantDisplayName);
  // "via <method>" marker is parsed by fetchPayments to surface the
  // right payment method on the payments page without relying on
  // fuzzy description matches.
  const viaTag = " · via " + s.method;
  const jeLines = hasAccrual
  ? [
  { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: "Autopay from " + tenantDisplayName + viaTag },
  { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: amt, class_id: classId, memo: "AR settlement — " + tenantDisplayName + viaTag },
  ]
  : [
  { account_id: "1000", account_name: "Checking Account", debit: amt, credit: 0, class_id: classId, memo: "Autopay from " + tenantDisplayName + viaTag },
  { account_id: "4000", account_name: "Rental Income", debit: 0, credit: amt, class_id: classId, memo: tenantDisplayName + " — " + s.property + viaTag },
  ];
  const jeDesc = hasAccrual ? "Autopay received — " + tenantDisplayName + " — " + s.property + " (settling AR)" : "Autopay — " + tenantDisplayName + " — " + s.property;
  // Deterministic reference — the unique index on (company_id, reference)
  // is only useful if refs are predictable. APAY-<tenantId>-<yyyymmdd>
  // collides on double-post, which is exactly what we want.
  const refKey = tenantRow?.id ? String(tenantRow.id) : (s.tenant || "anon").replace(/\s+/g, "_");
  const jeRef = "APAY-" + refKey + "-" + today.replace(/-/g, "");
  const result = await atomicPostJEAndLedger({ companyId,
  date: today, description: jeDesc, reference: jeRef, property: s.property,
  lines: jeLines,
  ledgerEntry: { tenant: tenantDisplayName, tenant_id: tenantRow?.id || null, property: s.property, date: today, description: "Autopay payment (" + s.method + ")", amount: -amt, type: "payment", balance: 0 },
  balanceUpdate: tenantRow ? { tenantId: tenantRow.id, amount: -amt } : null,
  });
  if (!result.jeId) { fetchData(); return; } // toast already shown
  logAudit("create", "payments", "Autopay: $" + s.amount + " from " + tenantDisplayName + " at " + s.property, "", userProfile?.email, userRole, companyId);
  addNotification("\ud83d\udcb3", "Autopay $" + s.amount + " processed for " + tenantDisplayName);
  if (tenantRow?.email) {
  queueNotification("payment_received", tenantRow.email, { tenant: tenantDisplayName, amount: amt, date: today, property: s.property, method: s.method }, companyId);
  }
  await autoOwnerDistribution(companyId, s.property, amt, today, tenantDisplayName);
  fetchData();
  } finally {
  guardRelease("runNow", s.id);
  }
  }

  function nextDue(s) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = s.start_date ? parseLocalDate(s.start_date) : today;
  let next;
  if (s.frequency === "weekly" || s.frequency === "biweekly") {
  // Step from start_date in 7 or 14-day hops until we land on/past today.
  const stepDays = s.frequency === "weekly" ? 7 : 14;
  next = new Date(start.getTime());
  while (next < today) next.setDate(next.getDate() + stepDays);
  } else {
  const rawDay = parseInt(s.day_of_month) || 1;
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const day = Math.min(rawDay, daysInMonth);
  next = new Date(today.getFullYear(), today.getMonth(), day);
  if (next < today) {
  next.setMonth(next.getMonth() + 1);
  // Re-clamp for next month (e.g., 31 in Feb → 28)
  const nextDaysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  if (next.getDate() > nextDaysInMonth) next.setDate(nextDaysInMonth);
  }
  }
  if (s.end_date && next > parseLocalDate(s.end_date)) return "Expired";
  return next.toLocaleDateString();
  }

  if (loading) return <Spinner />;

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <div>
  <PageHeader title="Autopay & Recurring Rent" />
  <p className="text-xs text-neutral-400 mt-0.5">Set recurring schedules per tenant with custom start and end dates</p>
  </div>
  <Btn onClick={() => setShowForm(!showForm)}>+ New Schedule</Btn>
  </div>
  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-5">
  <h3 className="font-semibold text-neutral-700 mb-3">New Autopay Schedule</h3>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Tenant *</label><Select value={form.tenant} onChange={e => { const t = tenants.find(t => t.name === e.target.value); setForm({ ...form, tenant: e.target.value, property: t?.property || "", amount: t?.rent || "" }); }}>
  <option value="">Select tenant...</option>
  {tenants.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Amount ($)</label><Input placeholder="1500.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Payment Method</label><Select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>
  {["ACH", "card", "cash", "check"].map(m => <option key={m}>{m}</option>)}
  </Select></div>
  {form.frequency === "monthly" && (
  <div>
  <label className="text-xs text-neutral-400 mb-1 block">Day of Month</label>
  <Select value={form.day_of_month} onChange={e => setForm({ ...form, day_of_month: e.target.value })} >
  {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={String(d)}>{d}{d === 1 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th"}{d > 28 ? " (short-month clamp)" : ""}</option>)}
  </Select>
  </div>
  )}
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Frequency</label><Select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })}>
  <option value="monthly">Monthly</option>
  <option value="weekly">Weekly</option>
  <option value="biweekly">Bi-Weekly</option>
  </Select></div>
  <div>
  <label className="text-xs text-neutral-400 mb-1 block">Start Date</label>
  <Input type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })}  className="w-40" />
  </div>
  <div>
  <label className="text-xs text-neutral-400 mb-1 block">End Date (optional)</label>
  <Input type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })}  className="w-40" />
  </div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveSchedule}>Save Schedule</Btn>
  <Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
  </div>
  </div>
  )}
  <div className="space-y-3">
  {schedules.map(s => (
  <div key={s.id} className={`bg-white rounded-xl border shadow-sm p-4 ${s.enabled ? "border-brand-50" : "border-brand-100 opacity-60"}`}>
  <div className="flex justify-between items-start">
  <div>
  <div className="font-semibold text-neutral-800">{s.tenant}</div>
  <div className="text-xs text-neutral-400">{s.property}</div>
  </div>
  <div className="flex items-center gap-2">
  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${s.enabled ? "bg-positive-100 text-positive-700" : "bg-neutral-100 text-neutral-400"}`}>{s.enabled ? "Active" : "Paused"}</span>
  <span className="text-lg font-manrope font-bold text-neutral-800">${s.amount}</span>
  </div>
  </div>
  <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
  <div><span className="text-neutral-400">Frequency</span><div className="font-semibold text-neutral-700 capitalize">{s.frequency}</div></div>
  <div><span className="text-neutral-400">Day</span><div className="font-semibold text-neutral-700">{s.day_of_month}{s.day_of_month === "1" ? "st" : s.day_of_month === "2" ? "nd" : s.day_of_month === "3" ? "rd" : "th"} of month</div></div>
  <div><span className="text-neutral-400">Start</span><div className="font-semibold text-neutral-700">{s.start_date}</div></div>
  <div><span className="text-neutral-400">End</span><div className="font-semibold text-neutral-700">{s.end_date || "Ongoing"}</div></div>
  </div>
  <div className="mt-2 flex items-center justify-between">
  <div className="text-xs text-brand-600 font-medium">Next due: {nextDue(s)}</div>
  <div className="flex gap-2">
  <Btn variant="secondary" size="xs" onClick={() => runNow(s)}>▶ Run Now</Btn>
  <Btn variant={s.enabled ? "notice" : "positive"} size="xs" onClick={() => toggleActive(s)}>{s.enabled ? "⏸ Pause" : "▶ Resume"}</Btn>
  <Btn variant="danger" size="xs" onClick={() => deleteSchedule(s.id, s.tenant)}>🗑️</Btn>
  </div>
  </div>
  </div>
  ))}
  {schedules.length === 0 && <div className="text-center py-12 text-neutral-400">No autopay schedules yet. Create one above.</div>}
  </div>
  </div>
  );
}

export { Payments, Autopay };
