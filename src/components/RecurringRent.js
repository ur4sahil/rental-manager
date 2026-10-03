import { COMPANY_DEFAULTS } from "../config";
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "../supabase";
import { Input, MoneyInput, Select, Btn, FilterPill, DataTable, EmptyState, TextLink, Badge, AccountPicker, FormField, Switch, IconBtn } from "../ui";
import { safeNum, formatLocalDate, formatCurrency, fmtDate, propertyLabel } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { pathForPage } from "../utils/routes";
import { autoPostRecurringEntries, fetchAllPaged, tenantOwnArAccountId, resolveAccountId } from "../utils/accounting";
import { hasTenantId, isTenantBillable, monthBounds, recurringAttention, ATTENTION_LABEL, monthName } from "../utils/recurringRules";
import { Spinner, Modal, PropertySelect } from "./shared";

// ============ RECURRING RENT ============
// One line per schedule, a search box, and the problems stated at the top.
//
// The page this replaces drew every schedule as a card and edited it in a
// box that opened inside the list. It also had three faults that were not
// about looks:
//   - saving ANY edit reset the next posting to next month and switched a
//     paused schedule back on;
//   - a schedule made here carried no tenant id and the account CODES
//     "1200"/"4000" instead of accounts, so it was not the tenant's rent
//     schedule as far as the rest of the app could tell;
//   - it loaded 200 rows and stopped.
// And nothing said when a tenant was not being billed at all, which is how
// three tenants went a month uncharged.

const RENT_REF = /^(RECUR-|RENT1-|PRORENT-)/;
const idOf = (v) => (v === null || v === undefined ? "" : String(v));
const firstOf = (ym) => ym + "-01";
const nextMonthOf = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
const clampDay = (ym, day) => { const [y, m] = ym.split("-").map(Number); const last = new Date(y, m, 0).getDate(); return `${ym}-${String(Math.min(Math.max(1, day), last)).padStart(2, "0")}`; };
const ordinal = (n) => { const d = Number(n) || 1; const s = ["th", "st", "nd", "rd"], v = d % 100; return d + (s[(v - 20) % 10] || s[v] || s[0]); };

