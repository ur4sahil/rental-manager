import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, Checkbox, Input, PageHeader, Select, Textarea, TextLink} from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, formatCurrency, normalizeEmail, escapeHtml } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { printTheme } from "../utils/theme";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { safeLedgerInsert, autoPostJournalEntry, getPropertyClassId, autoPostRentCharges } from "../utils/accounting";
import { Badge, StatCard, Spinner, Modal, PropertySelect } from "./shared";

function LeaseManagement({ companySettings = {}, addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
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

  const defaultChecklist = ["Keys handed over","Smoke detectors tested","Appliances working","Walls condition documented","Floors condition documented","Plumbing checked","Electrical checked","Windows & doors checked","HVAC filter replaced","Photos taken"];
  const defaultMoveOutChecklist = ["Keys returned","All personal items removed","Unit cleaned","Walls patched/repaired","Appliances clean","Carpets cleaned","Final inspection done","Forwarding address collected","Utilities transferred","Security deposit review"];

  const [form, setForm] = useState({
  tenant_name: "", property: "", start_date: "", end_date: "",
  rent_amount: "", security_deposit: "", rent_escalation_pct: String(companySettings.rent_escalation_pct || 3),
  escalation_frequency: "annual", payment_due_day: String(companySettings.payment_due_day || 1),
  lease_type: "fixed", auto_renew: false, renewal_notice_days: String(companySettings.renewal_notice_days || 60),
  clauses: "", special_terms: "", template_id: "",
  late_fee_amount: String(companySettings.late_fee_amount || 50), late_fee_type: companySettings.late_fee_type || "flat", late_fee_grace_days: String(companySettings.late_fee_grace_days || 5),
  });
  const [showRentIncrease, setShowRentIncrease] = useState(null);
  const [rentIncreaseForm, setRentIncreaseForm] = useState({ new_amount: "", effective_date: "", reason: "" });
  const [templateForm, setTemplateForm] = useState({ name: "", description: "", clauses: "", special_terms: "", default_deposit_months: String(companySettings.default_deposit_months || 1), default_lease_months: String(companySettings.default_lease_months || 12), default_escalation_pct: String(companySettings.rent_escalation_pct || 3), payment_due_day: "1" });
  const [depositForm, setDepositForm] = useState({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()) });

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

  function prefillFromTenant(tenantName) {
  const tenant = tenants.find(t => t.name === tenantName);
  if (tenant) setForm(f => ({ ...f, tenant_name: tenant.name, property: tenant.property || "", rent_amount: String(tenant.rent || "") }));
  }

  async function saveLease() {
  if (!guardSubmit("saveLease")) return;
  try {
  if (!form.tenant_name) { showToast("Please select a tenant.", "error"); return; }
  if (!form.property) { showToast("Please select a property.", "error"); return; }
  if (!form.start_date || !form.end_date) { showToast("Lease start and end dates are required.", "error"); return; }
  if (!form.rent_amount || isNaN(Number(form.rent_amount)) || Number(form.rent_amount) <= 0) { showToast("Please enter a valid positive rent amount.", "error"); return; }
  if (form.start_date >= form.end_date) { showToast("Lease end date must be after start date.", "error"); return; }
  if (Number(form.security_deposit || 0) < 0) { showToast("Security deposit cannot be negative.", "error"); return; }
  if (Number(form.rent_escalation_pct || 0) < 0 || Number(form.rent_escalation_pct || 0) > 25) { showToast("Rent escalation must be between 0% and 25%.", "error"); return; }
  const tenant = tenants.find(t => t.name === form.tenant_name);
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
  late_fee_amount: Number(form.late_fee_amount || 50), late_fee_type: form.late_fee_type || "flat", late_fee_grace_days: Number(form.late_fee_grace_days || 5),
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
  if (!error && Number(form.security_deposit) > 0) {
  const classId = await getPropertyClassId(form.property, companyId);
  const dep = Number(form.security_deposit);
  const _jeOk = await autoPostJournalEntry({ companyId, date: form.start_date, description: "Security deposit received — " + form.tenant_name + " — " + form.property, reference: "DEP-" + shortId(), property: form.property,
  lines: [
  { account_id: "1000", account_name: "Checking Account", debit: dep, credit: 0, class_id: classId, memo: "Security deposit from " + form.tenant_name },
  { account_id: "2100", account_name: "Security Deposits Held", debit: 0, credit: dep, class_id: classId, memo: form.tenant_name + " — " + form.property },
  ]
  });
  if (!_jeOk) { showToast("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module.", "error"); }
  
  // Create ledger entry for deposit collection
  if (tenant?.id) {
  await safeLedgerInsert({ company_id: companyId,
  tenant: form.tenant_name, tenant_id: tenant.id, property: form.property, date: form.start_date,
  description: "Security deposit collected", amount: dep, type: "deposit", balance: 0,
  });
  if (!_jeOk) { showToast("Accounting entry failed. The operation was recorded but the journal entry could not be posted. Please check the accounting module.", "error"); }
  }
  }
  }
  if (error) { pmError("PM-3004", { raw: error, context: "save lease" }); return; }
  // Update properties table to reflect lease assignment
  if (!editingLease && tenant) {
  const { error: _err4608 } = await supabase.from("properties").update({ tenant: form.tenant_name, lease_end: form.end_date, status: "occupied" }).eq("company_id", companyId).eq("address", form.property);
  if (_err4608) { showToast("Error updating properties: " + _err4608.message, "error"); return; }
  }
  // (property_id auto-filled by DB trigger from property address)
  // Auto-post rent charges — prompt if backdated
  if (!editingLease) {
  const leaseStartDate = parseLocalDate(form.start_date);
  const today = new Date();
  const monthsBack = Math.max(0, (today.getFullYear() - leaseStartDate.getFullYear()) * 12 + (today.getMonth() - leaseStartDate.getMonth()));
  if (monthsBack > 0) {
  if (await showConfirm({ message: "This lease starts " + monthsBack + " month(s) in the past.\n\nWould you like to post " + monthsBack + " backdated rent accrual entries now?\n\n• Each month will create an Accounts Receivable charge\n• Tenant balance will be updated\n• You can also do this later from the Dashboard" })) {
  const result = await autoPostRentCharges(companyId);
  if (result?.posted > 0) addNotification("⚡", "Posted " + result.posted + " backdated rent charge(s)");
  if (result?.failed > 0) addNotification("⚠️", result.failed + " charge(s) failed");
  }
  } else {
  const result = await autoPostRentCharges(companyId);
  if (result?.posted > 0) showToast("Posted " + result.posted + " rent charge(s) to accounting", "success");
  }
  }
  logAudit(editingLease ? "update" : "create", "leases", (editingLease ? "Updated" : "Created") + " lease: " + form.tenant_name + " at " + form.property, editingLease?.id || "", userProfile?.email, userRole, companyId);
  // Queue lease notification
  if (!editingLease) {
  const { data: leaseTenant } = await supabase.from("tenants").select("email").eq("name", form.tenant_name).eq("company_id", companyId).maybeSingle();
  if (leaseTenant?.email) queueNotification("lease_created", leaseTenant.email, { tenant: form.tenant_name, property: form.property, startDate: form.start_date, endDate: form.end_date, rent: form.rent_amount }, companyId);
  }
  resetForm(); fetchData();
  } finally { guardRelease("saveLease"); }
  }

  function resetForm() {
  setShowForm(false); setEditingLease(null);
  setForm({ tenant_name: "", property: "", start_date: "", end_date: "", rent_amount: "", security_deposit: "", rent_escalation_pct: String(companySettings.rent_escalation_pct || 3), escalation_frequency: "annual", payment_due_day: String(companySettings.payment_due_day || 1), lease_type: "fixed", auto_renew: false, renewal_notice_days: String(companySettings.renewal_notice_days || 60), clauses: "", special_terms: "", template_id: "", late_fee_amount: String(companySettings.late_fee_amount || 50), late_fee_type: companySettings.late_fee_type || "flat", late_fee_grace_days: String(companySettings.late_fee_grace_days || 5) });
  }

  function startEdit(lease) {
  setEditingLease(lease);
  setForm({ tenant_name: lease.tenant_name, property: lease.property, start_date: lease.start_date, end_date: lease.end_date, rent_amount: String(lease.rent_amount), security_deposit: String(lease.security_deposit || 0), rent_escalation_pct: String(lease.rent_escalation_pct || 0), escalation_frequency: lease.escalation_frequency || "annual", payment_due_day: String(lease.payment_due_day || 1), lease_type: lease.lease_type || "fixed", auto_renew: lease.auto_renew || false, renewal_notice_days: String(lease.renewal_notice_days || 60), clauses: lease.clauses || "", special_terms: lease.special_terms || "", template_id: "", late_fee_amount: String(lease.late_fee_amount || 50), late_fee_type: lease.late_fee_type || "flat", late_fee_grace_days: String(lease.late_fee_grace_days || 5) });
  setShowForm(true);
  }

  async function renewLease(lease) {
  // Apply escalation based on frequency (Bug 19: was ignoring frequency)
  let escalationMultiplier = 1;
  const pct = lease.rent_escalation_pct > 0 ? lease.rent_escalation_pct / 100 : 0;
  if (pct > 0) {
  const freq = lease.escalation_frequency || "annual";
  if (freq === "semi-annual") escalationMultiplier = Math.min(Math.pow(1 + pct, 2), 10);
  else if (freq === "quarterly") escalationMultiplier = Math.min(Math.pow(1 + pct, 4), 10);
  else escalationMultiplier = 1 + pct; // annual or default
  }
  const escalated = lease.rent_amount * escalationMultiplier;
  const newStart = lease.end_date;
  const newEnd = parseLocalDate(newStart); newEnd.setFullYear(newEnd.getFullYear() + 1);
  // Bug 15: Clamp for leap year (Feb 29 in non-leap year → Feb 28)
  const endLastDay = new Date(newEnd.getFullYear(), newEnd.getMonth() + 1, 0).getDate();
  if (newEnd.getDate() > endLastDay) newEnd.setDate(endLastDay);
  if (!await showConfirm({ message: "Renew lease for " + lease.tenant_name + "?\nNew rent: $" + Math.round(escalated * 100) / 100 + "/mo\nNew term: " + newStart + " to " + formatLocalDate(newEnd) })) return;
  // Bug 1-2: Check errors and rollback on failure
  const { error: updateErr } = await supabase.from("leases").update({ status: "renewed" }).eq("company_id", companyId).eq("id", lease.id);
  if (updateErr) { showToast("Error updating old lease: " + updateErr.message, "error"); return; }
  const { error: insertErr } = await supabase.from("leases").insert([{ company_id: companyId, tenant_id: lease.tenant_id, tenant_name: lease.tenant_name, property: lease.property, start_date: newStart, end_date: formatLocalDate(newEnd), rent_amount: Math.round(escalated * 100) / 100, security_deposit: lease.security_deposit, rent_escalation_pct: lease.rent_escalation_pct, escalation_frequency: lease.escalation_frequency, payment_due_day: lease.payment_due_day, lease_type: "renewal", auto_renew: lease.auto_renew, renewal_notice_days: lease.renewal_notice_days, clauses: lease.clauses, special_terms: lease.special_terms, status: "active", renewed_from: lease.id, created_by: userProfile?.email || "", move_in_checklist: "[]", move_out_checklist: lease.move_out_checklist }]);
  if (insertErr) {
  const { error: _err4650 } = await supabase.from("leases").update({ status: "active" }).eq("company_id", companyId).eq("id", lease.id); // rollback
  if (_err4650) { showToast("Error updating leases: " + _err4650.message, "error"); return; }
  showToast("Error creating renewed lease: " + insertErr.message, "error"); return;
  }
  if (lease.tenant_id) await supabase.from("tenants").update({ rent: Math.round(escalated * 100) / 100, move_out: formatLocalDate(newEnd) }).eq("company_id", companyId).eq("id", lease.tenant_id);
  // Sync autopay schedule to new rent amount
  await supabase.from("autopay_schedules").update({ amount: Math.round(escalated * 100) / 100 }).eq("company_id", companyId).eq("tenant", lease.tenant_name).eq("enabled", true);
  // Update property table to reflect new lease end date
  const { error: _err4655 } = await supabase.from("properties").update({ lease_end: formatLocalDate(newEnd) }).eq("company_id", companyId).eq("address", lease.property);
  if (_err4655) { showToast("Error updating properties: " + _err4655.message, "error"); return; }
  logAudit("create", "leases", "Renewed lease: " + lease.tenant_name + " new rent $" + Math.round(escalated * 100) / 100, lease.id, userProfile?.email, userRole, companyId);
  await autoPostRentCharges(companyId);
  fetchData();
  }

  async function terminateLease(lease) {
  if (!await showConfirm({ message: "Terminate lease for " + lease.tenant_name + "? This cannot be undone." })) return;
  const { error: termErr } = await supabase.from("leases").update({ status: "terminated" }).eq("company_id", companyId).eq("id", lease.id);
  if (termErr) { showToast("Error terminating lease: " + termErr.message, "error"); return; }
  if (lease.tenant_id) {
  const { error: _err4666 } = await supabase.from("tenants").update({ lease_status: "inactive" }).eq("company_id", companyId).eq("id", lease.tenant_id);
  if (_err4666) { showToast("Error updating tenants: " + _err4666.message, "error"); return; }
  // Deactivate any autopay schedules for this tenant
  const { error: _err4668 } = await supabase.from("autopay_schedules").update({ active: false }).eq("company_id", companyId).eq("tenant", lease.tenant_name);
  if (_err4668) { showToast("Error updating autopay_schedules: " + _err4668.message, "error"); return; }
  // Update property status back to vacant
  const { error: _err4670 } = await supabase.from("properties").update({ status: "vacant", tenant: "", lease_end: "" }).eq("company_id", companyId).eq("address", lease.property);
  if (_err4670) { showToast("Error updating properties: " + _err4670.message, "error"); return; }
  // Create termination ledger entry
  await safeLedgerInsert({ company_id: companyId,
  tenant: lease.tenant_name, tenant_id: lease.tenant_id || null, property: lease.property, date: formatLocalDate(new Date()),
  description: "Lease terminated", amount: 0, type: "adjustment", balance: 0,
  });
  }
  logAudit("update", "leases", "Terminated lease: " + lease.tenant_name, lease.id, userProfile?.email, userRole, companyId);
  fetchData();
  }

  async function toggleChecklistItem(lease, type, index) {
  const field = type === "in" ? "move_in_checklist" : "move_out_checklist";
  let checklist = []; try { checklist = JSON.parse(lease[field] || "[]"); } catch { checklist = []; }
  if (checklist[index]) checklist[index].checked = !checklist[index].checked;
  const allDone = checklist.every(c => c.checked);
  const update = { [field]: JSON.stringify(checklist) };
  if (type === "in") update.move_in_completed = allDone;
  if (type === "out") update.move_out_completed = allDone;
  // update only contains checklist field + completion flag — safe
  const { error: _err4690 } = await supabase.from("leases").update(update).eq("id", lease.id).eq("company_id", companyId);
  if (_err4690) { showToast("Error updating leases: " + _err4690.message, "error"); return; }
  fetchData();
  }

  async function processDepositReturn(lease) {
  if (lease.deposit_status === "returned" || lease.deposit_status === "forfeited") {
  showToast("Deposit has already been processed for this lease.", "error"); return;
  }
  const returned = Number(depositForm.amount_returned || 0);
  const deposit = safeNum(lease.security_deposit);
  const deducted = deposit - returned;
  if (returned < 0 || deducted < 0) { showToast("Amounts cannot be negative.", "error"); return; }
  if (returned > deposit) {
  if (!await showConfirm({ message: "Return amount ($" + returned + ") exceeds the original deposit ($" + deposit + "). Continue?" })) return;
  }
  if (!depositForm.return_date) { showToast("Return date is required.", "error"); return; }
  try {
  const status = returned >= deposit ? "returned" : returned > 0 ? "partial_return" : "forfeited";
  const { error: depErr } = await supabase.from("leases").update({ deposit_status: status, deposit_returned: returned, deposit_return_date: depositForm.return_date, deposit_deductions: depositForm.deductions }).eq("company_id", companyId).eq("id", lease.id);
  if (depErr) { showToast("Error processing deposit return: " + depErr.message, "error"); return; }
  const classId = await getPropertyClassId(lease.property, companyId);
  // Get current tenant balance for accurate ledger trail
  const { data: depTenantBal } = lease.tenant_id ? await supabase.from("tenants").select("balance").eq("id", lease.tenant_id).eq("company_id", companyId).maybeSingle() : { data: null };
  let runningBalance = safeNum(depTenantBal?.balance);
  let returnJeOk = true;
  let deductJeOk = true;
  if (returned > 0) {
  returnJeOk = !!(await autoPostJournalEntry({ companyId, date: depositForm.return_date, description: "Security deposit return — " + lease.tenant_name, reference: "DEPRET-" + shortId(), property: lease.property,
  lines: [
  { account_id: "2100", account_name: "Security Deposits Held", debit: returned, credit: 0, class_id: classId, memo: "Return to " + lease.tenant_name },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: returned, class_id: classId, memo: "Deposit refund" },
  ]
  }));
  if (!returnJeOk) showToast("Deposit return accounting entry failed. Please check the accounting module.", "error");
  }
  if (deducted > 0) {
  deductJeOk = !!(await autoPostJournalEntry({ companyId, date: depositForm.return_date, description: "Deposit deduction — " + lease.tenant_name + " — " + depositForm.deductions, reference: "DEPDED-" + shortId(), property: lease.property,
  lines: [
  { account_id: "2100", account_name: "Security Deposits Held", debit: deducted, credit: 0, class_id: classId, memo: "Deduction: " + depositForm.deductions },
  { account_id: "4150", account_name: "Deposit Forfeiture Income", debit: 0, credit: deducted, class_id: classId, memo: "Deposit forfeiture: " + lease.tenant_name },
  ]
  }));
  if (!deductJeOk) showToast("Deposit deduction accounting entry failed. Please check the accounting module.", "error");
  }
  // Create ledger entries and update balance for deposit return
  if (returned > 0 && lease.tenant_id) {
  runningBalance -= returned;
  await safeLedgerInsert({ company_id: companyId,
  tenant: lease.tenant_name, tenant_id: lease.tenant_id, property: lease.property, date: depositForm.return_date,
  description: "Security deposit returned", amount: -returned, type: "deposit_return", balance: runningBalance,
  });
  const { error: depBalErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: lease.tenant_id, p_amount_change: -returned });
  if (depBalErr) showToast("Deposit return balance update failed: " + depBalErr.message + ". Please verify the tenant balance.", "error");
  }
  if (deducted > 0 && lease.tenant_id) {
  runningBalance += deducted;
  await safeLedgerInsert({ company_id: companyId,
  tenant: lease.tenant_name, tenant_id: lease.tenant_id, property: lease.property, date: depositForm.return_date,
  description: "Deposit deduction: " + depositForm.deductions, amount: deducted, type: "deposit_deduction", balance: runningBalance,
  });
  }
  logAudit("update", "leases", "Deposit return: $" + returned + " to " + lease.tenant_name, lease.id, userProfile?.email, userRole, companyId);
  // Queue deposit return notification
  const { data: depTenant } = await supabase.from("tenants").select("email").eq("name", lease.tenant_name).eq("company_id", companyId).maybeSingle();
  if (depTenant?.email) queueNotification("deposit_returned", depTenant.email, { tenant: lease.tenant_name, returned, deducted, property: lease.property }, companyId);
  setShowDepositModal(null); setDepositForm({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()) });
  fetchData();
  } catch (e) {
  showToast("Deposit return failed: " + e.message, "error");
  setShowDepositModal(null); setDepositForm({ amount_returned: "", deductions: "", return_date: formatLocalDate(new Date()) });
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
  <div className="bg-warn-50 border border-warn-200 rounded-3xl p-4 mb-4">
  <div className="font-semibold text-warn-800 text-sm mb-2">Leases Expiring Soon</div>
  {expiringSoon.map(l => { const d = Math.ceil((parseLocalDate(l.end_date) - new Date()) / 86400000); return (
  <div key={l.id} className="flex justify-between items-center py-1 text-sm">
  <span className="text-warn-700">{l.tenant_name} — {l.property}</span>
  <div className="flex items-center gap-2"><span className="text-warn-600 font-bold">{d} days</span><Btn variant="warning-fill" size="xs" onClick={() => renewLease(l)}>Renew</Btn></div>
  </div>
  ); })}
  </div>
  )}

  <div className="flex gap-1 mb-4 border-b border-brand-50 overflow-x-auto">
  {[["active","Active"],["expiring","Expiring"],["expired","Expired"],["renewed","Renewed"],["terminated","Terminated"],["all","All"]].map(([id,label]) => (
  <button key={id} onClick={() => setActiveTab(id)} className={"px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap " + (activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400")}>{label}{id === "expiring" && expiringSoon.length > 0 ? " (" + expiringSoon.length + ")" : ""}</button>
  ))}
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

  {showESign && <ESignatureModal lease={showESign} onClose={() => setShowESign(null)} onSigned={() => fetchData()} userProfile={userProfile} userRole={userRole} companyId={companyId} showToast={showToast} addNotification={addNotification} />}

  {showDepositModal && (
  <Modal title={"Return Deposit — " + showDepositModal.tenant_name} onClose={() => setShowDepositModal(null)}>
  <div className="space-y-3">
  <div className="bg-highlight-50 rounded-lg p-3 text-sm"><div className="flex justify-between"><span className="text-neutral-400">Original Deposit:</span><span className="font-bold">${safeNum(showDepositModal.security_deposit).toLocaleString()}</span></div></div>
  <div><label className="text-xs text-neutral-400">Amount to Return ($)</label><Input type="number" value={depositForm.amount_returned} onChange={e => setDepositForm({...depositForm, amount_returned: e.target.value})} placeholder={String(showDepositModal.security_deposit)} /></div>
  <div><label className="text-xs text-neutral-400">Deduction Reasons</label><Textarea value={depositForm.deductions} onChange={e => setDepositForm({...depositForm, deductions: e.target.value})} placeholder="Cleaning, damages, unpaid rent..." className="w-full border border-brand-100 rounded-xl px-3 py-1.5 text-sm" rows={3} /></div>
  <div><label className="text-xs text-neutral-400">Return Date</label><Input type="date" value={depositForm.return_date} onChange={e => setDepositForm({...depositForm, return_date: e.target.value})} /></div>
  {Number(depositForm.amount_returned || 0) < safeNum(showDepositModal.security_deposit) && depositForm.amount_returned && (
  <div className="bg-danger-50 rounded-lg p-2 text-xs text-danger-700">Deducting ${(safeNum(showDepositModal.security_deposit) - Number(depositForm.amount_returned)).toLocaleString()} from deposit</div>
  )}
  <Btn variant="purple" onClick={() => processDepositReturn(showDepositModal)}>Process Return</Btn>
  </div>
  </Modal>
  )}

  {showChecklist && (
  <Modal title={(showChecklist.type === "in" ? "Move-In" : "Move-Out") + " Checklist — " + showChecklist.lease.tenant_name} onClose={() => setShowChecklist(null)}>
  <div className="space-y-2">
  {(() => { let items = []; try { items = JSON.parse(showChecklist.lease[showChecklist.type === "in" ? "move_in_checklist" : "move_out_checklist"] || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse move checklist JSON", silent: true }); } return items.map((item, i) => (
  <div key={i} onClick={() => toggleChecklistItem(showChecklist.lease, showChecklist.type, i)} className={"flex items-center gap-3 p-2 rounded-lg cursor-pointer border " + (item.checked ? "bg-positive-50 border-positive-200" : "bg-white border-subtle-100 hover:bg-brand-50/30")}>
  <span className={"w-5 h-5 rounded border flex items-center justify-center text-xs " + (item.checked ? "bg-positive-500 border-positive-500 text-white" : "border-brand-200")}>{item.checked ? "✓" : ""}</span>
  <span className={"text-sm " + (item.checked ? "line-through text-neutral-400" : "text-neutral-700")}>{item.item}</span>
  </div>
  )); })()}
  </div>
  </Modal>
  )}

  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-5 mb-5">
  <h3 className="font-manrope font-semibold text-neutral-800 mb-4">{editingLease ? "Edit Lease" : "Create New Lease"}</h3>
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
  <Select value={form.tenant_name} onChange={e => { setForm({...form, tenant_name: e.target.value}); prefillFromTenant(e.target.value); }} >
  <option value="">Select tenant...</option>
  {tenants.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
  </Select>
  </div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({...form, property: v})} companyId={companyId} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Lease Start *</label><Input type="date" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Lease End *</label><Input type="date" value={form.end_date} onChange={e => setForm({...form, end_date: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Monthly Rent ($) *</label><Input type="number" min="0" step="0.01" placeholder="1500.00" value={form.rent_amount} onChange={e => setForm({...form, rent_amount: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Security Deposit ($)</label><Input type="number" min="0" step="0.01" placeholder="1500.00" value={form.security_deposit} onChange={e => setForm({...form, security_deposit: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Annual Escalation %</label><Input type="number" step="0.1" min="0" max="25" placeholder="3.0" value={form.rent_escalation_pct} onChange={e => setForm({...form, rent_escalation_pct: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Payment Due Day</label><Input type="number" min="1" max="31" placeholder="1" value={form.payment_due_day} onChange={e => setForm({...form, payment_due_day: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Lease Type</label>
  <Select value={form.lease_type} onChange={e => setForm({...form, lease_type: e.target.value})} ><option value="fixed">Fixed Term</option><option value="month_to_month">Month-to-Month</option><option value="renewal">Renewal</option></Select></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Renewal Notice (days)</label><Input type="number" min="0" max="180" placeholder="60" value={form.renewal_notice_days} onChange={e => setForm({...form, renewal_notice_days: e.target.value})} /></div>
  </div>
  {/* Late Fee Settings */}
  <div className="bg-warn-50 border border-warn-200 rounded-3xl p-4 mb-4">
  <div className="text-sm font-semibold text-warn-800 mb-2">⚠️ Late Fee Settings</div>
  <div className="grid grid-cols-3 gap-3">
  <div><label className="text-xs text-neutral-400 mb-1 block">Grace Period (days)</label><Input type="number" min="0" max="30" placeholder="5" value={form.late_fee_grace_days} onChange={e => setForm({...form, late_fee_grace_days: e.target.value})} className="border-warn-200 bg-white" /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Fee Type</label><Select value={form.late_fee_type} onChange={e => setForm({...form, late_fee_type: e.target.value})} className="border-warn-200 bg-white"><option value="flat">Flat ($)</option><option value="percent">Percent (%)</option></Select></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">{form.late_fee_type === "flat" ? "Fee Amount ($)" : "Fee Percentage (%)"}</label><Input type="number" step="0.01" min="0" placeholder="50.00" value={form.late_fee_amount} onChange={e => setForm({...form, late_fee_amount: e.target.value})} className="border-warn-200 bg-white" /></div>
  </div>
  <p className="text-xs text-warn-600 mt-2">Late fees auto-apply to tenant ledger after grace period. Admin can waive from ledger.</p>
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
  <div key={l.id} className={"bg-white rounded-xl border shadow-sm p-4 " + (isExpired ? "border-danger-200" : "border-brand-50")}>
  <div className="flex justify-between items-start mb-3">
  <div><div className="text-sm font-bold text-neutral-800">{l.tenant_name}</div><div className="text-xs text-neutral-400">{l.property}</div></div>
  <div className="flex items-center gap-2">
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (sc[isExpired ? "expired" : l.status] || "bg-neutral-100")}>{isExpired ? "EXPIRED" : l.status}</span>
  {l.lease_type === "renewal" && <span className="px-2 py-0.5 rounded-full text-xs bg-info-50 text-info-600">Renewal</span>}
  </div>
  </div>
  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3 md:grid-cols-4">
  <div><span className="text-neutral-400">Term:</span> <span className="font-medium">{l.start_date} to {l.end_date}</span></div>
  <div><span className="text-neutral-400">Rent:</span> <span className="font-bold text-neutral-800">${safeNum(l.rent_amount).toLocaleString()}/mo</span></div>
  <div><span className="text-neutral-400">Deposit:</span> <span className="font-medium">${safeNum(l.security_deposit).toLocaleString()}</span>{l.security_deposit > 0 && <span className={"ml-1 px-1 py-0.5 rounded text-xs " + (dc[l.deposit_status] || "")}>{l.deposit_status}</span>}</div>
  <div><span className="text-neutral-400">Escalation:</span> <span className="font-medium">{l.rent_escalation_pct || 0}%/yr</span></div>
  {l.status === "active" && <div><span className="text-neutral-400">Days Left:</span> <span className={"font-bold " + (daysLeft <= 30 ? "text-danger-600" : daysLeft <= 90 ? "text-warn-600" : "text-positive-600")}>{daysLeft}</span></div>}
  <div><span className="text-neutral-400">Due Day:</span> <span className="font-medium">{l.payment_due_day || 1}th</span></div>
  <div><span className="text-neutral-400">Type:</span> <span className="font-medium capitalize">{(l.lease_type || "fixed").replace("_"," ")}</span></div>
  <div><span className="text-neutral-400">Auto-Renew:</span> <span className="font-medium">{l.auto_renew ? "Yes" : "No"}</span></div>
  </div>
  <div className="flex flex-wrap gap-2 pt-2 border-t border-brand-50/50">
  <Btn variant="secondary" size="xs" onClick={() => startEdit(l)}>Edit</Btn>
  <Btn variant={l.signature_status === "fully_signed" ? "positive" : "purple"} size="xs" onClick={() => setShowESign(l)}>{l.signature_status === "fully_signed" ? "✓ Signed" : "\u270d\ufe0f E-Sign"}</Btn>
  {l.status === "active" && <Btn variant="success-fill" size="xs" onClick={() => renewLease(l)}>Renew</Btn>}
  {l.status === "active" && <Btn variant="secondary" size="xs" onClick={() => { setShowRentIncrease(l); setRentIncreaseForm({ new_amount: String(l.rent_amount), effective_date: formatLocalDate(new Date()), reason: "" }); }}>📈 Rent Increase</Btn>}
  {l.status === "active" && <Btn variant="danger" size="xs" onClick={() => terminateLease(l)}>Terminate</Btn>}
  <Btn variant={l.move_in_completed ? "positive" : "secondary"} size="xs" onClick={() => setShowChecklist({ lease: l, type: "in" })}>Move-In {l.move_in_completed ? "✓" : ""}</Btn>
  <Btn variant={l.move_out_completed ? "positive" : "secondary"} size="xs" onClick={() => setShowChecklist({ lease: l, type: "out" })}>Move-Out {l.move_out_completed ? "✓" : ""}</Btn>
  {safeNum(l.security_deposit) > 0 && l.deposit_status === "held" && (l.status === "terminated" || l.status === "expired" || isExpired) && (
  <Btn variant="purple" size="xs" onClick={() => { setShowDepositModal(l); setDepositForm({ amount_returned: String(l.security_deposit), deductions: "", return_date: formatLocalDate(new Date()) }); }}>Return Deposit</Btn>
  )}
  </div>
  </div>
  );
  })}
  {filteredLeases.length === 0 && <div className="text-center py-10 text-neutral-400">No leases found</div>}
  </div>

  {/* Rent Increase Modal */}
  {showRentIncrease && (
  <Modal title={`Rent Increase — ${showRentIncrease.tenant_name}`} onClose={() => setShowRentIncrease(null)}>
  <div className="space-y-3">
  <div className="bg-brand-50/30 rounded-xl p-3 text-sm">
  <div className="flex justify-between"><span className="text-neutral-400">Current Rent:</span><span className="font-bold">${showRentIncrease.rent_amount}/mo</span></div>
  <div className="flex justify-between"><span className="text-neutral-400">Property:</span><span>{showRentIncrease.property}</span></div>
  </div>
  <div><label className="text-xs text-neutral-400 mb-1 block">New Monthly Rent ($) *</label><Input type="number" min="0" step="0.01" placeholder="1600.00" value={rentIncreaseForm.new_amount} onChange={e => setRentIncreaseForm({...rentIncreaseForm, new_amount: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Effective Date *</label><Input type="date" value={rentIncreaseForm.effective_date} onChange={e => setRentIncreaseForm({...rentIncreaseForm, effective_date: e.target.value})} /></div>
  <div><label className="text-xs text-neutral-400 mb-1 block">Reason</label><Input value={rentIncreaseForm.reason} onChange={e => setRentIncreaseForm({...rentIncreaseForm, reason: e.target.value})} placeholder="Market adjustment, annual increase..." /></div>
  {rentIncreaseForm.new_amount && Number(rentIncreaseForm.new_amount) !== showRentIncrease.rent_amount && (
  <div className={`text-sm font-semibold rounded-lg p-2 text-center ${Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "bg-danger-50 text-danger-600" : "bg-positive-50 text-positive-600"}`}>
  {Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "+" : ""}{Math.round((Number(rentIncreaseForm.new_amount) - showRentIncrease.rent_amount) / showRentIncrease.rent_amount * 100)}% ({Number(rentIncreaseForm.new_amount) > showRentIncrease.rent_amount ? "+" : ""}${Number(rentIncreaseForm.new_amount) - showRentIncrease.rent_amount}/mo)
  </div>
  )}
  <Btn className="w-full" onClick={async () => {
  if (!rentIncreaseForm.new_amount || !rentIncreaseForm.effective_date) { showToast("Amount and date required.", "error"); return; }
  const newAmt = Number(rentIncreaseForm.new_amount);
  const { error: _err4960 } = await supabase.from("leases").update({ rent_amount: newAmt, rent_increase_history: JSON.stringify([...(JSON.parse(showRentIncrease.rent_increase_history || "[]")), { from: showRentIncrease.rent_amount, to: newAmt, date: rentIncreaseForm.effective_date, reason: rentIncreaseForm.reason }]) }).eq("company_id", companyId).eq("id", showRentIncrease.id);
  if (_err4960) { showToast("Error updating leases: " + _err4960.message, "error"); return; }
  if (showRentIncrease.tenant_id) await supabase.from("tenants").update({ rent: newAmt }).eq("company_id", companyId).eq("id", showRentIncrease.tenant_id);
  addNotification("📈", `Rent increased to ${formatCurrency(newAmt)}/mo for ${showRentIncrease.tenant_name}`);
  // Tenant-facing copy.
  if (showRentIncrease.tenant_email) addNotification("📈", `Your rent was updated to ${formatCurrency(newAmt)}/mo, effective ${rentIncreaseForm.effective_date}.`, { recipient: showRentIncrease.tenant_email, type: "rent_increase" });
  logAudit("update", "leases", `Rent increase: ${formatCurrency(showRentIncrease.rent_amount)} → ${formatCurrency(newAmt)} for ${showRentIncrease.tenant_name}`, showRentIncrease.id, userProfile?.email, userRole, companyId);
  setShowRentIncrease(null);
  fetchData();
  }}>Apply Rent Increase</Btn>
  </div>
  </Modal>
  )}
  </div>
  );
}

// E-signature for a lease. Uses the unified doc_signatures engine: creates
// (or loads) a doc_generated row tied to the lease and fires magic-link
// envelopes so tenant + landlord can sign remotely at /sign/:token.
// Previously this modal wrote to lease_signatures + called sign_lease; that
// old path never saw production traffic (0 rows at migration time) and has
// been retired in favor of the unified engine.
function ESignatureModal({ lease, onClose, onSigned, userProfile, userRole, companyId, showToast, addNotification }) {
  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState(null);
  const [sigs, setSigs] = useState([]);
  const [sending, setSending] = useState(false);
  const [tenantEmail, setTenantEmail] = useState("");
  const [landlordEmail, setLandlordEmail] = useState(userProfile?.email || "");

  useEffect(() => { loadEnvelope(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [lease.id]);

  async function loadEnvelope() {
    setLoading(true);
    // Find existing lease envelope (doc_generated with field_values.lease_id = this lease)
    const { data: existing } = await supabase
      .from("doc_generated")
      .select("*")
      .eq("company_id", companyId)
      .eq("output_type", "lease")
      .contains("field_values", { lease_id: lease.id })
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      setDoc(existing);
      const { data: ss } = await supabase
        .from("doc_signatures")
        .select("*")
        .eq("company_id", companyId)
        .eq("doc_id", existing.id)
        .order("sign_order", { ascending: true });
      setSigs(ss || []);
    } else {
      const { data: tenant } = await supabase
        .from("tenants")
        .select("email")
        .eq("company_id", companyId)
        .ilike("name", lease.tenant_name || "")
        .is("archived_at", null)
        .maybeSingle();
      if (tenant?.email) setTenantEmail(tenant.email);
    }
    setLoading(false);
  }

  function buildLeaseHtml() {
    const l = lease;
    return ''
      + '<h1 style="text-align:center;color:' + printTheme.signatureInk + ';">Residential Lease Agreement</h1>'
      + '<table style="width:100%;margin:20px 0;border-collapse:collapse;">'
      + '<tr><td style="padding:6px 10px;font-weight:600;width:30%;">Property</td><td style="padding:6px 10px;">' + escapeHtml(l.property || "") + '</td></tr>'
      + '<tr><td style="padding:6px 10px;font-weight:600;">Tenant</td><td style="padding:6px 10px;">' + escapeHtml(l.tenant_name || "") + '</td></tr>'
      + '<tr><td style="padding:6px 10px;font-weight:600;">Lease Term</td><td style="padding:6px 10px;">' + escapeHtml(l.start_date || "") + ' through ' + escapeHtml(l.end_date || "") + '</td></tr>'
      + '<tr><td style="padding:6px 10px;font-weight:600;">Monthly Rent</td><td style="padding:6px 10px;">$' + safeNum(l.rent_amount).toLocaleString() + '</td></tr>'
      + '<tr><td style="padding:6px 10px;font-weight:600;">Security Deposit</td><td style="padding:6px 10px;">$' + safeNum(l.security_deposit).toLocaleString() + '</td></tr>'
      + '</table>'
      + (l.clauses ? '<h3 style="color:' + printTheme.signatureInk + ';margin-top:24px;">Lease Terms</h3><div style="white-space:pre-wrap;line-height:1.7;">' + escapeHtml(l.clauses) + '</div>' : '')
      + (l.special_terms ? '<h3 style="color:' + printTheme.signatureInk + ';margin-top:24px;">Special Terms</h3><div style="white-space:pre-wrap;line-height:1.7;">' + escapeHtml(l.special_terms) + '</div>' : '')
      + '<hr style="margin-top:32px;"/><p style="font-size:11px;color:' + printTheme.inkMuted + ';">By signing below each party confirms they have read and agree to the terms set out above.</p>';
  }

  async function sendForSignature() {
    if (!guardSubmit("leaseSend", lease.id)) return;
    const te = (tenantEmail || "").trim().toLowerCase();
    const le = (landlordEmail || "").trim().toLowerCase();
    if (!te || !te.includes("@")) { showToast("Tenant email is required", "error"); guardRelease("leaseSend", lease.id); return; }
    if (!le || !le.includes("@")) { showToast("Landlord email is required", "error"); guardRelease("leaseSend", lease.id); return; }

    setSending(true);
    try {
      const rendered = buildLeaseHtml();
      const docName = "Lease Agreement — " + (lease.tenant_name || "") + " — " + (lease.property || "");
      const { data: newDoc, error: docErr } = await supabase.from("doc_generated").insert([{
        company_id: companyId,
        template_id: null,
        name: docName,
        rendered_body: rendered,
        field_values: { lease_id: lease.id },
        property_address: lease.property || "",
        tenant_name: lease.tenant_name || "",
        output_type: "lease",
        status: "sent",
        created_by: userProfile?.email || null,
      }]).select().single();
      if (docErr) { pmError("PM-3004", { raw: docErr, context: "create lease envelope doc" }); return; }

      const signers = [
        { role: "tenant", label: "Tenant", name: lease.tenant_name || "", email: te, order: 1 },
        { role: "landlord", label: "Landlord", name: userProfile?.name || "Property Manager", email: le, order: 2 },
      ];
      const { data: envRows, error: envErr } = await supabase.rpc("create_doc_envelope", { p_doc_id: newDoc.id, p_signers: signers });
      if (envErr) { pmError("PM-3004", { raw: envErr, context: "lease create_doc_envelope" }); return; }

      const origin = window.location.origin;
      for (const row of envRows || []) {
        if (row.status !== "sent") continue;
        const url = origin + "/sign/" + row.access_token;
        const matching = signers.find(s => s.email === row.signer_email);
        const html = '<div style="font-family:Georgia,serif;font-size:14px;line-height:1.6;color:' + printTheme.ink + ';max-width:640px;margin:0 auto;">'
          + '<p>Hello' + (matching?.name ? " " + matching.name : "") + ',</p>'
          + '<p>You are requested to review and sign the <strong>' + docName + '</strong> as <em>' + (matching?.label || "signer") + '</em>.</p>'
          + '<p><a href="' + url + '" style="display:inline-block;background:' + printTheme.brandLight + ';color:' + printTheme.surface + ';padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; Sign</a></p>'
          + '<p style="font-size:12px;color:' + printTheme.inkMuted + ';">Or paste this link into your browser:<br/>' + url + '</p>'
          + '<p style="font-size:11px;color:' + printTheme.inkSubtle + ';margin-top:24px;">This link expires in 30 days. If you did not expect this message, you can ignore it.</p>'
          + '</div>';
        try {
          const { error: emailErr } = await supabase.functions.invoke("send-email", { body: { to: row.signer_email, subject: "Signature requested: " + docName, html } });
          if (emailErr) pmError("PM-1007", { raw: emailErr, context: "lease signing email to " + row.signer_email, silent: true });
        } catch (e) { pmError("PM-1007", { raw: e, context: "lease signing email exception", silent: true }); }
      }

      await supabase.from("leases").update({ signature_status: "pending" }).eq("id", lease.id).eq("company_id", companyId);
      logAudit("update", "leases", "Lease sent for e-signature (unified engine): " + lease.tenant_name + " → " + te + " + " + le, lease.id, userProfile?.email, userRole, companyId);
      if (addNotification) addNotification("✍️", "Lease sent for signature: " + (lease.tenant_name || ""));
      showToast("Lease sent — both parties emailed magic links", "success");

      setDoc(newDoc);
      const { data: ss } = await supabase.from("doc_signatures").select("*").eq("company_id", companyId).eq("doc_id", newDoc.id).order("sign_order", { ascending: true });
      setSigs(ss || []);
      if (onSigned) onSigned();
    } finally {
      setSending(false);
      guardRelease("leaseSend", lease.id);
    }
  }

  async function resendSignerEmail(sig) {
    if (!sig?.access_token) return;
    const url = window.location.origin + "/sign/" + sig.access_token;
    const docName = doc?.name || "Lease";
    const html = '<div style="font-family:Georgia,serif;font-size:14px;line-height:1.6;"><p>Hello ' + escapeHtml(sig.signer_name || "") + ',</p>'
      + '<p>Reminder — you still need to sign <strong>' + escapeHtml(docName) + '</strong>.</p>'
      + '<p><a href="' + url + '" style="display:inline-block;background:' + printTheme.brandLight + ';color:' + printTheme.surface + ';padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; Sign</a></p></div>';
    try {
      await supabase.functions.invoke("send-email", { body: { to: sig.signer_email, subject: "Reminder: " + docName, html } });
      showToast("Reminder sent to " + sig.signer_email, "success");
    } catch (e) { pmError("PM-1007", { raw: e, context: "lease reminder email", silent: true }); }
  }

  async function copySignerLink(sig) {
    const url = window.location.origin + "/sign/" + sig.access_token;
    try { await navigator.clipboard.writeText(url); showToast("Signing link copied", "success"); }
    catch { showToast("Copy failed — link: " + url, "info"); }
  }

  if (loading) return <Modal title="E-Signature" onClose={onClose}><Spinner /></Modal>;

  const allSigned = doc && sigs.length > 0 && sigs.every(s => s.status === "signed");
  const envelopeOpen = doc && !allSigned;

  return (
    <Modal title={"E-Signature — " + (lease.tenant_name || "Lease")} onClose={onClose}>
      <div className="space-y-4">
        {/* Lease summary */}
        <div className="bg-brand-50 rounded-lg p-3">
          <div className="text-sm font-semibold text-brand-800">{lease.property}</div>
          <div className="text-xs text-brand-600">{lease.start_date} to {lease.end_date} · ${safeNum(lease.rent_amount).toLocaleString()}/mo</div>
        </div>

        {!doc && (
          <div className="border border-brand-100 rounded-2xl p-4 bg-white">
            <div className="text-sm font-semibold text-neutral-700 mb-2">Send Lease for Signature</div>
            <p className="text-xs text-neutral-400 mb-3">Both parties will receive a secure magic link by email. No account required to sign. Links expire in 30 days.</p>
            <div className="space-y-2 mb-3">
              <div>
                <label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1">Tenant email</label>
                <Input size="sm" type="email" value={tenantEmail} onChange={e => setTenantEmail(e.target.value)} placeholder="tenant@example.com" />
              </div>
              <div>
                <label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider block mb-1">Landlord / PM email</label>
                <Input size="sm" type="email" value={landlordEmail} onChange={e => setLandlordEmail(e.target.value)} placeholder="you@example.com" />
              </div>
            </div>
            <Btn variant="primary" className="w-full" onClick={sendForSignature} disabled={sending}>
              {sending ? "Sending…" : "Send for Signature"}
            </Btn>
          </div>
        )}

        {doc && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold text-neutral-700">Signer progress</div>
              {allSigned ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-success-100 text-success-700">✓ Fully signed</span>
              ) : (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brand-100 text-brand-700">Awaiting signatures</span>
              )}
            </div>
            <div className="space-y-2">
              {sigs.map(s => {
                const cls = s.status === "signed" ? "bg-positive-50 border-positive-200"
                  : s.status === "viewed" ? "bg-brand-50 border-brand-200"
                  : s.status === "sent" ? "bg-warn-50 border-warn-200"
                  : "bg-neutral-50 border-neutral-200";
                return (
                  <div key={s.id} className={"flex items-center justify-between px-3 py-2 rounded-lg border " + cls}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-neutral-800 truncate">{s.signer_name || s.signer_email}</div>
                      <div className="text-xs text-neutral-400 capitalize">{(s.signer_role || "").replace(/_/g, " ")} · {s.signer_email}</div>
                      {s.signed_at && <div className="text-[10px] text-neutral-400 mt-0.5">Signed {new Date(s.signed_at).toLocaleString()}{s.integrity_hash ? " · " + s.integrity_hash.slice(0, 12) + "…" : ""}</div>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {s.status === "signed" ? (
                        <span className="text-xs font-bold px-2 py-0.5 rounded-full text-positive-700 bg-positive-100">🔒 Signed</span>
                      ) : (
                        <>
                          <TextLink tone="brand" size="xs" onClick={() => copySignerLink(s)}  title="Copy signing link" className="px-1.5 py-0.5">Copy link</TextLink>
                          <TextLink tone="neutral" size="xs" onClick={() => resendSignerEmail(s)}  title="Resend signing email" className="px-1.5 py-0.5">Resend</TextLink>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {envelopeOpen && (
              <p className="text-[10px] text-neutral-400 mt-3">
                Signers receive a unique link per role. Signatures are verified server-side; IP, user-agent, and a SHA-256 integrity hash are captured at signing time.
              </p>
            )}

            {allSigned && (
              <div className="bg-positive-50 border border-positive-200 rounded-2xl p-3 mt-3 text-center">
                <div className="text-sm font-bold text-positive-700">Lease fully executed</div>
                <div className="text-xs text-positive-600 mt-1">Download the signed document and certificate of completion from the Documents tab → History.</div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export { LeaseManagement, ESignatureModal };
