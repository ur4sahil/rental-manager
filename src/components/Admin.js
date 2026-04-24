import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, Checkbox, EmptyState, FileInput, FilterPill, Input, PageHeader, Select, TextLink} from "../ui";
import { safeNum, formatCurrency, escapeFilterValue, normalizeEmail, formatPersonName, parseNameParts, formatPhoneInput, parseLocalDate, emailFilterValue, getWizardApplicableSteps, WIZARD_STEP_LABELS, canReviewRequest } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { runDataIntegrityChecks, saveCompanySettings } from "../utils/company";
import { queueNotification } from "../utils/notifications";
import { COMPANY_DEFAULTS } from "../config";
import { Spinner } from "./shared";

// ============ ROLE DEFINITIONS ============
// Mirror of ROLES in App.js. The two must stay in sync — App.js is
// the source of truth for page access, Admin.js uses this to render
// the role legend, the role dropdown, and the "customizable modules"
// UI. The older in-file copy diverged over time (missing manager,
// tax_bills, messages, latefees); keeping one canonical shape here
// prevents that from silently happening again.
const ROLES = {
  admin: { label: "Admin", color: "bg-brand-600", pages: ["dashboard","tasks","properties","tenants","payments","maintenance","utilities","hoa","loans","insurance","tax_bills","accounting","owners","notifications","messages","admin","documents","doc_builder","leases","autopay","inspections","vendors","moveout","evictions","latefees"] },
  manager: { label: "Manager", color: "bg-brand-400", pages: ["dashboard","tasks","properties","tenants","payments","maintenance","utilities","hoa","tax_bills","accounting","notifications","messages","documents","doc_builder","leases","inspections","vendors","moveout","evictions"] },
  office_assistant: { label: "Office Assistant", color: "bg-info-500", pages: ["dashboard","tasks","properties","tenants","payments","maintenance","utilities","hoa","tax_bills","accounting","notifications","messages","admin","documents","doc_builder","leases","inspections","vendors","moveout","evictions"] },
  accountant: { label: "Accountant", color: "bg-positive-600", pages: ["dashboard","accounting","payments","utilities"] },
  maintenance: { label: "Maintenance", color: "bg-notice-500", pages: ["maintenance","vendors"] },
  tenant: { label: "Tenant", color: "bg-brand-50/300", pages: ["tenant_portal"] },
  owner: { label: "Owner", color: "bg-highlight-600", pages: ["owner_portal","loans"] },
};

const ALL_NAV = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "tasks", label: "Tasks & Approvals", icon: "assignment" },
  { id: "properties", label: "Properties", icon: "apartment", children: [
    { id: "maintenance", label: "Maintenance", icon: "build" },
    { id: "inspections", label: "Inspections", icon: "checklist" },
    { id: "utilities", label: "Utilities", icon: "bolt" },
    { id: "hoa", label: "HOA Payments", icon: "holiday_village" },
    { id: "loans", label: "Loans", icon: "account_balance_wallet" },
    { id: "insurance", label: "Insurance", icon: "verified_user" },
  ]},
  { id: "tenants", label: "Tenants", icon: "people" },
  { id: "payments", label: "Payments", icon: "payments" },
  { id: "accounting", label: "Accounting", icon: "account_balance" },
  { id: "doc_builder", label: "Document Builder", icon: "description" },
  { id: "vendors", label: "Vendors", icon: "engineering" },
  { id: "owners", label: "Owners", icon: "person" },
  { id: "messages", label: "Messages", icon: "forum" },
  { id: "notifications", label: "Notifications", icon: "notifications_active" },
];
// Flat list of all nav IDs including children (for settings UI and allowedPages)
const ALL_NAV_FLAT = ALL_NAV.flatMap(n => n.children ? [n, ...n.children] : [n]);
// Child page IDs that live under a parent in sidebar
const NAV_CHILD_IDS = new Set(ALL_NAV.flatMap(n => (n.children || []).map(c => c.id)));


// ============ REUSABLE ARCHIVED ITEMS COMPONENT ============
function ArchivedItems({ tableName, label, fields, companyId, addNotification, onRestore, showConfirm, userProfile, userRole }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchItems(); }, [companyId]);

  async function fetchItems() {
  setLoading(true);
  const { data } = await supabase.from(tableName).select(fields).eq("company_id", companyId).not("archived_at", "is", null).order("archived_at", { ascending: false }).limit(200);
  setItems(data || []);
  setLoading(false);
  }

  async function restore(item) {
  if (!await showConfirm({ message: "Restore this " + label.toLowerCase() + "?" })) return;
  const { error } = await supabase.from(tableName).update({ archived_at: null, archived_by: null }).eq("id", item.id).eq("company_id", companyId);
  if (error) { pmError("PM-8006", { raw: error, context: "restoring archived " + label.toLowerCase() }); return; }
  addNotification("♻️", "Restored " + label + ": " + (item.address || item.name || item.issue || item.tenant || "item"));
  fetchItems();
  if (onRestore) onRestore();
  }

  async function permanentDelete(item) {
  if (!await showConfirm({ message: "PERMANENTLY delete this " + label.toLowerCase() + "? This cannot be undone.", variant: "danger", confirmText: "Delete" })) return;
  const { error } = await supabase.from(tableName).delete().eq("id", item.id).eq("company_id", companyId);
  if (error) { pmError("PM-8006", { raw: error, context: "permanently deleting " + label.toLowerCase() }); return; }
  logAudit("delete", tableName, "Permanently deleted " + label + ": " + (item.name || item.address || item.id), item.id, userProfile?.email, userRole, companyId);
  addNotification("🗑️", "Deleted " + label);
  fetchItems();
  }

  if (loading) return <Spinner />;

  return (
  <div>
  {items.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-subtle-100"><div className="text-subtle-400">No archived {label.toLowerCase()}s</div></div>
  ) : (
  <div className="space-y-2">
  {items.map(item => (
  <div key={item.id} className="bg-white rounded-xl border border-subtle-200 p-4 flex items-center gap-4 opacity-70">
  <div className="flex-1">
  <div className="font-semibold text-subtle-700 text-sm">{item.address || item.name || item.issue || item.tenant || "Item"}</div>
  <div className="text-xs text-subtle-400">
  {item.property && <span>{item.property} · </span>}
  {item.amount && <span>${Number(item.amount).toLocaleString()} · </span>}
  Archived {item.archived_at ? new Date(item.archived_at).toLocaleDateString() : ""}
  {item.archived_by && <span> by {item.archived_by}</span>}
  </div>
  <div className="text-xs text-warn-600 mt-1">{item.archived_at ? Math.max(0, 180 - Math.floor((Date.now() - new Date(item.archived_at)) / 86400000)) : "?"} days until auto-purge</div>
  </div>
  <Btn variant="success" size="sm" onClick={() => restore(item)}>♻️ Restore</Btn>
  <Btn variant="danger" size="sm" onClick={() => permanentDelete(item)}>🗑️ Delete</Btn>
  </div>
  ))}
  </div>
  )}
  </div>
  );
}


