import React, { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "../supabase";
import { Btn, Input, MoneyInput, Select, Textarea, FormField, Alert, DetailCard, TextLink } from "../ui";
import { formatCurrency, fmtDate, formatLocalDate, safeNum, formatPhoneInput } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import {
  renewalDefaults, checkRenewal, checkRentChange, earliestRentIncreaseDate, firstOfMonthOnOrAfter, checkAddendum, addendumText,
  describeLeaseChange, CHANGE_KIND_LABEL, CHANGE_STATUS_LABEL, DEFAULT_RENT_NOTICE_DAYS, daysBetween,
} from "../utils/leaseChangeRules";
import { loadLeaseChanges, createLeaseChange, cancelLeaseChange, openChangeOfKind } from "../utils/leaseChanges";
import { Modal } from "./shared";

// ============ RENEWALS, RENT CHANGES, ADDENDA ============
// One way to change a lease, from the tenant's page or the Leases tab.
//
// These used to change the lease the moment a button was pressed: "Renew"
// raised the rent today for a term starting months away, the rent increase
// ignored its own effective date, and none of them produced a document.
// Now each one is written up, signed where it has to be, and takes effect
// on its date -- see lease_changes and leaseChangeRules.js.

const OPTION = "w-full text-left rounded-xl border p-3 transition-colors ";
const optionClass = (on) => OPTION + (on ? "border-brand-500 bg-brand-50" : "border-neutral-200 bg-white hover:bg-neutral-50");
const TITLE = { renewal: "Renew the lease", rent: "Change the rent", addendum: "Addendum to the lease" };

/** The tenant's active lease, newest first. */
async function activeLeaseFor(companyId, tenantId) {
  const { data, error } = await supabase.from("leases").select("*").eq("company_id", companyId).eq("tenant_id", Number(tenantId))
    .eq("status", "active").is("archived_at", null).order("start_date", { ascending: false }).limit(1);
  if (error) return { error: error.message };
  return { lease: (data || [])[0] || null };
}

/**
 * kind: "renewal" | "rent" | "addendum".  Give `lease` when it is known (the
 * Leases tab); otherwise the tenant's active lease is looked up.
 * tenant: { id, name, co_tenants }
 */
export function LeaseChangeDialog({ kind, lease: givenLease = null, tenant, companyId, companySettings = {}, userEmail = "", userRole = "", setPage, returnTo = null, showToast, onClose, onSaved }) {
  const today = formatLocalDate(new Date());
  const noticeDays = Number.isFinite(Number(companySettings.rent_increase_notice_days)) ? Number(companySettings.rent_increase_notice_days) : DEFAULT_RENT_NOTICE_DAYS;
  const [lease, setLease] = useState(givenLease);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [how, setHow] = useState("document");          // "document" (write it up and send) | "paper" (already agreed outside the app)
  const [f, setF] = useState(null);                     // the form, once the lease is known

  useEffect(() => {
    let alive = true;
    (async () => {
      let l = givenLease;
      if (!l && tenant?.id != null) {
        const r = await activeLeaseFor(companyId, tenant.id);
        if (!alive) return;
        if (r.error) { setLoadError("The lease could not be read: " + r.error); return; }
        l = r.lease;
      }
      if (!alive) return;
      if (!l) { setLoadError(tenant?.name + " has no active lease on record. Create the lease in the Leases tab first."); return; }
      setLease(l);
      if (kind === "renewal") { const d = renewalDefaults(l, today); setF({ startDate: d.startDate, endDate: d.endDate, rent: String(d.rent || "") }); }
      else if (kind === "rent") setF({ newRent: "", noticeDate: today, effectiveDate: firstOfMonthOnOrAfter(earliestRentIncreaseDate({ noticeDate: today, noticeDays })), reason: "" });
      else setF({ type: "add_person", name: "", email: "", phone: "", removeName: "", newRent: "", text: "", effectiveDate: today });
    })();
    return () => { alive = false; };
    // The lease and tenant this dialog is for do not change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const coTenants = useMemo(() => (Array.isArray(tenant?.co_tenants) ? tenant.co_tenants : []).map(n => String(n || "").trim()).filter(Boolean), [tenant]);
  const set = (patch) => setF(prev => ({ ...prev, ...patch }));

  // What the form adds up to, and whether it may go ahead.
  const plan = useMemo(() => {
    if (!lease || !f) return null;
    if (kind === "renewal") {
      const c = checkRenewal({ lease, startDate: f.startDate, endDate: f.endDate, rent: safeNum(f.rent), date: fmtDate });
      if (!c.ok) return c;
      return { ok: true, change: { kind: "renewal", effective_date: c.startDate, payload: { end_date: c.endDate, rent: c.rent } },
        templateKey: "lease_renewal", fieldMap: { effective_date: "renewal_start", end_date: "renewal_end", rent: "new_rent" },
        values: { renewal_start: c.startDate, renewal_end: c.endDate, new_rent: formatCurrency(c.rent) } };
    }
    if (kind === "rent") {
      const noticeDate = how === "paper" ? f.noticeDate : today;
      const c = checkRentChange({ currentRent: lease.rent_amount, newRent: safeNum(f.newRent), effectiveDate: f.effectiveDate, noticeDate, noticeDays, date: fmtDate });
      if (!c.ok) return c;
      return { ok: true, increase: c.increase, pct: c.pct, noticeDate,
        change: { kind: "rent_increase", effective_date: f.effectiveDate, payload: { rent: c.to, reason: String(f.reason || "").trim() } },
        templateKey: "rent_increase_notice", fieldMap: { effective_date: "effective_date", rent: "new_rent" },
        values: { effective_date: f.effectiveDate, current_rent: formatCurrency(c.from), new_rent: formatCurrency(c.to), increase_amount: formatCurrency(Math.abs(c.amount)),
          increase_pct: c.pct != null ? String(Math.abs(c.pct)) : "", notice_days: String(Math.max(0, daysBetween(noticeDate, f.effectiveDate) || 0)), increase_reason: String(f.reason || "").trim() } };
    }
    const c = checkAddendum({ kind: f.type, tenantName: tenant?.name || "", coTenants, person: { name: f.name, email: f.email, phone: f.phone }, removeName: f.removeName, newRent: safeNum(f.newRent), currentRent: lease.rent_amount, effectiveDate: f.effectiveDate, text: f.text });
    if (!c.ok) return c;
    const payload = { ...c.payload, ...(String(f.text || "").trim() ? { summary: String(f.text).trim() } : {}) };
    return { ok: true, change: { kind: "addendum", effective_date: f.effectiveDate, payload },
      templateKey: "lease_change_addendum", fieldMap: { effective_date: "effective_date" },
      values: { effective_date: f.effectiveDate, addendum_text: addendumText(payload, { money: formatCurrency, text: f.text }) } };
  }, [lease, f, kind, how, today, noticeDays, coTenants, tenant]);

  async function go() {
    if (!plan?.ok || !lease || !guardSubmit("leaseChange", lease.id)) return;
    try {
      setBusy(true);
      // A renewal or rent change already in flight must be cancelled first:
      // two would each believe it had the last word on the rent.
      if (plan.change.kind !== "addendum") {
        const open = await openChangeOfKind(companyId, lease.id, plan.change.kind);
        if (open.error) { showToast("Could not check for a change already in progress. Try again.", "error"); return; }
        if (open.change) { showToast("There is already a " + (plan.change.kind === "renewal" ? "renewal" : "rent change") + " waiting to take effect (" + fmtDate(open.change.effective_date) + "). Cancel it first.", "error"); return; }
      }
      if (how === "paper") {
        const made = await createLeaseChange({
          companyId, leaseId: lease.id, tenantId: lease.tenant_id ?? tenant?.id, kind: plan.change.kind, effectiveDate: plan.change.effective_date,
          payload: plan.change.payload, status: "scheduled", noticeDate: plan.change.kind === "rent_increase" ? plan.noticeDate : null,
          note: plan.change.kind === "rent_increase" ? "Notice given outside the app" : "Signed outside the app", userEmail,
        });
        if (!made.ok) { showToast(made.error, "error"); return; }
        logAudit("create", "leases", CHANGE_KIND_LABEL[plan.change.kind] + " scheduled: " + describeLeaseChange(made.change, formatCurrency, fmtDate) + " — " + (lease.tenant_name || tenant?.name || ""), lease.id, userEmail, userRole, companyId);
        showToast(describeLeaseChange(made.change, formatCurrency, fmtDate) + ". It takes effect by itself on that date.", "success");
        if (onSaved) onSaved(made.change);
        onClose();
        return;
      }
      if (!setPage) { showToast("The Document Builder is not available from here.", "error"); return; }
      setPage("doc_builder", {
        templateKey: plan.templateKey, tenantId: lease.tenant_id ?? tenant?.id, leaseId: lease.id, returnTo, values: plan.values,
        change: { ...plan.change, leaseId: lease.id, tenantId: lease.tenant_id ?? tenant?.id, fieldMap: plan.fieldMap, noticeDate: plan.noticeDate || null },
      });
    } finally { setBusy(false); guardRelease("leaseChange", lease.id); }
  }

  const signed = kind !== "rent";
  return (
    <Modal title={TITLE[kind] + (tenant?.name || lease?.tenant_name ? " — " + (tenant?.name || lease.tenant_name) : "")} onClose={() => { if (!busy) onClose(); }}>
      {loadError ? (<>
        <Alert tone="warn" className="mb-4">{loadError}</Alert>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
      </>) : !lease || !f ? (
        <p className="text-sm text-neutral-400 py-6 text-center">Reading the lease…</p>
      ) : (<>
        <p className="text-sm text-neutral-500 mb-3">
          Current term {fmtDate(lease.start_date)} – {fmtDate(lease.end_date)} · {formatCurrency(lease.rent_amount)} a month
        </p>

        {kind === "renewal" && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="New term starts" required><Input type="date" value={f.startDate} onChange={e => set({ startDate: e.target.value })} /></FormField>
            <FormField label="New term ends" required><Input type="date" value={f.endDate} onChange={e => set({ endDate: e.target.value })} /></FormField>
            <FormField label="Rent for the new term" required className="col-span-2"><MoneyInput value={f.rent} onChange={v => set({ rent: v })} placeholder="0.00" /></FormField>
          </div>
        )}

        {kind === "rent" && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="New monthly rent" required><MoneyInput value={f.newRent} onChange={v => set({ newRent: v })} placeholder="0.00" /></FormField>
            <FormField label="New rent starts" required><Input type="date" value={f.effectiveDate} onChange={e => set({ effectiveDate: e.target.value })} /></FormField>
            <FormField label="Reason (optional)" className="col-span-2"><Input value={f.reason} onChange={e => set({ reason: e.target.value })} placeholder="e.g. Annual adjustment" /></FormField>
            <p className="col-span-2 text-xs text-neutral-400 -mt-1">
              An increase needs {noticeDays} days' written notice. With notice {how === "paper" ? "on " + fmtDate(f.noticeDate) : "today"}, the earliest start is {fmtDate(earliestRentIncreaseDate({ noticeDate: how === "paper" ? f.noticeDate : today, noticeDays }))}. A decrease needs none.
            </p>
          </div>
        )}

        {kind === "addendum" && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="What changes" className="col-span-2">
              <Select value={f.type} onChange={e => set({ type: e.target.value })}>
                <option value="add_person">A person joins the lease</option>
                <option value="remove_person" disabled={coTenants.length === 0}>A person leaves the lease{coTenants.length === 0 ? " (nobody else is on it)" : ""}</option>
                <option value="rent">The monthly rent changes (e.g. pet rent)</option>
                <option value="other">Wording only: nothing changes in the records</option>
              </Select>
            </FormField>
            {f.type === "add_person" && (<>
              <FormField label="Full name" required className="col-span-2"><Input value={f.name} onChange={e => set({ name: e.target.value })} /></FormField>
              <FormField label="Email (they sign too)"><Input type="email" value={f.email} onChange={e => set({ email: e.target.value })} placeholder="name@example.com" /></FormField>
              <FormField label="Phone"><Input type="tel" value={f.phone} onChange={e => set({ phone: formatPhoneInput(e.target.value) })} /></FormField>
            </>)}
            {f.type === "remove_person" && (
              <FormField label="Who is leaving" required className="col-span-2">
                <Select value={f.removeName} onChange={e => set({ removeName: e.target.value })}>
                  <option value="">Choose…</option>
                  {coTenants.map(n => <option key={n} value={n}>{n}</option>)}
                </Select>
              </FormField>
            )}
            {f.type === "rent" && <FormField label="New monthly rent" required className="col-span-2"><MoneyInput value={f.newRent} onChange={v => set({ newRent: v })} placeholder="0.00" /></FormField>}
            <FormField label="Takes effect on" required><Input type="date" value={f.effectiveDate} onChange={e => set({ effectiveDate: e.target.value })} /></FormField>
            <FormField label={f.type === "other" ? "What the addendum says" : "Anything else it should say (optional)"} required={f.type === "other"} className="col-span-2">
              <Textarea rows={3} value={f.text} onChange={e => set({ text: e.target.value })} />
            </FormField>
          </div>
        )}

        <div className="space-y-2 mt-4" role="radiogroup" aria-label="How it is put in writing">
          <button type="button" role="radio" aria-checked={how === "document"} className={optionClass(how === "document")} onClick={() => setHow("document")}>
            <span className="block text-sm font-semibold text-neutral-800">{signed ? "Write it up and send it for signature" : "Create the notice now"}</span>
            <span className="block text-xs text-neutral-600 mt-0.5">{signed
              ? "Opens the document, filled in. Nothing changes until everyone has signed and the date arrives."
              : "Opens the notice, filled in, to email or print. The new rent starts by itself on its date."}</span>
          </button>
          <button type="button" role="radio" aria-checked={how === "paper"} className={optionClass(how === "paper")} onClick={() => setHow("paper")}>
            <span className="block text-sm font-semibold text-neutral-800">{signed ? "Already signed on paper" : "Notice was already given"}</span>
            <span className="block text-xs text-neutral-600 mt-0.5">{signed ? "No document is made. It is scheduled and takes effect by itself on its date." : "No notice is made. The new rent is scheduled for its date."}</span>
          </button>
          {how === "paper" && kind === "rent" && (
            <FormField label="Notice was given on" required><Input type="date" value={f.noticeDate} max={today} onChange={e => set({ noticeDate: e.target.value })} /></FormField>
          )}
        </div>

        {plan && !plan.ok && <Alert tone="warn" className="mt-3">{plan.error}</Alert>}
        {plan?.ok && <p className="text-sm text-neutral-700 mt-3 flex gap-2"><span className="material-icons-outlined text-base text-positive-600">check</span><span>{describeLeaseChange(plan.change, formatCurrency, fmtDate)}{kind === "rent" && plan.pct != null ? ` (${plan.increase ? "+" : "−"}${Math.abs(plan.pct)}%)` : ""}</span></p>}

        <div className="flex gap-2 mt-4">
          <Btn onClick={go} disabled={busy || !plan?.ok}>{busy ? "Working…" : how === "paper" ? "Schedule it" : signed ? "Continue to the document" : "Continue to the notice"}</Btn>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
        </div>
      </>)}
    </Modal>
  );
}