export function RecurringJournalEntries({ companyId, companySettings = {}, addNotification, userProfile, userRole, showToast, showConfirm }) {
  const today = formatLocalDate(new Date());
  const thisYm = today.slice(0, 7);
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [charged, setCharged] = useState(() => new Set());   // tenant ids with rent on the ledger this month
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState({ key: "tenant", dir: "asc" });
  const [showAttention, setShowAttention] = useState(true);
  const [allAttention, setAllAttention] = useState(false);
  const [panel, setPanel] = useState(null);     // { kind: "edit", entry } | { kind: "rent", tenantId? } | { kind: "other" }
  const [form, setForm] = useState(null);
  const [history, setHistory] = useState(null); // recent postings for the schedule being edited
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    const { start, end } = monthBounds(thisYm);
    const [e, t, a, lines] = await Promise.all([
      fetchAllPaged(() => supabase.from("recurring_journal_entries").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }).order("id"), "recurring entries"),
      fetchAllPaged(() => supabase.from("tenants").select("id, name, property, rent, lease_status, archived_at, co_tenants, lease_start, move_in").eq("company_id", companyId).order("name").order("id"), "tenants for recurring rent"),
      fetchAllPaged(() => supabase.from("acct_accounts").select("id, code, name, type, is_active, tenant_id").eq("company_id", companyId).order("code").order("id"), "accounts for recurring rent"),
      fetchAllPaged(() => supabase.from("acct_journal_lines")
        .select("id, account_id, debit, memo, acct_journal_entries!inner(date, status, reference, description)")
        .eq("company_id", companyId).gt("debit", 0)
        .eq("acct_journal_entries.status", "posted")
        .gte("acct_journal_entries.date", start).lte("acct_journal_entries.date", end).order("id"), "this month's charges"),
    ]);
    const tenantOfAccount = Object.fromEntries((a.rows || []).filter(x => x.tenant_id != null).map(x => [x.id, idOf(x.tenant_id)]));
    const set = new Set();
    for (const l of lines.rows || []) {
      const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
      const tid = tenantOfAccount[l.account_id];
      if (!tid || !je) continue;
      const words = (je.description || "") + " " + (l.memo || "");
      if (/late/i.test(je.description || "") || /deposit/i.test(words)) continue;
      if (RENT_REF.test(je.reference || "") || /rent/i.test(words)) set.add(tid);
    }
    setEntries(e.rows || []); setTenants(t.rows || []); setAccounts(a.rows || []); setCharged(set);
    setLoading(false);
  }, [companyId, thisYm]);
  useEffect(() => { load(); }, [load]);

  const tenantById = useMemo(() => Object.fromEntries(tenants.map(t => [idOf(t.id), t])), [tenants]);
  const accountById = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, a])), [accounts]);
  const attention = useMemo(() => recurringAttention({ schedules: entries, tenants, chargedThisMonth: charged, today }), [entries, tenants, charged, today]);
  const flagsBySchedule = useMemo(() => {
    const m = {};
    for (const a of attention) if (a.scheduleId) (m[a.scheduleId] = m[a.scheduleId] || []).push(a);
    return m;
  }, [attention]);
  // Tenants with no schedule at all. One whose schedule is paused is resumed, not given a second.
  const unbilled = useMemo(() => tenants.filter(t => isTenantBillable(t) && !entries.some(s => hasTenantId(s) && idOf(s.tenant_id) === idOf(t.id))), [tenants, entries]);

  const rows = useMemo(() => entries.map(e => {
    const rent = hasTenantId(e);
    const tenant = rent ? tenantById[idOf(e.tenant_id)] : null;
    const co = Array.isArray(tenant?.co_tenants) ? tenant.co_tenants.filter(Boolean).length : 0;
    return { ...e, _rent: rent, _tenant: tenant, _co: co,
      _name: rent ? (tenant?.name || e.tenant_name || "Unknown tenant") : (e.description || "Recurring entry"),
      _property: e.property || tenant?.property || "", _flags: flagsBySchedule[e.id] || [] };
  }), [entries, tenantById, flagsBySchedule]);

  const counts = useMemo(() => ({
    all: rows.length, rent: rows.filter(r => r._rent).length, other: rows.filter(r => !r._rent).length,
    paused: rows.filter(r => r.status !== "active").length, attention: rows.filter(r => r._flags.length).length,
  }), [rows]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows
      .filter(r => filter === "all" || (filter === "rent" && r._rent) || (filter === "other" && !r._rent) || (filter === "paused" && r.status !== "active") || (filter === "attention" && r._flags.length))
      .filter(r => !q || [r._name, r._property, r.description, r.tenant_name].some(v => String(v || "").toLowerCase().includes(q)));
    const val = (r) => sort.key === "amount" ? safeNum(r.amount) : sort.key === "property" ? propertyLabel(r._property).toLowerCase()
      : sort.key === "next" ? (r.status === "active" ? r.next_post_date || "9999" : "9999") : sort.key === "last" ? (r.last_posted_date || "") : r._name.toLowerCase();
    return [...list].sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * (sort.dir === "asc" ? 1 : -1) || a._name.localeCompare(b._name); });
  }, [rows, filter, search, sort]);
  const active = rows.filter(r => r.status === "active");
  const monthlyTotal = active.filter(r => r._rent && (r.frequency || "monthly") === "monthly").reduce((n, r) => n + safeNum(r.amount), 0);
  const nextPosting = active.map(r => r.next_post_date).filter(Boolean).sort()[0] || null;
  const onSort = (key) => setSort(s => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }));

  // ── open the panels ─────────────────────────────────────────────────
  function openEdit(entry) {
    setHistory(null);
    setForm({
      description: entry.description || "", amount: String(entry.amount ?? ""), day_of_month: String(entry.day_of_month || 1),
      next_post_date: entry.next_post_date || "", late_fee_enabled: entry.late_fee_enabled !== false,
      grace_period_days: String(entry.grace_period_days ?? companySettings.late_fee_grace_days ?? 5), late_fee_amount: String(entry.late_fee_amount ?? companySettings.late_fee_amount ?? 50),
    });
    setPanel({ kind: "edit", entry });
    supabase.from("acct_journal_entries").select("id, number, date, acct_journal_lines(debit)")
      .eq("company_id", companyId).like("reference", "RECUR-" + String(entry.id).slice(0, 8) + "-%").neq("status", "voided")
      .order("date", { ascending: false }).limit(6)
      .then(({ data }) => setHistory((data || []).map(j => ({ id: j.id, number: j.number, date: j.date, amount: (j.acct_journal_lines || []).reduce((n, l) => n + safeNum(l.debit), 0) }))), () => setHistory([]));
  }
  function openNewRent(tenantId = null) {
    const t = tenantId != null ? tenantById[idOf(tenantId)] : unbilled[0] || null;
    setForm(rentFormFor(t));
    setPanel({ kind: "rent" });
  }
  // This month if it has not been charged; otherwise next month.
  function rentFormFor(t) {
    const alreadyCharged = t ? charged.has(idOf(t.id)) : false;
    return {
      tenant_id: t ? idOf(t.id) : "", amount: t && safeNum(t.rent) > 0 ? String(t.rent) : "", day_of_month: "1",
      first: alreadyCharged ? "next" : "this", late_fee_enabled: true, showFee: false,
      grace_period_days: String(companySettings.late_fee_grace_days || 5), late_fee_amount: String(companySettings.late_fee_amount ?? COMPANY_DEFAULTS.late_fee_amount),
    };
  }
  function openNewOther() {
    setForm({ description: "", amount: "", day_of_month: "1", next_post_date: firstOf(nextMonthOf(thisYm)), property: "", debit_account_id: "", credit_account_id: "" });
    setPanel({ kind: "other" });
  }
  const closePanel = useCallback(() => { if (!saving) { setPanel(null); setForm(null); setHistory(null); } }, [saving]);
  useEffect(() => {
    if (panel?.kind !== "edit") return undefined;
    const onKey = (e) => { if (e.key === "Escape") closePanel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, closePanel]);

  const validDay = (v) => { const d = parseInt(v, 10); return Number.isInteger(d) && d >= 1 && d <= 31 ? d : null; };

  // ── save an edit: ONLY what was changed ─────────────────────────────
  // Not the status, and not the next posting unless that field was edited.
  // The old form sent both on every save, which un-paused a paused schedule
  // and threw away its place in the calendar.
  async function saveEdit() {
    const entry = panel?.entry;
    if (!entry || !guardSubmit("saveRecurring", entry.id)) return;
    try {
      const amount = safeNum(form.amount), day = validDay(form.day_of_month);
      if (!(amount > 0)) { showToast("The amount must be more than zero.", "error"); return; }
      if (!day) { showToast("The day of the month must be between 1 and 31.", "error"); return; }
      if (form.next_post_date && !/^\d{4}-\d{2}-\d{2}$/.test(form.next_post_date)) { showToast("The next posting date is not a real date.", "error"); return; }
      const changes = {};
      if (Math.abs(amount - safeNum(entry.amount)) > 0.005) changes.amount = amount;
      if (day !== (parseInt(entry.day_of_month, 10) || 1)) changes.day_of_month = day;
      if ((form.next_post_date || null) !== (entry.next_post_date || null)) changes.next_post_date = form.next_post_date || null;
      if (hasTenantId(entry)) {
        if (!!form.late_fee_enabled !== (entry.late_fee_enabled !== false)) changes.late_fee_enabled = !!form.late_fee_enabled;
        if (safeNum(form.grace_period_days) !== safeNum(entry.grace_period_days)) changes.grace_period_days = Math.max(0, Math.round(safeNum(form.grace_period_days)));
        if (Math.abs(safeNum(form.late_fee_amount) - safeNum(entry.late_fee_amount)) > 0.005) changes.late_fee_amount = Math.max(0, safeNum(form.late_fee_amount));
      } else if (form.description.trim() && form.description.trim() !== (entry.description || "")) changes.description = form.description.trim();
      if (Object.keys(changes).length === 0) { closePanelNow(); return; }
      setSaving(true);
      const { error } = await supabase.from("recurring_journal_entries").update(changes).eq("id", entry.id).eq("company_id", companyId);
      if (error) { pmError("PM-4007", { raw: error, context: "updating recurring schedule" }); return; }
      const what = Object.keys(changes).map(k => ({ amount: "amount " + formatCurrency(changes.amount), day_of_month: "day " + changes.day_of_month, next_post_date: "next posting " + (changes.next_post_date || "none"), late_fee_enabled: "late fee " + (changes.late_fee_enabled ? "on" : "off"), grace_period_days: "grace " + changes.grace_period_days + " days", late_fee_amount: "late fee " + formatCurrency(changes.late_fee_amount), description: "description" }[k])).join(", ");
      logAudit("update", "accounting", "Recurring schedule updated: " + (entry.tenant_name || entry.description) + " — " + what, String(entry.id), userProfile?.email, userRole, companyId);
      if (addNotification) addNotification("✏️", "Updated recurring schedule: " + (entry.tenant_name || entry.description));
      showToast("Saved: " + what, "success");
      closePanelNow();
      await load();
    } finally { setSaving(false); guardRelease("saveRecurring", entry.id); }
  }
  function closePanelNow() { setPanel(null); setForm(null); setHistory(null); }

  // ── a new rent schedule: tied to the tenant and to their own ledger ──
  async function createRent() {
    if (!guardSubmit("createRecurringRent")) return;
    try {
      const t = tenantById[form.tenant_id];
      const amount = safeNum(form.amount), day = validDay(form.day_of_month);
      if (!t) { showToast("Choose the tenant.", "error"); return; }
      if (!(amount > 0)) { showToast("The amount must be more than zero.", "error"); return; }
      if (!day) { showToast("The day of the month must be between 1 and 31.", "error"); return; }
      setSaving(true);
      const arId = await tenantOwnArAccountId(companyId, t.name, t.id);
      const revenueId = await resolveAccountId("4000", companyId);
      if (!arId || !revenueId) { showToast(!arId ? "The tenant's ledger could not be found or created, so the schedule was not made." : "Rental Income (4000) was not found.", "error"); return; }
      const next = clampDay(form.first === "this" ? thisYm : nextMonthOf(thisYm), day);
      const { error } = await supabase.from("recurring_journal_entries").insert([{
        company_id: companyId, description: "Monthly rent — " + t.name + " — " + propertyLabel(t.property || ""),
        frequency: "monthly", day_of_month: day, amount, tenant_name: t.name, tenant_id: Number(t.id), property: t.property || "",
        debit_account_id: arId, debit_account_name: "AR - " + t.name, credit_account_id: revenueId, credit_account_name: "Rental Income",
        status: "active", next_post_date: next, late_fee_enabled: !!form.late_fee_enabled,
        grace_period_days: Math.max(0, Math.round(safeNum(form.grace_period_days))), late_fee_amount: Math.max(0, safeNum(form.late_fee_amount)),
        created_by: userProfile?.email || "",
      }]);
      if (error) {
        // One active schedule per tenant is enforced by the database.
        if (/already has an active recurring/i.test(error.message || "")) showToast(t.name + " already has an active rent schedule. Edit that one instead.", "error");
        else pmError("PM-4008", { raw: error, context: "creating recurring rent schedule" });
        return;
      }
      logAudit("create", "accounting", "Rent schedule created: " + t.name + " — " + formatCurrency(amount) + " monthly, first posting " + next, String(t.id), userProfile?.email, userRole, companyId);
      if (addNotification) addNotification("🔄", "Rent schedule created: " + t.name);
      closePanelNow();
      // A first charge that is already due posts now, not at the next login.
      let posted = 0;
      if (next <= today) { try { posted = (await autoPostRecurringEntries(companyId))?.posted || 0; } catch (e) { pmError("PM-4008", { raw: e, context: "posting after creating a rent schedule", silent: true }); } }
      showToast("Rent schedule created for " + t.name + (next <= today ? (posted > 0 ? ". " + monthName(thisYm) + " rent has been charged." : ". Press “Post what is due” to charge " + monthName(thisYm) + ".") : ". First charge " + fmtDate(next) + "."), posted > 0 || next > today ? "success" : "warning");
      await load();
    } finally { setSaving(false); guardRelease("createRecurringRent"); }
  }

  async function createOther() {
    if (!guardSubmit("createRecurringOther")) return;
    try {
      const amount = safeNum(form.amount), day = validDay(form.day_of_month);
      const dr = accountById[form.debit_account_id], cr = accountById[form.credit_account_id];
      if (!form.description.trim()) { showToast("Describe what this entry is for.", "error"); return; }
      if (!(amount > 0)) { showToast("The amount must be more than zero.", "error"); return; }
      if (!day) { showToast("The day of the month must be between 1 and 31.", "error"); return; }
      if (!dr || !cr) { showToast("Choose both accounts.", "error"); return; }
      if (dr.id === cr.id) { showToast("The two accounts must be different.", "error"); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.next_post_date || "")) { showToast("Choose the first posting date.", "error"); return; }
      setSaving(true);
      const { error } = await supabase.from("recurring_journal_entries").insert([{
        company_id: companyId, description: form.description.trim(), frequency: "monthly", day_of_month: day, amount,
        tenant_name: "", property: form.property || "", debit_account_id: dr.id, debit_account_name: dr.name, credit_account_id: cr.id, credit_account_name: cr.name,
        status: "active", next_post_date: form.next_post_date, late_fee_enabled: false, created_by: userProfile?.email || "",
      }]);
      if (error) { pmError("PM-4008", { raw: error, context: "creating recurring entry" }); return; }
      logAudit("create", "accounting", "Recurring entry created: " + form.description.trim() + " — " + formatCurrency(amount), "", userProfile?.email, userRole, companyId);
      closePanelNow();
      showToast("Recurring entry created", "success");
      await load();
    } finally { setSaving(false); guardRelease("createRecurringOther"); }
  }

  async function toggleStatus(entry) {
    const next = entry.status === "active" ? "paused" : "active";
    const { error } = await supabase.from("recurring_journal_entries").update({ status: next }).eq("id", entry.id).eq("company_id", companyId);
    if (error) {
      if (/already has an active recurring/i.test(error.message || "")) showToast("This tenant already has another active rent schedule. Remove one of the two.", "error");
      else pmError("PM-4009", { raw: error, context: "toggling recurring schedule status" });
      return;
    }
    logAudit("update", "accounting", (next === "active" ? "Resumed" : "Paused") + " recurring schedule: " + (entry.tenant_name || entry.description), String(entry.id), userProfile?.email, userRole, companyId);
    showToast((next === "active" ? "Resumed: " : "Paused: ") + (entry.tenant_name || entry.description), "success");
    if (panel?.kind === "edit") closePanelNow();
    load();
  }
  async function removeEntry(entry) {
    const who = entry.tenant_name || entry.description;
    if (!await showConfirm({ message: `Remove the recurring schedule for ${who}? Nothing already posted is changed, but it will stop charging.`, variant: "danger", confirmText: "Remove" })) return;
    const { error } = await supabase.from("recurring_journal_entries").update({ status: "inactive", archived_at: new Date().toISOString(), archived_by: userProfile?.email || "" }).eq("id", entry.id).eq("company_id", companyId);
    if (error) { pmError("PM-4010", { raw: error, context: "removing recurring schedule" }); return; }
    logAudit("archive", "accounting", "Removed recurring schedule: " + who, String(entry.id), userProfile?.email, userRole, companyId);
    showToast("Removed: " + who, "success");
    if (panel?.kind === "edit") closePanelNow();
    load();
  }
  async function postDue() {
    if (posting) return;
    if (!await showConfirm({ message: "Post every recurring entry that is due? Entries already posted are never posted twice." })) return;
    setPosting(true);
    try {
      const result = await autoPostRecurringEntries(companyId);
      if (result?.posted > 0) { if (addNotification) addNotification("⚡", "Posted " + result.posted + " recurring entr" + (result.posted === 1 ? "y" : "ies")); showToast("Posted " + result.posted + " recurring entr" + (result.posted === 1 ? "y" : "ies"), "success"); }
      else showToast("Nothing is due right now.", "info");
      await load();
    } finally { setPosting(false); }
  }

  if (loading) return <Spinner />;

  const shownAttention = allAttention ? attention : attention.slice(0, 5);
  const editing = panel?.kind === "edit" ? panel.entry : null;
  const editRent = editing && hasTenantId(editing);
  const editTenant = editRent ? tenantById[idOf(editing.tenant_id)] : null;
  const editLedger = editing ? accountById[editing.debit_account_id] : null;
  const editIncome = editing ? accountById[editing.credit_account_id] : null;
  const amountDiffers = editRent && editTenant && safeNum(editTenant.rent) > 0 && Math.abs(safeNum(form?.amount) - safeNum(editTenant.rent)) > 0.005;
  const newTenant = panel?.kind === "rent" ? tenantById[form?.tenant_id] : null;
  const newCharged = newTenant ? charged.has(idOf(newTenant.id)) : false;
  const newDay = validDay(form?.day_of_month) || 1;

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-end gap-3 mb-3.5">
        <div className="flex-1">
          <h2 className="text-lg font-display font-bold text-neutral-800">Recurring rent</h2>
          <p className="text-sm text-neutral-400 mt-0.5">
            {active.length} active schedule{active.length === 1 ? "" : "s"} · {formatCurrency(monthlyTotal)} a month{nextPosting ? " · next posting " + fmtDate(nextPosting) : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Btn variant="secondary" onClick={postDue} disabled={posting}>{posting ? "Posting…" : "Post what is due"}</Btn>
          <Btn onClick={() => openNewRent()}>+ New schedule</Btn>
        </div>
      </div>

      {attention.length > 0 && (
        <div className="bg-warn-50 border border-warn-200 rounded-xl px-4 py-3 mb-3.5">
          <div className="flex items-center gap-2">
            <span className="material-icons-outlined text-base text-warn-700">warning_amber</span>
            <div className="text-sm font-bold text-warn-800 flex-1">{attention.length} thing{attention.length === 1 ? " needs" : "s need"} a look</div>
            <TextLink tone="warn" size="xs" onClick={() => setShowAttention(v => !v)}>{showAttention ? "Hide" : "Show"}</TextLink>
          </div>
          {showAttention && (
            <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 items-baseline text-sm">
              {shownAttention.map((a, i) => (
                <React.Fragment key={a.kind + "-" + (a.scheduleId || a.tenantId) + "-" + i}>
                  <div className="font-semibold text-warn-800 whitespace-nowrap">{ATTENTION_LABEL[a.kind]}</div>
                  <div className="text-neutral-600 min-w-0"><span className="font-medium text-neutral-700">{a.name}</span> · {a.text}</div>
                  <div className="text-right">
                    {a.kind === "not_billed"
                      ? <TextLink tone="brand" size="xs" onClick={() => openNewRent(a.tenantId)}>Set up</TextLink>
                      : a.kind === "not_charged" ? <TextLink tone="brand" size="xs" onClick={postDue}>Post now</TextLink>
                      : <TextLink tone="brand" size="xs" onClick={() => { const e = entries.find(x => x.id === a.scheduleId); if (e) openEdit(e); }}>Review</TextLink>}
                  </div>
                </React.Fragment>
              ))}
              {attention.length > 5 && <div className="col-span-3"><TextLink tone="warn" size="xs" onClick={() => setAllAttention(v => !v)}>{allAttention ? "Show fewer" : `Show all ${attention.length}`}</TextLink></div>}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col md:flex-row md:items-center gap-2.5 mb-3">
        <Input type="search" placeholder="Search tenant or property" value={search} onChange={e => setSearch(e.target.value)} className="md:w-72" aria-label="Search tenant or property" />
        <div className="flex gap-1.5 flex-wrap flex-1">
          {[["all", "All"], ["rent", "Rent"], ["other", "Other"], ["paused", "Paused"], ["attention", "Needs a look"]].map(([key, label]) => (
            <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)}>{label} {counts[key]}</FilterPill>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 shadow-card overflow-x-auto">
        {rows.length === 0 ? (
          <EmptyState size="compact" icon="autorenew" title="No recurring schedules yet" subtitle="A rent schedule charges a tenant automatically every month. Add one with “+ New schedule”." />
        ) : visible.length === 0 ? (
          <EmptyState size="compact" icon="search_off" title="Nothing matches" subtitle="Try another search or filter." />
        ) : (
          <DataTable
            sort={sort} onSort={onSort}
            columns={[
              { key: "tenant", label: "Tenant", sort: true, className: "text-neutral-800",
                render: r => (<>
                  <div className={"font-medium " + (r.status !== "active" ? "text-neutral-400" : "")}>{r._name}{r._co > 0 && <span className="text-neutral-400 font-normal"> +{r._co}</span>}</div>
                  {!r._rent && <div className="text-xs text-neutral-400">Other · not rent</div>}
                  {r._flags.map((f, i) => <div key={i} className="text-xs font-semibold text-warn-700">{f.kind === "amount_differs" ? "Tenant record says " + formatCurrency(f.tenantRent) : f.kind === "skips_months" ? f.months.map(monthName).join(" and ") + " not charged" : f.kind === "paused" ? "Not charging while paused" : ATTENTION_LABEL[f.kind]}</div>)}
                </>) },
              { key: "property", label: "Property", sort: true, className: "text-neutral-500",
                render: r => (<span className="whitespace-nowrap">{r._property ? propertyLabel(r._property) : "—"}</span>) },
              { key: "amount", label: "Amount", sort: true, align: "right", className: "tnum font-semibold whitespace-nowrap",
                render: r => (<span className={r._flags.some(f => f.kind === "amount_differs") ? "text-warn-700" : ""}>{formatCurrency(r.amount)}</span>) },
              { key: "day", label: "Bills on", className: "text-neutral-500 whitespace-nowrap",
                render: r => (<>{ordinal(r.day_of_month || 1)}{(r.frequency || "monthly") !== "monthly" ? " · " + r.frequency : ""}</>) },
              { key: "next", label: "Next posting", sort: true, className: "tnum whitespace-nowrap",
                render: r => (r.status !== "active" ? <span className="text-neutral-400">Paused</span>
                  : <span className={r._flags.some(f => f.kind === "skips_months") ? "text-warn-700 font-semibold" : "text-neutral-500"}>{fmtDate(r.next_post_date, "—")}</span>) },
              { key: "last", label: "Last posted", sort: true, className: "tnum text-neutral-500 whitespace-nowrap",
                render: r => (<>{r.last_posted_date ? fmtDate(r.last_posted_date) : <span className="text-neutral-400">Never</span>}</>) },
              { key: "late", label: "Late fee", className: "text-neutral-500 whitespace-nowrap",
                render: r => (<>{!r._rent ? "—" : r.late_fee_enabled === false ? "Off" : `${formatCurrency(r.late_fee_amount)} after ${safeNum(r.grace_period_days)} days`}</>) },
              { key: "status", label: "Status",
                render: r => (<Badge label={r.status === "active" ? "Active" : "Paused"} color={r.status === "active" ? "green" : "gray"} />) },
              { key: "actions", label: "Actions", align: "right", className: "whitespace-nowrap",
                render: r => (<span onClick={e => e.stopPropagation()} className="inline-flex gap-3.5">
                  <TextLink tone="brand" size="xs" onClick={() => toggleStatus(r)}>{r.status === "active" ? "Pause" : "Resume"}</TextLink>
                  <TextLink tone="brand" size="xs" onClick={() => openEdit(r)}>Edit</TextLink>
                  <TextLink tone="danger" size="xs" onClick={() => removeEntry(r)}>Remove</TextLink>
                </span>) },
            ]}
            rows={visible}
            rowKey={r => r.id}
            onRowClick={r => openEdit(r)}
            rowClassName={r => (r._flags.length ? "bg-warn-50/40" : "")}
            empty="Nothing matches"
          />
        )}
        {rows.length > 0 && <div className="px-4 py-2 border-t border-neutral-100 bg-neutral-50 text-xs text-neutral-400">Showing {visible.length} of {rows.length}</div>}
      </div>

      {/* ── edit: a slim side panel, not a box in the list ── */}
      {editing && form && (
        <div className="fixed inset-0 z-[60] flex justify-end bg-black/30" onMouseDown={e => { if (e.target === e.currentTarget) closePanel(); }}>
          <aside role="dialog" aria-modal="true" aria-label={"Edit schedule: " + (editing.tenant_name || editing.description)} className="bg-white w-full max-w-[460px] h-full shadow-pop flex flex-col">
            <div className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-neutral-200">
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-display font-bold text-neutral-800 truncate">{editRent ? (editTenant?.name || editing.tenant_name) : "Recurring entry"}</h3>
                <p className="text-sm text-neutral-400 truncate">{editing.property ? propertyLabel(editing.property) + " · " : ""}{editRent ? "rent schedule" : "not rent"}{editing.status !== "active" ? " · paused" : ""}</p>
              </div>
              <IconBtn icon="close" onClick={closePanel} aria-label="Close" />
            </div>

            <div className="px-6 py-4 space-y-4 flex-1 overflow-y-auto">
              {!editRent && <FormField label="Description"><Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></FormField>}
              <FormField label="Amount each month">
                <MoneyInput value={form.amount} onChange={v => setForm({ ...form, amount: v })} />
                {amountDiffers && (
                  <div className="flex items-center gap-2 text-xs text-warn-700 mt-1.5">
                    <span className="flex-1">The tenant record says {formatCurrency(editTenant.rent)}.</span>
                    <TextLink tone="brand" size="xs" onClick={() => setForm({ ...form, amount: String(editTenant.rent) })}>Use {formatCurrency(editTenant.rent)}</TextLink>
                  </div>
                )}
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Bills on day"><Input type="number" min="1" max="31" value={form.day_of_month} onChange={e => setForm({ ...form, day_of_month: e.target.value })} /></FormField>
                <FormField label="Next posting"><Input type="date" value={form.next_post_date} onChange={e => setForm({ ...form, next_post_date: e.target.value })} /></FormField>
              </div>
              <p className="text-xs text-neutral-400 -mt-2">Saving does not move the next posting unless you change it here. In a shorter month, a late day posts on the last day.</p>

              {editRent && (
                <div className="border border-neutral-200 rounded-xl p-3.5 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-neutral-700">Late fee</div>
                      <div className="text-xs text-neutral-400">Charged automatically when rent is unpaid</div>
                    </div>
                    <Switch checked={!!form.late_fee_enabled} onChange={v => setForm({ ...form, late_fee_enabled: !!v })} label="Late fee" />
                  </div>
                  {form.late_fee_enabled && (
                    <div className="grid grid-cols-2 gap-3">
                      <FormField label="Fee"><MoneyInput value={form.late_fee_amount} onChange={v => setForm({ ...form, late_fee_amount: v })} /></FormField>
                      <FormField label="After (days)"><Input type="number" min="0" value={form.grace_period_days} onChange={e => setForm({ ...form, grace_period_days: e.target.value })} /></FormField>
                    </div>
                  )}
                </div>
              )}

              <div className="bg-neutral-50 rounded-xl p-3.5 text-sm space-y-1.5">
                <div className="flex gap-3"><span className="text-neutral-400 w-24 shrink-0">Charges</span><span className="text-neutral-700">{editLedger ? `${editRent ? (editTenant?.name || editing.tenant_name) + "’s ledger" : editLedger.name} (${editLedger.code})` : (editing.debit_account_name || "—")}</span></div>
                <div className="flex gap-3"><span className="text-neutral-400 w-24 shrink-0">{editRent ? "Income to" : "Credits"}</span><span className="text-neutral-700">{editIncome ? `${editIncome.code} ${editIncome.name}` : (editing.credit_account_name || "—")}</span></div>
                {editRent && <div className="flex gap-3"><span className="text-neutral-400 w-24 shrink-0">Set by</span><span className="text-neutral-700">The tenant. It cannot point at someone else’s ledger.</span></div>}
              </div>

              <div>
                <div className="text-xs font-medium text-neutral-500 uppercase tracking-widest mb-1">Recent postings</div>
                {history === null ? <p className="text-xs text-neutral-400">Loading…</p>
                  : history.length === 0 ? <p className="text-xs text-neutral-400">This schedule has not posted anything yet.</p>
                  : history.map(h => (
                    <div key={h.id} className="flex gap-3 text-sm py-1.5 border-b border-neutral-100 last:border-b-0">
                      <span className="w-24 text-neutral-500 tnum">{fmtDate(h.date)}</span>
                      <a className="flex-1 text-brand-600 hover:underline" href={pathForPage("acct_journal") + "/" + encodeURIComponent(h.number || "") + window.location.search} target="_blank" rel="noopener noreferrer">{h.number || "entry"}</a>
                      <span className="tnum font-semibold text-neutral-700">{formatCurrency(h.amount)}</span>
                    </div>
                  ))}
              </div>
            </div>

            <div className="flex items-center gap-2.5 px-6 py-3.5 border-t border-neutral-200 bg-neutral-50">
              <Btn onClick={saveEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Btn>
              <Btn variant="secondary" onClick={closePanel} disabled={saving}>Cancel</Btn>
              <span className="flex-1" />
              <TextLink tone="brand" size="sm" onClick={() => toggleStatus(editing)}>{editing.status === "active" ? "Pause" : "Resume"}</TextLink>
              <TextLink tone="danger" size="sm" onClick={() => removeEntry(editing)}>Remove</TextLink>
            </div>
          </aside>
        </div>
      )}

      {/* ── new rent schedule ── */}
      {panel?.kind === "rent" && form && (
        <Modal title="New rent schedule" onClose={closePanel}>
          {unbilled.length === 0 ? (<>
            <p className="text-sm text-neutral-600">Every tenant living in a property already has a rent schedule. To change one, press Edit on its row.</p>
            <div className="flex gap-2 mt-4">
              <Btn variant="secondary" onClick={closePanel}>Close</Btn>
              <span className="flex-1" />
              <TextLink tone="brand" size="sm" onClick={openNewOther}>Not rent? Add another recurring entry</TextLink>
            </div>
          </>) : (<>
            <p className="text-sm text-neutral-400 mb-4">One per tenant. The app charges it on the day you choose, every month.</p>
            <div className="space-y-4">
              <FormField label="Tenant">
                <Select value={form.tenant_id} onChange={e => setForm({ ...rentFormFor(tenantById[e.target.value] || null), day_of_month: form.day_of_month })}>
                  <option value="">Select tenant…</option>
                  {unbilled.map(t => <option key={t.id} value={idOf(t.id)}>{t.name}{t.property ? " · " + propertyLabel(t.property) : ""}</option>)}
                </Select>
                <p className="text-xs text-neutral-400 mt-1">Only tenants who are not being billed are listed.</p>
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Amount each month">
                  <MoneyInput value={form.amount} onChange={v => setForm({ ...form, amount: v })} placeholder="0.00" />
                  {newTenant && safeNum(newTenant.rent) > 0 && <p className="text-xs text-neutral-400 mt-1">Their rent on record is {formatCurrency(newTenant.rent)}.</p>}
                </FormField>
                <FormField label="Bills on day"><Input type="number" min="1" max="31" value={form.day_of_month} onChange={e => setForm({ ...form, day_of_month: e.target.value })} /></FormField>
              </div>
              <div>
                <div className="text-xs font-medium text-neutral-500 uppercase tracking-widest mb-1.5">First charge</div>
                <div className="grid grid-cols-2 gap-2.5">
                  {[["this", clampDay(thisYm, newDay), newCharged ? `${monthName(thisYm)} is already on their ledger, so this would charge it twice.` : `Charge this month too. ${monthName(thisYm)} has not been charged.`],
                    ["next", clampDay(nextMonthOf(thisYm), newDay), newCharged ? `Start next month. ${monthName(thisYm)} is already charged.` : `Start next month. ${monthName(thisYm)} was handled another way.`]].map(([key, date, note]) => (
                    <button key={key} type="button" onClick={() => setForm({ ...form, first: key })} aria-pressed={form.first === key}
                      disabled={key === "this" && newCharged}
                      className={"text-left rounded-xl px-3.5 py-3 border-2 transition-colors disabled:opacity-50 " + (form.first === key ? "border-brand-600 bg-brand-50" : "border-neutral-200 bg-white hover:border-neutral-300")}>
                      <span className="block text-sm font-bold text-neutral-800">{fmtDate(date)}</span>
                      <span className="block text-xs text-neutral-500 mt-0.5">{note}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="border border-neutral-200 rounded-xl px-3.5 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-neutral-700">Late fee: {form.late_fee_enabled ? `${formatCurrency(form.late_fee_amount)} after ${safeNum(form.grace_period_days)} days` : "off"}</div>
                    <div className="text-xs text-neutral-400">The company default. Change it for this tenant if needed.</div>
                  </div>
                  <TextLink tone="brand" size="sm" onClick={() => setForm({ ...form, showFee: !form.showFee })}>{form.showFee ? "Done" : "Change"}</TextLink>
                </div>
                {form.showFee && (
                  <div className="grid grid-cols-3 gap-3 mt-3 items-end">
                    <label className="flex items-center gap-2 text-sm text-neutral-700 pb-2">
                      <Switch checked={!!form.late_fee_enabled} onChange={v => setForm({ ...form, late_fee_enabled: !!v })} label="Charge a late fee" />
                      <span>{form.late_fee_enabled ? "On" : "Off"}</span>
                    </label>
                    <FormField label="Fee"><MoneyInput value={form.late_fee_amount} onChange={v => setForm({ ...form, late_fee_amount: v })} /></FormField>
                    <FormField label="After (days)"><Input type="number" min="0" value={form.grace_period_days} onChange={e => setForm({ ...form, grace_period_days: e.target.value })} /></FormField>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-5">
              <Btn onClick={createRent} disabled={saving}>{saving ? "Creating…" : "Create schedule"}</Btn>
              <Btn variant="secondary" onClick={closePanel} disabled={saving}>Cancel</Btn>
              <span className="flex-1" />
              <TextLink tone="brand" size="xs" onClick={openNewOther}>Not rent? Add another recurring entry</TextLink>
            </div>
          </>)}
        </Modal>
      )}

      {/* ── another recurring entry (mortgage, HOA, ...) ── */}
      {panel?.kind === "other" && form && (
        <Modal title="New recurring entry (not rent)" onClose={closePanel}>
          <div className="space-y-4">
            <FormField label="Description" required><Input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. Mortgage payment" /></FormField>
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Amount" required><MoneyInput value={form.amount} onChange={v => setForm({ ...form, amount: v })} placeholder="0.00" /></FormField>
              <FormField label="Day"><Input type="number" min="1" max="31" value={form.day_of_month} onChange={e => setForm({ ...form, day_of_month: e.target.value })} /></FormField>
              <FormField label="First posting"><Input type="date" value={form.next_post_date} onChange={e => setForm({ ...form, next_post_date: e.target.value })} /></FormField>
            </div>
            <FormField label="Property (optional)"><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></FormField>
            <FormField label="Debit account" required><AccountPicker value={form.debit_account_id} onChange={id => setForm({ ...form, debit_account_id: id })} accounts={accounts} /></FormField>
            <FormField label="Credit account" required><AccountPicker value={form.credit_account_id} onChange={id => setForm({ ...form, credit_account_id: id })} accounts={accounts} /></FormField>
          </div>
          <div className="flex gap-2 mt-5">
            <Btn onClick={createOther} disabled={saving}>{saving ? "Creating…" : "Create entry"}</Btn>
            <Btn variant="secondary" onClick={closePanel} disabled={saving}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}
