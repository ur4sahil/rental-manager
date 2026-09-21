import React, { useState } from "react";
import { supabase } from "../supabase";
import { safeNum, formatCurrency, fmtDate, getSignedUrl } from "../utils/helpers";
import StreamedBrowser from "./StreamedBrowser";

// Review a utility bill, then pay it in a secure streamed browser. The person
// sees the amount due, can open the PDF statement, chooses how much to pay
// (full or partial, never more than owed), and only then presses Pay — which
// opens the utility's own card page streamed from the VPS. The card is typed by
// the person; PropManager never sees or stores it.
export default function PayBillModal({ bill, companyId, userProfile, onClose, onPaid, showToast }) {
  const due = safeNum(bill?.amount);
  const [amount, setAmount] = useState(due > 0 ? due.toFixed(2) : "");
  const [stream, setStream] = useState(null); // { streamBase, token, provider }
  const [minting, setMinting] = useState(false);

  const pay = safeNum(amount);
  const partial = pay > 0 && pay < due - 0.005;
  const invalid = !(pay > 0) || pay > due + 0.005;

  async function viewBill() {
    if (!bill?.pdf_storage_path) { showToast("No PDF statement is filed for this bill.", "error"); return; }
    try {
      const url = await getSignedUrl("documents", bill.pdf_storage_path, 300);
      if (url) window.open(url, "_blank", "noopener");
      else showToast("Could not open the statement.", "error");
    } catch { showToast("Could not open the statement.", "error"); }
  }

  async function startPayment() {
    if (invalid || minting) return;
    setMinting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const access = sess?.session?.access_token;
      if (!access) { showToast("Please sign in again.", "error"); setMinting(false); return; }
      const resp = await fetch("/api/stream-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
        body: JSON.stringify({
          provider: bill.provider_display || bill.provider,
          account: bill.account_number || bill.utility_account_id || null,
          amount: pay, billId: bill.bill_id || bill.id, companyId,
        }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        showToast(e.error === "streamed payments are not configured"
          ? "Streamed payments aren't switched on yet." : `Couldn't start the payment: ${e.error || resp.status}`, "error");
        setMinting(false); return;
      }
      const { streamBase, token, provider } = await resp.json();
      setStream({ streamBase, token, provider });
    } catch (e) {
      showToast("Couldn't reach the payment service.", "error");
    } finally {
      setMinting(false);
    }
  }

  if (stream) {
    return (
      <StreamedBrowser
        streamBase={stream.streamBase} token={stream.token} provider={stream.provider}
        onPaid={(msg) => { showToast("Payment confirmed — receipt captured.", "success"); onPaid && onPaid(msg, pay); }}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-[2500] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-pop w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-display font-bold text-neutral-800">Pay {bill.provider_display || bill.provider}</h3>
          <button onClick={onClose} className="text-neutral-400 hover:text-neutral-700">✕</button>
        </div>

        <div className="bg-neutral-50 rounded-xl p-3 space-y-1 text-sm mb-4">
          <div className="flex justify-between"><span className="text-neutral-500">Property</span><span className="font-medium text-neutral-800">{bill.property}</span></div>
          <div className="flex justify-between"><span className="text-neutral-500">Amount due</span><span className="font-bold text-neutral-900">{formatCurrency(due)}</span></div>
          {bill.due && <div className="flex justify-between"><span className="text-neutral-500">Due date</span><span className="font-medium text-neutral-800">{fmtDate(bill.due)}</span></div>}
          {bill.account_number && <div className="flex justify-between"><span className="text-neutral-500">Account</span><span className="font-medium text-neutral-800">{bill.account_number}</span></div>}
        </div>

        <button onClick={viewBill} disabled={!bill.pdf_storage_path}
          className="w-full mb-4 inline-flex items-center justify-center gap-2 border border-neutral-200 rounded-lg py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-40">
          <span className="material-icons-outlined text-base">picture_as_pdf</span>
          {bill.pdf_storage_path ? "View bill (PDF)" : "No statement filed"}
        </button>

        <label className="text-xs font-medium text-neutral-500 block mb-1">How much do you want to pay?</label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400">$</span>
          <input type="number" step="0.01" min="0" max={due} value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full border border-neutral-200 rounded-lg pl-7 pr-3 py-2 text-sm" />
        </div>
        <div className="flex gap-2 mt-2 text-xs">
          <button onClick={() => setAmount(due.toFixed(2))} className="text-brand-600 hover:underline">Pay full {formatCurrency(due)}</button>
        </div>
        {partial && <p className="text-xs text-warn-700 mt-2">Part payment — {formatCurrency(due - pay)} will remain owed.</p>}
        {pay > due + 0.005 && <p className="text-xs text-danger-600 mt-2">That's more than the {formatCurrency(due)} owed.</p>}

        <div className="flex gap-3 mt-5">
          <button onClick={startPayment} disabled={invalid || minting}
            className="flex-1 bg-brand-600 text-white rounded-lg py-2.5 text-sm font-medium hover:bg-brand-700 disabled:opacity-40">
            {minting ? "Opening secure browser…" : `Pay ${pay > 0 ? formatCurrency(pay) : ""}`}
          </button>
          <button onClick={onClose} className="flex-1 border border-neutral-200 rounded-lg py-2.5 text-sm text-neutral-700 hover:bg-neutral-50">Cancel</button>
        </div>
        <p className="text-2xs text-neutral-400 mt-3 text-center">You'll enter your card on {(bill.provider_display || bill.provider)}'s own page. Your card never touches PropManager.</p>
      </div>
    </div>
  );
}
