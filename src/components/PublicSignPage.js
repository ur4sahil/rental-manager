import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import DOMPurify from "dompurify";
import { supabase } from "../supabase";
import SignaturePad, { ESIGN_CONSENT_VERSION } from "./SignaturePad";
import RichTextEditor from "./RichTextEditor";
import { Modal } from "./shared";
import { fmtDate, fmtDateTime } from "../utils/helpers";
import { splitPageSetup } from "../utils/docKit";
import { notifyNextSigners } from "../utils/docService";
import { signatureText, signedDateText, initialsRoster } from "../utils/signatureStamp";
import { initialsBoxRect } from "../utils/initialsStamp";

// Public page rendered at /sign/:token — no auth required.
// Uses anon-callable SECURITY DEFINER RPCs:
//  get_signature_by_token(token) → envelope payload (incl. doc_hash_at_send)
//  sign_document(token, ...)     → records the signature + ESIGN consents
//  request_paper_copy(token)     → flag a paper-copy request post-sign
//  withdraw_e_records_consent    → ESIGN §101(c) withdrawal
//
// After the LAST signer completes, the client renders the signed PDF
// via html2pdf and POSTs it to /api/finalize-signed-pdf so the bytes
// are uploaded to Storage with a SHA-256 hash recorded — that file
// becomes the canonical signed copy, immune to later DB mutation of
// rendered_body. See migration 20260424000011 for the schema +
// set_signed_pdf RPC.
function sanitizeDoc(html) {
  return DOMPurify.sanitize(html || "", {
    ALLOWED_TAGS: ["p","br","b","i","u","strong","em","h1","h2","h3","h4","h5","h6","ul","ol","li","table","thead","tbody","tr","th","td","div","span","a","img","hr","blockquote","pre","code","sub","sup","s","del","ins","mark"],
    ALLOWED_ATTR: ["href","src","alt","title","class","style","width","height","colspan","rowspan","align","valign"],
    FORBID_TAGS: ["script","iframe","object","embed","form","input","button","select","textarea"],
    FORBID_ATTR: ["onerror","onload","onclick","onmouseover","onfocus","onblur"],
  });
}

