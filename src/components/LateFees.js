import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, MoneyInput, Select, Btn, PageHeader, TextLink} from "../ui";
import { safeNum, formatCurrency, LIVE_TENANCY} from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { getPropertyClassId } from "../utils/accounting";
import { postTenantLateFee, lateFeeFailureReason } from "../utils/lateFees";
import { lateFeeBusinessDate, normalizeLateFeeType, resolveLateFeeTerms, computeLateFeeAmount, lateFeeEligibility, lateFeeDueDay, lateFeeDueDate, lateFeeOrdered, LATE_FEE_RULE_ORDER, LATE_FEE_LEASE_ORDER, LATE_FEE_SCHEDULE_ORDER } from "../utils/lateFeeRules";
import { Spinner } from "./shared";

function LateFees({ companySettings = {}, addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [rules, setRules] = useState([]);
  const [flagged, setFlagged] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  // A new rule starts with NO name. The name is the one field that
  // identifies the rule, so requiring the user to type it is what makes
  // "+ New Rule" → "Save Rule" a deliberate act rather than a one-click
  // insert of a fully pre-filled row. The numeric policy defaults stay
  // seeded from company settings (same convention as Leases /
  // RecurringJournalEntries) and the form says so explicitly.
  const blankRule = () => ({ name: "", grace_days: String(companySettings.late_fee_grace_days || 5), fee_amount: String(companySettings.late_fee_amount || 50), fee_type: companySettings.late_fee_type || "flat" });
  const [form, setForm] = useState(blankRule);
  const [editingRule, setEditingRule] = useState(null);

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
  try {
  // Overdue derived from each tenant's AR balance, not from a
  // payments.status='unpaid' column. No flow in the app ever writes
  // status='unpaid' — every insert uses 'paid' — so the prior query
  // always returned an empty list and this page silently had nothing
  // to act on. AR balance > 0 after the grace period past the lease's
  // due day is the real "overdue rent" signal.
  const [r, t, lRes, sRes] = await Promise.all([
  // Ordered. applyAllFees and the per-row Apply button both take
  // rules[0], and without an ORDER BY the row Postgres happens to return
  // first decides which fee every overdue tenant is charged. Oldest rule
  // first makes the choice deterministic and explicable.
  // id breaks a created_at tie, as the nightly job does (LATE_FEE_RULE_ORDER).
  lateFeeOrdered(supabase.from("late_fee_rules").select("*").eq("company_id", companyId).is("archived_at", null), LATE_FEE_RULE_ORDER),
  // Active AND on-notice tenants: someone on notice still lives there and
  // still owes rent. Same "who" as the tenant button and the nightly job.
  supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null).in("lease_status", LIVE_TENANCY),
  // Leases and rent schedules in the nightly job's order (newest lease
  // first; oldest schedule first; id breaks ties), matched to tenants by
  // tenant_id only -- the same as the tenant button and the job. A lease
  // with no tenant_id is not guessed at by name.
  lateFeeOrdered(supabase.from("leases").select("tenant_id, payment_due_day, start_date, id").eq("company_id", companyId).eq("status", "active").gt("payment_due_day", 0).not("tenant_id", "is", null), LATE_FEE_LEASE_ORDER),
  lateFeeOrdered(supabase.from("recurring_journal_entries").select("tenant_id, day_of_month, created_at, id").eq("company_id", companyId).eq("status", "active").is("archived_at", null).gt("day_of_month", 0).not("tenant_id", "is", null), LATE_FEE_SCHEDULE_ORDER),
  ]);
  const leases = lRes.data || [];
  const schedules = sRes.data || [];
  setRules(r.data || []);
  setTenants(t.data || []);
  // New York calendar day, the same day the nightly job uses.
  const today = lateFeeBusinessDate();
  if (!today) throw new Error("could not determine today's date in New York");
  const overdue = (t.data || [])
    .filter(tn => safeNum(tn.balance) > 0)
    .map(tn => {
      const tLeases = leases.filter(l => String(l.tenant_id) === String(tn.id));
      const tScheds = schedules.filter(sc => String(sc.tenant_id) === String(tn.id));
      const dueDay = lateFeeDueDay({ leases: tLeases, schedules: tScheds });
      const dueDate = lateFeeDueDate(today, dueDay);
      // Grace 0 here: this is "how many days past due", the list shows it;
      // the grace period is applied when a fee is charged.
      const e = lateFeeEligibility({ tenant: tn, today, dueDay, graceDays: 0 });
      return {
        id: tn.id,
        tenant: tn.name,
        tenant_id: tn.id,
        property: tn.property,
        amount: safeNum(tn.balance),
        date: dueDate,
        dueDay,
        daysLate: e.daysLate,
      };
    })
    .filter(row => row.daysLate > 0);
  setFlagged(overdue);
  } catch (_e) {
  pmError("PM-6003", { raw: _e, context: "fetch late-fee overdue list", silent: true });
  setRules([]);
  setTenants([]);
  setFlagged([]);
  }
  setLoading(false);
  }

  async function saveRule() {
  if (!guardSubmit("saveRule")) return;
  try {
  if (!form.name.trim()) { showToast("Rule name is required.", "error"); return; }
  if (!form.grace_days || !form.fee_amount) { showToast("Please fill all fields.", "error"); return; }
  if (isNaN(Number(form.grace_days)) || Number(form.grace_days) < 0) { showToast("Grace days must be a valid number.", "error"); return; }
  if (isNaN(Number(form.fee_amount)) || Number(form.fee_amount) <= 0) { showToast("Fee amount must be a positive number.", "error"); return; }
  const fields = { name: form.name, grace_days: Number(form.grace_days), fee_amount: Number(form.fee_amount), fee_type: normalizeLateFeeType(form.fee_type) || "flat" };
  if (editingRule) {
  const { error } = await supabase.from("late_fee_rules").update(fields).eq("id", editingRule.id).eq("company_id", companyId);
  if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }
  addNotification("⚠️", `Late fee rule "${form.name}" updated`);
  logAudit("update", "late_fees", `Late fee rule "${form.name}" updated`, editingRule.id, userProfile?.email, userRole, companyId);
  } else {
  const { error } = await supabase.from("late_fee_rules").insert([{ ...fields, company_id: companyId }]);
  if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }
  addNotification("⚠️", `Late fee rule "${form.name}" created`);
  }
  setShowForm(false);
  setForm(blankRule());
  setEditingRule(null);
  fetchData();
  } finally { guardRelease("saveRule"); }
  }

  async function applyLateFee(payment, rule) {
  // By id: the overdue row is built from the tenant row, and two tenants
  // can share a name.
  const tenant = tenants.find(t => payment.tenant_id != null && String(t.id) === String(payment.tenant_id))
    || tenants.find(t => t.name === payment.tenant && t.property === payment.property);
  if (!tenant?.id) {
    pmError("PM-6003", { raw: { message: "Late fee not applied: no tenant record for " + payment.tenant }, context: "applyLateFee", silent: true });
    return;
  }
  // Same four answers as the tenant button and the nightly job
  // (utils/lateFeeRules.js): the tenant's own late-fee setting if set, else
  // this rule; 'fixed' is a dollar amount; only a live tenant who owes money
  // and is past the due day + grace.
  const terms = resolveLateFeeTerms({ tenant, rule });
  if (terms.error) { showToast(`Late fee not applied to ${payment.tenant}: ${terms.error}.`, "error"); return; }
  const today = lateFeeBusinessDate();
  const elig = lateFeeEligibility({ tenant, today, dueDay: payment.dueDay, graceDays: terms.graceDays });
  if (!elig.ok) { showToast(`Late fee not applied to ${payment.tenant}: ${elig.reason}.`, "warning"); return; }
  const feeAmount = computeLateFeeAmount(terms, tenant?.rent);
  if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
    showToast(`Late fee not applied to ${payment.tenant}: a percent fee needs the tenant's rent to be set.`, "error");
    pmError("PM-6003", { raw: { message: "Computed late fee is invalid: " + feeAmount }, context: "applyLateFee", silent: true });
    return;
  }
  const classId = await getPropertyClassId(payment.property, companyId);
  // One routine for every manual late fee (utils/lateFees.js): the shared
  // one-per-month rule — which also sees the nightly job's fees, the tenant
  // page's fees and hand-entered ones — reference LATEFEE-<tenant_id>-YYYYMM,
  // and the debit on the tenant's OWN AR account. No balanceUpdate — the
  // balance-sync trigger recomputes tenants.balance from the GL.
  const res = await postTenantLateFee({ companyId, tenant, amount: feeAmount, date: today, classId,
    description: "Late fee - " + payment.tenant + " - " + payment.property,
    arMemo: "Late fee: " + payment.tenant,
    incomeMemo: payment.daysLate + " days overdue",
    ledgerDescription: `Late fee — ${payment.daysLate} days overdue`,
  });
  if (res.status === "duplicate") {
    pmError("PM-9005", { raw: { message: "Late fee already applied for " + payment.tenant + " this month" }, context: "late fee duplicate check", silent: true });
    return;
  }
  if (res.status !== "posted") {
    pmError("PM-4002", { raw: { message: "Late fee not applied for " + payment.tenant + ": " + lateFeeFailureReason(res) }, context: "applyLateFee" });
    fetchData();
    return;
  }
  addNotification("⚠️", `Late fee ${formatCurrency(feeAmount)} applied to ${payment.tenant}`);
  // Tenant-facing copy — they'll see this in their portal inbox.
  if (tenant?.email) addNotification("⚠️", `A late fee of ${formatCurrency(feeAmount)} was added to your account (${payment.daysLate} days overdue).`, { recipient: tenant.email, type: "late_fee" });
  logAudit("create", "late_fees", `Late fee ${formatCurrency(feeAmount)} applied to ${payment.tenant} (${payment.daysLate} days overdue)`, tenant?.id || "", userProfile?.email, userRole, companyId);
  if (tenant?.email) queueNotification("late_fee_applied", tenant.email, { tenant: payment.tenant, amount: feeAmount, daysLate: payment.daysLate, property: payment.property }, companyId);
  fetchData();
  }

  async function applyAllFees() {
  const rule = rules.find(r => r.is_active !== false);
  if (!rule) { showToast("Create an active late fee rule first.", "error"); return; }
  if (!await showConfirm({ message: `Apply late fees to all ${flagged.filter(p => p.daysLate > rule.grace_days).length} overdue tenants?` })) return;
  for (const p of flagged.filter(p => p.daysLate > rule.grace_days)) await applyLateFee(p, rule);
  }

  // What the Apply button promises must be what applyLateFee charges.
  // A percent rule is a percentage of the tenant's RENT (see the rentBase
  // branch above); previewing it off the outstanding BALANCE showed a
  // different number on the button than the one that got posted for any
  // tenant who was not exactly one month behind.
  function previewFee(row, rule) {
  const tenant = tenants.find(t => row.tenant_id != null && String(t.id) === String(row.tenant_id))
    || tenants.find(t => t.name === row.tenant && t.property === row.property);
  const terms = resolveLateFeeTerms({ tenant, rule });
  if (terms.error) return "—";
  const fee = computeLateFeeAmount(terms, tenant?.rent);
  return fee == null ? "—" : fee.toFixed(2);
  }

  if (loading) return <Spinner />;
  // Only ENABLED rules drive the apply UI; disabled rules stay listed but inert.
  const activeRules = rules.filter(r => r.is_active !== false);
  const afterGrace = flagged.filter(p => activeRules.length > 0 && p.daysLate > activeRules[0]?.grace_days);

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <div>
  <PageHeader title="Late Fee Automation" />
  <p className="text-xs text-neutral-400 mt-0.5">Auto-flag overdue payments and apply fees after grace period</p>
  </div>
  <div className="flex gap-2">
  {afterGrace.length > 0 && <Btn variant="danger-fill" className="bg-danger-500 hover:bg-danger-600" onClick={applyAllFees}>⚡ Apply All ({afterGrace.length})</Btn>}
  <Btn onClick={() => { if (!showForm) { setForm(blankRule()); setEditingRule(null); } setShowForm(!showForm); }}>+ New Rule</Btn>
  </div>
  </div>
  {rules.length > 0 && (
  <div className="mb-5 space-y-2">
  <h3 className="font-semibold text-neutral-700 text-sm">Active Rules</h3>
  {rules.map(r => (
  <div key={r.id} className={`bg-brand-50 border border-brand-100 rounded-xl px-4 py-3 flex justify-between items-center ${r.is_active === false ? "opacity-50" : ""}`}>
  <div>
  <div className="font-semibold text-brand-800 text-sm flex items-center gap-2">{r.name}{r.is_active === false && <span className="text-2xs font-medium text-neutral-400 bg-neutral-100 px-2 py-0.5 rounded">Disabled</span>}</div>
  <div className="text-xs text-brand-500">{r.grace_days} day grace · {normalizeLateFeeType(r.fee_type) === "flat" ? `${formatCurrency(r.fee_amount)} flat` : normalizeLateFeeType(r.fee_type) === "percent" ? `${r.fee_amount}% of rent` : `unknown type "${r.fee_type}"`}</div>
  </div>
  <div className="flex gap-3 items-center">
  <TextLink size="xs" underline={false} onClick={() => { setEditingRule(r); setForm({ name: r.name || "", grace_days: String(r.grace_days ?? ""), fee_amount: String(r.fee_amount ?? ""), fee_type: normalizeLateFeeType(r.fee_type) || "flat" }); setShowForm(true); }}>Edit</TextLink>
  <TextLink size="xs" underline={false} onClick={async () => { if(!guardSubmit("toggleLateFee",r.id))return; try{ const { error } = await supabase.from("late_fee_rules").update({ is_active: !r.is_active }).eq("id", r.id).eq("company_id", companyId); if(error){ showToast("Failed to update rule.", "error"); return; } showToast(r.is_active ? "Rule disabled." : "Rule enabled.", "success"); fetchData(); }finally{guardRelease("toggleLateFee",r.id);} }}>{r.is_active === false ? "Enable" : "Disable"}</TextLink>
  <TextLink tone="danger" size="xs" underline={false} onClick={async () => { if(!guardSubmit("delLateFee",r.id))return; try{ if(!await showConfirm({ message: "Delete this late fee rule?" }))return; await supabase.from("late_fee_rules").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", r.id).eq("company_id", companyId); fetchData(); }finally{guardRelease("delLateFee",r.id);} }}>Delete</TextLink>
  </div>
  </div>
  ))}
  </div>
  )}
  {showForm && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-5">
  <h3 className="font-semibold text-neutral-700 mb-1">{editingRule ? "Edit Late Fee Rule" : "New Late Fee Rule"}</h3>
  <p className="text-xs text-neutral-400 mb-3">Grace period, fee type and amount are pre-filled as suggested defaults from your company settings — adjust them as needed. Give the rule a name to save it.</p>
  <div className="grid grid-cols-2 gap-3">
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Rule Name *</label><Input placeholder="Standard Late Fee" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Grace Period (days) <span className="text-neutral-300">· suggested</span></label><Input type="number" min="0" max="30" placeholder="5" value={form.grace_days} onChange={e => setForm({ ...form, grace_days: e.target.value })} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Fee Type</label><Select value={form.fee_type} onChange={e => setForm({ ...form, fee_type: e.target.value })}><option value="flat">Flat ($)</option><option value="percent">Percent (%)</option></Select></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">{form.fee_type === "flat" ? "Fee Amount ($)" : "Percentage (%)"} <span className="text-neutral-300">· suggested</span></label><MoneyInput min="0" placeholder={form.fee_type === "flat" ? "50.00" : "5.0"} value={form.fee_amount} onChange={v => setForm({ ...form, fee_amount: v })} /></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveRule}>Save Rule</Btn>
  <Btn variant="secondary" onClick={() => { setShowForm(false); setForm(blankRule()); setEditingRule(null); }}>Cancel</Btn>
  </div>
  </div>
  )}
  <div className="grid grid-cols-3 gap-3 mb-5">
  <div className="bg-white rounded-xl border border-neutral-200 p-4 text-center"><div className="text-2xl font-bold text-notice-500">{flagged.length}</div><div className="text-xs text-neutral-400 mt-1">Overdue</div></div>
  <div className="bg-white rounded-xl border border-neutral-200 p-4 text-center"><div className="text-2xl font-bold text-danger-500">{afterGrace.length}</div><div className="text-xs text-neutral-400 mt-1">Past Grace Period</div></div>
  <div className="bg-white rounded-xl border border-neutral-200 p-4 text-center"><div className="text-2xl font-bold text-neutral-700">${flagged.reduce((s, p) => s + safeNum(p.amount), 0).toLocaleString()}</div><div className="text-xs text-neutral-400 mt-1">Total Overdue</div></div>
  </div>
  <div className="space-y-3">
  {flagged.map(p => {
  const pastGrace = activeRules.length > 0 && p.daysLate > activeRules[0]?.grace_days;
  return (
  <div key={p.id} className={`bg-white rounded-xl border shadow-card p-4 ${pastGrace ? "border-danger-200" : "border-notice-100"}`}>
  <div className="flex justify-between items-start">
  <div><div className="font-semibold text-neutral-800">{p.tenant}</div><div className="text-xs text-neutral-400">{p.property}</div></div>
  <div className="text-right"><div className="font-bold text-danger-500">${p.amount}</div><div className={`text-xs font-semibold ${pastGrace ? "text-danger-500" : "text-notice-500"}`}>{p.daysLate} days late</div></div>
  </div>
  <div className="mt-3 flex gap-2">
  {pastGrace && activeRules.length > 0 && <Btn variant="danger" size="xs" onClick={() => applyLateFee(p, activeRules[0])}>Apply ${previewFee(p, activeRules[0])} Late Fee</Btn>}
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
