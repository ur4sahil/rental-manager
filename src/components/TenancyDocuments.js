import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { Btn, TextLink, DetailCard, MenuItem } from "../ui";
import { fmtDate, fmtDateTime, getSignedUrl } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { resendSignatureRequest, voidEnvelope, summarizeSends, signingMailto } from "../utils/docService";

// ============ A TENANCY'S DOCUMENTS ============
// The leases, renewals, addenda and notices made for one tenant (or one
// lease) in the Document Builder, with where each one stands: draft, out
// for signature and who has signed, signed by everyone, cancelled.
//
// One component, because the same list belongs on the tenant's page, in the
// Leases tab and (later) on a court case, and three copies would drift the
// way the three lease generators did. "New" opens the Document Builder with
// the tenant already chosen: no screen writes its own lease text any more.
//
//   actions = [{ label, templateKey } | { label, onClick }]   what can be started from here
//   returnTo = { page, action }          where the builder comes back to

export const DOC_KIND_LABEL = {
  lease: "Lease", renewal: "Renewal", addendum: "Addendum", rent_increase_notice: "Rent increase notice",
  notice_to_vacate: "Notice to vacate", move_out_acknowledgment: "Move-out acknowledgment", late_notice: "Late notice",
  notice_of_intent: "Notice of intent", ftpr_complaint: "Court complaint", court_other: "Court form",
  move_out_statement: "Move-out statement", deposit_disposition: "Deposit letter", letter: "Letter", other: "Document",
};
const SIG_LABEL = { pending: "waiting their turn", sent: "emailed", viewed: "opened", signed: "signed", declined: "declined", voided: "cancelled" };

/** Where a generated document stands, in words. Exported for tests and for badges elsewhere. */
export function docStanding(doc, signers = []) {
  const st = doc?.envelope_status || "draft";
  const live = signers.filter(s => s.status !== "voided");
  const done = live.filter(s => s.status === "signed").length;
  if (st === "completed") return { key: "signed", label: "Signed by everyone", tone: "positive" };
  if (st === "out_for_signature") return { key: "out", label: live.length ? `Out for signature · ${done} of ${live.length} signed` : "Out for signature", tone: "warn" };
  if (st === "voided") return { key: "cancelled", label: "Cancelled", tone: "neutral" };
  if (st === "declined") return { key: "declined", label: "Declined", tone: "danger" };
  if (doc?.served_at) return { key: "served", label: "Served " + fmtDate(doc.served_at), tone: "positive" };
  if (doc?.sent_at) return { key: "sent", label: "Emailed " + fmtDate(doc.sent_at), tone: "neutral" };
  return { key: "draft", label: "Not sent", tone: "neutral" };
}
const TONE = { positive: "text-positive-700", warn: "text-warn-700", danger: "text-danger-600", neutral: "text-neutral-400" };

