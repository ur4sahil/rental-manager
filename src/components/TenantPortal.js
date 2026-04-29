import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, FileInput, Input, PageHeader, Select, Textarea } from "../ui";
import { safeNum, formatLocalDate, shortId, formatCurrency, sanitizeFileName, exportToCSV, getSignedUrl, emailFilterValue, escapeFilterValue } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { Spinner, DocUploadModal, generatePaymentReceipt } from "./shared";
import { MessageThread, MessageComposer, uploadMessageAttachment } from "./Messages";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";

// Lazy-init Stripe so the bundle doesn't load Stripe.js on portal mount.
// Promise is memoized at module scope per Stripe's docs to avoid
// re-loading on every render.
const stripePublishableKey = process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY || "";
const stripePromise = stripePublishableKey ? loadStripe(stripePublishableKey) : null;

// Pass-through fee math, mirrored from api/stripe.js so the Pay Rent
// UI can preview "Card: $X · Bank: $Y" before the tenant commits to a
// method. The webhook on the server side recomputes from the same
// formulas using the metadata we set at intent creation.
//   Card:  total = ceil((rent + 30) / 0.971) — 2.9% + $0.30
//   ACH:   total = ceil(rent / 0.992) capped so fee ≤ $5.00
function computeFeeForMethod(rentDollars, method) {
  const rentCents = Math.round(safeNum(rentDollars) * 100);
  if (method === "us_bank_account") {
    const totalUncapped = Math.ceil(rentCents / 0.992);
    const feeUncapped = totalUncapped - rentCents;
    if (feeUncapped >= 500) {
      return { totalCents: rentCents + 500, feeCents: 500, rentCents };
    }
    return { totalCents: totalUncapped, feeCents: feeUncapped, rentCents };
  }
  // Default = card (Apple/Google Pay wallet-wrap a card → same fee)
  const totalCents = Math.ceil((rentCents + 30) / 0.971);
  return { totalCents, feeCents: totalCents - rentCents, rentCents };
}

// Inner card form — must live inside <Elements>. Receives the
// PaymentIntent's client_secret + a callback for what to do after
// successful confirmation. Stripe handles the actual card capture +
// 3DS challenge inline.
function StripeCardForm({ clientSecret, totalCents, feeCents, rentCents, payMethod, onSuccess, onError, busy, setBusy }) {
  const stripe = useStripe();
  const elements = useElements();
  const [localError, setLocalError] = useState("");

  const isAch = payMethod === "us_bank_account";
  const feeLabel = isAch ? "ACH fee (0.8%, max $5)" : "Processing fee (2.9% + $0.30)";

  async function handleSubmit(e) {
    e.preventDefault();
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setLocalError("");
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.origin + "?payment=success" },
      redirect: "if_required",
    });
    if (error) {
      setLocalError(error.message || "Payment declined.");
      onError && onError(error.message || "Payment declined");
      setBusy(false);
      return;
    }
    // Status flow varies by method:
    //   Card:  succeeded (instant) — JE posts via webhook now
    //   ACH/FC: processing (instant verification via Financial Connections)
    //          → eventually succeeded when the ACH clears (1-3 days)
    //   ACH/microdeposit: requires_action (tenant verifies $0.01 deposit
    //          in 1-2 days, then status moves to processing → succeeded)
    // All three are valid "we got it" states — the JE doesn't post until
    // the webhook fires payment_intent.succeeded. Pass paymentIntent up
    // so the parent can show method-appropriate copy.
    const ok = ["succeeded", "processing", "requires_action"];
    if (paymentIntent && ok.includes(paymentIntent.status)) {
      onSuccess && onSuccess(paymentIntent);
    } else {
      setLocalError("Unexpected payment status: " + (paymentIntent?.status || "unknown"));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement options={{ layout: "tabs" }} />
      <div className="mt-4 p-3 bg-neutral-50 rounded-lg text-sm">
        <div className="flex justify-between text-neutral-600">
          <span>Rent</span><span className="font-mono">${(rentCents / 100).toFixed(2)}</span>
        </div>
        <div className="flex justify-between text-neutral-500 text-xs mt-1">
          <span>{feeLabel}</span><span className="font-mono">${(feeCents / 100).toFixed(2)}</span>
        </div>
        <div className="flex justify-between font-semibold text-neutral-800 mt-2 pt-2 border-t border-neutral-200">
          <span>Total charge</span><span className="font-mono">${(totalCents / 100).toFixed(2)}</span>
        </div>
      </div>
      {localError && <div className="mt-3 text-xs text-danger-600 bg-danger-50 border border-danger-200 rounded-lg px-3 py-2">{localError}</div>}
      <Btn type="submit" variant="primary" size="lg" className="w-full mt-4" disabled={!stripe || busy}>
        {busy ? "Processing…" : "Pay $" + (totalCents / 100).toFixed(2)}
      </Btn>
      <div className="text-xs text-neutral-400 text-center mt-3">{isAch ? "Bank account payments take 1-3 business days to clear." : "Secured by Stripe — your card details never touch our servers."}</div>
    </form>
  );
}

// Inner form for the Autopay tab. Uses Stripe's confirmSetup (not
// confirmPayment) — saves the card without charging. On success the
// parent calls /api/stripe?action=save-payment-method to persist the
// autopay_schedules row.
function SetupCardForm({ clientSecret, onSuccess, onError, busy, setBusy }) {
  const stripe = useStripe();
  const elements = useElements();
  const [localError, setLocalError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setLocalError("");
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.origin + "?autopay=saved" },
      redirect: "if_required",
    });
    if (error) {
      setLocalError(error.message || "Couldn't save card.");
      onError && onError(error.message || "Couldn't save card");
      setBusy(false);
      return;
    }
    if (setupIntent?.status === "succeeded") {
      onSuccess && onSuccess(setupIntent);
    } else {
      setLocalError("Unexpected status: " + (setupIntent?.status || "unknown"));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement options={{ layout: "tabs" }} />
      {localError && <div className="mt-3 text-xs text-danger-600 bg-danger-50 border border-danger-200 rounded-lg px-3 py-2">{localError}</div>}
      <Btn type="submit" variant="primary" size="lg" className="w-full mt-4" disabled={!stripe || busy}>
        {busy ? "Saving…" : "Save card for autopay"}
      </Btn>
      <div className="text-xs text-neutral-400 text-center mt-3">No charge today. We'll auto-charge rent on the 1st of each month.</div>
    </form>
  );
}

