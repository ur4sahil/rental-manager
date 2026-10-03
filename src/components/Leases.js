import { COMPANY_DEFAULTS } from "../config";
import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, Checkbox, Input, MoneyInput, PageHeader, Select, Textarea, TextLink, TabBar, EmptyState} from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, formatCurrency, normalizeEmail, escapeHtml, escapeFilterValue, fmtDate, fmtDateTime, canManage } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { printTheme, printTable } from "../utils/theme";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { fileApprovalRequest, terminateLeaseCascade } from "../utils/destructive";
import { queueNotification } from "../utils/notifications";
import { safeLedgerInsert, atomicPostJEAndLedger, autoPostJournalEntry, getPropertyClassId, depositReference, depositAlreadyPosted, tenantOwnArAccountId, depositReleaseState, depositReturnOfferable, planReleaseLegs, releasedDepositStatus, tenantOwedFromGL, fetchAllPaged, syncTenantRecurringAmount, deactivateTenantRecurring } from "../utils/accounting";
import { Badge, StatCard, Spinner, Modal, PropertySelect } from "./shared";
import { StartTenancyModal } from "./StartTenancyModal";
import { TenancyDocuments } from "./TenancyDocuments";
import { LeaseChangeDialog, LeaseChangesCard } from "./LeaseChanges";
import { leaseTermState } from "../utils/leaseChangeRules";

