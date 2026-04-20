import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Textarea, Select, Btn, PageHeader, TextLink} from "../ui";
import { safeNum, formatLocalDate, formatCurrency, exportToCSV } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { encryptCredential, decryptCredential } from "../utils/encryption";
import { logAudit } from "../utils/audit";
import { safeLedgerInsert, autoPostJournalEntry, getPropertyClassId } from "../utils/accounting";
import { Badge, Spinner, Modal, PropertySelect } from "./shared";

function Utilities({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  function exportUtilities() {
  exportToCSV(utilities, [
  { label: "Property", key: "property" },
  { label: "Provider", key: "provider" },
  { label: "Type", key: "type" },
  { label: "Amount", key: "amount" },
  { label: "Due Date", key: "due" },
  { label: "Status", key: "status" },
  ], "utilities_" + new Date().toLocaleDateString(), showToast);
  }
  const [utilities, setUtilities] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [showAudit, setShowAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending", website: "", username: "", password: "" });
  const [showCreds, setShowCreds] = useState(new Set());
  const [utilView, setUtilView] = useState("card");
  const [utilSearch, setUtilSearch] = useState("");
  const [utilFilterStatus, setUtilFilterStatus] = useState("all");
  const [utilFilterProp, setUtilFilterProp] = useState("all");
  
  // === Utility Automation ===
  const [utilTab, setUtilTab] = useState("bills"); // bills / automation / jobs
  const [utilAccounts, setUtilAccounts] = useState([]);
  const [autoBills, setAutoBills] = useState([]);
  const [autoJobs, setAutoJobs] = useState([]);
  const [providers, setProviders] = useState([]);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [accountForm, setAccountForm] = useState({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" });
  const [show2FAPrompt, setShow2FAPrompt] = useState(null); // job awaiting 2FA
  const [twoFACode, setTwoFACode] = useState("");
  const [billViewModal, setBillViewModal] = useState(null); // bill being reviewed
  const [paymentMethodModal, setPaymentMethodModal] = useState(null); // bill for payment auth

  useEffect(() => { fetchUtilities(); fetchAutomationData(); }, [companyId]);

  async function fetchAutomationData() {
  const [accts, bills, jobs, provs] = await Promise.all([
  supabase.from("utility_accounts").select("*").eq("company_id", companyId).is("archived_at", null).order("property"),
  supabase.from("utility_bills").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }).limit(100),
  supabase.from("automation_jobs").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(50),
  supabase.from("utility_providers").select("*").eq("is_active", true).order("display_name"), // Intentionally unscoped — shared reference table of utility companies
  ]);
  setUtilAccounts(accts.data || []);
  setAutoBills(bills.data || []);
  setAutoJobs(jobs.data || []);
  setProviders(provs.data || []);
  }

  async function saveAccount() {
  if (!accountForm.property || !accountForm.provider || !accountForm.username || !accountForm.password) {
  showToast("Property, provider, username, and password are required.", "error"); return;
  }
  // Encrypt credentials client-side before sending
  // In production, this should be done server-side via Edge Function
  // For now, we use a simple encoding (NOT production-grade encryption)
  const providerInfo = providers.find(p => p.id === accountForm.provider);
  // AES-256-GCM encryption for credentials using Web Crypto API
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  // Derive a key from companyId (deterministic per company — not perfect but far better than Base64)
  // For production, move encryption to a Supabase Edge Function with a server-managed key
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode((companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0")), { name: "AES-GCM" }, false, ["encrypt"]);
  async function encryptField(plaintext) {
  if (!plaintext) return "";
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyMaterial, encoded);
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  }
  const payload = {
  company_id: companyId,
  property: accountForm.property,
  provider: accountForm.provider,
  provider_display: providerInfo?.display_name || accountForm.provider,
  account_number: accountForm.account_number,
  username_encrypted: await encryptField(accountForm.username),
  password_encrypted: await encryptField(accountForm.password),
  encryption_iv: ivHex,
  login_url: providerInfo?.login_url || "",
  account_type: accountForm.account_type,
  check_frequency: accountForm.check_frequency,
  two_factor_method: accountForm.two_factor_method,
  notes: accountForm.notes,
  };
  let error;
  if (editingAccount) {
  ({ error } = await supabase.from("utility_accounts").update(payload).eq("id", editingAccount.id).eq("company_id", companyId));
  } else {
  ({ error } = await supabase.from("utility_accounts").insert([payload]));
  }
  if (error) { pmError("PM-4002", { raw: error, context: "saving utility account" }); return; }
  addNotification("⚡", (editingAccount ? "Updated" : "Added") + " utility account: " + (providerInfo?.display_name || accountForm.provider));
  setShowAccountForm(false);
  setEditingAccount(null);
  setAccountForm({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" });
  fetchAutomationData();
  }

  async function deleteAccount(acct) {
  if (!await showConfirm({ message: "Delete this utility account? Automation will stop for this account.", variant: "danger", confirmText: "Delete" })) return;
  await supabase.from("utility_accounts").update({ archived_at: new Date().toISOString() }).eq("id", acct.id).eq("company_id", companyId);
  addNotification("📦", "Utility account archived: " + acct.provider_display);
  fetchAutomationData();
  }

  async function triggerManualCheck(acct) {
  // Queue a manual bill check job
  const { error } = await supabase.from("automation_jobs").insert([{
  company_id: companyId,
  utility_account_id: acct.id,
  job_type: "fetch_bill",
  status: "queued",
  triggered_by: userProfile?.email || "manual",
  }]);
  if (error) { pmError("PM-4003", { raw: error, context: "queuing automation job" }); return; }
  addNotification("🔄", "Bill check queued for " + acct.provider_display + " at " + acct.property);
  fetchAutomationData();
  }

  async function authorizeBillPayment(bill, paymentMethod) {
  if (!guardSubmit("authorizeBill", bill?.id)) return;
  try {
  const { error } = await supabase.from("utility_bills").update({
  status: "authorized",
  payment_method_selected: paymentMethod,
  authorized_by: userProfile?.email,
  authorized_at: new Date().toISOString(),
  }).eq("id", bill.id).eq("company_id", companyId);
  if (error) { pmError("PM-6001", { raw: error, context: "authorizing bill payment" }); return; }
  // Queue payment job
  const { error: jobErr } = await supabase.from("automation_jobs").insert([{
  company_id: companyId,
  utility_account_id: bill.utility_account_id,
  bill_id: bill.id,
  job_type: "pay_bill",
  status: "queued",
  triggered_by: userProfile?.email || "manual",
  }]);
  if (jobErr) pmError("PM-8006", { raw: jobErr, context: "queue bill payment job", silent: true });
  // Auto-post journal entry for utility payment (DR Utilities Expense, CR Checking)
  const classId = await getPropertyClassId(bill.property, companyId);
  const _jeOk = await autoPostJournalEntry({
  companyId,
  date: formatLocalDate(new Date()),
  description: "Utility payment — " + (bill.provider_display || bill.provider) + " — " + bill.property,
  reference: "UTIL-" + bill.id,
  property: bill.property,
  lines: [
  { account_id: "5400", account_name: "Utilities Expense", debit: safeNum(bill.amount), credit: 0, class_id: classId, memo: (bill.provider_display || bill.provider) + " bill" },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: safeNum(bill.amount), class_id: classId, memo: "Utility payment" },
  ]
  });
  if (!_jeOk) { pmError("PM-4004", { raw: new Error("JE post failed"), context: "posting bill payment accounting entry" }); }
  addNotification("✅", "Payment authorized: " + (bill.provider_display || bill.provider) + " $" + bill.amount);
  setPaymentMethodModal(null);
  fetchAutomationData();
  } finally { guardRelease("authorizeBill", bill?.id); }
  }

  async function fetchUtilities() {
  const { data } = await supabase.from("utilities").select("*").eq("company_id", companyId).is("archived_at", null).order("due", { ascending: true }).limit(500);
  setUtilities(data || []);
  setLoading(false);
  }

  async function addUtility() {
  if (!guardSubmit("addUtility")) return;
  try {
  if (!form.property.trim()) { showToast("Property is required.", "error"); return; }
  if (!form.provider.trim()) { showToast("Provider name is required.", "error"); return; }
  if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { showToast("Please enter a valid amount.", "error"); return; }
  if (!form.due) { showToast("Due date is required.", "error"); return; }
  const row = { ...form, amount: Number(form.amount), company_id: companyId };
  delete row.username; delete row.password; // don't store plaintext
  row.website = form.website || "";
  if (form.username || form.password) {
    const resU = await encryptCredential(form.username || "", companyId);
    const resP = await encryptCredential(form.password || "", companyId, resU.salt);
    row.username_encrypted = resU.encrypted;
    row.password_encrypted = resP.encrypted;
    row.encryption_iv_username = resU.iv || null;
    row.encryption_iv = resP.iv || resU.iv;
    row.encryption_salt = resU.salt || resP.salt;
  }
  const { error } = await supabase.from("utilities").insert([row]);
  if (error) { pmError("PM-4005", { raw: error, context: "adding utility bill" }); return; }
  addNotification("⚡", `Utility bill added: ${form.provider} at ${form.property}`);
  logAudit("create", "utilities", `Utility added: ${form.provider} ${formatCurrency(form.amount)} at ${form.property}`, "", userProfile?.email, userRole, companyId);
  setShowForm(false);
  setForm({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending", website: "", username: "", password: "" });
  fetchUtilities();
  } finally { guardRelease("addUtility"); }
  }

  async function approvePay(u) {
  if (!guardSubmit("approvePay")) return;
  try {
  if (u.status === "paid") { showToast("This utility is already marked as paid.", "error"); return; }
  const now = new Date().toISOString();
  const { error } = await supabase.from("utilities").update({ status: "paid", paid_at: now }).eq("company_id", companyId).eq("id", u.id);
  if (error) { pmError("PM-6002", { raw: error, context: "approving utility payment" }); return; }
  await supabase.from("utility_audit").insert([{ company_id: companyId,
  utility_id: u.id,
  property: u.property,
  provider: u.provider,
  amount: u.amount,
  action: "Approved & Paid",
  paid_at: now,
  }]);
  addNotification("✅", `Utility paid: ${u.provider} ${formatCurrency(u.amount)} for ${u.property}`);
  // AUTO-POST TO ACCOUNTING: DR Utilities Expense, CR Bank
  const classId = await getPropertyClassId(u.property, companyId);
  const amt = safeNum(u.amount);
  if (amt > 0) {
  const _jeOk = await autoPostJournalEntry({
  companyId,
  date: formatLocalDate(new Date()),
  description: `Utility: ${u.provider} — ${u.property}`,
  reference: `UTIL-${u.id}`,
  property: u.property,
  lines: [
  { account_id: "5400", account_name: "Utilities", debit: amt, credit: 0, class_id: classId, memo: `${u.provider} — ${u.property}` },
  { account_id: "1000", account_name: "Checking Account", debit: 0, credit: amt, class_id: classId, memo: `Paid: ${u.provider}` },
  ]
  });
  if (!_jeOk) { pmError("PM-4006", { raw: new Error("JE post failed"), context: "posting utility payment accounting entry" }); }
  // #15: Create ledger entry for utility payment
  await safeLedgerInsert({ company_id: companyId, tenant: "", property: u.property, date: formatLocalDate(new Date()), description: `Utility: ${u.provider}`, amount: amt, type: "expense", balance: 0 });
  }
  // #14: Add audit trail logging for utility payment
  logAudit("update", "utilities", `Utility paid: ${u.provider} ${formatCurrency(u.amount)} for ${u.property}`, u.id, userProfile?.email, userRole, companyId);
  fetchUtilities();
  } finally { guardRelease("approvePay"); }
  }

  async function openAuditLog(u) {
  const { data } = await supabase.from("utility_audit").select("*").eq("utility_id", u.id).eq("company_id", companyId).order("paid_at", { ascending: false });
  setAuditLog(data || []);
  setShowAudit(u);
  }

  if (loading) return <Spinner />;

  return (
  <div>
  {showAudit && (
  <Modal title={`Audit Log — ${showAudit.provider}`} onClose={() => setShowAudit(null)}>
  {auditLog.length === 0 ? (
  <div className="text-center text-neutral-400 py-6">No audit entries yet</div>
  ) : (
  <div className="space-y-3">
  {auditLog.map((a, i) => (
  <div key={i} className="bg-brand-50/30 rounded-lg px-4 py-3">
  <div className="flex justify-between">
  <span className="text-sm font-semibold text-positive-600">{a.action}</span>
  <span className="text-xs text-neutral-400">{new Date(a.paid_at).toLocaleString()}</span>
  </div>
  <div className="text-sm text-neutral-500 mt-1">${a.amount} — {a.property}</div>
  </div>
  ))}
  </div>
  )}
  </Modal>
  )}

  {/* Tab Navigation */}
  <div className="flex flex-col md:flex-row md:items-center gap-2 mb-5 border-b border-brand-50 pb-3">
  <PageHeader title="Utilities" />
  <Btn variant="secondary" onClick={exportUtilities}><span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export</Btn>
  <div className="flex gap-1 overflow-x-auto pb-1">
  {[["bills", "Manual Bills"], ["automation", "⚡ Automation"], ["jobs", "Job History"]].map(([id, label]) => (
  <button key={id} onClick={() => setUtilTab(id)} className={"px-3 py-1.5 text-xs font-medium rounded-lg " + (utilTab === id ? "bg-brand-600 text-white" : "bg-subtle-100 text-subtle-600 hover:bg-subtle-200")}>{label}</button>
  ))}
  </div>
  </div>

  {/* ===== AUTOMATION TAB ===== */}
  {utilTab === "automation" && (
  <div>
  <div className="flex items-center justify-between mb-4">
  <div>
  <h3 className="font-semibold text-subtle-700">Connected Utility Accounts</h3>
  <p className="text-xs text-subtle-400 mt-0.5">{utilAccounts.length} account{utilAccounts.length !== 1 ? "s" : ""} connected</p>
  </div>
  <Btn onClick={() => { setEditingAccount(null); setAccountForm({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" }); setShowAccountForm(true); }}>+ Add Account</Btn>
  </div>

  {showAccountForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-subtle-700 mb-3">{editingAccount ? "Edit Account" : "Connect Utility Account"}</h3>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Property *</label><PropertySelect value={accountForm.property} onChange={v => setAccountForm({...accountForm, property: v})} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Provider *</label><Select value={accountForm.provider} onChange={e => { const p = providers.find(x => x.id === e.target.value); setAccountForm({...accountForm, provider: e.target.value, account_type: p?.account_type || "electric"}); }}><option value="">Select provider...</option>{providers.map(p => <option key={p.id} value={p.id}>{p.display_name} ({p.region})</option>)}</Select></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Account Number</label><Input placeholder="e.g. 1234567890" value={accountForm.account_number} onChange={e => setAccountForm({...accountForm, account_number: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Account Type</label><Select value={accountForm.account_type} onChange={e => setAccountForm({...accountForm, account_type: e.target.value})}><option value="electric">Electric</option><option value="gas">Gas</option><option value="water_sewer">Water/Sewer</option><option value="electric_gas">Electric + Gas</option><option value="trash">Trash</option></Select></div>
  <div className="col-span-1 sm:col-span-2 bg-warn-50 rounded-lg px-3 py-2"><div className="text-xs font-semibold text-warn-700">🔐 Login Credentials (encrypted before storage)</div></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Username / Email *</label><Input placeholder="your-login@email.com" value={accountForm.username} onChange={e => setAccountForm({...accountForm, username: e.target.value})} autoComplete="off" /></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Password *</label><Input type="password" placeholder="••••••••" value={accountForm.password} onChange={e => setAccountForm({...accountForm, password: e.target.value})} autoComplete="new-password" /></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Check Frequency</label><Select value={accountForm.check_frequency} onChange={e => setAccountForm({...accountForm, check_frequency: e.target.value})}><option value="weekly">Weekly</option><option value="biweekly">Every 2 Weeks</option><option value="monthly">Monthly</option></Select></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">2FA Method</label><Select value={accountForm.two_factor_method} onChange={e => setAccountForm({...accountForm, two_factor_method: e.target.value})}><option value="none">None</option><option value="sms">SMS</option><option value="email">Email</option></Select></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveAccount}>Save Account</Btn>
  <Btn variant="slate" onClick={() => { setShowAccountForm(false); setEditingAccount(null); }}>Cancel</Btn>
  </div>
  </div>
  )}

  {utilAccounts.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-subtle-100">
  <div className="text-4xl mb-3">⚡</div>
  <div className="text-subtle-500 font-medium">No utility accounts connected</div>
  <div className="text-xs text-subtle-400 mt-1">Add your first account to start automated bill fetching</div>
  </div>
  ) : (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
  {utilAccounts.map(acct => (
  <div key={acct.id} className="bg-white rounded-xl border border-subtle-100 shadow-sm p-4">
  <div className="flex items-start justify-between mb-2">
  <div><div className="font-semibold text-subtle-800 text-sm">{acct.provider_display}</div><div className="text-xs text-subtle-400">{acct.property}</div></div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (acct.last_check_status === "success" ? "bg-positive-100 text-positive-700" : acct.last_check_status === "failed" ? "bg-danger-100 text-danger-700" : "bg-subtle-100 text-subtle-500")}>{acct.last_check_status || "never"}</span>
  </div>
  <div className="grid grid-cols-2 gap-2 text-xs mt-2">
  <div><span className="text-subtle-400">Account #</span><div className="font-semibold text-subtle-700">{acct.account_number || "—"}</div></div>
  <div><span className="text-subtle-400">Type</span><div className="font-semibold text-subtle-700 capitalize">{acct.account_type?.replace("_", "/")}</div></div>
  <div><span className="text-subtle-400">Last Checked</span><div className="font-semibold text-subtle-700">{acct.last_checked_at ? new Date(acct.last_checked_at).toLocaleDateString() : "Never"}</div></div>
  <div><span className="text-subtle-400">Frequency</span><div className="font-semibold text-subtle-700 capitalize">{acct.check_frequency}</div></div>
  </div>
  <div className="flex gap-2 mt-3 pt-3 border-t border-subtle-50">
  <TextLink tone="brand" size="xs" underline={false} onClick={() => triggerManualCheck(acct)} className="border border-brand-200 px-3 py-1 rounded-lg hover:bg-brand-50">🔄 Check Now</TextLink>
  <TextLink tone="danger" size="xs" onClick={() => deleteAccount(acct)} className="ml-auto">Delete</TextLink>
  </div>
  </div>
  ))}
  </div>
  )}

  {autoBills.length > 0 && (
  <div>
  <h3 className="font-semibold text-subtle-700 mb-3">Fetched Bills</h3>
  <div className="space-y-2">
  {autoBills.map(bill => (
  <div key={bill.id} className="bg-white rounded-xl border border-subtle-100 shadow-sm p-4 flex items-center gap-4">
  <div className="flex-1"><div className="font-semibold text-subtle-800 text-sm">{bill.provider_display || bill.provider}</div><div className="text-xs text-subtle-400">{bill.property} · Due {bill.due_date || "—"}</div></div>
  <div className="text-lg font-bold text-subtle-800">${safeNum(bill.amount).toLocaleString()}</div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (bill.status === "paid" ? "bg-positive-100 text-positive-700" : bill.status === "authorized" ? "bg-info-100 text-info-700" : "bg-warn-100 text-warn-700")}>{bill.status?.replace("_", " ")}</span>
  {bill.status === "pending_review" && <Btn variant="positive" size="sm" onClick={() => authorizeBillPayment(bill, "default_on_file")}>Authorize Pay</Btn>}
  </div>
  ))}
  </div>
  </div>
  )}
  </div>
  )}

  {/* ===== JOB HISTORY TAB ===== */}
  {utilTab === "jobs" && (
  <div>
  <h3 className="font-semibold text-subtle-700 mb-3">Automation Job History</h3>
  {autoJobs.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-subtle-100"><div className="text-subtle-400">No automation jobs yet</div></div>
  ) : (
  <div className="space-y-2">
  {autoJobs.map(job => (
  <div key={job.id} className="bg-white rounded-xl border border-subtle-100 shadow-sm p-4 flex items-center gap-4">
  <div className="flex-1"><div className="font-semibold text-subtle-800 text-sm capitalize">{job.job_type?.replace("_", " ")}</div><div className="text-xs text-subtle-400">{job.triggered_by} · {job.created_at ? new Date(job.created_at).toLocaleString() : ""}</div></div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (job.status === "completed" ? "bg-positive-100 text-positive-700" : job.status === "failed" ? "bg-danger-100 text-danger-700" : job.status === "running" ? "bg-info-100 text-info-700" : "bg-subtle-100 text-subtle-500")}>{job.status}</span>
  {job.error_message && <div className="text-xs text-danger-500 max-w-xs truncate">{job.error_message}</div>}
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* ===== MANUAL BILLS TAB ===== */}
  {utilTab === "bills" && (<>
  {/* Toolbar */}
  <div className="flex flex-col md:flex-row gap-3 mb-4">
  <div className="mr-auto"></div>
  <Input placeholder="Search..." value={utilSearch} onChange={e => setUtilSearch(e.target.value)} className="w-64" />
  <Select filter value={utilFilterStatus} onChange={e => setUtilFilterStatus(e.target.value)} >
  <option value="all">All Status</option><option value="pending">Pending</option><option value="paid">Paid</option>
  </Select>
  <Select filter value={utilFilterProp} onChange={e => setUtilFilterProp(e.target.value)} >
  <option value="all">All Properties</option>
  {[...new Set(utilities.map(u => u.property).filter(Boolean))].map(p => <option key={p} value={p}>{p}</option>)}
  </Select>
  <div className="flex bg-brand-50 rounded-2xl p-0.5">
  {[["card","▦"],["table","☰"]].map(([m,icon]) => (
  <button key={m} onClick={() => setUtilView(m)} className={`px-3 py-1.5 text-sm rounded-md ${utilView === m ? "bg-white shadow-sm text-brand-700 font-semibold" : "text-neutral-400"}`}>{icon}</button>
  ))}
  </div>
  <Btn onClick={() => setShowForm(!showForm)}>+ Add Bill</Btn>
  </div>

  {/* Stats */}
  <div className="flex gap-3 mb-4">
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center flex-1"><div className="text-lg font-manrope font-bold text-neutral-800">{utilities.length}</div><div className="text-xs text-neutral-400">Total</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-warn-600">{utilities.filter(u => u.status === "pending").length}</div><div className="text-xs text-neutral-400">Pending</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-success-600">${utilities.filter(u => u.status === "paid").reduce((s,u) => s + safeNum(u.amount), 0).toLocaleString()}</div><div className="text-xs text-neutral-400">Paid</div></div>
  <div className="bg-white rounded-3xl border border-brand-50 px-3 py-2 text-center flex-1"><div className="text-lg font-bold text-danger-500">${utilities.filter(u => u.status === "pending").reduce((s,u) => s + safeNum(u.amount), 0).toLocaleString()}</div><div className="text-xs text-neutral-400">Outstanding</div></div>
  </div>

  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">New Utility Bill</h3>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Provider</label><Input placeholder="e.g. PEPCO, Washington Gas" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Amount ($)</label><Input placeholder="150.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Due Date</label><Input type="date" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Responsibility</label><Select value={form.responsibility} onChange={e => setForm({ ...form, responsibility: e.target.value })}>
  {["owner", "tenant", "shared"].map(r => <option key={r}>{r}</option>)}
  </Select></div>
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Portal Login (encrypted)</p>
  <div className="grid grid-cols-3 gap-2">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" value={form.website||""} onChange={e => setForm({...form, website: e.target.value})} placeholder="https://..." /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input value={form.username||""} onChange={e => setForm({...form, username: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" value={form.password||""} onChange={e => setForm({...form, password: e.target.value})} /></div>
  </div></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={addUtility}>Save</Btn>
  <Btn variant="slate" onClick={() => setShowForm(false)}>Cancel</Btn>
  </div>
  </div>
  )}

  {(() => {
  const fu = utilities.filter(u =>
  (utilFilterStatus === "all" || u.status === utilFilterStatus) &&
  (utilFilterProp === "all" || u.property === utilFilterProp) &&
  (!utilSearch || u.provider?.toLowerCase().includes(utilSearch.toLowerCase()) || u.property?.toLowerCase().includes(utilSearch.toLowerCase()))
  );
  return <>
  {utilView === "card" && (
  <div className="space-y-3">
  {fu.map(u => (
  <div key={u.id} className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <div className="flex justify-between items-start">
  <div><div className="font-semibold text-neutral-800">{u.provider}</div><div className="text-xs text-neutral-400 mt-0.5">{u.property}</div></div>
  <div className="text-right"><div className="text-lg font-manrope font-bold text-neutral-800">${u.amount}</div><Badge status={u.status} /></div>
  </div>
  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
  <div><span className="text-neutral-400">Due</span><div className="font-semibold text-neutral-700">{u.due}</div></div>
  <div><span className="text-neutral-400">Responsibility</span><div className="font-semibold capitalize text-neutral-700">{u.responsibility}</div></div>
  <div><span className="text-neutral-400">Paid</span><div className="font-semibold text-neutral-700">{u.paid_at ? new Date(u.paid_at).toLocaleDateString() : "—"}</div></div>
  </div>
  <div className="mt-3 flex gap-2">
  {u.status === "pending" && <TextLink tone="positive" size="xs" underline={false} onClick={() => approvePay(u)} className="border border-positive-200 px-3 py-1 rounded-lg hover:bg-positive-50">✓ Pay</TextLink>}
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => openAuditLog(u)} className="border border-brand-100 px-3 py-1 rounded-lg hover:bg-brand-50/30">Audit</TextLink>
  </div>
  </div>
  ))}
  </div>
  )}
  {utilView === "table" && (
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 overflow-x-auto">
  <table className="w-full text-sm">
  <thead className="bg-brand-50/30 text-xs text-neutral-400 uppercase">
  <tr><th className="px-4 py-3 text-left">Provider</th><th className="px-4 py-3 text-left">Property</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-left">Due</th><th className="px-4 py-3 text-left">Status</th><th className="px-4 py-3 text-left">Resp.</th><th className="px-4 py-3 text-left">Portal</th><th className="px-4 py-3 text-right">Actions</th></tr>
  </thead>
  <tbody>
  {fu.map(u => (
  <tr key={u.id} className="border-t border-brand-50/50 hover:bg-brand-50/30/50">
  <td className="px-4 py-2.5 font-medium text-neutral-800">{u.provider}</td>
  <td className="px-4 py-2.5 text-neutral-500">{u.property}</td>
  <td className="px-4 py-2.5 text-right font-semibold">${u.amount}</td>
  <td className="px-4 py-2.5 text-neutral-400">{u.due}</td>
  <td className="px-4 py-2.5"><Badge status={u.status} /></td>
  <td className="px-4 py-2.5 text-neutral-500 capitalize">{u.responsibility}</td>
  <td className="px-4 py-2.5 text-xs">
  {u.website ? <a href={u.website} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline block truncate max-w-28">{u.website.replace(/^https?:\/\//, "")}</a> : <span className="text-neutral-300">—</span>}
  {u.username_encrypted && <TextLink tone="brand" size="xs" onClick={async () => { const s = new Set(showCreds); if (s.has(u.id)) { s.delete(u.id); setShowCreds(s); } else { u._decUser = await decryptCredential(u.username_encrypted, u.encryption_iv_username || u.encryption_iv, companyId, u.encryption_salt); u._decPass = await decryptCredential(u.password_encrypted, u.encryption_iv, companyId, u.encryption_salt); s.add(u.id); setShowCreds(new Set(s)); }}}>{showCreds.has(u.id) ? "Hide" : "Show"} login</TextLink>}
  {showCreds.has(u.id) && <div className="text-neutral-600 mt-0.5">{u._decUser || "—"} / {u._decPass || "—"}</div>}
  </td>
  <td className="px-4 py-2.5 text-right whitespace-nowrap">
  {u.status === "pending" && <TextLink tone="positive" size="xs" onClick={() => approvePay(u)} className="mr-2">Pay</TextLink>}
  <TextLink tone="neutral" size="xs" onClick={() => openAuditLog(u)}>Audit</TextLink>
  </td>
  </tr>
  ))}
  </tbody>
  </table>
  </div>
  )}
  {fu.length === 0 && <div className="text-center py-8 text-neutral-400">No utility bills found</div>}
  </>;
  })()}
  </>)}
  </div>
  );
}

export { Utilities };
