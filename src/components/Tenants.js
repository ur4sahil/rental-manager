import React, { useMemo, useState, useEffect } from "react";
import { supabase } from "../supabase";
import { archiveTenant } from "../utils/tenantArchive";
import TenantPage from "./TenantPage";
import { Btn, Checkbox, FilterPill, IconBtn, Input, PageHeader, Select, TextLink, clickable, keyboardActivate, CardOpenButton, DataTable, EmptyState, usePersistedView, usePersistedList, MultiSelect} from "../ui";
import { safeNum, parseLocalDate, formatLocalDate, shortId, formatPersonName, parseNameParts, isValidEmail, normalizeEmail, formatCurrency, getSignedUrl, formatPhoneInput, exportToCSV, escapeHtml, escapeFilterValue, emailFilterValue, REQUIRED_TENANT_DOCS, isRequiredDocMet, DOC_TYPES, recomputeTenantDocStatus, canReviewRequest , pgrestQuote, ACTIVE_LEASE, propertyLabel, fmtDate, fmtDateTime} from "../utils/helpers";
import { pmError } from "../utils/errors";
import { printTheme, printTable} from "../utils/theme";
import { guardSubmit, guardRelease, _submitGuards } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { safeLedgerInsert, atomicPostJEAndLedger, autoPostJournalEntry, getPropertyClassId, getOrCreateTenantAR, autoPostRentCharges, resolveAccountId } from "../utils/accounting";
import { Badge, Spinner, Modal, PropertySelect, RecurringEntryModal, DocUploadModal } from "./shared";
import { MessageThread, MessageComposer, uploadMessageAttachment } from "./Messages";
import { queueNotification } from "../utils/notifications";
import { pathForPage, subPathFor } from "../utils/routes";
import { LeaseManagement } from "./Leases";
import { MoveOutWizard, EvictionWorkflow } from "./Lifecycle";

// "ID" and "Utility Transfer" are stored values; people read the long form.
const docTypeLabel = (v) => (DOC_TYPES.find(t => t.value === v) || {}).label || v || "Other";


// One tenant's rows, precisely.
//
// tenant_id is authoritative. The (name, property) pair is the fallback
// for rows written before the tenant_id backfill, and it identifies a
// tenant uniquely among ACTIVE tenants because of the partial unique
// index idx_tenants_unique_name_property on (company_id, name, property).
//
// Matching on the NAME ALONE -- which is what these queries used to do --
// merged two namesakes' records into a single view: one running ledger
// balance built from two people's charges, one document list holding
// both their leases. Staff are authorised to see all of it, so this is
// not a disclosure bug; it is a wrong-data bug, which is harder to
// notice and worse to act on.
//
// Both halves are kept rather than filtering on tenant_id alone: the
// backfill could not resolve every historical row (an archived tenant's
// documents, for instance), and an id-only filter would silently drop
// that history.
function scopeToTenant(q, tenant, nameCol = "tenant") {
  // pgrestQuote, not escapeFilterValue: inside and(...) a comma ends the
  // argument, and addresses carry two of them ("7200 Bogley, District
  // Heights, MD 20747"). Unquoted, the filter is malformed and PostgREST
  // returns 400, which the caller's `data || []` turns into "no rows".
  const name = pgrestQuote(tenant?.name || "");
  const prop = pgrestQuote(tenant?.property || "");
  return tenant?.id
    ? q.or(`tenant_id.eq.${tenant.id},and(${nameCol}.eq.${name},property.eq.${prop})`)
    : q.eq(nameCol, tenant?.name || "").eq("property", tenant?.property || "");
}


const acctToday = () => formatLocalDate(new Date());

// Resolve every bare chart-of-accounts code on a set of JE lines to the
// real acct_accounts UUID.
//
// post_je_and_ledger() casts each line's account_id to ::uuid, so a bare
// code like "4100" makes the RPC fail with 22P02 — PostgREST turns that
// into an HTTP 400 and atomicPostJEAndLedger swallows it as PM-4002 and
// silently drops to the non-atomic postAccountingTransaction fallback.
// The post still lands (autoPostJournalEntry resolves codes itself), so
// nothing looks broken — but the atomic guarantee is gone on EVERY post
// and a 400 is logged every time. Resolving client-side keeps us on the
// RPC.
//
// Returns { lines } on success or { missing } naming the first code that
// could not be resolved. Callers must abort on `missing`: a line with a
// null account_id posts money to nowhere, which is strictly worse than
// not posting at all.
async function resolveJELineAccounts(lines, companyId) {
  const out = [];
  for (const l of lines || []) {
    let id = l.account_id;
    if (typeof id === "string" && /^\d{4}$/.test(id)) id = await resolveAccountId(id, companyId);
    if (!id) return { lines: null, missing: l.account_id || "(unset)" };
    out.push({ ...l, account_id: id });
  }
  return { lines: out, missing: null };
}

