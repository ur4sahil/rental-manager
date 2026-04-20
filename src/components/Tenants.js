import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, Checkbox, IconBtn, Input, PageHeader, Select, TextLink} from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, formatPersonName, parseNameParts, isValidEmail, normalizeEmail, formatCurrency, getSignedUrl, formatPhoneInput, exportToCSV, escapeHtml, escapeFilterValue, REQUIRED_TENANT_DOCS, recomputeTenantDocStatus } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { printTheme } from "../utils/theme";
import { guardSubmit, guardRelease, _submitGuards } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { safeLedgerInsert, atomicPostJEAndLedger, autoPostJournalEntry, getPropertyClassId, getOrCreateTenantAR, autoPostRentCharges } from "../utils/accounting";
import { Badge, Spinner, Modal, PropertySelect, RecurringEntryModal, DocUploadModal } from "./shared";
import { MessageThread, MessageComposer, uploadMessageAttachment } from "./Messages";
import { queueNotification } from "../utils/notifications";
import { LeaseManagement } from "./Leases";
import { MoveOutWizard, EvictionWorkflow } from "./Lifecycle";

const acctToday = () => formatLocalDate(new Date());

// ============ TENANTS ============
function Tenants({ addNotification, userProfile, userRole, companyId, setPage, initialTab, showToast, showConfirm, activeCompany, companySettings = {} }) {
  const isAdmin = userRole === "admin";
  const [pendingRecurringEntry, setPendingRecurringEntry] = useState(null);
  function exportTenants() {
  const exportData = tenants.filter(t => !t.archived_at);
  exportToCSV(exportData, [
  { label: "Name", key: "name" },
  { label: "Email", key: "email" },
  { label: "Phone", key: "phone" },
  { label: "Property", key: "property" },
  { label: "Rent", key: "rent" },
  { label: "Balance", key: "balance" },
  { label: "Status", key: "status" },
  { label: "Lease Start", key: "lease_start" },
  { label: "Lease End", key: "lease_end" },
  ], "tenants_" + new Date().toLocaleDateString(), showToast);
  }
  const [tenants, setTenants] = useState([]);
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTenant, setEditingTenant] = useState(null);
  const [savingTenant, setSavingTenant] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(null);
  const [activePanel, setActivePanel] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [msgAttachment, setMsgAttachment] = useState(null);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [newCharge, setNewCharge] = useState({ description: "", amount: "", type: "charge" });
  const [form, setForm] = useState({ name: "", first_name: "", mi: "", last_name: "", email: "", phone: "", property: "", lease_status: "active", lease_start: "", lease_end: "", rent: "", late_fee_amount: "", late_fee_type: companySettings?.late_fee_type || "flat", is_voucher: false, voucher_number: "", reexam_date: "", case_manager_name: "", case_manager_email: "", case_manager_phone: "", voucher_portion: "", tenant_portion: "" });
  const [tenantView, setTenantView] = useState("card");
  const [tenantSearch, setTenantSearch] = useState("");
  const [tenantFilter, setTenantFilter] = useState("all");
  const [tenantFilterProp, setTenantFilterProp] = useState("all");
  const [tenantFilterBalance, setTenantFilterBalance] = useState("all");
  const [tenantFilterLeaseExpiry, setTenantFilterLeaseExpiry] = useState("all");
  // Bulk selection
  const [selectedTenants, setSelectedTenants] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(null);
  const [leaseModal, setLeaseModal] = useState(null);
  const [tenantDocs, setTenantDocs] = useState([]);
  const [tenantTab, setTenantTab] = useState(initialTab || "tenants");
  const [archivedTenants, setArchivedTenants] = useState([]);
  const [portalMembers, setPortalMembers] = useState({}); // email(lower) → 'invited' | 'active' | 'removed'
  const [showTenantDocPrompt, setShowTenantDocPrompt] = useState(null);
  const [showDocUpload, setShowDocUpload] = useState(null);
  const [docExceptions, setDocExceptions] = useState([]);
  const [leaseInput, setLeaseInput] = useState("");
  // eslint-disable-next-line no-unused-vars
  const [error, setError] = useState("");

  useEffect(() => {
  fetchTenants();
  fetchDocExceptions();
  fetchPortalMembers();
  supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null)
  .then(({ data, error }) => { if (error) pmError("PM-8006", { raw: error, context: "tenants property fetch", silent: true }); setProperties(data || []); });
  }, [companyId]);

  async function fetchTenants() {
  const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null);
  setTenants(data || []);
  setLoading(false);
  }
  async function fetchPortalMembers() {
  const { data } = await supabase.from("company_members").select("user_email, status").eq("company_id", companyId).eq("role", "tenant");
  const map = {};
  (data || []).forEach(m => { if (m.user_email) map[m.user_email.toLowerCase()] = m.status; });
  setPortalMembers(map);
  }
  async function fetchDocExceptions() {
  const { data } = await supabase.from("doc_exception_requests").select("*").eq("company_id", companyId).order("created_at", { ascending: false });
  setDocExceptions(data || []);
  }

  async function saveTenant() {
  if (!guardSubmit("saveTenant")) return;
  try {
  if (form.email && !isValidEmail(form.email)) { showToast("Please enter a valid email address.", "error"); return; }
  if (!form.name.trim()) { showToast("Tenant name is required.", "error"); return; }
  if (!form.email.trim() || !form.email.includes("@") || !form.email.includes(".")) { showToast("Please enter a valid email address.", "error"); return; }
  if (!form.property) { showToast("Please select a property.", "error"); return; }
  if (form.rent && (isNaN(Number(form.rent)) || Number(form.rent) < 0)) { showToast("Rent must be a valid positive number.", "error"); return; }
  // #27: Stale data check — verify record hasn't been modified by another user
  if (editingTenant) {
  const { data: freshTenant } = await supabase.from("tenants").select("updated_at").eq("id", editingTenant.id).eq("company_id", companyId).maybeSingle();
  if (freshTenant?.updated_at && editingTenant.updated_at && freshTenant.updated_at !== editingTenant.updated_at) {
  if (!await showConfirm({ message: "This tenant was modified by another user since you started editing. Your changes may overwrite theirs. Continue?" })) return;
  }
  }
  // #15: Block duplicate tenant (same name + property)
  if (!editingTenant) {
  const { data: dupCheck } = await supabase.from("tenants").select("id").eq("company_id", companyId).ilike("name", escapeFilterValue(form.name.trim())).eq("property", form.property).is("archived_at", null).maybeSingle();
  if (dupCheck) { showToast("A tenant named \"" + form.name.trim() + "\" already exists at this property.", "error"); return; }
  }
  // #3: Keep lease_start/move_in and lease_end_date/move_out in sync
  const { error } = editingTenant
  ? await supabase.from("tenants").update({ name: form.name, first_name: form.first_name, middle_initial: form.mi, last_name: form.last_name, email: normalizeEmail(form.email), phone: form.phone, property: form.property, lease_status: form.lease_status, lease_start: form.lease_start || null, move_in: form.lease_start || null, lease_end_date: form.lease_end || null, move_out: form.lease_end || null, rent: form.rent, late_fee_amount: safeNum(form.late_fee_amount) || null, late_fee_type: form.late_fee_type || "flat", is_voucher: form.is_voucher || false, voucher_number: form.voucher_number || null, reexam_date: form.reexam_date || null, case_manager_name: form.case_manager_name || null, case_manager_email: form.case_manager_email || null, case_manager_phone: form.case_manager_phone || null, voucher_portion: safeNum(form.voucher_portion) || null, tenant_portion: safeNum(form.tenant_portion) || null }).eq("id", editingTenant.id).eq("company_id", companyId)
  : await supabase.from("tenants").insert([{ company_id: companyId, name: form.name, first_name: form.first_name, middle_initial: form.mi, last_name: form.last_name, email: normalizeEmail(form.email), phone: form.phone, property: form.property, lease_status: form.lease_status, lease_start: form.lease_start || null, lease_end_date: form.lease_end || null, move_in: form.lease_start || null, move_out: form.lease_end || null, rent: form.rent, late_fee_amount: safeNum(form.late_fee_amount) || null, late_fee_type: form.late_fee_type || "flat", is_voucher: form.is_voucher || false, voucher_number: form.voucher_number || null, reexam_date: form.reexam_date || null, case_manager_name: form.case_manager_name || null, case_manager_email: form.case_manager_email || null, case_manager_phone: form.case_manager_phone || null, voucher_portion: safeNum(form.voucher_portion) || null, tenant_portion: safeNum(form.tenant_portion) || null, balance: 0, doc_status: "pending_docs" }]);
  if (error) {
  if (error.message?.includes("idx_tenants_unique_name_property") || error.message?.includes("duplicate")) {
  pmError("PM-3001", { raw: error, context: "save tenant " + form.name.trim() });
  } else {
  pmError("PM-3002", { raw: error, context: "save tenant " + form.name.trim() });
  }
  return;
  }
  // Close form immediately and show processing spinner for post-save operations
  const _isNew = !editingTenant;
  const _name = form.name.trim();
  const _property = form.property;
  const _rent = Number(form.rent);
  const _leaseStart = form.lease_start;
  const _leaseEnd = form.lease_end;
  const _secDep = Number(form.security_deposit) || 0;
  setShowForm(false);
  setEditingTenant(null);
  setForm({ name: "", first_name: "", mi: "", last_name: "", email: "", phone: "", property: "", lease_status: "active", lease_start: "", lease_end: "", rent: "", security_deposit: "" });
  if (_isNew && _property && _leaseStart && _leaseEnd && _rent) setSavingTenant(true);
  // Post-save operations (run while spinner shows)
  if (_isNew) {
  const { data: insertedTenant } = await supabase.from("tenants").select("id").eq("company_id", companyId).ilike("name", escapeFilterValue(_name)).eq("property", _property).is("archived_at", null).maybeSingle();
  const tenantId = insertedTenant?.id || null;
  // Create AR sub-account + update property + create lease in parallel where possible
  const [, ,] = await Promise.all([
  getOrCreateTenantAR(companyId, _name, tenantId),
  _property ? supabase.from("properties").update({ status: "occupied", tenant: _name, rent: _rent || null, lease_start: _leaseStart || null, lease_end: _leaseEnd || null }).eq("company_id", companyId).eq("address", _property) : Promise.resolve(),
  Promise.resolve(), // placeholder
  ]);
  if (_property && _leaseStart && _leaseEnd && _rent) {
  const { data: existingLease } = await supabase.from("leases").select("id").eq("company_id", companyId).eq("property", _property).eq("status", "active").maybeSingle();
  if (!existingLease) {
  await supabase.from("leases").insert([{ company_id: companyId, tenant_name: _name, tenant_id: tenantId, property: _property, start_date: _leaseStart, end_date: _leaseEnd, rent_amount: _rent, security_deposit: _secDep, status: "active", payment_due_day: 1, rent_escalation_pct: 3, escalation_frequency: "annual" }]);
  }
  // Security deposit + rent charges in parallel
  if (_secDep > 0 && tenantId) {
  const [classId, tenantArId] = await Promise.all([getPropertyClassId(_property, companyId), getOrCreateTenantAR(companyId, _name, tenantId)]);
  const _depOk = await autoPostJournalEntry({ companyId, date: _leaseStart, description: "Security deposit received — " + _name + " — " + _property, reference: "DEP-" + shortId(), property: _property,
  lines: [
  { account_id: tenantArId, account_name: "AR - " + _name, debit: _secDep, credit: 0, class_id: classId, memo: "Security deposit from " + _name },
  { account_id: "2100", account_name: "Security Deposits Held", debit: 0, credit: _secDep, class_id: classId, memo: _name + " — " + _property },
  ]
  });
  if (_depOk) await safeLedgerInsert({ company_id: companyId, tenant: _name, tenant_id: tenantId, property: _property, date: _leaseStart, description: "Security deposit collected", amount: _secDep, type: "deposit", balance: 0 });
  if (!_depOk) showToast("Security deposit accounting entry failed.", "error");
  }
  // Rent charges — fire and forget (don't block the popup)
  autoPostRentCharges(companyId).then(result => { if (result?.posted > 0) showToast("Posted " + result.posted + " rent charge(s)", "success"); }).catch(e => pmError("PM-4008", { raw: e, context: "auto rent charge posting", silent: true }));
  setSavingTenant(false);
  // Queue recurring entry popup
  setPendingRecurringEntry({ tenantName: _name, tenantId: tenantId, property: _property, rent: _rent, leaseStart: _leaseStart, leaseEnd: _leaseEnd });
  } else {
  setSavingTenant(false);
  }
  }
  if (editingTenant) {
  // Cascade name change to all related tables
  if (editingTenant.name !== form.name) {
  // Atomic cascade rename via server-side RPC
  // Atomic cascade rename — server-side RPC required
  const { error: tenantRenameErr } = await supabase.rpc("rename_tenant_cascade", {
  p_company_id: companyId, p_old_name: editingTenant.name, p_new_name: form.name
  });
  if (tenantRenameErr) {
  // #13: Client-side fallback — cascade rename to tables the RPC may not cover
  pmError("PM-3002", { raw: tenantRenameErr, context: "tenant rename RPC, running client-side fallback", silent: true });
  const oldName = editingTenant.name;
  const tRenameResults = await Promise.allSettled([
  supabase.from("payments").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
  supabase.from("leases").update({ tenant_name: form.name }).eq("company_id", companyId).eq("tenant_name", oldName),
  supabase.from("work_orders").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
  supabase.from("documents").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
  supabase.from("autopay_schedules").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
  supabase.from("ledger_entries").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
  supabase.from("messages").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
  supabase.from("eviction_cases").update({ tenant_name: form.name }).eq("company_id", companyId).eq("tenant_name", oldName),
  supabase.from("properties").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName),
  ]);
  const tRenameFails = tRenameResults.filter(r => r.status === "rejected");
  if (tRenameFails.length > 0) showToast("Warning: " + tRenameFails.length + " table(s) failed during tenant rename.", "warning");
  }
  }
  addNotification("\u{1F464}", `Tenant updated: ${_name}`);
  logAudit("update", "tenants", `Updated tenant: ${_name}`, "", userProfile?.email, userRole, companyId);
  } else {
  addNotification("\u{1F464}", `New tenant added: ${_name}`);
  setShowTenantDocPrompt(_name);
  logAudit("create", "tenants", `Added tenant: ${_name} at ${_property}`, "", userProfile?.email, userRole, companyId);
  }
  fetchTenants();
  showToast(_isNew ? "Tenant added successfully" : "Tenant updated successfully", "success");
  } catch (e) {
  pmError("PM-3002", { raw: e, context: "saveTenant" });
  setSavingTenant(false);
  showToast("Tenant was saved but a post-save operation failed: " + (e.message || e) + ". Please check the tenant list.", "error");
  setShowForm(false);
  setEditingTenant(null);
  fetchTenants();
  } finally { guardRelease("saveTenant"); }
  }

  async function deleteTenant(id, name) {
  if (!guardSubmit("deleteTenant")) return;
  try {
  // Check if already archived
  const { data: checkRow } = await supabase.from("tenants").select("archived_at").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (checkRow?.archived_at) { showToast("This tenant is already archived.", "info"); return; }
  // Non-admin: submit delete request for admin approval
  if (!isAdmin) {
  if (!await showConfirm({ message: `Request to delete tenant "${name}"?\n\nAn admin will review and approve this request.` })) return;
  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from("property_change_requests").insert([{ company_id: companyId, request_type: "delete_tenant", requested_by: user?.email || "unknown", address: name, notes: "Delete tenant: " + name }]);
  showToast("Delete request submitted for admin approval.", "success");
  logAudit("request", "tenants", "Requested delete: " + name, id, user?.email, userRole, companyId);
  return;
  }
  // Check for outstanding balance before allowing deletion
  const { data: tenantRow } = await supabase.from("tenants").select("balance").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (tenantRow && safeNum(tenantRow.balance) > 0) {
  showToast(`Cannot delete tenant "${name}" with an outstanding balance of $${safeNum(tenantRow.balance).toFixed(2)}. Please settle the balance first.`, "error");
  return;
  }
  if (tenantRow && safeNum(tenantRow.balance) < 0) {
  if (!await showConfirm({ message: `Tenant "${name}" has a credit balance of $${Math.abs(safeNum(tenantRow.balance)).toFixed(2)}. Deleting will forfeit this credit. Continue?` })) return;
  }
  // #16: Check for unreturned security deposit
  const { data: activeLease } = await supabase.from("leases").select("security_deposit").eq("company_id", companyId).eq("tenant_name", name).eq("status", "active").maybeSingle();
  if (activeLease && safeNum(activeLease.security_deposit) > 0) {
  if (isAdmin) {
  if (!await showConfirm({ message: `Tenant "${name}" has an unreturned security deposit of ${formatCurrency(activeLease.security_deposit)}.\n\nDeleting without processing the deposit through the Move-Out Wizard will leave the deposit liability on your books.\n\nProceed anyway?`, variant: "danger", confirmText: "Delete Anyway" })) return;
  } else {
  showToast("Cannot delete \"" + name + "\" — a security deposit of " + formatCurrency(activeLease.security_deposit) + " has not been returned. Please use the Move-Out Wizard first.", "error");
  return;
  }
  }
  if (!await showConfirm({ message: `Delete tenant "${name}"?\n\nThis will hide the tenant and terminate their lease. You can restore within 180 days.`, variant: "danger", confirmText: "Delete" })) return;
  // Get tenant's property before archiving for cascade updates
  const { data: tenantDetail } = await supabase.from("tenants").select("property, balance").eq("id", id).eq("company_id", companyId).maybeSingle();
  const tenantProperty = tenantDetail?.property;
  // Soft-delete: archive instead of permanent deletion
  const { error: archiveErr } = await supabase.from("tenants").update({
  archived_at: new Date().toISOString(),
  archived_by: userProfile?.email,
  lease_status: "inactive"
  }).eq("id", id).eq("company_id", companyId);
  if (archiveErr) { pmError("PM-3003", { raw: archiveErr, context: "archive tenant" }); return; }
  // Update property to vacant when tenant archived
  if (tenantProperty) {
  const { error: propErr } = await supabase.from("properties").update({ status: "vacant", tenant: "", tenant_2: "", tenant_2_email: "", tenant_2_phone: "", tenant_3: "", tenant_3_email: "", tenant_3_phone: "", tenant_4: "", tenant_4_email: "", tenant_4_phone: "", tenant_5: "", tenant_5_email: "", tenant_5_phone: "", lease_end: null, lease_start: "", rent: null, security_deposit: null }).eq("company_id", companyId).eq("address", tenantProperty);
  if (propErr) pmError("PM-2002", { raw: propErr, context: "update property to vacant", silent: true });
  }
  // Terminate active leases for this tenant (match by name or property)
  const { error: leaseErr } = await supabase.from("leases").update({ status: "terminated", archived_at: new Date().toISOString() }).eq("company_id", companyId).eq("status", "active").or(`tenant_name.ilike.%${escapeFilterValue(name)}%,property.eq.${escapeFilterValue(tenantProperty)}`);
  if (leaseErr) pmError("PM-3004", { raw: leaseErr, context: "terminate leases on archive", silent: true });
  // Archive autopay schedules for this tenant
  await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant", name).eq("property", tenantProperty);
  // Settle outstanding AR on tenant sub-accounts (write off remaining balance)
  const tenantBal = safeNum(tenantDetail?.balance);
  if (tenantBal > 0 && id) {
  const classId = tenantProperty ? await getPropertyClassId(tenantProperty, companyId) : null;
  await autoPostJournalEntry({ companyId, date: formatLocalDate(new Date()), description: "AR write-off — tenant deleted — " + name, reference: "WOFF-" + shortId(), property: tenantProperty || "",
  lines: [
  { account_id: "5300", account_name: "Bad Debt Expense", debit: tenantBal, credit: 0, class_id: classId, memo: "Write-off at deletion — " + name },
  { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: tenantBal, class_id: classId, memo: "AR write-off — " + name },
  ]
  });
  // Zero out tenant balance
  await supabase.rpc("update_tenant_balance", { p_tenant_id: id, p_amount_change: -tenantBal }).catch(e => pmError("PM-6002", { raw: e, context: "balance zero-out on archive", silent: true }));
  }
  // Deactivate tenant AR sub-accounts
  await supabase.from("acct_accounts").update({ is_active: false }).eq("company_id", companyId).eq("tenant_id", id);
  addNotification("\u{1F5D1}\uFE0F", `Tenant deleted: ${name}`);
  logAudit("delete", "tenants", `Deleted tenant: ${name} (property→vacant, lease terminated, autopay disabled)`, id, userProfile?.email, userRole, companyId);
  fetchTenants();
  } finally { guardRelease("deleteTenant"); }
  }

  async function inviteTenant(tenant) {
  if (!guardSubmit("inviteTenant")) return;
  try {
  if (!tenant.email) { showToast("This tenant has no email address. Please add one first.", "error"); return; }
  if (!await showConfirm({ message: "Send portal invite to " + tenant.email + "?\n\nThis will:\n1. Generate a unique invite code for this tenant\n2. Send a magic link to their email\n3. They can sign up using the invite code to access their portal" })) return;
  try {
  // Generate unique invite code
  // Generate unique invite code with collision retry
  let code, codeInsertErr;
  for (let attempt = 0; attempt < 5; attempt++) {
  const codeArr = new Uint32Array(1); crypto.getRandomValues(codeArr);
  code = "TNT-" + String(10000000 + (codeArr[0] % 89999999));
  const { data: existing } = await supabase.from("tenant_invite_codes").select("id").eq("company_id", companyId).eq("code", code).maybeSingle();
  if (!existing) break; // No collision — code is unique
  if (attempt === 4) { showToast("Could not generate unique invite code. Please try again.", "error"); return; }
  }
  const { error: codeInsertError } = await supabase.from("tenant_invite_codes").insert([{
  code: code,
  company_id: companyId,
  property: tenant.property || "",
  tenant_id: tenant.id,
  tenant_name: tenant.name,
  tenant_email: tenant.email,
  created_by: userProfile?.email || "admin",
  used: false,
  }]);

  // Also send magic link — but only if invite code was created successfully
  if (codeInsertError) { pmError("PM-3007", { raw: codeInsertError, context: "create tenant invite code" }); return; }
  // Routed server-side: /api/invite-user bypasses Supabase Bot Protection
  // captcha by using auth.admin.inviteUserByEmail. This single call both
  // sends the magic link AND upserts the company_members row with
  // status=invited. Pre-M15 this was two separate client-side calls; the
  // captcha gate on signInWithOtp would now block admins from every invite.
  const { data: { session } } = await supabase.auth.getSession();
  const inviteToken = session?.access_token;
  if (!inviteToken) { showToast("Session expired — please sign in again.", "error"); return; }
  const inviteResp = await fetch("/api/invite-user", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + inviteToken },
  body: JSON.stringify({
  email: (tenant.email || "").trim().toLowerCase(),
  companyId,
  userName: tenant.name,
  role: "tenant",
  inviteType: "tenant",
  }),
  });
  if (!inviteResp.ok) {
  let errMsg = "Invite failed (" + inviteResp.status + ")";
  try { errMsg = (await inviteResp.json()).error || errMsg; } catch (_) {}
  pmError("PM-3007", { raw: { message: errMsg }, context: "send invitation to " + tenant.email });
  showToast(errMsg, "error");
  return;
  }
  addNotification("✉️", "Invite code generated for " + tenant.email);
  logAudit("create", "tenants", "Invited tenant to portal: " + tenant.email, tenant.id, userProfile?.email, userRole, companyId);
  fetchPortalMembers();
  // Show masked code — full code sent via email only
  const maskedCode = code.slice(0, 2) + "****" + code.slice(-2);
  showToast("Tenant invite created!\n\nA magic link and invite code have been sent to " + tenant.email + ".\n\nCode hint: " + maskedCode + " (full code in their email)\n\n" + tenant.name + " can sign up by selecting 'I'm a Tenant' and entering the code from their email.", "success");
  } catch (e) {
  showToast("Error inviting tenant: " + e.message, "error");
  }
  } finally { guardRelease("inviteTenant"); }
  }

  async function applyLateFeeForTenant(t) {
    if (!guardSubmit("lateFee", t.id)) return;
    try {
      const feeAmount = t.late_fee_type === "percent"
        ? Math.round(safeNum(t.rent) * safeNum(t.late_fee_amount) / 100 * 100) / 100
        : safeNum(t.late_fee_amount);
      if (!feeAmount || feeAmount <= 0) { showToast("No late fee configured for this tenant. Edit the tenant to set a late fee amount.", "error"); return; }
      // Dedup: check if late fee already posted this month
      const thisMonth = formatLocalDate(new Date()).slice(0, 7);
      const { data: existing } = await supabase.from("ledger_entries").select("id").eq("company_id", companyId).eq("tenant_id", t.id).eq("type", "late_fee").gte("date", thisMonth + "-01").limit(1);
      if (existing?.length > 0) { showToast("Late fee already applied for " + t.name + " this month.", "warning"); return; }
      const monthName = new Date().toLocaleString("default", { month: "long", year: "numeric" });
      const feeLabel = t.late_fee_type === "percent" ? `${t.late_fee_amount}% of $${safeNum(t.rent).toLocaleString()} = ${formatCurrency(feeAmount)}` : formatCurrency(feeAmount);
      if (!await showConfirm({ message: `Apply ${feeLabel} late fee to ${t.name} for ${monthName}?` })) return;
      const today = formatLocalDate(new Date());
      const classId = await getPropertyClassId(t.property, companyId);
      const result = await atomicPostJEAndLedger({ companyId,
        date: today,
        description: "Late fee \u2014 " + t.name + " \u2014 " + t.property,
        reference: "LATEFEE-" + t.id + "-" + thisMonth.replace("-", ""),
        property: t.property,
        lines: [
          { account_id: "1100", account_name: "Accounts Receivable", debit: feeAmount, credit: 0, class_id: classId, memo: "Late fee: " + t.name },
          { account_id: "4010", account_name: "Late Fee Income", debit: 0, credit: feeAmount, class_id: classId, memo: monthName + " late fee" },
        ],
        ledgerEntry: { tenant: t.name, tenant_id: t.id, property: t.property, date: today, description: `Late fee \u2014 ${monthName}`, amount: feeAmount, type: "late_fee", balance: 0 },
        balanceUpdate: { tenantId: t.id, amount: feeAmount },
      });
      if (!result.jeId) return;
      showToast(`Late fee ${formatCurrency(feeAmount)} applied to ${t.name}.`, "success");
      addNotification("\u26A0\uFE0F", `Late fee ${formatCurrency(feeAmount)} \u2014 ${t.name}`);
      logAudit("create", "late_fees", `Late fee ${formatCurrency(feeAmount)} for ${t.name}`, t.id, userProfile?.email, userRole, companyId);
      fetchTenants();
      if (selectedTenant?.id === t.id) openLedger(t);
    } finally { guardRelease("lateFee", t.id); }
  }

  function startEdit(t) {
  setEditingTenant(t);
  setForm({ name: t.name, first_name: t.first_name || parseNameParts(t.name).first_name, mi: t.middle_initial || parseNameParts(t.name).middle_initial, last_name: t.last_name || parseNameParts(t.name).last_name, email: t.email, phone: t.phone, property: t.property, lease_status: t.lease_status, lease_start: t.lease_start || t.move_in || "", lease_end: t.lease_end_date || t.move_out || "", rent: t.rent || "", late_fee_amount: t.late_fee_amount || "", late_fee_type: t.late_fee_type || "flat", is_voucher: t.is_voucher || false, voucher_number: t.voucher_number || "", reexam_date: t.reexam_date || "", case_manager_name: t.case_manager_name || "", case_manager_email: t.case_manager_email || "", case_manager_phone: t.case_manager_phone || "", voucher_portion: t.voucher_portion || "", tenant_portion: t.tenant_portion || "" });
  setShowForm(true);
  }

  async function fetchTenantDocs(tenant) {
  const { data } = await supabase.from("documents").select("*").eq("company_id", companyId).ilike("tenant", escapeFilterValue(tenant.name)).is("archived_at", null).order("uploaded_at", { ascending: false }).limit(50);
  setTenantDocs(data || []);
  }

  function exportLedgerPDF(tenant, ledgerData) {
    // All interpolated values go through escapeHtml — a tenant/property
    // name with a stray quote used to break out of the <title> attribute
    // or of tag boundaries when only `<` was replaced. The popup is
    // sandboxed (noopener) but still shown to staff who print ledgers.
    const companyName = escapeHtml(activeCompany?.name || "Property Management");
    const today = acctToday();
    const sorted = [...ledgerData].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const dateFrom = escapeHtml(sorted.length > 0 ? sorted[0].date : today);
    const dateTo = escapeHtml(sorted.length > 0 ? sorted[sorted.length - 1].date : today);
    const rows = sorted.map(e => {
      const isCredit = e.type === "payment" || e.type === "credit";
      const date = escapeHtml(e.date || "");
      const desc = escapeHtml(e.description || "");
      const type = escapeHtml(e.type || "");
      return `<tr><td style="padding:6px 10px;border-bottom:1px solid ${printTheme.borderLight}">${date}</td><td style="padding:6px 10px;border-bottom:1px solid ${printTheme.borderLight}">${desc}</td><td style="padding:6px 10px;border-bottom:1px solid ${printTheme.borderLight};text-transform:capitalize">${type}</td><td style="padding:6px 10px;border-bottom:1px solid ${printTheme.borderLight};text-align:right">${isCredit?"":"$"+Math.abs(safeNum(e.amount)).toFixed(2)}</td><td style="padding:6px 10px;border-bottom:1px solid ${printTheme.borderLight};text-align:right">${isCredit?"$"+Math.abs(safeNum(e.amount)).toFixed(2):""}</td><td style="padding:6px 10px;border-bottom:1px solid ${printTheme.borderLight};text-align:right;font-weight:600">$${safeNum(e.balance).toFixed(2)}</td></tr>`;
    }).join("");
    const totalCharges = sorted.filter(e => e.type !== "payment" && e.type !== "credit").reduce((s, e) => s + Math.abs(safeNum(e.amount)), 0);
    const totalPayments = sorted.filter(e => e.type === "payment" || e.type === "credit").reduce((s, e) => s + Math.abs(safeNum(e.amount)), 0);
    const safeTenantName = escapeHtml(tenant.name || "");
    const safeProperty = escapeHtml(tenant.property || "");
    const html = `<div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="margin:0;font-size:22px;color:${printTheme.inkStrong}">${companyName}</h1>
        <h2 style="margin:4px 0 0;font-size:16px;color:${printTheme.inkMuted};font-weight:normal">Tenant Ledger Statement</h2>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;padding:12px 16px;background:${printTheme.surfaceAlt};border-radius:8px">
        <div><strong>Tenant:</strong> ${safeTenantName}<br><strong>Property:</strong> ${safeProperty}</div>
        <div style="text-align:right"><strong>Period:</strong> ${dateFrom} to ${dateTo}<br><strong>Current Balance:</strong> <span style="color:${safeNum(tenant.balance)>0?"${printTheme.danger}":"${printTheme.success}"};font-weight:bold">$${safeNum(Math.abs(tenant.balance)).toFixed(2)}</span></div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:${printTheme.surfaceMuted}"><th style="padding:8px 10px;text-align:left;border-bottom:2px solid ${printTheme.borderMed}">Date</th><th style="padding:8px 10px;text-align:left;border-bottom:2px solid ${printTheme.borderMed}">Description</th><th style="padding:8px 10px;text-align:left;border-bottom:2px solid ${printTheme.borderMed}">Type</th><th style="padding:8px 10px;text-align:right;border-bottom:2px solid ${printTheme.borderMed}">Charges</th><th style="padding:8px 10px;text-align:right;border-bottom:2px solid ${printTheme.borderMed}">Payments</th><th style="padding:8px 10px;text-align:right;border-bottom:2px solid ${printTheme.borderMed}">Balance</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="background:${printTheme.surfaceMuted};font-weight:bold"><td colspan="3" style="padding:8px 10px;text-align:right">Totals</td><td style="padding:8px 10px;text-align:right;color:${printTheme.danger}">$${totalCharges.toFixed(2)}</td><td style="padding:8px 10px;text-align:right;color:${printTheme.success}">$${totalPayments.toFixed(2)}</td><td style="padding:8px 10px;text-align:right">$${safeNum(Math.abs(tenant.balance)).toFixed(2)}</td></tr></tfoot>
      </table>
      <div style="margin-top:24px;text-align:center;font-size:11px;color:${printTheme.inkSubtle}">Generated on ${escapeHtml(today)} by ${companyName}</div>
    </div>`;
    const w = window.open("", "_blank", "width=900,height=700,noopener,noreferrer");
    w.document.write(`<!DOCTYPE html><html><head><title>Ledger - ${safeTenantName || "Tenant"}</title><style>@media print{body{margin:0}}</style></head><body>${html}</body></html>`);
    w.document.close();
    w.onload = () => setTimeout(() => w.print(), 300);
  }

  async function openLedger(tenant) {
  setSelectedTenant(tenant);
  setActivePanel("detail");
  fetchTenantDocs(tenant);
  // Query by BOTH tenant_id and tenant name to catch entries created before tenant_id existed
  // (e.g., security deposit entries created during property save before tenant record)
  let data = [];
  if (tenant.id) {
  const { data: byId } = await supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant_id", tenant.id).order("date", { ascending: false }).limit(200);
  const { data: byName } = await supabase.from("ledger_entries").select("*").eq("company_id", companyId).ilike("tenant", escapeFilterValue(tenant.name)).is("tenant_id", null).order("date", { ascending: false }).limit(200);
  // Merge and deduplicate by id, sort by date desc
  const merged = {};
  (byId || []).forEach(e => { merged[e.id] = e; });
  (byName || []).forEach(e => { if (!merged[e.id]) merged[e.id] = e; });
  data = Object.values(merged).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  } else {
  const { data: byName } = await supabase.from("ledger_entries").select("*").eq("company_id", companyId).ilike("tenant", escapeFilterValue(tenant.name)).order("date", { ascending: false }).limit(200);
  data = byName || [];
  }
  setLedger(data);
  }

  async function openMessages(tenant) {
  setSelectedTenant(tenant);
  setActivePanel("messages");
  // Prefer tenant_id — the legacy name-based query breaks when two
  // tenants share a name at different properties. Fall back when the
  // row is unindexed (shouldn't happen after the 20260420 migration).
  const q = tenant.id
    ? supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant_id", tenant.id)
    : supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant", tenant.name);
  const { data } = await q.order("created_at", { ascending: true }).limit(200);
  setMessages(data || []);
  // Mark any inbound (tenant-sent) messages read.
  if (tenant.id) {
    const { error: mrErr } = await supabase.from("messages")
      .update({ read_at: new Date().toISOString(), read: true })
      .eq("company_id", companyId)
      .eq("tenant_id", tenant.id)
      .is("read_at", null)
      .eq("sender_role", "tenant");
    if (mrErr) pmError("PM-8006", { raw: mrErr, context: "messages mark read", silent: true });
  }
  }

  async function sendMessage() {
  if (!guardSubmit("sendMessage")) return;
  setSendingMsg(true);
  try {
  if (!selectedTenant) return;
  const body = newMessage.trim();
  if (!body && !msgAttachment) return;
  let attachmentPath = null;
  let attachmentName = null;
  if (msgAttachment) {
    attachmentPath = await uploadMessageAttachment(msgAttachment, companyId);
    if (!attachmentPath) { if (showToast) showToast("Attachment upload failed.", "error"); return; }
    attachmentName = msgAttachment.name;
  }
  const { data: inserted, error: _err_messages_1499 } = await supabase.from("messages").insert([{
    company_id: companyId,
    tenant_id: selectedTenant.id,
    tenant: selectedTenant.name,
    property: selectedTenant.property,
    sender: userProfile?.name || "admin",
    sender_email: userProfile?.email || null,
    sender_role: "admin",
    message: body,
    attachment_url: attachmentPath,
    attachment_name: attachmentName,
    read: false,
    read_at: null,
  }]).select("id").maybeSingle();
  if (_err_messages_1499) { pmError("PM-8006", { raw: _err_messages_1499, context: "send tenant message" }); return; }
  setNewMessage("");
  setMsgAttachment(null);
  // Ping the tenant via the notification pipeline. Cheap and best-effort.
  if (selectedTenant.email) {
    await queueNotification("message_received", selectedTenant.email, {
      sender: userProfile?.name || "Property Manager",
      preview: body ? body.slice(0, 120) : (attachmentName ? "[attachment: " + attachmentName + "]" : ""),
      tenant: selectedTenant.name,
      property: selectedTenant.property,
    }, companyId);
  }
  logAudit("create", "messages", "Sent message to " + selectedTenant.name, inserted?.id, userProfile?.email, userRole, companyId);
  const { data } = await supabase.from("messages").select("*")
    .eq("company_id", companyId)
    .eq("tenant_id", selectedTenant.id)
    .order("created_at", { ascending: true });
  setMessages(data || []);
  } finally {
    setSendingMsg(false);
    guardRelease("sendMessage");
  }
  }

  async function addLedgerEntry() {
  if (!guardSubmit("addLedgerEntry")) return;
  try {
  if (!newCharge.description || !newCharge.amount) return;
  // #4: Late fees are positive charges (increase balance), not negative like payments
  const isCredit = newCharge.type === "payment" || newCharge.type === "credit";
  const amount = isCredit ? -Math.abs(Number(newCharge.amount)) : Math.abs(Number(newCharge.amount));
  const today = formatLocalDate(new Date());
  const classId = await getPropertyClassId(selectedTenant.property, companyId);
  const ledgerData = { tenant: selectedTenant.name, property: selectedTenant.property, date: today, description: newCharge.description, amount, type: newCharge.type, balance: 0 };
  const balData = { tenantId: selectedTenant.id, amount };
  // JE lines depend on charge type
  let jeLines;
  let jeDesc;
  if (newCharge.type === "charge") {
  jeDesc = "Manual charge \u2014 " + selectedTenant.name + " \u2014 " + newCharge.description;
  jeLines = [
  { account_id: "1100", account_name: "Accounts Receivable", debit: Math.abs(amount), credit: 0, class_id: classId, memo: selectedTenant.name + ": " + newCharge.description },
  { account_id: "4100", account_name: "Other Income", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
  ];
  } else if (newCharge.type === "late_fee") {
  jeDesc = "Late fee \u2014 " + selectedTenant.name + " \u2014 " + newCharge.description;
  jeLines = [
  { account_id: "1100", account_name: "Accounts Receivable", debit: Math.abs(amount), credit: 0, class_id: classId, memo: "Late fee: " + selectedTenant.name },
  { account_id: "4010", account_name: "Late Fee Income", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
  ];
  } else {
  jeDesc = "Manual " + newCharge.type + " \u2014 " + selectedTenant.name + " \u2014 " + newCharge.description;
  jeLines = [
  { account_id: "1000", account_name: "Checking Account", debit: Math.abs(amount), credit: 0, class_id: classId, memo: selectedTenant.name + ": " + newCharge.description },
  { account_id: "1100", account_name: "Accounts Receivable", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
  ];
  }
  // Unified: JE first → ledger → balance (all gated on JE success)
  const result = await atomicPostJEAndLedger({ companyId,
  date: today, description: jeDesc, reference: "MANUAL-" + shortId(), property: selectedTenant.property || "",
  lines: jeLines,
  ledgerEntry: ledgerData,
  balanceUpdate: balData,
  });
  if (!result.jeId) return; // toast already shown by postAccountingTransaction
  // Fetch fresh tenant data to avoid stale closure state
  const { data: freshTenant } = await supabase.from("tenants").select("*").eq("id", selectedTenant.id).eq("company_id", companyId).maybeSingle();
  if (freshTenant) setSelectedTenant(freshTenant);
  setNewCharge({ description: "", amount: "", type: "charge" });
  openLedger(freshTenant || selectedTenant);
  fetchTenants();
  } finally { guardRelease("addLedgerEntry"); }
  }

  async function renewLease(newMoveOut) {
  if (!guardSubmit("renewLease")) return;
  try {
  if (!newMoveOut) return;
  if (!selectedTenant?.id) return;
  const { error } = await supabase.from("tenants").update({ move_out: newMoveOut, lease_end_date: newMoveOut, lease_status: "active" }).eq("company_id", companyId).eq("id", selectedTenant.id);
  if (error) { pmError("PM-3004", { raw: error, context: "renew lease" }); return; }
  // #4: Update active lease end_date if one exists, or create one
  const { data: activeLease, error: leaseErr } = await supabase.from("leases").select("id, rent_amount").eq("company_id", companyId).eq("tenant_name", selectedTenant.name).eq("status", "active").limit(1);
  if (leaseErr) { showToast("Lease lookup failed: " + leaseErr.message, "error"); }
  if (activeLease?.[0]) {
  const { error: leaseUpErr } = await supabase.from("leases").update({ end_date: newMoveOut }).eq("company_id", companyId).eq("id", activeLease[0].id);
  if (leaseUpErr) showToast("Lease update failed: " + leaseUpErr.message, "error");
  } else if (selectedTenant.property && selectedTenant.rent) {
  const { error: leaseInsErr } = await supabase.from("leases").insert([{ company_id: companyId, tenant_name: selectedTenant.name, tenant_id: selectedTenant.id, property: selectedTenant.property, start_date: formatLocalDate(new Date()), end_date: newMoveOut, rent_amount: safeNum(selectedTenant.rent), status: "active", payment_due_day: 1 }]);
  if (leaseInsErr) showToast("Lease creation failed: " + leaseInsErr.message, "error");
  }
  // Update property lease_end
  if (selectedTenant.property) {
  await supabase.from("properties").update({ lease_end: newMoveOut }).eq("company_id", companyId).eq("address", selectedTenant.property);
  }
  // #4: Sync autopay schedule end_date
  await supabase.from("autopay_schedules").update({ end_date: newMoveOut }).eq("company_id", companyId).eq("tenant", selectedTenant.name);
  addNotification("\u{1F4C4}", `Lease extended for ${selectedTenant.name} until ${newMoveOut}`);
  logAudit("update", "tenants", `Lease renewed for ${selectedTenant.name} until ${newMoveOut}`, selectedTenant.id, userProfile?.email, userRole, companyId);
  setLeaseModal(null);
  fetchTenants();
  setSelectedTenant({ ...selectedTenant, move_out: newMoveOut, lease_status: "active" });
  } finally { guardRelease("renewLease"); }
  }

  async function generateMoveOutNotice(days) {
  if (!guardSubmit("generateMoveOutNotice")) return;
  try {
  if (!days || !selectedTenant?.id) return;
  const noticeDate = new Date();
  noticeDate.setDate(noticeDate.getDate() + parseInt(days));
  const moveOutDate = formatLocalDate(noticeDate);
  const { error } = await supabase.from("tenants").update({ lease_status: "notice", move_out: moveOutDate }).eq("company_id", companyId).eq("id", selectedTenant.id);
  if (error) { pmError("PM-3006", { raw: error, context: "generate move-out notice" }); return; }
  // #8: Also update lease status to reflect notice
  const { error: leaseErr } = await supabase.from("leases").update({ status: "notice" }).eq("company_id", companyId).eq("tenant_name", selectedTenant.name).eq("status", "active");
  if (leaseErr) showToast("Lease status update failed: " + leaseErr.message, "error");
  addNotification("\u{1F4CB}", `${days}-day move-out notice generated for ${selectedTenant.name}`);
  logAudit("update", "tenants", `${days}-day notice issued for ${selectedTenant.name}`, selectedTenant.id, userProfile?.email, userRole, companyId);
  setLeaseModal(null);
  fetchTenants();
  } finally { guardRelease("generateMoveOutNotice"); }
  }

  function closePanel() {
  setActivePanel(null);
  setSelectedTenant(null);
  setLedger([]);
  setMessages([]);
  }

  function openLeaseForSigning(tenant) {
  // Open in new tab with signing canvas
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
  <title>Lease Agreement \u2014 ${escapeHtml(tenant.name)}</title>
  <style>
  body { font-family: Arial, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: ${printTheme.inkStrong}; }
  h1 { text-align: center; color: ${printTheme.signatureInk}; border-bottom: 2px solid ${printTheme.signatureInk}; padding-bottom: 10px; }
  h2 { color: ${printTheme.signatureInk}; margin-top: 30px; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; }
  .field { background: ${printTheme.surfaceMuted}; border: 1px solid ${printTheme.borderLight}; padding: 8px 12px; margin: 5px 0; border-radius: 4px; }
  .clause { margin: 10px 0; font-size: 13px; line-height: 1.6; }
  .signature-section { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; }
  canvas { border: 2px solid ${printTheme.inkStrong}; border-radius: 4px; cursor: crosshair; background: white; }
  .btn { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .btn-primary { background: ${printTheme.brand}; color: white; }
  .btn-clear { background: ${printTheme.borderLight}; color: ${printTheme.inkStrong}; }
  .signed-badge { display:none; background: ${printTheme.success}; color: white; padding: 6px 16px; border-radius: 20px; font-weight: bold; }
  @media print { .no-print { display: none; } }
  </style>
  </head>
  <body>
  <h1>RESIDENTIAL LEASE AGREEMENT</h1>
  <p style="text-align:center;color:${printTheme.inkMuted};">Generated on ${new Date().toLocaleDateString()}</p>
  <h2>Parties</h2>
  <div class="field"><strong>Tenant:</strong> ${escapeHtml(tenant.name)}</div>
  <div class="field"><strong>Email:</strong> ${escapeHtml(tenant.email)}</div>
  <div class="field"><strong>Property:</strong> ${escapeHtml(tenant.property)}</div>
  <h2>Lease Terms</h2>
  <div class="field"><strong>Monthly Rent:</strong> $${escapeHtml(String(tenant.rent))}/month</div>
  <div class="field"><strong>Move-In Date:</strong> ${escapeHtml(tenant.move_in || "\u2014")}</div>
  <div class="field"><strong>Move-Out Date:</strong> ${escapeHtml(tenant.move_out || "\u2014")}</div>
  <h2>Terms & Conditions</h2>
  <div class="clause">1. <strong>Rent Payment.</strong> Tenant agrees to pay $${escapeHtml(String(tenant.rent))} per month on the 1st of each month. A late fee will be applied after the grace period.</div>
  <div class="clause">2. <strong>Security Deposit.</strong> A security deposit equal to one month's rent is required prior to occupancy and will be returned within " + (companySettings?.deposit_return_days || 30) + " days of move-out, less any deductions for damages.</div>
  <div class="clause">3. <strong>Property Use.</strong> The property shall be used solely as a private residence. No illegal activities are permitted on the premises.</div>
  <div class="clause">4. <strong>Maintenance.</strong> Tenant is responsible for minor maintenance. Landlord is responsible for major repairs.</div>
  <div class="clause">5. <strong>Entry.</strong> Landlord may enter the property with 24-hour notice for inspections, repairs, or showings.</div>
  <div class="clause">6. <strong>Termination.</strong> Either party may terminate this lease with " + (companySettings?.termination_notice_days || 30) + " days written notice.</div>
  <div class="signature-section">
  <div>
  <h2>Landlord Signature</h2>
  <canvas id="landlord-canvas" width="320" height="100"></canvas>
  <div class="no-print" style="margin-top:8px;display:flex;gap:8px;">
  <button class="btn btn-clear" onclick="clearCanvas('landlord-canvas')">Clear</button>
  </div>
  </div>
  <div>
  <h2>Tenant Signature</h2>
  <canvas id="tenant-canvas" width="320" height="100"></canvas>
  <div class="no-print" style="margin-top:8px;display:flex;gap:8px;">
  <button class="btn btn-clear" onclick="clearCanvas('tenant-canvas')">Clear</button>
  </div>
  </div>
  </div>
  <div class="no-print" style="text-align:center;margin-top:30px;display:flex;gap:12px;justify-content:center;">
  <button class="btn btn-primary" onclick="saveAndPrint()">✓ Sign & Save as PDF</button>
  <button class="btn btn-clear" onclick="window.print()">\u{1F5A8}\uFE0F Print</button>
  </div>
  <div id="signed-badge" class="signed-badge" style="text-align:center;margin-top:20px;">✅ SIGNED — ${new Date().toLocaleDateString()}</div>
  <script>
  function makeDrawable(canvasId) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  let drawing = false;
  canvas.addEventListener('mousedown', e => { drawing = true; ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); });
  canvas.addEventListener('mousemove', e => { if (!drawing) return; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '${printTheme.signatureInk}'; ctx.lineTo(e.offsetX, e.offsetY); ctx.stroke(); });
  canvas.addEventListener('mouseup', () => drawing = false);
  canvas.addEventListener('mouseleave', () => drawing = false);
  // Touch support
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; const r = canvas.getBoundingClientRect(); ctx.beginPath(); ctx.moveTo(e.touches[0].clientX - r.left, e.touches[0].clientY - r.top); });
  canvas.addEventListener('touchmove', e => { e.preventDefault(); if (!drawing) return; const r = canvas.getBoundingClientRect(); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '${printTheme.signatureInk}'; ctx.lineTo(e.touches[0].clientX - r.left, e.touches[0].clientY - r.top); ctx.stroke(); });
  canvas.addEventListener('touchend', () => drawing = false);
  }
  function clearCanvas(id) { const c = document.getElementById(id); c.getContext('2d').clearRect(0, 0, c.width, c.height); }
  function saveAndPrint() {
  document.getElementById('signed-badge').style.display = 'block';
  setTimeout(() => window.print(), 300);
  }
  makeDrawable('landlord-canvas');
  makeDrawable('tenant-canvas');
  </script>
  </body>
  </html>
  `;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const safeWin = window.open(url, "_blank", "noopener,noreferrer");
  if (safeWin) safeWin.onload = () => URL.revokeObjectURL(url);
  }

  if (loading) return <Spinner />;

  return (
  <div>
  {activePanel && selectedTenant && activePanel === "lease" && (
  <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
  <div className="bg-white w-full max-w-lg h-full flex flex-col shadow-2xl">
  <div className="px-5 py-4 border-b border-brand-50 flex items-center justify-between bg-brand-600 text-white">
  <div>
  <div className="font-bold">{selectedTenant.name}</div>
  <div className="text-xs text-brand-200">{selectedTenant.property}</div>
  </div>
  <IconBtn icon="close" onClick={closePanel} className="text-brand-200 hover:text-white" />
  </div>
  <div className="flex border-b border-brand-50">
  {[["ledger", "\u{1F4D2} Ledger"], ["messages", "\u{1F4AC} Messages"], ["lease", "\u{1F4C4} Lease"]].map(([id, label]) => (
  <button key={id} onClick={() => {
  setActivePanel(id);
  if (id === "ledger") openLedger(selectedTenant);
  if (id === "messages") openMessages(selectedTenant);
  }} className={`flex-1 py-2.5 text-xs font-medium ${activePanel === id ? "border-b-2 border-brand-600 text-brand-700" : "text-neutral-400 hover:text-neutral-700"}`}>{label}</button>
  ))}
  </div>

  {/* LEDGER */}
  {activePanel === "ledger" && (
  <div className="flex-1 overflow-y-auto p-4">
  <div className={`rounded-3xl p-4 mb-4 text-center relative ${safeNum(selectedTenant?.balance) > 0 ? "bg-danger-50" : safeNum(selectedTenant?.balance) < 0 ? "bg-positive-50" : "bg-brand-50/30"}`}>
  <button onClick={() => exportLedgerPDF(selectedTenant, ledger)} className="absolute top-3 right-3 text-xs text-danger-600 border border-danger-200 bg-white px-3 py-1.5 rounded-lg hover:bg-danger-50 flex items-center gap-1" title="Export ledger as PDF for sharing"><span className="material-icons-outlined text-sm">picture_as_pdf</span>Export PDF</button>
  <div className="text-xs text-neutral-400 mb-1">Current Balance</div>
  <div className={`text-3xl font-bold ${safeNum(selectedTenant?.balance) > 0 ? "text-danger-500" : safeNum(selectedTenant?.balance) < 0 ? "text-positive-600" : "text-neutral-700"}`}>
  {safeNum(selectedTenant?.balance) > 0 ? `-${formatCurrency(selectedTenant.balance)}` : safeNum(selectedTenant?.balance) < 0 ? `Credit ${formatCurrency(Math.abs(selectedTenant.balance))}` : "$0 Current"}
  </div>
  {safeNum(selectedTenant?.balance) > 0 && safeNum(selectedTenant?.late_fee_amount) > 0 && (
  <button onClick={() => applyLateFeeForTenant(selectedTenant)} className="mt-2 w-full text-xs bg-danger-50 text-danger-700 border border-danger-200 rounded-lg px-3 py-2 hover:bg-danger-100 font-semibold flex items-center justify-center gap-1"><span className="material-icons-outlined text-sm">gavel</span>Apply Late Fee ({selectedTenant.late_fee_type === "percent" ? selectedTenant.late_fee_amount + "%" : formatCurrency(selectedTenant.late_fee_amount)})</button>
  )}
  </div>
  <div className="bg-brand-50/30 rounded-xl p-3 mb-4">
  <div className="text-xs font-semibold text-neutral-500 mb-2">Add Transaction</div>
  <div className="grid grid-cols-3 gap-2">
  <Select value={newCharge.type} onChange={e => setNewCharge({ ...newCharge, type: e.target.value })}>
  <option value="charge">Charge</option>
  <option value="payment">Payment</option>
  <option value="credit">Credit</option>
  <option value="late_fee">Late Fee</option>
  </Select>
  <Input placeholder="e.g. Rent, Late fee, Repair" value={newCharge.description} title="Description" onChange={e => setNewCharge({ ...newCharge, description: e.target.value })} className="text-xs" />
  <Input placeholder="0.00" value={newCharge.amount} title="Amount ($)" onChange={e => setNewCharge({ ...newCharge, amount: e.target.value })} className="text-xs" />
  </div>
  <Btn size="sm" className="mt-2 w-full" onClick={addLedgerEntry}>Add Transaction</Btn>
  </div>
  <div className="space-y-2">
  {ledger.map(e => (
  <div key={e.id} className="bg-white border border-brand-50 rounded-lg px-3 py-2.5">
  <div className="flex justify-between items-start">
  <div>
  <div className="text-sm font-medium text-neutral-800">{e.description}</div>
  <div className="text-xs text-neutral-400">{e.date}</div>
  </div>
  <div className="text-right">
  <div className={`text-sm font-bold ${e.type === "payment" || e.type === "credit" ? "text-positive-600" : "text-danger-500"}`}>
  {e.type === "payment" || e.type === "credit" ? "+" + formatCurrency(Math.abs(e.amount)) : "-" + formatCurrency(Math.abs(e.amount))}
  </div>
  <div className="text-xs text-neutral-400">Bal: ${e.balance}</div>
  </div>
  </div>
  </div>
  ))}
  {ledger.length === 0 && <div className="text-center py-6 text-neutral-400 text-sm">No ledger entries yet</div>}
  </div>
  </div>
  )}

  {/* MESSAGES */}
  {activePanel === "messages" && (
  <div className="flex-1 flex flex-col overflow-hidden">
  <MessageThread
    messages={messages}
    viewerRole={userRole || "admin"}
    viewerName={userProfile?.name || "You"}
    emptyLabel="No messages yet"
  />
  <MessageComposer
    value={newMessage}
    onChange={setNewMessage}
    onSend={sendMessage}
    sending={sendingMsg}
    attachment={msgAttachment}
    onAttachmentChange={setMsgAttachment}
    showToast={showToast}
    placeholder={"Message " + selectedTenant.name + "…"}
  />
  </div>
  )}

  {/* LEASE */}
  {activePanel === "lease" && (
  <div className="flex-1 overflow-y-auto p-4">
  <div className="bg-white border border-brand-50 rounded-3xl p-4 mb-4">
  <h4 className="font-semibold text-neutral-700 mb-3">Lease Details</h4>
  <div className="space-y-2 text-sm">
  {[
  ["Tenant", selectedTenant.name],
  ["Property", selectedTenant.property],
  ["Monthly Rent", selectedTenant.rent ? `${formatCurrency(selectedTenant.rent)}/mo` : "\u2014"],
  ["Move-In Date", selectedTenant.move_in || "\u2014"],
  ["Move-Out Date", selectedTenant.move_out || "\u2014"],
  ["Lease Status", selectedTenant.lease_status],
  ].map(([l, v]) => (
  <div key={l} className="flex justify-between py-1.5 border-b border-brand-50/50">
  <span className="text-neutral-400">{l}</span>
  <span className="font-medium text-neutral-800 capitalize">{v}</span>
  </div>
  ))}
  </div>
  </div>
  {leaseModal === "renew" && (
  <div className="bg-brand-50 rounded-3xl p-4 mb-3 border border-brand-100">
  <div className="text-sm font-semibold text-brand-700 mb-2">Enter New Lease End Date</div>
  <Input type="date" value={leaseInput} onChange={e => setLeaseInput(e.target.value)} className="mb-2" />
  <div className="flex gap-2">
  <Btn variant="primary" size="sm" onClick={() => renewLease(leaseInput)}>Confirm Renewal</Btn>
  <Btn variant="ghost" size="sm" onClick={() => setLeaseModal(null)}>Cancel</Btn>
  </div>
  </div>
  )}
  {leaseModal === "notice" && (
  <div className="bg-notice-50 rounded-3xl p-4 mb-3 border border-notice-100">
  <div className="text-sm font-semibold text-notice-700 mb-2">Select Notice Period</div>
  <div className="flex gap-2 mb-2">
  <button onClick={() => setLeaseInput("30")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${leaseInput === "30" ? "bg-notice-500 text-white" : "bg-white border border-notice-200 text-notice-700"}`}>30 Days</button>
  <button onClick={() => setLeaseInput("60")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${leaseInput === "60" ? "bg-notice-500 text-white" : "bg-white border border-notice-200 text-notice-700"}`}>60 Days</button>
  </div>
  <div className="flex gap-2">
  <Btn variant="warning-fill" size="sm" onClick={() => generateMoveOutNotice(leaseInput)}>Generate Notice</Btn>
  <Btn variant="ghost" size="sm" onClick={() => setLeaseModal(null)}>Cancel</Btn>
  </div>
  </div>
  )}
  <div className="space-y-2">
  <button onClick={() => openLeaseForSigning(selectedTenant)} className="w-full flex items-center justify-between bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-2xl px-4 py-3 text-left">
  <div>
  <div className="text-sm font-medium text-brand-800">✍️ Generate & E-Sign Lease</div>
  <div className="text-xs text-brand-400">Opens PDF with signature canvas</div>
  </div>
  <span className="text-brand-300">→</span>
  </button>
  {[
  { label: "\u{1F504} Renew Lease", desc: "Extend lease term", modal: "renew" },
  { label: "\u{1F4CB} Generate Move-Out Notice", desc: "30/60 day notice", modal: "notice" },
  ].map(item => (
  <button key={item.label} onClick={() => { setLeaseModal(item.modal); setLeaseInput(""); }} className="w-full flex items-center justify-between bg-brand-50/30 hover:bg-brand-50 border border-brand-50 hover:border-brand-200 rounded-2xl px-4 py-3 text-left">
  <div>
  <div className="text-sm font-medium text-neutral-800">{item.label}</div>
  <div className="text-xs text-neutral-400">{item.desc}</div>
  </div>
  <span className="text-neutral-300">→</span>
  </button>
  ))}
  </div>
  </div>
  )}
  </div>
  </div>
  )}

  {/* ===== TENANT DETAIL VIEW ===== */}
  {selectedTenant && ["detail","ledger","documents","messages","actions"].includes(activePanel) && (
  <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex justify-end">
  <div className="bg-white w-full max-w-lg h-full flex flex-col shadow-2xl overflow-y-auto">
  {/* Header */}
  <div className="bg-gradient-to-r from-brand-600 to-brand-800 p-6 text-white">
  <div className="flex items-center justify-between">
  <div className="flex items-center gap-4">
  <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center text-2xl font-bold">{selectedTenant.name?.[0]}</div>
  <div>
  <h2 className="text-xl font-bold">{selectedTenant.name}</h2>
  <div className="text-brand-200 text-sm">{selectedTenant.property}</div>
  </div>
  </div>
  <IconBtn icon="close" onClick={() => { setSelectedTenant(null); setActivePanel(null); }} className="text-white/70 hover:text-white" />
  </div>
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs text-brand-200">Rent</div><div className="text-lg font-bold">{selectedTenant.rent ? formatCurrency(selectedTenant.rent) : "\u2014"}</div></div>
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs text-brand-200">Balance</div><div className={"text-lg font-bold " + (selectedTenant.balance > 0 ? "text-danger-300" : "text-positive-300")}>{selectedTenant.balance > 0 ? formatCurrency(selectedTenant.balance) : "Current"}</div></div>
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs text-brand-200">Status</div><div className="text-lg font-bold capitalize">{selectedTenant.lease_status}</div></div>
  <div className="bg-white/10 rounded-2xl px-3 py-2 text-center"><div className="text-xs text-brand-200">Lease End</div><div className="text-lg font-bold">{selectedTenant.lease_end_date || selectedTenant.move_out || "\u2014"}</div></div>
  </div>
  {selectedTenant.is_voucher && (
  <div className="mt-3 bg-white/10 rounded-2xl px-4 py-3">
  <div className="flex items-center gap-2 mb-2"><span className="text-xs bg-highlight-400 text-white px-2 py-0.5 rounded-full font-bold">VOUCHER</span><span className="text-sm text-brand-200">{selectedTenant.voucher_number || ""}</span></div>
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
  <div><span className="text-brand-300">Voucher Portion</span><div className="font-bold text-white">{formatCurrency(selectedTenant.voucher_portion || 0)}</div></div>
  <div><span className="text-brand-300">Tenant Portion</span><div className="font-bold text-white">{formatCurrency(selectedTenant.tenant_portion || 0)}</div></div>
  <div><span className="text-brand-300">Re-exam Date</span><div className="font-bold text-white">{selectedTenant.reexam_date || "\u2014"}</div></div>
  <div><span className="text-brand-300">Case Manager</span><div className="font-bold text-white">{selectedTenant.case_manager_name || "\u2014"}</div></div>
  </div>
  </div>
  )}
  </div>

  {/* Contact Info */}
  <div className="px-6 py-4 border-b border-brand-50">
  <div className="space-y-2 text-sm">
  <div><span className="text-xs text-neutral-400 block">Email</span><a href={"mailto:" + selectedTenant.email} className="text-brand-600 hover:underline break-all">{selectedTenant.email || "\u2014"}</a></div>
  <div className="grid grid-cols-2 gap-3">
  <div><span className="text-xs text-neutral-400 block">Phone</span><a href={"tel:" + selectedTenant.phone} className="text-brand-600 hover:underline">{selectedTenant.phone || "\u2014"}</a></div>
  <div><span className="text-xs text-neutral-400 block">Lease Start</span><span className="text-neutral-700">{selectedTenant.lease_start || selectedTenant.move_in || "\u2014"}</span></div>
  </div>
  </div>
  </div>

  {/* Tab navigation */}
  <div className="flex border-b border-brand-50 px-6 overflow-x-auto">
  {[["ledger","Ledger"],["documents","Documents"],["messages","Messages"],["actions","Actions"]].map(([id, label]) => (
  <button key={id} onClick={() => { setActivePanel(id); if (id === "documents" && selectedTenant) fetchTenantDocs(selectedTenant); if (id === "ledger" && selectedTenant) openLedger(selectedTenant); if (id === "messages" && selectedTenant) openMessages(selectedTenant); }} className={"px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap " + ((activePanel === id || (id === "ledger" && activePanel === "detail")) ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-500")}>{label}</button>
  ))}
  </div>

  {/* Tab content */}
  <div className="px-6 py-4 flex-1 overflow-y-auto">

  {/* Ledger tab (default) */}
  {(activePanel === "detail" || activePanel === "ledger") && (
  <div>
  <div className="flex items-center justify-between mb-3">
  <h3 className="text-sm font-semibold text-neutral-700">Transaction History</h3>
  <Btn variant="primary" size="sm" onClick={() => setPage("accounting", "newJE")}><span className="material-icons-outlined text-sm">add_circle</span>New Entry</Btn>
  </div>
  {ledger.length === 0 ? <div className="text-center py-6 text-neutral-400 text-sm">No transactions yet</div> : (
  <div className="space-y-1">
  {ledger.slice(0, 20).map((e, i) => (
  <div key={i} className="flex items-center justify-between py-2 border-b border-brand-50/50 text-sm">
  <div><div className="font-medium text-neutral-700">{e.description}</div><div className="text-xs text-neutral-400">{e.date}</div></div>
  <div className={"font-semibold " + (e.type === "payment" || e.type === "credit" ? "text-positive-600" : "text-danger-500")}>{e.type === "payment" || e.type === "credit" ? "+" : "-"}{formatCurrency(Math.abs(e.amount))}</div>
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* Documents tab */}
  {activePanel === "documents" && (
  <div>
  <h3 className="text-sm font-semibold text-neutral-700 mb-3">Tenant Documents</h3>
  {/* Required docs checklist */}
  <div className="bg-warn-50 border border-warn-200 rounded-xl p-3 mb-4">
  <div className="text-xs font-bold text-warn-800 mb-2">Required Documents</div>
  {REQUIRED_TENANT_DOCS.map(({ label, match }) => {
  const uploaded = tenantDocs.some(d => {
    const n = (d.name || "").toLowerCase();
    const t = (d.type || "").toLowerCase();
    return match.some(m => n.includes(m) || t.includes(m));
  });
  return (
  <div key={label} className="flex items-center gap-2 py-1 text-sm">
  <span className={uploaded ? "text-positive-500" : "text-warn-400"}>{uploaded ? "\u2705" : "\u2610"}</span>
  <span className={uploaded ? "text-neutral-700" : "text-warn-700"}>{label}</span>
  {uploaded && <span className="text-xs text-positive-600 bg-positive-50 px-2 py-0.5 rounded-full">Uploaded</span>}
  </div>
  );
  })}
  </div>
  {/* Uploaded docs list */}
  {tenantDocs.length === 0 ? <div className="text-center py-4 text-neutral-400 text-sm">No documents uploaded for this tenant</div> : (
  <div className="space-y-2">
  {tenantDocs.map(d => (
  <div key={d.id} className="flex items-center justify-between bg-neutral-50 rounded-lg px-4 py-3 hover:bg-neutral-100 transition-colors">
  <div className="flex items-center gap-3">
  <span className="material-icons-outlined text-neutral-400 text-lg">{d.type === "Lease" ? "description" : d.type === "ID" ? "badge" : d.type === "Insurance" ? "verified_user" : d.type === "Inspection" ? "search" : "insert_drive_file"}</span>
  <div>
  <div className="text-sm font-medium text-neutral-700">{d.name}</div>
  <div className="text-xs text-neutral-400">{d.type} · {d.uploaded_at?.slice(0, 10)}</div>
  </div>
  </div>
  <div className="flex items-center gap-2">
  <TextLink tone="brand" size="xs" onClick={async () => { const url = await getSignedUrl("documents", d.file_name || d.url); if (url) window.open(url, "_blank", "noopener,noreferrer"); }} className="flex items-center gap-1"><span className="material-icons-outlined text-sm">open_in_new</span>View</TextLink>
  {userRole !== "tenant" && <TextLink tone="danger" size="xs" underline={false} onClick={async () => {
  if (!await showConfirm({ message: `Delete document "${d.name}"?\n\nThis will remove the document from active views. It can be recovered within 180 days.`, variant: "danger", confirmText: "Delete" })) return;
  const { error } = await supabase.from("documents").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", d.id).eq("company_id", companyId);
  if (error) { pmError("PM-7004", { raw: error, context: "delete document" }); return; }
  if (selectedTenant?.name) await recomputeTenantDocStatus(companyId, selectedTenant.name);
  showToast("Document deleted: " + d.name, "success");
  logAudit("delete", "documents", "Deleted document: " + d.name + " (tenant: " + (selectedTenant?.name || "") + ")", d.id, userProfile?.email, userRole, companyId);
  fetchTenantDocs(selectedTenant);
  }}  title="Delete document" className="flex items-center gap-1"><span className="material-icons-outlined text-sm">delete</span>Delete</TextLink>}
  </div>
  </div>
  ))}
  </div>
  )}
  <Btn variant="primary" size="sm" className="mt-3" onClick={() => setShowDocUpload({ property: selectedTenant?.property || "", tenant: selectedTenant?.name || "" })}>Upload Documents</Btn>
  </div>
  )}

  {/* Messages tab */}
  {activePanel === "messages" && (
  <div className="flex flex-col" style={{ minHeight: "400px" }}>
  <h3 className="text-sm font-semibold text-neutral-700 mb-3">Messages</h3>
  <div className="flex-1 flex flex-col rounded-2xl border border-neutral-200 overflow-hidden" style={{ minHeight: "300px", maxHeight: "60vh" }}>
  <MessageThread
    messages={messages}
    viewerRole={userRole || "admin"}
    viewerName={userProfile?.name || "You"}
    emptyLabel="No messages yet"
  />
  <MessageComposer
    value={newMessage}
    onChange={setNewMessage}
    onSend={sendMessage}
    sending={sendingMsg}
    attachment={msgAttachment}
    onAttachmentChange={setMsgAttachment}
    showToast={showToast}
    placeholder={"Message " + selectedTenant.name + "…"}
  />
  </div>
  </div>
  )}

  {/* Actions tab */}
  {activePanel === "actions" && (
  <div className="grid grid-cols-2 gap-3">
  <button onClick={() => startEdit(selectedTenant)} className="bg-brand-50/30 rounded-3xl p-4 text-center hover:bg-brand-50/50 transition-all">
  <div className="text-2xl mb-1">✏️</div><div className="text-sm font-semibold text-neutral-700">Edit Tenant</div>
  </button>
  <button onClick={() => inviteTenant(selectedTenant)} className="bg-highlight-50 rounded-3xl p-4 text-center hover:bg-highlight-100 transition-all">
  <div className="text-2xl mb-1">✉️</div><div className="text-sm font-semibold text-highlight-700">Send Invite</div>
  </button>
  <button onClick={() => { setLeaseModal("renew"); setLeaseInput(""); }} className="bg-positive-50 rounded-3xl p-4 text-center hover:bg-positive-100 transition-all">
  <div className="text-2xl mb-1">{"\u{1F504}"}</div><div className="text-sm font-semibold text-positive-700">Renew Lease</div>
  </button>
  <button onClick={() => setPage("moveout")} className="bg-notice-50 rounded-3xl p-4 text-center hover:bg-notice-100 transition-all">
  <div className="text-2xl mb-1"><span className="material-icons-outlined text-notice-600">exit_to_app</span></div><div className="text-sm font-semibold text-notice-700">Move-Out</div>
  </button>
  <button onClick={() => deleteTenant(selectedTenant.id, selectedTenant.name)} className="bg-danger-50 rounded-3xl p-4 text-center hover:bg-danger-100 transition-all">
  <div className="text-2xl mb-1">{"\u{1F4E6}"}</div><div className="text-sm font-semibold text-danger-700">Archive Tenant</div>
  </button>
  </div>
  )}
  </div>
  </div>
  </div>
  )}

  {/* Tab Navigation */}
  <div className="flex flex-col md:flex-row md:items-center gap-2 mb-4 border-b border-brand-50 pb-3">
  <h2 className="text-xl md:text-2xl font-bold text-subtle-800">Tenants</h2>
  <div className="flex gap-1 overflow-x-auto pb-1">
  {[["tenants", "Tenants"], ["leases", "Leases"], ["moveout", "Move-Out"], ["evictions", "Evictions"], ["archived", "Archived"]].map(([id, label]) => (
  <button key={id} onClick={() => { setTenantTab(id); setTenantSearch(""); if (id === "archived") { supabase.from("tenants").select("*").eq("company_id", companyId).not("archived_at", "is", null).order("archived_at", { ascending: false }).limit(200).then(({ data }) => setArchivedTenants(data || [])); } }} className={"px-3 py-1.5 text-xs font-medium rounded-lg " + (tenantTab === id ? "bg-brand-600 text-white" : "bg-subtle-100 text-subtle-600 hover:bg-subtle-200")}>{label}</button>
  ))}
  </div>
  </div>

  {tenantTab === "leases" && <LeaseManagement addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} showToast={showToast} showConfirm={showConfirm} />}
  {tenantTab === "archived" && (
  <div>
  {archivedTenants.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-subtle-100"><div className="text-subtle-400">No archived tenants</div><TextLink tone="brand" size="xs" underline={false} onClick={async () => { if (!guardSubmit("refreshArchived")) return; try { const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId).not("archived_at", "is", null).order("archived_at", { ascending: false }).limit(200); setArchivedTenants(data || []); } finally { guardRelease("refreshArchived"); } }} className="mt-2 hover:underline">Refresh</TextLink></div>
  ) : archivedTenants.map(t => (
  <div key={t.id} className="bg-white rounded-xl border border-subtle-200 p-4 flex items-center gap-4 opacity-70 mb-2">
  <div className="flex-1">
  <div className="font-semibold text-subtle-700 text-sm">{t.name}</div>
  <div className="text-xs text-subtle-400">{t.property} · Archived {t.archived_at ? new Date(t.archived_at).toLocaleDateString() : ""}</div>
  </div>
  <button onClick={async () => { if (!guardSubmit("restoreTenant", t.id)) return; try { await supabase.from("tenants").update({ archived_at: null, archived_by: null, lease_status: "active" }).eq("id", t.id).eq("company_id", companyId); addNotification("\u267B\uFE0F", "Restored: " + t.name); const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId).not("archived_at", "is", null).limit(200); setArchivedTenants(data || []); fetchTenants(); } finally { guardRelease("restoreTenant", t.id); } }} className="text-xs bg-success-50 text-success-700 px-3 py-1.5 rounded-lg hover:bg-success-100 border border-success-200">♻️ Restore</button>
  </div>
  ))}
  </div>
  )}
  {tenantTab === "moveout" && <MoveOutWizard addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} setPage={setPage} showToast={showToast} showConfirm={showConfirm} />}
  {tenantTab === "evictions" && <EvictionWorkflow addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} showToast={showToast} showConfirm={showConfirm} />}

  {tenantTab === "tenants" && (<>
  {/* Required Documents Prompt */}
  {showTenantDocPrompt && (
  <div className="bg-warn-50 border border-warn-200 rounded-3xl p-4 mb-4">
  <div className="flex items-center justify-between mb-2">
  <div className="text-sm font-bold text-warn-800">{"\u{1F4CB}"} Required Documents for {showTenantDocPrompt}</div>
  <TextLink tone="warn" size="xs" underline={false} onClick={() => setShowTenantDocPrompt(null)}>✕</TextLink>
  </div>
  <p className="text-xs text-warn-600 mb-3">Before this tenant can move in, the following documents must be uploaded. These are required for lease compliance.</p>
  <div className="space-y-2">
  {["Signed Lease Agreement", "Government-Issued ID", "Renters Insurance Certificate", "Proof of Utility Transfer"].map(doc => (
  <div key={doc} className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 border border-warn-100">
  <span className="text-warn-400">☐</span>
  <span className="text-sm text-neutral-700">{doc}</span>
  </div>
  ))}
  </div>
  <div className="flex gap-2 mt-3">
  <Btn variant="warning-fill" size="sm" onClick={() => { setShowDocUpload({ property: selectedTenant?.property || "", tenant: selectedTenant?.name || showTenantDocPrompt || "" }); setShowTenantDocPrompt(null); }} >Upload Documents Now</Btn>
  {isAdmin ? (
  <Btn variant="ghost" size="sm" onClick={async () => { if (!guardSubmit("approveException")) return; try { await supabase.from("tenants").update({ doc_status: "exception_approved" }).eq("company_id", companyId).ilike("name", escapeFilterValue(showTenantDocPrompt)).is("archived_at", null); showToast("Document exception approved for " + showTenantDocPrompt, "success"); setShowTenantDocPrompt(null); fetchTenants(); } finally { guardRelease("approveException"); } }} >Admin: Approve Exception</Btn>
  ) : (
  <Btn variant="ghost" size="sm" onClick={async () => { if (!guardSubmit("reqException")) return; try { if (!await showConfirm({ message: "Skipping requires admin approval. An approval request will be sent. Continue?" })) return; await supabase.from("doc_exception_requests").insert([{ company_id: companyId, tenant_name: showTenantDocPrompt, property: selectedTenant?.property || "", requested_by: userProfile?.email || "" }]); addNotification("\u{1F4CB}", "Document exception request sent for " + showTenantDocPrompt); logAudit("request", "tenants", "Document exception requested for " + showTenantDocPrompt, "", userProfile?.email, userRole, companyId); setShowTenantDocPrompt(null); fetchDocExceptions(); } finally { guardRelease("reqException"); } }} >Request Exception</Btn>
  )}
  </div>
  </div>
  )}

  {/* Document Exception Requests — Admin Panel */}
  {isAdmin && docExceptions.filter(r => r.status === "pending").length > 0 && (
  <div className="bg-warn-50 border border-warn-200 rounded-3xl p-4 mb-4">
  <div className="text-sm font-bold text-warn-800 mb-2">{"\u{1F4CB}"} Pending Document Exception Requests ({docExceptions.filter(r => r.status === "pending").length})</div>
  <div className="space-y-2">
  {docExceptions.filter(r => r.status === "pending").map(r => (
  <div key={r.id} className="bg-white rounded-xl border border-warn-100 px-4 py-3 flex items-center justify-between">
  <div>
  <div className="text-sm font-semibold text-neutral-800">{r.tenant_name}</div>
  <div className="text-xs text-neutral-400">{r.property} · Requested by {r.requested_by} · {new Date(r.created_at).toLocaleDateString()}</div>
  </div>
  <div className="flex gap-2">
  <button onClick={async () => {
  await supabase.from("doc_exception_requests").update({ status: "approved", reviewed_by: userProfile?.email, reviewed_at: new Date().toISOString() }).eq("id", r.id);
  await supabase.from("tenants").update({ doc_status: "exception_approved" }).eq("company_id", companyId).ilike("name", escapeFilterValue(r.tenant_name)).is("archived_at", null);
  showToast("Exception approved for " + r.tenant_name, "success");
  logAudit("approve", "tenants", "Document exception approved for " + r.tenant_name, "", userProfile?.email, userRole, companyId);
  fetchDocExceptions(); fetchTenants();
  }} className="text-xs bg-success-50 text-success-700 px-3 py-1.5 rounded-lg hover:bg-success-100 font-medium">Approve</button>
  <button onClick={async () => {
  await supabase.from("doc_exception_requests").update({ status: "rejected", reviewed_by: userProfile?.email, reviewed_at: new Date().toISOString() }).eq("id", r.id);
  showToast("Exception rejected for " + r.tenant_name, "info");
  logAudit("reject", "tenants", "Document exception rejected for " + r.tenant_name, "", userProfile?.email, userRole, companyId);
  fetchDocExceptions();
  }} className="text-xs bg-danger-50 text-danger-600 px-3 py-1.5 rounded-lg hover:bg-danger-100 font-medium">Reject</button>
  </div>
  </div>
  ))}
  </div>
  </div>
  )}

  {/* Toolbar */}
  <div className="flex items-center justify-between mb-3">
  <PageHeader title="Tenants" />
  <div className="flex gap-2 items-center">
  <div className="flex bg-brand-50 rounded-2xl p-0.5">
  {[["card","\u25A6"],["table","\u2630"],["compact","\u2261"]].map(([m,icon]) => (
  <button key={m} onClick={() => setTenantView(m)} className={`px-3 py-1.5 text-sm rounded-md ${tenantView === m ? "bg-white shadow-sm text-brand-700 font-semibold" : "text-neutral-400"}`}>{icon}</button>
  ))}
  </div>
  <Btn variant="secondary" onClick={exportTenants}><span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export</Btn>
  {/* Tenants are added through the Property Setup Wizard */}
  </div>
  </div>
  {/* Filters */}
  <div className="flex items-center gap-2 mb-4 flex-wrap">
  <Input placeholder="Search name, email, phone, property..." value={tenantSearch || ""} onChange={e => setTenantSearch(e.target.value)} className="w-64" />
  <Select filter value={tenantFilter || "all"} onChange={e => setTenantFilter(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Status</option><option value="active">Active</option><option value="notice">Notice</option><option value="expired">Expired</option><option value="inactive">Inactive</option>
  </Select>
  <Select filter value={tenantFilterProp} onChange={e => setTenantFilterProp(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Properties</option>
  {[...new Set(tenants.map(t => t.property).filter(Boolean))].sort().map(p => <option key={p} value={p}>{p.length > 30 ? p.slice(0, 30) + "..." : p}</option>)}
  </Select>
  <Select filter value={tenantFilterBalance} onChange={e => setTenantFilterBalance(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Balances</option><option value="delinquent">Delinquent (owes)</option><option value="current">Current ($0)</option><option value="credit">Credit (overpaid)</option>
  </Select>
  <Select filter value={tenantFilterLeaseExpiry} onChange={e => setTenantFilterLeaseExpiry(e.target.value)} className="w-auto text-sm" >
  <option value="all">All Leases</option><option value="30">Expires in 30 days</option><option value="60">Expires in 60 days</option><option value="90">Expires in 90 days</option><option value="expired">Expired</option><option value="no_lease">No lease date</option>
  </Select>
  {(tenantFilter !== "all" || tenantFilterProp !== "all" || tenantFilterBalance !== "all" || tenantFilterLeaseExpiry !== "all" || tenantSearch) && (
  <Btn variant="danger" size="sm" onClick={() => { setTenantFilter("all"); setTenantFilterProp("all"); setTenantFilterBalance("all"); setTenantFilterLeaseExpiry("all"); setTenantSearch(""); }}>Clear Filters</Btn>
  )}
  </div>
  {/* Bulk action bar */}
  {selectedTenants.size > 0 && (
  <div className="bg-brand-50 border border-brand-200 rounded-2xl px-4 py-3 mb-4 flex items-center justify-between">
  <span className="text-sm font-medium text-brand-800">{selectedTenants.size} tenant{selectedTenants.size > 1 ? "s" : ""} selected</span>
  <div className="flex gap-2">
  <button onClick={() => setBulkAction("notice")} className="text-xs bg-notice-100 text-notice-700 px-3 py-1.5 rounded-lg hover:bg-notice-200 font-medium">Send Notice</button>
  <button onClick={() => setBulkAction("charge")} className="text-xs bg-info-100 text-info-700 px-3 py-1.5 rounded-lg hover:bg-info-200 font-medium">Add Charge</button>
  <button onClick={() => setBulkAction("status")} className="text-xs bg-highlight-100 text-highlight-700 px-3 py-1.5 rounded-lg hover:bg-highlight-200 font-medium">Change Status</button>
  <button onClick={() => setBulkAction("archive")} className="text-xs bg-danger-100 text-danger-700 px-3 py-1.5 rounded-lg hover:bg-danger-200 font-medium">Delete</button>
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => setSelectedTenants(new Set())} className="px-3 py-1.5 rounded-lg hover:bg-neutral-100">Deselect All</TextLink>
  </div>
  </div>
  )}
  {/* Bulk action modals */}
  {bulkAction === "notice" && (
  <Modal title={`Send Notice to ${selectedTenants.size} Tenant(s)`} onClose={() => setBulkAction(null)}>
  <div className="space-y-3">
  <p className="text-sm text-neutral-500">This will set the selected tenants' status to "notice" and generate a move-out date.</p>
  <div><label className="text-xs font-medium text-neutral-400 block mb-1">Notice Period (days)</label>
  <Select id="bulk-notice-days" >
  <option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option>
  </Select>
  </div>
  <Btn variant="warning-fill" className="w-full" onClick={async () => {
  if (!guardSubmit("bulkNotice")) return;
  try {
  const days = parseInt(document.getElementById("bulk-notice-days").value);
  const noticeDate = new Date(); noticeDate.setDate(noticeDate.getDate() + days);
  const moveOutDate = formatLocalDate(noticeDate);
  let count = 0;
  for (const tid of selectedTenants) {
  const { error } = await supabase.from("tenants").update({ lease_status: "notice", move_out: moveOutDate }).eq("company_id", companyId).eq("id", tid);
  if (!error) count++;
  }
  addNotification("\u{1F4CB}", `${days}-day notice sent to ${count} tenant(s)`);
  logAudit("update", "tenants", `Bulk ${days}-day notice to ${count} tenants`, "", userProfile?.email, userRole, companyId);
  setBulkAction(null); setSelectedTenants(new Set()); fetchTenants();
  } finally { guardRelease("bulkNotice"); }
  }}>Send Notices</Btn>
  </div>
  </Modal>
  )}
  {bulkAction === "charge" && (
  <Modal title={`Add Charge to ${selectedTenants.size} Tenant(s)`} onClose={() => setBulkAction(null)}>
  <div className="space-y-3">
  <div><label className="text-xs font-medium text-neutral-400 block mb-1">Description</label><Input id="bulk-charge-desc" placeholder="Late fee, utility charge, etc." /></div>
  <div><label className="text-xs font-medium text-neutral-400 block mb-1">Amount ($)</label><Input id="bulk-charge-amt" type="number" placeholder="50.00" /></div>
  <div><label className="text-xs font-medium text-neutral-400 block mb-1">Revenue Account</label>
  <Select id="bulk-charge-acct" >
  <option value="4100">4100 — Other Income</option>
  <option value="4000">4000 — Rental Income</option>
  <option value="4010">4010 — Late Fee Income</option>
  <option value="4200">4200 — Management Fee Income</option>
  </Select>
  </div>
  <Btn variant="primary" className="w-full" onClick={async () => {
  if (!guardSubmit("bulkCharge")) return;
  try {
  const desc = document.getElementById("bulk-charge-desc").value;
  const amt = Math.abs(Number(document.getElementById("bulk-charge-amt").value));
  const acctCode = document.getElementById("bulk-charge-acct").value;
  const acctNames = { "4100": "Other Income", "4000": "Rental Income", "4010": "Late Fee Income", "4200": "Management Fee Income" };
  if (!desc || !amt) { showToast("Description and amount required.", "error"); return; }
  let count = 0;
  for (const tid of selectedTenants) {
  const t = tenants.find(x => x.id === tid);
  if (!t) continue;
  const classId = await getPropertyClassId(t.property, companyId);
  const result = await atomicPostJEAndLedger({ companyId,
  date: formatLocalDate(new Date()), description: "Bulk charge \u2014 " + t.name + " \u2014 " + desc,
  reference: "BULK-" + shortId(), property: t.property || "",
  lines: [
  { account_id: "1100", account_name: "Accounts Receivable", debit: amt, credit: 0, class_id: classId, memo: t.name + ": " + desc },
  { account_id: acctCode, account_name: acctNames[acctCode] || "Other Income", debit: 0, credit: amt, class_id: classId, memo: desc },
  ],
  ledgerEntry: { tenant: t.name, property: t.property, date: formatLocalDate(new Date()), description: desc, amount: amt, type: "charge", balance: 0 },
  balanceUpdate: { tenantId: tid, amount: amt },
  silent: true,
  });
  if (result.jeId) count++;
  }
  if (count > 0) addNotification("\u{1F4B0}", `Charge of ${formatCurrency(amt)} added to ${count} tenant(s)`);
  if (count < selectedTenants.size) showToast((selectedTenants.size - count) + " charge(s) failed \u2014 check the Accounting module.", "error");
  logAudit("create", "tenants", `Bulk charge $${amt} "${desc}" to ${count} tenants (acct ${acctCode})`, "", userProfile?.email, userRole, companyId);
  setBulkAction(null); setSelectedTenants(new Set()); fetchTenants();
  } finally { guardRelease("bulkCharge"); }
  }}>Add Charges</Btn>
  </div>
  </Modal>
  )}
  {bulkAction === "status" && (
  <Modal title={`Change Status — ${selectedTenants.size} Tenant(s)`} onClose={() => setBulkAction(null)}>
  <div className="space-y-3">
  <div><label className="text-xs font-medium text-neutral-400 block mb-1">New Status</label>
  <Select id="bulk-status-val"  >
  <option value="active">Active</option><option value="notice">Notice</option><option value="expired">Expired</option><option value="inactive">Inactive</option>
  </Select>
  </div>
  <Btn variant="purple" className="w-full" onClick={async () => {
  if (!guardSubmit("bulkStatus")) return;
  try {
  const newStatus = document.getElementById("bulk-status-val").value;
  // Single update against .in(ids) instead of N serial updates.
  const ids = [...selectedTenants];
  const { error: bulkErr, count } = await supabase.from("tenants")
    .update({ lease_status: newStatus }, { count: "exact" })
    .eq("company_id", companyId)
    .in("id", ids);
  if (bulkErr) pmError("PM-3002", { raw: bulkErr, context: "bulk tenant status update" });
  addNotification("\u{1F464}", `Status changed to "${newStatus}" for ${count || 0} tenant(s)`);
  logAudit("update", "tenants", `Bulk status change to ${newStatus} for ${count || 0} tenants`, "", userProfile?.email, userRole, companyId);
  setBulkAction(null); setSelectedTenants(new Set()); fetchTenants();
  } finally { guardRelease("bulkStatus"); }
  }}>Update Status</Btn>
  </div>
  </Modal>
  )}
  {bulkAction === "archive" && (
  <Modal title={`Archive ${selectedTenants.size} Tenant(s)?`} onClose={() => setBulkAction(null)}>
  <div className="space-y-3">
  <p className="text-sm text-danger-600">This will archive the selected tenants. They can be restored from the Archive page within 180 days.</p>
  <div className="bg-danger-50 rounded-lg p-3 text-xs text-danger-700 space-y-1">
  {[...selectedTenants].map(tid => { const t = tenants.find(x => x.id === tid); return t ? <div key={tid}>{t.name} — {t.property}{safeNum(t.balance) > 0 ? ` (owes ${formatCurrency(t.balance)})` : ""}</div> : null; })}
  </div>
  <Btn variant="danger-fill" onClick={async () => {
  if (!guardSubmit("bulkArchive")) return;
  try {
  // Filter client-side to only zero-balance tenants (can't archive
  // someone with owed rent), then archive all at once.
  const eligibleIds = [...selectedTenants].filter(tid => {
    const t = tenants.find(x => x.id === tid);
    return safeNum(t?.balance) <= 0;
  });
  let count = 0;
  if (eligibleIds.length > 0) {
    const { error: archErr, count: archCount } = await supabase.from("tenants")
      .update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email, lease_status: "inactive" }, { count: "exact" })
      .eq("company_id", companyId)
      .in("id", eligibleIds);
    if (archErr) pmError("PM-3003", { raw: archErr, context: "bulk tenant archive" });
    count = archCount || 0;
  }
  addNotification("\u{1F4E6}", `${count} tenant(s) archived`);
  logAudit("archive", "tenants", `Bulk archived ${count} tenants`, "", userProfile?.email, userRole, companyId);
  setBulkAction(null); setSelectedTenants(new Set()); fetchTenants();
  } finally { guardRelease("bulkArchive"); }
  }} className="w-full">Confirm Delete</Btn>
  </div>
  </Modal>
  )}

  {showForm && editingTenant && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">{editingTenant ? "Edit Tenant" : "New Tenant"}</h3>
  <div className="grid grid-cols-2 gap-3">
  <div className="col-span-2 grid grid-cols-6 gap-3">
    <div className="col-span-2"><label className="text-xs font-medium text-neutral-400 mb-1 block">First Name *</label><Input placeholder="First" value={form.first_name} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, first_name: v, name: formatPersonName(v, f.mi, f.last_name) })); }} /></div>
    <div className="col-span-1"><label className="text-xs font-medium text-neutral-400 mb-1 block">MI</label><Input maxLength={1} placeholder="M" value={form.mi} onChange={e => { const v = e.target.value.toUpperCase(); setForm(f => ({ ...f, mi: v, name: formatPersonName(f.first_name, v, f.last_name) })); }} className="text-center" /></div>
    <div className="col-span-3"><label className="text-xs font-medium text-neutral-400 mb-1 block">Last Name *</label><Input placeholder="Last" value={form.last_name} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, last_name: v, name: formatPersonName(f.first_name, f.mi, v) })); }} /></div>
  </div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Email</label><Input type="email" placeholder="tenant@email.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Phone</label><Input type="tel" placeholder="(555) 123-4567" value={form.phone} onChange={e => setForm({ ...form, phone: formatPhoneInput(e.target.value) })} maxLength={14} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Monthly Rent ($)</label><Input placeholder="1500" value={form.rent} onChange={e => setForm({ ...form, rent: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Late Fee</label><div className="flex gap-1 items-center"><Input type="number" min="0" step="0.01" placeholder="50" value={form.late_fee_amount || ""} onChange={e => setForm({ ...form, late_fee_amount: e.target.value })} className="border border-brand-100 rounded-xl px-3 py-1.5 text-sm flex-1 min-w-0 focus:border-brand-300 focus:outline-none" /><Select value={form.late_fee_type || "flat"} onChange={e => setForm({ ...form, late_fee_type: e.target.value })} className="border border-brand-100 rounded-2xl px-2 py-2 text-sm w-12 shrink-0 focus:outline-none"><option value="flat">$</option><option value="percent">%</option></Select></div></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Lease Status</label><Select value={form.lease_status} onChange={e => setForm({ ...form, lease_status: e.target.value })}>
  {["active", "notice", "expired"].map(s => <option key={s}>{s}</option>)}
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Lease Start / Move-in</label><Input type="date" value={form.lease_start} onChange={e => setForm({ ...form, lease_start: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Lease End / Move-out</label><Input type="date" value={form.lease_end} onChange={e => setForm({ ...form, lease_end: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Security Deposit ($)</label><Input placeholder="0" value={form.security_deposit || ""} onChange={e => setForm({ ...form, security_deposit: e.target.value })} /></div>
  </div>
  {/* Voucher Tenant Section */}
  <div className="mt-3 border border-neutral-200 rounded-xl p-3">
  <label className="flex items-center gap-2 cursor-pointer">
  <Checkbox checked={form.is_voucher || false} onChange={e => setForm({ ...form, is_voucher: e.target.checked })} className="rounded" />
  <span className="text-sm font-medium text-neutral-700">Voucher / Section 8 Tenant</span>
  </label>
  {form.is_voucher && (
  <div className="mt-3 space-y-3">
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Voucher Number</label><Input value={form.voucher_number} onChange={e => setForm({ ...form, voucher_number: e.target.value })} placeholder="e.g. HCV-12345" /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Re-examination Date</label><Input type="date" value={form.reexam_date} onChange={e => setForm({ ...form, reexam_date: e.target.value })} /></div>
  </div>
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Case Manager Name</label><Input value={form.case_manager_name} onChange={e => setForm({ ...form, case_manager_name: e.target.value })} placeholder="Jane Smith" /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Case Manager Email</label><Input type="email" value={form.case_manager_email} onChange={e => setForm({ ...form, case_manager_email: e.target.value })} placeholder="jane@county.gov" /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Case Manager Phone</label><Input type="tel" value={form.case_manager_phone} onChange={e => setForm({ ...form, case_manager_phone: formatPhoneInput(e.target.value) })} maxLength={14} placeholder="(555) 123-4567" /></div>
  </div>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Voucher Portion ($)</label><Input type="number" min="0" step="0.01" value={form.voucher_portion} onChange={e => { const vp = e.target.value; const tp = safeNum(form.rent) - safeNum(vp); setForm({ ...form, voucher_portion: vp, tenant_portion: tp > 0 ? String(tp) : "0" }); }} placeholder="0.00" /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Tenant Portion ($)</label><Input type="number" min="0" step="0.01" value={form.tenant_portion} onChange={e => { const tp = e.target.value; const vp = safeNum(form.rent) - safeNum(tp); setForm({ ...form, tenant_portion: tp, voucher_portion: vp > 0 ? String(vp) : "0" }); }} placeholder="0.00" /></div>
  </div>
  {form.rent && <div className="text-xs text-neutral-400">Total rent: {formatCurrency(form.rent)} = Voucher {formatCurrency(form.voucher_portion || 0)} + Tenant {formatCurrency(form.tenant_portion || 0)}</div>}
  </div>
  )}
  </div>
  {form.lease_start && form.lease_end && form.rent && (
  <div className="bg-brand-50 border border-brand-200 rounded-xl p-3 mt-2 text-xs text-brand-700">
  A lease will be auto-created and rent charges posted to accounting.
  {Number(form.security_deposit) > 0 && " Security deposit will also be recorded."}
  </div>
  )}
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveTenant} disabled={_submitGuards["saveTenant"]}>{_submitGuards["saveTenant"] ? "Saving..." : "Save"}</Btn>
  <Btn variant="slate" onClick={() => { setShowForm(false); setEditingTenant(null); }}>Cancel</Btn>
  </div>
  </div>
  )}

  {(() => {
  const ft = tenants.filter(t => {
  if (tenantFilter !== "all" && tenantFilter && t.lease_status !== tenantFilter) return false;
  if (tenantFilterProp !== "all" && t.property !== tenantFilterProp) return false;
  if (tenantFilterBalance === "delinquent" && !(safeNum(t.balance) > 0)) return false;
  if (tenantFilterBalance === "current" && safeNum(t.balance) > 0) return false;
  if (tenantFilterBalance === "credit" && !(safeNum(t.balance) < 0)) return false;
  if (tenantFilterLeaseExpiry !== "all") {
  const endDate = t.lease_end_date || t.move_out;
  if (!endDate) return tenantFilterLeaseExpiry === "no_lease" ? true : false;
  if (tenantFilterLeaseExpiry === "no_lease") return false;
  const daysLeft = Math.ceil((parseLocalDate(endDate) - new Date()) / 86400000);
  if (tenantFilterLeaseExpiry === "30" && daysLeft > 30) return false;
  if (tenantFilterLeaseExpiry === "60" && daysLeft > 60) return false;
  if (tenantFilterLeaseExpiry === "90" && daysLeft > 90) return false;
  if (tenantFilterLeaseExpiry === "expired" && daysLeft > 0) return false;
  }
  if (tenantSearch) {
  const q = tenantSearch.toLowerCase();
  if (!t.name?.toLowerCase().includes(q) && !t.email?.toLowerCase().includes(q) && !t.property?.toLowerCase().includes(q) && !t.phone?.toLowerCase().includes(q)) return false;
  }
  return true;
  });
  const TenantActions = ({t}) => (
  <div className="flex gap-1.5 flex-wrap">
  <TextLink tone="brand" size="xs" underline={false} onClick={() => openLedger(t)} className="border border-brand-200 px-2 py-1 rounded-lg hover:bg-brand-50">Ledger</TextLink>
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => openMessages(t)} className="border border-brand-100 px-2 py-1 rounded-lg hover:bg-brand-50/30">Msg</TextLink>
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => { setSelectedTenant(t); setActivePanel("lease"); }} className="border border-brand-100 px-2 py-1 rounded-lg hover:bg-brand-50/30">Lease</TextLink>
  <button onClick={() => startEdit(t)} className="text-xs text-info-600 hover:underline">Edit</button>
  <TextLink tone="danger" size="xs" onClick={() => deleteTenant(t.id, t.name)}>Delete</TextLink>
  <button onClick={() => inviteTenant(t)} className="text-xs text-highlight-600 hover:underline">Invite</button>
  </div>
  );
  return <>
  {tenantView === "card" && (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
  {ft.map(t => {
  const portalStatus = t.email ? portalMembers[t.email.toLowerCase()] : null;
  return (
  <div key={t.id} onClick={() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); }} className={"rounded-3xl shadow-card border p-4 cursor-pointer hover:shadow-md transition-all " + (t.doc_status === "pending_docs" ? "bg-neutral-50 border-warn-200 opacity-60" : "bg-white border-brand-50 hover:border-brand-200")}>
  <div className="flex justify-between items-start mb-2">
  <div className="flex items-center gap-3">
  <div className={"w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg " + (t.doc_status === "pending_docs" ? "bg-warn-100 text-warn-700" : "bg-brand-100 text-brand-700")}>{t.name?.[0]}</div>
  <div><div className="font-semibold text-neutral-800">{t.name}</div><div className="text-xs text-neutral-400">{t.property}</div>{t.doc_status === "pending_docs" && <div className="text-xs text-warn-600 font-medium">Pending documents</div>}</div>
  </div>
  <div className="flex items-center gap-1">
  <Badge status={t.lease_status} />
  {t.is_voucher && <span className="text-xs bg-highlight-100 text-highlight-700 px-1.5 py-0.5 rounded-full font-semibold">Voucher</span>}
  {portalStatus === "active" && <span className="text-[10px] bg-success-100 text-success-700 px-1.5 py-0.5 rounded-full font-semibold" title="Tenant has signed up for the portal">Portal Active</span>}
  {portalStatus === "invited" && <span className="text-[10px] bg-highlight-50 text-highlight-700 px-1.5 py-0.5 rounded-full font-semibold" title="Invite sent, not yet accepted">Invited</span>}
  </div>
  </div>
  <div className="grid grid-cols-3 gap-2 text-xs mt-2">
  <div><span className="text-neutral-400">Email</span><div className="font-semibold text-neutral-700 truncate">{t.email || "\u2014"}</div></div>
  <div><span className="text-neutral-400">Balance</span><div className={`font-semibold ${t.balance > 0 ? "text-danger-500" : "text-neutral-700"}`}>{t.balance > 0 ? `-${formatCurrency(t.balance)}` : "Current"}</div></div>
  <div><span className="text-neutral-400">Rent</span><div className="font-semibold text-neutral-700">{t.rent ? `${formatCurrency(t.rent)}/mo` : "\u2014"}</div></div>
  </div>
  <div className="flex items-center justify-between mt-3 pt-2 border-t border-brand-50 gap-2">
  <TextLink tone="brand" size="xs" underline={false} onClick={e => { e.stopPropagation(); setSelectedTenant(t); setActivePanel("ledger"); openLedger(t); }} className="font-medium shrink-0">View Ledger</TextLink>
  {safeNum(t.balance) > 0 && safeNum(t.late_fee_amount) > 0 && <TextLink tone="danger" size="xs" underline={false} onClick={e => { e.stopPropagation(); applyLateFeeForTenant(t); }} className="font-medium flex items-center gap-0.5 shrink-0"><span className="material-icons-outlined text-xs">gavel</span>Late Fee</TextLink>}
  {portalStatus !== "active" && (
  <button
    onClick={e => { e.stopPropagation(); inviteTenant(t); }}
    disabled={!t.email}
    title={!t.email ? "Add an email to this tenant first" : portalStatus === "invited" ? "Re-send the portal invite email" : "Send portal access invite to this tenant"}
    className={"ml-auto text-xs font-semibold px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors " + (!t.email ? "bg-neutral-100 text-neutral-400 cursor-not-allowed" : portalStatus === "invited" ? "bg-highlight-50 text-highlight-700 hover:bg-highlight-100 border border-highlight-200" : "bg-brand-600 text-white hover:bg-brand-700")}
  >
    <span className="material-icons-outlined text-xs">{portalStatus === "invited" ? "refresh" : "mail"}</span>
    {portalStatus === "invited" ? "Resend Invite" : "Invite to Portal"}
  </button>
  )}
  </div>
  </div>
  );
  })}
  </div>
  )}
  {tenantView === "table" && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 overflow-x-auto">
  <table className="w-full text-sm">
  <thead className="bg-brand-50/30 text-xs text-neutral-400 uppercase">
  <tr>
  <th className="px-3 py-3 text-left w-8"><Checkbox checked={ft.length > 0 && ft.every(t => selectedTenants.has(t.id))} onChange={e => { if (e.target.checked) setSelectedTenants(new Set(ft.map(t => t.id))); else setSelectedTenants(new Set()); }} className="rounded" /></th>
  <th className="px-4 py-3 text-left">Name</th><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-left">Email</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-right">Rent</th><th className="px-4 py-3 text-right">Balance</th><th className="px-4 py-3 text-right">Actions</th>
  </tr>
  </thead>
  <tbody>
  {ft.map(t => (
  <tr key={t.id} className={`border-t border-brand-50/50 hover:bg-brand-50/50 cursor-pointer ${selectedTenants.has(t.id) ? "bg-brand-50/60" : ""}`}>
  <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}><Checkbox checked={selectedTenants.has(t.id)} onChange={e => { const next = new Set(selectedTenants); if (e.target.checked) next.add(t.id); else next.delete(t.id); setSelectedTenants(next); }} className="rounded" /></td>
  <td className="px-4 py-2.5 font-medium text-brand-600" onClick={() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); }}>{t.name}</td>
  <td className="px-4 py-2.5 text-neutral-500">{t.property}</td>
  <td className="px-4 py-2.5 text-neutral-400 text-xs">{t.email}</td>
  <td className="px-4 py-2.5"><Badge status={t.lease_status} /></td>
  <td className="px-4 py-2.5 text-right font-semibold">{t.rent ? `${formatCurrency(t.rent)}` : "\u2014"}</td>
  <td className={`px-4 py-2.5 text-right font-semibold ${t.balance > 0 ? "text-danger-500" : "text-neutral-700"}`}>{t.balance > 0 ? `-${formatCurrency(t.balance)}` : "Current"}</td>
  <td className="px-4 py-2.5 text-right"><TenantActions t={t} /></td>
  </tr>
  ))}
  </tbody>
  </table>
  </div>
  )}
  {tenantView === "compact" && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 divide-y divide-brand-50/50">
  {ft.map(t => (
  <div key={t.id} onClick={() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-brand-50/50 cursor-pointer">
  <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-xs">{t.name?.[0]}</div>
  <div className="flex-1 min-w-0"><span className="text-sm font-medium text-neutral-800">{t.name}</span><span className="text-xs text-neutral-400 ml-2">{t.property}</span></div>
  <span className="text-sm font-semibold text-neutral-700">{t.rent ? `${formatCurrency(t.rent)}/mo` : "\u2014"}</span>
  <span className={`text-xs font-semibold ${t.balance > 0 ? "text-danger-500" : "text-neutral-400"}`}>{t.balance > 0 ? `-${formatCurrency(t.balance)}` : "Current"}</span>
  <Badge status={t.lease_status} />
  <TextLink tone="brand" size="xs" onClick={() => openLedger(t)}>Ledger</TextLink>
  <button onClick={() => startEdit(t)} className="text-xs text-info-600 hover:underline">Edit</button>
  </div>
  ))}
  </div>
  )}
  {ft.length === 0 && <div className="text-center py-8 text-neutral-400">No tenants found</div>}
  </>;
  })()}
  </>)}
  {showDocUpload && <DocUploadModal onClose={() => setShowDocUpload(null)} companyId={companyId} property={showDocUpload.property} tenant={showDocUpload.tenant} showToast={showToast} onUploaded={() => { if (selectedTenant) fetchTenantDocs(selectedTenant); }} />}
  {savingTenant && (
  <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[60] flex items-center justify-center">
  <div className="bg-white rounded-2xl shadow-2xl px-8 py-6 flex flex-col items-center gap-3">
  <div className="w-10 h-10 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin" />
  <div className="text-sm font-medium text-neutral-700">Setting up tenant...</div>
  <div className="text-xs text-neutral-400">Creating accounts, lease & posting entries</div>
  </div>
  </div>
  )}
  {pendingRecurringEntry && <RecurringEntryModal entry={pendingRecurringEntry} companyId={companyId} showToast={showToast} onComplete={() => setPendingRecurringEntry(null)} />}
  </div>
  );
}

export default Tenants;
