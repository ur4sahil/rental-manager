import React, { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import { supabase } from "../supabase";
import { Input, Textarea, Select, Btn, PageHeader, TextLink} from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, formatCurrency, sanitizeForPrint, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { companyQuery, companyInsert } from "../utils/company";
import { safeLedgerInsert, atomicPostJEAndLedger, autoPostJournalEntry, getPropertyClassId, getOrCreateTenantAR, resolveAccountId } from "../utils/accounting";
import { StatCard, Spinner, PropertySelect } from "./shared";

function MoveOutWizard({ addNotification, userProfile, userRole, companyId, setPage, showToast, showConfirm }) {
  const [step, setStep] = useState(1);
  const [tenants, setTenants] = useState([]);
  const [leases, setLeases] = useState([]);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [selectedLease, setSelectedLease] = useState(null);
  const [moveOutDate, setMoveOutDate] = useState(formatLocalDate(new Date()));
  const [checklist, setChecklist] = useState([]);
  const [deductions, setDeductions] = useState([]);
  const [newDeductionDesc, setNewDeductionDesc] = useState("");
  const [newDeductionAmt, setNewDeductionAmt] = useState("");
  const [arAction, setArAction] = useState("collect");
  const [processing, setProcessing] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [loading, setLoading] = useState(true);

  const defaultChecklist = ["Keys returned","All personal items removed","Unit cleaned","Walls patched/repaired","Appliances clean","Carpets cleaned","Final inspection done","Forwarding address collected","Utilities transferred","Security deposit review","Photos taken"];

  useEffect(() => {
  async function load() {
  const [t, l] = await Promise.all([
  supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null).eq("lease_status", "active"),
  supabase.from("leases").select("*").eq("company_id", companyId).eq("status", "active"),
  ]);
  setTenants(t.data || []);
  setLeases(l.data || []);
  setChecklist(defaultChecklist.map(item => ({ label: item, checked: false, notes: "" })));
  setLoading(false);
  }
  load();
  }, [companyId]);

  function selectTenant(tenantId) {
  const t = tenants.find(x => String(x.id) === String(tenantId));
  setSelectedTenant(t || null);
  if (t) {
  const lease = leases.find(l => l.tenant_name === t.name || l.property === t.property);
  setSelectedLease(lease || null);
  }
  }

  function addDeduction() {
  if (!newDeductionDesc.trim() || !newDeductionAmt || isNaN(Number(newDeductionAmt))) return;
  setDeductions([...deductions, { desc: newDeductionDesc.trim(), amount: Number(newDeductionAmt) }]);
  setNewDeductionDesc(""); setNewDeductionAmt("");
  }

  const depositAmount = safeNum(selectedLease?.security_deposit);
  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);
  const depositReturn = Math.max(0, depositAmount - totalDeductions);
  const depositForfeited = Math.max(0, totalDeductions - depositAmount);
  const outstandingBalance = safeNum(selectedTenant?.balance);

  async function executeMoveOut() {
  if (!selectedTenant || !selectedLease) return;
  setProcessing(true);
  try {
  const cid = companyId;
  const tName = selectedTenant.name;
  const classId = await getPropertyClassId(selectedLease.property, cid);

  // 1. Process deposit return/deductions GL
  if (depositReturn > 0) {
  const depResult = await atomicPostJEAndLedger({ companyId, date: moveOutDate, description: `Security deposit returned — ${tName}`, reference: `DEP-RTN-${shortId()}`, property: selectedLease.property,
  lines: [
  { account_id: "2100", account_name: "Security Deposits Held", debit: depositReturn, credit: 0, class_id: classId, memo: `Deposit return — ${tName}` },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: depositReturn, class_id: classId, memo: `Deposit refund to ${tName}` },
  ], requireJE: false });
  if (!depResult.jeId) showToast("Warning: Deposit return GL entry failed — please post manually in Accounting.", "error");
  }
  if (totalDeductions > 0 && totalDeductions <= depositAmount) {
  const dedResult = await atomicPostJEAndLedger({ companyId, date: moveOutDate, description: `Deposit deductions — ${tName}`, reference: `DEP-DED-${shortId()}`, property: selectedLease.property,
  lines: [
  { account_id: "2100", account_name: "Security Deposits Held", debit: totalDeductions, credit: 0, class_id: classId, memo: `Deductions: ${deductions.map(d => d.desc).join(", ")}` },
  { account_id: "4100", account_name: "Other Income", debit: 0, credit: totalDeductions, class_id: classId, memo: `Deposit forfeiture — ${tName}` },
  ], requireJE: false });
  if (!dedResult.jeId) showToast("Warning: Deposit deduction GL entry failed — please post manually in Accounting.", "error");
  }

  // 2. Handle outstanding AR (balance update gated on JE success)
  if (arAction === "waive" && outstandingBalance > 0) {
  const woResult = await atomicPostJEAndLedger({ companyId, date: moveOutDate, description: `Bad debt write-off — ${tName}`, reference: `WOFF-${shortId()}`, property: selectedLease.property,
  lines: [
  { account_id: "5500", account_name: "Bad Debt Expense", debit: outstandingBalance, credit: 0, class_id: classId, memo: `Write-off at move-out — ${tName}` },
  { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: outstandingBalance, class_id: classId, memo: `AR write-off — ${tName}` },
  ], ledgerEntry: { tenant: tName, tenant_id: selectedTenant.id, property: selectedLease.property, date: moveOutDate, description: "Bad debt write-off", amount: -outstandingBalance, type: "adjustment", balance: 0 },
  balanceUpdate: { tenantId: selectedTenant.id, amount: -outstandingBalance } });
  }

  // 2b. Prorate rent for partial move-out month
  const moveOutDay = parseInt(moveOutDate.split("-")[2]);
  const moveOutMonth = moveOutDate.slice(0, 7);
  const daysInMoveOutMonth = new Date(parseInt(moveOutDate.split("-")[0]), parseInt(moveOutDate.split("-")[1]), 0).getDate();
  if (moveOutDay < daysInMoveOutMonth && selectedLease.rent_amount > 0) {
  // Check if full rent was already posted for this month
  const fullRef = "RENT-AUTO-" + selectedLease.id + "-" + moveOutMonth;
  const { data: existingCharge } = await supabase.from("acct_journal_entries").select("id").eq("company_id", cid).eq("reference", fullRef).neq("status", "voided").maybeSingle();
  if (existingCharge) {
  // Full rent was posted — credit back the prorated difference
  const fullRentCents = Math.round(safeNum(selectedLease.rent_amount) * 100);
  const proratedCents = Math.round(fullRentCents * moveOutDay / daysInMoveOutMonth);
  const fullRent = fullRentCents / 100;
  const proratedRent = proratedCents / 100;
  const creditBack = (fullRentCents - proratedCents) / 100;
  if (creditBack > 0) {
  const tenantArId = await getOrCreateTenantAR(cid, tName, selectedTenant.id);
  const revenueId = await resolveAccountId("4000", cid);
  await autoPostJournalEntry({ companyId: cid, date: moveOutDate,
  description: `Prorated rent adjustment — ${tName} — ${moveOutDay}/${daysInMoveOutMonth} days`,
  reference: `RENT-PRORATE-${selectedLease.id}-${moveOutMonth}`, property: selectedLease.property,
  lines: [
  { account_id: revenueId, account_name: "Rental Income", debit: creditBack, credit: 0, class_id: classId, memo: `Proration credit ${moveOutMonth}` },
  { account_id: tenantArId, account_name: "AR - " + tName, debit: 0, credit: creditBack, class_id: classId, memo: `${moveOutDay}/${daysInMoveOutMonth} days — move-out` },
  ]
  });
  await safeLedgerInsert({ company_id: cid, tenant: tName, tenant_id: selectedTenant.id, property: selectedLease.property, date: moveOutDate, description: `Rent proration credit (${moveOutDay}/${daysInMoveOutMonth} days)`, amount: -creditBack, type: "adjustment", balance: 0 });
  if (selectedTenant.id) {
  const { error: _balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: selectedTenant.id, p_amount_change: -creditBack });
  if (_balErr) pmError("PM-6002", { raw: _balErr, context: "balance update on move-out credit", silent: true });
  }
  }
  }
  }

  // #7: Track completed steps for error recovery
  const completedSteps = [];
  try {
  // 3. Terminate lease
  const { error: leaseErr } = await supabase.from("leases").update({ status: "terminated", end_date: moveOutDate }).eq("id", selectedLease.id).eq("company_id", cid);
  if (leaseErr) { pmError("PM-3004", { raw: leaseErr, context: "lease termination in move-out wizard", silent: true }); throw new Error("Lease termination failed. Please try again or contact your admin."); }
  completedSteps.push("lease_terminated");

  // 4. Deactivate autopay (scope by property to avoid disabling same-name tenant at different property)
  await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", cid).eq("tenant", tName).eq("property", selectedLease.property);
  completedSteps.push("autopay_disabled");

  // 5. Archive tenant (moves to Historical Tenants on property page)
  const { error: tenantErr } = await supabase.from("tenants").update({ lease_status: "inactive", move_out: moveOutDate, archived_at: new Date().toISOString(), archived_by: userProfile?.email || "system" }).eq("id", selectedTenant.id).eq("company_id", cid);
  if (tenantErr) throw new Error("Tenant archive failed: " + tenantErr.message + ". Completed: " + completedSteps.join(", "));
  completedSteps.push("tenant_archived");

  // 6. Update property to vacant
  const { error: propErr } = await supabase.from("properties").update({ status: "vacant", tenant: "", lease_end: null }).eq("company_id", cid).eq("address", selectedLease.property);
  if (propErr) throw new Error("Property update failed: " + propErr.message + ". Completed: " + completedSteps.join(", "));
  completedSteps.push("property_vacant");

  // 7. Deactivate recurring entries for this property/tenant
  await supabase.from("recurring_journal_entries").update({ status: "inactive", archived_at: new Date().toISOString() }).eq("company_id", cid).eq("property", selectedLease.property).eq("status", "active");
  completedSteps.push("recurring_deactivated");
  } catch (stepErr) {
  showToast("Move-out partially completed. " + stepErr.message + "\n\nPlease manually verify and fix any inconsistent state.", "error");
  pmError("PM-3006", { raw: stepErr, context: "move-out partial failure, completed: " + completedSteps.join(", "), silent: true });
  }

  // 7. Create ledger entries (fetch fresh balance for accurate ledger trail)
  const { data: moTenantBal } = await supabase.from("tenants").select("balance").eq("id", selectedTenant.id).eq("company_id", cid).maybeSingle();
  let moRunningBalance = safeNum(moTenantBal?.balance);
  if (depositReturn > 0) {
  moRunningBalance -= depositReturn;
  await safeLedgerInsert({ company_id: cid, tenant: tName, tenant_id: selectedTenant.id, property: selectedLease.property, date: moveOutDate, description: "Security deposit returned", amount: -depositReturn, type: "deposit_return", balance: moRunningBalance });
  }

  // 8. Save inspection checklist
  await supabase.from("inspections").insert([{ company_id: cid, property: selectedLease.property, type: "Move-Out", date: moveOutDate, inspector: userProfile?.name || "Admin", items: JSON.stringify(checklist), notes: `Move-out inspection for ${tName}` }]);

  // 9. Audit + notifications
  logAudit("update", "tenants", `Move-out completed: ${tName} from ${selectedLease.property}`, selectedTenant.id, userProfile?.email, userRole, cid);
  addNotification("🚪", `Move-out completed: ${tName} from ${selectedLease.property}`);
  queueNotification("move_out", selectedTenant?.email || "", { tenant: tName, property: selectedLease?.property, moveOutDate: formatLocalDate(new Date()) }, cid);
  if (selectedTenant.email) {
  queueNotification("deposit_returned", selectedTenant.email, { tenant: tName, returned: depositReturn, deducted: totalDeductions, property: selectedLease.property, moveOutDate }, cid);
  }

  setCompleted(true);
  } catch (e) {
  showToast("Move-out failed: " + e.message, "error");
  }
  setProcessing(false);
  }

  if (loading) return <Spinner />;

  if (completed) return (
  <div className="max-w-xl mx-auto text-center py-20">
  <div className="w-16 h-16 bg-success-50 text-success-600 rounded-3xl flex items-center justify-center mx-auto mb-4">
  <span className="material-icons-outlined text-3xl">check_circle</span>
  </div>
  <PageHeader title="Move-Out Complete" />
  <p className="text-neutral-400 mb-6">All accounting entries posted, lease terminated, and property marked vacant.</p>
  <Btn onClick={() => setPage("dashboard")}>Back to Dashboard</Btn>
  </div>
  );

  const steps = ["Select Tenant", "Inspection", "Deposit", "AR Settlement", "Confirm"];

  return (
  <div className="max-w-2xl mx-auto">
  <PageHeader title="Move-Out Wizard" />

  {/* Step indicator */}
  <div className="flex items-center gap-2 mb-8">
  {steps.map((s, i) => (
  <div key={s} className="flex items-center gap-2 flex-1">
  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${i + 1 <= step ? "bg-brand-600 text-white" : "bg-brand-50 text-neutral-400"}`}>{i + 1}</div>
  <span className={`text-xs font-medium hidden md:block ${i + 1 <= step ? "text-brand-600" : "text-neutral-400"}`}>{s}</span>
  {i < steps.length - 1 && <div className={`flex-1 h-0.5 ${i + 1 < step ? "bg-brand-600" : "bg-brand-50"}`} />}
  </div>
  ))}
  </div>

  {/* Step 1: Select Tenant */}
  {step === 1 && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-6">
  <h3 className="text-lg font-manrope font-bold text-neutral-800 mb-4">Select Tenant & Move-Out Date</h3>
  <div className="space-y-4">
  <div>
  <label className="text-xs font-medium text-neutral-400 uppercase tracking-widest block mb-1">Tenant</label>
  <Select value={selectedTenant?.id || ""} onChange={e => selectTenant(e.target.value)} >
  <option value="">Select tenant...</option>
  {tenants.map(t => <option key={t.id} value={t.id}>{t.name} — {t.property}</option>)}
  </Select>
  </div>
  {selectedTenant && (
  <>
  <div>
  <label className="text-xs font-medium text-neutral-400 uppercase tracking-widest block mb-1">Move-Out Date</label>
  <Input type="date" value={moveOutDate} onChange={e => setMoveOutDate(e.target.value)}  className="w-40" />
  </div>
  <div className="bg-brand-50/30 rounded-2xl p-4 space-y-2 text-sm">
  <div className="flex justify-between"><span className="text-neutral-400">Property</span><span className="font-medium text-neutral-700">{selectedTenant.property}</span></div>
  <div className="flex justify-between"><span className="text-neutral-400">Monthly Rent</span><span className="font-medium text-neutral-700">${safeNum(selectedTenant.rent)}</span></div>
  <div className="flex justify-between"><span className="text-neutral-400">Balance</span><span className={`font-bold ${outstandingBalance > 0 ? "text-danger-600" : "text-success-600"}`}>${outstandingBalance.toFixed(2)}</span></div>
  {selectedLease && <div className="flex justify-between"><span className="text-neutral-400">Security Deposit</span><span className="font-medium text-neutral-700">${depositAmount.toFixed(2)}</span></div>}
  </div>
  </>
  )}
  </div>
  <div className="flex justify-end mt-6">
  <Btn disabled={!selectedTenant} onClick={() => setStep(2)} className="disabled:opacity-40">Next →</Btn>
  </div>
  </div>
  )}

  {/* Step 2: Inspection Checklist */}
  {step === 2 && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-6">
  <h3 className="text-lg font-manrope font-bold text-neutral-800 mb-4">Move-Out Inspection</h3>
  <div className="space-y-2">
  {checklist.map((item, i) => (
  <div key={i} className={`flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-colors ${item.checked ? "bg-success-50 border-success-200" : "bg-white border-brand-50 hover:bg-brand-50/30"}`} onClick={() => { const c = [...checklist]; c[i] = { ...c[i], checked: !c[i].checked }; setChecklist(c); }}>
  <span className={`material-icons-outlined text-lg ${item.checked ? "text-success-600" : "text-neutral-300"}`}>{item.checked ? "check_circle" : "radio_button_unchecked"}</span>
  <span className={`flex-1 text-sm ${item.checked ? "text-success-700 font-medium" : "text-neutral-500"}`}>{item.label}</span>
  </div>
  ))}
  </div>
  <div className="flex justify-between mt-6">
  <Btn variant="ghost" onClick={() => setStep(1)}>← Back</Btn>
  <Btn onClick={() => setStep(3)}>Next →</Btn>
  </div>
  </div>
  )}

  {/* Step 3: Deposit Accounting */}
  {step === 3 && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-6">
  <h3 className="text-lg font-manrope font-bold text-neutral-800 mb-4">Security Deposit Settlement</h3>
  <div className="bg-brand-50/30 rounded-2xl p-4 mb-4">
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Original Deposit</span><span className="font-bold text-neutral-700">${depositAmount.toFixed(2)}</span></div>
  </div>
  <h4 className="text-sm font-semibold text-neutral-500 mb-2">Deductions</h4>
  {deductions.map((d, i) => (
  <div key={i} className="flex items-center justify-between py-2 border-b border-brand-50/50">
  <span className="text-sm text-neutral-700">{d.desc}</span>
  <div className="flex items-center gap-2">
  <span className="text-sm font-semibold text-danger-600">-${d.amount.toFixed(2)}</span>
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => setDeductions(deductions.filter((_, j) => j !== i))}><span className="material-icons-outlined text-sm">close</span></TextLink>
  </div>
  </div>
  ))}
  <div className="flex gap-2 mt-3">
  <Input placeholder="Description (e.g., Wall damage)" value={newDeductionDesc} onChange={e => setNewDeductionDesc(e.target.value)} className="flex-1" />
  <Input placeholder="$" type="number" value={newDeductionAmt} onChange={e => setNewDeductionAmt(e.target.value)} className="w-24" />
  <Btn onClick={addDeduction}>Add</Btn>
  </div>
  <div className="bg-success-50 rounded-2xl p-4 mt-4 space-y-1">
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Total Deductions</span><span className="font-semibold text-danger-600">-${totalDeductions.toFixed(2)}</span></div>
  <div className="flex justify-between text-sm font-bold"><span className="text-success-700">Return to Tenant</span><span className="text-success-700">${depositReturn.toFixed(2)}</span></div>
  </div>
  <div className="flex justify-between mt-6">
  <Btn variant="ghost" onClick={() => setStep(2)}>← Back</Btn>
  <Btn onClick={() => setStep(4)}>Next →</Btn>
  </div>
  </div>
  )}

  {/* Step 4: AR Settlement */}
  {step === 4 && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-6">
  <h3 className="text-lg font-manrope font-bold text-neutral-800 mb-4">Outstanding Balance</h3>
  <div className={`rounded-2xl p-4 mb-4 ${outstandingBalance > 0 ? "bg-danger-50" : "bg-success-50"}`}>
  <div className="text-sm text-neutral-400">Current Balance</div>
  <div className={`text-2xl font-manrope font-bold ${outstandingBalance > 0 ? "text-danger-600" : "text-success-600"}`}>${outstandingBalance.toFixed(2)}</div>
  </div>
  {outstandingBalance > 0 && (
  <div className="space-y-2">
  {[
  { value: "collect", label: "Keep for Collection", desc: "Balance remains on tenant record for future collection", icon: "account_balance" },
  { value: "waive", label: "Write Off (Bad Debt)", desc: "Post as bad debt expense and zero out balance", icon: "money_off" },
  { value: "collections", label: "Send to Collections", desc: "Mark tenant for external collections agency", icon: "gavel" },
  ].map(opt => (
  <div key={opt.value} onClick={() => setArAction(opt.value)} className={`flex items-center gap-3 p-4 rounded-2xl border cursor-pointer transition-all ${arAction === opt.value ? "border-brand-300 bg-brand-50" : "border-brand-50 hover:border-brand-200"}`}>
  <span className={`material-icons-outlined ${arAction === opt.value ? "text-brand-600" : "text-neutral-400"}`}>{opt.icon}</span>
  <div><div className="text-sm font-semibold text-neutral-700">{opt.label}</div><div className="text-xs text-neutral-400">{opt.desc}</div></div>
  </div>
  ))}
  </div>
  )}
  {outstandingBalance <= 0 && <p className="text-sm text-success-600 font-medium">No outstanding balance — tenant is settled.</p>}
  <div className="flex justify-between mt-6">
  <Btn variant="ghost" onClick={() => setStep(3)}>← Back</Btn>
  <Btn onClick={() => setStep(5)}>Next →</Btn>
  </div>
  </div>
  )}

  {/* Step 5: Confirm & Execute */}
  {step === 5 && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-6">
  <h3 className="text-lg font-manrope font-bold text-neutral-800 mb-4">Confirm Move-Out</h3>
  <div className="space-y-3 text-sm">
  <div className="flex justify-between py-2 border-b border-brand-50"><span className="text-neutral-400">Tenant</span><span className="font-semibold text-neutral-700">{selectedTenant?.name}</span></div>
  <div className="flex justify-between py-2 border-b border-brand-50"><span className="text-neutral-400">Property</span><span className="font-semibold text-neutral-700">{selectedLease?.property}</span></div>
  <div className="flex justify-between py-2 border-b border-brand-50"><span className="text-neutral-400">Move-Out Date</span><span className="font-semibold text-neutral-700">{moveOutDate}</span></div>
  <div className="flex justify-between py-2 border-b border-brand-50"><span className="text-neutral-400">Inspection Items</span><span className="font-semibold text-success-600">{checklist.filter(c => c.checked).length}/{checklist.length} checked</span></div>
  <div className="flex justify-between py-2 border-b border-brand-50"><span className="text-neutral-400">Deposit Return</span><span className="font-semibold text-success-600">${depositReturn.toFixed(2)}</span></div>
  {totalDeductions > 0 && <div className="flex justify-between py-2 border-b border-brand-50"><span className="text-neutral-400">Deductions</span><span className="font-semibold text-danger-600">-${totalDeductions.toFixed(2)}</span></div>}
  <div className="flex justify-between py-2 border-b border-brand-50"><span className="text-neutral-400">AR Action</span><span className="font-semibold text-neutral-700 capitalize">{outstandingBalance > 0 ? arAction.replace("_", " ") : "Settled"}</span></div>
  </div>
  <div className="bg-warn-50 rounded-2xl p-3 mt-4 text-xs text-warn-700">
  <span className="material-icons-outlined text-sm align-middle mr-1">warning</span>
  This will terminate the lease, update property to vacant, and post all accounting entries. This cannot be undone.
  </div>
  <div className="flex justify-between mt-6">
  <Btn variant="ghost" onClick={() => setStep(4)}>← Back</Btn>
  <Btn variant="danger-fill" className="disabled:opacity-40" onClick={executeMoveOut} disabled={processing}>
  {processing ? "Processing..." : "Execute Move-Out"}
  </Btn>
  </div>
  </div>
  )}
  </div>
  );
}

const EVICTION_STAGES = [
  { id: "notice", label: "Notice to Cure/Quit", icon: "mail", color: "bg-warn-500" },
  { id: "cure_period", label: "Cure Period", icon: "schedule", color: "bg-notice-500" },
  { id: "filing", label: "Court Filing", icon: "gavel", color: "bg-danger-400" },
  { id: "hearing", label: "Hearing", icon: "event", color: "bg-danger-500" },
  { id: "judgment", label: "Judgment", icon: "description", color: "bg-danger-600" },
  { id: "writ", label: "Writ of Restitution", icon: "assignment", color: "bg-danger-700" },
  { id: "lockout", label: "Lockout", icon: "lock", color: "bg-danger-800" },
  { id: "closed", label: "Closed", icon: "check_circle", color: "bg-neutral-500" },
];

function EvictionWorkflow({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  const [cases, setCases] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selectedCase, setSelectedCase] = useState(null);
  const [filterStage, setFilterStage] = useState("all");
  const [evSearch, setEvSearch] = useState("");
  const [form, setForm] = useState({ tenant_id: "", tenant_name: "", property: "", reason: "non_payment", notice_type: "pay_or_quit", notice_days: "30", notes: "" });
  const [stageNote, setStageNote] = useState("");
  const [stageCost, setStageCost] = useState("");
  const [stageDate, setStageDate] = useState(formatLocalDate(new Date()));

  useEffect(() => { fetchCases(); fetchTenants(); }, [companyId]);

  async function fetchTenants() {
  const { data } = await supabase.from("tenants").select("id, name, property, lease_status, balance").eq("company_id", companyId).is("archived_at", null);
  setTenants(data || []);
  }

  async function fetchCases() {
  const { data } = await companyQuery("eviction_cases", companyId).order("created_at", { ascending: false });
  setCases(data || []);
  setLoading(false);
  }

  async function createCase() {
  if (!guardSubmit("createEviction")) return;
  try {
  if (!form.tenant_name || !form.property) { showToast("Select a tenant.", "error"); return; }
  const noticeDate = new Date();
  noticeDate.setDate(noticeDate.getDate() + parseInt(form.notice_days));
  const caseData = {
  tenant_id: form.tenant_id,
  tenant_name: form.tenant_name,
  property: form.property,
  reason: form.reason,
  notice_type: form.notice_type,
  notice_days: parseInt(form.notice_days),
  notice_date: formatLocalDate(new Date()),
  cure_deadline: formatLocalDate(noticeDate),
  current_stage: "notice",
  status: "active",
  notes: form.notes,
  stage_history: JSON.stringify([{
  stage: "notice",
  date: formatLocalDate(new Date()),
  note: `${form.notice_type.replace(/_/g, " ")} notice issued — ${form.notice_days} day cure period`,
  cost: 0,
  by: userProfile?.email,
  }]),
  total_costs: 0,
  };
  const { error } = await companyInsert("eviction_cases", caseData, companyId);
  if (error) { pmError("PM-8006", { raw: error, context: "create eviction case" }); return; }
  // Update tenant status to notice
  if (form.tenant_id) {
  const { error: tErr } = await supabase.from("tenants").update({ lease_status: "notice", move_out: formatLocalDate(noticeDate) }).eq("id", form.tenant_id).eq("company_id", companyId);
  if (tErr) pmError("PM-3002", { raw: tErr, context: "update tenant status to notice for eviction", silent: true });
  }
  // Also update lease status to notice
  const { error: lErr } = await supabase.from("leases").update({ status: "notice" }).eq("company_id", companyId).eq("tenant_name", form.tenant_name).eq("status", "active");
  if (lErr) pmError("PM-3004", { raw: lErr, context: "update lease status to notice for eviction", silent: true });
  addNotification("⚖️", `Eviction case started for ${form.tenant_name}`);
  logAudit("create", "evictions", `Eviction case: ${form.tenant_name} at ${form.property} — ${form.reason}`, "", userProfile?.email, userRole, companyId);
  setShowForm(false);
  setForm({ tenant_id: "", tenant_name: "", property: "", reason: "non_payment", notice_type: "pay_or_quit", notice_days: "30", notes: "" });
  fetchCases();
  fetchTenants();
  } finally { guardRelease("createEviction"); }
  }

  async function generateEvictionNotice(evCase) {
  const noticeTypeLabel = { pay_or_quit: "Pay or Quit", cure_or_quit: "Cure or Quit", unconditional_quit: "Unconditional Quit" };
  const stateNotice = { MD: { pay_or_quit: 10, cure_or_quit: 14, unconditional_quit: 30 }, VA: { pay_or_quit: 5, cure_or_quit: 21, unconditional_quit: 30 }, DC: { pay_or_quit: 30, cure_or_quit: 30, unconditional_quit: 90 } };
  const state = (evCase.property || "").includes(", VA") ? "VA" : (evCase.property || "").includes(", DC") ? "DC" : "MD";
  const days = stateNotice[state]?.[evCase.notice_type] || evCase.notice_days || 30;
  const serveDate = formatLocalDate(new Date());
  const deadlineDate = new Date(); deadlineDate.setDate(deadlineDate.getDate() + days);
  const deadline = formatLocalDate(deadlineDate);
  // Query current tenant balance instead of using stale eviction case data
  let balanceOwed = evCase.balance_owed || 0;
  if (evCase.tenant_id) {
    const { data: tBal } = await supabase.from("tenants").select("balance").eq("id", evCase.tenant_id).eq("company_id", companyId).maybeSingle();
    if (tBal) balanceOwed = safeNum(tBal.balance);
  }

  // Sanitize all user-supplied values before inserting into HTML
  const safeTenant = sanitizeForPrint(evCase.tenant_name || "[TENANT NAME]");
  const safeProperty = sanitizeForPrint(evCase.property || "[PROPERTY ADDRESS]");
  const safeNotes = sanitizeForPrint(evCase.notes || "[Describe the violation]");
  const html = `<!DOCTYPE html><html><head><style>
  body { font-family: 'Times New Roman', serif; max-width: 700px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #111; }
  h1 { text-align: center; font-size: 22px; border-bottom: 2px solid #333; padding-bottom: 10px; }
  h2 { font-size: 16px; margin-top: 24px; }
  .field { font-weight: bold; }
  .signature-line { border-bottom: 1px solid #333; width: 250px; display: inline-block; margin-top: 40px; }
  @media print { body { margin: 0.5in; } }
  </style></head><body>
  <h1>NOTICE TO ${sanitizeForPrint((noticeTypeLabel[evCase.notice_type] || "QUIT").toUpperCase())}</h1>
  <p><strong>State of ${state === "MD" ? "Maryland" : state === "VA" ? "Virginia" : "District of Columbia"}</strong></p>
  <p><strong>Date Served:</strong> ${sanitizeForPrint(serveDate)}</p>
  <p><strong>To:</strong> ${safeTenant}</p>
  <p><strong>Property Address:</strong> ${safeProperty}</p>
  <hr>
  <p>You are hereby notified that you are required to ${evCase.notice_type === "pay_or_quit"
  ? `pay the total outstanding rent of <strong>$${balanceOwed.toLocaleString()}</strong> or vacate the premises`
  : evCase.notice_type === "cure_or_quit"
  ? `cure the following lease violation or vacate the premises`
  : `vacate the premises unconditionally`}
  within <strong>${days} days</strong> of the date of this notice (by <strong>${sanitizeForPrint(deadline)}</strong>).</p>
  ${evCase.notice_type === "pay_or_quit" ? `<h2>Amount Due</h2><table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%">
  <tr><td>Rent Owed</td><td style="text-align:right">$${balanceOwed.toLocaleString()}</td></tr>
  <tr><td>Late Fees</td><td style="text-align:right">$${(evCase.late_fees || 0).toLocaleString()}</td></tr>
  <tr style="font-weight:bold"><td>Total</td><td style="text-align:right">$${(balanceOwed + (evCase.late_fees || 0)).toLocaleString()}</td></tr>
  </table>` : ""}
  ${evCase.reason === "lease_violation" ? `<h2>Lease Violation</h2><p>${safeNotes}</p>` : ""}
  <h2>Legal Notice</h2>
  <p>If you fail to comply with this notice within the time specified, the landlord may commence legal proceedings to recover possession of the premises and any amounts owed, pursuant to ${state === "MD" ? "Maryland Real Property Code § 8-401" : state === "VA" ? "Virginia Code § 55.1-1245" : "D.C. Code § 42-3505.01"}.</p>
  <p>Payment may be made to the landlord at the above property address or by contacting the property management office.</p>
  <br><br>
  <p>Respectfully,</p>
  <p class="signature-line">&nbsp;</p>
  <p>Landlord / Property Manager</p>
  <p style="color:#666;font-size:12px;margin-top:30px">This notice was generated by PropManager on ${serveDate}. This is a legal document — consult with an attorney for jurisdiction-specific requirements.</p>
  </body></html>`;

  const w = window.open("", "_blank", "noopener,noreferrer");
  if (w) { w.document.write(html); w.document.title = DOMPurify.sanitize(`${noticeTypeLabel[evCase.notice_type] || "Notice"} — ${evCase.tenant_name}`, { ALLOWED_TAGS: [] }); setTimeout(() => w.print(), 500); }
  }

  async function advanceStage(evCase, nextStage) {
  if (!guardSubmit("advanceEviction")) return;
  try {
  const history = JSON.parse(evCase.stage_history || "[]");
  history.push({
  stage: nextStage,
  date: stageDate || formatLocalDate(new Date()),
  note: stageNote,
  cost: safeNum(stageCost),
  by: userProfile?.email,
  });
  const newCosts = safeNum(evCase.total_costs) + safeNum(stageCost);
  const updates = {
  current_stage: nextStage,
  stage_history: JSON.stringify(history),
  total_costs: newCosts,
  };
  if (nextStage === "closed") updates.status = "closed";
  if (nextStage === "filing") updates.filing_date = stageDate || formatLocalDate(new Date());
  if (nextStage === "hearing") updates.hearing_date = stageDate || formatLocalDate(new Date());
  if (nextStage === "judgment") updates.judgment_date = stageDate || formatLocalDate(new Date());
  if (nextStage === "lockout") updates.lockout_date = stageDate || formatLocalDate(new Date());

  const { error } = await supabase.from("eviction_cases").update(updates).eq("id", evCase.id).eq("company_id", companyId);
  if (error) { pmError("PM-8006", { raw: error, context: "update eviction case stage" }); return; }

  // Post legal costs to accounting if any
  if (safeNum(stageCost) > 0) {
  const classId = await getPropertyClassId(evCase.property, companyId);
  const evResult = await atomicPostJEAndLedger({ companyId,
  date: stageDate || formatLocalDate(new Date()),
  description: `Eviction cost — ${evCase.tenant_name} — ${nextStage.replace(/_/g, " ")}`,
  reference: `EVICT-${shortId()}`, property: evCase.property,
  lines: [
  { account_id: "5610", account_name: "Legal & Eviction Costs", debit: safeNum(stageCost), credit: 0, class_id: classId, memo: `${nextStage}: ${stageNote || "Eviction expense"}` },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(stageCost), class_id: classId, memo: `Eviction: ${evCase.tenant_name}` },
  ], requireJE: false });
  if (!evResult.jeId) showToast("Warning: Eviction cost GL entry failed — please post manually in Accounting.", "error");
  }

  addNotification("⚖️", `Eviction: ${evCase.tenant_name} → ${nextStage.replace(/_/g, " ")}`);
  logAudit("update", "evictions", `Eviction stage: ${nextStage} for ${evCase.tenant_name}`, evCase.id, userProfile?.email, userRole, companyId);
  setStageNote(""); setStageCost(""); setStageDate(formatLocalDate(new Date()));
  fetchCases();
  // Refresh selected case
  const { data: refreshed } = await supabase.from("eviction_cases").select("*").eq("id", evCase.id).eq("company_id", companyId).maybeSingle();
  if (refreshed) setSelectedCase(refreshed);
  } finally { guardRelease("advanceEviction"); }
  }

  async function closeCase(evCase, outcome) {
  if (!await showConfirm({ message: `Close this eviction case as "${outcome}"?\n\n${outcome === "completed" ? "This will also: set tenant to inactive, mark property vacant, terminate lease, and disable autopay." : outcome === "tenant_cured" ? "Tenant status will return to active." : "No tenant/property changes will be made."}` })) return;
  const history = JSON.parse(evCase.stage_history || "[]");
  history.push({ stage: "closed", date: formatLocalDate(new Date()), note: `Case closed — ${outcome}`, cost: 0, by: userProfile?.email });
  await supabase.from("eviction_cases").update({ status: "closed", current_stage: "closed", outcome, stage_history: JSON.stringify(history) }).eq("id", evCase.id).eq("company_id", companyId);

  // #2: Cascade updates based on outcome
  if (outcome === "completed") {
  // Eviction complete — tenant out, property vacant
  if (evCase.tenant_id) {
  await supabase.from("tenants").update({ lease_status: "inactive" }).eq("id", evCase.tenant_id).eq("company_id", companyId);
  }
  await supabase.from("tenants").update({ lease_status: "inactive" }).eq("company_id", companyId).ilike("name", escapeFilterValue(evCase.tenant_name)).eq("property", evCase.property);
  await supabase.from("properties").update({ status: "vacant", tenant: "", lease_end: null }).eq("company_id", companyId).eq("address", evCase.property);
  await supabase.from("leases").update({ status: "terminated" }).eq("company_id", companyId).eq("tenant_name", evCase.tenant_name).eq("status", "active");
  await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant", evCase.tenant_name).eq("property", evCase.property);
  } else if (outcome === "tenant_cured") {
  // Tenant cured — restore to active
  if (evCase.tenant_id) {
  await supabase.from("tenants").update({ lease_status: "active" }).eq("id", evCase.tenant_id).eq("company_id", companyId);
  }
  await supabase.from("leases").update({ status: "active" }).eq("company_id", companyId).eq("tenant_name", evCase.tenant_name).eq("status", "notice");
  }
  // settled/dismissed: no cascade — user handles manually

  addNotification("⚖️", `Eviction closed: ${evCase.tenant_name} — ${outcome}`);
  logAudit("update", "evictions", `Eviction closed (${outcome}): ${evCase.tenant_name}${outcome === "completed" ? " — tenant inactive, property vacant, lease terminated" : ""}`, evCase.id, userProfile?.email, userRole, companyId);
  setSelectedCase(null);
  fetchCases();
  fetchTenants();
  }

  if (loading) return <Spinner />;

  const stageIdx = (stage) => EVICTION_STAGES.findIndex(s => s.id === stage);
  const filtered = cases.filter(c => {
  if (filterStage !== "all" && c.current_stage !== filterStage && (filterStage !== "active" || c.status !== "active") && (filterStage !== "closed" || c.status !== "closed")) return false;
  if (evSearch) {
  const q = evSearch.toLowerCase();
  if (!c.tenant_name?.toLowerCase().includes(q) && !c.property?.toLowerCase().includes(q)) return false;
  }
  return true;
  });

  const activeCases = cases.filter(c => c.status === "active");

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <div>
  <PageHeader title="Eviction Tracker" />
  <p className="text-sm text-neutral-400">Manage eviction cases from notice to resolution</p>
  </div>
  <Btn variant="danger-fill" onClick={() => setShowForm(!showForm)}>+ New Case</Btn>
  </div>

  {/* Stats */}
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
  <StatCard label="Active Cases" value={activeCases.length} color="text-danger-600" />
  <StatCard label="In Court" value={activeCases.filter(c => ["filing","hearing","judgment","writ"].includes(c.current_stage)).length} color="text-notice-600" />
  <StatCard label="Total Costs" value={formatCurrency(cases.reduce((s, c) => s + safeNum(c.total_costs), 0))} color="text-neutral-700" />
  <StatCard label="Closed" value={cases.filter(c => c.status === "closed").length} color="text-neutral-500" />
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-danger-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Start Eviction Case</h3>
  <div className="grid grid-cols-2 gap-3">
  <div className="col-span-2">
  <label className="text-xs font-medium text-neutral-400 mb-1 block">Tenant *</label>
  <Select value={form.tenant_id} onChange={e => { const t = tenants.find(x => String(x.id) === e.target.value); if (t) setForm({ ...form, tenant_id: t.id, tenant_name: t.name, property: t.property || "" }); }}>
  <option value="">Select tenant...</option>
  {tenants.filter(t => !t.archived_at).map(t => <option key={t.id} value={t.id}>{t.name} — {t.property}{safeNum(t.balance) > 0 ? ` (owes ${formatCurrency(t.balance)})` : ""}</option>)}
  </Select>
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-400 mb-1 block">Reason</label>
  <Select value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} >
  <option value="non_payment">Non-Payment of Rent</option>
  <option value="lease_violation">Lease Violation</option>
  <option value="holdover">Holdover (Expired Lease)</option>
  <option value="nuisance">Nuisance / Disturbance</option>
  <option value="property_damage">Property Damage</option>
  <option value="unauthorized_occupant">Unauthorized Occupant</option>
  <option value="other">Other</option>
  </Select>
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-400 mb-1 block">Notice Type</label>
  <Select value={form.notice_type} onChange={e => setForm({ ...form, notice_type: e.target.value })} >
  <option value="pay_or_quit">Pay or Quit</option>
  <option value="cure_or_quit">Cure or Quit</option>
  <option value="unconditional_quit">Unconditional Quit</option>
  <option value="notice_to_vacate">Notice to Vacate</option>
  </Select>
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-400 mb-1 block">Cure Period (days)</label>
  <Select value={form.notice_days} onChange={e => setForm({ ...form, notice_days: e.target.value })} >
  <option value="3">3 days</option><option value="5">5 days</option><option value="7">7 days</option><option value="10">10 days</option><option value="14">14 days</option><option value="30">30 days</option><option value="60">60 days</option>
  </Select>
  </div>
  <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">Notes</label><Textarea placeholder="Additional context or details..." value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="border border-brand-100 rounded-xl px-3 py-1.5 text-sm w-full" rows={2} /></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn variant="danger-fill" onClick={createCase}>Start Case</Btn>
  <Btn variant="secondary" onClick={() => setShowForm(false)}>Cancel</Btn>
  </div>
  </div>
  )}

  {/* Filters */}
  <div className="flex flex-wrap gap-2 mb-4">
  <Input placeholder="Search tenant or property..." value={evSearch} onChange={e => setEvSearch(e.target.value)} className="w-64" />
  <Select filter value={filterStage} onChange={e => setFilterStage(e.target.value)} >
  <option value="all">All Cases</option>
  <option value="active">Active Only</option>
  <option value="closed">Closed Only</option>
  {EVICTION_STAGES.filter(s => s.id !== "closed").map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
  </Select>
  </div>

  {/* Case Detail Panel */}
  {selectedCase && (
  <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
  <div className="bg-white w-full max-w-xl h-full flex flex-col shadow-2xl overflow-y-auto">
  <div className="bg-gradient-to-r from-danger-600 to-danger-800 p-6 text-white">
  <div className="flex items-center justify-between">
  <div>
  <h2 className="text-lg font-bold">{selectedCase.tenant_name}</h2>
  <div className="text-sm opacity-80">{selectedCase.property}</div>
  <div className="text-xs opacity-60 mt-1">{selectedCase.reason?.replace(/_/g, " ")} · {selectedCase.notice_type?.replace(/_/g, " ")}</div>
  </div>
  <button onClick={() => setSelectedCase(null)} className="text-white/70 hover:text-white text-2xl">✕</button>
  </div>
  <div className="grid grid-cols-3 gap-2 mt-4">
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Stage</div><div className="text-sm font-bold capitalize">{selectedCase.current_stage?.replace(/_/g, " ")}</div></div>
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Costs</div><div className="text-sm font-bold">{formatCurrency(selectedCase.total_costs)}</div></div>
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs opacity-70">Status</div><div className="text-sm font-bold capitalize">{selectedCase.status}</div></div>
  </div>
  </div>

  {/* Stage Progress */}
  <div className="px-6 py-4 border-b border-brand-50">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3">Progress</div>
  <div className="flex items-center gap-1">
  {EVICTION_STAGES.map((s, i) => {
  const currentIdx = stageIdx(selectedCase.current_stage);
  const isComplete = i < currentIdx;
  const isCurrent = i === currentIdx;
  return (
  <div key={s.id} className="flex-1">
  <div className={`h-2 rounded-full ${isComplete ? "bg-danger-500" : isCurrent ? "bg-danger-300" : "bg-neutral-100"}`} />
  <div className={`text-center mt-1 text-[10px] ${isCurrent ? "text-danger-600 font-bold" : isComplete ? "text-danger-400" : "text-neutral-300"}`}>{s.label.split(" ")[0]}</div>
  </div>
  );
  })}
  </div>
  </div>

  {/* Key Dates */}
  <div className="px-6 py-4 border-b border-brand-50">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-2">Key Dates</div>
  <div className="grid grid-cols-2 gap-2 text-sm">
  <div><span className="text-neutral-400 text-xs block">Notice Sent</span><span className="font-semibold text-neutral-700">{selectedCase.notice_date || "—"}</span></div>
  <div><span className="text-neutral-400 text-xs block">Cure Deadline</span><span className="font-semibold text-danger-600">{selectedCase.cure_deadline || "—"}</span></div>
  {selectedCase.filing_date && <div><span className="text-neutral-400 text-xs block">Filed</span><span className="font-semibold text-neutral-700">{selectedCase.filing_date}</span></div>}
  {selectedCase.hearing_date && <div><span className="text-neutral-400 text-xs block">Hearing</span><span className="font-semibold text-neutral-700">{selectedCase.hearing_date}</span></div>}
  {selectedCase.judgment_date && <div><span className="text-neutral-400 text-xs block">Judgment</span><span className="font-semibold text-neutral-700">{selectedCase.judgment_date}</span></div>}
  {selectedCase.lockout_date && <div><span className="text-neutral-400 text-xs block">Lockout</span><span className="font-semibold text-neutral-700">{selectedCase.lockout_date}</span></div>}
  </div>
  </div>

  {/* Stage History */}
  <div className="px-6 py-4 border-b border-brand-50">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3">Timeline</div>
  <div className="space-y-3">
  {JSON.parse(selectedCase.stage_history || "[]").slice().reverse().map((h, i) => {
  const stg = EVICTION_STAGES.find(s => s.id === h.stage);
  return (
  <div key={i} className="flex gap-3">
  <div className={`w-8 h-8 rounded-full ${stg?.color || "bg-neutral-400"} flex items-center justify-center shrink-0`}>
  <span className="material-icons-outlined text-white text-sm">{stg?.icon || "info"}</span>
  </div>
  <div className="flex-1">
  <div className="text-sm font-semibold text-neutral-800 capitalize">{h.stage?.replace(/_/g, " ")}</div>
  <div className="text-xs text-neutral-400">{h.date} · {h.by}</div>
  {h.note && <div className="text-xs text-neutral-500 mt-0.5">{h.note}</div>}
  {safeNum(h.cost) > 0 && <div className="text-xs text-danger-500 font-semibold mt-0.5">Cost: {formatCurrency(h.cost)}</div>}
  </div>
  </div>
  );
  })}
  </div>
  </div>

  {/* Generate Legal Notice */}
  <div className="px-6 py-3 border-b border-brand-50 flex gap-2">
  <Btn variant="amber" size="sm" icon="print" onClick={() => generateEvictionNotice(selectedCase)}>Generate Legal Notice</Btn>
  </div>

  {/* Advance Stage */}
  {selectedCase.status === "active" && (
  <div className="px-6 py-4 border-b border-brand-50">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3">Advance to Next Stage</div>
  <div className="space-y-2">
  <div className="grid grid-cols-2 gap-2">
  <div><label className="text-xs text-neutral-400 block mb-1">Date</label><Input type="date" value={stageDate} onChange={e => setStageDate(e.target.value)} /></div>
  <div><label className="text-xs text-neutral-400 block mb-1">Cost ($)</label><Input type="number" value={stageCost} onChange={e => setStageCost(e.target.value)} placeholder="0.00" /></div>
  </div>
  <div><label className="text-xs text-neutral-400 block mb-1">Notes</label><Input value={stageNote} onChange={e => setStageNote(e.target.value)} placeholder="Court case #, attorney notes, details..." /></div>
  <div className="flex gap-2 flex-wrap">
  {EVICTION_STAGES.filter(s => stageIdx(s.id) === stageIdx(selectedCase.current_stage) + 1).map(nextS => (
  <button key={nextS.id} onClick={() => advanceStage(selectedCase, nextS.id)} className={`text-xs text-white px-4 py-2 rounded-lg font-medium ${nextS.color} hover:opacity-90`}>
  <span className="material-icons-outlined text-sm align-middle mr-1">{nextS.icon}</span>{nextS.label}
  </button>
  ))}
  </div>
  </div>
  </div>
  )}

  {/* Actions */}
  <div className="px-6 py-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3">Case Actions</div>
  <div className="flex gap-2 flex-wrap">
  {selectedCase.status === "active" && (
  <>
  <Btn variant="positive" size="sm" onClick={() => closeCase(selectedCase, "tenant_cured")}>Tenant Cured</Btn>
  <Btn variant="info" size="sm" onClick={() => closeCase(selectedCase, "settled")}>Settled / Agreement</Btn>
  <Btn variant="slate" size="sm" onClick={() => closeCase(selectedCase, "dismissed")}>Dismissed</Btn>
  <Btn variant="danger" size="sm" onClick={() => closeCase(selectedCase, "completed")}>Eviction Complete</Btn>
  </>
  )}
  </div>
  </div>

  {selectedCase.notes && (
  <div className="px-6 py-4 border-t border-brand-50">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-2">Case Notes</div>
  <p className="text-sm text-neutral-600">{selectedCase.notes}</p>
  </div>
  )}
  </div>
  </div>
  )}

  {/* Cases List */}
  <div className="space-y-3">
  {filtered.map(c => {
  const currentStage = EVICTION_STAGES.find(s => s.id === c.current_stage);
  const curIdx = stageIdx(c.current_stage);
  const daysActive = Math.ceil((new Date() - new Date(c.created_at)) / 86400000);
  return (
  <div key={c.id} onClick={() => setSelectedCase(c)} className="bg-white rounded-3xl shadow-card border border-brand-50 p-4 cursor-pointer hover:border-danger-200 hover:shadow-md transition-all">
  <div className="flex justify-between items-start">
  <div>
  <div className="flex items-center gap-2 mb-1">
  <span className={`w-6 h-6 rounded-full ${currentStage?.color || "bg-neutral-400"} flex items-center justify-center`}>
  <span className="material-icons-outlined text-white text-xs">{currentStage?.icon || "info"}</span>
  </span>
  <span className="font-semibold text-neutral-800">{c.tenant_name}</span>
  {c.status === "closed" && <span className="text-xs bg-neutral-100 text-neutral-500 px-2 py-0.5 rounded-full">Closed{c.outcome ? ` — ${c.outcome.replace(/_/g, " ")}` : ""}</span>}
  </div>
  <div className="text-xs text-neutral-400">{c.property} · {c.reason?.replace(/_/g, " ")}</div>
  </div>
  <div className="text-right">
  <div className={`text-xs font-semibold capitalize px-2.5 py-1 rounded-full ${c.status === "active" ? "bg-danger-100 text-danger-700" : "bg-neutral-100 text-neutral-500"}`}>{currentStage?.label || c.current_stage}</div>
  <div className="text-xs text-neutral-400 mt-1">{daysActive}d active</div>
  </div>
  </div>
  {/* Mini progress bar */}
  <div className="flex gap-0.5 mt-3">
  {EVICTION_STAGES.map((s, i) => (
  <div key={s.id} className={`h-1.5 flex-1 rounded-full ${i < curIdx ? "bg-danger-400" : i === curIdx ? "bg-danger-200" : "bg-neutral-100"}`} />
  ))}
  </div>
  <div className="flex gap-4 mt-2 text-xs text-neutral-400">
  <span>Notice: {c.notice_date}</span>
  <span>Cure by: {c.cure_deadline}</span>
  {safeNum(c.total_costs) > 0 && <span className="text-danger-500">Costs: {formatCurrency(c.total_costs)}</span>}
  </div>
  </div>
  );
  })}
  {filtered.length === 0 && <div className="text-center py-12 text-neutral-400">No eviction cases{filterStage !== "all" ? " matching filter" : ""}. Click + New Case to start one.</div>}
  </div>
  </div>
  );
}

export { MoveOutWizard, EvictionWorkflow, EVICTION_STAGES };