// ============ ROLE MANAGEMENT ============
function RoleManagement({ addNotification, companyId, showToast, showConfirm, userProfile }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null); // user being edited
  const [form, setForm] = useState({ email: "", role: "office_assistant", name: "", first_name: "", mi: "", last_name: "", manager_email: "" });
  // customPages: which modules are toggled ON when adding/editing a user
  const [customPages, setCustomPages] = useState([]);

  // All modules that can be assigned (admin and tenant are fixed, not customizable)
  const CUSTOMIZABLE_ROLES = ["office_assistant", "accountant", "maintenance", "manager"];

  // Candidate reviewers for the "Manager" dropdown. Includes admins and
  // any existing manager — they're the only roles that can approve.
  const managerCandidates = users.filter(u => u.role === "admin" || u.role === "manager");

  useEffect(() => { fetchUsers(); }, [companyId]);

  async function fetchUsers() {
  const [{ data }, { data: mems }] = await Promise.all([
    supabase.from("app_users").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }),
    supabase.from("company_members").select("user_email, status").eq("company_id", companyId),
  ]);
  const memMap = Object.fromEntries((mems || []).map(m => [m.user_email?.toLowerCase(), m.status]));
  setUsers((data || []).map(u => ({ ...u, _memberStatus: memMap[u.email?.toLowerCase()] || null })));
  setLoading(false);
  }

  // When role changes in the form, pre-fill the default pages for that role
  function handleRoleChange(role) {
  setForm(f => ({ ...f, role }));
  setCustomPages(ROLES[role]?.pages ? [...ROLES[role].pages] : []);
  }

  function togglePage(pageId) {
  setCustomPages(prev =>
  prev.includes(pageId) ? prev.filter(p => p !== pageId) : [...prev, pageId]
  );
  }

  function startAdd() {
  setEditingUser(null);
  setForm({ email: "", role: "office_assistant", name: "", first_name: "", mi: "", last_name: "", manager_email: "" });
  setCustomPages([...ROLES["office_assistant"].pages]);
  setShowForm(true);
  }

  function startEdit(u) {
  setEditingUser(u);
  const parsed = parseNameParts(u.name);
  setForm({ email: u.email, role: u.role, name: u.name, first_name: u.first_name || parsed.first_name, mi: u.middle_initial || parsed.middle_initial, last_name: u.last_name || parsed.last_name, manager_email: u.manager_email || "" });
  // Load their custom pages if saved, otherwise use role defaults
  const savedPages = u.custom_pages ? JSON.parse(u.custom_pages) : ROLES[u.role]?.pages || [];
  setCustomPages([...savedPages]);
  setShowForm(true);
  }

  async function saveUser() {
  if (!guardSubmit("saveUser")) return;
  try {
  if (!form.email.trim()) { showToast("Email is required.", "error"); return; }
  if (!form.name.trim()) { showToast("Name is required.", "error"); return; }
  if (!form.email.trim() || !form.email.includes("@")) { showToast("Please enter a valid email address.", "error"); return; }
  if (customPages.length === 0) { showToast("Please select at least one module.", "error"); return; }

  // Admin/tenant never get a manager — admin sits at the top of the
  // approval chain, and tenants don't submit staff requests.
  const managerEmail = (form.role === "admin" || form.role === "tenant") ? null : (form.manager_email || null);
  const payload = {
  email: form.email,
  role: form.role,
  name: form.name,
  first_name: form.first_name,
  middle_initial: form.mi,
  last_name: form.last_name,
  manager_email: managerEmail,
  custom_pages: JSON.stringify(customPages),
  company_id: companyId,
  };

  if (editingUser) {
  const emailChanged = editingUser.email && normalizeEmail(editingUser.email) !== normalizeEmail(payload.email);
  if (emailChanged) {
  // Atomic email change: delete old membership + update user + create new membership in one transaction
  try {
  const { error: rpcErr } = await supabase.rpc("change_user_email", {
  p_company_id: companyId,
  p_user_id: String(editingUser.id),
  p_old_email: editingUser.email,
  p_new_email: payload.email,
  p_name: payload.name,
  p_role: payload.role,
  p_custom_pages: JSON.stringify(customPages),
  });
  if (rpcErr) throw new Error(rpcErr.message);
  // RPC signature doesn't accept manager_email — tack it on after.
  await supabase.from("app_users").update({ manager_email: managerEmail })
    .eq("company_id", companyId).eq("id", editingUser.id);
  await supabase.from("company_members").update({ manager_email: managerEmail })
    .eq("company_id", companyId).ilike("user_email", emailFilterValue(payload.email));
  } catch (rpcE) {
  pmError("PM-1009", { raw: rpcE, context: "update user email via RPC" });
  return;
  }
  } else {
  // No email change — just update role/name/pages + manager
  const { error } = await supabase.from("app_users").update({ email: normalizeEmail(payload.email), role: payload.role, name: payload.name, manager_email: managerEmail, custom_pages: payload.custom_pages, company_id: payload.company_id }).eq("company_id", companyId).eq("id", editingUser.id);
  if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }
  await supabase.from("company_members").upsert([{ company_id: companyId, user_email: (form.email || "").toLowerCase(), user_name: form.name, role: form.role, status: "active", manager_email: managerEmail, custom_pages: JSON.stringify(customPages) }], { onConflict: "company_id,user_email" });
  }
  addNotification("👥", `${form.name}'s access updated`);
  } else {
  const { error, data: newUser } = await supabase.from("app_users").insert([{ ...payload, email: normalizeEmail(payload.email) }]).select();
  if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }
  // Also add to company_members
  await supabase.from("company_members").upsert([{ company_id: companyId, user_email: (form.email || "").toLowerCase(), user_name: form.name, role: form.role, status: "active", manager_email: managerEmail, custom_pages: JSON.stringify(customPages) }], { onConflict: "company_id,user_email" });
  addNotification("👥", `${form.name} added as ${ROLES[form.role]?.label}`);
  // Offer to send invite
  if (newUser?.[0] && await showConfirm({ message: `${form.name} has been added!\n\nWould you like to send them a login invite now?` })) {
  await inviteUser({ ...newUser[0], ...payload });
  }
  }

  setShowForm(false);
  setEditingUser(null);
  setForm({ email: "", role: "office_assistant", name: "", first_name: "", mi: "", last_name: "" });
  setCustomPages([]);
  fetchUsers();
  } finally { guardRelease("saveUser"); }
  }

  async function removeUser(id, name, email) {
  if (!guardSubmit("removeUser")) return;
  try {
  if (!await showConfirm({ message: `Remove ${name}?`, variant: "danger", confirmText: "Delete" })) return;
  await supabase.from("app_users").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
  // Also deactivate their company membership
  if (email) {
  const { error: _err7920 } = await supabase.from("company_members").update({ status: "removed" }).eq("company_id", companyId).eq("user_email", email.toLowerCase());
  if (_err7920) { showToast("Error updating company_members: " + _err7920.message, "error"); return; }
  }
  addNotification("👥", `${name} removed`);
  fetchUsers();
  } finally { guardRelease("removeUser"); }
  }

  async function inviteUser(user) {
  if (!guardSubmit("inviteUser")) return;
  try {
  if (!user.email) { showToast("This user has no email address.", "error"); return; }
  const roleName = ROLES[user.role]?.label || user.role;
  if (!await showConfirm({ message: `Send login invite to ${user.name} (${user.email})?\n\nRole: ${roleName}\n\nThis will:\n1. Create their authentication account\n2. Send a magic link to their email\n3. They can log in and access their assigned modules` })) return;
  try {
  // Routed server-side: /api/invite-user uses service role + admin.inviteUserByEmail,
  // which bypasses Supabase Bot Protection captcha. An authenticated admin
  // shouldn't have to solve a captcha every time they add a teammate.
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) { showToast("Session expired — please sign in again.", "error"); return; }
  const resp = await fetch("/api/invite-user", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
  body: JSON.stringify({
  email: (user.email || "").trim().toLowerCase(),
  companyId,
  userName: user.name,
  role: user.role,
  inviteType: "team",
  }),
  });
  if (!resp.ok) {
  let errMsg = "Invite failed (" + resp.status + ")";
  try { errMsg = (await resp.json()).error || errMsg; } catch (_) {}
  pmError("PM-1007", { raw: { message: errMsg }, context: "send team invitation to " + user.email });
  showToast(errMsg, "error");
  return;
  }
  let respJson = {};
  try { respJson = await resp.json(); } catch (_) {}
  addNotification("✉️", `Invite sent to ${user.name} (${roleName})`);
  logAudit("create", "team", "Invited " + user.name + " as " + roleName + ": " + user.email, user.id || "", "", "admin", companyId);
  if (respJson.already_registered) {
  // User already has a Housify account. The server tried to send a
  // magic-link email so they can click through and accept the new
  // pending membership. If that send failed, fall back to
  // "Pending Invites on Company Selector" messaging.
  if (respJson.magic_link_sent) {
    showToast(`Magic-link email sent to ${user.email}. Once they sign in, your invite is waiting under "Pending Invites" on the Company Selector.`, "success");
  } else {
    showToast(`${user.email} already has an account. They'll see your invite as "Pending Invites" on their Company Selector the next time they sign in.`, "success");
  }
  } else {
  showToast(`Invite sent to ${user.email}!\n\nThey will receive an invite email to set up their account.`, "success");
  }
  } catch (e) {
  showToast("Error sending invite: " + e.message, "error");
  }
  } finally { guardRelease("inviteUser"); }
  }

  // Get the effective pages for a user — custom_pages takes priority over role default
  function getEffectivePages(u) {
  if (u.custom_pages) {
  try { return JSON.parse(u.custom_pages); } catch { /* fall through */ }
  }
  return ROLES[u.role]?.pages || [];
  }

  if (loading) return <Spinner />;

  const isCustomizable = CUSTOMIZABLE_ROLES.includes(form.role);

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <div>
  <PageHeader title="Team & Role Management" />
  <p className="text-xs text-neutral-400 mt-0.5">Add team members and choose exactly which modules they can access</p>
  </div>
  <Btn onClick={startAdd}>+ Add User</Btn>
  </div>

  {/* Role legend */}
  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-5">
  {Object.entries(ROLES).map(([key, r]) => (
  <div key={key} className="bg-white rounded-3xl border border-brand-50 p-3 text-center">
  <div className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-white mb-1 ${r.color}`}>{r.label}</div>
  <div className="text-xs text-neutral-400">{key === "admin" ? "Full access" : key === "tenant" ? "Portal only" : "Customizable"}</div>
  </div>
  ))}
  </div>

  {/* Add / Edit form */}
  {showForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h3 className="text-sm font-semibold text-neutral-700 mb-3">{editingUser ? `Edit — ${editingUser.name}` : "Add Team Member"}</h3>

  {/* Basic info */}
  <div className="grid grid-cols-6 gap-2 mb-3">
  <div className="col-span-2"><label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-1 block">First Name *</label><Input size="sm" value={form.first_name} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, first_name: v, name: formatPersonName(v, f.mi, f.last_name) })); }} placeholder="First" /></div>
  <div className="col-span-1"><label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-1 block">MI</label><Input size="sm" maxLength={1} value={form.mi} onChange={e => { const v = e.target.value.toUpperCase(); setForm(f => ({ ...f, mi: v, name: formatPersonName(f.first_name, v, f.last_name) })); }} placeholder="M" className="text-center" /></div>
  <div className="col-span-3"><label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-1 block">Last Name *</label><Input size="sm" value={form.last_name} onChange={e => { const v = e.target.value; setForm(f => ({ ...f, last_name: v, name: formatPersonName(f.first_name, f.mi, v) })); }} placeholder="Last" /></div>
  <div className="col-span-4"><label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-1 block">Email *</label><Input size="sm" type="email" placeholder="Email address" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} disabled={!!editingUser} autoComplete="off" className="disabled:bg-brand-50/30 disabled:text-neutral-400" /></div>
  <div className="col-span-2"><label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-1 block">Role</label><Select size="sm" value={form.role} onChange={e => handleRoleChange(e.target.value)}>
  {Object.entries(ROLES).filter(([k]) => k !== "tenant").map(([key, r]) => (
  <option key={key} value={key}>{r.label}</option>
  ))}
  </Select></div>
  {/* Approval manager — which admin/manager reviews this user's
      property-change and document-exception requests. Hidden for
      admin (no reviewer above them) and tenant (doesn't submit). */}
  {form.role !== "admin" && form.role !== "tenant" && (
  <div className="col-span-6"><label className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider mb-1 block">Approval Manager <span className="text-neutral-400 normal-case">(who reviews their edit/exception requests)</span></label>
  <Select size="sm" value={form.manager_email} onChange={e => setForm({ ...form, manager_email: e.target.value })}>
  <option value="">— No manager (admin reviews) —</option>
  {managerCandidates.filter(m => m.email && m.email !== form.email).map(m => (
  <option key={m.id} value={m.email}>{m.name || m.email} ({ROLES[m.role]?.label || m.role})</option>
  ))}
  </Select></div>
  )}
  </div>

  {/* Module picker — only shown for customizable roles */}
  {isCustomizable && (
  <div className="border border-brand-100 rounded-2xl p-3 bg-brand-50/20">
  <div className="flex items-center justify-between mb-2">
  <div className="text-xs font-semibold text-neutral-700">Module access <span className="ml-1 text-neutral-400 font-normal">· {customPages.length} of {ALL_NAV_FLAT.length}</span></div>
  <div className="flex gap-2 text-xs">
  <TextLink tone="brand" size="xs" onClick={() => setCustomPages(ALL_NAV_FLAT.map(n => n.id))}>Select all</TextLink>
  <span className="text-neutral-300">|</span>
  <TextLink tone="neutral" size="xs" onClick={() => setCustomPages([])}>Clear all</TextLink>
  </div>
  </div>
  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-0.5">
  {ALL_NAV_FLAT.map(nav => {
  const isOn = customPages.includes(nav.id);
  return (
  <label key={nav.id} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-brand-50 cursor-pointer text-xs text-neutral-600">
  <Checkbox checked={isOn} onChange={() => togglePage(nav.id)} className="accent-brand-600 w-3.5 h-3.5" />
  <span className="material-icons-outlined text-sm text-neutral-400">{nav.icon}</span>
  <span className={isOn ? "text-neutral-700 font-medium" : ""}>{nav.label}</span>
  </label>
  );
  })}
  </div>
  </div>
  )}

  {/* Admin / Maintenance / Tenant — fixed access notice */}
  {!isCustomizable && (
  <div className="bg-info-50 border border-info-100 rounded-xl p-2.5 text-xs text-info-700">
  <strong>{ROLES[form.role]?.label}</strong> has fixed access and cannot be customized.
  {form.role === "admin" && " Admins always have full access to everything."}
  {form.role === "maintenance" && " Maintenance staff can only see the Maintenance page."}
  </div>
  )}

  <div className="flex gap-2 mt-3">
  <Btn
    size="sm"
    onClick={saveUser}
    disabled={!form.first_name.trim() || !form.last_name.trim() || !form.email.trim() || !form.email.includes("@") || customPages.length === 0}
  >
    {editingUser ? "Save Changes" : "Add User"}
  </Btn>
  <Btn size="sm" variant="secondary" onClick={() => { setShowForm(false); setEditingUser(null); setForm({ email: "", role: "office_assistant", name: "", first_name: "", mi: "", last_name: "", manager_email: "" }); setCustomPages([]); }}>
  Cancel
  </Btn>
  </div>
  </div>
  )}

  {/* User list */}
  <div className="space-y-3">
  {users.map(u => {
  const effectivePages = getEffectivePages(u);
  return (
  <div key={u.id} className="bg-white rounded-3xl shadow-card border border-brand-50 p-4">
  <div className="flex justify-between items-center">
  <div className="flex items-center gap-3">
  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold ${ROLES[u.role]?.color || "bg-neutral-400"}`}>
  {u.name?.[0]}
  </div>
  <div>
  <div className="font-semibold text-neutral-800 text-sm">{u.name}</div>
  <div className="text-xs text-neutral-400">{u.email}</div>
  </div>
  </div>
  <div className="flex items-center gap-2">
  <span className={`text-xs font-semibold text-white px-2 py-0.5 rounded-full ${ROLES[u.role]?.color || "bg-neutral-400"}`}>
  {ROLES[u.role]?.label}
  </span>
  <Btn variant="secondary" size="xs" onClick={() => inviteUser(u)}>
  {u._memberStatus ? "✉️ Resend Invite" : "✉️ Invite"}
  </Btn>
  <Btn variant="secondary" size="xs" onClick={() => startEdit(u)}>
  ✏️ Edit
  </Btn>
  <Btn variant="danger" size="xs" onClick={() => removeUser(u.id, u.name, u.email)}>
  Remove
  </Btn>
  </div>
  </div>
  {/* Show their current module access */}
  <div className="mt-3 flex flex-wrap gap-1">
  {effectivePages.map(p => {
  const nav = ALL_NAV_FLAT.find(n => n.id === p);
  return (
  <span key={p} className="inline-flex items-center gap-1 text-xs bg-brand-50 text-brand-700 border border-brand-100 px-2 py-0.5 rounded-full">
  {nav ? <><span className="material-icons-outlined text-xs">{nav.icon}</span>{nav.label}</> : p}
  </span>
  );
  })}
  </div>
  {u.custom_pages && (
  <div className="mt-1 text-xs text-neutral-400">Custom access · {effectivePages.length} modules</div>
  )}
  </div>
  );
  })}
  {users.length === 0 && (
  <div className="text-center py-10 text-neutral-400">No team members added yet. Click + Add User to get started.</div>
  )}
  </div>
  </div>
  );
}