function TenantPortal({ currentUser, companyId, showToast, showConfirm, addNotification, initialTab, setPage }) {
  const [tenantData, setTenantData] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [payments, setPayments] = useState([]);
  const [messages, setMessages] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [msgAttachment, setMsgAttachment] = useState(null);
  const [sendingMsg, setSendingMsg] = useState(false);
  // Every active staff member for this company — destinations for the
  // tenant's outbound message / payment notifications. Previously we
  // picked ONE admin via limit(1), so only the first-returned admin
  // was ever pinged; other admins, managers, owners, and office
  // assistants never got the in-app/email/push. Fan out to everyone
  // who has inbox access on the staff side.
  const [staffEmails, setStaffEmails] = useState([]);
  // The property-management company's display name. Tenants see this
  // on all incoming messages instead of individual staff names —
  // their landlord is "the company" not whichever team member happens
  // to be on duty that day.
  const [companyName, setCompanyName] = useState(null);
  const [activeTab, setActiveTab] = useState(initialTab || "overview");
  // Sidebar nav drives tab via initialTab prop. Sync on prop change so
  // clicks on the sidebar swap the tab instead of unmounting the
  // whole TenantPortal (which would re-fetch ledger/messages/etc.).
  useEffect(() => { if (initialTab) setActiveTab(initialTab); }, [initialTab]);
  const [loading, setLoading] = useState(true);
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  // Tracks the post-confirm status of the most recent PaymentIntent.
  // Drives the success-banner copy: card/wallet → "recorded";
  // ACH instant → "processing"; ACH microdeposit → "verification pending".
  const [paymentPendingStatus, setPaymentPendingStatus] = useState(null);
  // When non-null: the Pay Rent tab swaps from the amount-input card
  // into a Stripe Elements card form. Cleared on success or when the
  // tenant cancels.
  const [stripeIntent, setStripeIntent] = useState(null);
  // Pay-method picker: "card" (incl. Apple/Google Pay since they
  // wallet-wrap a card) or "us_bank_account" (ACH). Drives the
  // pass-through fee math and the payment_method_types passed to
  // create-intent. Card is the default since most tenants pay by
  // card and Apple/Google Pay piggyback on it.
  const [payMethod, setPayMethod] = useState("card");
  // Stripe SetupIntent for the Autopay tab. When non-null the Autopay
  // tab renders the card-capture form; on confirm we POST to
  // save-payment-method which writes the autopay_schedules row.
  const [setupIntent, setSetupIntent] = useState(null);
  const [setupBusy, setSetupBusy] = useState(false);
  // The active stripe-autopay row for this tenant (provider='stripe',
  // archived_at IS NULL). Drives the Autopay tab UI: row present →
  // show card + disable button; row null → show "Set up autopay" CTA.
  const [stripeAutopay, setStripeAutopay] = useState(null);
  // Tenant's AR account + lines, hydrated by fetchData. Drives the
  // Ledger tab. account_id is the per-tenant AR sub-account if one
  // exists, else the bare AR account. Lines come from
  // acct_journal_lines joined to acct_journal_entries for the date +
  // description.
  const [ledgerLines, setLedgerLines] = useState([]);
  // Maintenance request form
  const [showMaintForm, setShowMaintForm] = useState(false);
  const [maintForm, setMaintForm] = useState({ issue: "", priority: "normal", notes: "" });
  const [maintPhotos, setMaintPhotos] = useState([]);
  const [showTenantDocUpload, setShowTenantDocUpload] = useState(false);

  useEffect(() => {
  async function fetchData() {
  const email = currentUser?.email;
  if (!email || !email.includes("@")) { setLoading(false); return; }
  const { data: tenant } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", emailFilterValue(email)).maybeSingle();
  if (!tenant) { setLoading(false); return; }
  setTenantData(tenant);
  setPaymentAmount(String(tenant.rent || ""));
  // Use tenant_id for reliable lookups where available, fall back to name
  // Use tenant_id for all lookups to prevent cross-tenant data leaks (same-name tenants)
  const tid = tenant.id;
  const tname = tenant.name;
  const [l, m, p, w, d] = await Promise.all([
  tid
  ? supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant_id", tid).order("date", { ascending: false })
  : supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant", tname).eq("property", tenant.property).order("date", { ascending: false }),
  tid
  ? supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant_id", tid).order("created_at", { ascending: true })
  : supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant", tname).eq("property", tenant.property).order("created_at", { ascending: true }),
  tid
  ? supabase.from("payments").select("*").eq("company_id", companyId).eq("tenant_id", tid).is("archived_at", null).order("date", { ascending: false })
  : supabase.from("payments").select("*").eq("company_id", companyId).ilike("tenant", escapeFilterValue(tname)).eq("property", tenant.property).is("archived_at", null).order("date", { ascending: false }),
  supabase.from("work_orders").select("*").eq("company_id", companyId).eq("tenant", tname).eq("property", tenant.property).is("archived_at", null).order("created", { ascending: false }),
  supabase.from("documents").select("*").eq("company_id", companyId).eq("tenant", tname).eq("tenant_visible", true).is("archived_at", null).order("uploaded_at", { ascending: false }),
  ]);
  setLedger(l.data || []);
  setMessages(m.data || []);
  setPayments(p.data || []);
  setWorkOrders(w.data || []);
  setDocuments(d.data || []);
  // Resolve the destination staff for outbound message notifications.
  // Fetch every non-tenant active membership so the handleSend loop
  // below can fan out; the old single-admin lookup meant managers,
  // owners, office assistants and additional admins never heard from
  // a tenant even though they had inbox access.
  if (companyId) {
    const { data: staff } = await supabase.from("company_members")
      .select("user_email, role")
      .eq("company_id", companyId).eq("status", "active")
      .neq("role", "tenant");
    const emails = (staff || [])
      .map(s => (s.user_email || "").toLowerCase())
      .filter(Boolean);
    setStaffEmails(Array.from(new Set(emails)));
    // Fetch the company name so message bubbles on the tenant side
    // can attribute incoming messages to "Smith Properties LLC"
    // instead of whichever individual staff member typed.
    const { data: co } = await supabase.from("companies")
      .select("name").eq("id", companyId).maybeSingle();
    if (co?.name) setCompanyName(co.name);
  }
  // Mark any admin-sent messages as read now that the tenant is online.
  if (tid) {
    await supabase.from("messages")
      .update({ read_at: new Date().toISOString(), read: true })
      .eq("company_id", companyId)
      .eq("tenant_id", tid)
      .is("read_at", null)
      .neq("sender_role", "tenant");
  }
  // Stripe-autopay row + ledger hydration. Both are read here so the
  // Autopay and Ledger tabs render without an extra round-trip when
  // the tenant clicks them.
  if (tid) {
    const [{ data: apRow }, { data: arAccts }] = await Promise.all([
      supabase.from("autopay_schedules")
        .select("id, amount, day_of_month, next_charge_date, card_brand, card_last4, last_error, last_error_at, enabled, stripe_payment_method_id")
        .eq("company_id", companyId).eq("tenant_id", tid)
        .eq("provider", "stripe").is("archived_at", null)
        .maybeSingle(),
      supabase.from("acct_accounts")
        .select("id, code, name, tenant_id")
        .eq("company_id", companyId)
        .or(`tenant_id.eq.${tid},code.eq.1100,name.eq.Accounts Receivable`),
    ]);
    setStripeAutopay(apRow || null);
    setAutopayEnabled(!!apRow?.enabled);

    // Pick the per-tenant AR sub-account if one exists; fall back to
    // the bare AR. Ledger reads lines for that account_id.
    const arAcct = (arAccts || []).find(a => String(a.tenant_id) === String(tid))
      || (arAccts || []).find(a => a.code === "1100" || a.name === "Accounts Receivable");
    if (arAcct) {
      const { data: lines } = await supabase.from("acct_journal_lines")
        .select("id, debit, credit, memo, journal_entry_id, acct_journal_entries(date, description, reference, status)")
        .eq("company_id", companyId).eq("account_id", arAcct.id)
        .order("id", { ascending: false }).limit(200);
      const filtered = (lines || []).filter(r => r.acct_journal_entries?.status === "posted");
      // Sort by JE date desc, then id desc, so same-day entries keep
      // insertion order.
      filtered.sort((a, b) => {
        const da = a.acct_journal_entries?.date || "";
        const db = b.acct_journal_entries?.date || "";
        if (da !== db) return da < db ? 1 : -1;
        return b.id - a.id;
      });
      setLedgerLines(filtered);
    } else {
      setLedgerLines([]);
    }
  }
  setLoading(false);
  }
  fetchData();
  }, [currentUser, companyId]);

  async function refreshData() {
  if (!tenantData) return;
  const tid = tenantData.id;
  const tname = tenantData.name;
  const tprop = tenantData.property;
  const [l, p, w, m] = await Promise.all([
  tid
  ? supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant_id", tid).order("date", { ascending: false })
  : supabase.from("ledger_entries").select("*").eq("company_id", companyId).eq("tenant", tname).eq("property", tprop).order("date", { ascending: false }),
  tid
  ? supabase.from("payments").select("*").eq("company_id", companyId).eq("tenant_id", tid).is("archived_at", null).order("date", { ascending: false })
  : supabase.from("payments").select("*").eq("company_id", companyId).eq("tenant", tname).eq("property", tprop).is("archived_at", null).order("date", { ascending: false }),
  supabase.from("work_orders").select("*").eq("company_id", companyId).eq("tenant", tname).eq("property", tprop).is("archived_at", null).order("created", { ascending: false }),
  tid
  ? supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant_id", tid).order("created_at", { ascending: true })
  : supabase.from("messages").select("*").eq("company_id", companyId).eq("tenant", tname).eq("property", tprop).order("created_at", { ascending: true }),
  ]);
  setLedger(l.data || []);
  setPayments(p.data || []);
  setWorkOrders(w.data || []);
  setMessages(m.data || []);
  // Refresh tenant balance
  const { data: t } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", emailFilterValue(currentUser?.email || "")).maybeSingle();
  if (t) setTenantData(t);
  }

  // ---- STRIPE PAYMENT ----
  // Initiate a Stripe payment: validate amount, request a PaymentIntent
  // from /api/stripe?action=create-intent, and stash the client_secret +
  // fee breakdown so the StripeCardForm renders in the Pay Rent tab.
  // The user then types their card and confirms; Stripe webhook posts
  // the JE on success.
  async function handleStripePayment() {
  if (!guardSubmit("handleStripePayment")) return;
  try {
    if (!paymentAmount || isNaN(Number(paymentAmount)) || Number(paymentAmount) <= 0) {
      showToast("Please enter a valid payment amount.", "error"); return;
    }
    setPaymentSuccess(false);
    if (Number(paymentAmount) > safeNum(tenantData.balance)) {
      if (!await showConfirm({ message: "Payment amount ($" + paymentAmount + ") exceeds your balance ($" + safeNum(tenantData.balance).toFixed(2) + "). The overpayment will be applied as a credit. Continue?" })) return;
    }
    if (!stripePromise) {
      showToast("Stripe is not configured for this site. Contact your admin.", "error");
      return;
    }
    setPaymentProcessing(true);
    const amt = Number(paymentAmount);
    try {
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      if (!jwt) { showToast("Session expired. Please sign in again.", "error"); return; }
      const res = await fetch("/api/stripe?action=create-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
        body: JSON.stringify({ amount: amt, tenant_id: tenantData.id, company_id: companyId, payment_method: payMethod }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast("Payment setup failed: " + (data.error || res.status), "error"); return; }
      setStripeIntent({
        client_secret: data.client_secret,
        total_cents: data.total_cents,
        fee_cents: data.fee_cents,
        rent_cents: data.rent_cents,
      });
    } catch (e) {
      pmError("PM-8006", { raw: e, context: "stripe create-intent", silent: false });
      showToast("Payment setup failed: " + e.message, "error");
    } finally {
      setPaymentProcessing(false);
    }
  } finally { guardRelease("handleStripePayment"); }
  }

  // Called from inside StripeCardForm after Stripe confirms the
  // PaymentIntent. The JE post happens server-side via webhook —
  // here we just give the tenant immediate feedback + refresh local
  // state so the balance updates without a round-trip.
  async function onStripeSuccess(paymentIntent) {
    setPaymentSuccess(true);
    setPaymentAmount("");
    setStripeIntent(null);
    const amt = (paymentIntent?.amount || 0) / 100;
    const status = paymentIntent?.status;
    // Customize the toast + ledger refresh by status. Card / wallet
    // payments confirm instantly; ACH lands as `processing` (instant
    // verification) or `requires_action` (microdeposit verification
    // pending). The JE only posts once the webhook fires `succeeded`.
    if (status === "requires_action") {
      addNotification("🏦", "Bank verification pending. Check your email in 1-2 business days.");
    } else if (status === "processing") {
      addNotification("🏦", "Payment of $" + amt.toFixed(2) + " is processing. We'll email you when it clears.");
    } else {
      addNotification("💳", "Payment of $" + amt.toFixed(2) + " confirmed.");
    }
    setPaymentPendingStatus(status);
    // Refetch the tenant balance shortly after — only meaningful for
    // the synchronous "succeeded" path. ACH balance updates when the
    // webhook fires a few days later.
    setTimeout(async () => {
      const { data: refreshed } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", emailFilterValue(currentUser?.email || "")).maybeSingle();
      if (refreshed) setTenantData(refreshed);
    }, 1500);
  }

  // ---- STRIPE AUTOPAY (Phase 2) ----
  // The "Set up autopay" CTA POSTs to create-setup-intent, which
  // returns a SetupIntent client_secret. Setting setupIntent here
  // mounts <Elements> + <SetupCardForm> on the Autopay tab, where the
  // tenant enters the card. On confirmSetup success, onSetupSuccess
  // POSTs to save-payment-method which writes the autopay row.
  async function handleSetupAutopay() {
    if (!guardSubmit("setupAutopay")) return;
    try {
      if (!stripePromise) { showToast("Stripe is not configured.", "error"); return; }
      setSetupBusy(true);
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      if (!jwt) { showToast("Session expired. Please sign in again.", "error"); return; }
      const res = await fetch("/api/stripe?action=create-setup-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
        body: JSON.stringify({ tenant_id: tenantData.id, company_id: companyId, payment_method_types: ["card"] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast("Autopay setup failed: " + (data.error || res.status), "error"); return; }
      setSetupIntent({ client_secret: data.client_secret, customer_id: data.customer_id });
    } catch (e) {
      pmError("PM-8006", { raw: e, context: "stripe create-setup-intent", silent: false });
      showToast("Autopay setup failed: " + e.message, "error");
    } finally {
      setSetupBusy(false);
      guardRelease("setupAutopay");
    }
  }

  async function onSetupSuccess(confirmedSetupIntent) {
    try {
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      const res = await fetch("/api/stripe?action=save-payment-method", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
        body: JSON.stringify({
          setup_intent_id: confirmedSetupIntent.id,
          tenant_id: tenantData.id,
          company_id: companyId,
          day_of_month: 1,
          amount: safeNum(tenantData.rent),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast("Couldn't save autopay: " + (data.error || res.status), "error"); return; }
      setSetupIntent(null);
      // Re-fetch the autopay row so the UI swaps to the saved-card view.
      const { data: apRow } = await supabase.from("autopay_schedules")
        .select("id, amount, day_of_month, next_charge_date, card_brand, card_last4, last_error, last_error_at, enabled, stripe_payment_method_id")
        .eq("company_id", companyId).eq("tenant_id", tenantData.id)
        .eq("provider", "stripe").is("archived_at", null)
        .maybeSingle();
      setStripeAutopay(apRow || null);
      setAutopayEnabled(!!apRow?.enabled);
      addNotification("🔄", "Autopay set up — " + (data.card_brand || "card") + " ending " + (data.card_last4 || "••••"));
    } catch (e) {
      pmError("PM-8006", { raw: e, context: "stripe save-payment-method", silent: false });
      showToast("Couldn't save autopay: " + e.message, "error");
    }
  }

  async function handleDisableStripeAutopay() {
    if (!await showConfirm({ message: "Disable autopay? Your saved card will be removed and rent will not be auto-charged next month." })) return;
    try {
      const { data: session } = await supabase.auth.getSession();
      const jwt = session?.session?.access_token;
      const res = await fetch("/api/stripe?action=disable-autopay", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt },
        body: JSON.stringify({ tenant_id: tenantData.id, company_id: companyId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast("Couldn't disable autopay: " + (data.error || res.status), "error"); return; }
      setStripeAutopay(null);
      setAutopayEnabled(false);
      addNotification("🔄", "Autopay disabled");
    } catch (e) {
      showToast("Couldn't disable autopay: " + e.message, "error");
    }
  }

  // ---- MAINTENANCE REQUEST ----
  async function submitMaintenanceRequest() {
  if (!guardSubmit("submitMaintenanceRequest")) return;
  try {
  if (!maintForm.issue.trim()) { showToast("Please describe the issue.", "error"); return; }
  // Create the work order first
  const { data: newWO, error } = await supabase.from("work_orders").insert([{ company_id: companyId,
  property: tenantData.property,
  tenant: tenantData.name,
  issue: maintForm.issue,
  priority: maintForm.priority,
  status: "open",
  created: formatLocalDate(new Date()),
  notes: maintForm.notes,
  cost: 0,
  }]).select();
  // Upload photos and link to the work order
  if (newWO?.[0] && maintPhotos.length > 0) {
  for (const photo of maintPhotos) {
  const fileName = shortId() + "-" + sanitizeFileName(photo.name);
  const { error: uploadErr } = await supabase.storage.from("maintenance-photos").upload(fileName, photo);
  if (!uploadErr) {
  await supabase.from("work_order_photos").insert([{
  work_order_id: newWO[0].id, property: tenantData.property,
  url: fileName, caption: photo.name,
  company_id: companyId, storage_bucket: "maintenance-photos"
  }]);
  }
  }
  }
  if (error) { pmError("PM-7001", { raw: error, context: "submit maintenance request" }); return; }
  logAudit("create", "maintenance", "Tenant submitted: " + maintForm.issue, "", currentUser?.email, "tenant", companyId);
  setMaintForm({ issue: "", priority: "normal", notes: "" });
  setMaintPhotos([]);
  setShowMaintForm(false);
  await refreshData();
  } finally { guardRelease("submitMaintenanceRequest"); }
  }

  // ---- MESSAGING ----
  async function sendMessage() {
  if (!tenantData) return;
  const body = newMessage.trim();
  if (!body && !msgAttachment) return;
  if (!guardSubmit("tenantPortal:send")) return;
  setSendingMsg(true);
  try {
    let attachmentPath = null;
    let attachmentName = null;
    if (msgAttachment) {
      attachmentPath = await uploadMessageAttachment(msgAttachment, companyId);
      if (!attachmentPath) { showToast("Attachment upload failed.", "error"); return; }
      attachmentName = msgAttachment.name;
    }
    // sender_role='tenant' is the key — the admin page reads this to
    // distinguish incoming vs outgoing bubbles, and the unread-badge
    // count on the sidebar filters by it.
    const { error: insErr } = await supabase.from("messages").insert([{
      company_id: companyId,
      tenant_id: tenantData.id,
      tenant: tenantData.name,
      property: tenantData.property,
      sender: tenantData.name,
      sender_email: currentUser?.email || null,
      sender_role: "tenant",
      message: body,
      attachment_url: attachmentPath,
      attachment_name: attachmentName,
      read: false,
      read_at: null,
    }]);
    if (insErr) { pmError("PM-8006", { raw: insErr, context: "messages write" }); return; }
    setNewMessage("");
    setMsgAttachment(null);
    // Notify every active staff member. Fan-out is fine — queueNotification
    // dedupes per recipient in notification_queue; worst case one staff
    // row fails independently (pmError logged, others still go through).
    // Sent best-effort — no toast on failure so we don't surface infra
    // noise to the tenant.
    if (staffEmails.length > 0) {
      const payload = {
        sender: tenantData.name,
        preview: body ? body.slice(0, 120) : (attachmentName ? "[attachment: " + attachmentName + "]" : ""),
        tenant: tenantData.name,
        property: tenantData.property,
      };
      await Promise.all(staffEmails.map(e => queueNotification("message_received", e, payload, companyId)));
    }
    const { data } = await supabase.from("messages").select("*")
      .eq("company_id", companyId)
      .eq("tenant_id", tenantData.id)
      .order("created_at", { ascending: true });
    setMessages(data || []);
  } finally {
    setSendingMsg(false);
    guardRelease("tenantPortal:send");
  }
  }

  async function deleteOwnMessage(m) {
  if (!m?.id || !tenantData) return;
  if (!await showConfirm({ message: "Delete this message? Your property manager will no longer see it.", variant: "danger", confirmText: "Delete" })) return;
  // Scope delete to this tenant's own row — safety net on top of the UI-
  // side rule that only outgoing bubbles expose the trash affordance.
  const { error } = await supabase.from("messages").delete()
    .eq("id", m.id)
    .eq("company_id", companyId)
    .eq("tenant_id", tenantData.id);
  if (error) { pmError("PM-8006", { raw: error, context: "tenant portal delete message" }); return; }
  const { data } = await supabase.from("messages").select("*")
    .eq("company_id", companyId)
    .eq("tenant_id", tenantData.id)
    .order("created_at", { ascending: true });
  setMessages(data || []);
  }

  const [autopayEnabled, setAutopayEnabled] = useState(false);
  const [autopayLoading, setAutopayLoading] = useState(false);

  if (loading) return <Spinner />;
  if (!tenantData) return (
  <div className="text-center py-20">
  <div className="text-5xl mb-4">🏠</div>
  <div className="text-neutral-500 font-semibold text-lg">No tenant account linked to this email.</div>
  <div className="text-neutral-400 text-sm mt-2">Contact your property manager to get access.</div>
  <div className="text-xs text-neutral-300 mt-4">{currentUser?.email}</div>
  </div>
  );

  // On the messages tab, App.js makes <main> a flex-col container so
  // the chat layout can fill the viewport. Mirror that on this
  // wrapper so the persistent header keeps its natural height and
  // the active tab content (the messages container below) gets a
  // flex-1 height to size against. Other tabs are scroll-flow content
  // and unaffected by the flex layout.
  const useFlexLayout = activeTab === "messages";
  return (
  <div className={useFlexLayout ? "flex flex-col flex-1 min-h-0" : ""}>
  {/* Tenant Header — kept above the tab content as a persistent
      summary (balance/rent/lease end). The tab strip itself moved to
      the left sidebar; navigation is driven by initialTab prop now. */}
  <div className="bg-gradient-to-r from-brand-600 to-brand-800 rounded-3xl p-5 mb-5 text-white">
  <div className="flex justify-between items-start">
  <div>
  <div className="text-lg font-bold">{tenantData.name}</div>
  <div className="text-brand-200 text-sm">{tenantData.property}</div>
  </div>
  <div className="text-right text-xs text-brand-200">Lease: {tenantData.lease_status || "active"}</div>
  </div>
  <div className="mt-3 grid grid-cols-3 gap-3">
  <div className="bg-white/10 backdrop-blur rounded-lg p-3 text-center">
  <div className="text-xs text-brand-200">Balance Due</div>
  <div className={"text-xl font-bold " + (safeNum(tenantData.balance) > 0 ? "text-danger-300" : "text-positive-300")}>
  {safeNum(tenantData.balance) > 0 ? "$" + safeNum(tenantData.balance).toLocaleString() : "$0.00"}
  </div>
  </div>
  <div className="bg-white/10 backdrop-blur rounded-lg p-3 text-center">
  <div className="text-xs text-brand-200">Monthly Rent</div>
  <div className="text-xl font-bold">${safeNum(tenantData.rent).toLocaleString()}</div>
  </div>
  <div className="bg-white/10 backdrop-blur rounded-lg p-3 text-center">
  <div className="text-xs text-brand-200">Lease End</div>
  <div className="text-sm font-bold mt-1">{tenantData.lease_end_date || tenantData.move_out || "—"}</div>
  </div>
  </div>
  </div>

  {/* ---- OVERVIEW TAB ---- */}
  {activeTab === "overview" && (
  <div className="space-y-4">
  <div className="bg-white rounded-3xl border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Lease Details</h3>
  {[["Status", (tenantData.lease_status || "active")], ["Property", tenantData.property], ["Move-in", tenantData.lease_start || tenantData.move_in || "—"], ["Lease End", tenantData.lease_end_date || tenantData.move_out || "—"], ["Monthly Rent", "$" + safeNum(tenantData.rent).toLocaleString()], ["Email", tenantData.email || "—"], ["Phone", tenantData.phone || "—"]].map(([l, v]) => (
  <div key={l} className="flex justify-between py-2 border-b border-brand-50/50 text-sm last:border-0"><span className="text-neutral-400">{l}</span><span className="font-medium text-neutral-800 capitalize">{v}</span></div>
  ))}
  </div>
  {safeNum(tenantData.balance) > 0 && (
  <div className="bg-danger-50 border border-danger-100 rounded-3xl p-4 flex items-center justify-between">
  <div>
  <div className="text-sm font-semibold text-danger-800">Balance Due: ${safeNum(tenantData.balance).toLocaleString()}</div>
  <div className="text-xs text-danger-600">Please make a payment to avoid late fees.</div>
  </div>
  <Btn variant="danger-fill" size="xs" onClick={() => setPage ? setPage("tenant_pay") : setActiveTab("pay")}>Pay Now</Btn>
  </div>
  )}
  <div className="bg-white rounded-3xl border border-brand-50 p-4">
  <h3 className="font-semibold text-neutral-700 mb-3">Recent Activity</h3>
  {payments.slice(0, 3).map(p => (
  <div key={p.id} className="flex justify-between py-2 border-b border-brand-50/50 last:border-0 text-sm">
  <div><span className="text-positive-600 font-medium">Payment</span> <span className="text-neutral-400">— {p.date}</span></div>
  <span className="font-semibold text-neutral-800">${safeNum(p.amount).toLocaleString()}</span>
  </div>
  ))}
  {workOrders.slice(0, 2).map(w => (
  <div key={w.id} className="flex justify-between py-2 border-b border-brand-50/50 last:border-0 text-sm">
  <div><span className="text-notice-600 font-medium">Maintenance</span> <span className="text-neutral-400">— {w.issue}</span></div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (w.status === "completed" ? "bg-positive-100 text-positive-700" : w.status === "in_progress" ? "bg-info-100 text-info-700" : "bg-warn-100 text-warn-700")}>{w.status}</span>
  </div>
  ))}
  {payments.length === 0 && workOrders.length === 0 && <div className="text-center py-4 text-neutral-400 text-sm">No recent activity</div>}
  </div>
  </div>
  )}

  {/* ---- PAY RENT TAB ---- */}
  {activeTab === "pay" && (
  <div className="max-w-md mx-auto">
  {paymentSuccess && (
  paymentPendingStatus === "requires_action" ? (
    <div className="bg-info-50 border border-info-200 rounded-3xl p-4 mb-4 text-center">
    <div className="text-2xl mb-1">🏦</div>
    <div className="text-info-800 font-semibold">Bank verification pending</div>
    <div className="text-info-600 text-sm">You'll see a $0.01 deposit in 1-2 business days. Check your email for verification instructions to complete the payment.</div>
    </div>
  ) : paymentPendingStatus === "processing" ? (
    <div className="bg-info-50 border border-info-200 rounded-3xl p-4 mb-4 text-center">
    <div className="text-2xl mb-1">🏦</div>
    <div className="text-info-800 font-semibold">Payment processing</div>
    <div className="text-info-600 text-sm">ACH transfers take 1-3 business days to clear. You'll be notified when the payment posts.</div>
    </div>
  ) : (
    <div className="bg-positive-50 border border-positive-200 rounded-3xl p-4 mb-4 text-center">
    <div className="text-2xl mb-1">✅</div>
    <div className="text-positive-800 font-semibold">Payment Successful!</div>
    <div className="text-positive-600 text-sm">Your payment has been recorded and your balance updated.</div>
    </div>
  )
  )}

  {/* Two-step flow:
      1. Tenant enters an amount → click Pay → server creates a
         PaymentIntent and returns a client_secret.
      2. We swap into <Elements> + StripeCardForm so the tenant
         enters card details. On confirm, Stripe webhook posts the
         JE server-side and we toast success here.
      stripeIntent === null → step 1, otherwise step 2. */}
  {!stripeIntent ? (
  <div className="bg-white rounded-3xl border border-brand-50 p-6">
  <h3 className="font-semibold text-neutral-800 text-lg mb-1">Make a Payment</h3>
  <p className="text-sm text-neutral-400 mb-5">Pay securely with Stripe</p>
  <div className="mb-4">
  <label className="text-xs text-neutral-400 mb-1 block">Current Balance</label>
  <div className={"text-2xl font-bold " + (safeNum(tenantData.balance) > 0 ? "text-danger-600" : "text-positive-600")}>
  ${safeNum(tenantData.balance).toLocaleString()}
  </div>
  </div>
  <div className="mb-4">
  <label className="text-xs text-neutral-400 mb-1 block">Payment Amount</label>
  <div className="relative">
  <span className="absolute left-3 top-2.5 text-neutral-400">$</span>
  <Input type="number" value={paymentAmount} onChange={e => setPaymentAmount(e.target.value)} className="w-full border border-brand-100 rounded-2xl pl-7 pr-3 py-2.5 text-lg font-mono" placeholder="0.00" min="0" max="999999.99" step="0.01" />
  </div>
  <div className="flex gap-2 mt-2">
  <Btn variant="slate" size="xs" onClick={() => setPaymentAmount(String(tenantData.rent || 0))}>Full Rent (${safeNum(tenantData.rent)})</Btn>
  {safeNum(tenantData.balance) > 0 && <Btn variant="danger" size="xs" onClick={() => setPaymentAmount(String(tenantData.balance))}>Full Balance (${safeNum(tenantData.balance)})</Btn>}
  </div>
  </div>
  {/* Pay-method picker. Card and Bank get separate fee math; both
      previews are shown so the tenant sees what they'll actually
      pay before committing. Apple Pay / Google Pay piggyback on the
      card option (PaymentElement surfaces them as wallet buttons
      when the device supports them). */}
  {(() => {
    const cardMath = computeFeeForMethod(paymentAmount, "card");
    const achMath = computeFeeForMethod(paymentAmount, "us_bank_account");
    const opts = [
      { id: "card", label: "Card", sub: "Visa, Mastercard, Apple Pay, Google Pay", math: cardMath, feeLabel: "2.9% + $0.30" },
      { id: "us_bank_account", label: "Bank Account (ACH)", sub: "Connect your bank — slower (1-2 days)", math: achMath, feeLabel: "0.8% (max $5)" },
    ];
    return (
    <div className="mb-4">
    <label className="text-xs text-neutral-400 mb-2 block">Payment Method</label>
    <div className="grid grid-cols-1 gap-2">
    {opts.map(o => (
      <button key={o.id} type="button" onClick={() => setPayMethod(o.id)}
        className={"text-left rounded-2xl border p-3 transition-colors " + (payMethod === o.id ? "border-brand-600 bg-brand-50/40" : "border-brand-100 bg-white hover:border-brand-300")}>
      <div className="flex items-start justify-between">
        <div>
        <div className="text-sm font-semibold text-neutral-800">{o.label}</div>
        <div className="text-xs text-neutral-400">{o.sub}</div>
        </div>
        <div className="text-right">
        <div className="text-sm font-mono font-bold text-neutral-800">${(o.math.totalCents / 100).toFixed(2)}</div>
        <div className="text-xs text-neutral-400">+ ${(o.math.feeCents / 100).toFixed(2)} fee ({o.feeLabel})</div>
        </div>
      </div>
      </button>
    ))}
    </div>
    <div className="text-xs text-neutral-400 mt-2">Powered by Stripe · Secure payment processing. Your details never touch our servers.</div>
    </div>
    );
  })()}
  <Btn variant="primary" size="lg" className="w-full" onClick={handleStripePayment} disabled={paymentProcessing || !paymentAmount || Number(paymentAmount) <= 0}>
  {paymentProcessing ? "Loading…" : "Continue to Pay $" + (paymentAmount ? (computeFeeForMethod(paymentAmount, payMethod).totalCents / 100).toFixed(2) : "0.00")}
  </Btn>
  <div className="text-xs text-neutral-400 text-center mt-3">A receipt will be available after payment is confirmed.</div>
  </div>
  ) : (
  <div className="bg-white rounded-3xl border border-brand-50 p-6">
  <div className="flex items-center justify-between mb-4">
  <h3 className="font-semibold text-neutral-800 text-lg">{payMethod === "us_bank_account" ? "Bank details" : "Card details"}</h3>
  <button onClick={() => setStripeIntent(null)} className="text-xs text-neutral-400 hover:text-neutral-600 underline">Change amount</button>
  </div>
  <Elements stripe={stripePromise} options={{ clientSecret: stripeIntent.client_secret, appearance: { theme: "stripe" } }}>
  <StripeCardForm
    clientSecret={stripeIntent.client_secret}
    totalCents={stripeIntent.total_cents}
    feeCents={stripeIntent.fee_cents}
    rentCents={stripeIntent.rent_cents}
    payMethod={payMethod}
    busy={paymentProcessing}
    setBusy={setPaymentProcessing}
    onSuccess={onStripeSuccess}
    onError={(msg) => showToast(msg, "error")}
  />
  </Elements>
  </div>
  )}
  </div>
  )}

  {/* ---- AUTOPAY TAB ---- */}
  {activeTab === "autopay" && tenantData && (
  <div className="max-w-md mx-auto">
  <h3 className="font-manrope font-bold text-neutral-800 mb-4">Autopay</h3>
  <div className="bg-white rounded-3xl border border-brand-50 shadow-card p-6">
  {/* Three states:
        1. setupIntent != null → tenant is mid-setup, show card form
        2. stripeAutopay != null → saved card, show details + disable
        3. neither → show "Set up autopay" CTA */}
  {setupIntent ? (
    <div>
    <div className="mb-4">
    <h4 className="font-semibold text-neutral-700">Save card for autopay</h4>
    <p className="text-xs text-neutral-400">No charge today. We'll auto-charge your monthly rent on the 1st.</p>
    </div>
    <Elements stripe={stripePromise} options={{ clientSecret: setupIntent.client_secret, appearance: { theme: "stripe" } }}>
      <SetupCardForm
        clientSecret={setupIntent.client_secret}
        onSuccess={onSetupSuccess}
        onError={(msg) => showToast(msg, "error")}
        busy={setupBusy}
        setBusy={setSetupBusy}
      />
    </Elements>
    <button onClick={() => setSetupIntent(null)} className="text-xs text-neutral-400 hover:text-neutral-600 underline mt-3 mx-auto block">Cancel</button>
    </div>
  ) : stripeAutopay ? (
    <div>
    <div className="flex items-center justify-between mb-4">
    <div>
    <div className="text-sm font-semibold text-neutral-700">Autopay is on</div>
    <div className="text-xs text-neutral-400">Rent auto-charges to your saved card</div>
    </div>
    <span className="bg-positive-100 text-positive-700 text-xs font-bold rounded-full px-2 py-1">Active</span>
    </div>
    <div className="bg-brand-50/40 rounded-2xl p-4 space-y-2">
    <div className="flex justify-between text-sm"><span className="text-neutral-400">Card</span><span className="font-mono text-neutral-700 capitalize">{stripeAutopay.card_brand || "card"} •••• {stripeAutopay.card_last4 || "????"}</span></div>
    <div className="flex justify-between text-sm"><span className="text-neutral-400">Amount</span><span className="font-bold text-neutral-700">${safeNum(stripeAutopay.amount).toLocaleString()}/month</span></div>
    <div className="flex justify-between text-sm"><span className="text-neutral-400">Next Charge</span><span className="font-medium text-neutral-700">{stripeAutopay.next_charge_date || "—"}</span></div>
    </div>
    {stripeAutopay.last_error && (
      <div className="mt-3 bg-danger-50 border border-danger-100 rounded-2xl p-3">
        <div className="text-sm font-semibold text-danger-800">Last charge failed</div>
        <div className="text-xs text-danger-600 mt-1">{stripeAutopay.last_error}</div>
        <div className="text-xs text-danger-500 mt-2">Update your card to keep autopay running.</div>
      </div>
    )}
    <Btn variant="danger" size="sm" className="w-full mt-4" onClick={handleDisableStripeAutopay}>Disable autopay</Btn>
    <Btn variant="secondary" size="sm" className="w-full mt-2" onClick={handleSetupAutopay} disabled={setupBusy}>{setupBusy ? "Loading…" : "Replace card"}</Btn>
    </div>
  ) : (
    <div className="text-center">
    <span className="material-icons-outlined text-neutral-300 text-4xl mb-2 block">autorenew</span>
    <h4 className="font-semibold text-neutral-700">Set up autopay</h4>
    <p className="text-sm text-neutral-400 mt-1 mb-4">Save a card and we'll auto-charge ${safeNum(tenantData.rent).toLocaleString()} on the 1st of each month.</p>
    <Btn variant="primary" size="lg" className="w-full" onClick={handleSetupAutopay} disabled={setupBusy || !stripePromise}>
      {setupBusy ? "Loading…" : "Set up autopay"}
    </Btn>
    {!stripePromise && <p className="text-xs text-danger-500 mt-2">Stripe isn't configured for this site.</p>}
    </div>
  )}
  </div>
  </div>
  )}

  {/* ---- LEDGER TAB ---- */}
  {/* Reads from acct_journal_lines for the tenant's per-tenant AR
      sub-account. Each line is one side of a posted JE — debits
      increase what's owed (rent charges, late fees), credits decrease
      it (payments, credits applied). Running balance is computed
      forward from the oldest line, then displayed newest-first. */}
  {activeTab === "history" && (() => {
    // Compute running balance forward (oldest → newest) so we can
    // display each row's balance-after-this-entry. ledgerLines comes
    // pre-sorted newest-first; reverse to walk forward.
    const forward = [...ledgerLines].reverse();
    let bal = 0;
    const withBal = forward.map(l => {
      const d = safeNum(l.debit) || 0;
      const c = safeNum(l.credit) || 0;
      bal += d - c;
      return { ...l, _balance: bal };
    });
    const rows = withBal.reverse(); // back to newest-first for render
    return (
    <div>
    <div className="flex justify-between items-center mb-3">
    <div>
      <h3 className="font-semibold text-neutral-700">Account Ledger</h3>
      <p className="text-xs text-neutral-400">All charges and payments on your account.</p>
    </div>
    <Btn variant="secondary" size="xs" onClick={() => exportToCSV(rows.map(r => ({
      date: r.acct_journal_entries?.date || "",
      description: r.acct_journal_entries?.description || r.memo || "",
      charge: r.debit > 0 ? r.debit : "",
      payment: r.credit > 0 ? r.credit : "",
      balance: r._balance.toFixed(2),
    })), [
      { label: "Date", key: "date" }, { label: "Description", key: "description" },
      { label: "Charge", key: "charge" }, { label: "Payment", key: "payment" },
      { label: "Balance", key: "balance" },
    ], "my-ledger", showToast)}>
      <span className="material-icons-outlined text-xs align-middle mr-1">download</span>Export
    </Btn>
    </div>
    <div className="bg-white border border-brand-50 rounded-2xl overflow-hidden">
    <div className="hidden md:grid grid-cols-[1fr_2fr_auto_auto_auto] gap-4 px-4 py-2 text-xs font-semibold text-neutral-400 bg-neutral-50/50 border-b border-brand-50">
    <div>Date</div><div>Description</div>
    <div className="text-right">Charge</div>
    <div className="text-right">Payment</div>
    <div className="text-right">Balance</div>
    </div>
    {rows.map(l => {
      const je = l.acct_journal_entries || {};
      const isCharge = safeNum(l.debit) > 0;
      const isPayment = safeNum(l.credit) > 0;
      return (
      <div key={l.id} className="md:grid md:grid-cols-[1fr_2fr_auto_auto_auto] md:gap-4 flex flex-col px-4 py-3 border-b border-brand-50/50 last:border-0 text-sm">
      <div className="text-neutral-500 text-xs md:text-sm">{je.date || "—"}</div>
      <div className="text-neutral-800 font-medium">{je.description || l.memo || "—"}</div>
      <div className="md:text-right text-danger-600 font-semibold">{isCharge ? formatCurrency(safeNum(l.debit)) : <span className="text-neutral-200">—</span>}</div>
      <div className="md:text-right text-positive-600 font-semibold">{isPayment ? formatCurrency(safeNum(l.credit)) : <span className="text-neutral-200">—</span>}</div>
      <div className="md:text-right font-mono font-bold text-neutral-800">{formatCurrency(l._balance)}</div>
      </div>
      );
    })}
    {rows.length === 0 && <div className="text-center py-8 text-neutral-400">No ledger entries yet</div>}
    </div>
    {payments.filter(p => p.status === "paid").length > 0 && (
      <>
      <h3 className="font-semibold text-neutral-700 mt-6 mb-3">Receipts</h3>
      <div className="space-y-2">
      {payments.filter(p => p.status === "paid").map(p => (
        <div key={p.id} className="bg-white border border-brand-50 rounded-2xl px-4 py-3 flex justify-between items-center">
        <div>
          <div className="text-sm font-medium text-neutral-800">{p.type === "rent" ? "Rent Payment" : p.type}</div>
          <div className="text-xs text-neutral-400">{p.date} · {p.method}</div>
        </div>
        <div className="flex items-center gap-3">
          <Btn variant="secondary" size="xs" onClick={() => generatePaymentReceipt(p)}>Receipt</Btn>
          <div className="text-sm font-bold text-positive-600">${safeNum(p.amount).toLocaleString()}</div>
        </div>
        </div>
      ))}
      </div>
      </>
    )}
    </div>
    );
  })()}

  {/* ---- MAINTENANCE TAB ---- */}
  {activeTab === "maintenance" && (
  <div>
  <div className="flex justify-between items-center mb-4">
  <h3 className="font-semibold text-neutral-700">Maintenance Requests</h3>
  <Btn size="xs" onClick={() => setShowMaintForm(!showMaintForm)}>
  {showMaintForm ? "Cancel" : "+ New Request"}
  </Btn>
  </div>
  {showMaintForm && (
  <div className="bg-white rounded-xl border border-brand-100 shadow-sm p-4 mb-4">
  <h4 className="font-medium text-neutral-700 mb-3">Submit a Maintenance Request</h4>
  <label className="text-xs font-medium text-neutral-400 mb-1 block">What's the issue? *</label>
  <Input placeholder="e.g. Leaking faucet in kitchen" value={maintForm.issue} onChange={e => setMaintForm({...maintForm, issue: e.target.value})} className="mb-3" />
  <Select value={maintForm.priority} onChange={e => setMaintForm({...maintForm, priority: e.target.value})} className="mb-3">
  <option value="normal">Normal Priority</option>
  <option value="urgent">Urgent</option>
  <option value="emergency">Emergency</option>
  </Select>
  <Textarea placeholder="Additional details..." value={maintForm.notes} onChange={e => setMaintForm({...maintForm, notes: e.target.value})} className="mb-3" rows={3} />
  <div className="mb-3">
  <label className="text-xs text-neutral-400 mb-1 block">Attach Photo (optional)</label>
  <FileInput accept="image/*" onChange={e => { if (e.target.files[0]) setMaintPhotos(prev => [...prev, e.target.files[0]]); }} className="text-sm" />
  </div>
  <Btn onClick={submitMaintenanceRequest}>Submit Request</Btn>
  </div>
  )}
  <div className="space-y-2">
  {workOrders.map(w => (
  <div key={w.id} className="bg-white border border-brand-50 rounded-2xl px-4 py-3">
  <div className="flex justify-between items-start">
  <div>
  <div className="text-sm font-medium text-neutral-800">{w.issue}</div>
  <div className="text-xs text-neutral-400">{w.property} · {w.created || "—"}</div>
  {w.notes && <div className="text-xs text-neutral-400 mt-1">{w.notes}</div>}
  </div>
  <div className="text-right">
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (w.status === "completed" ? "bg-positive-100 text-positive-700" : w.status === "in_progress" ? "bg-info-100 text-info-700" : "bg-warn-100 text-warn-700")}>{w.status.replace("_", " ")}</span>
  <div className={"text-xs mt-1 " + (w.priority === "emergency" ? "text-danger-500 font-bold" : w.priority === "urgent" ? "text-notice-500" : "text-neutral-400")}>{w.priority}</div>
  </div>
  </div>
  </div>
  ))}
  {workOrders.length === 0 && <div className="text-center py-8 text-neutral-400">No maintenance requests</div>}
  </div>
  </div>
  )}

  {/* ---- DOCUMENTS TAB ---- */}
  {activeTab === "documents" && (
  <div>
  <div className="flex items-center justify-between mb-3">
  <h3 className="font-semibold text-neutral-700">My Documents</h3>
  <Btn size="xs" onClick={() => setShowTenantDocUpload(true)}>+ Upload</Btn>
  </div>
  <div className="space-y-2">
  {documents.map(d => (
  <div key={d.id} className="bg-white border border-brand-50 rounded-2xl px-4 py-3 flex justify-between items-center">
  <div className="flex items-center gap-3">
  <div className="w-10 h-10 bg-brand-50 rounded-lg flex items-center justify-center text-brand-600 text-lg">
  {d.type === "lease" ? "\ud83d\udcdc" : d.type === "notice" ? "\ud83d\udce8" : "📄"}
  </div>
  <div>
  <div className="text-sm font-medium text-neutral-800">{d.name || d.file_name}</div>
  <div className="text-xs text-neutral-400">{d.type || "Document"} · {new Date(d.uploaded_at).toLocaleDateString()}</div>
  </div>
  </div>
  <Btn variant="secondary" size="xs" onClick={async () => { const url = await getSignedUrl("documents", d.file_name || d.url); if (url) window.open(url, "_blank", "noopener,noreferrer"); }}>View</Btn>
  </div>
  ))}
  {documents.length === 0 && <div className="text-center py-8 text-neutral-400">No documents uploaded yet</div>}
  </div>
  {showTenantDocUpload && <DocUploadModal onClose={() => setShowTenantDocUpload(false)} companyId={companyId} property={tenantData?.property || ""} tenant={tenantData?.name || ""} showToast={showToast} isTenantUpload onUploaded={async () => { const { data } = await supabase.from("documents").select("*").eq("company_id", companyId).eq("tenant", tenantData.name).is("archived_at", null).order("uploaded_at", { ascending: false }); setDocuments(data || []); }} />}
  </div>
  )}

  {/* ---- MESSAGES TAB ---- */}
  {/* Mobile: flex-1 min-h-0 fills <main>'s available height through
      the flex chain set up above (App.js → TenantPortal wrapper →
      this div). No more viewport-unit math — the chain handles it.
      Desktop reverts to a fixed calc since the flex chain breaks
      desktop's normal page-flow scroll layout. */}
  {activeTab === "messages" && (
  <div className="bg-white md:rounded-3xl md:border md:border-brand-50 overflow-hidden flex flex-col flex-1 min-h-0 md:flex-none md:h-[calc(100dvh-320px)]" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
  <MessageThread
    messages={messages}
    viewerRole="tenant"
    viewerName={tenantData.name || "You"}
    tenantName={tenantData.name}
    companyName={companyName}
    onDelete={deleteOwnMessage}
    emptyLabel="No messages yet. Send a message to your property manager below."
  />
  <MessageComposer
    value={newMessage}
    onChange={setNewMessage}
    onSend={sendMessage}
    sending={sendingMsg}
    attachment={msgAttachment}
    onAttachmentChange={setMsgAttachment}
    showToast={showToast}
    placeholder="Message your property manager…"
  />
  </div>
  )}
  </div>
  );
}

export { TenantPortal };