function LeaseManagement({ companySettings = {}, addNotification, userProfile, userRole, companyId, showToast, showConfirm, setPage }) {
  const [leases, setLeases] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("active");
  const [showForm, setShowForm] = useState(false);
  const [editingLease, setEditingLease] = useState(null);
  const [showChecklist, setShowChecklist] = useState(null);
  const [showDepositModal, setShowDepositModal] = useState(null);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [showESign, setShowESign] = useState(null);
  // Same hand-off as the Tenants create path: a new lease queues the shared
  // "Start billing" dialog, which posts the deposit, the first month and the
  // tenant's one rent schedule through startTenancyBooks.
  const [pendingRecurringEntry, setPendingRecurringEntry] = useState(null);

  const defaultChecklist = ["Keys handed over","Smoke detectors tested","Appliances working","Walls condition documented","Floors condition documented","Plumbing checked","Electrical checked","Windows & doors checked","HVAC filter replaced","Photos taken"];
  const defaultMoveOutChecklist = ["Keys returned","All personal items removed","Unit cleaned","Walls patched/repaired","Appliances clean","Carpets cleaned","Final inspection done","Forwarding address collected","Utilities transferred","Security deposit review"];

  const [form, setForm] = useState({
  tenant_id: "", tenant_name: "", property: "", start_date: "", end_date: "",
  rent_amount: "", security_deposit: "", rent_escalation_pct: String(companySettings.rent_escalation_pct || 3),
  escalation_frequency: "annual", payment_due_day: String(companySettings.payment_due_day || 1),
  lease_type: "fixed", auto_renew: false, renewal_notice_days: String(companySettings.renewal_notice_days || 60),
  clauses: "", special_terms: "", template_id: "",
  late_fee_amount: "", late_fee_type: companySettings.late_fee_type || COMPANY_DEFAULTS.late_fee_type, late_fee_grace_days: String(companySettings.late_fee_grace_days || 5),
  });
  const [leaseChangeFor, setLeaseChangeFor] = useState(null);   // { kind: "renewal"|"rent"|"addendum", lease }
  const [templateForm, setTemplateForm] = useState({ name: "", description: "", clauses: "", special_terms: "", default_deposit_months: String(companySettings.default_deposit_months || 1), default_lease_months: String(companySettings.default_lease_months || 12), default_escalation_pct: String(companySettings.rent_escalation_pct || 3), payment_due_day: "1" });
  // Deposit release entries (DEPRET-/DEPDED-, any status) for the company, so
  // "Return Deposit" is not offered for a deposit already released elsewhere.
  const [depositReleases, setDepositReleases] = useState([]);
  const [depositForm, setDepositForm] = useState({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()), mode: "cash" });
  // { loading, leaseId, rel, owed } for the open "Return Deposit" modal.
  const [depositCtx, setDepositCtx] = useState(null);

  useEffect(() => { fetchData(); }, [companyId]);

  async function fetchData() {
  setLoading(true);
  const [l, t, p, tmpl] = await Promise.all([
  supabase.from("leases").select("*").eq("company_id", companyId).order("created_at", { ascending: false }),
  supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("lease_templates").select("*").eq("company_id", companyId).order("name"),
  ]);
  setLeases(l.data || []);
  setTenants(t.data || []);
  setProperties(p.data || []);
  setTemplates(tmpl.data || []);
  const { rows: rel } = await fetchAllPaged(() => supabase.from("acct_journal_entries").select("reference, status, acct_journal_lines(debit)")
    .eq("company_id", companyId).or("reference.like.DEPRET-%,reference.like.DEPDED-%").order("id"), "deposit release entries");
  setDepositReleases((rel || []).map(e => ({ reference: e.reference, status: e.status, amount: (e.acct_journal_lines || []).reduce((t, l) => t + safeNum(l.debit), 0) })));
  setLoading(false);
  }

  function applyTemplate(templateId) {
  const tmpl = templates.find(t => String(t.id) === String(templateId));
  if (!tmpl) return;
  const months = tmpl.default_lease_months || 12;
  const start = form.start_date || formatLocalDate(new Date());
  const endDate = parseLocalDate(start);
  const origDay = endDate.getDate();
  endDate.setMonth(endDate.getMonth() + months);
  // Clamp if month overflow (e.g., Jan 31 + 1 month = Mar 3 → Feb 28)
  if (endDate.getDate() !== origDay) endDate.setDate(0); // setDate(0) = last day of prev month
  setForm({ ...form, template_id: templateId, clauses: tmpl.clauses || "", special_terms: tmpl.special_terms || "", rent_escalation_pct: String(tmpl.default_escalation_pct || 3), payment_due_day: String(tmpl.payment_due_day || 1), end_date: formatLocalDate(endDate) });
  }

  // The tenant is chosen by ID. Picking by name charged the deposit to
  // whichever same-named tenant came first in the list.
  function prefillFromTenant(tenantId) {
  const tenant = tenants.find(t => String(t.id) === String(tenantId));
  if (tenant) setForm(f => ({ ...f, tenant_id: String(tenant.id), tenant_name: tenant.name, property: tenant.property || "", rent_amount: String(tenant.rent || "") }));
  else setForm(f => ({ ...f, tenant_id: "", tenant_name: "" }));
  }

  async function saveLease() {
  if (!guardSubmit("saveLease")) return;
  try {
  const tenant = form.tenant_id ? tenants.find(t => String(t.id) === String(form.tenant_id)) : null;
  if (!form.tenant_name || (!editingLease && !tenant)) { showToast("Please select a tenant.", "error"); return; }
  if (!form.property) { showToast("Please select a property.", "error"); return; }
  if (!form.start_date || !form.end_date) { showToast("Lease start and end dates are required.", "error"); return; }
  if (!form.rent_amount || isNaN(Number(form.rent_amount)) || Number(form.rent_amount) <= 0) { showToast("Please enter a valid positive rent amount.", "error"); return; }
  if (form.start_date >= form.end_date) { showToast("Lease end date must be after start date.", "error"); return; }
  if (Number(form.security_deposit || 0) < 0) { showToast("Security deposit cannot be negative.", "error"); return; }
  if (Number(form.rent_escalation_pct || 0) < 0 || Number(form.rent_escalation_pct || 0) > 25) { showToast("Rent escalation must be between 0% and 25%.", "error"); return; }
  // Prevent duplicate active leases for same tenant+property
  if (!editingLease) {
  const { data: existingActive } = await supabase.from("leases").select("id").eq("company_id", companyId).eq("tenant_name", form.tenant_name).eq("property", form.property).eq("status", "active").limit(1);
  if (existingActive?.length > 0) {
  if (!await showConfirm({ message: "An active lease already exists for " + form.tenant_name + " at " + form.property + ". Creating another will result in double rent charges. Continue?" })) return;
  }
  }
  const payload = {
  tenant_id: tenant?.id || null, tenant_name: form.tenant_name, property: form.property,
  start_date: form.start_date, end_date: form.end_date, rent_amount: Number(form.rent_amount),
  security_deposit: Number(form.security_deposit || 0), rent_escalation_pct: Number(form.rent_escalation_pct || 0),
  escalation_frequency: form.escalation_frequency, payment_due_day: Math.max(1, Math.min(31, Math.floor(Number(form.payment_due_day || 1)))),
  lease_type: form.lease_type, auto_renew: form.auto_renew, renewal_notice_days: Number(form.renewal_notice_days || 60),
  clauses: form.clauses, special_terms: form.special_terms, status: "active",
  late_fee_amount: form.late_fee_amount === "" ? null : Number(form.late_fee_amount), late_fee_type: form.late_fee_amount === "" ? null : (form.late_fee_type || companySettings.late_fee_type || COMPANY_DEFAULTS.late_fee_type), late_fee_grace_days: Number(form.late_fee_grace_days || 5),
  move_in_checklist: JSON.stringify(defaultChecklist.map(item => ({ item, checked: false }))),
  move_out_checklist: JSON.stringify(defaultMoveOutChecklist.map(item => ({ item, checked: false }))),
  created_by: normalizeEmail(userProfile?.email),
  };
  let error;
  if (editingLease) {
  ({ error } = await supabase.from("leases").update({ tenant_name: payload.tenant_name, property: payload.property, start_date: payload.start_date, end_date: payload.end_date, rent_amount: payload.rent_amount, security_deposit: payload.security_deposit, rent_escalation_pct: payload.rent_escalation_pct, escalation_frequency: payload.escalation_frequency, payment_due_day: payload.payment_due_day, lease_type: payload.lease_type, auto_renew: payload.auto_renew, renewal_notice_days: payload.renewal_notice_days, clauses: payload.clauses, special_terms: payload.special_terms, late_fee_amount: payload.late_fee_amount, late_fee_type: payload.late_fee_type, late_fee_grace_days: payload.late_fee_grace_days }).eq("id", editingLease.id).eq("company_id", companyId));
  } else {
  ({ error } = await supabase.from("leases").insert([{ ...payload, company_id: companyId }]));
  if (!error && tenant) {
  const { error: tenantErr } = await supabase.from("tenants").update({ lease_status: "active", move_in: form.start_date, move_out: form.end_date, rent: Number(form.rent_amount) }).eq("company_id", companyId).eq("id", tenant.id);
  if (tenantErr) pmError("PM-3002", { raw: tenantErr, context: "tenant status update", silent: true });
  }
  // The deposit is no longer posted here. It, the first month's rent and the
  // monthly schedule are posted together by the shared engine, from the
  // "Start billing" dialog queued below (see StartTenancyModal).
  }
  if (error) { pmError("PM-3004", { raw: error, context: "save lease" }); return; }
  // Update properties table to reflect lease assignment
  if (!editingLease && tenant) {
  const { error: _err4608 } = await supabase.from("properties").update({ tenant: form.tenant_name, lease_end: form.end_date, status: "occupied" }).eq("company_id", companyId).eq("address", form.property);
  if (_err4608) { showToast("Error updating properties: " + _err4608.message, "error"); return; }
  }
  // (property_id auto-filled by DB trigger from property address)
  // Rent is billed by the tenant's recurring schedule, set up exactly as the
  // Tenants page does it. This used to offer to "post N backdated rent
  // accruals" and then call autoPostRentCharges, a stub that posts nothing --
  // the lease was saved with no rent schedule at all.
  const _queueRecurring = !editingLease && tenant?.id ? { tenantName: form.tenant_name, tenantId: tenant.id, property: form.property, rent: Number(form.rent_amount), deposit: Number(form.security_deposit || 0), leaseStart: form.start_date, leaseEnd: form.end_date } : null;
  logAudit(editingLease ? "update" : "create", "leases", (editingLease ? "Updated" : "Created") + " lease: " + form.tenant_name + " at " + form.property, editingLease?.id || "", userProfile?.email, userRole, companyId);
  // Queue lease notification
  if (!editingLease) {
  const { data: leaseTenant } = tenant ? await supabase.from("tenants").select("email").eq("id", tenant.id).eq("company_id", companyId).maybeSingle() : { data: null };
  if (leaseTenant?.email) queueNotification("lease_created", leaseTenant.email, { tenant: form.tenant_name, property: form.property, startDate: form.start_date, endDate: form.end_date, rent: form.rent_amount }, companyId);
  }
  resetForm(); fetchData();
  if (_queueRecurring) setPendingRecurringEntry(_queueRecurring);
  } finally { guardRelease("saveLease"); }
  }

  function resetForm() {
  setShowForm(false); setEditingLease(null);
  setForm({ tenant_id: "", tenant_name: "", property: "", start_date: "", end_date: "", rent_amount: "", security_deposit: "", rent_escalation_pct: String(companySettings.rent_escalation_pct || 3), escalation_frequency: "annual", payment_due_day: String(companySettings.payment_due_day || 1), lease_type: "fixed", auto_renew: false, renewal_notice_days: String(companySettings.renewal_notice_days || 60), clauses: "", special_terms: "", template_id: "", late_fee_amount: String(companySettings.late_fee_amount ?? COMPANY_DEFAULTS.late_fee_amount), late_fee_type: companySettings.late_fee_type || COMPANY_DEFAULTS.late_fee_type, late_fee_grace_days: String(companySettings.late_fee_grace_days || 5) });
  }

  function startEdit(lease) {
  setEditingLease(lease);
  // Legacy leases carry no tenant_id: pre-select the tenant only when the
  // name AND property identify exactly one.
  const byNameProp = tenants.filter(t => t.name === lease.tenant_name && t.property === lease.property);
  const editTenantId = lease.tenant_id ? String(lease.tenant_id) : (byNameProp.length === 1 ? String(byNameProp[0].id) : "");
  setForm({ tenant_id: editTenantId, tenant_name: lease.tenant_name, property: lease.property, start_date: lease.start_date, end_date: lease.end_date, rent_amount: String(lease.rent_amount), security_deposit: String(lease.security_deposit || 0), rent_escalation_pct: String(lease.rent_escalation_pct || 0), escalation_frequency: lease.escalation_frequency || "annual", payment_due_day: String(lease.payment_due_day || 1), lease_type: lease.lease_type || "fixed", auto_renew: lease.auto_renew || false, renewal_notice_days: String(lease.renewal_notice_days || 60), clauses: lease.clauses || "", special_terms: lease.special_terms || "", template_id: "", late_fee_amount: lease.late_fee_amount == null ? "" : String(lease.late_fee_amount), late_fee_type: lease.late_fee_type || "flat", late_fee_grace_days: String(lease.late_fee_grace_days || 5) });
  setShowForm(true);
  }

  // Renew and Rent Increase used to change the lease the moment they were
  // pressed (the renewal raised the rent today for a term starting months
  // away; the increase ignored its own effective date) and neither produced
  // a document. Both, and addenda, now go through LeaseChangeDialog: written
  // up, signed where it has to be, and in effect on its date.
  const tenantOfLease = (l) => tenants.find(t => String(t.id) === String(l.tenant_id)) || { id: l.tenant_id, name: l.tenant_name, co_tenants: [] };

  async function terminateLease(lease) {
  // Termination is a management-tier action (the database enforces it).
  // Other staff file a request; the approving manager runs the same
  // terminateLeaseCascade from the Properties approval queue.
  if (!canManage(userRole)) {
  if (!await showConfirm({ message: "Ask a manager to terminate the lease for " + lease.tenant_name + "?", confirmText: "Send request" })) return;
  const r = await fileApprovalRequest({ companyId, requestType: "terminate_lease", targetId: lease.id, tenantId: lease.tenant_id || null,
    address: lease.property || "", tenant: lease.tenant_name || "", notes: "Terminate lease: " + lease.tenant_name, userEmail: userProfile?.email });
  if (r.duplicate) { showToast("A termination request for " + lease.tenant_name + " is already waiting for approval.", "info"); return; }
  if (!r.ok) { showToast("Could not file the request: " + (r.error?.message || "unknown error"), "error"); return; }
  showToast("Termination request sent for approval.", "success");
  return;
  }
  if (!await showConfirm({ message: "Terminate lease for " + lease.tenant_name + "? This cannot be undone." })) return;
  const r = await terminateLeaseCascade({ companyId, lease, userProfile, userRole });
  if (!r.ok) { showToast("Error " + r.step + ": " + (r.error?.message || "unknown error"), "error"); return; }
  if (r.warning) showToast(r.warning, "error");
  fetchData();
  }

  // move_in_checklist / move_out_checklist are jsonb columns that saveLease
  // fills with a JSON *string*, while the column default and any row
  // written server-side hold a real array. Accept either shape — reading
  // an array with JSON.parse threw, and the catch left the checklist empty,
  // so those leases showed a checklist with no items at all.
  function parseChecklist(raw) {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse move checklist JSON", silent: true }); return []; }
  }

  async function toggleChecklistItem(lease, type, index) {
  const field = type === "in" ? "move_in_checklist" : "move_out_checklist";
  const checklist = parseChecklist(lease[field]);
  if (checklist[index]) checklist[index].checked = !checklist[index].checked;
  const allDone = checklist.length > 0 && checklist.every(c => c.checked);
  const update = { [field]: JSON.stringify(checklist) };
  if (type === "in") update.move_in_completed = allDone;
  if (type === "out") update.move_out_completed = allDone;
  // update only contains checklist field + completion flag — safe
  const { error: _err4690 } = await supabase.from("leases").update(update).eq("id", lease.id).eq("company_id", companyId);
  if (_err4690) { showToast("Error updating leases: " + _err4690.message, "error"); return; }
  fetchData();
  }

  // Open "Return Deposit": read what is still held and what the tenant owes,
  // fresh from the database, so the modal can warn before anything posts.
  async function openDepositModal(l) {
  setShowDepositModal(l);
  setDepositForm({ amount_returned: String(l.security_deposit), deductions: "", return_date: formatLocalDate(new Date()), mode: "cash" });
  setDepositCtx({ loading: true, leaseId: l.id });
  const [rel, owed] = await Promise.all([
    depositReleaseState(companyId, { tenantId: l.tenant_id, leaseId: l.id }),
    l.tenant_id ? tenantOwedFromGL(companyId, l.tenant_id) : Promise.resolve(null),
  ]);
  setDepositCtx({ loading: false, leaseId: l.id, rel, owed });
  if (rel?.partial) setDepositForm(f => ({ ...f, amount_returned: String(rel.remaining) }));
  }

  async function processDepositReturn(lease) {
  if (!guardSubmit("processDepositReturn", lease.id)) return;
  try {
  // A deposit leaves 2100 once. depositReleaseState reads the lease and its
  // renewal chain afresh and looks for a release from ANY path -- keyed
  // (DEPRET-/DEPDED-<key>), legacy random references at this property, or a
  // released status. A voided release does not count; a voided LEG frees only
  // that leg's amount. It fails closed.
  const rel = await depositReleaseState(companyId, { tenantId: lease.tenant_id, leaseId: lease.id });
  if (rel.released) {
  showToast("This deposit cannot be returned again: " + rel.reason + ".", "error");
  setShowDepositModal(null); fetchData(); return;
  }
  // Owner decision: refunding cash to a tenant who still owes money gets a
  // (non-blocking) warning with the option to apply the deposit instead.
  // Re-read the balance now; if it changed since the modal opened, show it
  // and let the user choose before anything posts.
  const owed = lease.tenant_id ? await tenantOwedFromGL(companyId, lease.tenant_id) : null;
  if (depositForm.mode !== "apply" && safeNum(owed) > 0.005 && !(depositCtx?.leaseId === lease.id && safeNum(depositCtx?.owed) > 0.005)) {
  setDepositCtx({ loading: false, leaseId: lease.id, rel, owed });
  showToast("This tenant still owes " + formatCurrency(owed) + ". You can apply the deposit to that balance instead — choose, then press Process Return again.", "warning");
  return;
  }
  await _processDepositReturn(lease, rel);
  } finally { guardRelease("processDepositReturn", lease.id); }
  }

  async function _processDepositReturn(lease, rel) {
  const apply = depositForm.mode === "apply";
  const returned = Math.round(Number(depositForm.amount_returned || 0) * 100) / 100;
  const fullDeposit = safeNum(lease.security_deposit);
  // What is still held: the whole deposit, or -- when one leg of an earlier
  // split release was voided -- only that leg's amount.
  const held = safeNum(rel.remaining);
  const deducted = Math.round((held - returned) * 100) / 100;
  if (returned < 0) { showToast("Amounts cannot be negative.", "error"); return; }
  if (deducted < 0) { showToast("The amount returned cannot exceed the " + formatCurrency(held) + " still held.", "error"); return; }
  if (!depositForm.return_date) { showToast("Return date is required.", "error"); return; }
  if (apply && returned > 0 && !lease.tenant_id) { showToast("This lease has no tenant record, so the deposit cannot be applied to a balance. Refund it instead.", "error"); return; }
  // Each leg gets one of this deposit's free references; the first takes the
  // claim DEPRET-<key>, so the unique index refuses any concurrent release.
  const plan = planReleaseLegs({ returned, deducted, freeReferences: rel.freeReferences });
  if (plan.error) { showToast("Deposit not released: " + plan.error + ".", "error"); return; }
  try {
  const classId = await getPropertyClassId(lease.property, companyId);
  const arId = apply && returned > 0 ? await tenantOwnArAccountId(companyId, lease.tenant_name, lease.tenant_id) : null;
  if (apply && returned > 0 && !arId) { showToast("Deposit not applied: this tenant's receivable account could not be found.", "error"); return; }
  const posted = [];
  for (const leg of plan.legs) {
  let res;
  if (leg.kind === "return" && apply) {
  // Same shape as move-out: DR 2100 / CR the tenant's own AR. The balance
  // trigger recomputes tenants.balance from that AR, so no balanceUpdate.
  res = await atomicPostJEAndLedger({ companyId, date: depositForm.return_date, description: "Deposit applied to balance — " + lease.tenant_name, reference: leg.reference, property: lease.property,
  lines: [
  { account_id: "2100", account_name: "Security Deposits Held", debit: leg.amount, credit: 0, class_id: classId, memo: "Deposit applied to balance — " + lease.tenant_name },
  { account_id: arId, account_name: "AR - " + lease.tenant_name, debit: 0, credit: leg.amount, class_id: classId, memo: "Deposit credit — applied to balance" },
  ],
  ledgerEntry: { tenant: lease.tenant_name, tenant_id: lease.tenant_id, property: lease.property, date: depositForm.return_date, description: "Deposit applied to balance", amount: -leg.amount, type: "credit" }
  });
  } else if (leg.kind === "return") {
  res = await atomicPostJEAndLedger({ companyId, date: depositForm.return_date, description: "Security deposit return — " + lease.tenant_name, reference: leg.reference, property: lease.property,
  lines: [
  { account_id: "2100", account_name: "Security Deposits Held", debit: leg.amount, credit: 0, class_id: classId, memo: "Return to " + lease.tenant_name },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: leg.amount, class_id: classId, memo: "Deposit refund" },
  ],
  ledgerEntry: lease.tenant_id ? { tenant: lease.tenant_name, tenant_id: lease.tenant_id, property: lease.property, date: depositForm.return_date, description: "Security deposit returned", amount: leg.amount, type: "deposit_return" } : null
  });
  } else {
  res = await atomicPostJEAndLedger({ companyId, date: depositForm.return_date, description: "Deposit deduction — " + lease.tenant_name + " — " + depositForm.deductions, reference: leg.reference, property: lease.property,
  lines: [
  { account_id: "2100", account_name: "Security Deposits Held", debit: leg.amount, credit: 0, class_id: classId, memo: "Deduction: " + depositForm.deductions },
  { account_id: "4150", account_name: "Deposit Forfeiture Income", debit: 0, credit: leg.amount, class_id: classId, memo: "Deposit forfeiture: " + lease.tenant_name },
  ],
  ledgerEntry: lease.tenant_id ? { tenant: lease.tenant_name, tenant_id: lease.tenant_id, property: lease.property, date: depositForm.return_date, description: "Deposit deduction: " + depositForm.deductions, amount: leg.amount, type: "deposit_deduction" } : null
  });
  }
  if (!res?.jeId) {
  if (!posted.length) {
  // Nothing was released (a duplicate claim is refused here too).
  showToast("Deposit was not released — it may already have been released elsewhere. Please check the accounting module.", "error");
  setShowDepositModal(null); fetchData(); return;
  }
  showToast("The " + (leg.kind === "deduction" ? "deduction" : "return") + " of " + formatCurrency(leg.amount) + " was not posted. The lease stays “held” with " + formatCurrency(leg.amount) + " still held — process the rest again.", "error");
  break;
  }
  posted.push(leg);
  }
  // Mark the lease only for what is on the books. If a leg failed, the lease
  // stays "held" (the remainder is still held) and records what was returned.
  const returnedNow = posted.filter(l => l.kind === "return").reduce((t, l) => t + l.amount, 0);
  const deductedNow = posted.filter(l => l.kind === "deduction").reduce((t, l) => t + l.amount, 0);
  const priorReturned = safeNum(rel.liveReturned);
  const complete = posted.length === plan.legs.length;
  const upd = { deposit_returned: Math.round((priorReturned + returnedNow) * 100) / 100, deposit_return_date: depositForm.return_date, deposit_deductions: depositForm.deductions };
  if (complete) upd.deposit_status = releasedDepositStatus({ deposit: fullDeposit, priorReturned, returnedNow });
  const { error: depErr } = await supabase.from("leases").update(upd).eq("company_id", companyId).eq("id", lease.id);
  if (depErr) showToast("Deposit posted, but the lease record could not be updated: " + depErr.message, "error");
  logAudit("update", "leases", "Deposit " + (apply ? "applied to balance" : "return") + ": $" + returnedNow + " to " + lease.tenant_name + (deductedNow ? ", $" + deductedNow + " deducted" : ""), lease.id, userProfile?.email, userRole, companyId);
  // Queue deposit return notification
  const { data: depTenant } = lease.tenant_id ? await supabase.from("tenants").select("email").eq("id", lease.tenant_id).eq("company_id", companyId).maybeSingle() : { data: null };
  if (depTenant?.email) queueNotification("deposit_returned", depTenant.email, { tenant: lease.tenant_name, returned: returnedNow, deducted: deductedNow, property: lease.property }, companyId);
  setShowDepositModal(null); setDepositCtx(null); setDepositForm({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()), mode: "cash" });
  fetchData();
  } catch (e) {
  showToast("Deposit return failed: " + e.message, "error");
  setShowDepositModal(null); setDepositCtx(null); setDepositForm({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()), mode: "cash" });
  }
  }

  async function saveTemplate() {
  if (!guardSubmit("saveTemplate")) return;
  try {
  if (!templateForm.name) { showToast("Template name is required.", "error"); return; }
  const { error } = await supabase.from("lease_templates").insert([{ ...templateForm, default_deposit_months: Number(templateForm.default_deposit_months || 1), default_lease_months: Number(templateForm.default_lease_months || 12), default_escalation_pct: Number(templateForm.default_escalation_pct || 3), payment_due_day: Math.max(1, Math.min(31, Number(templateForm.payment_due_day || 1))), company_id: companyId }]);
  if (error) { pmError("PM-3004", { raw: error, context: "save lease template" }); return; }
  setShowTemplateForm(false); setTemplateForm({ name: "", description: "", clauses: "", special_terms: "", default_deposit_months: String(companySettings.default_deposit_months || 1), default_lease_months: String(companySettings.default_lease_months || 12), default_escalation_pct: String(companySettings.rent_escalation_pct || 3), payment_due_day: String(companySettings.payment_due_day || 1) });
  fetchData();
  } finally { guardRelease("saveTemplate"); }
  }

  if (loading) return <Spinner />;

  const today = formatLocalDate(new Date());
  const active = leases.filter(l => l.status === "active");
  const expiringSoon = active.filter(l => { const d = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000); return d <= 90 && d > 0; });
  const expired = leases.filter(l => l.status === "expired" || (l.status === "active" && l.end_date < today));
  const totalDeposits = active.reduce((s, l) => s + safeNum(l.security_deposit), 0);
  const filteredLeases = activeTab === "active" ? active : activeTab === "expiring" ? expiringSoon : activeTab === "expired" ? expired : activeTab === "all" ? leases : leases.filter(l => l.status === activeTab);

  return (
  <div>
  <div className="flex justify-between items-center mb-5">
  <PageHeader title="Lease Management" />
  <div className="flex gap-2">
  <Btn variant="secondary" size="xs" onClick={() => setShowTemplateForm(true)}>Manage Templates</Btn>
  <Btn onClick={() => { resetForm(); setShowForm(true); }}>+ New Lease</Btn>
  </div>
  </div>

  <div className="grid grid-cols-2 gap-3 mb-5 md:grid-cols-4">
  <StatCard label="Active Leases" value={active.length} color="text-positive-600" sub="current" />
  <StatCard label="Expiring (90d)" value={expiringSoon.length} color={expiringSoon.length > 0 ? "text-warn-600" : "text-neutral-400"} sub="need attention" />
  <StatCard label="Total Deposits" value={"$" + totalDeposits.toLocaleString()} color="text-highlight-600" sub="held" />
  <StatCard label="Avg Rent" value={"$" + (active.length > 0 ? Math.round(active.reduce((s, l) => s + safeNum(l.rent_amount), 0) / active.length) : 0)} color="text-info-600" sub="per lease" />
  </div>

  {expiringSoon.length > 0 && (
  <div className="bg-warn-50 border border-warn-200 rounded-xl p-3 mb-4">
  <div className="font-semibold text-warn-800 text-sm mb-2">Leases Expiring Soon</div>
  {/* Each row stacks on a phone: side by side, the name wrapped into the day count. */}
  {expiringSoon.map(l => { const d = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000); return (
  <div key={l.id} className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1 sm:gap-3 py-1.5 text-sm">
  <span className="text-warn-700 min-w-0">{l.tenant_name} — {l.property}</span>
  <div className="flex items-center gap-2 flex-wrap shrink-0"><span className="text-warn-600 font-bold whitespace-nowrap">{d} days</span><Btn variant="secondary" size="xs" onClick={() => startEdit(l)}>Edit</Btn><Btn variant="warning-fill" size="xs" onClick={() => setLeaseChangeFor({ kind: "renewal", lease: l })}>Renew</Btn><Btn variant="danger" size="xs" onClick={() => terminateLease(l)}>{canManage(userRole) ? "Terminate" : "Request termination"}</Btn></div>
  </div>
  ); })}
  </div>
  )}

  <div className="flex gap-1 mb-4 border-b border-brand-50 overflow-x-auto">
  <TabBar size="sm" active={activeTab} onChange={setActiveTab} tabs={[
    { id: "active", label: "Active" },
    { id: "expiring", label: "Expiring", count: expiringSoon.length || null },
    { id: "expired", label: "Expired" },
    { id: "renewed", label: "Renewed" },
    { id: "terminated", label: "Terminated" },
    { id: "all", label: "All" },
  ]} />
  </div>

  {showTemplateForm && (
  <Modal title="Lease Template" onClose={() => setShowTemplateForm(false)}>
  <div className="space-y-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Template Name *</label><Input placeholder="Standard 12-Month Lease" value={templateForm.name} onChange={e => setTemplateForm({...templateForm, name: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Description</label><Input placeholder="Default template for residential leases" value={templateForm.description} onChange={e => setTemplateForm({...templateForm, description: e.target.value})} /></div>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs text-neutral-400">Lease Length (months)</label><Input type="number" min="1" max="120" placeholder="12" value={templateForm.default_lease_months} onChange={e => setTemplateForm({...templateForm, default_lease_months: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400">Annual Escalation %</label><Input type="number" step="0.1" min="0" max="25" placeholder="3.0" value={templateForm.default_escalation_pct} onChange={e => setTemplateForm({...templateForm, default_escalation_pct: e.target.value})} /></div>
  </div>
  <Textarea placeholder="Standard clauses..." value={templateForm.clauses} onChange={e => setTemplateForm({...templateForm, clauses: e.target.value})}  rows={4} />
  <Textarea placeholder="Special terms..." value={templateForm.special_terms} onChange={e => setTemplateForm({...templateForm, special_terms: e.target.value})}  rows={3} />
  <Btn onClick={saveTemplate}>Save Template</Btn>
  </div>
  </Modal>
  )}

  {showESign && <ESignatureModal lease={showESign} onClose={() => setShowESign(null)} onSigned={() => fetchData()} companyId={companyId} showToast={showToast} showConfirm={showConfirm} setPage={setPage} userEmail={userProfile?.email || ""} userRole={userRole} />}

  {showDepositModal && (
  <Modal title={"Return Deposit — " + showDepositModal.tenant_name} onClose={() => { setShowDepositModal(null); setDepositCtx(null); }}>
  <div className="space-y-3">
  <div className="bg-highlight-50 rounded-lg p-3 text-sm"><div className="flex justify-between"><span className="text-neutral-400">Original Deposit:</span><span className="font-bold">${safeNum(showDepositModal.security_deposit).toLocaleString()}</span></div>
  {depositCtx?.rel?.partial && <div className="flex justify-between mt-1"><span className="text-neutral-400">Still held:</span><span className="font-bold">{formatCurrency(depositCtx.rel.remaining)}</span></div>}</div>
  {depositCtx?.loading && <div className="text-xs text-neutral-400">Checking the tenant's balance…</div>}
  {depositCtx?.rel?.partial && <div className="bg-warn-50 rounded-lg p-2 text-xs text-warn-700">{depositCtx.rel.reason}.</div>}
  {depositCtx?.rel?.released && <div className="bg-danger-50 rounded-lg p-2 text-xs text-danger-700">This deposit cannot be returned again: {depositCtx.rel.reason}.</div>}
  {safeNum(depositCtx?.owed) > 0.005 && (
  <div className="bg-warn-50 rounded-lg p-3 text-xs text-warn-700 space-y-2">
  <div>This tenant still owes <span className="font-bold">{formatCurrency(depositCtx.owed)}</span>. You can apply the deposit to that balance instead of refunding cash.</div>
  <div className="flex gap-2">
  <Btn size="xs" variant={depositForm.mode === "apply" ? "purple" : "secondary"} onClick={() => setDepositForm({ ...depositForm, mode: "apply" })}>Apply to balance</Btn>
  <Btn size="xs" variant={depositForm.mode !== "apply" ? "purple" : "secondary"} onClick={() => setDepositForm({ ...depositForm, mode: "cash" })}>Refund cash anyway</Btn>
  </div>
  </div>
  )}
  <div><label className="text-xs text-neutral-400">{depositForm.mode === "apply" ? "Amount to Apply to Balance ($)" : "Amount to Return ($)"}</label><MoneyInput value={depositForm.amount_returned} onChange={v => setDepositForm({...depositForm, amount_returned: v})} placeholder={String(showDepositModal.security_deposit)} /></div>
  <div><label className="text-xs text-neutral-400">Deduction Reasons</label><Textarea value={depositForm.deductions} onChange={e => setDepositForm({...depositForm, deductions: e.target.value})} placeholder="Cleaning, damages, unpaid rent..." className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm" rows={3} /></div>
  <div><label className="text-xs text-neutral-400">Return Date</label><Input type="date" value={depositForm.return_date} onChange={e => setDepositForm({...depositForm, return_date: e.target.value})} /></div>
  {Number(depositForm.amount_returned || 0) < safeNum(depositCtx?.rel?.partial ? depositCtx.rel.remaining : showDepositModal.security_deposit) && depositForm.amount_returned && (
  <div className="bg-danger-50 rounded-lg p-2 text-xs text-danger-700">Deducting ${(safeNum(depositCtx?.rel?.partial ? depositCtx.rel.remaining : showDepositModal.security_deposit) - Number(depositForm.amount_returned)).toLocaleString()} from deposit</div>
  )}
  <Btn variant="purple" onClick={() => processDepositReturn(showDepositModal)}>Process Return</Btn>
  </div>
  </Modal>
  )}

  {showChecklist && (() => {
  // showChecklist holds the lease as it was when the modal opened.
  // toggleChecklistItem writes and then calls fetchData(), which refreshes
  // `leases` but NOT this snapshot — so every tick was computed from the
  // original array. Ticking a second item silently un-ticked the first,
  // no checkmark ever appeared, and move_in/out_completed could never go
  // true. Re-resolve the lease from state on each render instead.
  const live = leases.find(l => l.id === showChecklist.lease.id) || showChecklist.lease;
  const items = parseChecklist(live[showChecklist.type === "in" ? "move_in_checklist" : "move_out_checklist"]);
  return (
  <Modal title={(showChecklist.type === "in" ? "Move-In" : "Move-Out") + " Checklist — " + live.tenant_name} onClose={() => setShowChecklist(null)}>
  <div className="space-y-2">
  {items.map((item, i) => (
  <div key={i} onClick={() => toggleChecklistItem(live, showChecklist.type, i)} className={"flex items-center gap-3 p-2 rounded-lg cursor-pointer border " + (item.checked ? "bg-positive-50 border-positive-200" : "bg-white border-subtle-100 hover:bg-brand-50/30")}>
  <span className={"w-5 h-5 rounded border flex items-center justify-center text-xs " + (item.checked ? "bg-positive-500 border-positive-500 text-white" : "border-brand-200")}>{item.checked ? "✓" : ""}</span>
  <span className={"text-sm " + (item.checked ? "line-through text-neutral-400" : "text-neutral-700")}>{item.item}</span>
  </div>
  ))}
  {items.length === 0 && <EmptyState size="inline" title={"No checklist items on this lease."} />}
  </div>
  </Modal>
  );
  })()}

  {showForm && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-5">
  <h3 className="font-display font-semibold text-neutral-800 mb-4">{editingLease ? "Edit Lease" : "Create New Lease"}</h3>
  {!editingLease && templates.length > 0 && (
  <div className="mb-4"><label className="text-xs text-neutral-400 mb-1 block">Apply Template</label>
  <Select value={form.template_id} onChange={e => { setForm({...form, template_id: e.target.value}); applyTemplate(e.target.value); }} >
  <option value="">Select template...</option>
  {templates.map(t => <option key={t.id} value={t.id}>{t.name} — {t.description}</option>)}
  </Select>
  </div>
  )}
  <div className="grid grid-cols-2 gap-3 mb-4">
  <div><label className="text-xs text-neutral-400 mb-1 block">Tenant *</label>
  <Select value={form.tenant_id} onChange={e => prefillFromTenant(e.target.value)} >
  <option value="">{editingLease && !form.tenant_id && form.tenant_name ? form.tenant_name : "Select tenant..."}</option>
  {tenants.map(t => <option key={t.id} value={String(t.id)}>{t.name}{t.property ? " — " + t.property : ""}</option>)}
  </Select>
  </div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({...form, property: v})} companyId={companyId} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Lease Start *</label><Input type="date" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Lease End *</label><Input type="date" value={form.end_date} onChange={e => setForm({...form, end_date: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Monthly Rent ($) *</label><MoneyInput min="0" placeholder="1500.00" value={form.rent_amount} onChange={v => setForm({...form, rent_amount: v})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Security Deposit ($)</label><MoneyInput min="0" placeholder="1500.00" value={form.security_deposit} onChange={v => setForm({...form, security_deposit: v})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Annual Escalation %</label><Input type="number" step="0.1" min="0" max="25" placeholder="3.0" value={form.rent_escalation_pct} onChange={e => setForm({...form, rent_escalation_pct: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Payment Due Day</label><Input type="number" min="1" max="31" placeholder="1" value={form.payment_due_day} onChange={e => setForm({...form, payment_due_day: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Lease Type</label>
  <Select value={form.lease_type} onChange={e => setForm({...form, lease_type: e.target.value})} ><option value="fixed">Fixed Term</option><option value="month_to_month">Month-to-Month</option><option value="renewal">Renewal</option></Select></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Renewal Notice (days)</label><Input type="number" min="0" max="180" placeholder="60" value={form.renewal_notice_days} onChange={e => setForm({...form, renewal_notice_days: e.target.value})} /></div>
  </div>
  {/* Late Fee Settings */}
  <div className="bg-warn-50 border border-warn-200 rounded-xl p-3 mb-4">
  <div className="text-sm font-semibold text-warn-800 mb-2">⚠️ Late Fee Settings</div>
  <div className="grid grid-cols-3 gap-3">
  <div><label className="text-xs text-neutral-400 mb-1 block">Grace Period (days)</label><Input type="number" min="0" max="30" placeholder="5" value={form.late_fee_grace_days} onChange={e => setForm({...form, late_fee_grace_days: e.target.value})} className="border-warn-200 bg-white" /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Fee Type</label><Select value={form.late_fee_type} onChange={e => setForm({...form, late_fee_type: e.target.value})} className="border-warn-200 bg-white"><option value="flat">Flat ($)</option><option value="percent">Percent (%)</option></Select></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">{form.late_fee_type === "flat" ? "Fee Amount ($)" : "Fee Percentage (%)"}</label><MoneyInput min="0" placeholder="50.00" value={form.late_fee_amount} onChange={v => setForm({...form, late_fee_amount: v})} className="border-warn-200 bg-white" /></div>
  </div>
  <p className="text-xs text-warn-600 mt-2">Leave blank to use the company default from Settings ({companySettings.late_fee_type === "flat" ? formatCurrency(companySettings.late_fee_amount) : (companySettings.late_fee_amount ?? COMPANY_DEFAULTS.late_fee_amount) + "% of rent"}). Late fees are charged from the tenant's ledger with the "Apply Late Fee" button, never automatically.</p>
  </div>
  <div className="flex items-center gap-2 mb-4"><Checkbox checked={form.auto_renew} onChange={e => setForm({...form, auto_renew: e.target.checked})} className="rounded" /><label className="text-sm text-neutral-500">Auto-renew at end of term</label></div>
  <div className="mb-3"><label className="text-xs text-neutral-400 mb-1 block">Lease Clauses</label><Textarea value={form.clauses} onChange={e => setForm({...form, clauses: e.target.value})} className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm" rows={3} placeholder="Standard clauses..." /></div>
  <div className="mb-4"><label className="text-xs text-neutral-400 mb-1 block">Special Terms</label><Textarea value={form.special_terms} onChange={e => setForm({...form, special_terms: e.target.value})} className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm" rows={2} placeholder="Pet deposit, parking, storage..." /></div>
  <div className="flex gap-2">
  <Btn onClick={saveLease}>{editingLease ? "Update Lease" : "Create Lease"}</Btn>
  <Btn variant="ghost" onClick={resetForm}>Cancel</Btn>
  </div>
  </div>
  )}

  <div className="space-y-3">
  {filteredLeases.map(l => {
  const daysLeft = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000);
  const isExpired = daysLeft <= 0 && l.status === "active";
  const sc = { active: "bg-positive-100 text-positive-700", expired: "bg-danger-100 text-danger-700", renewed: "bg-info-100 text-info-700", terminated: "bg-neutral-100 text-neutral-500", draft: "bg-warn-100 text-warn-700" };
  const dc = { held: "bg-highlight-100 text-highlight-700", partial_return: "bg-warn-100 text-warn-700", returned: "bg-positive-100 text-positive-700", forfeited: "bg-danger-100 text-danger-700" };
  return (
  <div key={l.id} className={"bg-white rounded-xl border shadow-card p-4 " + (isExpired ? "border-danger-200" : "border-brand-50")}>
  <div className="flex justify-between items-start mb-3">
  <div><div className="text-sm font-bold text-neutral-800">{l.tenant_name}</div><div className="text-xs text-neutral-400">{l.property}</div></div>
  <div className="flex items-center gap-2">
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[isExpired ? "expired" : l.status] || "bg-neutral-100")}>{isExpired ? "EXPIRED" : l.status}</span>
  {l.lease_type === "renewal" && <span className="px-2 py-0.5 rounded-full text-xs bg-info-50 text-info-600">Renewal</span>}
  </div>
  </div>
  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3 md:grid-cols-4">
  <div><span className="text-neutral-400">Term:</span> <span className="font-medium">{fmtDate(l.start_date)} to {fmtDate(l.end_date)}</span></div>
  <div><span className="text-neutral-400">Rent:</span> <span className="font-bold text-neutral-800">${safeNum(l.rent_amount).toLocaleString()}/mo</span></div>
  <div><span className="text-neutral-400">Deposit:</span> <span className="font-medium">${safeNum(l.security_deposit).toLocaleString()}</span>{l.security_deposit > 0 && <span className={"ml-1 px-1 py-0.5 rounded text-xs " + (dc[l.deposit_status] || "")}>{l.deposit_status}</span>}</div>
  <div><span className="text-neutral-400">Escalation:</span> <span className="font-medium">{l.rent_escalation_pct || 0}%/yr</span></div>
  {l.status === "active" && <div><span className="text-neutral-400">Days Left:</span> <span className={"font-bold " + (daysLeft <= 30 ? "text-danger-600" : daysLeft <= 90 ? "text-warn-600" : "text-positive-600")}>{daysLeft}</span></div>}
  <div><span className="text-neutral-400">Due Day:</span> <span className="font-medium">{l.payment_due_day || 1}th</span></div>
  <div><span className="text-neutral-400">Type:</span> <span className="font-medium capitalize">{(l.lease_type || "fixed").replace("_"," ")}</span></div>
  <div><span className="text-neutral-400">Auto-Renew:</span> <span className="font-medium">{l.auto_renew ? "Yes" : "No"}</span></div>
  {/* A lease that is not renewed carries on month to month: said plainly,
      not flagged as expired. */}
  {l.status === "active" && leaseTermState(l, formatLocalDate(new Date())).key === "month_to_month" && <div><span className="text-neutral-400">Term:</span> <span className="font-medium">Month-to-month since {fmtDate(l.end_date)}</span></div>}
  </div>
  <div className="flex flex-wrap gap-2 pt-2 border-t border-brand-50/50">
  <Btn variant="secondary" size="xs" onClick={() => startEdit(l)}>Edit</Btn>
  <Btn variant={l.signature_status === "fully_signed" ? "positive" : "purple"} size="xs" onClick={() => setShowESign(l)}>{l.signature_status === "fully_signed" ? "✓ Signed" : ["pending", "partially_signed"].includes(l.signature_status) ? "Out for signature" : "Lease document"}</Btn>
  {l.status === "active" && <Btn variant="success-fill" size="xs" onClick={() => setLeaseChangeFor({ kind: "renewal", lease: l })}>Renew</Btn>}
  {l.status === "active" && <Btn variant="secondary" size="xs" onClick={() => setLeaseChangeFor({ kind: "rent", lease: l })}>Change rent</Btn>}
  {l.status === "active" && <Btn variant="secondary" size="xs" onClick={() => setLeaseChangeFor({ kind: "addendum", lease: l })}>Addendum</Btn>}
  {l.status === "active" && <Btn variant="danger" size="xs" onClick={() => terminateLease(l)}>{canManage(userRole) ? "Terminate" : "Request termination"}</Btn>}
  <Btn variant={l.move_in_completed ? "positive" : "secondary"} size="xs" onClick={() => setShowChecklist({ lease: l, type: "in" })}>Move-In {l.move_in_completed ? "✓" : ""}</Btn>
  <Btn variant={l.move_out_completed ? "positive" : "secondary"} size="xs" onClick={() => setShowChecklist({ lease: l, type: "out" })}>Move-Out {l.move_out_completed ? "✓" : ""}</Btn>
  {safeNum(l.security_deposit) > 0 && depositReturnOfferable(l, depositReleases) && (l.status === "terminated" || l.status === "expired" || isExpired) && (
  <Btn variant="purple" size="xs" onClick={() => openDepositModal(l)}>Return Deposit</Btn>
  )}
  </div>
  </div>
  );
  })}
  {filteredLeases.length === 0 && <EmptyState size="inline" title={"No leases found"} />}
  </div>

  {pendingRecurringEntry && <StartTenancyModal entry={pendingRecurringEntry} companyId={companyId} userEmail={userProfile?.email || ""} showToast={showToast} onComplete={() => { setPendingRecurringEntry(null); fetchData(); }} />}

  {/* Rent Increase Modal */}
  {leaseChangeFor && (
    <LeaseChangeDialog kind={leaseChangeFor.kind} lease={leaseChangeFor.lease} tenant={tenantOfLease(leaseChangeFor.lease)}
      companyId={companyId} companySettings={companySettings} userEmail={userProfile?.email || ""} userRole={userRole}
      setPage={setPage} returnTo={{ page: "leases" }} showToast={showToast}
      onClose={() => setLeaseChangeFor(null)} onSaved={() => fetchData()} />
  )}
  </div>
  );
}

// ============ LEASE SIGNING ============
// The lease document is made in the Document Builder from the company's own
// lease template, filled in for this lease's tenant, and sent for signature
// there. This window shows what has been made for the lease and who has
// signed. It used to compose its own lease text (a table of five facts plus
// the clauses typed on the lease form) and send that instead of the real
// lease: a third lease, next to the Builder's and the Tenants page's.
function ESignatureModal({ lease, onClose, onSigned, companyId, showToast, showConfirm, setPage, userEmail = "", userRole = "" }) {
  return (
    <Modal title={"Lease signing — " + (lease.tenant_name || "Lease")} onClose={onClose}>
      <div className="space-y-4">
        <div className="bg-brand-50 rounded-lg p-3">
          <div className="text-sm font-semibold text-brand-800">{lease.property}</div>
          <div className="text-xs text-brand-600">{fmtDate(lease.start_date)} to {fmtDate(lease.end_date)} · ${safeNum(lease.rent_amount).toLocaleString()}/mo</div>
        </div>
        {lease.tenant_id == null && (
          <p className="text-xs text-warn-700">This lease is not linked to a tenant record, so a lease document cannot be filled in for it. Edit the lease and choose the tenant.</p>
        )}
        <LeaseChangesCard companyId={companyId} leaseId={lease.id} userEmail={userEmail} userRole={userRole} showToast={showToast} showConfirm={showConfirm} onChanged={onSigned} />
        <TenancyDocuments companyId={companyId} leaseId={lease.id} tenantId={lease.tenant_id}
          title="Lease documents" kinds={["lease", "renewal", "addendum"]}
          actions={lease.tenant_id != null ? [{ label: "Create lease", templateKey: "md_residential_lease" }] : []}
          setPage={setPage} returnTo={{ page: "leases" }}
          showToast={showToast} showConfirm={showConfirm} onChanged={onSigned}
          emptyText="No lease document has been created for this lease yet." />
        <p className="text-2xs text-neutral-400">Signers get their own link by email and need no account. Links stop working after 30 days. The signed copy is filed on the tenant's page.</p>
      </div>
    </Modal>
  );
}

export { LeaseManagement, ESignatureModal };
