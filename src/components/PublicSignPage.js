import React, { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { supabase } from "../supabase";
import SignaturePad, { ESIGN_CONSENT_VERSION } from "./SignaturePad";

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data, error: rpcErr } = await supabase.rpc("get_signature_by_token", { p_token: token });
      if (cancelled) return;
      if (rpcErr) { setError("Could not load this signature request. Please check the link and try again."); setLoading(false); return; }
      if (data?.error) {
        if (data.error === "not available" && data.status === "signed") {
          setError("You have already signed this document on " + new Date(data.signed_at).toLocaleString() + ".");
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
      const wrapper = document.createElement("div");
      wrapper.innerHTML = `
        <h1 style="font-family:Georgia,serif;font-size:18px;margin:0 0 12px;">${(payload.doc_name || "").replace(/[<>]/g, "")}</h1>
        ${sanitizeDoc(payload.doc_body)}
        <hr style="margin:24px 0;" />
        <h2 style="font-family:Georgia,serif;font-size:14px;">Certificate of Completion</h2>
        <p style="font-family:Georgia,serif;font-size:11px;line-height:1.5;">
          Document hash at send: <code>${(payload.doc_hash_at_send || "").slice(0, 64)}</code><br/>
          Signature hash: <code>${(integrityHash || "").slice(0, 64)}</code><br/>
          Signed by: ${payload.signer_name || payload.signer_email}<br/>
          Signed at: ${new Date().toISOString()}<br/>
          Disclosure version: ${ESIGN_CONSENT_VERSION}
        </p>`;
      const pdfBlob = await html2pdf().set({
        margin: 12,
        filename: `${(payload.doc_name || "signed").replace(/[^a-z0-9]/gi, "-")}.pdf`,
        html2canvas: { scale: 2 },
        jsPDF: { unit: "pt", format: "letter", orientation: "portrait" },
      }).from(wrapper).outputPdf("blob");

      // Upload via /api/finalize-signed-pdf so the server-side
      // service-role client owns the Storage write + DB update.
      const arrayBuffer = await pdfBlob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      const res = await fetch("/api/finalize-signed-pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, doc_id: docId, pdf_base64: base64 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setPdfStatus("stored");
      setDoneInfo(prev => ({
        ...prev,
        signed_pdf_path: j.signed_pdf_path,
        signed_pdf_hash: j.signed_pdf_hash,
        download_url: j.download_url,
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

  async function handleSign({ signatureData, signingMethod, consentText, signerName, eRecordsConsented, hwSwAcknowledged, consentVersion }) {
    setSubmitting(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc("sign_document", {
        p_token: token,
        p_signer_name: signerName || payload?.signer_name || "",
        p_signature_data: signatureData,
        p_signing_method: signingMethod,
        p_consent_text: consentText,
        p_user_agent: navigator.userAgent || "",
        p_e_records_consented: !!eRecordsConsented,
        p_hw_sw_acknowledged: !!hwSwAcknowledged,
        p_consent_version: consentVersion || ESIGN_CONSENT_VERSION,
      });
      if (rpcErr) { setError("Signing failed: " + rpcErr.message); return; }
      if (data?.error) { setError("Signing failed: " + data.error); return; }
      setDoneInfo(data);
      setDone(true);
      // Last signer? Render and upload the PDF.
      if (data?.all_signed && data?.doc_id) {
        renderAndUploadSignedPdf(data.doc_id, data.integrity_hash);
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
        <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-8 max-w-md text-center">
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
        <div className="bg-white rounded-3xl shadow-card border border-success-200 p-8 max-w-md text-center">
          <div className="text-5xl mb-3">✅</div>
          <h1 className="text-xl font-bold text-neutral-800 mb-1">Thanks — signature recorded</h1>
          <p className="text-sm text-neutral-500 mb-4">
            {doneInfo?.all_signed
              ? "All parties have signed. You'll receive a copy of the fully-executed document by email."
              : doneInfo?.next_signer_email
                ? "The next signer has been notified. You'll receive a copy once everyone has signed."
                : "You'll receive a copy once all other parties have signed."}
          </p>
          {doneInfo?.integrity_hash && (
            <div className="text-[10px] font-mono text-neutral-400 bg-neutral-50 rounded-lg px-3 py-2 break-all space-y-1 text-left">
              <div><span className="text-neutral-500">Document hash at send:</span> <span className="text-neutral-700">{(doneInfo.doc_hash_at_send || "").slice(0, 32)}…</span></div>
              <div><span className="text-neutral-500">Signature hash:</span> <span className="text-neutral-700">{doneInfo.integrity_hash.slice(0, 32)}…</span></div>
              {pdfStatus === "uploading" && <div className="text-warn-700">⏳ Generating signed PDF…</div>}
              {pdfStatus === "stored" && <div className="text-success-700">✓ Signed PDF stored ({(doneInfo.signed_pdf_hash || "").slice(0, 12)}…)</div>}
              {pdfStatus === "error" && <div className="text-warn-700">PDF generation deferred — your signature is still recorded.</div>}
            </div>
          )}
          {doneInfo?.download_url && (
            <a
              href={doneInfo.download_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold hover:bg-brand-700 transition-colors"
            >
              <span className="material-icons-outlined text-base">download</span>
              Download your signed copy
            </a>
          )}
          {doneInfo?.all_signed && doneInfo?.signers_queued > 0 && (
            <p className="text-[11px] text-neutral-400 mt-2">
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
          <p className="text-xs text-neutral-400 mt-4">You can safely close this window.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh safe-y safe-x bg-surface-muted">
      <div className="bg-white border-b border-brand-50 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center">
              <span className="material-icons-outlined text-white text-sm">description</span>
            </div>
            <div>
              <div className="font-bold text-sm text-neutral-800">{payload.doc_name}</div>
              {payload.company_name && <div className="text-xs text-neutral-400">from {payload.company_name}</div>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-neutral-400">Signing as</div>
            <div className="text-sm font-semibold text-neutral-700">{payload.signer_name || payload.signer_email}</div>
            <div className="text-[10px] text-neutral-400 capitalize">{(payload.signer_role || "").replace(/_/g, " ")}</div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-8 mb-4">
          {payload.doc_property_address && <div className="text-xs text-neutral-400 mb-2">Property: <span className="font-semibold text-neutral-600">{payload.doc_property_address}</span></div>}
          <div
            className="prose prose-sm max-w-none"
            style={{ fontFamily: "Georgia, serif", fontSize: "14px", lineHeight: "1.7" }}
            dangerouslySetInnerHTML={{ __html: sanitizeDoc(payload.doc_body) }}
          />
        </div>

        {/* Document hash banner — gives the signer something concrete
            to anchor their consent to. Without this they're trusting
            "the document" abstractly; with it they're committing to
            a specific 64-character SHA-256 they can compare later. */}
        {payload.doc_hash_at_send && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-brand-50/40 border border-brand-100 text-[11px] text-neutral-600 flex items-start gap-2">
            <span className="material-icons-outlined text-brand-600 text-base mt-0.5">fingerprint</span>
            <div>
              <div className="font-semibold text-neutral-700 mb-0.5">You are signing the version of this document with hash:</div>
              <div className="font-mono break-all text-neutral-700">{payload.doc_hash_at_send}</div>
              <div className="text-neutral-500 mt-1">Save this hash if you want to verify later that the document hasn't been altered.</div>
            </div>
          </div>
        )}

        <SignaturePad
          signerName={payload.signer_name || ""}
          signerLabel={(payload.signer_role || "").replace(/_/g, " ")}
          companyName={payload.company_name}
          companyContactEmail={payload.company_contact_email}
          submitting={submitting}
          submitLabel="Sign & Submit"
          onSubmit={handleSign}
        />

        <p className="text-[10px] text-neutral-400 text-center mt-4">
          This link expires {payload.expires_at ? "on " + new Date(payload.expires_at).toLocaleDateString() : "in 30 days"}.
          Your IP address, browser information, and a cryptographic hash of this document are recorded for audit purposes.
        </p>
      </div>
    </div>
  );
}
