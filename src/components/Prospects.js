import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { supabase } from "../supabase";
import { Input, MoneyInput, Textarea, Btn, PageHeader, FormField, FilterPill, DataTable, EmptyState, TextLink, Badge, Alert, Checkbox, DetailPanel, DetailRow, DetailCard, DetailAlert } from "../ui";
import { safeNum, formatLocalDate, formatCurrency, fmtDate, fmtDateTime, propertyLabel, formatPhoneInput, isValidEmail, normalizeEmail, getSignedUrl } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { resendSignatureRequest, voidEnvelope, summarizeSends } from "../utils/docService";
import { planTenancyCharges, describeTenancyCharges } from "../utils/onboardingRules";
import { startTenancyBooks } from "../utils/tenantOnboarding";
import { heldForProspect, recordProspectMoney, refundProspectMoney } from "../utils/prospectMoney";
import { Spinner, Modal, PropertySelect, DocUploadModal } from "./shared";

// ============ PROSPECTS ============
// People who may become tenants. A prospect can be sent a lease and can
// sign it, and nothing reaches the books until they are converted: no
// tenant record, no ledger, no deposit, no rent. Adding a tenant directly
// (the Tenants page, the property wizard) is unchanged and is still how a
// tenant onboarded outside the app gets in.

const LEASE_TEMPLATE_KEY = "md_residential_lease";
const LIVE = ["active", "current", "notice"];
const STATUS = {
  new:        { label: "New",        color: "gray" },
  lease_sent: { label: "Lease sent", color: "yellow" },
  signed:     { label: "Signed",     color: "green" },
  converted:  { label: "Tenant",     color: "indigo" },
  lost:       { label: "Lost",       color: "red" },
};
const FILTERS = [
  ["open", "Open"], ["new", "New"], ["lease_sent", "Lease sent"], ["signed", "Signed"], ["converted", "Converted"], ["lost", "Lost"],
];
const SIG_LABEL = { pending: "waiting their turn", sent: "emailed", viewed: "opened", signed: "signed", declined: "declined", voided: "cancelled" };
const ENVELOPE_LABEL = { draft: "Draft", out_for_signature: "Out for signature", completed: "Signed by everyone", voided: "Cancelled", declined: "Declined" };
const EMPTY_FORM = {
  first_name: "", last_name: "", email: "", phone: "", co_applicants: [],
  property: "", property_id: null, lease_start: "", lease_end: "", rent: "", security_deposit: "",
  landlord_utilities: "", tenant_utilities: "", notes: "",
};
const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";
const fullName = (f) => [f.first_name, f.last_name].map(v => String(v || "").trim()).filter(Boolean).join(" ");
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