// ============ TENANTS ============
function Tenants({ addNotification, userProfile, userRole, companyId, setPage, initialTab, initialAction, showToast, showConfirm, activeCompany, companySettings = {} }) {
  const isAdmin = userRole === "admin";
  const isManager = userRole === "manager";
  const canReviewAny = isAdmin || userRole === "owner" || isManager;
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
  { label: "Lease Start", key: t => fmtDate(t.lease_start) },
  { label: "Lease End", key: t => fmtDate(t.lease_end) },
  ], "tenants_" + fmtDate(new Date()), showToast);
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
  const [form, setForm] = useState({ name: "", first_name: "", mi: "", last_name: "", email: "", phone: "", property: "", lease_status: "current", lease_start: "", lease_end: "", rent: "", late_fee_amount: "", late_fee_type: companySettings?.late_fee_type || "flat", is_voucher: false, voucher_number: "", reexam_date: "", case_manager_name: "", case_manager_email: "", case_manager_phone: "", voucher_portion: "", tenant_portion: "" });
  const [tenantView, setTenantView] = usePersistedView("tenants", "card", ["card", "table", "compact"]);
  const [tenantSearch, setTenantSearch] = useState("");
  // Multi-select, and remembered. These were single-select, so "current
  // AND past but not archived" was not expressible -- and every choice was
  // lost on navigation. An empty list means everything, which is what the
  // old "all" sentinel meant.
  const [tenantFilter, setTenantFilter] = usePersistedList("tenants-status", [],
    ["active", "current", "notice", "past", "expired", "inactive"]);
  // Name ascending is how the list was ordered before sorting existed, so
  // the default view does not change for anyone.
  const [tenantSort, setTenantSort] = useState({ key: "name", dir: "asc" });
  const SORTABLE = { name: "Name", property: "Property", email: "Email",
                     lease_status: "Status", rent: "Rent", balance: "Balance" };
  const [tenantFilterProp, setTenantFilterProp] = usePersistedList("tenants-property", []);
  const [tenantFilterBalance, setTenantFilterBalance] = usePersistedList("tenants-balance", [], ["delinquent", "current", "credit"]);
  const [tenantFilterLeaseExpiry, setTenantFilterLeaseExpiry] = usePersistedList("tenants-lease", [], ["30", "60", "90", "expired", "no_lease"]);
  // Bulk selection
  const [selectedTenants, setSelectedTenants] = useState(new Set());
  const [bulkAction, setBulkAction] = useState(null);
  const [leaseModal, setLeaseModal] = useState(null);
  const [tenantDocs, setTenantDocs] = useState([]);
  const [tenantTab, setTenantTab] = useState(initialTab || "tenants");
  const [reviewBusy, setReviewBusy] = useState(null);
  // When editing was launched from the tenant side panel, remember the
  // tenant so saving can hand back to that panel instead of dumping the
  // user on the bare list.
  const [editReturnTo, setEditReturnTo] = useState(null);
  const [showAddTxn, setShowAddTxn] = useState(false);
  const [ledgerShowAll, setLedgerShowAll] = useState(false);
  const [archivedTenants, setArchivedTenants] = useState([]);
  // Detail panel for a single archived/moved-out tenant.
  // { tenant, ledger, docs, messages, leases, payments, workOrders, activeTab }
  const [archivedDetail, setArchivedDetail] = useState(null);
  const [portalMembers, setPortalMembers] = useState({}); // email(lower) → 'invited' | 'active' | 'removed'
  const [showTenantDocPrompt, setShowTenantDocPrompt] = useState(null);
  const [showDocUpload, setShowDocUpload] = useState(null);
  const [docExceptions, setDocExceptions] = useState([]);
  const [leaseInput, setLeaseInput] = useState("");
  // eslint-disable-next-line no-unused-vars
  const [error, setError] = useState("");
  const [invitingTenant, setInvitingTenant] = useState({});

  useEffect(() => {
  fetchTenants();
  fetchDocExceptions();
  fetchPortalMembers();
  supabase.from("properties").select("*").eq("company_id", companyId).is("archived_at", null)
  .then(({ data, error }) => { if (error) pmError("PM-8006", { raw: error, context: "tenants property fetch", silent: true }); setProperties(data || []); });
  }, [companyId]);

  // Deep-link handler: Tasks & Approvals passes `openTenantId` +
  // `panel` via initialAction so clicking a "documents pending" card
  // lands on that tenant's Documents tab rather than dumping the user
  // on the generic Tenants list. Runs once the tenants array has
  // loaded; re-runs if the caller re-navigates with a different id.
  useEffect(() => {
    if (!initialAction?.openTenantId || tenants.length === 0) return;
    const t = tenants.find(x => String(x.id) === String(initialAction.openTenantId))
      || tenants.find(x => x.name === initialAction.tenantName);
    if (!t) return;
    setSelectedTenant(t);
    setActivePanel(initialAction.panel || "detail");
    if (initialAction.panel === "documents") fetchTenantDocs(t);
    if (initialAction.panel === "ledger") openLedger(t);
    if (initialAction.panel === "messages") openMessages(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAction?.openTenantId, tenants.length]);

  // ---- A TENANT IS A PLACE -------------------------------------------
  //
  // /tenants/1049/ledger, not /tenants with the tenant held in React state.
  //
  // Reports were the only screen in the app whose URL said what was on
  // screen; everywhere else, opening something left the address bar on the
  // page you started from. That costs three things people expect:
  //   * Back returns to the tenant list, not to the previous PAGE
  //   * a refresh keeps your place
  //   * a link can be bookmarked or sent to someone
  //
  // It also removes hand-rolled history. jeOrigin in Accounting.js exists to
  // remember "where did this journal entry come from" -- a second history
  // stack maintained beside the browser's. With real URLs that question is
  // just Back.
  const PANELS = ["detail", "ledger", "documents", "messages", "actions", "lease"];
  const urlSyncing = React.useRef(false);

  const tenantUrl = (tenant, panel) => {
    const base = pathForPage("tenants");
    const path = tenant ? `${base}/${tenant.id}${panel && panel !== "detail" ? "/" + panel : ""}` : base;
    // Keep the query string: ?company= lives there and must survive.
    return path + window.location.search + window.location.hash;
  };

  // Read the URL on arrival (and on Back/Forward) and open what it names.
  const openFromUrl = React.useCallback((list) => {
    const sub = subPathFor("tenants", window.location.pathname);
    if (!sub) { setSelectedTenant(null); setActivePanel(null); return; }
    const [idPart, panelPart] = sub.split("/");
    const t = (list || []).find(x => String(x.id) === String(idPart));
    // A tenant id that is not in this company's list is not an error to
    // report -- it is a link to somewhere the viewer cannot see, and the
    // list is the honest answer.
    if (!t) return;
    const panel = PANELS.includes(panelPart) ? panelPart : "detail";
    urlSyncing.current = true;
    setSelectedTenant(t);
    setActivePanel(panel);
    // The page shows the ledger and the documents together, so a deep link
    // has to load both. The drawer could defer each to the tab that owned it.
    openLedger(t);
    openMessages(t);
    urlSyncing.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tenants.length) openFromUrl(tenants);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants.length]);

  useEffect(() => {
    const onPop = () => openFromUrl(tenants);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants]);

  // Write the URL when the selection changes.
  //
  // Opening a tenant PUSHES, so Back returns to the list. Switching panel
  // REPLACES, so clicking through Ledger/Documents/Messages does not bury
  // the list under four history entries -- the same judgement the Reports
  // page already makes about periods.
  useEffect(() => {
    if (urlSyncing.current) return;
    const want = tenantUrl(selectedTenant, activePanel);
    const here = window.location.pathname + window.location.search + window.location.hash;
    if (want === here) return;
    const opening = selectedTenant && !subPathFor("tenants", window.location.pathname);
    const st = { ...(window.history.state || {}), page: "tenants", screen: "app" };
    try {
      if (opening) window.history.pushState(st, "", want);
      else window.history.replaceState(st, "", want);
    } catch (_e) { /* a URL we cannot write must never block the UI */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTenant?.id, activePanel]);

  async function fetchTenants() {
  const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId).is("archived_at", null);
  setTenants(data || []);
  setLoading(false);
  }
  // Tenants a bulk import could not classify. Derived from the tenants
  // already loaded rather than fetched again, so the tab count updates
  // the moment one is resolved.
  const reviewTenants = useMemo(
    () => (tenants || []).filter(t => String(t.lease_status || "").toLowerCase() === "review"),
    [tenants]
  );

  // Answering the question. "Not a tenant" archives rather than deletes:
  // the QuickBooks import turned lenders and title companies into
  // tenants, and their ledger history has to survive being told so.
  async function resolveReview(t, answer) {
    if (!guardSubmit("resolveReview")) return;
    setReviewBusy(t.id);
    try {
      const patch = answer === "not_a_tenant"
        ? { archived_at: new Date().toISOString(), archived_by: userProfile?.email || "review",
            lease_status: "past" }
        : { lease_status: answer };
      const { error } = await supabase.from("tenants").update(patch)
        .eq("id", t.id).eq("company_id", companyId);
      if (error) { pmError("PM-3007", { raw: error, context: "resolving tenant review status" }); return; }

      // Occupancy follows from the answer, so the Properties page stops
      // disagreeing with the Tenants page.
      if (t.property) {
        if (answer === "current") {
          await supabase.from("properties").update({ status: "occupied" })
            .eq("company_id", companyId).eq("address", t.property).neq("status", "occupied");
        } else {
          const { data: others } = await supabase.from("tenants").select("id")
            .eq("company_id", companyId).eq("property", t.property)
            .in("lease_status", ACTIVE_LEASE).is("archived_at", null).neq("id", t.id).limit(1);
          if (!(others || []).length) {
            await supabase.from("properties").update({ status: "vacant" })
              .eq("company_id", companyId).eq("address", t.property).neq("status", "vacant");
          }
        }
      }
      showToast(`${t.name} marked ${answer === "not_a_tenant" ? "not a tenant" : answer}.`, "success");
      await fetchTenants();
    } finally { setReviewBusy(null); guardRelease("resolveReview"); }
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

  // A rent change has to reach the recurring entry that bills it.
  // Otherwise a rent increase is saved on the tenant and the monthly
  // charge keeps posting the OLD amount indefinitely -- the books quietly
  // disagree with the lease.
  //
  // Matched on tenant_id (bigint, same as tenants.id), not tenant_name:
  // names are not unique -- production has same-name tenant groups -- and
  // this edit may itself be renaming the tenant.
  if (editingTenant && Number(editingTenant.rent) !== _rent) {
    const { data: recurring, error: recErr } = await supabase
      .from("recurring_journal_entries")
      .select("id, amount, description")
      .eq("company_id", companyId)
      .eq("tenant_id", editingTenant.id)
      .neq("status", "cancelled");
    if (recErr) {
      // Non-fatal: the tenant is already saved. Say so plainly rather
      // than leaving the mismatch silent.
      showToast("Rent saved, but the recurring entry could not be checked — please update it manually.", "warning");
      pmError("PM-4008", { raw: recErr, context: "sync recurring amount after rent change", silent: true });
    } else if (recurring && recurring.length > 0) {
      const { error: upErr } = await supabase.from("recurring_journal_entries")
        .update({ amount: _rent })
        .eq("company_id", companyId)
        .eq("tenant_id", editingTenant.id)
        .neq("status", "cancelled");
      if (upErr) {
        showToast("Rent saved, but the recurring entry still bills " + formatCurrency(recurring[0].amount) + " — please update it manually.", "warning");
        pmError("PM-4008", { raw: upErr, context: "update recurring amount after rent change", silent: true });
      } else {
        // Announced, not silent: this changes what the tenant is billed.
        showToast(`Rent updated to ${formatCurrency(_rent)} — the recurring ${recurring.length === 1 ? "entry" : "entries"} now bill${recurring.length === 1 ? "s" : ""} the new amount.`, "success");
      }
    }
  }

  setShowForm(false);
  setEditingTenant(null);
  setForm({ name: "", first_name: "", mi: "", last_name: "", email: "", phone: "", property: "", lease_status: "current", lease_start: "", lease_end: "", rent: "", security_deposit: "" });
  // Hand back to the side panel this edit came from, showing the saved
  // values rather than the stale ones the panel was opened with.
  if (editReturnTo) {
    const returning = editReturnTo;
    setEditReturnTo(null);
    supabase.from("tenants").select("*").eq("company_id", companyId).eq("id", returning.id)
      .maybeSingle().then(({ data }) => {
        setSelectedTenant(data || returning);
        setActivePanel("actions");
      }, () => { setSelectedTenant(returning); setActivePanel("actions"); });
  }
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
  // "2100" is a bare code and post_je_and_ledger casts account_id to
  // ::uuid, so leaving it bare 400s the RPC and drops the deposit onto
  // the non-atomic fallback. Resolve both legs up front; refuse to
  // post if either is unresolvable rather than writing a null
  // account_id. (The AR leg is already the per-tenant sub-account and
  // deliberately passes no balanceUpdate — the balance trigger owns it.)
  const _depResolved = await resolveJELineAccounts([
  { account_id: tenantArId, account_name: "AR - " + _name, debit: _secDep, credit: 0, class_id: classId, memo: "Security deposit from " + _name },
  { account_id: "2100", account_name: "Security Deposits Held", debit: 0, credit: _secDep, class_id: classId, memo: _name + " — " + _property },
  ], companyId);
  if (!_depResolved.lines) { showToast("Security deposit accounting entry failed — could not resolve account " + _depResolved.missing + ".", "error"); }
  const _depResult = _depResolved.lines ? await atomicPostJEAndLedger({ companyId, date: _leaseStart, description: "Security deposit received — " + _name + " — " + _property, reference: "DEP-" + shortId(), property: _property,
  lines: _depResolved.lines,
  ledgerEntry: { tenant: _name, tenant_id: tenantId, property: _property, date: _leaseStart, description: "Security deposit collected", amount: _secDep, type: "deposit" }
  }) : null;
  if (_depResolved.lines && !_depResult?.jeId) showToast("Security deposit accounting entry failed.", "error");
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
  // Cascade name change to all related tables — scoped by property so that
  // two tenants sharing a name at different properties don't rewrite each
  // other's records. Previous code updated by name only, which violated
  // the CLAUDE.md "scope by tenant name AND property" rule.
  if (editingTenant.name !== form.name) {
  const oldProperty = editingTenant.property || "";
  const oldName = editingTenant.name;
  const { error: tenantRenameErr } = await supabase.rpc("rename_tenant_cascade", {
  p_company_id: companyId, p_old_name: oldName, p_new_name: form.name, p_property: oldProperty
  });
  if (tenantRenameErr) {
  // Client-side fallback — same property scoping as the RPC so the
  // loose legacy behavior doesn't come back via the fallback.
  pmError("PM-3002", { raw: tenantRenameErr, context: "tenant rename RPC, running client-side fallback", silent: true });
  const tRenameResults = await Promise.allSettled([
  supabase.from("payments").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName).eq("property", oldProperty),
  editingTenant.id
    ? supabase.from("leases").update({ tenant_name: form.name }).eq("company_id", companyId).eq("tenant_id", editingTenant.id)
    : supabase.from("leases").update({ tenant_name: form.name }).eq("company_id", companyId).eq("tenant_name", oldName).eq("property", oldProperty),
  supabase.from("work_orders").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName).eq("property", oldProperty),
  supabase.from("documents").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName).eq("property", oldProperty),
  supabase.from("autopay_schedules").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName).eq("property", oldProperty),
  // ledger_entries is deliberately absent: it is a VIEW over a window
  // function and is not updatable, so this entry always rejected. It sat
  // inside Promise.allSettled, so it failed silently on every rename
  // rather than aborting its siblings. The view derives `tenant` from
  // acct_journal_lines -> acct_accounts and follows on its own.
  editingTenant.id
    ? supabase.from("messages").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant_id", editingTenant.id)
    : supabase.from("messages").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName).eq("property", oldProperty),
  supabase.from("eviction_cases").update({ tenant_name: form.name }).eq("company_id", companyId).eq("tenant_name", oldName).eq("property", oldProperty),
  supabase.from("properties").update({ tenant: form.name }).eq("company_id", companyId).eq("tenant", oldName).eq("address", oldProperty),
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
  const { data: me } = await supabase.from("app_users")
    .select("manager_email").eq("company_id", companyId)
    .ilike("email", emailFilterValue(user?.email || "")).maybeSingle();
  // tenant_id is what makes this request approvable. Filing only the NAME --
  // which is all this used to do, in the `address` column -- left the approver
  // guessing between same-name tenants, and there are five such groups in
  // production. `address` now holds the property, which is what that column
  // means on every other request type.
  const { data: reqTenant } = await supabase.from("tenants").select("property").eq("id", id).eq("company_id", companyId).maybeSingle();
  const { error: reqErr } = await supabase.from("property_change_requests").insert([{
  company_id: companyId, request_type: "delete_tenant", requested_by: user?.email || "unknown",
  tenant_id: id, tenant: name, address: reqTenant?.property || name,
  notes: "Archive tenant: " + name, approver_email: me?.manager_email || null,
  }]);
  if (reqErr) { pmError("PM-3003", { raw: reqErr, context: "file tenant archive request" }); showToast("Could not submit the delete request: " + reqErr.message, "error"); return; }
  showToast("Delete request submitted for admin approval.", "success");
  logAudit("request", "tenants", "Requested delete: " + name, id, user?.email, userRole, companyId);
  if (me?.manager_email) {
    queueNotification("approval_pending", me.manager_email, {
      kind: "delete_tenant", tenant: name, requested_by: user?.email || "unknown",
    }, companyId);
  }
  return;
  }
  // Check for outstanding balance before allowing deletion
  // property comes along so the security-deposit lookup below can scope
  // the lease to this tenant rather than to everyone sharing their name.
  const { data: tenantRow } = await supabase.from("tenants").select("balance, property").eq("id", id).eq("company_id", companyId).maybeSingle();
  if (tenantRow && safeNum(tenantRow.balance) > 0) {
  showToast(`Cannot delete tenant "${name}" with an outstanding balance of $${safeNum(tenantRow.balance).toFixed(2)}. Please settle the balance first.`, "error");
  return;
  }
  if (tenantRow && safeNum(tenantRow.balance) < 0) {
  if (!await showConfirm({ message: `Tenant "${name}" has a credit balance of $${Math.abs(safeNum(tenantRow.balance)).toFixed(2)}. Deleting will forfeit this credit. Continue?` })) return;
  }
  // #16: Check for unreturned security deposit
  const { data: activeLease } = await scopeToTenant(
    supabase.from("leases").select("security_deposit").eq("company_id", companyId).eq("status", "active"),
    { id, name, property: tenantRow?.property }, "tenant_name"
  ).maybeSingle();
  if (activeLease && safeNum(activeLease.security_deposit) > 0) {
  if (isAdmin) {
  if (!await showConfirm({ message: `Tenant "${name}" has an unreturned security deposit of ${formatCurrency(activeLease.security_deposit)}.\n\nDeleting without processing the deposit through the Move-Out Wizard will leave the deposit liability on your books.\n\nProceed anyway?`, variant: "danger", confirmText: "Delete Anyway" })) return;
  } else {
  showToast("Cannot delete \"" + name + "\" — a security deposit of " + formatCurrency(activeLease.security_deposit) + " has not been returned. Please use the Move-Out Wizard first.", "error");
  return;
  }
  }
  if (!await showConfirm({ message: `Delete tenant "${name}"?\n\nThis will hide the tenant and terminate their lease. You can restore within 180 days.`, variant: "danger", confirmText: "Delete" })) return;
  // The archive itself lives in utils/tenantArchive so the approval path in
  // Properties.js runs THIS code rather than a second copy of it.
  const { ok: archived } = await archiveTenant({
  companyId, tenantId: id, name, archivedBy: userProfile?.email, userRole, onToast: showToast,
  });
  if (!archived) return;
  addNotification("\u{1F5D1}\uFE0F", `Tenant deleted: ${name}`);
  fetchTenants();
  } finally { guardRelease("deleteTenant"); }
  }

  async function inviteTenant(tenant) {
  // Per tenant, not shared: inviting one tenant must not block inviting
  // another. Same fault as the team invite in Admin.js.
  const who = tenant.id || tenant.email || "";
  if (!guardSubmit("inviteTenant", who)) return;
  setInvitingTenant(prev => ({ ...prev, [who]: true }));
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
  // Timed out: without this a hung request leaves the button inert until
  // the guard self-clears 30 seconds later, with nothing on screen saying
  // so.
  const inviteResp = await fetch("/api/invite-user", {
    signal: AbortSignal.timeout(30000),
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
  let inviteJson = {};
  try { inviteJson = await inviteResp.json(); } catch (_) {}
  addNotification("✉️", "Invite code generated for " + tenant.email);
  logAudit("create", "tenants", "Invited tenant to portal: " + tenant.email, tenant.id, userProfile?.email, userRole, companyId);
  fetchPortalMembers();
  const maskedCode = code.slice(0, 2) + "****" + code.slice(-2);
  if (inviteJson.already_registered) {
  showToast(tenant.email + " already has an account. They'll see the invite as \"Pending Invites\" on their Company Selector at next login. Give them invite code " + code + " to link to their tenant record.", "success");
  } else {
  showToast("Tenant invite created!\n\nA magic link and invite code have been sent to " + tenant.email + ".\n\nCode hint: " + maskedCode + " (full code in their email)\n\n" + tenant.name + " can sign up by selecting 'I'm a Tenant' and entering the code from their email.", "success");
  }
  } catch (e) {
  showToast("Error inviting tenant: " + e.message, "error");
  }
  } finally {
    guardRelease("inviteTenant", who);
    setInvitingTenant(prev => { const n = { ...prev }; delete n[who]; return n; });
  }
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
      // Same two fixes as addLedgerEntry: the AR leg goes to the
      // tenant's own sub-account (bare 1100 is invisible in
      // ledger_entries), and once it does the balance trigger owns
      // tenants.balance so balanceUpdate must not also run.
      const lfArId = await getOrCreateTenantAR(companyId, t.name, t.id) || await resolveAccountId("1100", companyId);
      if (!lfArId) { showToast("Could not resolve the Accounts Receivable account. Nothing was posted.", "error"); return; }
      let lfArName = "Accounts Receivable", lfArIsPerTenant = false;
      { const { data: lfAcct } = await supabase.from("acct_accounts").select("name, tenant_id").eq("company_id", companyId).eq("id", lfArId).maybeSingle();
        if (lfAcct?.name) lfArName = lfAcct.name;
        lfArIsPerTenant = !!lfAcct?.tenant_id && String(lfAcct.tenant_id) === String(t.id); }
      const lfResolved = await resolveJELineAccounts([
        { account_id: lfArId, account_name: lfArName, debit: feeAmount, credit: 0, class_id: classId, memo: "Late fee: " + t.name },
        { account_id: "4010", account_name: "Late Fee Income", debit: 0, credit: feeAmount, class_id: classId, memo: monthName + " late fee" },
      ], companyId);
      if (!lfResolved.lines) { showToast("Chart of accounts is missing account " + lfResolved.missing + ". Nothing was posted.", "error"); return; }
      const result = await atomicPostJEAndLedger({ companyId,
        date: today,
        description: "Late fee \u2014 " + t.name + " \u2014 " + t.property,
        reference: "LATEFEE-" + t.id + "-" + thisMonth.replace("-", ""),
        property: t.property,
        lines: lfResolved.lines,
        ledgerEntry: { tenant: t.name, tenant_id: t.id, property: t.property, date: today, description: `Late fee \u2014 ${monthName}`, amount: feeAmount, type: "late_fee", balance: 0 },
        balanceUpdate: lfArIsPerTenant ? null : { tenantId: t.id, amount: feeAmount },
      });
      if (!result.jeId) return;
      showToast(`Late fee ${formatCurrency(feeAmount)} applied to ${t.name}.`, "success");
      addNotification("\u26A0\uFE0F", `Late fee ${formatCurrency(feeAmount)} \u2014 ${t.name}`);
      logAudit("create", "late_fees", `Late fee ${formatCurrency(feeAmount)} for ${t.name}`, t.id, userProfile?.email, userRole, companyId);
      fetchTenants();
      // Refetch before reopening the drawer. openLedger() does
      // setSelectedTenant(tenant), so handing it the stale list-row `t`
      // pushed the PRE-fee balance straight back into the drawer's Balance
      // tile — the DB was already right, the tile just kept the old number
      // until the page was re-entered. Same refetch addLedgerEntry does.
      if (selectedTenant?.id === t.id) {
        const { data: freshTenant } = await supabase.from("tenants").select("*").eq("id", t.id).eq("company_id", companyId).maybeSingle();
        openLedger(freshTenant || t);
      }
    } finally { guardRelease("lateFee", t.id); }
  }

  function startEdit(t) {
  setEditingTenant(t);
  setForm({ name: t.name, first_name: t.first_name || parseNameParts(t.name).first_name, mi: t.middle_initial || parseNameParts(t.name).middle_initial, last_name: t.last_name || parseNameParts(t.name).last_name, email: t.email, phone: t.phone, property: t.property, lease_status: t.lease_status, lease_start: t.lease_start || t.move_in || "", lease_end: t.lease_end_date || t.move_out || "", rent: t.rent || "", late_fee_amount: t.late_fee_amount || "", late_fee_type: t.late_fee_type || "flat", is_voucher: t.is_voucher || false, voucher_number: t.voucher_number || "", reexam_date: t.reexam_date || "", case_manager_name: t.case_manager_name || "", case_manager_email: t.case_manager_email || "", case_manager_phone: t.case_manager_phone || "", voucher_portion: t.voucher_portion || "", tenant_portion: t.tenant_portion || "" });
  setShowForm(true);
  // The detail panel is fixed and sits above the page, so the edit form
  // opened underneath it: visible and untouchable. Close the panel, and
  // remember where we came from so saving returns there.
  if (selectedTenant) setEditReturnTo(selectedTenant);
  setSelectedTenant(null);
  setActivePanel(null);
  }

  async function fetchTenantDocs(tenant) {
  const { data } = await scopeToTenant(
    supabase.from("documents").select("*").eq("company_id", companyId).is("archived_at", null),
    tenant
  ).order("uploaded_at", { ascending: false }).limit(50);
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
    // Values only; printTable in utils/theme.js owns the markup, the
    // paddings and the borders, so every printed table in the app shares
    // one density instead of hand-writing padding:6px 10px here.
    const ledgerRows = sorted.map(e => {
      const isCredit = e.type === "payment" || e.type === "credit";
      return {
        date: escapeHtml(e.date || ""),
        desc: escapeHtml(e.description || ""),
        type: escapeHtml(e.type || ""),
        charge: isCredit ? "" : "$" + Math.abs(safeNum(e.amount)).toFixed(2),
        payment: isCredit ? "$" + Math.abs(safeNum(e.amount)).toFixed(2) : "",
        balance: "$" + safeNum(e.balance).toFixed(2),
      };
    });
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
      ${printTable({
        columns: [
          { label: "Date", render: r => fmtDate(r.date) },
          { label: "Description", render: r => r.desc },
          { label: "Type", render: r => r.type },
          { label: "Charges", align: "right", render: r => r.charge },
          { label: "Payments", align: "right", render: r => r.payment },
          { label: "Balance", align: "right", render: r => r.balance },
        ],
        rows: ledgerRows,
        footer: [{ label: "Totals", cells: [
          `<span style="color:${printTheme.danger}">$${totalCharges.toFixed(2)}</span>`,
          `<span style="color:${printTheme.success}">$${totalPayments.toFixed(2)}</span>`,
          `$${safeNum(Math.abs(tenant.balance)).toFixed(2)}`,
        ] }],
      })}
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
  const { data: byName } = await supabase.from("ledger_entries").select("*").eq("company_id", companyId)
    .eq("tenant", tenant.name).eq("property", tenant.property || "")
    .is("tenant_id", null).order("date", { ascending: false }).limit(200);
  // Merge and deduplicate by id, sort by date desc
  const merged = {};
  (byId || []).forEach(e => { merged[e.id] = e; });
  (byName || []).forEach(e => { if (!merged[e.id]) merged[e.id] = e; });
  data = Object.values(merged).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  } else {
  const { data: byName } = await supabase.from("ledger_entries").select("*").eq("company_id", companyId)
    .eq("tenant", tenant.name).eq("property", tenant.property || "")
    .order("date", { ascending: false }).limit(200);
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

  async function deleteStaffMessage(m) {
  if (!m?.id || !selectedTenant) return;
  if (!await showConfirm({ message: "Delete this message? The tenant will no longer see it.", variant: "danger", confirmText: "Delete" })) return;
  const { error } = await supabase.from("messages").delete()
    .eq("id", m.id)
    .eq("company_id", companyId)
    .eq("tenant_id", selectedTenant.id);
  if (error) { pmError("PM-8006", { raw: error, context: "tenants drawer delete message" }); return; }
  logAudit("delete", "messages", "Deleted message " + m.id, m.id, userProfile?.email, userRole, companyId);
  const { data } = await supabase.from("messages").select("*")
    .eq("company_id", companyId)
    .eq("tenant_id", selectedTenant.id)
    .order("created_at", { ascending: true });
  setMessages(data || []);
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
  // The receivable leg has to land on the tenant's OWN AR sub-account
  // (1100-NNN), not the bare 1100 parent. `ledger_entries` is a view
  // over journal lines whose account carries a tenant_id, so a charge
  // posted to the parent is real in the GL but invisible in the
  // tenant's ledger and absent from tenants.balance. This is the same
  // account the payments path and the QuickBooks import use.
  const tenantArId = await getOrCreateTenantAR(companyId, selectedTenant.name, selectedTenant.id);
  // getOrCreateTenantAR falls back to the plain 1100 parent when it
  // can't resolve or create a sub-account. Read the account back so
  // the line carries that account's real name either way ("AR - Name"
  // for a sub-account, "Accounts Receivable" for the parent fallback),
  // and so we know whether the DB balance trigger will fire for it.
  const arAccountId = tenantArId || await resolveAccountId("1100", companyId);
  if (!arAccountId) { showToast("Could not resolve the Accounts Receivable account. Nothing was posted.", "error"); return; }
  let arAccountName = "Accounts Receivable";
  let arIsPerTenant = false;
  {
  const { data: arAcct } = await supabase.from("acct_accounts").select("name, tenant_id").eq("company_id", companyId).eq("id", arAccountId).maybeSingle();
  if (arAcct?.name) arAccountName = arAcct.name;
  arIsPerTenant = !!arAcct?.tenant_id && String(arAcct.tenant_id) === String(selectedTenant.id);
  }
  const ledgerData = { tenant: selectedTenant.name, tenant_id: selectedTenant.id, property: selectedTenant.property, date: today, description: newCharge.description, amount, type: newCharge.type, balance: 0 };
  const balData = { tenantId: selectedTenant.id, amount };
  // JE lines depend on charge type
  let jeLines;
  let jeDesc;
  if (newCharge.type === "charge") {
  jeDesc = "Manual charge \u2014 " + selectedTenant.name + " \u2014 " + newCharge.description;
  jeLines = [
  { account_id: arAccountId, account_name: arAccountName, debit: Math.abs(amount), credit: 0, class_id: classId, memo: selectedTenant.name + ": " + newCharge.description },
  { account_id: "4100", account_name: "Other Income", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
  ];
  } else if (newCharge.type === "late_fee") {
  jeDesc = "Late fee \u2014 " + selectedTenant.name + " \u2014 " + newCharge.description;
  jeLines = [
  { account_id: arAccountId, account_name: arAccountName, debit: Math.abs(amount), credit: 0, class_id: classId, memo: "Late fee: " + selectedTenant.name },
  { account_id: "4010", account_name: "Late Fee Income", debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
  ];
  } else {
  jeDesc = "Manual " + newCharge.type + " \u2014 " + selectedTenant.name + " \u2014 " + newCharge.description;
  jeLines = [
  { account_id: "1000", account_name: "Checking Account", debit: Math.abs(amount), credit: 0, class_id: classId, memo: selectedTenant.name + ": " + newCharge.description },
  // Same rule as the charge branch: the receivable leg has to relieve
  // the tenant's OWN AR sub-account. Credited to the bare 1100 parent
  // the payment was real in the GL but invisible in ledger_entries
  // (the view only surfaces lines on accounts carrying a tenant_id),
  // so a tenant who paid still showed the full balance on their ledger.
  { account_id: arAccountId, account_name: arAccountName, debit: 0, credit: Math.abs(amount), class_id: classId, memo: newCharge.description },
  ];
  }
  // When the receivable leg lands on the per-tenant AR sub-account the
  // sync_tenant_balance_lines trigger recomputes tenants.balance from
  // the GL on line insert. Passing balanceUpdate as well would apply
  // the amount a second time (see 20260430000003_post_je_drop_manual_
  // balance.sql — same double-count that drifted 14 tenants).
  //
  // Every branch now posts its receivable leg to the per-tenant AR
  // sub-account, so the gate is simply "did the AR leg land on a
  // per-tenant account". It is NOT specific to charges. A payment is
  // the mirror image of the same hazard, not an exception to it: its
  // AR leg is a CREDIT, so double-applying would drive the balance
  // DOWN by twice what the tenant actually paid. The manual update
  // survives only for the degraded case where getOrCreateTenantAR fell
  // back to the bare 1100 parent — no tenant_id, so the trigger never
  // fires and nothing else would move the balance.
  const arLegIsPerTenant = arIsPerTenant;
  // Unified: JE first → ledger → balance (all gated on JE success)
  const resolved = await resolveJELineAccounts(jeLines, companyId);
  if (!resolved.lines) { showToast("Chart of accounts is missing account " + resolved.missing + ". Nothing was posted.", "error"); return; }
  const result = await atomicPostJEAndLedger({ companyId,
  date: today, description: jeDesc, reference: "MANUAL-" + shortId(), property: selectedTenant.property || "",
  lines: resolved.lines,
  ledgerEntry: ledgerData,
  balanceUpdate: arLegIsPerTenant ? null : balData,
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
  const { error } = await supabase.from("tenants").update({ move_out: newMoveOut, lease_end_date: newMoveOut, lease_status: "current" }).eq("company_id", companyId).eq("id", selectedTenant.id);
  if (error) { pmError("PM-3004", { raw: error, context: "renew lease" }); return; }
  // #4: Update active lease end_date if one exists, or create one
  // Scoped to this tenant, not to their name. Matching on tenant_name
  // alone picked whichever active lease came first among namesakes, and
  // the update below then wrote the new end_date onto that lease --
  // extending a different person's tenancy. tenant_id is authoritative;
  // (name, property) is the fallback for rows predating the backfill and
  // is unique among active tenants (idx_tenants_unique_name_property).
  let activeLeaseQ = supabase.from("leases").select("id, rent_amount").eq("company_id", companyId).eq("status", "active");
  activeLeaseQ = selectedTenant.id
    ? activeLeaseQ.or(`tenant_id.eq.${selectedTenant.id},and(tenant_name.eq.${pgrestQuote(selectedTenant.name)},property.eq.${pgrestQuote(selectedTenant.property || "")})`)
    : activeLeaseQ.eq("tenant_name", selectedTenant.name).eq("property", selectedTenant.property || "");
  const { data: activeLease, error: leaseErr } = await activeLeaseQ.limit(1);
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
  // Same hazard, worse consequence: an unscoped name match set end_date
  // on EVERY autopay row carrying that name, silently ending a namesake's
  // rent collection.
  let apSyncQ = supabase.from("autopay_schedules").update({ end_date: newMoveOut }).eq("company_id", companyId);
  apSyncQ = selectedTenant.id
    ? apSyncQ.or(`tenant_id.eq.${selectedTenant.id},and(tenant.eq.${pgrestQuote(selectedTenant.name)},property.eq.${pgrestQuote(selectedTenant.property || "")})`)
    : apSyncQ.eq("tenant", selectedTenant.name).eq("property", selectedTenant.property || "");
  const { error: apSyncErr } = await apSyncQ;
  if (apSyncErr) pmError("PM-3004", { raw: apSyncErr, context: "sync autopay end_date on renew", silent: true });
  addNotification("\u{1F4C4}", `Lease extended for ${selectedTenant.name} until ${newMoveOut}`);
  logAudit("update", "tenants", `Lease renewed for ${selectedTenant.name} until ${newMoveOut}`, selectedTenant.id, userProfile?.email, userRole, companyId);
  setLeaseModal(null);
  fetchTenants();
  setSelectedTenant({ ...selectedTenant, move_out: newMoveOut, lease_status: "current" });
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
  // Unscoped, this flipped a namesake's active lease to "notice" too.
  let noticeQ = supabase.from("leases").update({ status: "notice" }).eq("company_id", companyId).eq("status", "active");
  noticeQ = selectedTenant.id
    ? noticeQ.or(`tenant_id.eq.${selectedTenant.id},and(tenant_name.eq.${pgrestQuote(selectedTenant.name)},property.eq.${pgrestQuote(selectedTenant.property || "")})`)
    : noticeQ.eq("tenant_name", selectedTenant.name).eq("property", selectedTenant.property || "");
  const { error: leaseErr } = await noticeQ;
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
  <p style="text-align:center;color:${printTheme.inkMuted};">Generated on ${fmtDate(new Date())}</p>
  <h2>Parties</h2>
  <div class="field"><strong>Tenant:</strong> ${escapeHtml(tenant.name)}</div>
  <div class="field"><strong>Email:</strong> ${escapeHtml(tenant.email)}</div>
  <div class="field"><strong>Property:</strong> ${escapeHtml(tenant.property)}</div>
  <h2>Lease Terms</h2>
  <div class="field"><strong>Monthly Rent:</strong> $${escapeHtml(String(tenant.rent))}/month</div>
  <div class="field"><strong>Move-In Date:</strong> ${escapeHtml(fmtDate(tenant.move_in, "\u2014"))}</div>
  <div class="field"><strong>Move-Out Date:</strong> ${escapeHtml(fmtDate(tenant.move_out, "\u2014"))}</div>
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
  <div id="signed-badge" class="signed-badge" style="text-align:center;margin-top:20px;">✅ SIGNED — ${fmtDate(new Date())}</div>
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


  // ---- what the tenant PAGE calls --------------------------------------
  //
  // These four were inline arrow functions buried in a 400-line drawer.
  // Naming them is what let the markup leave this file for TenantPage.js:
  // the writes stay here, beside the data, the guards and the toasts.

  // Only a current tenant has a lease to close. This used to navigate
  // regardless, so a past tenant landed on the Move-Out wizard, met an error
  // there, and had lost the panel they were working in. Say it where the
  // click happened and stay put.
  async function pageMoveOut(t) {
    const st = String(t?.lease_status || "").toLowerCase();
    if (st !== "current" && st !== "active") {
      await showConfirm({
        message: `${t?.name} is marked "${st || "unknown"}", so there is no active lease to close.\n\nMove-Out applies to a current tenant. If they are still in the property, set them to Current first — Edit tenant, or the Review tab.`,
        title: "No active lease to close",
        confirmText: "Got it", cancelText: "Close", variant: "notice",
      });
      return;
    }
    setPage("moveout");
  }

  async function pageSetDocType(d, nextType) {
    const prevType = d.type;
    const { error } = await supabase.from("documents").update({ type: nextType }).eq("id", d.id).eq("company_id", companyId);
    if (error) { pmError("PM-7004", { raw: error, context: "reclassify document" }); return; }
    if (selectedTenant?.name) await recomputeTenantDocStatus(companyId, { tenantId: selectedTenant.id, tenantName: selectedTenant.name, property: selectedTenant.property });
    showToast(`Classified as ${docTypeLabel(nextType)}`, "success");
    logAudit("update", "documents", `Reclassified document "${d.name}" from ${prevType || "(none)"} to ${nextType}`, d.id, userProfile?.email, userRole, companyId);
    await fetchTenantDocs(selectedTenant);
    fetchTenants();
  }

  async function pageViewDoc(d) {
    const url = await getSignedUrl("documents", d.file_name || d.url);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  // Admin/owner only. Waiving is per-requirement: the other required docs
  // stay required, which is why the label is stored rather than a flag.
  async function pageWaive(t, label) {
    if (!guardSubmit("waive_" + label)) return;
    try {
      if (!await showConfirm({ message: `Waive "${label}" for ${t.name}? Other required docs stay required.` })) return;
      const current = (() => {
        const v = t.approved_doc_exceptions;
        if (Array.isArray(v)) return v;
        if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
        return [];
      })();
      const next = Array.from(new Set([...current, label]));
      const { error } = await supabase.from("tenants").update({ approved_doc_exceptions: next }).eq("company_id", companyId).eq("id", t.id);
      if (error) { pmError("PM-7004", { raw: error, context: "waive required document" }); return; }
      // A request already in the queue for this doc is now answered.
      const pendingReq = (docExceptions || []).find(r => r.status === "pending" && r.tenant_name === t.name && r.doc_type === label);
      if (pendingReq) {
        await supabase.from("doc_exception_requests")
          .update({ status: "approved", reviewed_by: userProfile?.email, reviewed_at: new Date().toISOString() })
          .eq("id", pendingReq.id);
        if (pendingReq.requested_by) addNotification("✅", `Your doc exception for ${t.name} (${label}) was approved.`, { recipient: pendingReq.requested_by, type: "doc_exception" });
      }
      if (t.email) addNotification("📄", `${label} requirement was waived on your account.`, { recipient: t.email, type: "doc_exception" });
      logAudit("approve", "tenants", "Doc exception (" + label + ") approved for " + t.name, t.id, userProfile?.email, userRole, companyId);
      showToast(`"${label}" waived for ${t.name}`, "success");
      setSelectedTenant({ ...t, approved_doc_exceptions: next });
      fetchTenants();
      fetchDocExceptions();
    } finally { guardRelease("waive_" + label); }
  }

  // Everyone else asks. The reviewer is the requester's assigned manager,
  // falling back to the first active admin, so the request lands in an inbox
  // rather than waiting to be discovered in Tasks & Approvals.
  async function pageRequestException(t, label) {
    if (!guardSubmit("reqExc_" + label)) return;
    try {
      if (!await showConfirm({ message: `Request an exception for "${label}" for ${t.name}? A manager will review.` })) return;
      const { data: me } = await supabase.from("app_users").select("manager_email").eq("company_id", companyId).ilike("email", emailFilterValue(userProfile?.email || "")).maybeSingle();
      let reviewerEmail = me?.manager_email || null;
      if (!reviewerEmail) {
        const { data: adm } = await supabase.from("company_members")
          .select("user_email").eq("company_id", companyId).eq("role", "admin").eq("status", "active")
          .limit(1).maybeSingle();
        reviewerEmail = adm?.user_email || null;
      }
      const { error } = await supabase.from("doc_exception_requests").insert([{ company_id: companyId, tenant_name: t.name, property: t.property, requested_by: userProfile?.email || "", approver_email: reviewerEmail, doc_type: label }]);
      if (error) { pmError("PM-7004", { raw: error, context: "request doc exception" }); return; }
      if (reviewerEmail) {
        addNotification("📋", `${userProfile?.email || "Staff"} requested a doc exception for ${t.name}: ${label}`, { recipient: reviewerEmail, type: "doc_exception" });
        queueNotification("approval_pending", reviewerEmail, {
          kind: "doc_exception", tenant: t.name, property: t.property,
          doc_type: label, requested_by: userProfile?.email || "",
        }, companyId);
      }
      addNotification("📤", `Exception request sent for ${t.name}: ${label}`, { type: "doc_exception" });
      logAudit("request", "tenants", "Doc exception requested (" + label + ") for " + t.name, t.id, userProfile?.email, userRole, companyId);
      showToast("Request submitted", "success");
      fetchDocExceptions();
    } finally { guardRelease("reqExc_" + label); }
  }

  // The renew/lease drawer still opens OVER the page, so it renders in both
  // branches from one definition rather than being copied into each.
  function renderLeasePanel() {
    return (<>
  {activePanel && selectedTenant && activePanel === "lease" && (
  <div className="fixed inset-0 bg-black/40 z-50 flex justify-end safe-y safe-x">
  <div className="bg-white w-full max-w-lg h-full flex flex-col shadow-pop">
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

  {/* LEASE */}
  {activePanel === "lease" && (
  <div className="flex-1 overflow-y-auto p-4">
  <div className="bg-white border border-brand-50 rounded-xl p-4 mb-4">
  <h4 className="font-semibold text-neutral-700 mb-3">Lease Details</h4>
  <div className="space-y-2 text-sm">
  {[
  ["Tenant", selectedTenant.name],
  ["Property", selectedTenant.property],
  ["Monthly Rent", selectedTenant.rent ? `${formatCurrency(selectedTenant.rent)}/mo` : "\u2014"],
  ["Move-In Date", fmtDate(selectedTenant.move_in, "\u2014")],
  ["Move-Out Date", fmtDate(selectedTenant.move_out, "\u2014")],
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
  <div className="bg-brand-50 rounded-xl p-4 mb-3 border border-brand-100">
  <div className="text-sm font-semibold text-brand-700 mb-2">Enter New Lease End Date</div>
  <Input type="date" value={leaseInput} onChange={e => setLeaseInput(e.target.value)} className="mb-2" />
  <div className="flex gap-2">
  <Btn variant="primary" size="sm" onClick={() => renewLease(leaseInput)}>Confirm Renewal</Btn>
  <Btn variant="ghost" size="sm" onClick={() => setLeaseModal(null)}>Cancel</Btn>
  </div>
  </div>
  )}
  {leaseModal === "notice" && (
  <div className="bg-notice-50 rounded-xl p-4 mb-3 border border-notice-100">
  <div className="text-sm font-semibold text-notice-700 mb-2">Select Notice Period</div>
  <div className="flex gap-2 mb-2">
  <FilterPill tone="notice" active={leaseInput === "30"} onClick={() => setLeaseInput("30")} className="flex-1 py-2 text-sm">30 Days</FilterPill>
  <FilterPill tone="notice" active={leaseInput === "60"} onClick={() => setLeaseInput("60")} className="flex-1 py-2 text-sm">60 Days</FilterPill>
  </div>
  <div className="flex gap-2">
  <Btn variant="warning-fill" size="sm" onClick={() => generateMoveOutNotice(leaseInput)}>Generate Notice</Btn>
  <Btn variant="ghost" size="sm" onClick={() => setLeaseModal(null)}>Cancel</Btn>
  </div>
  </div>
  )}
  <div className="space-y-2">
  <button onClick={() => openLeaseForSigning(selectedTenant)} className="w-full flex items-center justify-between bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg px-4 py-3 text-left">
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
  <button key={item.label} onClick={() => { setLeaseModal(item.modal); setLeaseInput(""); }} className="w-full flex items-center justify-between bg-brand-50/30 hover:bg-brand-50 border border-brand-50 hover:border-brand-200 rounded-lg px-4 py-3 text-left">
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
    </>);
  }

  // ---- the detail is a PAGE, not a drawer over the list -----------------
  // Everything a tenant record holds fits on one screen; five tabs each
  // hiding the other four did not make it smaller, only harder to read.
  if (selectedTenant && activePanel) {
    return (<>
      {renderLeasePanel()}
      <TenantPage
        tenant={selectedTenant} ledger={ledger} docs={tenantDocs}
        docExceptions={docExceptions} userRole={userRole}
        onBack={closePanel}
        onOpenProperty={t => setPage("properties", { openProperty: t.property })}
        onEdit={startEdit}
        onMessage={openMessages}
        onInvite={inviteTenant}
        onRenew={() => { setLeaseModal("renew"); setLeaseInput(""); setActivePanel("lease"); }}
        onMoveOut={pageMoveOut}
        onArchive={t => deleteTenant(t.id, t.name)}
        onAddEntry={() => setShowAddTxn(true)}
        onSetRent={startEdit}
        onExportPdf={exportLedgerPDF}
        onApplyLateFee={() => setPage("latefees")}
        onPrepareFiling={() => setPage("evictions")}
        onUploadDoc={t => setShowDocUpload({ property: t.property || "", tenant: t.name || "" })}
        onViewDoc={pageViewDoc}
        onSetDocType={pageSetDocType}
        onWaiveDoc={pageWaive}
        onRequestException={pageRequestException}
        ledgerShowAll={ledgerShowAll}
        onToggleLedgerAll={() => setLedgerShowAll(v => !v)}
        lateFeeAction={safeNum(selectedTenant?.balance) > 0 && safeNum(selectedTenant?.late_fee_amount) > 0
          ? <Btn variant="danger" size="sm" className="w-full" onClick={() => applyLateFeeForTenant(selectedTenant)} icon="gavel">Apply Late Fee ({selectedTenant.late_fee_type === "percent" ? selectedTenant.late_fee_amount + "%" : formatCurrency(selectedTenant.late_fee_amount)})</Btn>
          : null}
        addEntryForm={showAddTxn ? (
          <div className="bg-brand-50/30 rounded-xl p-3">
            <div className="text-xs font-semibold text-neutral-500 mb-2">Add Transaction</div>
            <div className="grid grid-cols-3 gap-2">
              <Select value={newCharge.type} onChange={e => setNewCharge({ ...newCharge, type: e.target.value })} aria-label="Transaction type">
                <option value="charge">Charge</option>
                <option value="payment">Payment</option>
                <option value="credit">Credit</option>
                <option value="late_fee">Late Fee</option>
              </Select>
              <Input placeholder="e.g. Rent, Late fee, Repair" value={newCharge.description} title="Description" onChange={e => setNewCharge({ ...newCharge, description: e.target.value })} className="text-xs" />
              <Input placeholder="0.00" value={newCharge.amount} title="Amount ($)" onChange={e => setNewCharge({ ...newCharge, amount: e.target.value })} className="text-xs" />
            </div>
            <div className="flex gap-2 mt-2">
              <Btn size="sm" className="flex-1" onClick={addLedgerEntry}>Add Transaction</Btn>
              <Btn size="sm" variant="slate" onClick={() => setShowAddTxn(false)}>Cancel</Btn>
            </div>
          </div>
        ) : null}
        messagesPanel={<>
          <MessageThread messages={messages} viewerRole={userRole || "admin"} viewerName={userProfile?.name || "You"}
            tenantName={selectedTenant?.name} onDelete={deleteStaffMessage} emptyLabel="No messages yet" />
          <MessageComposer value={newMessage} onChange={setNewMessage} onSend={sendMessage} sending={sendingMsg}
            attachment={msgAttachment} onAttachmentChange={setMsgAttachment} showToast={showToast}
            placeholder={"Message " + selectedTenant.name + "…"} />
        </>}
      />
    </>);
  }


  return (
  <div>

  {/* Tab Navigation */}
  <div className="flex flex-col md:flex-row md:items-center gap-2 mb-4 border-b border-brand-50 pb-3">
  <h2 className="text-xl md:text-2xl font-bold text-subtle-800">Tenants</h2>
  <div className="flex gap-1 overflow-x-auto pb-1">
  {[["tenants", "Tenants"], ["review", reviewTenants.length ? `Review (${reviewTenants.length})` : "Review"], ["leases", "Leases"], ["moveout", "Move-Out"], ["evictions", "Evictions"], ["archived", "Archived"]].map(([id, label]) => (
  <FilterPill key={id} active={tenantTab === id} onClick={() => { setTenantTab(id); setTenantSearch(""); if (id === "archived") { supabase.from("tenants").select("*").eq("company_id", companyId).not("archived_at", "is", null).order("archived_at", { ascending: false }).limit(200).then(({ data }) => setArchivedTenants(data || [])); } }}>{label}</FilterPill>
  ))}
  </div>
  </div>

  {/* ---- Review ------------------------------------------------------
      A bulk import can tell that a tenant needs a decision but not what
      the decision is. Those land here as a question with the three
      answers, instead of being written silently as current or past --
      or, as before, not written at all. */}
  {tenantTab === "review" && (
  <div className="space-y-3">
    <div className="text-sm text-neutral-600">
      {reviewTenants.length === 0
        ? "Nothing to review. Tenants a bulk import could not classify appear here."
        : <>These {reviewTenants.length} tenant{reviewTenants.length === 1 ? " was" : "s were"} imported without a clear status. Pick one for each — the property's occupancy follows from it.</>}
    </div>
    {reviewTenants.map(t => (
      <div key={t.id} className="bg-white rounded-xl border border-brand-50 p-4 flex flex-col md:flex-row md:items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-neutral-800 truncate">{t.name}</div>
          <div className="text-xs text-neutral-500 truncate">
            {t.property || "no property"}
            {t.lease_end_date ? ` · lease ended ${fmtDate(t.lease_end_date)}` : ""}
            {safeNum(t.balance) ? ` · balance ${formatCurrency(t.balance)}` : ""}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn size="sm" variant="success" disabled={reviewBusy === t.id}
               onClick={() => resolveReview(t, "current")}>Current tenant</Btn>
          <Btn size="sm" variant="secondary" disabled={reviewBusy === t.id}
               onClick={() => resolveReview(t, "past")}>Past tenant</Btn>
          <Btn size="sm" variant="danger" disabled={reviewBusy === t.id}
               onClick={() => resolveReview(t, "not_a_tenant")}>Not a tenant</Btn>
        </div>
      </div>
    ))}
  </div>
  )}

  {tenantTab === "leases" && <LeaseManagement addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} showToast={showToast} showConfirm={showConfirm} />}
  {tenantTab === "archived" && !archivedDetail && (
  <div>
  {archivedTenants.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-neutral-200"><div className="text-subtle-400">No archived tenants</div><TextLink tone="brand" size="xs" underline={false} onClick={async () => { if (!guardSubmit("refreshArchived")) return; try { const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId).not("archived_at", "is", null).order("archived_at", { ascending: false }).limit(200); setArchivedTenants(data || []); } finally { guardRelease("refreshArchived"); } }} className="mt-2 hover:underline">Refresh</TextLink></div>
  ) : archivedTenants.map(t => (
  <div key={t.id} className="bg-white rounded-xl border border-neutral-200 p-4 flex items-center gap-4 mb-2 cursor-pointer hover:border-brand-300 hover:shadow-card transition-all" onClick={async () => {
    // Fan-out fetch for the full tenant history so the detail panel
    // renders in one shot. Scope each query by tenant_id where the
    // table has it, falling back to escaped name ilike otherwise —
    // ledger_entries / documents / messages didn't uniformly backfill
    // tenant_id on old rows, so an id-only filter would silently
    // drop history for long-tenured archives.
    const tSafe = escapeFilterValue(t.name || "");
    const [ledger, docs, msgs, leases, pays, wos] = await Promise.all([
      t.id
        ? supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant_id", t.id).order("date", { ascending: false }).limit(500)
        : supabase.from("ledger_entries").select("*").eq("company_id", companyId).ilike("tenant", tSafe).order("date", { ascending: false }).limit(500),
      scopeToTenant(supabase.from("documents").select("*").eq("company_id", companyId), t)
        .order("uploaded_at", { ascending: false }).limit(200),
      t.id
        ? supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant_id", t.id).order("created_at", { ascending: true }).limit(500)
        : supabase.from("messages").select("*").eq("company_id", companyId).ilike("tenant", tSafe).order("created_at", { ascending: true }).limit(500),
      supabase.from("leases").select("*").eq("company_id", companyId).eq("tenant_id", t.id).order("start_date", { ascending: false }),
      scopeToTenant(supabase.from("payments").select("*").eq("company_id", companyId), t)
        .order("date", { ascending: false }).limit(200),
      scopeToTenant(supabase.from("work_orders").select("*").eq("company_id", companyId), t)
        .order("created_at", { ascending: false }).limit(100),
    ]);
    setArchivedDetail({
      tenant: t,
      ledger: ledger.data || [],
      docs: docs.data || [],
      messages: msgs.data || [],
      leases: leases.data || [],
      payments: pays.data || [],
      workOrders: wos.data || [],
      activeTab: "overview",
    });
  }}>
  <div className="flex-1">
  <div className="font-semibold text-subtle-700 text-sm">{t.name}</div>
  <div className="text-xs text-subtle-400">{t.property} · Archived {fmtDate(t.archived_at)}{t.archived_by ? " by " + t.archived_by : ""}</div>
  </div>
  <Btn variant="success" size="sm" onClick={async (e) => { e.stopPropagation(); if (!guardSubmit("restoreTenant", t.id)) return; try { await supabase.from("tenants").update({ archived_at: null, archived_by: null, lease_status: "current" }).eq("id", t.id).eq("company_id", companyId); addNotification("\u267B\uFE0F", "Restored: " + t.name); const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId).not("archived_at", "is", null).limit(200); setArchivedTenants(data || []); fetchTenants(); } finally { guardRelease("restoreTenant", t.id); } }}>♻️ Restore</Btn>
  </div>
  ))}
  </div>
  )}

  {/* Archived Tenant Detail Drawer — full history from an otherwise
      unreachable record. Every data slice is read-only: the tenant is
      archived, so nothing here emits writes beyond the Restore button
      in the header. */}
  {tenantTab === "archived" && archivedDetail && (
  <div className="bg-white rounded-xl border border-neutral-200 p-6">
  <TextLink tone="brand" size="xs" onClick={() => setArchivedDetail(null)} className="mb-3 flex items-center gap-1"><span className="material-icons-outlined text-sm">arrow_back</span>Back to Archived List</TextLink>
  <div className="flex items-center gap-3 mb-4">
  <div className="w-12 h-12 rounded-full bg-neutral-200 flex items-center justify-center text-neutral-500 font-bold text-lg">{(archivedDetail.tenant.name?.[0] || "?").toUpperCase()}</div>
  <div className="flex-1">
  <div className="font-bold text-neutral-800 text-lg">{archivedDetail.tenant.name}</div>
  <div className="text-xs text-neutral-400">{archivedDetail.tenant.email || ""}{archivedDetail.tenant.phone ? " · " + archivedDetail.tenant.phone : ""}</div>
  <div className="text-xs text-neutral-400">{archivedDetail.tenant.property}</div>
  </div>
  <Btn variant="success" size="sm" onClick={async () => { if (!guardSubmit("restoreTenant", archivedDetail.tenant.id)) return; try { await supabase.from("tenants").update({ archived_at: null, archived_by: null, lease_status: "current" }).eq("id", archivedDetail.tenant.id).eq("company_id", companyId); addNotification("\u267B\uFE0F", "Restored: " + archivedDetail.tenant.name); const { data } = await supabase.from("tenants").select("*").eq("company_id", companyId).not("archived_at", "is", null).limit(200); setArchivedTenants(data || []); setArchivedDetail(null); fetchTenants(); } finally { guardRelease("restoreTenant", archivedDetail.tenant.id); } }}>♻️ Restore</Btn>
  </div>
  <div className="flex border-b border-neutral-200 mb-4 overflow-x-auto">
  {[
    ["overview", "Overview"],
    ["ledger", `Ledger (${archivedDetail.ledger.length})`],
    ["payments", `Payments (${archivedDetail.payments.length})`],
    ["docs", `Documents (${archivedDetail.docs.length})`],
    ["messages", `Messages (${archivedDetail.messages.length})`],
    ["workorders", `Work Orders (${archivedDetail.workOrders.length})`],
  ].map(([id, label]) => (
  <button key={id} onClick={() => setArchivedDetail(prev => ({ ...prev, activeTab: id }))} className={"px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap " + (archivedDetail.activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-500")}>{label}</button>
  ))}
  </div>

  {archivedDetail.activeTab === "overview" && (
  <div className="space-y-4">
  {archivedDetail.leases.length > 0 && (
  <div>
  <div className="text-xs font-semibold text-neutral-400 uppercase mb-2">Lease History</div>
  {archivedDetail.leases.map((l, i) => (
  <div key={l.id || i} className="bg-neutral-50 rounded-lg p-3 mb-2">
  <div className="grid grid-cols-2 gap-2 text-xs">
  <div><span className="text-neutral-400 block">Period</span><span className="font-medium text-neutral-700">{fmtDate(l.start_date, "—")} → {fmtDate(l.end_date, "—")}</span></div>
  <div><span className="text-neutral-400 block">Status</span><span className="font-medium text-neutral-700 capitalize">{l.status}</span></div>
  <div><span className="text-neutral-400 block">Rent</span><span className="font-medium text-neutral-700">{l.rent_amount ? formatCurrency(l.rent_amount) : "—"}</span></div>
  <div><span className="text-neutral-400 block">Security Deposit</span><span className="font-medium text-neutral-700">{l.security_deposit ? formatCurrency(l.security_deposit) : "—"}{l.deposit_status ? " · " + l.deposit_status : ""}</span></div>
  {safeNum(l.deposit_returned) > 0 && <div><span className="text-neutral-400 block">Deposit Returned</span><span className="font-medium text-positive-600">{formatCurrency(l.deposit_returned)}</span></div>}
  {l.deposit_deductions && <div className="col-span-2"><span className="text-neutral-400 block">Deductions</span><span className="font-medium text-neutral-700">{l.deposit_deductions}</span></div>}
  </div>
  </div>
  ))}
  </div>
  )}
  <div className="grid grid-cols-2 gap-3 text-xs">
  <div><span className="text-neutral-400 block">Final Balance</span><span className={"font-semibold " + (safeNum(archivedDetail.tenant.balance) > 0 ? "text-danger-500" : "text-positive-600")}>{archivedDetail.tenant.balance != null ? formatCurrency(Math.abs(safeNum(archivedDetail.tenant.balance))) + (safeNum(archivedDetail.tenant.balance) > 0 ? " owed" : " settled") : "—"}</span></div>
  <div><span className="text-neutral-400 block">Move Out</span><span className="font-medium text-neutral-700">{fmtDate(archivedDetail.tenant.move_out, "—")}</span></div>
  <div><span className="text-neutral-400 block">Archived</span><span className="font-medium text-neutral-700">{fmtDate(archivedDetail.tenant.archived_at, "—")}</span></div>
  <div><span className="text-neutral-400 block">Archived By</span><span className="font-medium text-neutral-700">{archivedDetail.tenant.archived_by || "—"}</span></div>
  </div>
  </div>
  )}

  {archivedDetail.activeTab === "ledger" && (
  <div>{archivedDetail.ledger.length === 0 ? <EmptyState size="inline" title={"No transaction history"} /> : (
  <div className="space-y-1">
  {archivedDetail.ledger.map((e, i) => (
  <div key={e.id || i} className="flex items-center justify-between py-2.5 border-b border-neutral-100 text-sm">
  <div>
  <div className="font-medium text-neutral-700">{e.description}</div>
  <div className="text-xs text-neutral-400">{fmtDate(e.date)}{e.type ? " · " + e.type : ""}</div>
  </div>
  <div className="text-right">
  <div className={"font-semibold tnum " + (safeNum(e.amount) < 0 ? "text-positive-600" : "text-danger-500")}>{safeNum(e.amount) < 0 ? "+" : "-"}{formatCurrency(Math.abs(safeNum(e.amount)))}</div>
  {e.balance != null && <div className="text-xs text-neutral-400">Bal: {formatCurrency(e.balance)}</div>}
  </div>
  </div>
  ))}
  </div>
  )}</div>
  )}

  {archivedDetail.activeTab === "payments" && (
  <div>{archivedDetail.payments.length === 0 ? <EmptyState size="inline" title={"No payments on file"} /> : (
  <div className="space-y-1">
  {archivedDetail.payments.map(p => (
  <div key={p.id} className="flex items-center justify-between py-2.5 border-b border-neutral-100 text-sm">
  <div>
  <div className="font-medium text-neutral-700">{p.method || p.type || "Payment"}</div>
  <div className="text-xs text-neutral-400">{fmtDate(p.date)}{p.status ? " · " + p.status : ""}</div>
  </div>
  <div className="text-right font-semibold tnum text-positive-600">{formatCurrency(p.amount)}</div>
  </div>
  ))}
  </div>
  )}</div>
  )}

  {archivedDetail.activeTab === "docs" && (
  <div>{archivedDetail.docs.length === 0 ? <EmptyState size="inline" title={"No documents"} /> : (
  <div className="space-y-2">
  {archivedDetail.docs.map(d => (
  <div key={d.id} className="flex items-center justify-between bg-neutral-50 rounded-lg px-4 py-3 hover:bg-neutral-100 transition-colors">
  <div className="flex items-center gap-3">
  <span className="material-icons-outlined text-neutral-400 text-lg">{d.type === "Lease" ? "description" : d.type === "ID" ? "badge" : d.type === "Insurance" ? "verified_user" : "insert_drive_file"}</span>
  <div>
  <div className="text-sm font-medium text-neutral-700">{d.name}</div>
  <div className="text-xs text-neutral-400">{d.type || "Document"}{d.uploaded_at ? " · " + fmtDate(d.uploaded_at) : ""}</div>
  </div>
  </div>
  <TextLink tone="brand" size="xs" onClick={async () => { const url = await getSignedUrl("documents", d.file_name || d.url); if (url) window.open(url, "_blank", "noopener,noreferrer"); }} className="flex items-center gap-1"><span className="material-icons-outlined text-sm">open_in_new</span>View</TextLink>
  </div>
  ))}
  </div>
  )}</div>
  )}

  {archivedDetail.activeTab === "messages" && (
  <div>{archivedDetail.messages.length === 0 ? <EmptyState size="inline" title={"No messages"} /> : (
  <div className="space-y-2 max-h-96 overflow-y-auto">
  {archivedDetail.messages.map((m) => {
    const role = m.sender_role || (m.sender === "admin" ? "admin" : "tenant");
    const fromStaff = role !== "tenant";
    return (
    <div key={m.id} className={"rounded-xl px-3 py-2 max-w-[85%] text-sm " + (fromStaff ? "bg-brand-50 text-brand-800 ml-auto" : "bg-neutral-100 text-neutral-700")}>
    <div>{m.message}</div>
    {m.attachment_name && <div className="text-xs text-neutral-500 italic mt-1">📎 {m.attachment_name}</div>}
    <div className="text-xs text-neutral-400 mt-1">{m.sender || role}{m.created_at ? " · " + fmtDateTime(m.created_at) : ""}</div>
    </div>
    );
  })}
  </div>
  )}</div>
  )}

  {archivedDetail.activeTab === "workorders" && (
  <div>{archivedDetail.workOrders.length === 0 ? <EmptyState size="inline" title={"No maintenance history"} /> : (
  <div className="space-y-2">
  {archivedDetail.workOrders.map(w => (
  <div key={w.id} className="bg-neutral-50 rounded-lg px-4 py-3">
  <div className="flex items-center justify-between">
  <div className="text-sm font-medium text-neutral-700">{w.issue || "Work order"}</div>
  <span className="text-xs bg-neutral-200 text-neutral-600 px-2 py-0.5 rounded-full capitalize">{w.status || "—"}</span>
  </div>
  <div className="text-xs text-neutral-400 mt-1">{fmtDate(w.created)}{w.priority ? " · " + w.priority : ""}{w.vendor_name ? " · " + w.vendor_name : ""}</div>
  {w.notes && <div className="text-xs text-neutral-500 mt-2">{w.notes}</div>}
  </div>
  ))}
  </div>
  )}</div>
  )}
  </div>
  )}
  {tenantTab === "moveout" && <MoveOutWizard addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} setPage={setPage} showToast={showToast} showConfirm={showConfirm} />}
  {tenantTab === "evictions" && <EvictionWorkflow addNotification={addNotification} userProfile={userProfile} userRole={userRole} companyId={companyId} showToast={showToast} showConfirm={showConfirm} />}

  {tenantTab === "tenants" && (<>
  {/* Required Documents Prompt */}
  {showTenantDocPrompt && (
  <div className="bg-warn-50 border border-warn-200 rounded-xl p-3 mb-4">
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
  {(isAdmin || userRole === "owner") ? (
  <Btn variant="ghost" size="sm" onClick={async () => { if (!guardSubmit("approveException")) return; try { await supabase.from("tenants").update({ doc_status: "exception_approved" }).eq("company_id", companyId).ilike("name", escapeFilterValue(showTenantDocPrompt)).is("archived_at", null); showToast("Document exception approved for " + showTenantDocPrompt, "success"); setShowTenantDocPrompt(null); fetchTenants(); } finally { guardRelease("approveException"); } }} >Admin: Approve Exception</Btn>
  ) : (
  <Btn variant="ghost" size="sm" onClick={async () => { if (!guardSubmit("reqException")) return; try { if (!await showConfirm({ message: "Skipping requires admin approval. An approval request will be sent. Continue?" })) return; const { data: me } = await supabase.from("app_users").select("manager_email").eq("company_id", companyId).ilike("email", emailFilterValue(userProfile?.email || "")).maybeSingle(); await supabase.from("doc_exception_requests").insert([{ company_id: companyId, tenant_name: showTenantDocPrompt, property: selectedTenant?.property || "", requested_by: userProfile?.email || "", approver_email: me?.manager_email || null }]); addNotification("\u{1F4CB}", "Document exception request sent for " + showTenantDocPrompt); logAudit("request", "tenants", "Document exception requested for " + showTenantDocPrompt, "", userProfile?.email, userRole, companyId); setShowTenantDocPrompt(null); fetchDocExceptions(); } finally { guardRelease("reqException"); } }} >Request Exception</Btn>
  )}
  </div>
  </div>
  )}

  {/* Document Exception Requests — Admin/Manager Panel */}
  {canReviewAny && docExceptions.filter(r => r.status === "pending" && canReviewRequest({ userRole, userEmail: userProfile?.email, approverEmail: r.approver_email })).length > 0 && (
  <div className="bg-warn-50 border border-warn-200 rounded-xl p-3 mb-4">
  <div className="text-sm font-bold text-warn-800 mb-2">{"\u{1F4CB}"} Pending Document Exception Requests ({docExceptions.filter(r => r.status === "pending" && canReviewRequest({ userRole, userEmail: userProfile?.email, approverEmail: r.approver_email })).length})</div>
  <div className="space-y-2">
  {docExceptions.filter(r => r.status === "pending" && canReviewRequest({ userRole, userEmail: userProfile?.email, approverEmail: r.approver_email })).map(r => (
  <div key={r.id} className="bg-white rounded-xl border border-warn-100 px-4 py-3 flex items-center justify-between">
  <div>
  <div className="text-sm font-semibold text-neutral-800">{r.tenant_name}</div>
  <div className="text-xs text-neutral-400">{r.property} · Requested by {r.requested_by} · {fmtDate(r.created_at)}</div>
  </div>
  <div className="flex gap-2">
  <Btn variant="success" size="sm" onClick={async () => {
  await supabase.from("doc_exception_requests").update({ status: "approved", reviewed_by: userProfile?.email, reviewed_at: new Date().toISOString() }).eq("id", r.id);
  // Per-doc requests waive the specific doc; blanket requests
  // (legacy rows with no doc_type) fall back to doc_status.
  if (r.doc_type) {
    const { data: tRow } = await supabase.from("tenants").select("id, approved_doc_exceptions, email").eq("company_id", companyId).ilike("name", escapeFilterValue(r.tenant_name)).is("archived_at", null).maybeSingle();
    if (tRow) {
      const existing = Array.isArray(tRow.approved_doc_exceptions) ? tRow.approved_doc_exceptions : [];
      const next = Array.from(new Set([...existing, r.doc_type]));
      await supabase.from("tenants").update({ approved_doc_exceptions: next }).eq("company_id", companyId).eq("id", tRow.id);
      if (tRow.email) addNotification("📄", `${r.doc_type} requirement was waived on your account.`, { recipient: tRow.email, type: "doc_exception" });
    }
  } else {
    await supabase.from("tenants").update({ doc_status: "exception_approved" }).eq("company_id", companyId).ilike("name", escapeFilterValue(r.tenant_name)).is("archived_at", null);
  }
  // Notify the staff member who submitted this request.
  if (r.requested_by) addNotification("✅", `Your doc exception for ${r.tenant_name}${r.doc_type ? ` (${r.doc_type})` : ""} was approved.`, { recipient: r.requested_by, type: "doc_exception" });
  showToast("Exception approved for " + r.tenant_name + (r.doc_type ? ": " + r.doc_type : ""), "success");
  logAudit("approve", "tenants", "Document exception approved for " + r.tenant_name + (r.doc_type ? " (" + r.doc_type + ")" : ""), r.id, userProfile?.email, userRole, companyId);
  fetchDocExceptions(); fetchTenants();
  }}>Approve</Btn>
  <Btn variant="danger" size="sm" onClick={async () => {
  await supabase.from("doc_exception_requests").update({ status: "rejected", reviewed_by: userProfile?.email, reviewed_at: new Date().toISOString() }).eq("id", r.id);
  if (r.requested_by) addNotification("❌", `Your doc exception for ${r.tenant_name}${r.doc_type ? ` (${r.doc_type})` : ""} was rejected.`, { recipient: r.requested_by, type: "doc_exception" });
  showToast("Exception rejected for " + r.tenant_name, "info");
  logAudit("reject", "tenants", "Document exception rejected for " + r.tenant_name + (r.doc_type ? " (" + r.doc_type + ")" : ""), r.id, userProfile?.email, userRole, companyId);
  fetchDocExceptions();
  }}>Reject</Btn>
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
  <div className="flex bg-brand-50 rounded-lg p-0.5">
  {[["card","\u25A6","Cards"],["table","\u2630","Table"],["compact","\u2261","Compact"]].map(([m,icon,label]) => (
  <button key={m} onClick={() => setTenantView(m)} title={label} aria-label={label + " view"} aria-pressed={tenantView === m} className={`px-3 py-1.5 text-sm rounded-lg ${tenantView === m ? "bg-white shadow-card text-brand-700 font-semibold" : "text-neutral-400"}`}>{icon}</button>
  ))}
  </div>
  {/* Sort control, not just clickable table headers. The list defaults to
      CARD view, where there are no headers to click -- so with headers
      alone the list is unsortable unless you first discover the view
      toggle, which is three unlabelled symbols. */}
  <label className="flex items-center gap-1.5 text-xs text-neutral-500">
    Sort
    <Select
      size="sm"
      className="w-36"
      aria-label="Sort tenants by"
      value={`${tenantSort.key}:${tenantSort.dir}`}
      onChange={e => { const [key, dir] = e.target.value.split(":"); setTenantSort({ key, dir }); }}
    >
      {Object.entries(SORTABLE).flatMap(([key, label]) => [
        <option key={key + ":asc"} value={key + ":asc"}>{label} ↑</option>,
        <option key={key + ":desc"} value={key + ":desc"}>{label} ↓</option>,
      ])}
    </Select>
  </label>
  <Btn variant="secondary" onClick={exportTenants}><span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export</Btn>
  {/* Tenants are added through the Property Setup Wizard */}
  </div>
  </div>
  {/* Filters */}
  <div className="flex items-center gap-2 mb-4 flex-wrap">
  <Input placeholder="Search name, email, phone, property..." value={tenantSearch || ""} onChange={e => setTenantSearch(e.target.value)} className="w-64" />
  {/* Must cover every lease_status the app can write. PropertyImport
      stores "current"/"past" for imported tenants; omitting those made
      the filter silently return zero rows on any imported portfolio. */}
  <MultiSelect allLabel="All Status" ariaLabel="Filter tenants by status"
    value={tenantFilter} onChange={setTenantFilter}
    options={[
      { value: "active", label: "Active" }, { value: "current", label: "Current" },
      { value: "notice", label: "Notice" }, { value: "past", label: "Past" },
      { value: "expired", label: "Expired" }, { value: "inactive", label: "Inactive" },
    ]} />
  <MultiSelect allLabel="All Properties" ariaLabel="Filter tenants by property"
    value={tenantFilterProp} onChange={setTenantFilterProp}
    options={[...new Set(tenants.map(t => t.property).filter(Boolean))].sort()
      .map(p => ({ value: p, label: p.length > 34 ? p.slice(0, 34) + "\u2026" : p }))} />
  <MultiSelect allLabel="All Balances" ariaLabel="Filter tenants by balance"
    value={tenantFilterBalance} onChange={setTenantFilterBalance}
    options={[
      { value: "delinquent", label: "Delinquent (owes)" },
      { value: "current", label: "Current ($0)" },
      { value: "credit", label: "Credit (overpaid)" },
    ]} />
  <MultiSelect allLabel="All Leases" ariaLabel="Filter tenants by lease expiry"
    value={tenantFilterLeaseExpiry} onChange={setTenantFilterLeaseExpiry}
    options={[
      { value: "30", label: "Expires in 30 days" }, { value: "60", label: "Expires in 60 days" },
      { value: "90", label: "Expires in 90 days" }, { value: "expired", label: "Expired" },
      { value: "no_lease", label: "No lease date" },
    ]} />
  {(tenantFilter.length || tenantFilterProp.length || tenantFilterBalance.length || tenantFilterLeaseExpiry.length || tenantSearch) && (
  <Btn variant="danger" size="sm" onClick={() => { setTenantFilter([]); setTenantFilterProp([]); setTenantFilterBalance([]); setTenantFilterLeaseExpiry([]); setTenantSearch(""); }}>Clear Filters</Btn>
  )}
  </div>
  {/* Bulk action bar */}
  {selectedTenants.size > 0 && (
  <div className="bg-brand-50 border border-brand-200 rounded-xl px-4 py-3 mb-4 flex items-center justify-between">
  <span className="text-sm font-medium text-brand-800">{selectedTenants.size} tenant{selectedTenants.size > 1 ? "s" : ""} selected</span>
  <div className="flex gap-2">
  <Btn variant="notice" size="sm" onClick={() => setBulkAction("notice")}>Send Notice</Btn>
  <Btn variant="info" size="sm" onClick={() => setBulkAction("charge")}>Add Charge</Btn>
  <Btn variant="purple" size="sm" onClick={() => setBulkAction("status")}>Change Status</Btn>
  <Btn variant="danger" size="sm" onClick={() => setBulkAction("archive")}>Delete</Btn>
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
  // Ids that actually got a posted charge — used below to decide whether the
  // open ledger drawer is now showing a stale balance.
  const bcCharged = new Set();
  for (const tid of selectedTenants) {
  const t = tenants.find(x => x.id === tid);
  if (!t) continue;
  const classId = await getPropertyClassId(t.property, companyId);
  // Same two fixes as addLedgerEntry: AR leg onto the tenant's own
  // sub-account so the charge is visible in the tenant ledger, and no
  // manual balanceUpdate once the balance trigger owns it. Revenue leg
  // is a bare code straight off the <Select>, so it needs resolving
  // too or every bulk charge 400s onto the non-atomic fallback.
  const bcArId = await getOrCreateTenantAR(companyId, t.name, t.id) || await resolveAccountId("1100", companyId);
  if (!bcArId) { showToast("Could not resolve the Accounts Receivable account for " + t.name + ".", "error"); continue; }
  let bcArName = "Accounts Receivable", bcArIsPerTenant = false;
  { const { data: bcAcct } = await supabase.from("acct_accounts").select("name, tenant_id").eq("company_id", companyId).eq("id", bcArId).maybeSingle();
    if (bcAcct?.name) bcArName = bcAcct.name;
    bcArIsPerTenant = !!bcAcct?.tenant_id && String(bcAcct.tenant_id) === String(t.id); }
  const bcResolved = await resolveJELineAccounts([
  { account_id: bcArId, account_name: bcArName, debit: amt, credit: 0, class_id: classId, memo: t.name + ": " + desc },
  { account_id: acctCode, account_name: acctNames[acctCode] || "Other Income", debit: 0, credit: amt, class_id: classId, memo: desc },
  ], companyId);
  if (!bcResolved.lines) { showToast("Chart of accounts is missing account " + bcResolved.missing + ". Nothing was posted.", "error"); break; }
  const result = await atomicPostJEAndLedger({ companyId,
  date: formatLocalDate(new Date()), description: "Bulk charge \u2014 " + t.name + " \u2014 " + desc,
  reference: "BULK-" + shortId(), property: t.property || "",
  lines: bcResolved.lines,
  ledgerEntry: { tenant: t.name, tenant_id: t.id, property: t.property, date: formatLocalDate(new Date()), description: desc, amount: amt, type: "charge", balance: 0 },
  balanceUpdate: bcArIsPerTenant ? null : { tenantId: tid, amount: amt },
  silent: true,
  });
  if (result.jeId) { count++; bcCharged.add(t.id); }
  }
  if (count > 0) addNotification("\u{1F4B0}", `Charge of ${formatCurrency(amt)} added to ${count} tenant(s)`);
  if (count < selectedTenants.size) showToast((selectedTenants.size - count) + " charge(s) failed \u2014 check the Accounting module.", "error");
  logAudit("create", "tenants", `Bulk charge $${amt} "${desc}" to ${count} tenants (acct ${acctCode})`, "", userProfile?.email, userRole, companyId);
  // Same staleness as applyLateFeeForTenant: the ledger drawer keeps its own
  // copy of the tenant row in selectedTenant, and fetchTenants() only
  // refreshes the list behind it. Charging the tenant whose drawer is open
  // left the Balance tile on the pre-charge figure. Refetch that one row and
  // reopen the ledger on it, exactly as addLedgerEntry does.
  if (selectedTenant?.id && bcCharged.has(selectedTenant.id)) {
  const { data: freshTenant } = await supabase.from("tenants").select("*").eq("id", selectedTenant.id).eq("company_id", companyId).maybeSingle();
  // Refresh the ledger too when that panel is the one on screen; otherwise
  // just swap in the fresh row, because openLedger() also forces the panel
  // back to the ledger tab and a bulk charge has no business yanking the
  // user off Documents/Messages — or popping the drawer open again when it
  // was closed with selectedTenant still set.
  if (freshTenant && (activePanel === "detail" || activePanel === "ledger")) openLedger(freshTenant);
  else if (freshTenant) setSelectedTenant(freshTenant);
  }
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
  <option value="active">Active</option><option value="current">Current</option><option value="notice">Notice</option><option value="past">Past</option><option value="expired">Expired</option><option value="inactive">Inactive</option>
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
      .update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email, lease_status: "past" }, { count: "exact" })
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

  {/* Opened from the tenant panel: its own window over the page, and
      saving or cancelling hands back to that panel. Opened from the list
      as before: an inline card. Same fields either way -- only the
      container differs, so there is one copy of the form. */}
  {showForm && editingTenant && editReturnTo && (
  <div className="fixed inset-0 z-[55] bg-black/40"
       onClick={() => { setShowForm(false); setEditingTenant(null); const r = editReturnTo; setEditReturnTo(null); setSelectedTenant(r); setActivePanel("actions"); }} />
  )}
  {showForm && editingTenant && (
  <div className={editReturnTo
    ? "fixed z-[60] inset-x-3 top-4 bottom-4 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-full md:max-w-3xl bg-white rounded-xl shadow-pop p-4 overflow-y-auto safe-y"
    : "bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-4"}>
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
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Late Fee</label><div className="flex gap-1 items-center"><Input type="number" min="0" step="0.01" placeholder="50" value={form.late_fee_amount || ""} onChange={e => setForm({ ...form, late_fee_amount: e.target.value })} className="border border-brand-100 rounded-xl px-3 py-1.5 text-sm flex-1 min-w-0 focus:border-brand-300 focus:outline-none" /><Select value={form.late_fee_type || "flat"} onChange={e => setForm({ ...form, late_fee_type: e.target.value })} className="border border-brand-100 rounded-lg px-2 py-2 text-sm w-12 shrink-0 focus:outline-none"><option value="flat">$</option><option value="percent">%</option></Select></div></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Lease Status</label><Select value={form.lease_status} onChange={e => setForm({ ...form, lease_status: e.target.value })}>
  {["active", "current", "notice", "past", "expired", "inactive"].map(s => <option key={s}>{s}</option>)}
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
  <Btn variant="slate" onClick={() => { setShowForm(false); setEditingTenant(null); if (editReturnTo) { const r = editReturnTo; setEditReturnTo(null); setSelectedTenant(r); setActivePanel("actions"); } }}>Cancel</Btn>
  </div>
  </div>
  )}

  {(() => {
  // Sort state for the tenant list. Name ascending matches how the list
  // was ordered before sorting existed, so the default view is unchanged.

  const ft = tenants.filter(t => {
  // Each filter is now a LIST. An empty list means no constraint; several
  // values mean OR within that filter, and the filters still AND with each
  // other -- so "Current or Past, at 6932 Hawthorne, owing money" is one
  // question instead of three searches.
  if (tenantFilter.length && !tenantFilter.includes(t.lease_status)) return false;
  if (tenantFilterProp.length && !tenantFilterProp.includes(t.property)) return false;
  if (tenantFilterBalance.length) {
  const bal = safeNum(t.balance);
  const hit = tenantFilterBalance.some(f =>
    (f === "delinquent" && bal > 0) || (f === "current" && bal === 0) || (f === "credit" && bal < 0));
  if (!hit) return false;
  }
  if (tenantFilterLeaseExpiry.length) {
  const endDate = t.lease_end_date || t.move_out;
  if (!endDate) { if (!tenantFilterLeaseExpiry.includes("no_lease")) return false; }
  else {
  const daysLeft = Math.ceil((parseLocalDate(endDate) - new Date()) / 86400000);
  // "no_lease" alongside a window keeps rows with no date AND rows in the
  // window; on its own it keeps only the undated ones.
  const hit = tenantFilterLeaseExpiry.some(f =>
    (f === "30" && daysLeft <= 30) || (f === "60" && daysLeft <= 60) ||
    (f === "90" && daysLeft <= 90) || (f === "expired" && daysLeft <= 0));
  if (!hit) return false;
  }
  }
  if (tenantSearch) {
  const q = tenantSearch.toLowerCase();
  if (!t.name?.toLowerCase().includes(q) && !t.email?.toLowerCase().includes(q) && !t.property?.toLowerCase().includes(q) && !t.phone?.toLowerCase().includes(q)) return false;
  }
  return true;
  })
  // Sorted copy. .sort() mutates, so sorting `tenants` directly would
  // reorder the state array under React and make renders depend on the
  // order of previous renders.
  .slice()
  .sort((a, b) => {
    const { key, dir } = tenantSort;
    const mul = dir === "desc" ? -1 : 1;
    const NUMERIC = { rent: true, balance: true };
    if (NUMERIC[key]) return (safeNum(a[key]) - safeNum(b[key])) * mul;
    const av = String(a[key] == null ? "" : a[key]).trim();
    const bv = String(b[key] == null ? "" : b[key]).trim();
    // Blanks last in BOTH directions. Flipping them to the top on a
    // descending sort reads as broken -- a tenant with no email is not
    // "the highest email".
    if (!av && !bv) return 0;
    if (!av) return 1;
    if (!bv) return -1;
    return av.localeCompare(bv, undefined, { sensitivity: "base", numeric: true }) * mul;
  });
  // All six actions are visible -- nothing behind a kebab. The room for
  // them comes from the columns instead: Name, Property and Email are
  // given fixed widths and truncate, rather than being allowed to size
  // themselves to the longest value in the table. A tenant called
  // "Alice E Allen Brown & Michael A Brown" was setting the width of the
  // whole column, which is what pushed the actions onto a second line.
  const TenantActions = ({t}) => (
  <div className="flex gap-1 items-center justify-end flex-nowrap whitespace-nowrap">
  <TextLink tone="brand" size="xs" underline={false} onClick={() => openLedger(t)} className="border border-brand-200 px-1.5 py-0.5 rounded-md hover:bg-brand-50">Ledger</TextLink>
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => openMessages(t)} className="border border-brand-100 px-1.5 py-0.5 rounded-md hover:bg-brand-50/30">Msg</TextLink>
  <TextLink tone="neutral" size="xs" underline={false} onClick={() => { setSelectedTenant(t); setActivePanel("lease"); }} className="border border-brand-100 px-1.5 py-0.5 rounded-md hover:bg-brand-50/30">Lease</TextLink>
  <TextLink tone="info" size="xs" onClick={() => startEdit(t)}>Edit</TextLink>
  <TextLink tone="highlight" size="xs" disabled={!t.email || !!invitingTenant[t.id || t.email || ""]}
    title={!t.email ? "Add an email to this tenant first" : "Send a portal invite"}
    onClick={() => inviteTenant(t)}>{invitingTenant[t.id || t.email || ""] ? "Sending\u2026" : "Invite"}</TextLink>
  <TextLink tone="danger" size="xs" onClick={() => deleteTenant(t.id, t.name)}>Delete</TextLink>
  </div>
  );
  return <>
  {tenantView === "card" && (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
  {ft.map(t => {
  const portalStatus = t.email ? portalMembers[t.email.toLowerCase()] : null;
  return (
  <div key={t.id} {...clickable(() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); })} className={"rounded-xl shadow-card border p-4 cursor-pointer hover:shadow-pop transition-all " + (t.doc_status === "pending_docs" ? "bg-warn-50/60 border-warn-200" /* tinted, not faded: opacity-60 on the whole card dragged every colour inside it below contrast -- 24 failures on this page alone -- because opacity blends the TEXT too, not just the background */ : "bg-white border-brand-50 hover:border-brand-200")}>
  <div className="flex justify-between items-start mb-2">
  <div className="flex items-center gap-3">
  <div className={"w-10 h-10 rounded-full flex items-center justify-center font-bold text-lg " + (t.doc_status === "pending_docs" ? "bg-warn-100 text-warn-700" : "bg-brand-100 text-brand-700")}>{t.name?.[0]}</div>
  <div><CardOpenButton onActivate={() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); }} label={`Open tenant ${t.name}`} className="font-semibold text-neutral-800">{t.name}</CardOpenButton><div className="text-xs text-neutral-400">{t.property}</div>{t.doc_status === "pending_docs" && <div className="text-xs text-warn-600 font-medium">Pending documents</div>}</div>
  </div>
  <div className="flex items-center gap-1">
  <Badge status={t.lease_status} />
  {t.is_voucher && <span className="text-xs bg-highlight-100 text-highlight-700 px-1.5 py-0.5 rounded-full font-semibold">Voucher</span>}
  {portalStatus === "active" && <span className="text-2xs bg-success-100 text-success-700 px-1.5 py-0.5 rounded-full font-semibold" title="Tenant has signed up for the portal">Portal Active</span>}
  {portalStatus === "invited" && <span className="text-2xs bg-highlight-50 text-highlight-700 px-1.5 py-0.5 rounded-full font-semibold" title="Invite sent, not yet accepted">Invited</span>}
  </div>
  </div>
  <div className="grid grid-cols-3 gap-2 text-xs mt-2">
  <div><span className="text-neutral-400">Email</span><div className="font-semibold text-neutral-700 truncate">{t.email || "\u2014"}</div></div>
  <div><span className="text-neutral-400">Balance</span><div className={`font-semibold ${t.balance > 0 ? "text-danger-500" : "text-neutral-700"}`}>{t.balance > 0 ? `-${formatCurrency(t.balance)}` : formatCurrency(0)}</div></div>
  <div><span className="text-neutral-400">Rent</span><div className="font-semibold text-neutral-700">{t.rent ? `${formatCurrency(t.rent)}/mo` : "\u2014"}</div></div>
  </div>
  <div className="flex items-center justify-between mt-3 pt-2 border-t border-brand-50 gap-2">
  <TextLink tone="brand" size="xs" underline={false} onClick={e => { e.stopPropagation(); setSelectedTenant(t); setActivePanel("ledger"); openLedger(t); }} className="font-medium shrink-0">View Ledger</TextLink>
  {safeNum(t.balance) > 0 && safeNum(t.late_fee_amount) > 0 && <TextLink tone="danger" size="xs" underline={false} onClick={e => { e.stopPropagation(); applyLateFeeForTenant(t); }} className="font-medium flex items-center gap-0.5 shrink-0"><span className="material-icons-outlined text-xs">gavel</span>Late Fee</TextLink>}
  {portalStatus !== "active" && (
  <button
    onClick={e => { e.stopPropagation(); inviteTenant(t); }}
    disabled={!t.email || !!invitingTenant[t.id || t.email || ""]}
    title={!t.email ? "Add an email to this tenant first" : portalStatus === "invited" ? "Re-send the portal invite email" : "Send portal access invite to this tenant"}
    className={"ml-auto text-xs font-semibold px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors " + (!t.email ? "bg-neutral-100 text-neutral-400 cursor-not-allowed" : portalStatus === "invited" ? "bg-highlight-50 text-highlight-700 hover:bg-highlight-100 border border-highlight-200" : "bg-brand-600 text-white hover:bg-brand-700")}
  >
    <span className="material-icons-outlined text-xs">{portalStatus === "invited" ? "refresh" : "mail"}</span>
    {invitingTenant[t.id || t.email || ""]
      ? "Sending\u2026"
      : (portalStatus === "invited" ? "Resend Invite" : "Invite to Portal")}
  </button>
  )}
  </div>
  </div>
  );
  })}
  </div>
  )}
  {tenantView === "table" && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card overflow-x-auto">
  <DataTable
    // Restored from the pre-migration markup. The flat migration emitted a
    // ONE-column table here -- just the select-all checkbox -- because the
    // other seven headers were <SortTh> components rather than literal
    // <th>, so the tool never saw them and lifted only the first <td>.
    // Name, Property, Email, Status, Rent, Balance and the row actions all
    // disappeared from the table view, and nothing failed: it still
    // rendered, built and linted.
    columns={[
      // The select-all control lived in the <th>, so it went with the
      // header. A column label takes a node, which is where it belongs.
      { key: "select", thClassName: "w-8", width: 32,
        label: <Checkbox checked={ft.length > 0 && ft.every(t => selectedTenants.has(t.id))} onChange={e => { if (e.target.checked) setSelectedTenants(new Set(ft.map(t => t.id))); else setSelectedTenants(new Set()); }} className="rounded" />,
        render: t => (
          <span onClick={e => e.stopPropagation()}>
            <Checkbox checked={selectedTenants.has(t.id)} onChange={e => { const next = new Set(selectedTenants); if (e.target.checked) next.add(t.id); else next.delete(t.id); setSelectedTenants(next); }} className="rounded" />
          </span>
        ) },
      { key: "name", label: "Name", sort: true, width: 150,
        render: t => (
          <CardOpenButton onActivate={() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); }} label={`Open tenant ${t.name}`} title={t.name} className="font-medium text-brand-600 hover:underline text-left block w-full truncate">{t.name}</CardOpenButton>
        ) },
      { key: "property", label: "Property", sort: true, className: "text-neutral-500", width: 128,
        render: t => <span className="block truncate" title={t.property}>{propertyLabel(t.property)}</span> },
      { key: "email", label: "Email", sort: true, className: "text-neutral-400 text-xs", width: 136,
        render: t => <span className="block truncate" title={t.email}>{t.email}</span> },
      { key: "lease_status", label: "Status", sort: true, width: 84,
        render: t => <Badge status={t.lease_status} /> },
      { key: "rent", label: "Rent", sort: true, align: "right", className: "font-semibold", width: 80,
        render: t => (t.rent ? formatCurrency(t.rent) : "\u2014") },
      { key: "balance", label: "Balance", sort: true, align: "right", width: 92,
        className: t => `font-semibold ${t.balance > 0 ? "text-danger-500" : "text-neutral-700"}`,
        render: t => (t.balance > 0 ? `-${formatCurrency(t.balance)}` : formatCurrency(0)) },
      { key: "actions", label: "", align: "right", width: 276,
        render: t => <TenantActions t={t} /> },
    ]}
    rows={ft}
    rowKey={t => t.id}
    sort={tenantSort}
    onSort={key => setTenantSort(sv => ({ key, dir: sv.key === key && sv.dir === "asc" ? "desc" : "asc" }))}
    className={undefined}
    resizable
    storageKey="tenants-table"
    empty="No tenants found"
  />
  </div>
  )}
  {tenantView === "compact" && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card divide-y divide-brand-50/50">
  {ft.map(t => (
  <div key={t.id} {...clickable(() => { setSelectedTenant(t); setActivePanel("detail"); openLedger(t); })} className="flex items-center gap-3 px-4 py-2.5 hover:bg-brand-50/50 cursor-pointer">
  <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 font-bold text-xs">{t.name?.[0]}</div>
  <div className="flex-1 min-w-0"><span className="text-sm font-medium text-neutral-800">{t.name}</span><span className="text-xs text-neutral-400 ml-2">{t.property}</span></div>
  <span className="text-sm font-semibold text-neutral-700">{t.rent ? `${formatCurrency(t.rent)}/mo` : "\u2014"}</span>
  <span className={`text-xs font-semibold ${t.balance > 0 ? "text-danger-500" : "text-neutral-400"}`}>{t.balance > 0 ? `-${formatCurrency(t.balance)}` : formatCurrency(0)}</span>
  <Badge status={t.lease_status} />
  <TextLink tone="brand" size="xs" onClick={() => openLedger(t)}>Ledger</TextLink>
  <TextLink tone="info" size="xs" onClick={() => startEdit(t)}>Edit</TextLink>
  </div>
  ))}
  </div>
  )}
  {ft.length === 0 && <EmptyState size="compact" title={"No tenants found"} />}
  </>;
  })()}
  </>)}
  {showDocUpload && <DocUploadModal onClose={() => setShowDocUpload(null)} companyId={companyId} property={showDocUpload.property} tenant={showDocUpload.tenant} showToast={showToast} onUploaded={() => { if (selectedTenant) fetchTenantDocs(selectedTenant); }} />}
  {savingTenant && (
  <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-[60] flex items-center justify-center">
  <div className="bg-white rounded-xl shadow-pop px-8 py-6 flex flex-col items-center gap-3">
  <Spinner />
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
