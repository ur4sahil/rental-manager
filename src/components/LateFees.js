import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Select, Btn, PageHeader } from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, formatCurrency } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { atomicPostJEAndLedger, getPropertyClassId } from "../utils/accounting";
import { Spinner } from "./shared";

function LateFees({ companySettings = {}, addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [rules, setRules] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "Standard Late Fee", grace_days: String(companySettings.late_fee_grace_days || 5), fee_amount: String(companySettings.late_fee_amount || 50), fee_type: companySettings.late_fee_type || "flat" });

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
  try {
  const [r, p, t, lRes] = await Promise.all([
  supabase.from("late_fee_rules").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("payments").select("*").eq("company_id", companyId).eq("status", "unpaid").is("archived_at", null),
  supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("leases").select("tenant_name, payment_due_day, status").eq("company_id", companyId).eq("status", "active"),
  ]);
  const leases = lRes.data || [];
  setRules(r.data || []);
  setTenants(t.data || []);
  const today = new Date();
  // Calculate overdue based on when rent was DUE (from lease due day), not payment record date
  const overdue = (p.data || []).filter(pay => {
  // Find the tenant's lease to get payment_due_day
  const tenant = (t.data || []).find(tn => tn.name === pay.tenant);
  const lease = tenant ? leases.find(l => l.tenant_name === pay.tenant && l.status === "active") : null;
  const dueDay = lease?.payment_due_day || 1;
  // Compute the due date for the month of this payment
  const payDate = parseLocalDate(pay.date);
  const dueDate = new Date(payDate.getFullYear(), payDate.getMonth(), Math.min(dueDay, new Date(payDate.getFullYear(), payDate.getMonth() + 1, 0).getDate()));
  const daysFromDue = Math.floor((today - dueDate) / 86400000);
  pay._dueDate = dueDate;
  pay._daysFromDue = daysFromDue;
  return daysFromDue > 0;
  }).map(pay => ({ ...pay, daysLate: pay._daysFromDue }));
  setFlagged(overdue);
  } catch {
  setRules([]);
  setTenants([]);
  setFlagged([]);
  }
  setLoading(false);
  }

  async function saveRule() {
  if (!guardSubmit("saveRule")) return;
  try {
  if (!form.grace_days || !form.fee_amount) { showToast("Please fill all fields.", "error"); return; }
  if (isNaN(Number(form.grace_days)) || Number(form.grace_days) < 0) { showToast("Grace days must be a valid number.", "error"); return; }
  if (isNaN(Number(form.fee_amount)) || Number(form.fee_amount) <= 0) { showToast("Fee amount must be a positive number.", "error"); return; }
  const { error } = await supabase.from("late_fee_rules").insert([{ ...form, grace_days: Number(form.grace_days), fee_amount: Number(form.fee_amount), company_id: companyId }]);
  if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }
  addNotification("⚠️", `Late fee rule "${form.name}" created`);
  setShowForm(false);
  fetchData();
  } finally { guardRelease("saveRule"); }
  }

  async function applyLateFee(payment, rule) {
  // Duplicate guard: check if late fee already applied for this tenant this month
  const thisMonth = formatLocalDate(new Date()).slice(0, 7);
  const { data: existingFee } = await supabase.from("ledger_entries").select("id")
  .eq("company_id", companyId).eq("tenant", payment.tenant)
  .eq("property", payment.property).eq("type", "late_fee").gte("date", thisMonth + "-01").limit(1);
  if (existingFee && existingFee.length > 0) {
  pmError("PM-9005", { raw: { message: "Late fee already applied for " + payment.tenant + " this month" }, context: "late fee duplicate check", silent: true });
  return;
  }
  const tenant = tenants.find(t => t.name === payment.tenant);
  const feeAmount = rule.fee_type === "flat" ? rule.fee_amount : Math.round((tenant?.rent || payment.amount) * rule.fee_amount / 100);
  const today = formatLocalDate(new Date());
  const classId = await getPropertyClassId(payment.property, companyId);
  // Unified: JE first → ledger → balance (all gated on JE success)
  if (feeAmount > 0) {
  // Deterministic reference so a cron re-run can't double-charge.
  // tenant_id + YYYYMM aligns with the one-per-tenant-per-month policy
  // already enforced by the SELECT check above.
  const refKey = tenant?.id ? String(tenant.id) : (payment.tenant || "anon").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32);
  const result = await atomicPostJEAndLedger({ companyId,
  date: today,
  description: "Late fee - " + payment.tenant + " - " + payment.property,
  reference: "LATE-" + refKey + "-" + thisMonth.replace("-", ""),
  property: payment.property,
  lines: [
  { account_id: "1100", account_name: "Accounts Receivable", debit: feeAmount, credit: 0, class_id: classId, memo: "Late fee: " + payment.tenant },
  { account_id: "4010", account_name: "Late Fee Income", debit: 0, credit: feeAmount, class_id: classId, memo: payment.daysLate + " days overdue" },
  ],
  ledgerEntry: { tenant: payment.tenant, property: payment.property, date: today, description: `Late fee — ${payment.daysLate} days overdue`, amount: feeAmount, type: "late_fee", balance: 0 },
  balanceUpdate: tenant ? { tenantId: tenant.id, amount: feeAmount } : null,
  });
  if (!result.jeId) { fetchData(); return; } // toast already shown
  }
  addNotification("⚠️", `Late fee ${formatCurrency(feeAmount)} applied to ${payment.tenant}`);
  logAudit("create", "late_fees", `Late fee ${formatCurrency(feeAmount)} applied to ${payment.tenant} (${payment.daysLate} days overdue)`, tenant?.id || "", userProfile?.email, userRole, companyId);
  if (tenant?.email) queueNotification("late_fee_applied", tenant.email, { tenant: payment.tenant, amount: feeAmount, daysLate: payment.daysLate, property: payment.property }, companyId);
  fetchData();
  }

  async function applyAllFees() {
  const rule = rules[0];
  if (!rule) { showToast("Create a late fee rule first.", "error"); return; }
  if (!await showConfirm({ message: `Apply late fees to all ${flagged.filter(p => p.daysLate > rule.grace_days).length} overdue tenants?` })) return;
  for (const p of flagged.filter(p => p.daysLate > rule.grace_days)) await applyLateFee(p, rule);
  }

  if (loading) return <Spinner />;
  const afterGrace = flagged.filter(p => rules.length > 0 && p.daysLate > rules[0]?.grace_days);

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <div>
  <PageHeader title="Late Fee Automation" />
  <p className="text-xs text-neutral-400 mt-0.5">Auto-flag overdue payments and apply fees after grace period</p>
  </div>
  <div className="flex gap-2">
  {afterGrace.length > 0 && <Btn variant="danger-fill" className="bg-danger-500 hover:bg-danger-600" onClick={applyAllFees}>⚡ Apply All ({afterGrace.length})</Btn>}
  <Btn onClick={() => setShowForm(!showForm)}>+ New Rule</Btn>
  </div>
  </div>
  {rules.length > 0 && (
  <div className="mb-5 space-y-2">
  <h3 className="font-semibold text-neutral-700 text-sm">Active Rules</h3>
  {rules.map(r => (
  <div key={r.id} className="bg-brand-50 border border-brand-100 rounded-2xl px-4 py-3 flex justify-between items-center">
  <div>
  <div className="font-semibold text-brand-800 text-sm">{r.name}</div>
  <div className="text-xs text-brand-500">{r.grace_days} day grace · {r.fee_type === "flat" ? `${formatCurrency(r.fee_amount)} flat` : `${r.fee_amount}% of rent`}</div>
  </div>
  <button onClick={async () => { if(!guardSubmit("delLateFee",r.id))return; try{ if(!await showConfirm({ message: "Delete this late fee rule?" }))return; await supabase.from("late_fee_rules").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", r.id).eq("company_id", companyId); fetchData(); }finally{guardRelease("delLateFee",r.id);} }} className="text-xs text-danger-400 hover:text-danger-600">Delete</button>
  </div>
  ))}
  </div>
  )}
  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-5">
  <h3 className="font-semibold text-neutral-700 mb-3">New Late Fee Rule</h3>
  <div className="grid grid-cols-2 gap-3">
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Rule Name *</label><Input placeholder="Standard Late Fee" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Grace Period (days)</label><Input type="number" min="0" max="30" placeholder="5" value={form.grace_days} onChange={e => setForm({ ...form, grace_days: e.target.value })} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Fee Type</label><Select value={form.fee_type} onChange={e => setForm({ ...form, fee_type: e.target.value })}><option value="flat">Flat ($)</option><option value="percent">Percent (%)</option></Select></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">{form.fee_type === "flat" ? "Fee Amount ($)" : "Percentage (%)"}</label><Input type="number" min="0" step="0.01" placeholder={form.fee_type === "flat" ? "50.00" : "5.0"} value={form.fee_amount} onChange={e => setForm({ ...form, fee_amount: e.target.value })} /></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveRule}>Save Rule</Btn>
  <Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
  </div>
  </div>
  )}
  <div className="grid grid-cols-3 gap-3 mb-5">
  <div className="bg-white rounded-3xl border border-brand-50 p-4 text-center"><div className="text-2xl font-bold text-notice-500">{flagged.length}</div><div className="text-xs text-neutral-400 mt-1">Overdue</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 p-4 text-center"><div className="text-2xl font-bold text-danger-500">{afterGrace.length}</div><div className="text-xs text-neutral-400 mt-1">Past Grace Period</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 p-4 text-center"><div className="text-2xl font-bold text-neutral-700">${flagged.reduce((s, p) => s + safeNum(p.amount), 0).toLocaleString()}</div><div className="text-xs text-neutral-400 mt-1">Total Overdue</div></div>
  </div>
  <div className="space-y-3">
  {flagged.map(p => {
  const pastGrace = rules.length > 0 && p.daysLate > rules[0]?.grace_days;
  return (
  <div key={p.id} className={`bg-white rounded-xl border shadow-sm p-4 ${pastGrace ? "border-danger-200" : "border-notice-100"}`}>
  <div className="flex justify-between items-start">
  <div><div className="font-semibold text-neutral-800">{p.tenant}</div><div className="text-xs text-neutral-400">{p.property}</div></div>
  <div className="text-right"><div className="font-bold text-danger-500">${p.amount}</div><div className={`text-xs font-semibold ${pastGrace ? "text-danger-500" : "text-notice-500"}`}>{p.daysLate} days late</div></div>
  </div>
  <div className="mt-3 flex gap-2">
  {pastGrace && rules.length > 0 && <Btn variant="danger" size="xs" onClick={() => applyLateFee(p, rules[0])}>Apply ${rules[0].fee_type === "flat" ? rules[0].fee_amount : Math.round(p.amount * rules[0].fee_amount / 100)} Late Fee</Btn>}
  {!pastGrace && <span className="text-xs text-notice-500 bg-notice-50 px-3 py-1 rounded-lg">Within grace period</span>}
  </div>
  </div>
  );
  })}
  {flagged.length === 0 && <div className="text-center py-10 text-neutral-400">🎉 No overdue payments!</div>}
  </div>
  </div>
  );
}

export { LateFees };
