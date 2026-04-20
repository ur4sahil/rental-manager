import React, { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { supabase } from "../supabase";
import SignaturePad from "./SignaturePad";

// Public page rendered at /sign/:token — no auth required.
// Uses anon-callable SECURITY DEFINER RPCs:
//  get_signature_by_token(token) → envelope payload
//  sign_document(token, ...)     → records the signature
//
// This component is intentionally self-contained: imports only supabase
// (anon client is fine; RLS allows nothing here, RPCs gate access), and
// avoids any auth-path side effects so the URL works in incognito.
//
// Render states: loading → error (bad/expired token) → signing → done.
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

  async function handleSign({ signatureData, signingMethod, consentText, signerName }) {
    setSubmitting(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc("sign_document", {
        p_token: token,
        p_signer_name: signerName || payload?.signer_name || "",
        p_signature_data: signatureData,
        p_signing_method: signingMethod,
        p_consent_text: consentText,
        p_user_agent: navigator.userAgent || "",
      });
      if (rpcErr) { setError("Signing failed: " + rpcErr.message); return; }
      if (data?.error) { setError("Signing failed: " + data.error); return; }
      setDoneInfo(data);
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center p-6">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-brand-200 border-t-brand-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-neutral-500">Loading signature request…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-surface-muted flex items-center justify-center p-6">
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
      <div className="min-h-screen bg-surface-muted flex items-center justify-center p-6">
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
            <div className="text-[10px] font-mono text-neutral-400 bg-neutral-50 rounded-lg px-3 py-2 break-all">
              Audit hash: {doneInfo.integrity_hash.slice(0, 32)}…
            </div>
          )}
          <p className="text-xs text-neutral-400 mt-4">You can safely close this window.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-muted">
      {/* Header */}
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

      {/* Doc body */}
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="bg-white rounded-3xl shadow-card border border-brand-50 p-8 mb-4">
          {payload.doc_property_address && <div className="text-xs text-neutral-400 mb-2">Property: <span className="font-semibold text-neutral-600">{payload.doc_property_address}</span></div>}
          <div
            className="prose prose-sm max-w-none"
            style={{ fontFamily: "Georgia, serif", fontSize: "14px", lineHeight: "1.7" }}
            dangerouslySetInnerHTML={{ __html: sanitizeDoc(payload.doc_body) }}
          />
        </div>

        <SignaturePad
          signerName={payload.signer_name || ""}
          signerLabel={(payload.signer_role || "").replace(/_/g, " ")}
          submitting={submitting}
          submitLabel="Sign & Submit"
          onSubmit={handleSign}
        />

        <p className="text-[10px] text-neutral-400 text-center mt-4">
          This link expires {payload.expires_at ? "on " + new Date(payload.expires_at).toLocaleDateString() : "in 30 days"}.
          Your IP address, browser information, and a cryptographic hash of this document will be recorded for audit purposes.
        </p>
      </div>
    </div>
  );
}