export function TenancyDocuments({ companyId, tenantId = null, leaseId = null, title = "Lease and notices", actions = [], setPage, returnTo = null, showToast, showConfirm, canAct = true, emptyText = "Nothing has been created yet.", onChanged, kinds = null }) {
  const [docs, setDocs] = useState(null);
  const [sigs, setSigs] = useState([]);
  const [busy, setBusy] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  // A caller's inline array is a new object every render; key on its contents.
  const kindsKey = (kinds || []).join(",");
  const load = useCallback(async () => {
    if (tenantId == null && !leaseId) { setDocs([]); return; }
    const kindList = kindsKey ? kindsKey.split(",") : [];
    let q = supabase.from("doc_generated")
      .select("id, name, doc_kind, envelope_status, created_at, sent_at, envelope_sent_at, envelope_completed_at, void_reason, signed_pdf_path, pdf_output_path, served_at, served_method, effective_date, lease_id, tenant_id")
      .eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }).limit(50);
    q = leaseId ? q.eq("lease_id", leaseId) : q.eq("tenant_id", Number(tenantId));
    if (kindList.length) q = q.in("doc_kind", kindList);
    const { data, error } = await q;
    if (error) { pmError("PM-8006", { raw: error, context: "load tenancy documents", silent: true }); setDocs([]); return; }
    const rows = data || [];
    let s = [];
    if (rows.length) {
      // .in() is capped at 100 ids per request; the list above is capped at 50.
      const r = await supabase.from("doc_signatures")
        .select("id, doc_id, signer_role, signer_name, signer_email, sign_order, status, signed_at, access_token")
        .eq("company_id", companyId).in("doc_id", rows.map(d => d.id)).order("sign_order");
      s = r.data || [];
    }
    setSigs(s);
    setDocs(rows);
  }, [companyId, tenantId, leaseId, kindsKey]);
  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); if (onChanged) onChanged(); };

  function start(action) {
    setMenuOpen(false);
    // Some things need a question answered first (a renewal's dates, the
    // new rent): those open their own dialog, which then opens the builder.
    if (action.onClick) { action.onClick(); return; }
    if (!setPage) return;
    setPage("doc_builder", { templateKey: action.templateKey, tenantId: tenantId != null ? Number(tenantId) : undefined, leaseId: leaseId || undefined, returnTo });
  }
  async function remind(sig) {
    setBusy("Sending reminder…");
    const r = await resendSignatureRequest(companyId, sig.id);
    setBusy("");
    if (!r.ok) { showToast("The reminder could not be sent: " + r.error, "error"); return; }
    const sum = summarizeSends([{ status: r.status, email: sig.signer_email, delivered_to: r.delivered_to, error: r.error }]);
    showToast("Reminder to " + (sig.signer_name || sig.signer_email) + ": " + sum.text, sum.tone);
    changed();
  }
  async function copyLink(sig) {
    const url = window.location.origin + "/sign/" + sig.access_token;
    try { await navigator.clipboard.writeText(url); showToast("Signing link copied", "success"); }
    catch { showToast("Copy failed. The link is: " + url, "info"); }
  }
  async function cancel(doc) {
    if (showConfirm && !await showConfirm({ message: `Cancel the signature request for "${doc.name}"? The signing links stop working. Nobody is emailed about it.`, confirmText: "Cancel request" })) return;
    setBusy("Cancelling…");
    const r = await voidEnvelope(companyId, doc.id, "Cancelled by staff");
    setBusy("");
    if (!r.ok) { showToast("The request could not be cancelled: " + r.error, "error"); return; }
    showToast("Signature request cancelled", "success");
    changed();
  }
  async function openPdf(path) {
    const url = await getSignedUrl("documents", path);
    if (!url) { showToast("That file could not be opened.", "error"); return; }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const headerAction = !canAct || !actions.length ? null
    : actions.length === 1
      ? <TextLink tone="brand" size="xs" onClick={() => start(actions[0])}>{actions[0].label}</TextLink>
      : (
        <div className="relative">
          <Btn variant="secondary" size="sm" onClick={() => setMenuOpen(o => !o)} aria-haspopup="menu" aria-expanded={menuOpen}>New…</Btn>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div role="menu" className="absolute right-0 mt-1 z-20 w-60 bg-white border border-neutral-200 rounded-xl shadow-pop py-1">
                {actions.map(a => <MenuItem key={(a.templateKey || "") + a.label} onClick={() => start(a)}>{a.label}</MenuItem>)}
              </div>
            </>
          )}
        </div>
      );

  return (
    <DetailCard title={title} sub={docs?.length ? String(docs.length) : null} action={headerAction} flush>
      {docs === null ? (
        <p className="px-4 py-6 text-sm text-neutral-400 text-center">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="px-4 py-6 text-sm text-neutral-400 text-center">{emptyText}</p>
      ) : docs.map(d => {
        const signers = sigs.filter(s => s.doc_id === d.id);
        const standing = docStanding(d, signers);
        const out = d.envelope_status === "out_for_signature";
        return (
          <div key={d.id} className="px-4 py-3 border-b border-brand-50 last:border-b-0">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-neutral-700 truncate" title={d.name}>{d.name}</div>
                <div className="text-xs text-neutral-400">
                  {DOC_KIND_LABEL[d.doc_kind] || "Document"} · <span className={TONE[standing.tone]}>{standing.label}</span>
                  {d.envelope_status === "voided" && d.void_reason ? ` · ${d.void_reason}` : ""}
                  {" · "}{fmtDate(d.envelope_completed_at || d.envelope_sent_at || d.created_at)}
                </div>
              </div>
              {out && canAct && <TextLink tone="danger" size="xs" onClick={() => cancel(d)}>Cancel request</TextLink>}
              {d.envelope_status === "completed" && d.signed_pdf_path && <TextLink tone="brand" size="xs" onClick={() => openPdf(d.signed_pdf_path)}>Signed copy</TextLink>}
              {d.envelope_status !== "completed" && !out && d.pdf_output_path && <TextLink tone="brand" size="xs" onClick={() => openPdf(d.pdf_output_path)}>PDF</TextLink>}
            </div>
            {out && signers.filter(s => s.status !== "voided").map(s => (
              <div key={s.id} className="flex items-center gap-2 text-xs mt-1.5 pl-1">
                <span className={"material-icons-outlined text-sm " + (s.status === "signed" ? "text-positive-600" : "text-neutral-300")}>{s.status === "signed" ? "check_circle" : "radio_button_unchecked"}</span>
                <span className="flex-1 min-w-0 truncate text-neutral-600">{s.signer_name || s.signer_email} <span className="text-neutral-400">· {SIG_LABEL[s.status] || s.status}{s.status === "signed" && s.signed_at ? " " + fmtDateTime(s.signed_at) : ""}</span></span>
                {canAct && ["sent", "viewed"].includes(s.status) && (<>
                  <TextLink tone="neutral" size="xs" onClick={() => copyLink(s)}>Copy link</TextLink>
                  {/* From the device's own mail app: a real link, so it opens
                      straight from the click. Not logged: the app cannot see it sent. */}
                  <a className="text-xs text-neutral-500 underline hover:text-brand-600" title="Opens a draft in your own mail app, with their signing link" href={signingMailto({ signer: s, docName: d.name, origin: window.location.origin })}>My mail app</a>
                  <TextLink tone="brand" size="xs" onClick={() => remind(s)}>Remind</TextLink>
                </>)}
              </div>
            ))}
          </div>
        );
      })}
      {busy && <p className="px-4 py-2 text-xs text-neutral-400">{busy}</p>}
    </DetailCard>
  );
}
