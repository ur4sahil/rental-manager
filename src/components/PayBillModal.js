import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "../supabase";
import { safeNum } from "../utils/helpers";
import StreamedBrowser from "./StreamedBrowser";

// Pay a utility straight on the provider's own site, streamed into the app.
//
// No amount step, no review: clicking Pay opens the provider's page (WSSC etc.)
// in a secure streamed browser, and the person does the WHOLE thing there —
// sign in, pick the amount, enter the card, submit. The amount and the card
// live on the provider's site, never in PropManager. The server watches for the
// confirmation and captures the receipt.
export default function PayBillModal({ bill, companyId, onClose, onPaid, showToast }) {
  const [stream, setStream] = useState(null);   // { streamBase, token, provider }
  const [error, setError] = useState(null);

  const start = useCallback(async () => {
    setError(null);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const access = sess?.session?.access_token;
      if (!access) { setError("Please sign in again."); return; }
      // Served by /api/encrypt (action) to stay under Vercel's 12-function cap.
      const resp = await fetch("/api/encrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
        body: JSON.stringify({
          action: "stream-session", companyId,
          provider: bill.provider_display || bill.provider,
          account: bill.account_number || bill.utility_account_id || null,
          amount: safeNum(bill.amount) || null,
          billId: bill.bill_id || bill.id,
        }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        setError(e.error === "streamed payments are not configured"
          ? "Streamed payments aren't switched on yet." : (e.error || `Couldn't start (${resp.status})`));
        return;
      }
      const { streamBase, token, provider } = await resp.json();
      setStream({ streamBase, token, provider });
    } catch {
      setError("Couldn't reach the payment service.");
    }
  }, [bill, companyId]);

  // Open the provider's site immediately — this modal is a launcher, not a form.
  useEffect(() => { start(); }, [start]);

  if (stream) {
    return (
      <StreamedBrowser
        streamBase={stream.streamBase} token={stream.token} provider={stream.provider}
        onPaid={(msg) => { showToast("Payment confirmed — receipt captured.", "success"); onPaid && onPaid(msg); }}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[2500] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-pop w-full max-w-sm p-6 text-center">
        {error ? (
          <>
            <div className="w-12 h-12 rounded-xl bg-danger-50 text-danger-600 flex items-center justify-center mx-auto mb-3">
              <span className="material-icons-outlined">error_outline</span>
            </div>
            <p className="text-sm text-neutral-700 mb-4">{error}</p>
            <div className="flex gap-2">
              <button onClick={start} className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm">Try again</button>
              <button onClick={onClose} className="flex-1 border border-neutral-200 rounded-lg py-2 text-sm">Close</button>
            </div>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-xl bg-brand-100 text-brand-600 flex items-center justify-center mx-auto mb-3 animate-pulse">
              <span className="material-icons-outlined">lock</span>
            </div>
            <p className="text-sm font-medium text-neutral-800">Opening {bill.provider_display || bill.provider} securely…</p>
            <p className="text-xs text-neutral-400 mt-1">You'll sign in and pay on their site. Your card never touches PropManager.</p>
          </>
        )}
      </div>
    </div>
  );
}
