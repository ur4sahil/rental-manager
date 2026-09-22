import React, { useState, useCallback } from "react";
import { supabase } from "../supabase";
import { safeNum, formatCurrency } from "../utils/helpers";
import StreamedBrowser from "./StreamedBrowser";

// Pay a utility on the provider's own site, streamed into the app.
//
// FIRST, in Housy, the person picks WHAT to pay (full balance or a specific
// amount) and HOW (card or ACH). Then the streamed browser opens and DRIVES
// itself to the provider's card-entry page with those choices already applied
// (select account -> Pay -> Make a Payment -> amount page: set amount + method
// -> Next). The person only types the card and submits. The amount-as-money and
// the card live on the provider's site, never in Housy.
export default function PayBillModal({ bill, companyId, onClose, onPaid, showToast }) {
  const due = safeNum(bill.amount);
  const [full, setFull] = useState(due > 0);      // default to the full balance when there is one
  const [other, setOther] = useState("");
  const [method, setMethod] = useState("card");
  const [stream, setStream] = useState(null);      // { streamBase, token, provider }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const provider = bill.provider_display || bill.provider;
  const amount = full ? due : safeNum(other);
  const amountValid = full ? true : amount > 0;

  const start = useCallback(async () => {
    setError(null); setBusy(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const access = sess?.session?.access_token;
      if (!access) { setError("Please sign in again."); setBusy(false); return; }
      const resp = await fetch("/api/encrypt", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
        body: JSON.stringify({
          action: "stream-session", companyId, provider: bill.provider_display || bill.provider,
          account: bill.account_number || bill.utility_account_id || null,
          amount: full ? due : amount, full, method,
          billId: bill.bill_id || bill.id,
        }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        setError(e.error === "streamed payments are not configured"
          ? "Streamed payments aren't switched on yet." : (e.error || `Couldn't start (${resp.status})`));
        setBusy(false); return;
      }
      const { streamBase, token, provider: p } = await resp.json();
      setStream({ streamBase, token, provider: p });
    } catch {
      setError("Couldn't reach the payment service."); setBusy(false);
    }
  }, [bill, companyId, full, method, amount, due]);

  if (stream) {
    return (
      <StreamedBrowser
        streamBase={stream.streamBase} token={stream.token} provider={stream.provider}
        onPaid={(msg) => { showToast("Payment confirmed — receipt captured.", "success"); onPaid && onPaid(msg); }}
        onClose={onClose}
      />
    );
  }

  const radio = (checked) => `w-4 h-4 rounded-full border flex items-center justify-center ${checked ? "border-brand-600" : "border-neutral-300"}`;
  const dot = (checked) => checked ? <span className="w-2 h-2 rounded-full bg-brand-600" /> : null;

  return (
    <div className="fixed inset-0 z-[2500] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-pop w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-1">
          <h3 className="text-lg font-semibold text-neutral-900">Pay {provider}</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-600">
            <span className="material-icons-outlined">close</span>
          </button>
        </div>
        <p className="text-sm text-neutral-500 mb-4 truncate">{bill.property}</p>

        {/* Amount */}
        <div className="mb-4">
          <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">How much?</div>
          <button type="button" onClick={() => setFull(true)}
            className={`w-full flex items-center gap-3 rounded-xl border px-4 py-3 mb-2 text-left ${full ? "border-brand-600 bg-brand-50" : "border-neutral-200"}`}>
            <span className={radio(full)}>{dot(full)}</span>
            <span className="flex-1 text-sm text-neutral-800">Pay full balance</span>
            <span className="text-sm font-semibold text-neutral-900">{formatCurrency(due)}</span>
          </button>
          <button type="button" onClick={() => setFull(false)}
            className={`w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left ${!full ? "border-brand-600 bg-brand-50" : "border-neutral-200"}`}>
            <span className={radio(!full)}>{dot(!full)}</span>
            <span className="flex-1 text-sm text-neutral-800">Pay other amount</span>
            <span className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-400 text-sm">$</span>
              <input type="number" min="0" step="0.01" value={other} placeholder="0.00"
                onFocus={() => setFull(false)} onChange={(e) => setOther(e.target.value)}
                className="w-28 rounded-lg border border-neutral-200 pl-5 pr-2 py-1 text-sm text-right" />
            </span>
          </button>
        </div>

        {/* Method */}
        <div className="mb-5">
          <div className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">Pay with</div>
          <div className="flex gap-2">
            {[["card", "Credit / Debit Card"], ["ach", "ACH (E-Check)"]].map(([val, label]) => (
              <button key={val} type="button" onClick={() => setMethod(val)}
                className={`flex-1 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${method === val ? "border-brand-600 bg-brand-50 text-neutral-900" : "border-neutral-200 text-neutral-700"}`}>
                <span className={radio(method === val)}>{dot(method === val)}</span>{label}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-sm text-danger-600 mb-3">{error}</p>}

        <button onClick={start} disabled={busy || !amountValid}
          className="w-full bg-brand-600 disabled:opacity-50 text-white rounded-xl py-2.5 text-sm font-medium flex items-center justify-center gap-2">
          {busy ? "Opening secure browser…" : <>Continue to {provider} — pay {formatCurrency(amount)}</>}
        </button>
        <p className="text-xs text-neutral-400 mt-2 text-center">
          Opens {provider}'s own site in a secure browser. You enter the card there — it never touches Housy.
        </p>
      </div>
    </div>
  );
}
