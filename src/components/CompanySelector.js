import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Select, Btn, TextLink} from "../ui";
import { normalizeEmail, formatPhoneInput, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { logAudit } from "../utils/audit";
import { Spinner } from "./shared";

// ============ COMPANY SELECTOR ============
function CompanySelector({ currentUser, onSelectCompany, onLogout, showToast, showConfirm }) {
  const [companies, setCompanies] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [invites, setInvites] = useState([]);
  const [acceptingInvite, setAcceptingInvite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", type: "LLC", company_role: "management", address: "", phone: "", email: "" });
  const [joinCode, setJoinCode] = useState("");
  const [joinSearch, setJoinSearch] = useState(""); // Deprecated — code-only joining
  const [companySearch, setCompanySearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [joinMessage, setJoinMessage] = useState("");

  useEffect(() => { fetchCompanies(); }, []);

  async function fetchCompanies() {
  setLoading(true);
  const email = currentUser?.email;
  if (!email) { setLoading(false); return; }
  // Get all companies this user is an active member of
  const { data: memberships } = await supabase.from("company_members").select("company_id, role, status").ilike("user_email", email);
  const active = (memberships || []).filter(m => m.status === "active");
  const pending = (memberships || []).filter(m => m.status === "pending");
  const invited = (memberships || []).filter(m => m.status === "invited");
  setPendingRequests(pending);
  // Fetch company details for both active and invited memberships
  const allCompanyIds = [...new Set([...active, ...invited].map(m => m.company_id))];
  if (allCompanyIds.length > 0) {
  const { data: companyData } = await supabase.from("companies").select("*").in("id", allCompanyIds).is("archived_at", null);
  const companyMap = Object.fromEntries((companyData || []).map(c => [c.id, c]));
  // Active companies
  const withRoles = active.map(m => companyMap[m.company_id]).filter(Boolean).map(c => {
  const membership = active.find(m => m.company_id === c.id);
  return { ...c, memberRole: membership?.role || "tenant" };
  });
  setCompanies(withRoles);
  // Invited companies
  const inviteList = invited.map(m => companyMap[m.company_id]).filter(Boolean).map(c => {
  const membership = invited.find(m => m.company_id === c.id);
  return { ...c, memberRole: membership?.role || "tenant" };
  });
  setInvites(inviteList);
  } else {
  setCompanies([]);
  setInvites([]);
  }
  setLoading(false);
  }

  async function acceptInvite(company) {
  setAcceptingInvite(company.id);
  try {
  const email = normalizeEmail(currentUser?.email);
  // Refuse invites older than 30 days — otherwise an unused invite can
  // sit forever and let an ex-employee (or someone who re-registered the
  // email) reclaim access years later. The nightly expire-invites cron
  // also flips them to status="expired", but we guard at accept time in
  // case the cron hasn't run yet.
  const { data: invRow } = await supabase.from("company_members")
    .select("id, created_at")
    .eq("company_id", company.id)
    .ilike("user_email", email)
    .eq("status", "invited")
    .maybeSingle();
  if (!invRow) { showToast("Invite not found or already accepted.", "error"); return; }
  if (invRow.created_at) {
    const ageMs = Date.now() - new Date(invRow.created_at).getTime();
    if (ageMs > 30 * 86400000) {
      await supabase.from("company_members").update({ status: "expired" }).eq("id", invRow.id);
      showToast("This invite has expired. Please ask the admin to resend it.", "error");
      return;
    }
  }
  const { error } = await supabase.from("company_members").update({ status: "active" })
    .eq("id", invRow.id).eq("status", "invited");
  if (error) { showToast("Error accepting invite: " + error.message, "error"); return; }
  // Also ensure app_users row exists
  await supabase.from("app_users").upsert([{
    email, name: currentUser?.user_metadata?.name || email.split("@")[0],
  }], { onConflict: "email" });
  showToast(`Joined ${company.name}!`, "success");
  onSelectCompany(company, company.memberRole);
  } catch (e) {
  showToast("Error accepting invite: " + e.message, "error");
  } finally { setAcceptingInvite(null); }
  }

  async function createCompany() {
  if (creating) return;
  if (!createForm.name.trim()) { showToast("Company name is required.", "error"); return; }
  setCreating(true);
  // Block duplicate company names entirely
  const userCompanyNames = companies.map(c => c.name?.toLowerCase().trim());
  if (userCompanyNames.includes(createForm.name.trim().toLowerCase())) {
  showToast('You already have a company named "' + createForm.name.trim() + '".', "error");
  setCreating(false);
  return;
  }
  const companyId = crypto.randomUUID();
  // Generate unique 8-digit numeric company code
  // Generate unique company code with collision retry
  let companyCode;
  for (let attempt = 0; attempt < 5; attempt++) {
  const ccArr = new Uint32Array(1); crypto.getRandomValues(ccArr);
  companyCode = String(10000000 + (ccArr[0] % 89999999));
  const { data: existing } = await supabase.from("companies").select("id").eq("company_code", companyCode).maybeSingle();
  if (!existing) break;
  if (attempt === 4) { showToast("Could not generate unique company code. Please try again.", "error"); setCreating(false); return; }
  }
  // Atomic company creation: try RPC first, fall back to client-side inserts
  let companyCreated = false;
  try {
  const { error: rpcErr } = await supabase.rpc("create_company_atomic", {
  p_company_id: companyId,
  p_name: createForm.name,
  p_type: createForm.type,
  p_company_code: companyCode,
  p_company_role: createForm.company_role || "management",
  p_address: createForm.address || "",
  p_phone: createForm.phone || "",
  p_email: normalizeEmail(createForm.email),
  p_creator_email: normalizeEmail(currentUser?.email),
  p_creator_name: currentUser?.email?.split("@")[0] || "",
  });
  if (rpcErr) throw new Error(rpcErr.message);
  companyCreated = true;
  } catch (rpcE) {
  pmError("PM-8003", { raw: rpcE, context: "create_company_atomic RPC, using client-side fallback", silent: true });
  // Client-side fallback: insert company + membership + default accounts
  try {
  const { error: compErr } = await supabase.from("companies").insert([{
  id: companyId, name: createForm.name, type: createForm.type,
  company_code: companyCode, company_role: createForm.company_role || "management",
  address: createForm.address || "", phone: createForm.phone || "",
  email: normalizeEmail(createForm.email),
  }]);
  if (compErr) throw new Error("Company insert: " + compErr.message);
  // Add creator as admin member
  const { data: { user: authUser } } = await supabase.auth.getUser();
  const { error: memErr } = await supabase.from("company_members").insert([{
  company_id: companyId, user_email: normalizeEmail(currentUser?.email),
  role: "admin", status: "active",
  }]);
  if (memErr) {
  // If membership insert fails, company exists but user can't access it — delete the orphan
  await supabase.from("companies").delete().eq("id", companyId);
  throw new Error("Membership setup failed: " + memErr.message + ". This may be an RLS issue \u2014 the create_company_atomic RPC needs to be deployed.");
  }
  // Create default chart of accounts
  const defaultAccounts = [
  { code: "1000", name: "Checking Account", type: "Asset", is_active: true },
  { code: "1100", name: "Accounts Receivable", type: "Asset", is_active: true },
  { code: "2100", name: "Security Deposits Held", type: "Liability", is_active: true },
  { code: "2200", name: "Owner Distributions Payable", type: "Liability", is_active: true },
  { code: "4000", name: "Rental Income", type: "Revenue", is_active: true },
  { code: "4010", name: "Late Fee Income", type: "Revenue", is_active: true },
  { code: "4100", name: "Other Income", type: "Revenue", is_active: true },
  { code: "4200", name: "Management Fee Income", type: "Revenue", is_active: true },
  { code: "5300", name: "Repairs & Maintenance", type: "Expense", is_active: true },
  { code: "5400", name: "Utilities Expense", type: "Expense", is_active: true },
  { code: "5710", name: "Property Taxes", type: "Expense", is_active: true },
  ];
  for (const acct of defaultAccounts) {
  await supabase.from("acct_accounts").insert([{ ...acct, company_id: companyId, old_text_id: companyId + "-" + acct.code }]);
  }
  companyCreated = true;
  } catch (fallbackErr) {
  pmError("PM-8006", { raw: fallbackErr, context: "create company (client-side fallback)" });
  setCreating(false);
  return;
  }
  }
  if (!companyCreated) { setCreating(false); return; }
  showToast("Company created! Company Code: " + companyCode + " \u2014 share this code to invite team members.", "success");
  setShowCreate(false);
  setCreateForm({ name: "", type: "LLC", company_role: "management", address: "", phone: "", email: "" });
  setCreating(false);
  fetchCompanies();
  }

  async function searchCompanies() {
  if (!joinCode.trim()) { showToast("Please enter the 8-digit company code shared by your administrator.", "error"); return; }
  if (joinCode.trim().length < 8) { showToast("Please enter the full 8-digit company code.", "error"); return; }
  // Only exact code match — no name search (prevents company enumeration)
  const { data } = await supabase.from("companies").select("id, name, type").eq("company_code", joinCode.trim()).limit(1);
  setSearchResults(data || []);
  }

  async function requestJoin(company) {
  // Check if already a member
  const { data: existing } = await supabase.from("company_members").select("status").eq("company_id", company.id).ilike("user_email", currentUser?.email || "").maybeSingle();
  if (existing) {
  if (existing.status === "active") { showToast("You're already a member of " + company.name, "error"); return; }
  if (existing.status === "pending") { showToast("Your request to join " + company.name + " is pending admin approval.", "error"); return; }
  if (existing.status === "rejected") { showToast("Your previous request to join " + company.name + " was rejected. Please contact the company admin directly.", "error"); return; }
  if (existing.status === "removed") { showToast("You were previously removed from " + company.name + ". Please contact the company admin to be re-added.", "error"); return; }
  }
  // Server-side join request — verifies auth identity
  try {
  const { error: rpcErr } = await supabase.rpc("request_join_company", {
  p_company_id: company.id,
  });
  if (rpcErr) throw new Error(rpcErr.message);
  } catch (e) {
  // RPC mandatory — no client fallback for membership changes
  pmError("PM-8003", { raw: e, context: "submit company join request" });
  return;
  }
  setJoinMessage("Request sent to join " + company.name + "! An admin will review your request.");
  setSearchResults([]);
  setJoinCode("");
  setJoinSearch("");
  fetchCompanies();
  }

  const [deleting, setDeleting] = useState(null); // company id being deleted
  const [openMenu, setOpenMenu] = useState(null); // company id whose kebab menu is open
  // Typed-name confirmation modal. Holds the company + derived flags so
  // the modal can show Teller warning + record count before the admin
  // types the name. Previous flow was a single yes/no dialog, which made
  // a misclick on a subtle red "Delete" link catastrophic.
  const [deleteModal, setDeleteModal] = useState(null);
  const [deleteTyped, setDeleteTyped] = useState("");

  // Close kebab menu on outside click.
  useEffect(() => {
  if (!openMenu) return;
  const close = () => setOpenMenu(null);
  window.addEventListener("click", close);
  return () => window.removeEventListener("click", close);
  }, [openMenu]);

  async function openDeleteFlow(company) {
  if (deleting) return;
  setOpenMenu(null);
  // Gather pre-flight info — record count + Teller connection — so the
  // modal can show an honest impact summary instead of "no data found"
  // when in fact the company has bank tokens on file.
  const [props, tenants, payments, bankConn] = await Promise.all([
  supabase.from("properties").select("id", { count: "exact", head: true }).eq("company_id", company.id),
  supabase.from("tenants").select("id", { count: "exact", head: true }).eq("company_id", company.id),
  supabase.from("payments").select("id", { count: "exact", head: true }).eq("company_id", company.id),
  supabase.from("bank_connection").select("id", { count: "exact", head: true }).eq("company_id", company.id),
  ]);
  const totalRecords = (props.count || 0) + (tenants.count || 0) + (payments.count || 0);
  const isEmpty = totalRecords === 0;
  setDeleteTyped("");
  setDeleteModal({
  company,
  counts: { properties: props.count || 0, tenants: tenants.count || 0, payments: payments.count || 0 },
  hasTeller: (bankConn.count || 0) > 0,
  mode: isEmpty ? "hard" : "archive",
  });
  }

  async function confirmDelete() {
  if (!deleteModal) return;
  const company = deleteModal.company;
  if (deleteTyped !== company.name) { showToast("Company name doesn't match — type it exactly to confirm.", "error"); return; }
  setDeleting(company.id);
  try {
  if (deleteModal.mode === "hard") {
  // Server-side atomic teardown via RPC. The old client-side
  // Promise.allSettled over five tables left audit/journal/bank
  // rows orphaned (including encrypted Teller tokens).
  const { data, error } = await supabase.rpc("hard_delete_company", { p_company_id: company.id });
  if (error) {
  pmError("PM-8006", { raw: error, context: "hard_delete_company RPC" });
  showToast("Error deleting company: " + error.message, "error");
  return;
  }
  logAudit("delete", "companies", "Permanently deleted company: " + company.name + " (" + (data?.total_rows_deleted || 0) + " rows)", company.id, currentUser?.email, "admin", company.id);
  showToast('"' + company.name + '" permanently deleted (' + (data?.total_rows_deleted || 0) + ' rows).', "success");
  } else {
  const { error: archErr } = await supabase.from("companies").update({ archived_at: new Date().toISOString(), archived_by: currentUser?.email }).eq("id", company.id);
  if (archErr) { showToast("Error archiving company: " + archErr.message, "error"); return; }
  await supabase.from("company_members").update({ status: "removed" }).eq("company_id", company.id);
  logAudit("archive", "companies", "Archived company: " + company.name, company.id, currentUser?.email, "admin", company.id);
  showToast('"' + company.name + '" archived. Will be purged after 180 days.', "success");
  }
  } catch (e) { showToast("Error: " + e.message, "error"); }
  finally {
  setDeleting(null);
  setDeleteModal(null);
  setDeleteTyped("");
  fetchCompanies();
  }
  }

  if (loading) return <div className="flex items-center justify-center h-screen bg-brand-50/30"><Spinner /></div>;

  if (showProfile) return <UserProfile currentUser={currentUser} onBack={() => setShowProfile(false)} showToast={showToast} showConfirm={showConfirm} />;

  return (
  <div className="min-h-screen bg-gradient-to-br from-brand-50 to-white flex items-center justify-center p-4">
  {/* Top-right menu */}
  <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
  <Btn variant="secondary" size="sm" onClick={() => setShowProfile(true)}>
  <span className="material-icons-outlined text-base">person</span>Profile
  </Btn>
  <Btn variant="danger" size="sm" onClick={onLogout}>
  <span className="material-icons-outlined text-base">logout</span>Logout
  </Btn>
  </div>
  <div className="w-full max-w-2xl">
  <div className="text-center mb-8">
  <div className="text-3xl font-bold text-brand-700 mb-1">{"\u{1F3E1}"} PropManager</div>
  <div className="text-sm text-neutral-400">Welcome, {currentUser?.email}</div>
  </div>

  {/* Your Companies */}
  {companies.length > 0 && (
  <div className="mb-6">
  <div className="flex items-center justify-between mb-3">
  <h2 className="text-sm font-bold text-neutral-700 uppercase tracking-wide">Your Companies</h2>
  {companies.length > 3 && <Input placeholder="Search companies..." value={companySearch} onChange={e => setCompanySearch(e.target.value)} className="w-48 text-xs" />}
  </div>
  <div className="space-y-2">
  {companies.filter(c => !companySearch || c.name.toLowerCase().includes(companySearch.toLowerCase())).map(c => (
  <div key={c.id} className="w-full bg-white rounded-xl border border-brand-100 p-4 flex items-center justify-between hover:border-brand-300 hover:shadow-md transition-all">
  <div onClick={() => onSelectCompany(c, c.memberRole)} className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer">
  <div className="w-10 h-10 rounded-xl bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-lg shrink-0">
  {c.name[0]}
  </div>
  <div className="min-w-0">
  <div className="font-semibold text-neutral-800 truncate">{c.name}</div>
  <div className="text-xs text-neutral-400">{c.type} · {c.memberRole}</div>
  </div>
  </div>
  <div className="flex items-center gap-2 shrink-0 ml-3">
  <a href={window.location.origin + window.location.pathname + "?company=" + encodeURIComponent(c.id) + "#dashboard"} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.stopPropagation(); }} className="text-brand-600 text-xs font-medium hover:underline flex items-center gap-1"><span className="material-icons-outlined text-sm">open_in_new</span>Open</a>
  {c.memberRole === "admin" && (
  <div className="relative">
  <button onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === c.id ? null : c.id); }} disabled={deleting === c.id} className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 disabled:opacity-50" aria-label="More actions">
  <span className="material-icons-outlined text-lg">more_vert</span>
  </button>
  {openMenu === c.id && (
  <div onClick={(e) => e.stopPropagation()} className="absolute right-0 top-full mt-1 bg-white border border-brand-100 rounded-xl shadow-lg min-w-[160px] z-10 py-1">
  <button onClick={() => openDeleteFlow(c)} className="w-full text-left px-4 py-2 text-sm text-danger-600 hover:bg-danger-50 flex items-center gap-2">
  <span className="material-icons-outlined text-base">delete</span>Delete company
  </button>
  </div>
  )}
  </div>
  )}
  </div>
  </div>
  ))}
  </div>
  </div>
  )}

  {/* Invites */}
  {invites.length > 0 && (
  <div className="mb-6">
  <h2 className="text-sm font-bold text-neutral-700 uppercase tracking-wide mb-3">Pending Invites</h2>
  <div className="space-y-2">
  {invites.map(c => (
  <div key={c.id} className="w-full bg-positive-50 rounded-xl border border-positive-200 p-4 flex items-center justify-between">
  <div className="flex items-center gap-3 flex-1 min-w-0">
  <div className="w-10 h-10 rounded-xl bg-positive-100 flex items-center justify-center text-positive-700 font-bold text-lg shrink-0">
  <span className="material-icons-outlined text-xl">mail</span>
  </div>
  <div className="min-w-0">
  <div className="font-semibold text-neutral-800 truncate">{c.name}</div>
  <div className="text-xs text-neutral-500">You've been invited as <span className="font-medium">{c.memberRole}</span></div>
  </div>
  </div>
  <div className="flex items-center gap-2 shrink-0 ml-3">
  <Btn variant="success-fill" size="sm" onClick={() => acceptInvite(c)} disabled={acceptingInvite === c.id}>
  {acceptingInvite === c.id ? "Joining..." : "Accept & Open"}
  </Btn>
  </div>
  </div>
  ))}
  </div>
  </div>
  )}

  {/* Pending Requests */}
  {pendingRequests.length > 0 && (
  <div className="mb-6 bg-warn-50 border border-warn-200 rounded-3xl p-4">
  <div className="text-sm font-semibold text-warn-800 mb-1">⏳ Pending Requests</div>
  <div className="text-xs text-warn-600">You have {pendingRequests.length} pending request(s) waiting for admin approval.</div>
  </div>
  )}

  {joinMessage && (
  <div className="mb-4 bg-positive-50 border border-positive-200 rounded-3xl p-4 text-sm text-positive-700">{joinMessage}</div>
  )}

  {/* Actions */}
  <div className="grid grid-cols-2 gap-3 mb-6">
  <Btn variant="primary" onClick={() => { if (!creating) { setShowCreate(true); setShowJoin(false); } }} disabled={creating} className="p-4 text-center disabled:opacity-50">
  <div className="text-2xl mb-1">{"\u{1F3E2}"}</div>
  <div className="text-sm font-semibold">Create Company</div>
  <div className="text-xs text-brand-200">Start a new LLC or org</div>
  </Btn>
  <button onClick={() => { setShowJoin(true); setShowCreate(false); }}
  className="bg-white border-2 border-brand-200 text-brand-700 rounded-3xl p-4 text-center hover:border-brand-400 transition-colors">
  <div className="text-2xl mb-1">{"\u{1F517}"}</div>
  <div className="text-sm font-semibold">Join Company</div>
  <div className="text-xs text-neutral-400">Enter code or search</div>
  </button>
  </div>

  {/* Create Company Form */}
  {showCreate && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-6 mb-4">
  <h3 className="font-bold text-neutral-800 mb-4">Create New Company</h3>
  <div className="space-y-3">
  {/* Company Role Selection */}
  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-2">Company Type *</label>
  <div className="grid grid-cols-2 gap-3">
  <button type="button" onClick={() => setCreateForm({...createForm, company_role: "management"})} className={`p-3 rounded-xl border-2 text-left transition-all ${createForm.company_role === "management" ? "border-brand-500 bg-brand-50" : "border-brand-100 hover:border-brand-200"}`}>
  <div className="text-lg mb-1">{"\u{1F3E2}"}</div>
  <div className="text-sm font-semibold text-neutral-800">Property Management</div>
  <div className="text-xs text-neutral-400">I manage properties for owners</div>
  </button>
  <button type="button" onClick={() => setCreateForm({...createForm, company_role: "owner"})} className={`p-3 rounded-xl border-2 text-left transition-all ${createForm.company_role === "owner" ? "border-success-500 bg-success-50" : "border-brand-100 hover:border-brand-200"}`}>
  <div className="text-lg mb-1">{"\u{1F3E0}"}</div>
  <div className="text-sm font-semibold text-neutral-800">Property Owner</div>
  <div className="text-xs text-neutral-400">I own and manage my properties</div>
  </button>
  </div>
  </div>
  <div><label className="text-xs font-medium text-neutral-500">Company Name *</label><Input value={createForm.name} onChange={e => setCreateForm({...createForm, name: e.target.value})} className="mt-1" placeholder={createForm.company_role === "management" ? "e.g. Sigma Property Management" : "e.g. Smith Properties LLC"} /></div>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-500">Entity Type</label><Select value={createForm.type} onChange={e => setCreateForm({...createForm, type: e.target.value})} className="mt-1"><option>LLC</option><option>Corporation</option><option>Partnership</option><option>Sole Proprietorship</option><option>Trust</option><option>Other</option></Select></div>
  <div><label className="text-xs font-medium text-neutral-500">Email</label><Input type="email" value={createForm.email} onChange={e => setCreateForm({...createForm, email: e.target.value})} className="mt-1" placeholder="company@email.com" /></div>
  </div>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-500">Address</label><Input placeholder="123 Business Ave, City, State ZIP" value={createForm.address} onChange={e => setCreateForm({...createForm, address: e.target.value})} className="mt-1" /></div>
  <div><label className="text-xs font-medium text-neutral-500">Phone</label><Input type="tel" placeholder="(555) 123-4567" value={createForm.phone} onChange={e => setCreateForm({...createForm, phone: formatPhoneInput(e.target.value)})} maxLength={14} className="mt-1" /></div>
  </div>
  <div className="flex gap-2 pt-2">
  <Btn size="lg" onClick={createCompany} disabled={creating}>{creating ? "Creating..." : "Create Company"}</Btn>
  <Btn variant="slate" size="sm" onClick={() => setShowCreate(false)}>Cancel</Btn>
  </div>
  </div>
  </div>
  )}

  {/* Join Company Form */}
  {showJoin && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-6 mb-4">
  <h3 className="font-bold text-neutral-800 mb-4">Join a Company</h3>
  <div className="space-y-3">
  <div><label className="text-xs font-medium text-neutral-500">Company ID (8-digit code)</label><Input value={joinCode} onChange={e => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 8))} className="mt-1" placeholder="e.g. 12345678" maxLength={8} /></div>
  <div className="text-xs text-neutral-400 text-center">— or —</div>
  <div><label className="text-xs font-medium text-neutral-500">Search by Name</label><Input value={joinSearch} onChange={e => setJoinSearch(e.target.value)} className="mt-1" placeholder="e.g. Sigma Housing" /></div>
  <div className="flex gap-2">
  <Btn size="lg" onClick={searchCompanies}>Search</Btn>
  <Btn variant="slate" size="sm" onClick={() => setShowJoin(false)}>Cancel</Btn>
  </div>
  {searchResults.length > 0 && (
  <div className="space-y-2 mt-3">
  {searchResults.map(c => (
  <div key={c.id} className="flex items-center justify-between bg-brand-50/30 rounded-lg p-3">
  <div><div className="text-sm font-semibold text-neutral-800">{c.name}</div><div className="text-xs text-neutral-400">{c.type}</div></div>
  <Btn size="xs" onClick={() => requestJoin(c)}>Request to Join</Btn>
  </div>
  ))}
  </div>
  )}
  {searchResults.length === 0 && (joinCode || joinSearch) && <div className="text-xs text-neutral-400 text-center">Click Search to find companies</div>}
  </div>
  </div>
  )}

  </div>

  {/* Delete-confirmation modal — typed name required */}
  {deleteModal && (() => {
  const isHard = deleteModal.mode === "hard";
  const nameMatches = deleteTyped === deleteModal.company.name;
  const disabled = !nameMatches || deleting === deleteModal.company.id;
  return (
  <div className="fixed inset-0 bg-black bg-opacity-50 z-[100] flex items-center justify-center p-4">
  <div className="bg-white rounded-3xl shadow-card border border-danger-200 w-full max-w-md">
  <div className="px-6 py-4 border-b border-danger-100 bg-danger-50/60 rounded-t-3xl">
  <h3 className="font-manrope font-bold text-danger-700 text-lg flex items-center gap-2">
  <span className="material-icons-outlined text-xl">{isHard ? "delete_forever" : "archive"}</span>
  {isHard ? "Permanently delete" : "Archive"} "{deleteModal.company.name}"?
  </h3>
  </div>
  <div className="px-6 py-5 space-y-3 text-sm text-neutral-700">
  {isHard ? (
  <p>This company has no properties, tenants, or payments. Every related row (journal entries, ledger, bank connections, audit, documents, work orders, etc.) will be <strong>permanently deleted</strong>. This cannot be undone.</p>
  ) : (
  <p>This company has {deleteModal.counts.properties} properties, {deleteModal.counts.tenants} tenants, and {deleteModal.counts.payments} payments. It will be archived for 180 days and then automatically purged. Contact support during that window to restore it.</p>
  )}
  {deleteModal.hasTeller && (
  <div className="bg-warn-50 border border-warn-200 rounded-xl px-3 py-2 text-warn-800 text-xs">
  <span className="material-icons-outlined text-sm align-middle mr-1">warning</span>
  This company has a connected Teller bank account. The stored credentials will be {isHard ? "deleted" : "retained with the archive"}.
  </div>
  )}
  <div>
  <label className="text-xs font-medium text-neutral-500 uppercase tracking-widest block mb-1">Type <span className="font-mono text-danger-600 normal-case">{deleteModal.company.name}</span> to confirm</label>
  <Input value={deleteTyped} onChange={e => setDeleteTyped(e.target.value)} placeholder={deleteModal.company.name} autoFocus />
  </div>
  </div>
  <div className="px-6 py-4 border-t border-brand-50 flex justify-end gap-3">
  <Btn variant="slate" onClick={() => { setDeleteModal(null); setDeleteTyped(""); }}>Cancel</Btn>
  <Btn variant="danger-fill" onClick={confirmDelete} disabled={disabled}>
  {deleting === deleteModal.company.id ? (isHard ? "Deleting…" : "Archiving…") : (isHard ? "Delete forever" : "Archive company")}
  </Btn>
  </div>
  </div>
  </div>
  );
  })()}
  </div>
  );
}