export default function PublicSignPage({ token }) {
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [doneInfo, setDoneInfo] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [pdfStatus, setPdfStatus] = useState(null); // null | "uploading" | "stored" | "error"
  const [paperCopyRequested, setPaperCopyRequested] = useState(false);
  const [consentWithdrawn, setConsentWithdrawn] = useState(false);
  // DocuSign-style tabs. The document shows as real pages; the signer's
  // own signature lines (the signature block's slots for their role) get
  // a "Sign here" tab, and -- when the template asks for initials on every
  // page -- every page gets an "Initial here" tab at its foot. Each tab is
  // clicked on its own: the first click of a kind opens the dialog that
  // takes the signature (or the initials), later clicks apply it. Finish
  // unlocks when every tab is done, and records the signature once. A
  // document without signature lines for this signer (an older template)
  // keeps the pad on the page below the document, as before.
  const docRef = useRef(null);
  const [slots, setSlots] = useState([]);          // [{ kind: "sign"|"date"|"initial", el?, page?, top, left, width, height }]
  const [padOpen, setPadOpen] = useState(false);
  const [initialsOpen, setInitialsOpen] = useState(false);
  const [adopted, setAdopted] = useState(null);     // the pad's payload, held until Finish
  const [initials, setInitials] = useState("");     // adopted initials, "TT"
  const [signedSlots, setSignedSlots] = useState(() => new Set());   // sign slots applied (by element)
  const [initialedPages, setInitialedPages] = useState(() => new Set());
  const [pendingSlot, setPendingSlot] = useState(null);  // the tab whose click opened a dialog
  const role = payload?.signer_role || "";
  const wantsInitials = !!payload?.initials_each_page;
  const signedOthers = useMemo(() => (Array.isArray(payload?.others) ? payload.others : []).filter(o => o && o.status === "signed" && o.role), [payload]);
  const measureSlots = useCallback(() => {
    const host = docRef.current;
    if (!host || !role) { setSlots([]); return; }
    const base = host.getBoundingClientRect();
    const rel = (r) => ({ top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height });
    const esc = (v) => String(v).replace(/["\\]/g, "\\$&");
    const next = Array.from(host.querySelectorAll(`span[data-sig-role="${esc(role)}"], span[data-sig-date="${esc(role)}"]`))
      .map(el => ({ kind: el.hasAttribute("data-sig-date") ? "date" : "sign", el, ...rel(el.getBoundingClientRect()) }))
      .filter(sl => sl.width > 0);
    // The other signers who have already signed: their signature and date
    // on their own lines (as the signed copy will show them).
    for (const o of signedOthers) {
      for (const el of host.querySelectorAll(`span[data-sig-role="${esc(o.role)}"], span[data-sig-date="${esc(o.role)}"]`)) {
        const r = rel(el.getBoundingClientRect());
        if (r.width > 0) next.push({ kind: el.hasAttribute("data-sig-date") ? "dateOther" : "signOther", el, other: o, ...r });
      }
    }
    // The initials boxes at the foot of every page: one per signer in the
    // document's order (the roster), exactly where the signed copy draws
    // them. The signer's own box is the "Initial" tab; the others are
    // printed outlines with the signer's label. An older document (no
    // signature block) takes initials on the pad instead.
    const roster = initialsRoster(payload?.doc_body);
    const mine = roster.findIndex(r => r.role === role);
    if (wantsInitials && mine >= 0) {
      const pm = host.querySelector(".ProseMirror");
      const footers = Array.from(host.querySelectorAll(".ProseMirror .rm-page-footer"));
      const pmRect = pm ? pm.getBoundingClientRect() : null;
      const zoom = pmRect ? pmRect.width / 816 : 1;
      const PT = 1 / 0.75;   // pt -> page px
      footers.forEach((f, page) => {
        const r = f.getBoundingClientRect();
        if (!r.width || !pmRect) return;
        roster.forEach((who, i) => {
          const b = initialsBoxRect(i, 612, roster);
          const w = b.width * PT * zoom, h = b.height * PT * zoom;
          next.push({ kind: i === mine ? "initial" : "initialOther", page, el: f, label: who.label, other: signedOthers.find(o => o.role === who.role) || null, top: r.bottom - base.top - (b.y * PT * zoom) - h, left: pmRect.right - base.left - ((612 - b.x) * PT * zoom), width: w, height: h });
        });
      });
    }
    // On a phone the page is scaled well down: the signer's own tabs keep a
    // finger-sized hit area, anchored where the box or line is.
    const pm0 = host.querySelector(".ProseMirror");
    const z = pm0 ? pm0.getBoundingClientRect().width / 816 : 1;
    for (const sl of next) { sl.z = z; sl.n = { top: sl.top, left: sl.left, width: sl.width, height: sl.height }; }   // the natural (page-scaled) box
    if (z < 0.75) {
      // The other signers' empty outlines are unreadable at this scale and
      // collide with the enlarged tab: only boxes with initials in them stay.
      for (let i = next.length - 1; i >= 0; i--) if (next[i].kind === "initialOther" && !next[i].other?.initials_data) next.splice(i, 1);
      for (const sl of next) {
        if (sl.kind === "initial") { const w = Math.max(sl.width, 84), h = Math.max(sl.height, 36); sl.left = sl.left + sl.width - w; sl.top = sl.top + sl.height - h; sl.width = w; sl.height = h; }
        if (sl.kind === "sign") { const h = Math.max(sl.height, 36); sl.top = sl.top + sl.height - h; sl.height = h; sl.width = Math.max(sl.width, 120); }
      }
    }
    setSlots(prev => (prev.length === next.length && prev.every((p, i) => p.el === next[i].el && p.kind === next[i].kind && Math.abs(p.top - next[i].top) < 0.5 && Math.abs(p.left - next[i].left) < 0.5 && Math.abs(p.width - next[i].width) < 0.5) ? prev : next));
  }, [role, wantsInitials, signedOthers]);
  // The paged view settles its pages over a few frames and re-fits on
  // resize, so the tabs follow the lines: measured on a short interval
  // while the document is shown (cheap: a handful of rects).
  useEffect(() => {
    if (!payload || done) return undefined;
    measureSlots();
    const id = setInterval(measureSlots, 400);
    window.addEventListener("resize", measureSlots);
    return () => { clearInterval(id); window.removeEventListener("resize", measureSlots); };
  }, [payload, done, measureSlots]);
  const signSlots = slots.filter(sl => sl.kind === "sign");
  const initialSlots = slots.filter(sl => sl.kind === "initial");
  const hasSlots = signSlots.length > 0;
  const signsDone = signSlots.filter(sl => signedSlots.has(sl.el)).length;
  const initialsDone = initialSlots.filter(sl => initialedPages.has(sl.page)).length;
  const allDone = hasSlots && !!adopted && signsDone === signSlots.length && (!wantsInitials || initialsDone === initialSlots.length);
  // The next tab is the first UNDONE one down the page (Start used to jump
  // to the signature line on the last page, because the signature slots
  // were measured first).
  const nextTab = slots.filter(sl => (sl.kind === "sign" && !signedSlots.has(sl.el)) || (sl.kind === "initial" && !initialedPages.has(sl.page))).sort((a, b) => a.top - b.top)[0];
  function scrollToTab(sl) {
    const el = sl?.el;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function clickSign(sl) {
    if (!adopted) { setPendingSlot(sl); setPadOpen(true); return; }
    setSignedSlots(prev => new Set(prev).add(sl.el));
  }
  function clickInitial(sl) {
    if (!initials) { setPendingSlot(sl); setInitialsOpen(true); return; }
    setInitialedPages(prev => new Set(prev).add(sl.page));
  }
  function adopt(data) {
    setAdopted(data);
    setPadOpen(false);
    if (pendingSlot?.kind === "sign") setSignedSlots(prev => new Set(prev).add(pendingSlot.el));
    setPendingSlot(null);
  }
  function adoptInitials(text) {
    setInitials(text);
    setInitialsOpen(false);
    if (pendingSlot?.kind === "initial") setInitialedPages(prev => new Set(prev).add(pendingSlot.page));
    setPendingSlot(null);
  }
  function finish() {
    if (!allDone || !adopted) return;
    // The initials go with the signature; the page count is kept with
    // them so the record says every page was initialed by hand.
    const initialsData = wantsInitials && initials ? "typed:" + initials + "|ts:" + new Date().toISOString() + "|pages:" + initialSlots.length : adopted.initialsData || null;
    handleSign({ ...adopted, initialsData });
  }
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data, error: rpcErr } = await supabase.rpc("get_signature_by_token", { p_token: token });
      if (cancelled) return;
      if (rpcErr) { setError("Could not load this signature request. Please check the link and try again."); setLoading(false); return; }
      if (data?.error) {
        if (data.error === "not available" && data.status === "signed") {
          setError("You have already signed this document on " + fmtDateTime(data.signed_at) + ".");
        } else if (data.error === "token expired") {
          setError("This signing link has expired. Please contact the sender for a new one.");
        } else if (data.error === "token not found" || data.error === "invalid token") {
          setError("This signing link is not valid.");
        } else {
          setError("This signing request is no longer available (" + (data.status || data.error) + ").");
        }
        setLoading(false);
        return;
      }
      setPayload(data);
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [token]);

  // Render the final PDF and upload it to Storage. Triggered only
  // when sign_document returned all_signed=true (this signer was the
  // last one). Lazily imports html2pdf so a typical sign flow that
  // doesn't reach the upload branch never pulls the bundle.
  async function renderAndUploadSignedPdf(docId, integrityHash) {
    setPdfStatus("uploading");
    try {
      const html2pdfMod = await import("html2pdf.js");
      const html2pdf = html2pdfMod.default || html2pdfMod;
      // Build the printable HTML — body + a signature certificate
      // section. Server-side will recompute SHA-256 over the
      // resulting PDF bytes and store it as signed_pdf_hash.
      // payload.signer_name / signer_email come from the invitee's
      // form input (tenant-controlled) and used to land directly in
      // innerHTML — XSS sink flagged by security-adversarial.test.js
      // on 2026-05-01. Sanitize the entire assembled HTML through
      // DOMPurify before assignment so the certificate block can't
      // smuggle scripts/event-handlers from the signer fields.
      // The document itself is rendered as real text on its own pages,
      // exactly as the signer saw them (pagedPdf: same layout engine as
      // the on-page view below). The certificate follows on its own page
      // through the picture renderer -- it is a short block of hashes,
      // and keeping it out of the body keeps the body's pages unshifted.
      const { renderPagedPdf, concatPdfs } = await import("../utils/pagedPdf");
      const { html: bodyHtml, setup: pageSetup } = splitPageSetup(payload.doc_body);
      const wrapper = document.createElement("div");
      const rawCert =
        `<h1 style="font-family:Georgia,serif;font-size:18px;margin:0 0 12px;">${(payload.doc_name || "").slice(0, 200)}</h1>` +
        `<h2 style="font-family:Georgia,serif;font-size:14px;">Certificate of Completion</h2>` +
        `<p style="font-family:Georgia,serif;font-size:11px;line-height:1.5;">` +
        `Document hash at send: <code>${(payload.doc_hash_at_send || "").slice(0, 64)}</code><br/>` +
        `Signature hash: <code>${(integrityHash || "").slice(0, 64)}</code><br/>` +
        `Signed by: ${payload.signer_name || payload.signer_email || ""}<br/>` +
        `Signed at: ${new Date().toISOString()}<br/>` +
        `Disclosure version: ${ESIGN_CONSENT_VERSION}` +
        `</p>`;
      wrapper.innerHTML = DOMPurify.sanitize(rawCert);
      const { renderPagedPdfWithAnchors } = await import("../utils/pagedPdf");
      let sigAnchors = [];
      const [bodyPdf, certPdf] = await Promise.all([
        renderPagedPdfWithAnchors({ html: sanitizeDoc(bodyHtml), pageSetup, title: payload.doc_name }).then(r => { sigAnchors = r.anchors || []; return r.bytes; }),
        html2pdf().set({
          margin: 36,
          html2canvas: { scale: 2 },
          jsPDF: { unit: "pt", format: "letter", orientation: "portrait" },
        }).from(wrapper).outputPdf("arraybuffer"),
      ]);
      const pdfBytes = await concatPdfs([bodyPdf, certPdf]);
      // The server stamps every signer's initials on the body pages (it
      // can read all the signers; this page can only see its own).
      let bodyPages = 0;
      try { const { PDFDocument } = await import("pdf-lib"); bodyPages = (await PDFDocument.load(bodyPdf)).getPageCount(); } catch { bodyPages = 0; }

      // Upload via /api/finalize-signed-pdf so the server-side
      // service-role client owns the Storage write + DB update.
      // Chunked: spreading a whole PDF into String.fromCharCode overflows
      // the call stack once the file passes ~100 KB of arguments.
      let binary = "";
      for (let i = 0; i < pdfBytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, pdfBytes.subarray(i, i + 0x8000));
      const base64 = btoa(binary);
      const res = await fetch("/api/finalize-signed-pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Where the signature lines are (page px); the server draws every
        // signer's signature and date on them before it stores the copy.
        body: JSON.stringify({ token, doc_id: docId, pdf_base64: base64, body_pages: bodyPages, sig_anchors: sigAnchors }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setPdfStatus("stored");
      setDoneInfo(prev => ({
        ...prev,
        signed_pdf_path: j.signed_pdf_path,
        signed_pdf_hash: j.signed_pdf_hash,
        download_url: j.download_url,
        certificate_url: j.certificate_url,
        signers_queued: j.signers_queued,
      }));
    } catch (e) {
      // Best-effort. Failure here doesn't invalidate the signature
      // — the DB still has the integrity_hash + doc_hash_at_send for
      // forensic verification. A separate cron sweep can re-render
      // any envelope where signed_pdf_path is null.
      console.error("PDF finalization failed:", e);
      setPdfStatus("error");
    }
  }

  async function handleSign({ signatureData, initialsData, signingMethod, consentText, signerName, eRecordsConsented, hwSwAcknowledged, consentVersion }) {
    setSubmitting(true);
    try {
      // Through the web server (api/_sign-document-impl, on the e-sign
      // route), which records the
      // signer's real IP address with the signature; the initials go on
      // the same call. The page used to call the database directly, and
      // every signature's address came out as the gateway's.
      const res = await fetch("/api/finalize-signed-pdf?action=sign", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token, initials_data: initialsData || null,
          signer_name: signerName || payload?.signer_name || "",
          signature_data: signatureData, signing_method: signingMethod, consent_text: consentText,
          user_agent: navigator.userAgent || "", e_records_consented: !!eRecordsConsented, hw_sw_acknowledged: !!hwSwAcknowledged,
          consent_version: consentVersion || ESIGN_CONSENT_VERSION,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) { setError("Signing failed: " + (data?.error || `HTTP ${res.status}`)); return; }
      setDoneInfo(data);
      setDone(true);
      // Last signer? The server finished the envelope inside that call when
      // the pages were stored at send time (signed_pdf_path comes back).
      // Otherwise (an envelope sent before that), render and upload here.
      if (data?.all_signed && data?.doc_id) {
        if (data.signed_pdf_path) setPdfStatus("stored");
        else renderAndUploadSignedPdf(data.doc_id, data.integrity_hash);
      } else {
        // Others still to sign: have the server email whoever is next. The
        // page used to SAY "the next signer has been notified" while nothing
        // sent anything. Fire and forget -- this signer is done either way,
        // and staff can resend from Document Builder.
        notifyNextSigners(token).catch(() => {});
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRequestPaperCopy() {
    const { error: rpcErr } = await supabase.rpc("request_paper_copy", { p_token: token, p_reason: null });
    if (!rpcErr) setPaperCopyRequested(true);
  }
  async function handleWithdrawConsent() {
    const reason = window.prompt("Optional — tell us why you're withdrawing consent (this helps us follow up):", "");
    const { error: rpcErr } = await supabase.rpc("withdraw_e_records_consent", { p_token: token, p_reason: reason || null });
    if (!rpcErr) setConsentWithdrawn(true);
  }

  if (loading) {
    return (
      <div className="min-h-dvh safe-y safe-x bg-surface-muted flex items-center justify-center p-6">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-neutral-500">Loading signature request…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-dvh safe-y safe-x bg-surface-muted flex items-center justify-center p-6">
        <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-8 max-w-md text-center">
          <div className="text-5xl mb-3">⚠️</div>
          <h1 className="text-lg font-bold text-neutral-800 mb-2">Can't sign right now</h1>
          <p className="text-sm text-neutral-500">{error}</p>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-dvh safe-y safe-x bg-surface-muted flex items-center justify-center p-6">
        <div className="bg-white rounded-xl border border-neutral-200 shadow-card border border-success-200 p-8 max-w-md text-center">
          <div className="text-5xl mb-3">✅</div>
          <h1 className="text-xl font-bold text-neutral-800 mb-1">Thanks — signature recorded</h1>
          <p className="text-sm text-neutral-500 mb-4">
            {doneInfo?.all_signed
              ? "All parties have signed. You'll receive a copy of the fully-executed document by email."
              : doneInfo?.next_signer_email
                ? "Thank you. The next signer is being asked now, and you'll receive a copy by email once everyone has signed."
                : "You'll receive a copy once all other parties have signed."}
          </p>
          {doneInfo?.integrity_hash && (
            <div className="text-2xs tnum text-neutral-400 bg-neutral-50 rounded-lg px-3 py-2 break-all space-y-1 text-left">
              <div><span className="text-neutral-500">Document hash at send:</span> <span className="text-neutral-700">{(doneInfo.doc_hash_at_send || "").slice(0, 32)}…</span></div>
              <div><span className="text-neutral-500">Signature hash:</span> <span className="text-neutral-700">{doneInfo.integrity_hash.slice(0, 32)}…</span></div>
              {pdfStatus === "uploading" && <div className="text-warn-700">⏳ Preparing the signed copy — please keep this window open…</div>}
              {pdfStatus === "stored" && <div className="text-success-700">✓ Signed PDF stored ({(doneInfo.signed_pdf_hash || "").slice(0, 12)}…)</div>}
              {pdfStatus === "error" && <div className="text-warn-700">The signed copy could not be prepared from here — your signature is recorded, and the office can store the copy. <button type="button" onClick={() => renderAndUploadSignedPdf(doneInfo.doc_id, doneInfo.integrity_hash)} className="underline">Try again</button></div>}
            </div>
          )}
          {doneInfo?.download_url && (
            <div className="flex flex-wrap items-center gap-2 mt-3">
            <a
              href={doneInfo.download_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 transition-colors"
            >
              <span className="material-icons-outlined text-base">download</span>
              Download your signed copy
            </a>
            {doneInfo?.certificate_url && (
              <a href={doneInfo.certificate_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-brand-200 text-brand-700 text-sm font-semibold hover:bg-brand-50 transition-colors">
                <span className="material-icons-outlined text-base">verified</span>
                Certificate of completion
              </a>
            )}
            </div>
          )}
          {doneInfo?.all_signed && doneInfo?.signers_queued > 0 && (
            <p className="text-2xs text-neutral-400 mt-2">
              All {doneInfo.signers_queued} signers will receive a copy by email.
            </p>
          )}
          <div className="flex flex-col gap-2 mt-4">
            {!paperCopyRequested && (
              <button onClick={handleRequestPaperCopy} className="text-xs text-brand-600 hover:text-brand-700 underline">
                Request a paper copy
              </button>
            )}
            {paperCopyRequested && <div className="text-xs text-success-700">✓ Paper copy requested — the sender has been notified.</div>}
            {!consentWithdrawn && (
              <button onClick={handleWithdrawConsent} className="text-xs text-neutral-500 hover:text-neutral-700 underline">
                Withdraw electronic records consent (future communications)
              </button>
            )}
            {consentWithdrawn && <div className="text-xs text-neutral-500">Consent withdrawn — future communications will be paper.</div>}
          </div>
          {pdfStatus !== "uploading" && <p className="text-xs text-neutral-400 mt-4">You can safely close this window.</p>}
        </div>
      </div>
    );
  }

  const { html: bodyOnly, setup: bodySetup } = splitPageSetup(payload.doc_body);
  const signerLabel = (payload.signer_role || "").replace(/_/g, " ");
  const typed = adopted ? signatureText(adopted.signatureData) : null;
  const today = signedDateText(new Date().toISOString());
  const docFont = "'Liberation Serif', 'Times New Roman', Times, serif";
  const pad = (
    <SignaturePad
      signerName={payload.signer_name || ""}
      signerLabel={signerLabel}
      companyName={payload.company_name}
      companyContactEmail={payload.company_contact_email}
      submitting={submitting}
      submitLabel={hasSlots ? "Adopt and sign" : "Sign & Submit"}
      initialsRequired={!hasSlots && wantsInitials}
      onSubmit={hasSlots ? adopt : handleSign}
    />
  );
  const total = signSlots.length + initialSlots.length;
  const doneCount = signsDone + initialsDone;
  const progress = hasSlots ? `${doneCount} of ${total} done` : "";
  const finishBtn = (cls) => (
    <button type="button" disabled={!allDone || submitting} onClick={finish} title={allDone ? "Record your signature" : "Click every tab first"}
      className={cls + " px-4 py-2 rounded-xl text-sm font-semibold transition-colors " + (allDone ? "bg-brand-600 text-white hover:bg-brand-700" : "bg-neutral-200 text-neutral-500 cursor-not-allowed")}>
      {submitting ? "Submitting…" : "Finish"}
    </button>
  );

  return (
    <div className="min-h-dvh safe-y safe-x bg-surface-muted">
      <div className="bg-white border-b border-brand-50 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-3 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center shrink-0">
              <span className="material-icons-outlined text-white text-sm">description</span>
            </div>
            <div className="min-w-0">
              <div className="font-bold text-sm text-neutral-800 truncate">{payload.doc_name}</div>
              <div className="text-xs text-neutral-400 truncate">{payload.company_name ? "from " + payload.company_name + " · " : ""}signing as <span className="font-semibold text-neutral-600">{payload.signer_name || payload.signer_email}</span>{signerLabel ? " (" + signerLabel + ")" : ""}</div>
            </div>
          </div>
          {hasSlots && (
            <div className="flex items-center gap-2 shrink-0">
              <span className="hidden sm:inline text-xs text-neutral-500 tnum">{progress}</span>
              {nextTab && (
                <button type="button" onClick={() => scrollToTab(nextTab)} className="px-3 sm:px-4 py-2 rounded-xl bg-warn-400 text-neutral-900 text-sm font-semibold hover:bg-warn-500 transition-colors">
                  {doneCount === 0 ? "Start" : "Next"}
                </button>
              )}
              {finishBtn("")}
            </div>
          )}
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-1 sm:px-6 py-3 sm:py-6">
        {payload.doc_property_address && <div className="text-xs text-neutral-400 mb-2 px-2">Property: <span className="font-semibold text-neutral-600">{payload.doc_property_address}</span></div>}
        {hasSlots && !allDone && (
          <div className="mb-3 mx-2 px-4 py-3 rounded-xl bg-warn-50 border border-warn-200 text-sm text-neutral-700 flex items-start gap-2">
            <span className="material-icons-outlined text-warn-600 text-base mt-0.5">edit</span>
            <div>
              Read the document and click every tab: {wantsInitials && <><strong>Initial here</strong> at the foot of each page ({initialsDone} of {initialSlots.length} done) and </>}<strong>Sign here</strong> on your signature line{signSlots.length === 1 ? "" : "s"} ({signsDone} of {signSlots.length} done). <strong>Finish</strong> unlocks when every tab is done. <button type="button" onClick={() => scrollToTab(nextTab)} className="underline text-brand-700">Take me to the next one</button>
            </div>
          </div>
        )}

        {/* The document as real pages (the same layout as the signed copy),
            with the tabs laid over the signer's own lines and page feet. */}
        <div ref={docRef} className="relative">
          <div className="rounded-xl border border-neutral-200 overflow-hidden">
            <RichTextEditor key={payload.doc_body ? payload.doc_body.length : 0} readOnly paperCanvas hideToolbar grow value={sanitizeDoc(bodyOnly)} pageSetup={bodySetup} />
          </div>
          {slots.map((sl, i) => {
            // Above the page furniture (the pagination add-on's footers
            // carry a z-index of their own).
            const style = { position: "absolute", top: sl.top, left: sl.left, width: sl.width, height: sl.height, zIndex: 15 };
            if (sl.kind === "date") {
              return adopted && signedSlots.size ? <div key={i} aria-label="Date signed" style={{ ...style, pointerEvents: "none", fontSize: Math.max(6, 11 * (sl.z || 1)) }} className="flex items-end pb-0.5 pl-1 text-brand-900">{today}</div> : null;
            }
            if (sl.kind === "initialOther") {
              const ini = sl.other?.initials_data ? signatureText(sl.other.initials_data) : null;
              return (
                <div key={i} aria-hidden="true" style={{ ...style, pointerEvents: "none" }} className={"rounded border bg-white/70 flex items-center justify-center " + (sl.other ? "border-brand-200" : "border-neutral-400")}>
                  {ini ? <span className="italic text-brand-900 text-xs font-bold" style={{ fontFamily: docFont }}>{ini}</span>
                    : sl.other?.initials_data ? <img src={sl.other.initials_data} alt="" style={{ maxHeight: sl.height - 4, maxWidth: sl.width - 4 }} /> : null}
                  <div className="absolute left-0 right-0 text-neutral-500 text-center" style={{ top: "100%", fontSize: 7 }}>{sl.label}</div>
                </div>
              );
            }
            if (sl.kind === "signOther") {
              const t = signatureText(sl.other.signature_data);
              const h = Math.max(sl.height, 28 * (sl.z || 1));
              return (
                <div key={i} aria-label={"Signed by " + (sl.other.name || sl.other.role)} title={"Signed by " + (sl.other.name || sl.other.role) + (sl.other.signed_at ? " on " + signedDateText(sl.other.signed_at) : "")} data-other-signed="1"
                  style={{ ...style, height: h, top: sl.top + sl.height - h, pointerEvents: "none" }} className="flex items-end pl-1 pb-0.5 overflow-hidden">
                  {t !== null
                    ? <span className="italic text-brand-900 whitespace-nowrap" style={{ fontFamily: docFont, fontSize: Math.min(20 * (sl.z || 1), sl.width / 9) }}>{t}</span>
                    : sl.other.signature_data ? <img src={sl.other.signature_data} alt="" style={{ maxHeight: h - 4, maxWidth: sl.width - 6 }} /> : null}
                </div>
              );
            }
            if (sl.kind === "dateOther") {
              return <div key={i} aria-hidden="true" style={{ ...style, pointerEvents: "none", fontSize: Math.max(6, 11 * (sl.z || 1)) }} className="flex items-end pb-0.5 pl-1 text-brand-900">{signedDateText(sl.other.signed_at)}</div>;
            }
            if (sl.kind === "initial") {
              const isDone = initialedPages.has(sl.page);
              return (
                <button key={i} type="button" onClick={() => clickInitial(sl)} aria-label={isDone ? "Initialed page " + (sl.page + 1) : "Initial here, page " + (sl.page + 1)} data-initial-page={sl.page} data-done={isDone ? "1" : "0"}
                  style={style}
                  className={"relative flex items-center justify-center rounded border text-xs font-bold transition-colors " + (isDone ? "bg-brand-50 border-brand-300 text-brand-900 italic" : "bg-warn-200/80 hover:bg-warn-300 border-warn-500 text-neutral-900")}>
                  {isDone ? <span style={{ fontFamily: docFont }}>{initials}</span> : "Initial"}
                  <span className="absolute left-0 right-0 text-neutral-500 text-center font-normal not-italic" style={{ top: "100%", fontSize: 7 }}>{sl.label}</span>
                </button>
              );
            }
            const isSigned = adopted && signedSlots.has(sl.el);
            const nat = sl.n || sl, z = sl.z || 1;   // what is drawn on paper scales with the page; only tabs are finger-sized
            const h = Math.max(nat.height, 28 * z);
            if (isSigned) {
              return (
                <button key={i} type="button" onClick={() => setPadOpen(true)} title="Change your signature" aria-label="Your signature (click to change)" data-signed="1"
                  style={{ position: "absolute", left: nat.left, width: nat.width, height: h, minHeight: 0, top: nat.top + nat.height - h, zIndex: 15 }}
                  className="flex items-end pl-1 pb-0.5 bg-brand-50/60 rounded-t text-left overflow-hidden">
                  {typed !== null
                    ? <span className="italic text-brand-900 whitespace-nowrap" style={{ fontFamily: docFont, fontSize: Math.min(20 * z, nat.width / 9) }}>{typed}</span>
                    : <img src={adopted.signatureData} alt="Your signature" style={{ maxHeight: h - 4, maxWidth: nat.width - 6 }} />}
                </button>
              );
            }
            return (
              <button key={i} type="button" onClick={() => clickSign(sl)} aria-label="Sign here" data-signed="0"
                style={{ ...style, height: Math.max(sl.height, 26), top: sl.top + sl.height - Math.max(sl.height, 26) }}
                className="flex items-center bg-warn-200/70 hover:bg-warn-300/80 border-l-4 border-warn-500 rounded-r text-left transition-colors">
                <span className="ml-2 px-2 py-0.5 rounded bg-warn-500 text-neutral-900 text-xs font-bold">Sign here</span>
              </button>
            );
          })}
        </div>

        {/* Document hash banner — gives the signer something concrete
            to anchor their consent to. Without this they're trusting
            "the document" abstractly; with it they're committing to
            a specific 64-character SHA-256 they can compare later. */}
        {payload.doc_hash_at_send && (
          <div className="my-4 mx-2 px-4 py-3 rounded-xl bg-brand-50/40 border border-brand-100 text-2xs text-neutral-600 flex items-start gap-2">
            <span className="material-icons-outlined text-brand-600 text-base mt-0.5">fingerprint</span>
            <div>
              <div className="font-semibold text-neutral-700 mb-0.5">You are signing the version of this document with hash:</div>
              <div className="tnum break-all text-neutral-700">{payload.doc_hash_at_send}</div>
              <div className="text-neutral-500 mt-1">Save this hash if you want to verify later that the document hasn't been altered.</div>
            </div>
          </div>
        )}

        {!hasSlots && <div className="mx-2">{pad}</div>}
        {hasSlots && (
          <div className={"mx-2 mb-2 px-4 py-3 rounded-xl border text-sm text-neutral-700 flex items-center justify-between gap-3 " + (allDone ? "bg-success-50 border-success-200" : "bg-white border-neutral-200")}>
            <span>{allDone ? "Every tab is done. Press Finish to record your signature." : progress + " — " + (nextTab ? "click the next tab to continue." : "")}</span>
            {finishBtn("shrink-0")}
          </div>
        )}

        <p className="text-2xs text-neutral-400 text-center mt-4">
          This link expires {payload.expires_at ? "on " + fmtDate(payload.expires_at) : "in 30 days"}.
          Your IP address, browser information, and a cryptographic hash of this document are recorded for audit purposes.
        </p>
      </div>

      {padOpen && (
        <Modal title="Your signature" onClose={() => { setPadOpen(false); setPendingSlot(null); }}>
          <div className="p-4">{pad}</div>
        </Modal>
      )}
      {initialsOpen && (
        <Modal title="Your initials" onClose={() => { setInitialsOpen(false); setPendingSlot(null); }}>
          <InitialsForm signerName={payload.signer_name || ""} pages={initialSlots.length} onAdopt={adoptInitials} />
        </Modal>
      )}
    </div>
  );
}

// Typed initials, 2 to 6 letters. Adopted once; then each page's tab is
// clicked to place them, so the record shows every page was looked at.
function InitialsForm({ signerName, pages, onAdopt }) {
  const guess = String(signerName || "").split(/\s+/).filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 4);
  const [value, setValue] = useState(guess);
  const [err, setErr] = useState("");
  function submit(e) {
    e.preventDefault();
    const ini = value.trim().replace(/[^A-Za-z.]/g, "").slice(0, 6).toUpperCase();
    if (ini.length < 2) { setErr("Please type your initials (2 to 6 letters)."); return; }
    onAdopt(ini);
  }
  return (
    <form onSubmit={submit} className="p-5 space-y-3">
      <p className="text-sm text-neutral-600">Type your initials. They go at the foot of each of the {pages} pages as you click each page's <strong>Initial</strong> tab.</p>
      <input id="sig-initials" autoFocus value={value} onChange={e => { setValue(e.target.value.toUpperCase()); setErr(""); }} maxLength={6} placeholder="e.g. SA"
        className="w-40 text-2xl italic tracking-widest border border-neutral-300 rounded-xl px-3 py-2 focus:outline-none focus:border-brand-400" style={{ fontFamily: "'Liberation Serif', 'Times New Roman', Times, serif" }} />
      {err && <div className="text-xs text-danger-600">{err}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="submit" className="px-4 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700">Adopt initials</button>
      </div>
    </form>
  );
}