// ============ ARCHIVE (SOFT-DELETED ITEMS) ============
// NOTE: Stale "invited" membership records (>30 days old, never accepted) should be
// periodically cleaned up. Run: DELETE FROM company_members WHERE status = 'invited'
// AND created_at < NOW() - INTERVAL '30 days';

function ArchivePage({ addNotification, userProfile, userRole, companyId, showConfirm, showToast }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");

  useEffect(() => { fetchArchived(); }, [companyId]);

  async function fetchArchived() {
  setLoading(true);
  const tables = [
  { name: "properties", label: "Property", fields: "id, address, type, status, archived_at, archived_by" },
  { name: "tenants", label: "Tenant", fields: "id, name, email, property, archived_at, archived_by" },
  { name: "work_orders", label: "Work Order", fields: "id, issue, property, status, archived_at" },
  { name: "documents", label: "Document", fields: "id, name, property, type, archived_at" },
  { name: "leases", label: "Lease", fields: "id, tenant_name, property, status, archived_at" },
  { name: "payments", label: "Payment", fields: "id, tenant, property, amount, archived_at" },
  { name: "vendors", label: "Vendor", fields: "id, name, email, phone, archived_at, archived_by" },
  { name: "hoa_payments", label: "HOA Payment", fields: "id, property, amount, due_date, status, archived_at, archived_by" },
  { name: "autopay_schedules", label: "Autopay Schedule", fields: "id, tenant, property, amount, archived_at, archived_by" },
  { name: "recurring_journal_entries", label: "Recurring Entry", fields: "id, description, status, archived_at, archived_by" },
  { name: "late_fee_rules", label: "Late Fee Rule", fields: "id, name, fee_type, fee_amount, archived_at, archived_by" },
  { name: "app_users", label: "Team Member", fields: "id, name, email, role, archived_at, archived_by" },
  { name: "doc_generated", label: "Generated Doc", fields: "id, template_name, property, archived_at, archived_by" },
  ];
  let all = [];
  for (const t of tables) {
  const { data } = await supabase.from(t.name).select(t.fields).eq("company_id", companyId).not("archived_at", "is", null).order("archived_at", { ascending: false });
  if (data) {
  all = all.concat(data.map(d => ({ ...d, _table: t.name, _label: t.label })));
  }
  }
  all.sort((a, b) => new Date(b.archived_at) - new Date(a.archived_at));
  setItems(all);
  setLoading(false);
  }

  async function restoreItem(item) {
  if (!await showConfirm({ message: `Restore this ${item._label.toLowerCase()}?` })) return;
  const { error } = await supabase.from(item._table).update({ archived_at: null, archived_by: null }).eq("id", item.id).eq("company_id", companyId);
  if (error) {
  pmError("PM-2004", { raw: error, context: "restore archived item" });
  return;
  }
  // If restoring a property, also offer to restore its archived tenant
  if (item._table === "properties" && item.address) {
  const { data: archivedTenants } = await supabase.from("tenants").select("id, name").eq("company_id", companyId).eq("property", item.address).not("archived_at", "is", null);
  if (archivedTenants?.length > 0) {
  const shouldRestore = await showConfirm({ message: `Found ${archivedTenants.length} archived tenant(s) for this property: ${archivedTenants.map(t => t.name).join(", ")}\n\nWould you like to restore them too?` });
  if (shouldRestore) {
  for (const t of archivedTenants) {
  const { error: tErr } = await supabase.from("tenants").update({ archived_at: null, archived_by: null, lease_status: "active" }).eq("id", t.id).eq("company_id", companyId);
  if (tErr) pmError("PM-3002", { raw: tErr, context: "restore tenant " + t.name, silent: true });
  }
  // Also restore associated leases
  const { error: lErr } = await supabase.from("leases").update({ archived_at: null, status: "active" }).eq("company_id", companyId).eq("property", item.address).not("archived_at", "is", null);
  if (lErr) pmError("PM-3004", { raw: lErr, context: "restore leases", silent: true });
  addNotification("♻️", `Restored property + ${archivedTenants.length} tenant(s)`);
  }
  }
  }
  // If restoring a tenant, update their property back to occupied
  if (item._table === "tenants" && item.property) {
  const { error: propErr } = await supabase.from("properties").update({ status: "occupied", tenant: item.name }).eq("company_id", companyId).eq("address", item.property).is("archived_at", null);
  if (propErr) pmError("PM-2002", { raw: propErr, context: "update property on restore", silent: true });
  }
  // Reactivate accounting class if restoring a property
  if (item._table === "properties" && item.address) {
  await supabase.from("acct_classes").update({ is_active: true }).eq("company_id", companyId).eq("name", item.address);
  }
  addNotification("♻️", `Restored ${item._label}: ${item.address || item.name || item.issue || item.tenant_name || item.tenant || "item"}`);
  fetchArchived();
  }

  async function permanentDelete(item) {
  if (!await showConfirm({ message: `PERMANENTLY delete this ${item._label.toLowerCase()}? This cannot be undone.`, variant: "danger", confirmText: "Delete" })) return;
  const { error } = await supabase.from(item._table).delete().eq("id", item.id).eq("company_id", companyId);
  if (error) { pmError("PM-8006", { raw: error, context: "permanent delete" }); return; }
  logAudit("delete", item._table, "Permanently deleted " + item._label + ": " + (item.name || item.address || item.id), item.id, userProfile?.email, userRole, companyId);
  addNotification("🗑️", `Permanently deleted ${item._label}`);
  fetchArchived();
  }

  const filtered = filter === "all" ? items : items.filter(i => i._table === filter);
  const tables = [...new Set(items.map(i => i._table))];
  const daysUntilPurge = (item) => Math.max(0, 180 - Math.floor((new Date() - new Date(item.archived_at)) / 86400000));

  function getItemTitle(item) {
  return item.address || item.name || item.issue || item.tenant_name || item.tenant || item.description || item.template_name || "Unnamed";
  }

  function getItemSubtitle(item) {
  return item.property || item.email || item.type || item.status || item.fee_type || item.role || item.due_date || "";
  }

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <div>
  <PageHeader title="Archive" />
  <p className="text-xs text-neutral-400 mt-1">Archived items are auto-purged after 180 days</p>
  </div>
  <div className="text-sm text-neutral-400">{items.length} archived item{items.length !== 1 ? "s" : ""}</div>
  </div>

  <div className="flex gap-2 mb-4 flex-wrap">
  <FilterPill active={filter === "all"} onClick={() => setFilter("all")}>All ({items.length})</FilterPill>
  {tables.map(t => {
  const count = items.filter(i => i._table === t).length;
  const label = t.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase());
  return <FilterPill key={t} active={filter === t} onClick={() => setFilter(t)}><span className="capitalize">{label} ({count})</span></FilterPill>;
  })}
  </div>

  {loading ? <div className="text-center py-8 text-neutral-400">Loading...</div> : filtered.length === 0 ? (
  <div className="text-center py-16">
  <div className="text-4xl mb-3">📦</div>
  <div className="text-neutral-400">No archived items</div>
  <div className="text-xs text-neutral-300 mt-1">Deleted items will appear here for 180 days</div>
  </div>
  ) : (
  <div className="space-y-2">
  {filtered.map(item => (
  <div key={item._table + item.id} className="bg-white rounded-3xl shadow-card border border-brand-50 p-4 flex items-center gap-4">
  <div className="w-10 h-10 rounded-full bg-neutral-100 flex items-center justify-center text-lg">
  {item._table === "properties" ? "🏠" : item._table === "tenants" ? "👤" : item._table === "work_orders" ? "🔧" : item._table === "documents" || item._table === "doc_generated" ? "📄" : item._table === "leases" ? "📋" : item._table === "vendors" ? "🏗️" : item._table === "hoa_payments" ? "🏘️" : item._table === "autopay_schedules" ? "🔄" : item._table === "recurring_journal_entries" ? "📊" : item._table === "late_fee_rules" ? "⚠️" : item._table === "app_users" ? "👥" : "💰"}
  </div>
  <div className="flex-1 min-w-0">
  <div className="font-semibold text-neutral-800 text-sm">{getItemTitle(item)}</div>
  <div className="text-xs text-neutral-400">{item._label} · {getItemSubtitle(item)}</div>
  <div className="text-xs text-neutral-300 mt-0.5">Archived {new Date(item.archived_at).toLocaleDateString()} {item.archived_by ? "by " + item.archived_by : ""} · <span className={daysUntilPurge(item) < 30 ? "text-danger-400 font-semibold" : "text-neutral-400"}>{daysUntilPurge(item)} days until auto-purge</span></div>
  </div>
  <div className="flex gap-2 shrink-0">
  <Btn variant="success" size="sm" onClick={() => restoreItem(item)}>♻️ Restore</Btn>
  <Btn variant="danger" size="sm" onClick={() => permanentDelete(item)}>🗑️ Delete</Btn>
  </div>
  </div>
  ))}
  </div>
  )}
  </div>
  );
}