// ============ ADMIN: PENDING MEMBER REQUESTS ============
function PendingRequestsPanel({ companyId, addNotification }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchRequests(); }, [companyId]);

  async function fetchRequests() {
  const { data } = await supabase.from("company_members").select("*").eq("company_id", companyId).eq("status", "pending").order("created_at", { ascending: false });
  setRequests(data || []);
  setLoading(false);
  }

  async function handleRequest(member, action) {
  // Server-side membership approval — verifies caller is admin
  try {
  const { data: result, error: rpcErr } = await supabase.rpc("handle_membership_request", {
  p_company_id: companyId,
  p_member_id: String(member.id),
  p_action: action,
  });
  if (rpcErr) throw new Error(rpcErr.message);
  if (action === "approve") addNotification("\u2705", member.user_name + " approved to join");
  else addNotification("\u274C", member.user_name + "'s request rejected");
  } catch (e) {
  // RPC mandatory — no client fallback for membership changes
  pmError("PM-8003", { raw: e, context: "process membership request" });
  return;
  }
  fetchRequests();
  }

  if (loading || requests.length === 0) return null;

  return (
  <div className="bg-warn-50 border border-warn-200 rounded-3xl p-4 mb-4">
  <div className="flex items-center justify-between mb-3">
  <div className="text-sm font-bold text-warn-800">⏳ Pending Join Requests ({requests.length})</div>
  </div>
  <div className="space-y-2">
  {requests.map(r => (
  <div key={r.id} className="flex items-center justify-between bg-white rounded-lg p-3">
  <div>
  <div className="text-sm font-semibold text-neutral-800">{r.user_name || r.user_email}</div>
  <div className="text-xs text-neutral-400">{r.user_email} · Requested: {new Date(r.created_at).toLocaleDateString()}</div>
  </div>
  <div className="flex gap-2">
  <Btn variant="success-fill" size="xs" onClick={() => handleRequest(r, "approve")}>Approve</Btn>
  <Btn variant="danger" size="xs" onClick={() => handleRequest(r, "reject")}>Reject</Btn>
  </div>
  </div>
  ))}
  </div>
  </div>
  );
}