function Prospects({ addNotification, userProfile, userRole, companyId, showToast, showConfirm, setPage, initialAction }) {
  const [loading, setLoading] = useState(true);
  const [prospects, setProspects] = useState([]);
  const [properties, setProperties] = useState([]);
  const [occupants, setOccupants] = useState([]);      // live tenants, to say whether a unit is vacant
  const [docs, setDocs] = useState([]);                // doc_generated rows for prospects
  const [sigs, setSigs] = useState([]);                // doc_signatures for those
  const [files, setFiles] = useState([]);              // uploaded documents for prospects
  const [filter, setFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(null);              // { ...EMPTY_FORM, id? } while the add/edit dialog is open
  const [saving, setSaving] = useState(false);
  const [converting, setConverting] = useState(null);  // { prospect, signedOutside }
  const [busy, setBusy] = useState("");                // a short label while an action runs
  const [lostFor, setLostFor] = useState(null);        // { prospect, reason }
  const [uploadFor, setUploadFor] = useState(null);
  const [held, setHeld] = useState(null);              // { prospectId, ok, balance, entries, account } for the open prospect
  const [moneyFor, setMoneyFor] = useState(null);      // { prospect, kind: "receive"|"refund", amount, date, memo }
  const handledAction = useRef(null);

  const load = useCallback(async () => {
    const { data: rows, error } = await supabase.from("prospects").select("*").eq("company_id", companyId).is("archived_at", null).order("updated_at", { ascending: false });
    if (error) { pmError("PM-8006", { raw: error, context: "load prospects" }); setLoading(false); return; }
    const list = rows || [];
    const ids = list.map(p => p.id);
    const [props, tens] = await Promise.all([
      supabase.from("properties").select("id, address, status, tenant").eq("company_id", companyId).is("archived_at", null).order("address"),
      supabase.from("tenants").select("id, name, property, property_id, lease_status, move_out").eq("company_id", companyId).is("archived_at", null),
    ]);
    // .in() is capped at 100 ids per request.
    const docRows = [], fileRows = [];
    for (const part of chunk(ids, 100)) {
      const [d, f] = await Promise.all([
        supabase.from("doc_generated").select("id, name, prospect_id, property_id, doc_kind, envelope_status, created_at, envelope_sent_at, envelope_completed_at, void_reason, signed_pdf_path, filed_document_id").eq("company_id", companyId).is("archived_at", null).in("prospect_id", part).order("created_at", { ascending: false }),
        supabase.from("documents").select("id, name, type, url, file_name, uploaded_at, prospect_id").eq("company_id", companyId).is("archived_at", null).in("prospect_id", part).order("uploaded_at", { ascending: false }),
      ]);
      docRows.push(...(d.data || [])); fileRows.push(...(f.data || []));
    }
    const sigRows = [];
    for (const part of chunk(docRows.map(d => d.id), 100)) {
      const { data } = await supabase.from("doc_signatures").select("id, doc_id, signer_role, signer_name, signer_email, sign_order, status, signed_at, request_emailed_at, reminder_count, last_reminded_at").in("doc_id", part).order("sign_order");
      sigRows.push(...(data || []));
    }
    setProspects(list);
    setProperties(props.data || []);
    setOccupants((tens.data || []).filter(t => LIVE.includes(String(t.lease_status || "").toLowerCase())));
    setDocs(docRows); setSigs(sigRows); setFiles(fileRows);
    setLoading(false);
  }, [companyId]);
  useEffect(() => { load(); }, [load]);

  // Arriving back from the Document Builder (or a link): open that prospect.
  useEffect(() => {
    const id = initialAction?.openProspectId;
    if (!id || handledAction.current === initialAction || loading) return;
    handledAction.current = initialAction;
    if (prospects.some(p => p.id === id)) setSelectedId(id);
  }, [initialAction, loading, prospects]);

  // What is held for the prospect on screen (or the one being converted),
  // read off the ledger each time: money may have been categorised to them on
  // the Banking page since this page was opened.
  const heldProspectId = converting?.prospect?.id || selectedId || null;
  const loadHeld = useCallback(async (id) => {
    if (!id) { setHeld(null); return; }
    const h = await heldForProspect(companyId, id);
    setHeld({ prospectId: id, ...h });
  }, [companyId]);
  useEffect(() => { setHeld(null); loadHeld(heldProspectId); }, [heldProspectId, loadHeld]);
  const heldOf = (id) => (held && held.prospectId === id ? held : null);

  const propById = useMemo(() => Object.fromEntries(properties.map(p => [p.id, p])), [properties]);
  const occupantOf = useCallback((propertyId) => {
    const prop = propById[propertyId];
    if (!prop) return null;
    return occupants.find(t => t.property_id === prop.id || t.property === prop.address) || null;
  }, [propById, occupants]);
  // A tenant who has given (or been given) notice has a move-out date: the
  // home is spoken for until then and free after.
  const untilOf = (occ) => (occ && String(occ.lease_status || "").toLowerCase() === "notice" && occ.move_out ? occ.move_out : null);
  const docsOf = useCallback((id) => docs.filter(d => d.prospect_id === id), [docs]);
  const leaseOf = useCallback((id) => {
    const leases = docsOf(id).filter(d => d.doc_kind === "lease");
    return leases.find(d => d.envelope_status === "completed") || leases.find(d => d.envelope_status === "out_for_signature") || leases[0] || null;
  }, [docsOf]);
  const sigsOf = useCallback((docId) => sigs.filter(s => s.doc_id === docId), [sigs]);
  // Someone else has already signed (or been converted) for the same property.
  const rivalOf = useCallback((p) => p.property_id == null ? null
    : prospects.find(o => o.id !== p.id && o.property_id === p.property_id && ["signed", "converted"].includes(o.status)) || null, [prospects]);

  const counts = useMemo(() => {
    const c = { open: 0 };
    for (const p of prospects) { c[p.status] = (c[p.status] || 0) + 1; if (["new", "lease_sent", "signed"].includes(p.status)) c.open++; }
    return c;
  }, [prospects]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return prospects.filter(p => (filter === "open" ? ["new", "lease_sent", "signed"].includes(p.status) : p.status === filter))
      .filter(p => !q || [p.name, p.email, p.phone, p.property, ...(p.co_applicants || []).map(c => c?.name)].some(v => String(v || "").toLowerCase().includes(q)));
  }, [prospects, filter, search]);
  const needsAttention = useMemo(() => prospects.filter(p => p.attention), [prospects]);
  const selected = prospects.find(p => p.id === selectedId) || null;

  // ── add / edit ──────────────────────────────────────────────────────
  function openAdd() { setForm({ ...EMPTY_FORM, co_applicants: [] }); }
  function openEdit(p) {
    setForm({
      id: p.id, first_name: p.first_name || (p.last_name ? "" : p.name || ""), last_name: p.last_name || "", email: p.email || "", phone: p.phone || "",
      co_applicants: (Array.isArray(p.co_applicants) ? p.co_applicants : []).map(c => ({ name: c?.name || "", email: c?.email || "", phone: c?.phone || "" })),
      property: p.property || propById[p.property_id]?.address || "", property_id: p.property_id ?? null,
      lease_start: p.lease_start || "", lease_end: p.lease_end || "",
      rent: p.rent != null ? String(p.rent) : "", security_deposit: p.security_deposit != null ? String(p.security_deposit) : "",
      landlord_utilities: p.landlord_utilities || "", tenant_utilities: p.tenant_utilities || "", notes: p.notes || "",
    });
  }
  async function saveProspect() {
    if (!form || !guardSubmit("saveProspect")) return;
    try {
      const name = fullName(form);
      if (!name) { showToast("The prospect needs a name.", "error"); return; }
      if (form.email && !isValidEmail(form.email)) { showToast("That email address does not look right.", "error"); return; }
      const others = form.co_applicants.map(c => ({ name: String(c.name || "").trim(), email: normalizeEmail(c.email || "") || "", phone: String(c.phone || "").trim() })).filter(c => c.name || c.email || c.phone);
      if (others.some(c => !c.name)) { showToast("Each co-applicant needs a name.", "error"); return; }
      if (others.some(c => c.email && !isValidEmail(c.email))) { showToast("One of the co-applicant emails does not look right.", "error"); return; }
      if (form.lease_start && form.lease_end && form.lease_end <= form.lease_start) { showToast("The lease end date must be after the start date.", "error"); return; }
      const money = (v) => (String(v ?? "").trim() === "" ? null : safeNum(v));
      const payload = {
        name, first_name: String(form.first_name || "").trim(), last_name: String(form.last_name || "").trim(),
        email: form.email ? normalizeEmail(form.email) : null, phone: form.phone || null, co_applicants: others,
        property_id: form.property_id ?? null, property: form.property || null,
        lease_start: form.lease_start || null, lease_end: form.lease_end || null,
        rent: money(form.rent), security_deposit: money(form.security_deposit),
        landlord_utilities: form.landlord_utilities || null, tenant_utilities: form.tenant_utilities || null,
        notes: form.notes || null, updated_at: new Date().toISOString(),
      };
      setSaving(true);
      if (form.id) {
        const { error } = await supabase.from("prospects").update(payload).eq("company_id", companyId).eq("id", form.id);
        if (error) { pmError("PM-8006", { raw: error, context: "update prospect" }); return; }
        logAudit("update", "prospects", "Updated prospect: " + name, form.id, userProfile?.email, userRole, companyId);
        showToast("Prospect saved", "success");
      } else {
        const { data, error } = await supabase.from("prospects").insert([{ ...payload, company_id: companyId, created_by: userProfile?.email || "" }]).select("id").maybeSingle();
        if (error) { pmError("PM-8006", { raw: error, context: "add prospect" }); return; }
        logAudit("create", "prospects", "Added prospect: " + name, data?.id, userProfile?.email, userRole, companyId);
        showToast("Prospect added", "success");
        if (data?.id) setSelectedId(data.id);
      }
      setForm(null);
      await load();
    } finally { setSaving(false); guardRelease("saveProspect"); }
  }

  // ── lease ───────────────────────────────────────────────────────────
  function createLease(p) {
    if (p.property_id == null) { showToast("Choose the property for this prospect first.", "error"); openEdit(p); return; }
    const out = docsOf(p.id).find(d => d.doc_kind === "lease" && d.envelope_status === "out_for_signature");
    if (out) { showToast("A lease is already out for signature. Cancel that request before sending another.", "error"); return; }
    if (!setPage) return;
    setPage("doc_builder", { templateKey: LEASE_TEMPLATE_KEY, prospectId: p.id, returnTo: { page: "prospects", action: { openProspectId: p.id } } });
  }
  async function resend(sig) {
    setBusy("Sending reminder…");
    const r = await resendSignatureRequest(companyId, sig.id);
    setBusy("");
    if (!r.ok) { showToast("The reminder could not be sent: " + r.error, "error"); return; }
    const sum = summarizeSends([{ status: r.status, email: sig.signer_email, delivered_to: r.delivered_to, error: r.error }]);
    showToast("Reminder to " + (sig.signer_name || sig.signer_email) + ": " + sum.text, sum.tone);
    load();
  }
  async function cancelLease(doc, p) {
    if (!await showConfirm({ message: `Cancel the signature request for "${doc.name}"? The signing links stop working. ${p.name} is not emailed about it.`, confirmText: "Cancel request" })) return;
    setBusy("Cancelling…");
    const r = await voidEnvelope(companyId, doc.id, "Cancelled from the Prospects page");
    setBusy("");
    if (!r.ok) { showToast("The request could not be cancelled: " + r.error, "error"); return; }
    showToast("Signature request cancelled", "success");
    load();
  }
  async function openFile(pathOrFile) {
    const url = await getSignedUrl("documents", pathOrFile);
    if (!url) { showToast("That file could not be opened.", "error"); return; }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // ── status changes ──────────────────────────────────────────────────
  async function markLost() {
    if (!lostFor) return;
    const { prospect: p, reason } = lostFor;
    setBusy("Saving…");
    // A lease still out for signature must not stay signable.
    for (const d of docsOf(p.id).filter(x => x.envelope_status === "out_for_signature")) {
      const r = await voidEnvelope(companyId, d.id, "Prospect marked lost" + (reason ? ": " + reason : ""));
      if (!r.ok) { setBusy(""); showToast("The lease that is out for signature could not be cancelled (" + r.error + "), so nothing was changed.", "error"); return; }
    }
    const { error } = await supabase.from("prospects").update({ status: "lost", lost_reason: reason || null, attention: null, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", p.id);
    setBusy("");
    if (error) { pmError("PM-8006", { raw: error, context: "mark prospect lost" }); return; }
    logAudit("update", "prospects", "Marked lost: " + p.name + (reason ? " — " + reason : ""), p.id, userProfile?.email, userRole, companyId);
    setLostFor(null);
    showToast(p.name + " marked lost", "success");
    load();
  }
  async function reopen(p) {
    const signedLease = docsOf(p.id).some(d => d.doc_kind === "lease" && d.envelope_status === "completed");
    const { error } = await supabase.from("prospects").update({ status: signedLease ? "signed" : "new", lost_reason: null, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", p.id);
    if (error) { pmError("PM-8006", { raw: error, context: "reopen prospect" }); return; }
    showToast(p.name + " reopened", "success");
    load();
  }
  async function archive(p) {
    if (docsOf(p.id).some(d => d.envelope_status === "out_for_signature")) { showToast("A lease is still out for signature. Cancel that request first.", "error"); return; }
    // Money still held for them must go somewhere first: back to them, or
    // (once converted) onto their ledger.
    const h = await heldForProspect(companyId, p.id);
    if (!h.ok) { showToast("Could not check whether money is held for " + p.name + ". Try again.", "error"); return; }
    if (Math.abs(h.balance) > 0.004) { showToast(formatCurrency(h.balance) + " is still held for " + p.name + ". Refund it before removing them.", "error"); return; }
    if (!await showConfirm({ message: `Remove ${p.name} from Prospects? Their record and files are kept in the archive.`, confirmText: "Remove" })) return;
    const { error } = await supabase.from("prospects").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email || "" }).eq("company_id", companyId).eq("id", p.id);
    if (error) { pmError("PM-8006", { raw: error, context: "archive prospect" }); return; }
    logAudit("archive", "prospects", "Removed prospect: " + p.name, p.id, userProfile?.email, userRole, companyId);
    setSelectedId(null);
    showToast(p.name + " removed", "success");
    load();
  }
  async function dismissAttention(p) {
    const { error } = await supabase.from("prospects").update({ attention: null }).eq("company_id", companyId).eq("id", p.id);
    if (error) { pmError("PM-8006", { raw: error, context: "dismiss prospect note" }); return; }
    load();
  }

  // ── money received before move-in ───────────────────────────────────
  async function saveMoney() {
    if (!moneyFor || !guardSubmit("prospectMoney", moneyFor.prospect.id)) return;
    const { prospect: p, kind } = moneyFor;
    try {
      setBusy("Saving…");
      const args = { companyId, prospect: p, amount: safeNum(moneyFor.amount), date: moneyFor.date, memo: String(moneyFor.memo || "").trim() };
      const r = kind === "refund" ? await refundProspectMoney(args) : await recordProspectMoney(args);
      if (!r.ok) { showToast(r.error, "error"); return; }
      logAudit("create", "prospects", (kind === "refund" ? "Refunded " : "Recorded money received ") + formatCurrency(args.amount) + (kind === "refund" ? " to " : " from ") + p.name, p.id, userProfile?.email, userRole, companyId);
      showToast(kind === "refund" ? formatCurrency(args.amount) + " refunded to " + p.name : formatCurrency(args.amount) + " recorded for " + p.name, "success");
      setMoneyFor(null);
      await loadHeld(p.id);
    } finally { setBusy(""); guardRelease("prospectMoney", p.id); }
  }

  // ── convert ─────────────────────────────────────────────────────────
  async function runBooks(p, t) {
    const res = await startTenancyBooks({
      companyId, tenantId: t.tenant_id, tenantName: t.tenant_name, property: t.property,
      leaseStart: t.lease_start, rent: safeNum(t.rent), deposit: safeNum(t.security_deposit), userEmail: userProfile?.email || "",
      prospectId: p.id,
    });
    const note = res.ok ? null : "Converted, but not everything was posted to the books: " + res.failures.join("; ") + ". Press Finish setup to try again.";
    await supabase.from("prospects").update({ attention: note, updated_at: new Date().toISOString() }).eq("company_id", companyId).eq("id", p.id);
    return res;
  }
  async function convert() {
    if (!converting || !guardSubmit("convertProspect", converting.prospect.id)) return;
    const p = converting.prospect;
    try {
      setBusy("Converting…");
      const { data, error } = await supabase.rpc("convert_prospect_to_tenant", { p_prospect_id: p.id, p_signed_outside: !!converting.signedOutside });
      if (error) {
        // The database's own message is written for the person reading it.
        showToast(error.message || "The prospect could not be converted.", "error");
        if (!error.hint) pmError("PM-8006", { raw: error, context: "convert prospect", silent: true });
        return;
      }
      if (data?.already_converted) { showToast(p.name + " is already a tenant.", "info"); setConverting(null); await load(); return; }
      setBusy("Setting up the books…");
      const res = await runBooks(p, data);
      logAudit("create", "prospects", "Converted to tenant: " + p.name, String(data.tenant_id), userProfile?.email, userRole, companyId);
      if (addNotification) addNotification("🏠", p.name + " is now a tenant");
      setConverting(null);
      if (res.ok) showToast(p.name + " is now a tenant. Deposit, first month's rent and the monthly schedule are set up.", "success");
      else showToast(p.name + " is now a tenant, but some entries were not posted: " + res.failures.join("; ") + ". Open the prospect and press Finish setup.", "warning");
      await load();
      loadHeld(p.id);
    } finally { setBusy(""); guardRelease("convertProspect", p.id); }
  }
  async function finishSetup(p) {
    if (!p.converted_tenant_id || !guardSubmit("finishProspect", p.id)) return;
    try {
      setBusy("Setting up the books…");
      const { data: t, error } = await supabase.from("tenants").select("id, name, property, lease_start, rent, security_deposit").eq("company_id", companyId).eq("id", p.converted_tenant_id).maybeSingle();
      if (error || !t) { showToast("The tenant record could not be found.", "error"); return; }
      const res = await runBooks(p, { tenant_id: t.id, tenant_name: t.name, property: t.property, lease_start: t.lease_start || p.lease_start, rent: t.rent ?? p.rent, security_deposit: t.security_deposit ?? p.security_deposit });
      if (res.ok) showToast("The books are set up for " + t.name + ".", "success");
      else showToast("Still not posted: " + res.failures.join("; "), "error");
      await load();
      loadHeld(p.id);
    } finally { setBusy(""); guardRelease("finishProspect", p.id); }
  }

  if (loading) return <Spinner />;

  // ══════════ DETAIL ══════════
  if (selected) {
    const p = selected;
    const st = STATUS[p.status] || STATUS.new;
    const prop = propById[p.property_id] || null;
    const occupant = p.property_id != null ? occupantOf(p.property_id) : null;
    const lease = leaseOf(p.id);
    const myDocs = docsOf(p.id);
    const myFiles = files.filter(f => f.prospect_id === p.id);
    const rival = rivalOf(p);
    const others = Array.isArray(p.co_applicants) ? p.co_applicants.filter(c => c?.name) : [];
    const leaseOut = myDocs.find(d => d.doc_kind === "lease" && d.envelope_status === "out_for_signature");
    const canConvert = ["new", "lease_sent", "signed"].includes(p.status);
    const missing = [p.property_id == null && "a property", !p.lease_start && "a lease start date", !p.lease_end && "a lease end date", !(safeNum(p.rent) > 0) && "the rent"].filter(Boolean);
    const next = p.status === "converted" ? null
      : p.status === "lost" ? null
      : p.status === "signed" ? (occupant ? `The lease is signed. ${occupant.name} is still the tenant here, so ${p.name} can be converted once they have moved out.` : "The lease is signed and the property is vacant: ready to convert.")
      : p.status === "lease_sent" ? "Waiting for signatures."
      : missing.length ? "Before a lease can be sent, add " + missing.join(", ") + "."
      : "Next: create the lease and send it for signature.";

    return (
      <div className="max-w-[1180px] mx-auto pb-16">
        <div className="text-sm text-neutral-400 mb-2.5">
          <TextLink tone="neutral" size="xs" onClick={() => setSelectedId(null)}>Prospects</TextLink>
          <span className="mx-1.5">›</span><span>{p.name}</span>
        </div>

        <div className="bg-white border border-brand-50 rounded-2xl p-5 mb-3.5">
          <div className="flex gap-4 items-start flex-wrap">
            <div className="w-11 h-11 rounded-xl bg-brand-50 text-brand-700 grid place-items-center font-bold text-base shrink-0">{initials(p.name)}</div>
            <div className="flex-1 min-w-[220px]">
              <h1 className="text-2xl font-bold text-neutral-800 leading-tight">{p.name}</h1>
              <div className="text-sm text-neutral-400 mt-0.5">{prop ? prop.address : <span className="text-warn-700">No property chosen</span>}</div>
              <div className="flex gap-1.5 flex-wrap mt-2">
                <Badge label={st.label} color={st.color} />
                {others.length > 0 && <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-neutral-100 text-neutral-600">{others.length + 1} on the lease</span>}
                {prop && p.status !== "converted" && <span className={"text-xs font-semibold px-2.5 py-0.5 rounded-full " + (occupant ? "bg-warn-50 text-warn-700" : "bg-positive-50 text-positive-700")}>{occupant ? "Occupied by " + occupant.name + (untilOf(occupant) ? " until " + fmtDate(untilOf(occupant)) : "") : "Vacant"}</span>}
              </div>
            </div>
            <div className="text-right shrink-0 max-[620px]:text-left">
              <span className="block text-2xs font-semibold tracking-[0.06em] uppercase text-neutral-400">Rent</span>
              <span className="block text-3xl font-semibold tabular-nums tracking-tight mt-0.5 text-neutral-700">{safeNum(p.rent) > 0 ? formatCurrency(p.rent) : "—"}</span>
              <span className="block text-xs text-neutral-400 mt-0.5">per month</span>
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] mt-4 border border-brand-50 rounded-xl overflow-hidden bg-neutral-50/60">
            <DetailPanel title="Lease terms">
              <DetailRow label="Term"><span className="tabular-nums">{fmtDate(p.lease_start, "—")} – {fmtDate(p.lease_end, "—")}</span></DetailRow>
              <DetailRow label="Deposit">{p.security_deposit != null ? formatCurrency(p.security_deposit) : "—"}</DetailRow>
              <DetailRow label="Landlord pays">{p.landlord_utilities || "—"}</DetailRow>
              <DetailRow label="Tenant pays">{p.tenant_utilities || "—"}</DetailRow>
            </DetailPanel>
            <DetailPanel title="Contact">
              <DetailRow label="Email">{p.email ? <a className="text-brand-600 hover:underline break-all" href={"mailto:" + p.email}>{p.email}</a> : <span className="text-warn-700">None</span>}</DetailRow>
              <DetailRow label="Phone">{p.phone ? <a className="text-brand-600 hover:underline" href={"tel:" + p.phone}>{p.phone}</a> : "—"}</DetailRow>
              {others.map((c, i) => (
                <DetailRow key={i} label={"Also " + c.name}>{c.email || <span className="text-warn-700">no email</span>}</DetailRow>
              ))}
            </DetailPanel>
            <DetailPanel title="Actions">
              <div className="flex flex-wrap gap-1.5">
                {p.status !== "converted" && <Btn size="sm" variant="secondary" onClick={() => openEdit(p)}>Edit</Btn>}
                {["new", "lease_sent"].includes(p.status) && !leaseOut && <Btn size="sm" onClick={() => createLease(p)}>Create lease</Btn>}
                {canConvert && <Btn size="sm" variant="success-fill" onClick={() => setConverting({ prospect: p, signedOutside: false })}>Convert to tenant</Btn>}
                {p.status === "converted" && p.converted_tenant_id && <Btn size="sm" onClick={() => setPage && setPage("tenants", { openTenantId: p.converted_tenant_id, tenantName: p.name, panel: "detail" })}>Open tenant</Btn>}
                {p.status === "converted" && p.attention && <Btn size="sm" variant="amber" onClick={() => finishSetup(p)}>Finish setup</Btn>}
                {["new", "lease_sent", "signed"].includes(p.status) && <Btn size="sm" variant="ghost" onClick={() => setLostFor({ prospect: p, reason: "" })}>Mark lost</Btn>}
                {p.status === "lost" && <Btn size="sm" variant="secondary" onClick={() => reopen(p)}>Reopen</Btn>}
                {["lost", "converted", "new"].includes(p.status) && <Btn size="sm" variant="ghost" onClick={() => archive(p)}>Remove</Btn>}
              </div>
              {busy && <p className="text-xs text-neutral-400 mt-2">{busy}</p>}
            </DetailPanel>
          </div>
        </div>

        {p.attention && <DetailAlert fix={p.status === "converted" ? null : "Dismiss"} onFix={() => dismissAttention(p)}>{p.attention}</DetailAlert>}
        {rival && p.status !== "converted" && <DetailAlert>{rival.name} has already {rival.status === "converted" ? "moved in as the tenant" : "signed a lease"} for this property.</DetailAlert>}
        {p.status === "lost" && p.lost_reason && <DetailAlert>Marked lost: {p.lost_reason}</DetailAlert>}
        {next && <p className="text-sm text-neutral-500 mb-3 px-1">{next}</p>}
        {p.status === "converted" && <p className="text-sm text-neutral-500 mb-3 px-1">Converted to a tenant on {fmtDate(p.converted_at)}{p.converted_by ? " by " + p.converted_by : ""}. Their lease and files are now on the tenant's page.</p>}

        <div className="grid gap-3.5 md:grid-cols-2">
          <DetailCard title="Lease" sub={myDocs.length ? `${myDocs.length} document${myDocs.length === 1 ? "" : "s"}` : null}
            action={["new", "lease_sent"].includes(p.status) && !leaseOut ? <TextLink tone="brand" size="xs" onClick={() => createLease(p)}>Create lease</TextLink> : null} flush>
            {myDocs.length === 0 ? (
              <p className="px-4 py-6 text-sm text-neutral-400 text-center">No lease has been created for {p.name} yet.</p>
            ) : myDocs.map(d => {
              const signers = sigsOf(d.id);
              const done = signers.filter(s => s.status === "signed").length;
              return (
                <div key={d.id} className="px-4 py-3 border-b border-brand-50 last:border-b-0">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-neutral-700 truncate" title={d.name}>{d.name}</div>
                      <div className="text-xs text-neutral-400">
                        {ENVELOPE_LABEL[d.envelope_status] || d.envelope_status}
                        {d.envelope_status === "out_for_signature" && signers.length ? ` · ${done} of ${signers.length} signed` : ""}
                        {d.envelope_status === "voided" && d.void_reason ? ` · ${d.void_reason}` : ""}
                        {" · "}{fmtDate(d.envelope_completed_at || d.envelope_sent_at || d.created_at)}
                      </div>
                    </div>
                    {d.envelope_status === "out_for_signature" && <TextLink tone="danger" size="xs" onClick={() => cancelLease(d, p)}>Cancel request</TextLink>}
                    {d.envelope_status === "completed" && d.signed_pdf_path && <TextLink tone="brand" size="xs" onClick={() => openFile(d.signed_pdf_path)}>Signed copy</TextLink>}
                  </div>
                  {d.envelope_status === "out_for_signature" && signers.map(s => (
                    <div key={s.id} className="flex items-center gap-2 text-xs mt-1.5 pl-1">
                      <span className={"material-icons-outlined text-sm " + (s.status === "signed" ? "text-positive-600" : "text-neutral-300")}>{s.status === "signed" ? "check_circle" : "radio_button_unchecked"}</span>
                      <span className="flex-1 min-w-0 truncate text-neutral-600">{s.signer_name || s.signer_email} <span className="text-neutral-400">· {SIG_LABEL[s.status] || s.status}{s.status === "signed" && s.signed_at ? " " + fmtDateTime(s.signed_at) : ""}</span></span>
                      {["sent", "viewed"].includes(s.status) && <TextLink tone="brand" size="xs" onClick={() => resend(s)}>Remind</TextLink>}
                    </div>
                  ))}
                </div>
              );
            })}
          </DetailCard>

          <DetailCard title="Files" sub={myFiles.length ? String(myFiles.length) : null}
            action={p.status !== "converted" ? <TextLink tone="brand" size="xs" onClick={() => setUploadFor(p)}>Upload</TextLink> : null} flush>
            {myFiles.length === 0 ? (
              <p className="px-4 py-6 text-sm text-neutral-400 text-center">{p.status === "converted" ? "Their files moved to the tenant's page." : "ID, pay stubs, the application: upload them here. They follow the prospect when they become a tenant."}</p>
            ) : myFiles.map(f => (
              <div key={f.id} className="flex items-center gap-2 px-4 py-2.5 border-b border-brand-50 last:border-b-0 text-sm">
                <span className="material-icons-outlined text-base text-neutral-300">description</span>
                <span className="flex-1 min-w-0 truncate text-neutral-700" title={f.name}>{f.name}</span>
                <span className="text-xs text-neutral-400">{f.type}</span>
                <TextLink tone="brand" size="xs" onClick={() => openFile(f.url || f.file_name)}>Open</TextLink>
              </div>
            ))}
          </DetailCard>

          {(() => {
            const h = heldOf(p.id);
            const open = ["new", "lease_sent", "signed"].includes(p.status);
            // Converted with nothing ever received: nothing to show.
            if (!open && (!h || (!h.account && !h.entries.length))) return null;
            return (
              <DetailCard title="Money received" sub={h?.ok && h.balance ? formatCurrency(h.balance) + " held" : null}
                action={open ? (
                  <span className="flex gap-3">
                    {h?.ok && h.balance > 0.004 && <TextLink tone="neutral" size="xs" onClick={() => setMoneyFor({ prospect: p, kind: "refund", amount: String(h.balance), date: formatLocalDate(new Date()), memo: "" })}>Refund</TextLink>}
                    <TextLink tone="brand" size="xs" onClick={() => setMoneyFor({ prospect: p, kind: "receive", amount: "", date: formatLocalDate(new Date()), memo: "" })}>Record money</TextLink>
                  </span>
                ) : null} flush>
                {!h ? (
                  <p className="px-4 py-6 text-sm text-neutral-400 text-center">Checking…</p>
                ) : !h.ok ? (
                  <p className="px-4 py-6 text-sm text-danger-600 text-center">What is held could not be read: {h.error}</p>
                ) : h.entries.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-neutral-400 text-center">Nothing received yet. A deposit paid before move-in is held here, off the tenant ledgers, and moves to their ledger when they are converted.</p>
                ) : (<>
                  {h.entries.map(e => (
                    <div key={e.id} className="flex items-center gap-2 px-4 py-2.5 border-b border-brand-50 last:border-b-0 text-sm">
                      <span className="text-neutral-400 tabular-nums whitespace-nowrap">{fmtDate(e.date)}</span>
                      <span className="flex-1 min-w-0 truncate text-neutral-700" title={e.description}>{e.description}</span>
                      <span className={"tabular-nums font-medium whitespace-nowrap " + (e.amount < 0 ? "text-neutral-500" : "text-positive-700")}>{e.amount < 0 ? "−" : ""}{formatCurrency(Math.abs(e.amount))}</span>
                    </div>
                  ))}
                  {h.account && <p className="px-4 py-2 text-xs text-neutral-400 border-t border-brand-50">Account {h.account.code}. A bank deposit from {p.name} can be categorised to it on the Banking page instead of being recorded here.</p>}
                </>)}
              </DetailCard>
            );
          })()}

          <DetailCard title="Notes">
            {p.notes ? <p className="text-sm text-neutral-600 whitespace-pre-wrap">{p.notes}</p> : <p className="text-sm text-neutral-400">No notes.</p>}
          </DetailCard>
        </div>

        {renderDialogs()}
      </div>
    );
  }

  // ══════════ LIST ══════════
  function renderDialogs() {
    const plan = converting ? planTenancyCharges({ leaseStart: converting.prospect.lease_start, rent: converting.prospect.rent, deposit: converting.prospect.security_deposit, today: formatLocalDate(new Date()) }) : null;
    const cp = converting?.prospect;
    const cOccupant = cp && cp.property_id != null ? occupantOf(cp.property_id) : null;
    const cSigned = cp ? docsOf(cp.id).some(d => d.doc_kind === "lease" && d.envelope_status === "completed") : false;
    const cOut = cp ? docsOf(cp.id).some(d => d.envelope_status === "out_for_signature") : false;
    const cHeld = cp ? heldOf(cp.id) : null;
    const blocked = cp ? (cOccupant ? `${cOccupant.name} is still the tenant at this property. Move them out first.` : !plan.ok ? plan.error : cp.property_id == null ? "Choose the property first." : !cp.lease_end ? "The lease needs an end date." : "") : "";
    return (<>
      {form && (
        <Modal title={form.id ? "Edit prospect" : "Add prospect"} onClose={() => setForm(null)}>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="First name" required><Input value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })} /></FormField>
            <FormField label="Last name"><Input value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })} /></FormField>
            <FormField label="Email"><Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" /></FormField>
            <FormField label="Phone"><Input type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: formatPhoneInput(e.target.value) })} /></FormField>

            <div className="col-span-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-neutral-500 uppercase tracking-widest">Other adults on the lease</span>
                {form.co_applicants.length < 4 && <TextLink tone="brand" size="xs" onClick={() => setForm({ ...form, co_applicants: [...form.co_applicants, { name: "", email: "", phone: "" }] })}>+ Add</TextLink>}
              </div>
              {form.co_applicants.length === 0 && <p className="text-xs text-neutral-400">None. Each one added here signs the lease too.</p>}
              {form.co_applicants.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 mb-2">
                  <Input placeholder="Full name" value={c.name} onChange={e => setForm({ ...form, co_applicants: form.co_applicants.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
                  <Input type="email" placeholder="Email" value={c.email} onChange={e => setForm({ ...form, co_applicants: form.co_applicants.map((x, j) => j === i ? { ...x, email: e.target.value } : x) })} />
                  <TextLink tone="danger" size="xs" onClick={() => setForm({ ...form, co_applicants: form.co_applicants.filter((_, j) => j !== i) })}>Remove</TextLink>
                </div>
              ))}
            </div>

            <FormField label="Property" className="col-span-2">
              <PropertySelect value={form.property} companyId={companyId} onChange={(address, prop) => setForm({ ...form, property: address, property_id: prop?.id ?? null })} />
              {form.property_id != null && occupantOf(form.property_id) && <p className="text-xs text-warn-700 mt-1">Occupied now by {occupantOf(form.property_id).name}{untilOf(occupantOf(form.property_id)) ? ", who has given notice: available from " + fmtDate(untilOf(occupantOf(form.property_id))) : ""}. A lease can be sent, but the prospect can only be converted once the property is vacant.</p>}
            </FormField>
            <FormField label="Lease start"><Input type="date" value={form.lease_start} onChange={e => setForm({ ...form, lease_start: e.target.value })} /></FormField>
            <FormField label="Lease end"><Input type="date" value={form.lease_end} onChange={e => setForm({ ...form, lease_end: e.target.value })} /></FormField>
            <FormField label="Rent per month"><MoneyInput value={form.rent} onChange={v => setForm({ ...form, rent: v })} placeholder="0.00" /></FormField>
            <FormField label="Security deposit"><MoneyInput value={form.security_deposit} onChange={v => setForm({ ...form, security_deposit: v })} placeholder="0.00" /></FormField>
            <FormField label="Utilities the landlord pays"><Input value={form.landlord_utilities} onChange={e => setForm({ ...form, landlord_utilities: e.target.value })} placeholder="e.g. Water" /></FormField>
            <FormField label="Utilities the tenant pays"><Input value={form.tenant_utilities} onChange={e => setForm({ ...form, tenant_utilities: e.target.value })} placeholder="e.g. Electric, Gas" /></FormField>
            <FormField label="Notes" className="col-span-2"><Textarea rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></FormField>
          </div>
          <div className="flex gap-2 mt-4">
            <Btn onClick={saveProspect} disabled={saving}>{saving ? "Saving…" : "Save"}</Btn>
            <Btn variant="secondary" onClick={() => setForm(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {converting && (
        <Modal title={"Convert " + cp.name + " to a tenant"} onClose={() => { if (!busy) setConverting(null); }}>
          <p className="text-sm text-neutral-600 mb-3">{cp.name} becomes the tenant at <strong>{propById[cp.property_id]?.address || "—"}</strong>, the property turns occupied, and this is posted to the books:</p>
          {plan.ok ? (
            <ul className="text-sm text-neutral-700 space-y-1.5 mb-3">
              {describeTenancyCharges(plan, formatCurrency, fmtDate).map((line, i) => (
                <li key={i} className="flex gap-2"><span className="material-icons-outlined text-base text-positive-600">check</span><span>{line}</span></li>
              ))}
            </ul>
          ) : null}
          {cHeld?.ok && cHeld.balance > 0.004 && (
            <p className="text-sm text-neutral-700 mb-3 flex gap-2"><span className="material-icons-outlined text-base text-positive-600">check</span><span>{formatCurrency(cHeld.balance)} already received is applied to their ledger as a payment</span></p>
          )}
          {cHeld && !cHeld.ok && <Alert tone="warn" className="mb-3">What is held for {cp.name} could not be read, so it cannot be applied. Try again in a moment.</Alert>}
          {blocked && <Alert tone="warn" className="mb-3">{blocked}</Alert>}
          {!blocked && !cSigned && (
            <Alert tone="warn" className="mb-3" title="The lease has not been signed in the app">
              <Checkbox label={"The lease was signed on paper" + (cOut ? ". The request that is out for signature will be cancelled." : ".")} checked={!!converting.signedOutside} onChange={e => setConverting({ ...converting, signedOutside: e.target.checked })} />
            </Alert>
          )}
          <p className="text-xs text-neutral-400 mb-4">Their lease and files move to the tenant's page. Any other applicant still holding an unsigned lease for this property has it cancelled; they are not emailed.</p>
          <div className="flex gap-2">
            <Btn variant="success-fill" onClick={convert} disabled={!!busy || !!blocked || !cHeld || !cHeld.ok || (!cSigned && !converting.signedOutside)}>{busy || "Convert to tenant"}</Btn>
            <Btn variant="secondary" onClick={() => setConverting(null)} disabled={!!busy}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {lostFor && (
        <Modal title={"Mark " + lostFor.prospect.name + " lost"} onClose={() => setLostFor(null)}>
          <FormField label="Reason (optional)"><Input value={lostFor.reason} onChange={e => setLostFor({ ...lostFor, reason: e.target.value })} placeholder="e.g. Chose another place" /></FormField>
          {docsOf(lostFor.prospect.id).some(d => d.envelope_status === "out_for_signature") && <p className="text-xs text-warn-700 mt-2">The lease that is out for signature will be cancelled. They are not emailed about it.</p>}
          {heldOf(lostFor.prospect.id)?.balance > 0.004 && <p className="text-xs text-warn-700 mt-2">{formatCurrency(heldOf(lostFor.prospect.id).balance)} is held for them. Marking them lost does not refund it: use Refund on their page.</p>}
          <div className="flex gap-2 mt-4">
            <Btn variant="danger" onClick={markLost} disabled={!!busy}>{busy || "Mark lost"}</Btn>
            <Btn variant="secondary" onClick={() => setLostFor(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {moneyFor && (
        <Modal title={(moneyFor.kind === "refund" ? "Refund " : "Money received from ") + moneyFor.prospect.name} onClose={() => { if (!busy) setMoneyFor(null); }}>
          <p className="text-sm text-neutral-500 mb-3">
            {moneyFor.kind === "refund"
              ? "Returns money that was held for them. It leaves the Checking account."
              : "Held for them, off the tenant ledgers, until they are converted. It goes into the Checking account."}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Amount" required><MoneyInput value={moneyFor.amount} onChange={v => setMoneyFor({ ...moneyFor, amount: v })} placeholder="0.00" /></FormField>
            <FormField label="Date" required><Input type="date" value={moneyFor.date} onChange={e => setMoneyFor({ ...moneyFor, date: e.target.value })} /></FormField>
            <FormField label="Note" className="col-span-2"><Input value={moneyFor.memo} onChange={e => setMoneyFor({ ...moneyFor, memo: e.target.value })} placeholder={moneyFor.kind === "refund" ? "e.g. Did not move in" : "e.g. Security deposit, Zelle"} /></FormField>
          </div>
          {moneyFor.kind === "receive" && <p className="text-xs text-neutral-400 mt-3">If this payment will also appear on the bank feed, do not record it here: categorise the bank deposit to this prospect on the Banking page, or it is counted twice.</p>}
          <div className="flex gap-2 mt-4">
            <Btn onClick={saveMoney} disabled={!!busy || !(safeNum(moneyFor.amount) > 0) || !moneyFor.date}>{busy || (moneyFor.kind === "refund" ? "Refund" : "Record")}</Btn>
            <Btn variant="secondary" onClick={() => setMoneyFor(null)} disabled={!!busy}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {uploadFor && (
        <DocUploadModal onClose={() => setUploadFor(null)} companyId={companyId} showToast={showToast} onUploaded={load}
          prospectId={uploadFor.id} property={propById[uploadFor.property_id]?.address || ""} />
      )}
    </>);
  }

  return (
    <div>
      <PageHeader title="Prospects" subtitle="People who may become tenants. Nothing reaches the books until they are converted.">
        <Input type="search" placeholder="Search name, email, property…" value={search} onChange={e => setSearch(e.target.value)} className="w-64" aria-label="Search prospects" />
        <Btn onClick={openAdd}>+ Add prospect</Btn>
      </PageHeader>

      {needsAttention.map(p => (
        <DetailAlert key={p.id} fix="Open" onFix={() => setSelectedId(p.id)}><strong>{p.name}:</strong> {p.attention}</DetailAlert>
      ))}

      <div className="flex gap-1.5 flex-wrap mb-3">
        {FILTERS.map(([key, label]) => (
          <FilterPill key={key} active={filter === key} onClick={() => setFilter(key)}>{label}{counts[key] ? ` (${counts[key]})` : ""}</FilterPill>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-neutral-200 shadow-card overflow-x-auto">
        {visible.length === 0 ? (
          <EmptyState size="compact" icon="person_search"
            title={prospects.length === 0 ? "No prospects yet" : "Nobody matches"}
            subtitle={prospects.length === 0 ? "Add someone who is interested in a property. You can send them a lease from here, and convert them to a tenant once it is signed." : "Try another filter or search."} />
        ) : (
          <DataTable
            columns={[
              { key: "name", label: "Prospect", className: "text-neutral-800",
                render: p => (<>
                  <div className="font-medium">{p.name}{(p.co_applicants || []).filter(c => c?.name).length > 0 && <span className="text-neutral-400 font-normal"> +{(p.co_applicants || []).filter(c => c?.name).length}</span>}</div>
                  <div className="text-xs text-neutral-400">{p.email || p.phone || "no contact details"}</div>
                </>) },
              { key: "property", label: "Property", className: "text-neutral-700",
                render: p => { const occ = p.property_id != null ? occupantOf(p.property_id) : null; return (<>
                  <div>{p.property_id != null ? propertyLabel(propById[p.property_id]?.address || p.property || "") : <span className="text-neutral-300">—</span>}</div>
                  {p.property_id != null && p.status !== "converted" && <div className={"text-xs " + (occ ? "text-warn-700" : "text-neutral-400")}>{occ ? (untilOf(occ) ? "available from " + fmtDate(untilOf(occ)) : "occupied") : "vacant"}</div>}
                </>); } },
              { key: "term", label: "Lease", className: "text-neutral-500 whitespace-nowrap tabular-nums",
                render: p => (<>{p.lease_start ? fmtDate(p.lease_start) + " – " + fmtDate(p.lease_end, "?") : <span className="text-neutral-300">—</span>}</>) },
              { key: "rent", label: "Rent", align: "right", className: "tnum whitespace-nowrap",
                render: p => (<>{safeNum(p.rent) > 0 ? formatCurrency(p.rent) : ""}</>) },
              { key: "status", label: "Status", className: "whitespace-nowrap",
                render: p => { const st = STATUS[p.status] || STATUS.new; const l = leaseOf(p.id); const s = l ? sigsOf(l.id) : []; return (<>
                  <Badge label={st.label} color={st.color} />
                  {p.status === "lease_sent" && s.length > 0 && <span className="text-xs text-neutral-400 ml-2">{s.filter(x => x.status === "signed").length} of {s.length} signed</span>}
                </>); } },
              { key: "updated", label: "Updated", className: "text-neutral-400 whitespace-nowrap text-xs",
                render: p => (<>{fmtDate(p.updated_at)}</>) },
            ]}
            rows={visible}
            rowKey={p => p.id}
            onRowClick={p => setSelectedId(p.id)}
            empty="Nobody matches"
          />
        )}
      </div>
      {renderDialogs()}
    </div>
  );
}

export { Prospects };