// ============ TASKS & APPROVALS PAGE ============
// ─── TasksList ─────────────────────────────────────────────────────
//
// Renders the Pending Tasks section. Previously a flat list of
// "Setup: X — Address" rows — nine rows per half-configured property
// — which made the page a wall of text on mobile. Now each property
// with wizard-skip tasks collapses into a single card that rolls
// down to reveal the per-step actions. Non-wizard tasks (balance
// due, lease expiring, HOA due, …) stay as flat rows below.
//
// Per-step actions on the expanded card:
//   • Open Setup — jumps the wizard directly to that step (startAtStep)
//   • Admin: Mark Complete — same as before (admin/owner/manager)
//   • Request Exception — staff without approve rights file a routed
//     doc_exception_request; the step is badged "Exception pending"
function TasksList({ tasks, userRole, userProfile, companyId, setPage, approveWizardSkip, showConfirm, showToast, addNotification, onRefresh, openExceptions }) {
  const [expanded, setExpanded] = React.useState({});
  const canApprove = userRole === "admin" || userRole === "owner" || userRole === "manager";

  // Bundle every task that's scoped to a property address — wizard
  // setup steps, tenant doc-pending, balance-due, lease-expiring,
  // work order emergencies. One collapsible card per property; the
  // pill counts total tasks (not just wizard_skip) and shows a
  // second "N high" pill when any of them are priority=high.
  // Anything without an address (rare — shouldn't happen in practice)
  // stays as a flat row at the bottom.
  const propertyTasks = tasks.filter(t => t.address);
  const otherTasks = tasks.filter(t => !t.address);

  const byProp = new Map();
  for (const t of propertyTasks) {
    const key = t.address;
    if (!byProp.has(key)) byProp.set(key, { address: key, propertyId: t.propertyId || null, rows: [], highCount: 0 });
    const bucket = byProp.get(key);
    if (!bucket.propertyId && t.propertyId) bucket.propertyId = t.propertyId;
    bucket.rows.push(t);
    if (t.priority === "high") bucket.highCount++;
  }

  async function requestException(t) {
    if (!await showConfirm({ message: `Request a waiver on "${t.wizardStepLabel}" for ${(t.address || "").split(",")[0]}? Your assigned manager will review.` })) return;
    try {
      const { data: me } = await supabase.from("app_users").select("manager_email").eq("company_id", companyId).ilike("email", (userProfile?.email || "").toLowerCase()).maybeSingle();
      let approver = me?.manager_email || null;
      if (!approver) {
        const { data: adm } = await supabase.from("company_members").select("user_email").eq("company_id", companyId).eq("role", "admin").eq("status", "active").limit(1).maybeSingle();
        approver = adm?.user_email || null;
      }
      await supabase.from("doc_exception_requests").insert([{
        company_id: companyId,
        tenant_name: "Setup: " + t.address,
        property: t.address,
        doc_type: t.wizardStepLabel,
        requested_by: userProfile?.email || "",
        approver_email: approver,
      }]);
      if (approver) {
        addNotification("📋", `${userProfile?.email || "Staff"} requested a setup waiver for ${t.wizardStepLabel} — ${(t.address || "").split(",")[0]}`, { recipient: approver, type: "wizard_skip_request" });
        queueNotification("approval_pending", approver, {
          kind: "wizard_skip", step: t.wizardStepLabel, property: t.address,
          requested_by: userProfile?.email || "",
        }, companyId);
      }
      addNotification("📤", `Setup waiver requested: ${t.wizardStepLabel} — ${(t.address || "").split(",")[0]}`);
      logAudit("request", "properties", "Setup waiver requested (" + t.wizardStepLabel + ") for " + t.address, "", userProfile?.email, userRole, companyId);
      showToast("Exception request submitted", "success");
      onRefresh();
    } catch (e) { showToast("Failed to submit: " + (e.message || e), "error"); }
  }

  function hasPendingException(t) {
    return openExceptions.some(r =>
      r.property === t.address &&
      (r.doc_type === t.wizardStepLabel || r.doc_type === t.wizardStep)
    );
  }

  return (
    <div className="space-y-3">
      {/* One card per property with pending setup steps */}
      {Array.from(byProp.values()).map(group => {
        const isOpen = !!expanded[group.address];
        const shortAddr = (group.address || "").split(",")[0];
        return (
          <div key={group.address} className="bg-white rounded-xl border border-brand-50 overflow-hidden">
            <button onClick={() => setExpanded(prev => ({ ...prev, [group.address]: !isOpen }))} className="w-full px-4 py-3 flex items-center gap-3 hover:bg-brand-50/30 transition-colors text-left">
              <span className="text-xl">🏠</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-neutral-800 truncate">{shortAddr}</div>
                <div className="text-xs text-neutral-400 truncate">{group.address}</div>
              </div>
              <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-warn-100 text-warn-700">{group.rows.length} pending</span>
              {group.highCount > 0 && <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-danger-100 text-danger-600">{group.highCount} high</span>}
              <span className="material-icons-outlined text-neutral-400 text-sm">{isOpen ? "expand_less" : "expand_more"}</span>
            </button>
            {isOpen && (
              <div className="border-t border-brand-50 bg-brand-50/10 px-3 py-2 space-y-1.5">
                {group.rows.map((t, i) => {
                  if (t._kind === "wizard_skip") {
                    const pending = hasPendingException(t);
                    return (
                      <div key={i} className="bg-white rounded-lg border border-brand-50 px-3 py-2 flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-neutral-700 truncate">{t.wizardStepLabel}</div>
                          {pending && <div className="text-[10px] text-warn-700 mt-0.5 font-semibold uppercase tracking-wide">Exception pending review</div>}
                        </div>
                        <span className={"text-[10px] px-2 py-0.5 rounded-full font-bold " + (t.priority === "high" ? "bg-danger-100 text-danger-600" : "bg-warn-100 text-warn-700")}>{t.priority}</span>
                        <Btn variant="primary" size="xs" onClick={() => setPage("properties", { openWizardFor: { propertyId: t.propertyId, address: t.address, startAtStep: t.wizardStep } })}>Open</Btn>
                        {canApprove ? (
                          <Btn variant="success-fill" size="xs" onClick={() => approveWizardSkip(t)}>Mark Done</Btn>
                        ) : (
                          !pending && <Btn variant="ghost" size="xs" onClick={() => requestException(t)}>Request</Btn>
                        )}
                      </div>
                    );
                  }
                  // Non-setup tasks (docs pending, balance, lease
                  // expiry, work order) — just the title + click-to-
                  // navigate. Preserves the deep-link action set up in
                  // fetchAll.
                  return (
                    <div key={i} onClick={() => setPage(t.link, t.linkAction)} className="bg-white rounded-lg border border-brand-50 px-3 py-2 flex items-center gap-2 cursor-pointer hover:border-brand-200">
                      <span className="text-base shrink-0">{t.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-neutral-700 truncate">{t.title}</div>
                      </div>
                      <span className={"text-[10px] px-2 py-0.5 rounded-full font-bold " + (t.priority === "high" ? "bg-danger-100 text-danger-600" : "bg-warn-100 text-warn-700")}>{t.priority}</span>
                      <span className="material-icons-outlined text-neutral-300 text-sm">arrow_forward</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Remaining non-wizard tasks — flat rows */}
      {otherTasks.length > 0 && (
        <div className="space-y-2">
          {otherTasks.map((t, i) => (
            <div key={i} onClick={() => setPage(t.link, t.linkAction)} className="bg-white rounded-xl border border-brand-50 p-4 flex items-center gap-3 cursor-pointer hover:border-brand-200 hover:shadow-sm transition-all">
              <span className="text-xl">{t.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-neutral-800 truncate">{t.title}</div>
                <div className="text-xs text-neutral-400">{t.subtitle}</div>
              </div>
              <span className={"text-xs px-2 py-0.5 rounded-full font-bold " + (t.priority === "high" ? "bg-danger-100 text-danger-600" : "bg-warn-100 text-warn-700")}>{t.priority}</span>
              <span className="material-icons-outlined text-neutral-300 text-sm">arrow_forward</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TasksAndApprovals({ companyId, setPage, showToast, showConfirm, userProfile, userRole, addNotification }) {
  const [loading, setLoading] = useState(true);
  const [approvals, setApprovals] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [activeTab, setActiveTab] = useState("all");
  // Every pending doc_exception_request against any setup step.
  // TasksList uses this to mark a wizard-skip task with "Exception
  // pending review" when the current user has already filed one —
  // prevents duplicate submissions and gives the user feedback.
  const [openExceptions, setOpenExceptions] = useState([]);

  useEffect(() => { fetchAll(); }, [companyId]);

  async function fetchAll() {
  setLoading(true);
  const allApprovals = [];
  const allTasks = [];
  try {
  const [propReqs, docExceptions, memberReqs, tenants, leases, hoaDue, wizards, props] = await Promise.all([
  supabase.from("property_change_requests").select("*").eq("company_id", companyId).eq("status", "pending").order("requested_at", { ascending: false }),
  supabase.from("doc_exception_requests").select("*").eq("company_id", companyId).eq("status", "pending").order("created_at", { ascending: false }),
  supabase.from("company_members").select("*").eq("company_id", companyId).eq("status", "pending").order("created_at", { ascending: false }),
  supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null),
  supabase.from("leases").select("*").eq("company_id", companyId).eq("status", "active"),
  // HOA rows no longer fetched — they're not surfaced as tasks.
  // Work orders intentionally excluded — Maintenance page is the home
  // for emergency WOs; duplicating them here was noise.
  Promise.resolve({ data: [] }),
  // Wizard-skip tasks: every in-progress wizard row + every completed
  // one (a completed wizard can still have approved skips we need to
  // differentiate from truly-filled steps on the Review page).
  supabase.from("property_setup_wizard").select("*").eq("company_id", companyId).in("status", ["in_progress", "completed"]),
  supabase.from("properties").select("id, address, status").eq("company_id", companyId).is("archived_at", null),
  ]);
  // Approvals — route by approver_email (snapshotted at insert time).
  // Managers see only rows routed to them; admins/owners see everything.
  // Team join requests (member type) are admin-only regardless.
  const email = userProfile?.email || "";
  (propReqs.data || []).forEach(r => {
    if (!canReviewRequest({ userRole, userEmail: email, approverEmail: r.approver_email })) return;
    allApprovals.push({ id: "prop-" + r.id, type: "property", icon: "🏠", title: (r.request_type === "add" ? "New Property" : "Edit Property") + ": " + r.address, subtitle: "Requested by " + r.requested_by + " · " + new Date(r.requested_at).toLocaleDateString(), data: r, link: "properties" });
  });
  (docExceptions.data || []).forEach(r => {
    if (!canReviewRequest({ userRole, userEmail: email, approverEmail: r.approver_email })) return;
    allApprovals.push({ id: "doc-" + r.id, type: "document", icon: "📄", title: "Document Exception: " + r.tenant_name, subtitle: (r.reason || "No reason provided") + " · " + new Date(r.created_at).toLocaleDateString(), data: r, link: "tenants" });
  });
  if (userRole === "admin" || userRole === "owner") {
    (memberReqs.data || []).forEach(r => allApprovals.push({ id: "member-" + r.id, type: "member", icon: "👤", title: "Join Request: " + r.user_email, subtitle: "Role: " + (r.role || "pending") + " · " + new Date(r.created_at).toLocaleDateString(), data: r, link: "roles" }));
  }
  // Tasks
  const t = tenants.data || [];
  t.filter(x => x.doc_status === "pending_docs").forEach(x => allTasks.push({ icon: "📄", title: x.name + " — documents pending", subtitle: x.property, address: x.property, link: "tenants", linkAction: { openTenantId: x.id, tenantName: x.name, panel: "documents" }, priority: "medium", _kind: "tenant_docs" }));
  t.filter(x => safeNum(x.balance) > 0).forEach(x => allTasks.push({ icon: "💰", title: x.name + " — balance due " + formatCurrency(x.balance), subtitle: x.property, address: x.property, link: "tenants", linkAction: { openTenantId: x.id, tenantName: x.name, panel: "ledger" }, priority: safeNum(x.balance) > 1000 ? "high" : "medium", _kind: "tenant_balance" }));
  t.filter(x => { const end = x.lease_end_date || x.move_out; if (!end) return false; const days = Math.ceil((parseLocalDate(end) - new Date()) / 86400000); return days > 0 && days <= 30; }).forEach(x => allTasks.push({ icon: "📅", title: x.name + " — lease expires " + (x.lease_end_date || x.move_out), subtitle: x.property, address: x.property, link: "tenants", linkAction: { openTenantId: x.id, tenantName: x.name, panel: "ledger" }, priority: "high", _kind: "lease_expiry" }));
  // Wizard-skip tasks: one row per applicable step not yet filled
  // and not yet admin-approved. Insurance / Loan / Property Tax are
  // graded "high" since they're compliance/financial; the rest are
  // "medium".
  const HIGH = new Set(["insurance", "loan", "property_tax"]);
  const propsByAddr = new Map((props.data || []).map(p => [p.address, p]));
  for (const w of (wizards.data || [])) {
    // Skip dismissed wizards only — they represent abandoned drafts
    // with no DB side effects (deferred-commit model). In_progress
    // AND completed wizards still surface tasks for any applicable
    // step the user hasn't filled or explicitly approved: "completed"
    // just means they clicked Complete Setup; the missing steps are
    // still genuine pending work (e.g. insurance, property tax,
    // loan). Without this, clicking Complete with 6 skipped steps
    // left them invisible in Tasks & Approvals — which is the exact
    // surprise Sahil hit on Shruti gupta's property.
    if (w.status === "dismissed") continue;
    const prop = propsByAddr.get(w.property_address);
    if (!prop) continue;
    const applicable = getWizardApplicableSteps({ propertyStatus: prop.status, userRole });
    const completed = new Set(w.completed_steps || []);
    const approved = new Set(w.skipped_approved_steps || []);
    // property_details is required to create the row, so if the row
    // exists it's always completed. Filtering it here keeps the
    // behavior honest if that invariant ever slips.
    for (const step of applicable) {
      if (step === "property_details") continue;
      if (completed.has(step) || approved.has(step)) continue;
      const shortAddr = (prop.address || "").split(",")[0];
      const label = WIZARD_STEP_LABELS[step] || step;
      allTasks.push({
        icon: "📋",
        title: "Setup: " + label + " — " + shortAddr,
        subtitle: prop.address,
        link: "properties",
        priority: HIGH.has(step) ? "high" : "medium",
        _kind: "wizard_skip",
        wizardId: w.id,
        wizardStep: step,
        wizardStepLabel: label,
        propertyId: prop.id,
        address: prop.address,
        // Snapshot so the approve handler can merge without re-fetch.
        approvedSnapshot: Array.from(approved),
      });
    }
  }
  // Cache open doc_exception requests keyed on address + doc_type so
  // the TasksList can badge "Exception pending review" on the right
  // step without refetching per row. Must live inside the try block
  // — `docExceptions` is const-scoped to the await destructuring.
  setOpenExceptions((docExceptions.data || []).filter(r => r.tenant_name?.startsWith("Setup:")));
  } catch (e) { pmError("PM-8006", { raw: e, context: "tasks fetch", silent: true }); }
  setApprovals(allApprovals);
  setTasks(allTasks);
  setLoading(false);
  }

  // Admin override for a wizard Skip. Merges the step onto the
  // wizard row's skipped_approved_steps array and records an audit
  // entry. Re-reads the row before writing so a concurrent admin
  // approving a different step doesn't get clobbered.
  async function approveWizardSkip(task) {
  if (userRole !== "admin" && userRole !== "owner" && userRole !== "manager") {
    showToast("Only admins, owners, and managers can approve wizard skips.", "error");
    return;
  }
  if (!await showConfirm({
    message: `Mark "${task.wizardStepLabel}" complete for ${task.address}?\n\nThe section will be treated as approved-without-data. You can still fill it in later via the setup wizard.`,
    variant: "primary",
    confirmText: "Mark Complete",
  })) return;
  try {
    const { data: current } = await supabase.from("property_setup_wizard")
      .select("skipped_approved_steps").eq("id", task.wizardId).eq("company_id", companyId).maybeSingle();
    const currentSkips = new Set((current?.skipped_approved_steps) || task.approvedSnapshot || []);
    currentSkips.add(task.wizardStep);
    const { error } = await supabase.from("property_setup_wizard")
      .update({ skipped_approved_steps: Array.from(currentSkips) })
      .eq("id", task.wizardId).eq("company_id", companyId);
    if (error) { pmError("PM-2007", { raw: error, context: "wizard skip approval" }); return; }
    logAudit("approve", "properties",
      "Admin-approved wizard skip: " + task.wizardStepLabel + " for " + task.address,
      task.wizardId, userProfile?.email, userRole, companyId);
    if (addNotification) addNotification("✅", task.wizardStepLabel + " marked complete for " + task.address.split(",")[0]);
    showToast(task.wizardStepLabel + " marked complete.", "success");
    fetchAll();
  } catch (e) {
    pmError("PM-2007", { raw: e, context: "approveWizardSkip" });
  }
  }

  async function handleApproval(item, action) {
  if (action === "approve") {
  if (item.type === "document") {
  const docType = item.data.doc_type;
  await supabase.from("doc_exception_requests").update({ status: "approved", reviewed_by: userProfile?.email, reviewed_at: new Date().toISOString() }).eq("id", item.data.id);
  if (docType) {
    // Per-doc waive: append to tenants.approved_doc_exceptions.
    const { data: tRow } = await supabase.from("tenants").select("id, approved_doc_exceptions, email").eq("company_id", companyId).ilike("name", escapeFilterValue(item.data.tenant_name)).is("archived_at", null).maybeSingle();
    if (tRow) {
      const existing = Array.isArray(tRow.approved_doc_exceptions) ? tRow.approved_doc_exceptions : [];
      const next = Array.from(new Set([...existing, docType]));
      await supabase.from("tenants").update({ approved_doc_exceptions: next }).eq("id", tRow.id);
    }
  } else {
    // Legacy blanket waive (request had no doc_type captured).
    await supabase.from("tenants").update({ doc_status: "exception_approved" }).eq("company_id", companyId).ilike("name", escapeFilterValue(item.data.tenant_name)).is("archived_at", null);
  }
  showToast("Document exception approved for " + item.data.tenant_name + (docType ? ": " + docType : ""), "success");
  logAudit("approve", "tenants", "Document exception approved for " + item.data.tenant_name + (docType ? " (" + docType + ")" : ""), item.data.id, userProfile?.email, userRole, companyId);
  // Route a notification back to the staff member who submitted it.
  // addNotification's `recipient` option scopes the inbox row so the
  // requester sees it on their next load (loadInboxNotifications
  // filters on recipient_email = current user).
  if (item.data.requested_by && addNotification) {
    addNotification("✅", `Your doc exception request for ${item.data.tenant_name}${docType ? ` (${docType})` : ""} was approved.`, { recipient: item.data.requested_by, type: "doc_exception" });
  }
  } else if (item.type === "member") {
  try {
  const { error } = await supabase.rpc("approve_member_request", { p_member_id: item.data.id });
  if (error) throw error;
  showToast("Approved join request for " + item.data.user_email, "success");
  } catch (e) {
  await supabase.from("company_members").update({ status: "active" }).eq("id", item.data.id).eq("company_id", companyId);
  showToast("Approved " + item.data.user_email, "success");
  }
  } else if (item.type === "property") {
  showToast("Navigate to Properties to review this request.", "info");
  setPage("properties");
  return;
  }
  } else {
  if (item.type === "document") {
  await supabase.from("doc_exception_requests").update({ status: "rejected", reviewed_by: userProfile?.email, reviewed_at: new Date().toISOString() }).eq("id", item.data.id);
  showToast("Document exception rejected.", "info");
  logAudit("reject", "tenants", "Document exception rejected for " + item.data.tenant_name + (item.data.doc_type ? " (" + item.data.doc_type + ")" : ""), item.data.id, userProfile?.email, userRole, companyId);
  if (item.data.requested_by && addNotification) {
    addNotification("❌", `Your doc exception request for ${item.data.tenant_name}${item.data.doc_type ? ` (${item.data.doc_type})` : ""} was rejected.`, { recipient: item.data.requested_by, type: "doc_exception" });
  }
  } else if (item.type === "member") {
  await supabase.from("company_members").update({ status: "rejected" }).eq("id", item.data.id).eq("company_id", companyId);
  showToast("Rejected join request for " + item.data.user_email, "info");
  } else if (item.type === "property") {
  await supabase.from("property_change_requests").update({ status: "rejected", reviewed_by: userProfile?.email, reviewed_at: new Date().toISOString() }).eq("id", item.data.id).eq("company_id", companyId);
  showToast("Property request rejected.", "info");
  }
  }
  fetchAll();
  }

  if (loading) return <Spinner />;

  const filtered = activeTab === "approvals" ? [] : activeTab === "tasks" ? [] : [...approvals.map(a => ({ ...a, _kind: "approval" })), ...tasks.map(t => ({ ...t, _kind: "task" }))];
  const showApprovals = activeTab === "all" || activeTab === "approvals";
  const showTasks = activeTab === "all" || activeTab === "tasks";

  return (
  <div>
  <div className="flex items-center justify-between mb-5">
  <PageHeader title="Tasks & Approvals" />
  <Btn variant="ghost" size="xs" onClick={fetchAll}>Refresh</Btn>
  </div>

  <div className="flex gap-2 mb-5">
  {[["all", "All (" + (approvals.length + tasks.length) + ")"], ["approvals", "Approvals (" + approvals.length + ")"], ["tasks", "Tasks (" + tasks.length + ")"]].map(([id, label]) => (
  <FilterPill key={id} active={activeTab === id} onClick={() => setActiveTab(id)}>{label}</FilterPill>
  ))}
  </div>

  {/* Approvals Section */}
  {showApprovals && approvals.length > 0 && (
  <div className="mb-6">
  {activeTab === "all" && <h3 className="text-sm font-bold text-neutral-500 uppercase tracking-wide mb-3">Awaiting Approval</h3>}
  <div className="space-y-3">
  {approvals.map(a => (
  <div key={a.id} className="bg-white rounded-xl border border-warn-200 p-4 flex items-center justify-between">
  <div className="flex items-center gap-3 flex-1 min-w-0">
  <span className="text-2xl">{a.icon}</span>
  <div className="min-w-0">
  <div className="font-semibold text-neutral-800 truncate">{a.title}</div>
  <div className="text-xs text-neutral-400">{a.subtitle}</div>
  </div>
  </div>
  <div className="flex gap-2 shrink-0 ml-3">
  <Btn variant="success-fill" size="xs" onClick={() => handleApproval(a, "approve")}>Approve</Btn>
  <Btn variant="danger" size="xs" onClick={() => handleApproval(a, "reject")}>Reject</Btn>
  </div>
  </div>
  ))}
  </div>
  </div>
  )}

  {/* Tasks Section */}
  {showTasks && tasks.length > 0 && (
  <div className="mb-6">
  {activeTab === "all" && <h3 className="text-sm font-bold text-neutral-500 uppercase tracking-wide mb-3">Pending Tasks</h3>}
  <TasksList
    tasks={tasks}
    userRole={userRole}
    userProfile={userProfile}
    companyId={companyId}
    setPage={setPage}
    approveWizardSkip={approveWizardSkip}
    showConfirm={showConfirm}
    showToast={showToast}
    addNotification={addNotification}
    onRefresh={fetchAll}
    openExceptions={openExceptions}
  />
  </div>
  )}

  {approvals.length === 0 && tasks.length === 0 && (
  <div className="text-center py-16">
  <span className="material-icons-outlined text-5xl text-neutral-200 mb-3">task_alt</span>
  <div className="text-lg font-semibold text-neutral-400">All caught up!</div>
  <div className="text-sm text-neutral-300">No pending tasks or approvals</div>
  </div>
  )}
  </div>
  );
}


// ============ ERROR LOG DASHBOARD ============
function ErrorLogDashboard({ companyId, showToast }) {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ module: "", severity: "", reported: false, unresolved: true, range: "7d" });
  const [stats, setStats] = useState({ critical: 0, error: 0, reported: 0, resolved: 0 });
  const [runningCheck, setRunningCheck] = useState(false);
  const [violations, setViolations] = useState([]);

  useEffect(() => { fetchErrors(); }, [filter]);

  async function fetchErrors() {
    setLoading(true);
    let q = supabase.from("error_log").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(200);
    if (filter.module) q = q.eq("module", filter.module);
    if (filter.severity) q = q.eq("severity", filter.severity);
    if (filter.reported) q = q.eq("reported_by_user", true);
    if (filter.unresolved) q = q.eq("resolved", false);
    const rangeMap = { "1d": 1, "7d": 7, "30d": 30 };
    if (rangeMap[filter.range]) {
      const since = new Date(); since.setDate(since.getDate() - rangeMap[filter.range]);
      q = q.gte("created_at", since.toISOString());
    }
    const { data } = await q;
    setErrors(data || []);
    // Fetch 24h stats
    const since24h = new Date(); since24h.setDate(since24h.getDate() - 1);
    const since7d = new Date(); since7d.setDate(since7d.getDate() - 7);
    const { data: recentAll } = await supabase.from("error_log").select("severity, reported_by_user, resolved").eq("company_id", companyId).gte("created_at", since7d.toISOString());
    const recent24h = (recentAll || []).filter(e => new Date(e.created_at) >= since24h);
    setStats({
      critical: (recentAll || []).filter(e => e.severity === "critical" && !e.resolved).length,
      error: (recentAll || []).filter(e => e.severity === "error" && !e.resolved).length,
      reported: (recentAll || []).filter(e => e.reported_by_user).length,
      resolved: (recentAll || []).filter(e => e.resolved).length,
    });
    setLoading(false);
  }

  async function markResolved(id) {
    await supabase.from("error_log").update({ resolved: true, resolved_at: new Date().toISOString() }).eq("id", id);
    fetchErrors();
  }

  async function handleHealthCheck() {
    setRunningCheck(true);
    const v = await runDataIntegrityChecks(companyId, { deep: true });
    setViolations(v);
    setRunningCheck(false);
    showToast(v.length === 0 ? "Health check passed — no issues found" : `Health check found ${v.length} issue(s)`, v.length === 0 ? "success" : "warning");
  }

  const severityColor = { critical: "bg-danger-50 text-danger-700 border-danger-200", error: "bg-danger-50 text-danger-600 border-danger-200", warning: "bg-warning-50 text-warning-700 border-warning-200", info: "bg-info-50 text-info-700 border-info-200" };
  const severityDot = { critical: "text-danger-500", error: "text-danger-400", warning: "text-warning-500", info: "text-info-400" };
  const modules = ["auth", "properties", "tenants", "accounting", "banking", "payments", "work_orders", "infrastructure", "data_integrity"];

  return (
  <div>
  <div className="flex items-center justify-between mb-4">
  <PageHeader title="Error Log" />
  <Btn size="sm" onClick={handleHealthCheck} disabled={runningCheck}>{runningCheck ? "Running..." : "Run Health Check"}</Btn>
  </div>

  {/* Summary Cards */}
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
  <div className="bg-danger-50 border border-danger-200 rounded-xl p-3 text-center">
  <p className="text-2xl font-bold text-danger-700">{stats.critical}</p>
  <p className="text-xs text-danger-400">Critical (7d)</p>
  </div>
  <div className="bg-warning-50 border border-warning-200 rounded-xl p-3 text-center">
  <p className="text-2xl font-bold text-warning-700">{stats.error}</p>
  <p className="text-xs text-warning-400">Errors (7d)</p>
  </div>
  <div className="bg-brand-50 border border-brand-200 rounded-xl p-3 text-center">
  <p className="text-2xl font-bold text-brand-700">{stats.reported}</p>
  <p className="text-xs text-brand-400">User-Reported</p>
  </div>
  <div className="bg-positive-50 border border-positive-200 rounded-xl p-3 text-center">
  <p className="text-2xl font-bold text-positive-700">{stats.resolved}</p>
  <p className="text-xs text-positive-400">Resolved (7d)</p>
  </div>
  </div>

  {/* Health Check Violations */}
  {violations.length > 0 && (
  <div className="mb-4 p-3 bg-warning-50 border border-warning-200 rounded-xl">
  <div className="font-semibold text-warning-700 text-sm mb-2">Health Check Results ({violations.length} issues)</div>
  {violations.map((v, i) => (
  <div key={i} className="flex items-start gap-2 text-sm py-1">
  <span className="font-mono text-xs bg-warning-100 text-warning-700 px-1.5 py-0.5 rounded font-bold shrink-0">{v.code}</span>
  <span className="text-neutral-600">{v.details}</span>
  </div>
  ))}
  </div>
  )}

  {/* Filters */}
  <div className="flex flex-wrap gap-2 mb-4 items-center">
  <Select value={filter.module} onChange={e => setFilter(f => ({ ...f, module: e.target.value }))} className="text-xs w-auto">
  <option value="">All Modules</option>
  {modules.map(m => <option key={m} value={m}>{m.replace("_", " ")}</option>)}
  </Select>
  <Select value={filter.severity} onChange={e => setFilter(f => ({ ...f, severity: e.target.value }))} className="text-xs w-auto">
  <option value="">All Severities</option>
  {["critical", "error", "warning", "info"].map(s => <option key={s} value={s}>{s}</option>)}
  </Select>
  <Select value={filter.range} onChange={e => setFilter(f => ({ ...f, range: e.target.value }))} className="text-xs w-auto">
  <option value="1d">Last 24h</option>
  <option value="7d">Last 7 days</option>
  <option value="30d">Last 30 days</option>
  <option value="">All time</option>
  </Select>
  <label className="flex items-center gap-1 text-xs text-neutral-500 cursor-pointer">
  <Checkbox checked={filter.reported} onChange={e => setFilter(f => ({ ...f, reported: e.target.checked }))} className="rounded" /> User-reported only
  </label>
  <label className="flex items-center gap-1 text-xs text-neutral-500 cursor-pointer">
  <Checkbox checked={filter.unresolved} onChange={e => setFilter(f => ({ ...f, unresolved: e.target.checked }))} className="rounded" /> Unresolved only
  </label>
  </div>

  {/* Error List */}
  {loading ? <p className="text-sm text-neutral-400">Loading...</p> : errors.length === 0 ? (
  <EmptyState icon="check-circle" message="No errors match your filters" />
  ) : (
  <div className="space-y-2">
  {errors.map(e => (
  <div key={e.id} className={"border rounded-xl p-3 " + (severityColor[e.severity] || "bg-subtle-50 border-subtle-200")}>
  <div className="flex items-start justify-between gap-2">
  <div className="flex-1 min-w-0">
  <div className="flex items-center gap-2 mb-1 flex-wrap">
  <span className={"text-xs font-mono px-1.5 py-0.5 rounded font-bold " + (e.severity === "critical" || e.severity === "error" ? "bg-danger-100 text-danger-700" : "bg-warning-100 text-warning-700")}>{e.error_code}</span>
  <span className="text-xs text-neutral-400 capitalize">{e.severity}</span>
  <span className="text-xs text-neutral-300">{new Date(e.created_at).toLocaleString()}</span>
  {e.user_email && <span className="text-xs text-neutral-400">{e.user_email}</span>}
  {e.reported_by_user && <span className="text-xs bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded">Reported</span>}
  </div>
  <p className="text-sm font-medium text-neutral-700">{e.message}</p>
  {e.context && <p className="text-xs text-neutral-400 mt-0.5">Context: {e.context}</p>}
  {e.raw_message && e.raw_message !== e.message && <p className="text-xs text-neutral-300 mt-0.5 font-mono truncate">Raw: {e.raw_message}</p>}
  </div>
  <div className="shrink-0">
  {!e.resolved && <Btn size="xs" variant="ghost" onClick={() => markResolved(e.id)}>Resolve</Btn>}
  {e.resolved && <span className="text-xs text-positive-600">Resolved</span>}
  </div>
  </div>
  </div>
  ))}
  </div>
  )}
  </div>
  );
}

// ============ ADMIN PAGE (Audit Trail + Team & Roles + Error Log) ============
// ============ COMPANY SETTINGS PANEL ============
function CompanySettingsPanel({ companyId, showToast, userProfile, companySettings, setCompanySettings }) {
  const [form, setForm] = useState({ ...companySettings });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  function update(key, value) {
    setForm(f => ({ ...f, [key]: value }));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await saveCompanySettings(companyId, form, userProfile?.email);
      setCompanySettings({ ...form });
      setDirty(false);
      showToast("Settings saved!", "success");
      logAudit("update", "settings", "Updated company settings", "", userProfile?.email, "admin", companyId);
    } catch (e) {
      showToast("Error: " + e.message, "error");
    }
    setSaving(false);
  }

  function resetDefaults() {
    setForm({ ...COMPANY_DEFAULTS });
    setDirty(true);
  }

  const Field = ({ label, field, type = "number", suffix, min, max, step }) => (
    <div>
      <label className="text-xs font-medium text-neutral-500 block mb-1">{label}</label>
      <div className="flex items-center gap-1">
        <Input type={type} value={form[field] ?? ""} onChange={e => update(field, type === "number" ? Number(e.target.value) : e.target.value)} min={min} max={max} step={step || "1"} className="w-full" />
        {suffix && <span className="text-xs text-neutral-400 shrink-0">{suffix}</span>}
      </div>
    </div>
  );

  return (
  <div className="space-y-6">
  <div className="flex items-center justify-between">
  <div>
  <h3 className="text-sm font-bold text-neutral-700">Company Settings</h3>
  <p className="text-xs text-neutral-400">Configure defaults for this company. Changes apply to new entries only.</p>
  </div>
  <div className="flex items-center gap-2">
  <TextLink tone="neutral" size="xs" onClick={resetDefaults}>Reset to Defaults</TextLink>
  <Btn onClick={handleSave} disabled={saving || !dirty}>{saving ? "Saving..." : "Save Settings"}</Btn>
  </div>
  </div>

  {/* Late Fees */}
  <div className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center gap-1"><span className="material-icons-outlined text-sm">gavel</span>Late Fee Defaults</div>
  <div className="grid grid-cols-3 gap-4">
  <Field label="Grace Period" field="late_fee_grace_days" suffix="days" min={0} max={30} />
  <Field label="Fee Amount" field="late_fee_amount" suffix={form.late_fee_type === "percent" ? "%" : "$"} min={0} step="0.01" />
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Fee Type</label>
  <Select value={form.late_fee_type} onChange={e => update("late_fee_type", e.target.value)}>
  <option value="flat">Flat ($)</option><option value="percent">Percent (%)</option>
  </Select>
  </div>
  </div>
  </div>

  {/* Lease Defaults */}
  <div className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center gap-1"><span className="material-icons-outlined text-sm">description</span>Lease Defaults</div>
  <div className="grid grid-cols-3 gap-4">
  <Field label="Default Lease Term" field="default_lease_months" suffix="months" min={1} max={60} />
  <Field label="Security Deposit" field="default_deposit_months" suffix="month(s) rent" min={0} max={3} />
  <Field label="Rent Escalation" field="rent_escalation_pct" suffix="% / year" min={0} max={25} step="0.5" />
  <Field label="Payment Due Day" field="payment_due_day" suffix="of month" min={1} max={31} />
  <Field label="Renewal Notice" field="renewal_notice_days" suffix="days" min={0} max={180} />
  </div>
  </div>

  {/* Notifications */}
  <div className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center gap-1"><span className="material-icons-outlined text-sm">notifications</span>Notification Thresholds</div>
  <div className="grid grid-cols-3 gap-4">
  <Field label="Rent Due Reminder" field="rent_due_reminder_days" suffix="days before" min={1} max={14} />
  <Field label="Lease Expiry Warning" field="lease_expiry_warning_days" suffix="days before" min={7} max={180} />
  <Field label="Insurance Expiry Warning" field="insurance_expiry_warning_days" suffix="days before" min={7} max={180} />
  </div>
  </div>

  {/* Legal */}
  <div className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center gap-1"><span className="material-icons-outlined text-sm">balance</span>Legal & Lease Terms</div>
  <div className="grid grid-cols-3 gap-4">
  <Field label="Deposit Return Deadline" field="deposit_return_days" suffix="days after move-out" min={1} max={90} />
  <Field label="Termination Notice Required" field="termination_notice_days" suffix="days written" min={1} max={90} />
  <Field label="Archive Retention" field="archive_retention_days" suffix="days" min={30} max={365} />
  </div>
  </div>

  {/* Other */}
  <div className="bg-white rounded-xl border border-neutral-200 p-4">
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-3 flex items-center gap-1"><span className="material-icons-outlined text-sm">tune</span>Other Settings</div>
  <div className="grid grid-cols-3 gap-4">
  <Field label="HOA Upcoming Window" field="hoa_upcoming_window_days" suffix="days" min={1} max={60} />
  <Field label="Voucher Reexam Window" field="voucher_reexam_window_days" suffix="days" min={7} max={365} />
  </div>
  </div>
  </div>
  );
}

function AdminPage({ companyId, activeCompany, addNotification, userProfile, userRole, showToast, showConfirm, currentUser, companySettings, setCompanySettings }) {
  const [adminTab, setAdminTab] = useState("audit");
  const isAdmin = userRole === "admin";
  return (
  <div>
  <PageHeader title="Admin" />
  <p className="text-sm text-neutral-400 mb-4">Manage team access and view activity logs</p>
  {isAdmin && activeCompany?.company_code && (
  <div className="bg-brand-50/50 border border-brand-100 rounded-xl px-4 py-3 mb-4 flex items-center justify-between">
  <div>
  <div className="text-xs font-medium text-neutral-500">Company Join Code</div>
  <div className="text-lg font-bold font-mono text-brand-700 tracking-wider">{activeCompany.company_code}</div>
  </div>
  <TextLink tone="brand" size="xs" underline={false} onClick={() => { navigator.clipboard.writeText(activeCompany.company_code); showToast("Code copied!", "success"); }} className="font-medium flex items-center gap-1">
  <span className="material-icons-outlined text-sm">content_copy</span>Copy
  </TextLink>
  </div>
  )}
  <div className="flex gap-1 mb-4 border-b border-brand-50">
  {[["audit", "Audit Trail"], ...(isAdmin ? [["team", "Team & Roles"], ["settings", "Settings"], ["errors", "Error Log"]] : [])].map(([id, label]) => (
  <button key={id} onClick={() => setAdminTab(id)} className={"px-4 py-2 text-sm font-medium border-b-2 " + (adminTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-500")}>{label}</button>
  ))}
  </div>
  {adminTab === "audit" && <AuditTrail companyId={companyId} />}
  {adminTab === "team" && isAdmin && <RoleManagement companyId={companyId} activeCompany={activeCompany} addNotification={addNotification} userProfile={userProfile} userRole={userRole} showToast={showToast} showConfirm={showConfirm} currentUser={currentUser} />}
  {adminTab === "settings" && isAdmin && <CompanySettingsPanel companyId={companyId} showToast={showToast} userProfile={userProfile} companySettings={companySettings} setCompanySettings={setCompanySettings} />}
  {adminTab === "errors" && isAdmin && <ErrorLogDashboard companyId={companyId} showToast={showToast} />}
  </div>
  );
}

// ============ AUDIT TRAIL ============
function AuditTrail({ companyId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterModule, setFilterModule] = useState("all");
  const [filterAction, setFilterAction] = useState("all");
  const [filterUser, setFilterUser] = useState("");
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => { fetchLogs(); }, [companyId, page, filterModule, filterAction, filterUser]);

  async function fetchLogs() {
  setLoading(true);
  let query = supabase.from("audit_trail").select("*", { count: "exact" }).eq("company_id", companyId);
  if (filterModule !== "all") query = query.eq("module", filterModule);
  if (filterAction !== "all") query = query.eq("action", filterAction);
  if (filterUser) query = query.ilike("user_email", `%${escapeFilterValue(filterUser)}%`);
  const { data, count } = await query.order("created_at", { ascending: false }).range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
  setLogs(data || []);
  setTotalCount(count || 0);
  setLoading(false);
  }

  // Fetch distinct filter values once
  const [filterOptions, setFilterOptions] = useState({ modules: [], actions: [], users: [] });
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("audit_trail").select("module, action, user_email").eq("company_id", companyId).limit(1000);
      if (data) {
        setFilterOptions({
          modules: [...new Set(data.map(l => l.module))].sort(),
          actions: [...new Set(data.map(l => l.action))].sort(),
          users: [...new Set(data.map(l => l.user_email))].sort(),
        });
      }
    })();
  }, [companyId]);

  const modules = filterOptions.modules;
  const actions = filterOptions.actions;
  const users = filterOptions.users;

  const paged = logs;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const actionColors = {
  create: "bg-success-100 text-success-700",
  update: "bg-info-100 text-info-700",
  delete: "bg-danger-100 text-danger-700",
  request: "bg-warn-100 text-warn-700",
  approve: "bg-success-100 text-success-700",
  reject: "bg-danger-100 text-danger-700",
  };

  const moduleIcons = {
  properties: "🏠", tenants: "👤", payments: "💳", maintenance: "🔧",
  utilities: "⚡", accounting: "📊", documents: "📄", inspections: "🔍",
  autopay: "🔁",
  };

  if (loading) return <Spinner />;

  return (
  <div>
  <PageHeader title="Audit Trail" />
  <p className="text-sm text-neutral-400 mb-4">Complete activity log across all modules</p>

  {/* Filters */}
  <div className="flex flex-wrap gap-2 mb-4">
  <Select filter value={filterModule} onChange={e => { setFilterModule(e.target.value); setPage(0); }} >
  <option value="all">All Modules</option>
  {modules.map(m => <option key={m} value={m}>{moduleIcons[m] || "📌"} {m}</option>)}
  </Select>
  <Select filter value={filterAction} onChange={e => { setFilterAction(e.target.value); setPage(0); }} >
  <option value="all">All Actions</option>
  {actions.map(a => <option key={a} value={a}>{a}</option>)}
  </Select>
  <Input placeholder="Filter by user email..." value={filterUser} onChange={e => { setFilterUser(e.target.value); setPage(0); }} className="flex-1 min-w-48" />
  <Btn variant="slate" size="sm" onClick={fetchLogs}>Refresh</Btn>
  </div>

  {/* Stats */}
  <div className="grid grid-cols-4 gap-3 mb-4">
  <div className="bg-white rounded-3xl border border-brand-50 p-3 text-center">
  <p className="text-lg font-manrope font-bold text-neutral-800">{totalCount}</p>
  <p className="text-xs text-neutral-400">Total Actions</p>
  </div>
  <div className="bg-white rounded-3xl border border-brand-50 p-3 text-center">
  <p className="text-lg font-manrope font-bold text-neutral-800">{users.length}</p>
  <p className="text-xs text-neutral-400">Users Active</p>
  </div>
  <div className="bg-white rounded-3xl border border-brand-50 p-3 text-center">
  <p className="text-lg font-bold text-success-600">{logs.filter(l => l.action === "create").length}</p>
  <p className="text-xs text-neutral-400">Created</p>
  </div>
  <div className="bg-white rounded-3xl border border-brand-50 p-3 text-center">
  <p className="text-lg font-bold text-danger-500">{logs.filter(l => l.action === "delete").length}</p>
  <p className="text-xs text-neutral-400">Deleted</p>
  </div>
  </div>

  {/* Log Table */}
  <div className="bg-white rounded-3xl shadow-card border border-brand-50 overflow-hidden">
  <table className="w-full text-sm">
  <thead className="bg-brand-50/30 text-xs text-neutral-400 uppercase">
  <tr>
  <th className="px-4 py-3 text-left">Time</th>
  <th className="px-4 py-3 text-left">User</th>
  <th className="px-4 py-3 text-left">Role</th>
  <th className="px-4 py-3 text-left">Module</th>
  <th className="px-4 py-3 text-left">Action</th>
  <th className="px-4 py-3 text-left">Details</th>
  </tr>
  </thead>
  <tbody>
  {paged.map(log => (
  <tr key={log.id} className="border-t border-brand-50/50 hover:bg-brand-50/30/50">
  <td className="px-4 py-2.5 text-xs text-neutral-400 whitespace-nowrap">{new Date(log.created_at).toLocaleString()}</td>
  <td className="px-4 py-2.5 text-neutral-700 font-medium text-xs">{log.user_email}</td>
  <td className="px-4 py-2.5"><span className={`text-xs px-1.5 py-0.5 rounded-full ${log.user_role === "admin" ? "bg-brand-100 text-brand-700" : "bg-neutral-100 text-neutral-500"}`}>{log.user_role}</span></td>
  <td className="px-4 py-2.5 text-xs"><span className="flex items-center gap-1">{moduleIcons[log.module] || "📌"} {log.module}</span></td>
  <td className="px-4 py-2.5"><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${actionColors[log.action] || "bg-neutral-100 text-neutral-700"}`}>{log.action}</span></td>
  <td className="px-4 py-2.5 text-xs text-neutral-500 max-w-xs truncate">{log.details}</td>
  </tr>
  ))}
  {paged.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-neutral-400">No audit logs found</td></tr>}
  </tbody>
  </table>
  </div>

  {/* Pagination */}
  {totalPages > 1 && (
  <div className="flex items-center justify-between mt-3">
  <span className="text-xs text-neutral-400">Page {page + 1} of {totalPages} ({totalCount} records)</span>
  <div className="flex gap-1">
  <Btn variant="slate" size="xs" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>← Prev</Btn>
  <Btn variant="slate" size="xs" onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>Next →</Btn>
  </div>
  </div>
  )}
  </div>
  );
}

// ============ USER PROFILE PAGE ============
function UserProfile({ currentUser, onBack, showToast, showConfirm }) {
  const [displayName, setDisplayName] = useState(currentUser?.user_metadata?.name || currentUser?.email?.split("@")[0] || "");
  const [phone, setPhone] = useState(currentUser?.user_metadata?.phone || "");
  const [avatarUrl, setAvatarUrl] = useState(currentUser?.user_metadata?.avatar_url || "");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [darkMode, setDarkMode] = useState(localStorage.getItem("theme") === "dark");

  async function saveProfile() {
  setSaving(true);
  const { error } = await supabase.auth.updateUser({ data: { name: displayName.trim(), phone: phone.trim(), avatar_url: avatarUrl } });
  if (error) pmError("PM-1009", { raw: error, context: "update user profile" });
  else showToast("Profile updated!", "success");
  setSaving(false);
  }

  async function sendPasswordReset() {
  const { error } = await supabase.auth.resetPasswordForEmail(currentUser?.email, { redirectTo: window.location.origin });
  if (error) pmError("PM-1004", { raw: error, context: "send password reset email" });
  else { setResetSent(true); showToast("Password reset link sent to " + currentUser?.email, "success"); }
  }

  async function uploadAvatar(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const ALLOWED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!ALLOWED_AVATAR_TYPES.includes(file.type)) { showToast("Only image files allowed (JPG, PNG, GIF, WebP).", "error"); return; }
  if (file.size > 2 * 1024 * 1024) { showToast("Image must be under 2MB.", "error"); return; }
  setUploading(true);
  const ext = file.type.split("/")[1] || "jpg";
  const path = `avatars/${currentUser.id}.${ext}`;
  const { error } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
  if (error) { pmError("PM-7002", { raw: error, context: "upload avatar" }); setUploading(false); return; }
  const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(path);
  const publicUrl = urlData?.publicUrl + "?t=" + Date.now();
  setAvatarUrl(publicUrl);
  await supabase.auth.updateUser({ data: { avatar_url: publicUrl } });
  showToast("Avatar updated!", "success");
  setUploading(false);
  }

  async function deleteAccount() {
  if (deleteText !== "DELETE") return;
  setDeleting(true);
  // Phase 1: soft-delete memberships + flip app_users.status. These
  // are the user-visible effects and can be undone by an admin via DB.
  const { data: memberships } = await supabase.from("company_members").select("company_id").ilike("user_email", emailFilterValue(currentUser?.email));
  if (memberships) {
  for (const m of memberships) {
  await supabase.from("company_members").update({ status: "removed" }).eq("company_id", m.company_id).ilike("user_email", emailFilterValue(currentUser?.email));
  }
  }
  await supabase.from("app_users").update({ status: "deleted", deleted_at: new Date().toISOString() }).ilike("email", emailFilterValue(currentUser?.email));

  // Phase 2: delete the Supabase auth row via server route. Until now
  // the auth row stayed alive — the user could still sign in, and any
  // UI path that didn't re-check app_users.status granted access.
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const tok = session?.access_token;
    if (tok) {
      const resp = await fetch("/api/self-delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tok },
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        showToast("Account data cleared, but auth delete failed: " + (j.error || resp.status) + ". Contact support to finish.", "warning");
      }
    }
  } catch (_) { /* best effort; soft-delete already done */ }

  showToast("Account deleted. You will be signed out.", "info");
  setTimeout(async () => { await supabase.auth.signOut(); }, 1500);
  }

  function toggleDarkMode() {
  const next = !darkMode;
  setDarkMode(next);
  localStorage.setItem("theme", next ? "dark" : "light");
  document.documentElement.classList.toggle("dark", next);
  }

  return (
  <div className="min-h-screen bg-gradient-to-br from-brand-50 to-white flex items-center justify-center p-4">
  <div className="w-full max-w-lg">
  <Btn variant="ghost" size="sm" onClick={onBack} className="mb-6">
  <span className="material-icons-outlined text-sm">arrow_back</span> Back to Companies
  </Btn>

  <div className="bg-white rounded-2xl border border-brand-100 shadow-sm p-6 mb-4">
  <PageHeader title="Profile" />

  {/* Avatar */}
  <div className="flex items-center gap-4 mb-6">
  <div className="relative">
  {avatarUrl ? (
  <img src={avatarUrl} alt="Avatar" className="w-16 h-16 rounded-full object-cover border-2 border-brand-100" />
  ) : (
  <div className="w-16 h-16 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-2xl">
  {displayName?.[0]?.toUpperCase() || "U"}
  </div>
  )}
  <label className="absolute -bottom-1 -right-1 w-7 h-7 bg-brand-600 text-white rounded-full flex items-center justify-center cursor-pointer hover:bg-brand-700 transition-colors">
  <span className="material-icons-outlined text-sm">photo_camera</span>
  <FileInput accept="image/*" onChange={uploadAvatar} className="hidden" />
  </label>
  </div>
  <div>
  <div className="font-semibold text-neutral-800">{displayName || "User"}</div>
  <div className="text-xs text-neutral-400">{currentUser?.email}</div>
  {uploading && <div className="text-xs text-brand-500 mt-1">Uploading...</div>}
  </div>
  </div>

  {/* Name & Phone */}
  <div className="space-y-3 mb-5">
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Display Name</label>
  <Input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name" />
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Phone Number</label>
  <Input value={phone} onChange={e => setPhone(formatPhoneInput(e.target.value))} placeholder="(555) 123-4567" maxLength={14} />
  </div>
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Email</label>
  <Input value={currentUser?.email || ""} disabled className="bg-neutral-50 text-neutral-400" />
  </div>
  </div>

  <Btn size="lg" className="w-full mb-3" onClick={saveProfile} disabled={saving}>
  {saving ? "Saving..." : "Save Changes"}
  </Btn>
  </div>

  {/* Password Reset */}
  <div className="bg-white rounded-2xl border border-brand-100 shadow-sm p-6 mb-4">
  <h3 className="font-semibold text-neutral-800 mb-2">Password</h3>
  <p className="text-xs text-neutral-400 mb-3">We'll send a password reset link to your email.</p>
  <Btn variant="slate" size="sm" onClick={sendPasswordReset} disabled={resetSent}>
  {resetSent ? "Reset Link Sent" : "Send Password Reset Email"}
  </Btn>
  </div>

  {/* Preferences */}
  <div className="bg-white rounded-2xl border border-brand-100 shadow-sm p-6 mb-4">
  <h3 className="font-semibold text-neutral-800 mb-3">Preferences</h3>
  <div className="flex items-center justify-between py-2">
  <div>
  <div className="text-sm text-neutral-700">Dark Mode</div>
  <div className="text-xs text-neutral-400">Switch between light and dark theme</div>
  </div>
  <button onClick={toggleDarkMode} className={"relative w-10 h-5 rounded-full transition-colors " + (darkMode ? "bg-brand-600" : "bg-neutral-300")}>
  <span className={"absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow " + (darkMode ? "left-5" : "left-0.5")} />
  </button>
  </div>
  </div>

  {/* 2FA */}
  <div className="bg-white rounded-2xl border border-brand-100 shadow-sm p-6 mb-4">
  <h3 className="font-semibold text-neutral-800 mb-2">Two-Factor Authentication</h3>
  <p className="text-xs text-neutral-400 mb-3">Add an extra layer of security to your account.</p>
  <div className="bg-neutral-50 border border-neutral-200 rounded-xl px-4 py-3 text-sm text-neutral-400 text-center">Coming Soon</div>
  </div>

  {/* Delete Account */}
  <div className="bg-white rounded-2xl border border-danger-100 shadow-sm p-6">
  <h3 className="font-semibold text-danger-600 mb-2">Delete Account</h3>
  <p className="text-xs text-neutral-400 mb-3">This will deactivate your account and remove you from all companies. This action cannot be undone.</p>
  {!showDeleteConfirm ? (
  <Btn variant="danger" size="sm" onClick={() => setShowDeleteConfirm(true)}>Delete My Account</Btn>
  ) : (
  <div className="space-y-3">
  <p className="text-sm text-danger-600 font-medium">Type "DELETE" to confirm:</p>
  <Input value={deleteText} onChange={e => setDeleteText(e.target.value.toUpperCase())} placeholder="Type DELETE" className="border-danger-200" />
  <div className="flex gap-2">
  <Btn variant="danger-fill" onClick={deleteAccount} disabled={deleteText !== "DELETE" || deleting}>{deleting ? "Deleting..." : "Permanently Delete"}</Btn>
  <Btn variant="slate" size="sm" onClick={() => { setShowDeleteConfirm(false); setDeleteText(""); }}>Cancel</Btn>
  </div>
  </div>
  )}
  </div>
  </div>
  </div>
  );
}

export { ArchivedItems, RoleManagement, ArchivePage, TasksAndApprovals, ErrorLogDashboard, AdminPage, AuditTrail, UserProfile, ROLES, ALL_NAV, ALL_NAV_FLAT, NAV_CHILD_IDS };