// ============ PM ASSIGNMENT REQUESTS PANEL ============
function PendingPMAssignments({ companyId, addNotification }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchRequests(); }, [companyId]);

  async function fetchRequests() {
  const { data } = await supabase.from("pm_assignment_requests").select("*")
  .eq("pm_company_id", companyId).eq("status", "pending").order("created_at", { ascending: false });
  setRequests(data || []);
  setLoading(false);
  }

  async function handleRequest(req, action) {
  if (action === "accept") {
  try {
  const { data: result, error } = await supabase.rpc("accept_pm_assignment", {
  p_request_id: req.id,
  p_pm_company_id: companyId,
  p_reviewer_email: "",
  });
  if (error) throw new Error(error.message);
  addNotification("\u2705", "Accepted: now managing " + req.property_address);
  } catch (e) {
  showToast("Error accepting assignment: " + e.message, "error");
  return;
  }
  } else {
  const { error } = await supabase.from("pm_assignment_requests").update({
  status: "declined", reviewed_at: new Date().toISOString(),
  }).eq("id", req.id).eq("pm_company_id", companyId);
  if (error) { pmError("PM-8006", { raw: error, context: "decline membership request" }); return; }
  addNotification("\u274C", "Declined PM request for " + req.property_address);
  }
  fetchRequests();
  }

  if (loading || requests.length === 0) return null;

  return (
  <div className="bg-info-50 border border-info-200 rounded-3xl p-4 mb-4">
  <div className="flex items-center justify-between mb-3">
  <div className="text-sm font-bold text-info-800">{"\u{1F4E8}"} PM Assignment Requests ({requests.length})</div>
  </div>
  <div className="space-y-2">
  {requests.map(r => (
  <div key={r.id} className="flex items-center justify-between bg-white rounded-lg p-3">
  <div>
  <div className="text-sm font-semibold text-neutral-800">{r.property_address}</div>
  <div className="text-xs text-neutral-400">Owner requested: {new Date(r.requested_at).toLocaleDateString()} · {r.requested_by}</div>
  </div>
  <div className="flex gap-2">
  <Btn variant="success-fill" size="xs" onClick={() => handleRequest(r, "accept")}>Accept</Btn>
  <Btn variant="danger" size="xs" onClick={() => handleRequest(r, "decline")}>Decline</Btn>
  </div>
  </div>
  ))}
  </div>
  </div>
  );
}

export { CompanySelector, PendingRequestsPanel, PendingPMAssignments };
export default CompanySelector;