// What is coming up (and what recently happened) for one tenant or lease.
export function LeaseChangesCard({ companyId, tenantId = null, leaseId = null, userEmail = "", userRole = "", showToast, showConfirm, canAct = true, reloadKey = 0, onChanged }) {
  const [state, setState] = useState(null);   // { ok, changes }
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setState(await loadLeaseChanges(companyId, { tenantId, leaseId }));
  }, [companyId, tenantId, leaseId]);
  useEffect(() => { load(); }, [load, reloadKey]);

  async function cancel(c) {
    if (showConfirm && !await showConfirm({ message: "Cancel this " + CHANGE_KIND_LABEL[c.kind].toLowerCase() + "? " + describeLeaseChange(c, formatCurrency, fmtDate) + "." + (c.status === "awaiting_signature" ? " The signature request is cancelled too; nobody is emailed about it." : ""), confirmText: "Cancel it" })) return;
    setBusy("Cancelling…");
    const r = await cancelLeaseChange(companyId, c, { userEmail, reason: "Cancelled by staff" });
    setBusy("");
    if (!r.ok) { showToast(r.error, "error"); return; }
    logAudit("update", "leases", "Cancelled " + CHANGE_KIND_LABEL[c.kind].toLowerCase() + ": " + describeLeaseChange(c, formatCurrency, fmtDate), c.lease_id, userEmail, userRole, companyId);
    showToast(CHANGE_KIND_LABEL[c.kind] + " cancelled", "success");
    load();
    if (onChanged) onChanged();
  }

  if (!state) return null;
  if (!state.ok) { pmError("PM-3004", { raw: { message: state.error }, context: "lease changes card", silent: true }); return null; }
  const open = state.changes.filter(c => c.status === "awaiting_signature" || c.status === "scheduled");
  const past = state.changes.filter(c => c.status === "applied" || c.status === "cancelled").slice(0, 3);
  if (!open.length && !past.length) return null;
  const tone = { awaiting_signature: "text-warn-700", scheduled: "text-brand-700", applied: "text-positive-700", cancelled: "text-neutral-400" };
  return (
    <DetailCard title="Lease changes" sub={open.length ? open.length + " coming up" : null} flush>
      {[...open, ...past].map(c => (
        <div key={c.id} className="px-4 py-3 border-b border-brand-50 last:border-b-0">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-700">{describeLeaseChange(c, formatCurrency, fmtDate)}</div>
              <div className="text-xs text-neutral-400">
                {CHANGE_KIND_LABEL[c.kind]} · <span className={tone[c.status]}>{CHANGE_STATUS_LABEL[c.status]}</span>
                {c.status === "cancelled" && c.cancel_reason ? " · " + c.cancel_reason : ""}
                {c.status === "applied" && c.applied_at ? " · " + fmtDate(c.applied_at) : ""}
              </div>
              {c.status === "scheduled" && c.note && /^Could not be applied/.test(c.note) && <div className="text-xs text-danger-600 mt-0.5">{c.note}</div>}
            </div>
            {canAct && (c.status === "awaiting_signature" || c.status === "scheduled") && <TextLink tone="danger" size="xs" onClick={() => cancel(c)}>Cancel</TextLink>}
          </div>
        </div>
      ))}
      {busy && <p className="px-4 py-2 text-xs text-neutral-400">{busy}</p>}
    </DetailCard>
  );
}
