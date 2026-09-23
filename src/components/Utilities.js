import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Input, Textarea, Select, Btn, MultiSelect, PageHeader, TextLink, DataTable, EmptyState, usePersistedView} from "../ui";
import { safeNum, formatLocalDate, formatCurrency, exportToCSV, fmtDate, fmtDateTime, getSignedUrl, payablePortalFor} from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { encryptCredential, decryptCredential } from "../utils/encryption";
import { logAudit } from "../utils/audit";
import { autoPostJournalEntry, getPropertyClassId, getOrCreateTenantAR } from "../utils/accounting";
import { Spinner, Modal, PropertySelect } from "./shared";
import PayBillModal from "./PayBillModal";

// "Covered by condo fee" -- the cost is bundled into the monthly condo/HOA
// fee, so there is no separate bill to fetch, chase or pay. A third value of
// the existing responsibility field, beside owner and tenant.
const respLabel = (r) => r === "tenant" ? "Tenant" : r === "condo_fee" ? "Condo fee" : r === "shared" ? "Shared" : "Owner";

// A utility flipped owner->tenant keeps owing the owner one CLOSEOUT bill for
// usage up to the meter transfer. That is tracked as a SEPARATE owner-
// responsible utility line flagged is_final_bill (auto-created by the DB on the
// flip) -- a normal owner bill shown with a "Final bill" chip. Nothing special
// is needed here; owner lines are payable, tenant/condo are not.

// The lifecycle a bill actually has. "Paid or Ignore" was not a design
// choice -- it was everything one status column on an account could say.
const BILL_STATUS = {
  no_bill:        { label: "No bill yet", tone: "neutral" },
  no_balance:     { label: "No balance", tone: "neutral" },
  pending_review: { label: "To review",   tone: "warn" },
  authorized:     { label: "Approved",    tone: "info" },
  paid:           { label: "Paid",        tone: "good" },
  partial:        { label: "Part paid",   tone: "warn" },
  settled:        { label: "Recharged",   tone: "good" },
  error:          { label: "Read failed", tone: "bad" },
  excluded:       { label: "Ignored",     tone: "neutral" },
};
const STATUS_CLASS = {
  neutral: "bg-neutral-100 text-neutral-500",
  warn:    "bg-warn-100 text-warn-700",
  info:    "bg-info-100 text-info-700",
  good:    "bg-positive-100 text-positive-700",
  bad:     "bg-danger-100 text-danger-700",
};

// Overdue is a real question now that bills carry their own due date, and it
// is only askable of a bill that is still owed.
function billAge(row, today) {
  if (!row.due || row.status === "paid" || row.status === "settled" || row.status === "excluded") return null;
  const due = new Date(row.due + "T00:00:00");
  if (isNaN(due)) return null;
  const days = Math.round((due - today) / 86400000);
  return days;
}

function Utilities({ addNotification, userProfile, userRole, companyId, showToast, showConfirm }) {
  function exportUtilities() {
  exportToCSV(utilities, [
  { label: "Property", key: "property" },
  { label: "Provider", key: "provider" },
  { label: "Type", key: "type" },
  { label: "Amount", key: "amount" },
  { label: "Due Date", key: u => fmtDate(u.due) },
  { label: "Status", key: "status" },
  ], "utilities_" + fmtDate(new Date()), showToast);
  }
  const [utilities, setUtilities] = useState([]);
  const [allBills, setAllBills] = useState([]);
  // One "today" for the whole render: computing it per row means a render
  // that straddles midnight can call one bill late and the next one not.
  const todayRef = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
  // The bill being paid, and the form for it.
  const [payBill, setPayBill] = useState(null);
  const [payForm, setPayForm] = useState(null);
  const [bankAccounts, setBankAccounts] = useState([]);
  // utilAccounts is declared below, for the Accounts tab. fetchUtilities now
  // fills the same state from utility_accounts, so both tabs read one list.
  // Which account's bill history is open.
  const [historyFor_, setHistoryFor] = useState(null);
  const [docPicker, setDocPicker] = useState(null); // { kind: "statements"|"receipts", accountId }
  const [menuOpenId, setMenuOpenId] = useState(null); // account id whose ⋯ overflow menu is open (card view)
  const [tableMenu, setTableMenu] = useState(null); // { id, top, right } — table ⋯ menu, positioned fixed so the scroll container can't clip it
  const [showFilters, setShowFilters] = useState(false); // filter popover open
  const [paymentMethodModal, setPaymentMethodModal] = useState(null); // bill awaiting payment authorisation
  const [payingBill, setPayingBill] = useState(null); // bill being paid in the streamed secure browser
  const [auditLog, setAuditLog] = useState([]);
  const [showAudit, setShowAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending", website: "", username: "", password: "" });
  const [showCreds, setShowCreds] = useState(new Set());
  const [utilView, setUtilView] = usePersistedView("utilities", "card", ["card", "table"]);
  const [utilSearch, setUtilSearch] = useState("");
  const [utilFilterStatus, setUtilFilterStatus] = useState("all");
  const [utilFilterResp, setUtilFilterResp] = useState("all");   // all / owner / tenant / condo_fee
  const [utilHideZero, setUtilHideZero] = useState(false);       // hide rows with no positive balance
  const [utilFilterProps, setUtilFilterProps] = useState([]);   // [] = all
  // Biller filter. 79 bills across a dozen providers, and the only way to
  // see just BGE's was to type it into the free-text search -- which also
  // matches property names, so it was a filter by accident rather than by
  // design.
  const [utilFilterProviders, setUtilFilterProviders] = useState([]);  // [] = all
  // Due date ascending: the next thing to pay is the reason to open this page.
  const [utilSort, setUtilSort] = useState({ key: "due", dir: "asc" });
  
  // === Utility Automation ===
  const [utilTab, setUtilTab] = useState("bills"); // bills / automation / jobs
  const [utilAccounts, setUtilAccounts] = useState([]);
  const [autoBills, setAutoBills] = useState([]);
  const [autoJobs, setAutoJobs] = useState([]);
  const [providers, setProviders] = useState([]);
  const [showPendingProviders, setShowPendingProviders] = useState(false);
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [accountForm, setAccountForm] = useState({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" });

  useEffect(() => { fetchUtilities(); fetchAutomationData(); }, [companyId]);

  async function fetchAutomationData() {
  const [accts, bills, jobs, provs, receipts] = await Promise.all([
  supabase.from("utility_accounts").select("*").eq("company_id", companyId).is("archived_at", null).order("property"),
  supabase.from("utility_bills").select("*").eq("company_id", companyId).is("archived_at", null).order("created_at", { ascending: false }).limit(100),
  supabase.from("automation_jobs").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(50),
  supabase.from("utility_providers").select("*").eq("is_active", true).order("display_name"), // Intentionally unscoped — shared reference table of utility companies
  // Receipts, so a paid bill can open its receipt PDF straight from the
  // Utilities page (it was only reachable under Documents before).
  supabase.from("utility_payments").select("bill_id, receipt_storage_path, created_at").eq("company_id", companyId).not("receipt_storage_path", "is", null).order("created_at", { ascending: false }),
  ]);
  setUtilAccounts(accts.data || []);
  const receiptByBill = new Map();
  for (const r of (receipts.data || [])) { if (r.bill_id != null && !receiptByBill.has(r.bill_id)) receiptByBill.set(r.bill_id, r.receipt_storage_path); }
  setAutoBills((bills.data || []).map(b => ({ ...b, receipt_path: receiptByBill.get(b.id) || null })));
  setAutoJobs(jobs.data || []);
  // Approved providers, plus any this company proposed and an admin has not
  // approved yet (usable immediately). A legacy row with no approval_status
  // reads as approved.
  setProviders((provs.data || []).filter(p => p.approval_status !== "pending" || p.requested_company_id === companyId));
  }

  async function saveAccount() {
  if (!accountForm.property || !accountForm.provider || !accountForm.username || !accountForm.password) {
  showToast("Property, provider, username, and password are required.", "error"); return;
  }
  // Encrypt credentials client-side before sending
  // In production, this should be done server-side via Edge Function
  // For now, we use a simple encoding (NOT production-grade encryption)
  const providerInfo = providers.find(p => p.id === accountForm.provider);
  // AES-256-GCM encryption for credentials using Web Crypto API
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  // Derive a key from companyId (deterministic per company — not perfect but far better than Base64)
  // For production, move encryption to a Supabase Edge Function with a server-managed key
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode((companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0")), { name: "AES-GCM" }, false, ["encrypt"]);
  async function encryptField(plaintext) {
  if (!plaintext) return "";
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, keyMaterial, encoded);
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
  }
  const payload = {
  company_id: companyId,
  property: accountForm.property,
  provider: accountForm.provider,
  provider_display: providerInfo?.display_name || accountForm.provider,
  account_number: accountForm.account_number,
  username_encrypted: await encryptField(accountForm.username),
  password_encrypted: await encryptField(accountForm.password),
  encryption_iv: ivHex,
  login_url: providerInfo?.login_url || "",
  account_type: accountForm.account_type,
  check_frequency: accountForm.check_frequency,
  two_factor_method: accountForm.two_factor_method,
  notes: accountForm.notes,
  };
  let error;
  if (editingAccount) {
  ({ error } = await supabase.from("utility_accounts").update(payload).eq("id", editingAccount.id).eq("company_id", companyId));
  } else {
  ({ error } = await supabase.from("utility_accounts").insert([payload]));
  }
  if (error) { pmError("PM-4002", { raw: error, context: "saving utility account" }); return; }
  addNotification("⚡", (editingAccount ? "Updated" : "Added") + " utility account: " + (providerInfo?.display_name || accountForm.provider));
  setShowAccountForm(false);
  setEditingAccount(null);
  setAccountForm({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" });
  fetchAutomationData();
  }

  async function deleteAccount(acct) {
  if (!await showConfirm({ message: "Delete this utility account? Automation will stop for this account.", variant: "danger", confirmText: "Delete" })) return;
  await supabase.from("utility_accounts").update({ archived_at: new Date().toISOString() }).eq("id", acct.id).eq("company_id", companyId);
  addNotification("📦", "Utility account archived: " + acct.provider_display);
  fetchAutomationData();
  }

  async function triggerManualCheck(acct) {
  // Queue a manual bill check job
  const { error } = await supabase.from("automation_jobs").insert([{
  company_id: companyId,
  utility_account_id: acct.id,
  job_type: "fetch_bill",
  status: "queued",
  triggered_by: userProfile?.email || "manual",
  }]);
  if (error) { pmError("PM-4003", { raw: error, context: "queuing automation job" }); return; }
  addNotification("🔄", "Bill check queued for " + acct.provider_display + " at " + acct.property);
  fetchAutomationData();
  }


  // A person pressing Pay is the whole authorisation. It writes an APPROVED
  // payment; the worker on the box picks it up, pays the portal, captures the
  // receipt and marks the bill paid.
  //
  // What it does NOT do is post a journal entry. The old version did -- DR
  // 5400, CR 1000 Checking, dated today, for the full billed amount -- while
  // queueing a job into automation_jobs that nothing has ever read. So the
  // books recorded a payment out of an account nobody chose, for money that
  // never moved. The money leaving the bank arrives through the bank feed,
  // which is the one record that cannot claim a payment that did not happen.
  // `requested` is what a person chose to pay, which may be LESS than the
  // bill. Omitted means the whole bill.
  async function payBillViaPortal(bill, requested) {
  if (!guardSubmit("payViaPortal", bill?.id)) return;
  try {
  // The tenant's bill is not ours to pay. claim_utility_payment refuses it
  // too -- that is the layer that actually holds -- but refusing here means
  // no cancelled payment row is created for something that was never
  // legitimate to ask for.
  if (bill.responsibility === "condo_fee") {
    showToast("This utility is covered by the condo fee — there's no separate bill to pay.", "error");
    return;
  }
  if (bill.responsibility === "tenant") {
    showToast("The tenant is responsible for this utility — it is not ours to pay. Recharge it from their ledger if you have already covered it.", "error");
    return;
  }
  const portal = payablePortalFor(bill.provider_display || bill.provider);
  if (!portal) {
    showToast(`There is no payment recipe for ${bill.provider_display || bill.provider} yet — record the payment manually instead.`, "error");
    return;
  }
  const due = safeNum(bill.amount);
  if (!(due > 0)) { showToast("This bill has no amount to pay.", "error"); return; }

  const amount = requested == null ? due : safeNum(requested);
  if (!(amount > 0)) { showToast("Enter an amount to pay.", "error"); return; }

  // Never more than the bill. Overpaying is a different mistake from
  // underpaying and nothing downstream is designed to absorb it; the RPC
  // refuses it too, on the sum of everything already paid against this bill.
  if (amount > due + 0.005) {
    showToast(`That is more than the ${formatCurrency(due)} owed on this bill.`, "error");
    return;
  }
  const isPartial = amount < due - 0.005;

  // What is already committed against this bill, so the confirmation can say
  // what the remainder will be rather than leaving it to be worked out.
  const { data: priorRows } = await supabase.from("utility_payments")
    .select("approved_amount, status")
    .eq("company_id", companyId).eq("bill_id", bill.bill_id || bill.id)
    .in("status", ["submitting", "paid", "unknown", "partial"]);
  const prior = (priorRows || []).reduce((t, r) => t + safeNum(r.approved_amount), 0);
  if (prior + amount > due + 0.005) {
    showToast(`${formatCurrency(prior)} is already committed against this ${formatCurrency(due)} bill, so ${formatCurrency(amount)} would overpay it.`, "error");
    return;
  }

  if (!await showConfirm({
    message: `Pay ${bill.provider_display || bill.provider} ${formatCurrency(amount)} for ${bill.property}?\n\n`
      + (isPartial
          ? `This is a PART payment of the ${formatCurrency(due)} owed. ${formatCurrency(due - prior - amount)} will still be outstanding afterwards, and the bill stays open.\n\n`
          : `This pays the bill in full.\n\n`)
      + `It releases a real payment on the provider's site and cannot be undone from here.\n\n`
      + (isPartial
          ? `The amount is typed into the provider's form and read back before anything is submitted. If the form cannot be set to this figure, the payment is refused rather than sent at the full amount.`
          : `The amount on the page is checked against this figure first, and the payment is refused if they differ.`),
    variant: "danger", confirmText: `Pay ${formatCurrency(amount)}`,
  })) return;

  // The statement, so next month's identical amount is a DIFFERENT payment
  // while a retry of this one is the same payment and gets refused.
  const statement = (bill.statement_period || formatLocalDate(new Date()).slice(0, 7));
  // The key includes what was ALREADY committed against this bill, not just
  // the amount. That distinguishes a legitimate second $10 on a $27.66 bill
  // (prior 0, then prior 10) from a double-click submitting the same intent
  // twice (prior identical, so the same key, so refused by the unique index).
  // Keying on the amount alone made the first case impossible and the second
  // one indistinguishable from it.
  const idemKey = `${portal}:${bill.account_number || bill.utility_account_id}:${statement}`
    + `:${amount.toFixed(2)}:after${prior.toFixed(2)}`;

  const { error } = await supabase.from("utility_payments").insert([{
    company_id: companyId,
    provider: portal,
    bill_id: bill.bill_id || bill.id,
    property: bill.property,
    statement_ref: statement,
    idem_key: idemKey,
    approved_amount: amount,
    observed_amount: amount,
    due_date: bill.due || null,
    // Approved on the spot: the button IS the approval, and the person who
    // pressed it is named here because claim_utility_payment refuses a
    // payment with nobody against it.
    status: "approved",
    approved_at: new Date().toISOString(),
    approved_by: userProfile?.email || null,
    requested_by: userProfile?.email || null,
  }]);
  if (error) {
    // The unique indexes are the double-payment guard, so this is a normal
    // answer rather than a fault: it means this bill or this statement
    // already has a payment against it.
    const dup = /duplicate key|unique/i.test(error.message || "");
    if (dup) showToast("This bill already has a payment against it. Check the Payments column before trying again.", "error");
    else pmError("PM-6001", { raw: error, context: "queueing portal payment" });
    return;
  }

  await supabase.from("utility_bills").update({
    status: "authorized",
    authorized_by: userProfile?.email || null,
    authorized_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", bill.bill_id || bill.id).eq("company_id", companyId);

  logAudit("update", "utilities", `Released portal payment: ${bill.provider_display || bill.provider} ${formatCurrency(amount)} — ${bill.property}`,
    String(bill.bill_id || bill.id), userProfile?.email, userRole, companyId);
  addNotification("💸", `Payment released: ${bill.provider_display || bill.provider} ${formatCurrency(amount)}`);
  showToast("Payment released. The receipt will be filed against the property once the provider confirms it.", "success");
  setPaymentMethodModal(null);
  fetchAutomationData();
  } finally { guardRelease("payViaPortal", bill?.id); }
  }

  async function fetchUtilities() {
  // PHASE 2: the page reads BILLS now, not accounts.
  //
  // `utilities` held one amount per account and the reader overwrote it every
  // sweep, so this page could only ever show "the current balance" and the
  // word "Paid" meant a flag on the account that next month's read reset.
  // utility_bills holds one row per statement, which is what makes a history,
  // a real paid record and an overdue figure possible at all.
  //
  // The accounts are still read, because a bill needs its account's login and
  // because an account with no bill yet should still be visible -- otherwise
  // a newly added account vanishes until the first successful sweep.
  const [billsRes, acctRes, receiptsRes] = await Promise.all([
    supabase.from("utility_bills")
      .select("*").eq("company_id", companyId).is("archived_at", null)
      .order("due_date", { ascending: true, nullsFirst: false }).limit(1000),
    supabase.from("utility_accounts")
      .select("*").eq("company_id", companyId).is("archived_at", null)
      .order("provider").limit(1000),
    // Receipts live in utility_payments (one per confirmed payment, keyed by
    // bill), not on the bill row. Loaded here so a bill's history carries its
    // receipt PDF and the Receipts picker can list every one -- the same
    // documents already filed under the property, surfaced where the bill lives.
    supabase.from("utility_payments")
      .select("bill_id, receipt_storage_path, created_at")
      .eq("company_id", companyId).not("receipt_storage_path", "is", null)
      .order("created_at", { ascending: false }),
  ]);
  if (billsRes.error) pmError("PM-4003", { raw: billsRes.error, context: "loading utility bills", phase: "read" });
  if (acctRes.error) pmError("PM-4003", { raw: acctRes.error, context: "loading utility accounts", phase: "read" });

  const accounts = acctRes.data || [];
  setUtilAccounts(accounts);

  // Attach each bill's receipt path (newest receipt per bill) so the card, the
  // bill history and the Statements/Receipts pickers can all open it.
  const receiptByBill = new Map();
  for (const r of (receiptsRes.data || [])) {
    if (r.bill_id != null && !receiptByBill.has(r.bill_id)) receiptByBill.set(r.bill_id, r.receipt_storage_path);
  }
  const billsAll = (billsRes.data || []).map(b => ({ ...b, receipt_path: receiptByBill.get(b.id) || null }));

  // Which accounts have at least one statement / at least one receipt on file,
  // so a row only offers a picker that would have something in it.
  const stmtAccts = new Set(billsAll.filter(b => b.pdf_storage_path).map(b => b.utility_account_id));
  const rcptAccts = new Set(billsAll.filter(b => b.receipt_path).map(b => b.utility_account_id));

  // The newest bill per account is what the list shows; the rest are its
  // history. Sorted by statement period rather than by read time, because a
  // late re-read of an old statement must not make it look like this month's.
  const latest = new Map();
  for (const b of billsAll) {
    const k = b.utility_account_id;
    if (k == null) continue;
    const cur = latest.get(k);
    if (!cur || String(b.statement_period || "") > String(cur.statement_period || "")) latest.set(k, b);
  }

  const rows = accounts.map(a => {
    const b = latest.get(a.id) || null;
    return {
      // Keyed by ACCOUNT so a row is stable while its bill changes month to
      // month. The bill id travels alongside for anything that acts on it.
      id: a.id,
      bill_id: b?.id || null,
      account: a,
      provider: a.provider,
      property: a.property,
      account_number: a.account_number,
      website: a.website || a.login_url || "",
      // The ACCOUNT's responsibility is what the user manages and is the current
      // truth; the bill only carries a snapshot taken when the sweep fetched it,
      // which goes stale the moment the account's responsibility is changed (e.g.
      // 11455 set to Owner but old bills still read Tenant). Account wins; the
      // bill's value is a fallback only when the account has none.
      responsibility: a.responsibility || b?.responsibility || "owner",
      // The separate owner closeout line auto-created on an owner->tenant flip.
      is_final_bill: a.is_final_bill || false,
      amount: b ? b.amount : null,
      due: b?.due_date || null,
      statement_period: b?.statement_period || null,
      // A reading of exactly $0 is nothing owed -- a terminal "No balance", not
      // a bill "to review". Derived from the amount, so existing $0 bills read
      // as No balance immediately (no data backfill) and never inflate the
      // dashboard's To-pay / Overdue counts. Already-terminal states win.
      status: (b && b.amount != null && safeNum(b.amount) === 0
               && !["paid", "settled", "excluded"].includes(b.status))
        ? "no_balance"
        : (b?.status || "no_bill"),
      paid_at: b?.paid_at || null,
      payment_confirmation: b?.payment_confirmation || "",
      pdf_storage_path: b?.pdf_storage_path || null,
      receipt_path: b?.receipt_path || null,
      // Whether the Statements / Receipts pickers would have anything to show
      // for this account (across its whole bill history, not just the latest).
      has_statements: stmtAccts.has(a.id),
      has_receipts: rcptAccts.has(a.id),
      last_check_status: a.last_check_status,
      last_check_error: a.last_check_error,
      last_checked_at: a.last_checked_at,
      username_encrypted: a.username_encrypted,
      password_encrypted: a.password_encrypted,
      encryption_iv: a.encryption_iv,
      encryption_iv_username: a.encryption_iv_username,
      encryption_salt: a.encryption_salt,
    };
  });

  setAllBills(billsAll);
  setUtilities(rows);
  setLoading(false);
  }

  // Every bill ever recorded for one account, newest statement first.
  function historyFor(accountId) {
    return (allBills || [])
      .filter(b => b.utility_account_id === accountId)
      .sort((a, b) => String(b.statement_period || "").localeCompare(String(a.statement_period || "")));
  }

  // Record a payment against ONE BILL.
  //
  // What this replaces set utilities.status = 'paid' on the ACCOUNT, wrote a
  // utility_audit row, and posted a journal entry referenced UTIL-<account
  // id>. Since there is a unique index on (company_id, reference), the second
  // payment on any account was rejected -- production holds zero journal
  // entries beginning UTIL-, against an account marked paid. The accounting
  // leg has never once worked.
  //
  // The reference is per BILL now, so next month's payment is a different
  // entry. The bank account is chosen rather than assumed to be Checking. And
  // a tenant-responsible bill becomes that tenant's debt instead of the
  // owner's expense, which is what `responsibility` was always for.
  async function recordBillPayment() {
    if (!payBill || !payForm) return;
    if (!guardSubmit("recordBillPayment", payBill.bill_id)) return;
    try {
      const amt = safeNum(payForm.amount);
      if (!(amt > 0)) { showToast("Enter the amount that was actually paid.", "error"); return; }
      if (!payForm.paid_on) { showToast("When was it paid?", "error"); return; }
      if (!payForm.bank_account_id) { showToast("Which account did it come out of?", "error"); return; }

      const bill = payBill;
      // A pending final bill is the OWNER's closeout expense, never recharged to
      // the tenant -- so it's excluded from the recharge path here.
      const recharge = payForm.recharge && bill.responsibility === "tenant";

      // The tenant to charge it on to, scoped to this property. Refuses to
      // guess: two tenants at one address and the wrong one gets the debt.
      let tenant = null;
      if (recharge) {
        const { data: ts } = await supabase.from("tenants")
          .select("id, name").eq("company_id", companyId).eq("property", bill.property)
          .is("archived_at", null).in("lease_status", ["active", "current"]).limit(3);
        if (!ts || ts.length === 0) {
          showToast(`No active tenant at ${bill.property} to recharge this to.`, "error"); return;
        }
        if (ts.length > 1) {
          showToast(`${ts.length} active tenants at ${bill.property} — recharge it from the tenant's ledger instead so the right one is charged.`, "error"); return;
        }
        tenant = ts[0];
      }

      const classId = await getPropertyClassId(bill.property, companyId);
      const bankName = (bankAccounts.find(a => a.id === payForm.bank_account_id) || {}).name || "Bank";

      // Owner's bill: an expense. Tenant's bill we are recharging: a
      // receivable from them, not our cost.
      let debitLine;
      if (recharge) {
        const arId = await getOrCreateTenantAR(companyId, tenant.name, tenant.id);
        if (!arId) { showToast("Could not open a receivable for " + tenant.name + ".", "error"); return; }
        debitLine = { account_id: arId, account_name: "AR - " + tenant.name, debit: amt, credit: 0,
                      class_id: classId, memo: bill.provider + " recharged to " + tenant.name };
      } else {
        debitLine = { account_id: "5400", account_name: "Utilities", debit: amt, credit: 0,
                      class_id: classId, memo: bill.provider + " — " + bill.property };
      }

      const jeId = await autoPostJournalEntry({
        companyId,
        date: payForm.paid_on,
        description: `Utility: ${bill.provider} — ${bill.property}${bill.statement_period ? " — " + bill.statement_period : ""}`,
        // PER BILL. This is the fix for the reference collision.
        reference: `UTIL-${bill.bill_id}`,
        property: bill.property,
        lines: [
          debitLine,
          { account_id: payForm.bank_account_id, account_name: bankName, debit: 0, credit: amt,
            class_id: classId, memo: "Paid " + bill.provider },
        ],
      });
      if (!jeId) { pmError("PM-4006", { raw: new Error("JE post failed"), context: "utility bill payment" });
        showToast("The payment was not recorded — the journal entry could not post.", "error"); return; }

      const { error } = await supabase.from("utility_bills").update({
        status: recharge ? "settled" : "paid",
        amount_paid: amt,
        paid_at: new Date(payForm.paid_on + "T12:00:00").toISOString(),
        payment_confirmation: (payForm.confirmation || "").trim() || null,
        payment_method_selected: payForm.method || null,
        authorized_by: userProfile?.email || null,
        authorized_at: new Date().toISOString(),
        je_id: String(jeId),
        settled_tenant_id: recharge ? tenant.id : null,
        settled_at: recharge ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      }).eq("id", bill.bill_id).eq("company_id", companyId);
      if (error) {
        // The money and the journal entry are real; only the bill's own row
        // failed. Say so rather than letting it look unpaid.
        pmError("PM-6002", { raw: error, context: "marking utility bill paid" });
        showToast("The journal entry posted but the bill could not be marked paid — check the Utilities list.", "error");
        return;
      }

      await supabase.from("utility_audit").insert([{
        company_id: companyId, utility_id: bill.account?.legacy_utility_id || null,
        property: bill.property, provider: bill.provider, amount: amt,
        action: recharge ? "Paid & recharged to tenant" : "Paid", paid_at: new Date().toISOString(),
      }]);

      logAudit("update", "utilities",
        `Utility paid: ${bill.provider} ${formatCurrency(amt)} for ${bill.property}` +
        (recharge ? ` — recharged to ${tenant.name}` : ""),
        bill.bill_id, userProfile?.email, userRole, companyId);
      addNotification("✅", `${bill.provider} ${formatCurrency(amt)} recorded${recharge ? " and recharged to " + tenant.name : ""}`);

      showToast("Payment recorded.", "success");
      setPayBill(null); setPayForm(null);
      fetchUtilities();
    } finally { guardRelease("recordBillPayment", payBill?.bill_id); }
  }

  // The accounts money can come out of. Chosen, never assumed: the old code
  // hardcoded 1000 Checking for every payment regardless of which card or
  // account actually paid it.
  async function loadBankAccounts() {
    const { data } = await supabase.from("acct_accounts")
      .select("id, code, name, subtype, type").eq("company_id", companyId)
      .eq("is_active", true).in("type", ["Asset", "Liability"]).order("code").limit(200);
    setBankAccounts((data || []).filter(a =>
      String(a.subtype || "") === "Bank" || String(a.subtype || "") === "Credit Card" ||
      /^1\d{3}$/.test(String(a.code || "")) || /^2\d{3}$/.test(String(a.code || ""))));
  }

  // Add a provider from a form. Employees pick from the list; only admins/owners
  // add an APPROVED one. Anyone else's addition saves 'pending' for an admin to
  // approve -- usable immediately so nobody is blocked. Returns the name, or null.
  async function addUtilityProvider(rawName) {
    const name = String(rawName || "").trim();
    if (!name) return null;
    const existing = providers.find(p => p.display_name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.display_name;
    const isAdmin = userRole === "admin" || userRole === "owner";
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) + "_" + Math.random().toString(36).slice(2, 8);
    const { error } = await supabase.from("utility_providers").insert([{
      id, display_name: name, login_url: "", region: "", account_type: "electric",
      is_active: true, approval_status: isAdmin ? "approved" : "pending",
      requested_by: userProfile?.email || null, requested_company_id: companyId,
    }]);
    if (error) { showToast("Could not add provider: " + error.message, "error"); return null; }
    await fetchAutomationData();
    showToast(isAdmin ? `Added "${name}" to the provider list.` : `"${name}" sent to an admin for approval — you can use it now.`, "success");
    return name;
  }
  // Admin approve / reject of a proposed provider.
  async function reviewProvider(id, approve) {
    const patch = approve ? { approval_status: "approved" } : { is_active: false };
    const { error } = await supabase.from("utility_providers").update(patch).eq("id", id);
    if (error) { showToast("Could not update provider: " + error.message, "error"); return; }
    await fetchAutomationData();
    showToast(approve ? "Provider approved." : "Provider rejected.", "success");
  }

  async function addUtility() {
  if (!guardSubmit("addUtility")) return;
  try {
  if (!form.property.trim()) { showToast("Property is required.", "error"); return; }
  if (!form.provider.trim()) { showToast("Provider name is required.", "error"); return; }
  if (!form.amount || isNaN(Number(form.amount)) || Number(form.amount) <= 0) { showToast("Please enter a valid amount.", "error"); return; }
  if (!form.due) { showToast("Due date is required.", "error"); return; }
  const row = { ...form, amount: Number(form.amount), company_id: companyId };
  delete row.username; delete row.password; // don't store plaintext
  row.website = form.website || "";
  if (form.username || form.password) {
    try {
      const resU = await encryptCredential(form.username || "", companyId);
      const resP = await encryptCredential(form.password || "", companyId, resU.salt);
      row.username_encrypted = resU.encrypted;
      row.password_encrypted = resP.encrypted;
      row.encryption_iv_username = resU.iv || null;
      row.encryption_iv = resP.iv || resU.iv;
      row.encryption_salt = resU.salt || resP.salt;
    } catch (e) { showToast("Could not encrypt credentials — please try again: " + (e.message || e), "error"); return; }
  }
  const { error } = await supabase.from("utilities").insert([row]);
  if (error) { pmError("PM-4005", { raw: error, context: "adding utility bill" }); return; }
  addNotification("⚡", `Utility bill added: ${form.provider} at ${form.property}`);
  logAudit("create", "utilities", `Utility added: ${form.provider} ${formatCurrency(form.amount)} at ${form.property}`, "", userProfile?.email, userRole, companyId);
  setShowForm(false);
  setForm({ property: "", provider: "", amount: "", due: "", responsibility: "owner", status: "pending", website: "", username: "", password: "" });
  fetchUtilities();
  } finally { guardRelease("addUtility"); }
  }

  // approvePay is gone. It marked the ACCOUNT paid, which next month's read
  // reset, and posted a journal entry referenced UTIL-<account id> against a
  // unique index on (company_id, reference) -- so the second payment on any
  // account was silently rejected and production holds zero UTIL- entries.
  // recordBillPayment above replaces it: per bill, per statement, with the
  // paying account chosen and a tenant's bill charged to the tenant.


  async function openAuditLog(u) {
  const { data } = await supabase.from("utility_audit").select("*").eq("utility_id", u.id).eq("company_id", companyId).order("paid_at", { ascending: false });
  setAuditLog(data || []);
  setShowAudit(u);
  }

  if (loading) return <Spinner />;

  return (
  <div>
  {showAudit && (
  <Modal title={`Audit Log — ${showAudit.provider}`} onClose={() => setShowAudit(null)}>
  {auditLog.length === 0 ? (
  <EmptyState size="inline" title={"No audit entries yet"} />
  ) : (
  <div className="space-y-3">
  {auditLog.map((a, i) => (
  <div key={i} className="bg-brand-50/30 rounded-lg px-4 py-3">
  <div className="flex justify-between">
  <span className="text-sm font-semibold text-positive-600">{a.action}</span>
  <span className="text-xs text-neutral-400">{fmtDateTime(a.paid_at)}</span>
  </div>
  <div className="text-sm text-neutral-500 mt-1">${a.amount} — {a.property}</div>
  </div>
  ))}
  </div>
  )}
  </Modal>
  )}

  {/* Tab Navigation */}
  <div className="flex flex-col md:flex-row md:items-center gap-2 mb-5 border-b border-brand-50 pb-3">
  <PageHeader title="Utilities" />
  <Btn variant="secondary" onClick={exportUtilities}><span className="material-icons-outlined text-sm align-middle mr-1">download</span>Export</Btn>
  <div className="flex gap-1 overflow-x-auto pb-1">
  {/* "Manual Bills" and "Automation" were two implementations of one module
      pointed at two different schemas, and the split on screen was the
      visible symptom. One list of bills; the accounts behind them are a
      separate, quieter thing. */}
  {[["bills", "Bills"], ["automation", "Accounts"], ["jobs", "Job History"]].map(([id, label]) => (
  <button key={id} onClick={() => setUtilTab(id)} className={"px-3 py-1.5 text-xs font-medium rounded-lg " + (utilTab === id ? "bg-brand-600 text-white" : "bg-subtle-100 text-subtle-600 hover:bg-subtle-200")}>{label}</button>
  ))}
  </div>
  </div>

  {/* Admin: providers an employee proposed, awaiting approval. */}
  {(userRole === "admin" || userRole === "owner") && providers.filter(p => p.approval_status === "pending").length > 0 && (
  <div className="mb-4">
  <button onClick={() => setShowPendingProviders(v => !v)} className="text-xs font-medium text-warn-700 bg-warn-50 border border-warn-200 rounded-lg px-3 py-1.5">
  {providers.filter(p => p.approval_status === "pending").length} provider{providers.filter(p => p.approval_status === "pending").length !== 1 ? "s" : ""} pending approval {showPendingProviders ? "▲" : "▼"}
  </button>
  {showPendingProviders && (
  <div className="mt-2 bg-white border border-neutral-200 rounded-xl p-3 space-y-2 max-w-lg">
  {providers.filter(p => p.approval_status === "pending").map(p => (
  <div key={p.id} className="flex items-center justify-between gap-3 text-sm">
  <span><span className="font-medium">{p.display_name}</span> <span className="text-neutral-400 text-xs">requested by {p.requested_by || "—"}</span></span>
  <span className="flex gap-3">
  <TextLink tone="positive" size="xs" onClick={() => reviewProvider(p.id, true)}>Approve</TextLink>
  <TextLink tone="neutral" size="xs" onClick={() => reviewProvider(p.id, false)}>Reject</TextLink>
  </span>
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* ===== AUTOMATION TAB ===== */}
  {utilTab === "automation" && (
  <div>
  <div className="flex items-center justify-between mb-4">
  <div>
  <h3 className="font-semibold text-subtle-700">Connected Utility Accounts</h3>
  <p className="text-xs text-subtle-400 mt-0.5">{utilAccounts.length} account{utilAccounts.length !== 1 ? "s" : ""} connected</p>
  </div>
  <Btn onClick={() => { setEditingAccount(null); setAccountForm({ property: "", provider: "", account_number: "", username: "", password: "", account_type: "electric", check_frequency: "weekly", two_factor_method: "none", notes: "" }); setShowAccountForm(true); }}>+ Add Account</Btn>
  </div>

  {showAccountForm && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-4">
  <h3 className="font-semibold text-subtle-700 mb-3">{editingAccount ? "Edit Account" : "Connect Utility Account"}</h3>
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Property *</label><PropertySelect value={accountForm.property} onChange={v => setAccountForm({...accountForm, property: v})} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Provider *</label><Select value={accountForm.provider} onChange={e => { const p = providers.find(x => x.id === e.target.value); setAccountForm({...accountForm, provider: e.target.value, account_type: p?.account_type || "electric"}); }}><option value="">Select provider...</option>{providers.map(p => <option key={p.id} value={p.id}>{p.display_name} ({p.region})</option>)}</Select></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Account Number</label><Input placeholder="e.g. 1234567890" value={accountForm.account_number} onChange={e => setAccountForm({...accountForm, account_number: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Account Type</label><Select value={accountForm.account_type} onChange={e => setAccountForm({...accountForm, account_type: e.target.value})}><option value="electric">Electric</option><option value="gas">Gas</option><option value="water_sewer">Water/Sewer</option><option value="electric_gas">Electric + Gas</option><option value="trash">Trash</option></Select></div>
  <div className="col-span-1 sm:col-span-2 bg-warn-50 rounded-lg px-3 py-2"><div className="text-xs font-semibold text-warn-700">🔐 Login Credentials (encrypted before storage)</div></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Username / Email *</label><Input placeholder="your-login@email.com" value={accountForm.username} onChange={e => setAccountForm({...accountForm, username: e.target.value})} autoComplete="off" /></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Password *</label><Input type="password" placeholder="••••••••" value={accountForm.password} onChange={e => setAccountForm({...accountForm, password: e.target.value})} autoComplete="new-password" /></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">Check Frequency</label><Select value={accountForm.check_frequency} onChange={e => setAccountForm({...accountForm, check_frequency: e.target.value})}><option value="weekly">Weekly</option><option value="biweekly">Every 2 Weeks</option><option value="monthly">Monthly</option></Select></div>
  <div><label className="text-xs font-medium text-subtle-500 mb-1 block">2FA Method</label><Select value={accountForm.two_factor_method} onChange={e => setAccountForm({...accountForm, two_factor_method: e.target.value})}><option value="none">None</option><option value="sms">SMS</option><option value="email">Email</option></Select></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={saveAccount}>Save Account</Btn>
  <Btn variant="slate" onClick={() => { setShowAccountForm(false); setEditingAccount(null); }}>Cancel</Btn>
  </div>
  </div>
  )}

  {utilAccounts.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-neutral-200">
  <div className="text-4xl mb-3">⚡</div>
  <div className="text-subtle-500 font-medium">No utility accounts connected</div>
  <div className="text-xs text-subtle-400 mt-1">Add your first account to start automated bill fetching</div>
  </div>
  ) : (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
  {utilAccounts.map(acct => (
  <div key={acct.id} className="bg-white rounded-xl border border-neutral-200 shadow-card p-4">
  <div className="flex items-start justify-between mb-2">
  <div><div className="font-semibold text-subtle-800 text-sm">{acct.provider_display}</div><div className="text-xs text-subtle-400">{acct.property}</div></div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (acct.last_check_status === "success" ? "bg-positive-100 text-positive-700" : acct.last_check_status === "failed" ? "bg-danger-100 text-danger-700" : "bg-subtle-100 text-subtle-500")}>{acct.last_check_status || "never"}</span>
  </div>
  <div className="grid grid-cols-2 gap-2 text-xs mt-2">
  <div><span className="text-subtle-400">Account #</span><div className="font-semibold text-subtle-700">{acct.account_number || "—"}</div></div>
  <div><span className="text-subtle-400">Type</span><div className="font-semibold text-subtle-700 capitalize">{acct.account_type?.replace("_", "/")}</div></div>
  <div><span className="text-subtle-400">Last Checked</span><div className="font-semibold text-subtle-700">{fmtDate(acct.last_checked_at, "Never")}</div></div>
  <div><span className="text-subtle-400">Frequency</span><div className="font-semibold text-subtle-700 capitalize">{acct.check_frequency}</div></div>
  </div>
  <div className="flex gap-2 mt-3 pt-3 border-t border-subtle-50">
  <TextLink tone="brand" size="xs" underline={false} onClick={() => triggerManualCheck(acct)} className="border border-brand-200 px-3 py-1 rounded-lg hover:bg-brand-50">🔄 Check Now</TextLink>
  <TextLink tone="danger" size="xs" onClick={() => deleteAccount(acct)} className="ml-auto">Delete</TextLink>
  </div>
  </div>
  ))}
  </div>
  )}

  {autoBills.length > 0 && (
  <div>
  <h3 className="font-semibold text-subtle-700 mb-3">Fetched Bills</h3>
  <div className="space-y-2">
  {autoBills.map(bill => (
  <div key={bill.id} className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 flex items-center gap-4">
  <div className="flex-1"><div className="font-semibold text-subtle-800 text-sm">{bill.provider_display || bill.provider}</div><div className="text-xs text-subtle-400">{bill.property} · Due {fmtDate(bill.due_date, "—")}</div></div>
  <div className="text-lg font-bold text-subtle-800">${safeNum(bill.amount).toLocaleString()}</div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (bill.status === "paid" ? "bg-positive-100 text-positive-700" : bill.status === "authorized" ? "bg-info-100 text-info-700" : "bg-warn-100 text-warn-700")}>{bill.status?.replace("_", " ")}</span>
  {["pending_review", "partial"].includes(bill.status) && bill.responsibility !== "tenant" && bill.responsibility !== "condo_fee" && payablePortalFor(bill.provider_display || bill.provider) && (<>
  <Btn variant="positive" size="sm" onClick={() => payBillViaPortal(bill)}>Pay this bill</Btn>
  {/* Pay by card in the streamed secure browser: the person enters the card on
      the provider's own page; PropManager never holds it. */}
  <Btn variant="slate" size="sm" onClick={() => setPayingBill({ ...bill, due: bill.due || bill.due_date })}>Online Payment</Btn>
  {/* Paying less than the full amount is a real thing -- a payment plan, or
      holding back a disputed portion. Asking for the figure here keeps it a
      deliberate choice rather than something typed into the provider's form
      and hoped for. */}
  <TextLink tone="neutral" size="xs" onClick={async () => {
    const raw = window.prompt(`How much of the ${formatCurrency(safeNum(bill.amount))} do you want to pay?`, "");
    if (raw == null) return;
    const v = Number(String(raw).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(v) || v <= 0) { showToast("That is not an amount.", "error"); return; }
    await payBillViaPortal(bill, v);
  }}>Pay part</TextLink>
</>)}
  </div>
  ))}
  </div>
  </div>
  )}
  </div>
  )}

  {/* ===== JOB HISTORY TAB ===== */}
  {utilTab === "jobs" && (
  <div>
  <h3 className="font-semibold text-subtle-700 mb-3">Automation Job History</h3>
  {autoJobs.length === 0 ? (
  <div className="text-center py-12 bg-white rounded-xl border border-neutral-200"><div className="text-subtle-400">No automation jobs yet</div></div>
  ) : (
  <div className="space-y-2">
  {autoJobs.map(job => (
  <div key={job.id} className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 flex items-center gap-4">
  <div className="flex-1"><div className="font-semibold text-subtle-800 text-sm capitalize">{job.job_type?.replace("_", " ")}</div><div className="text-xs text-subtle-400">{job.triggered_by} · {fmtDateTime(job.created_at)}</div></div>
  <span className={"px-2 py-0.5 rounded-full text-xs font-bold " + (job.status === "completed" ? "bg-positive-100 text-positive-700" : job.status === "failed" ? "bg-danger-100 text-danger-700" : job.status === "running" ? "bg-info-100 text-info-700" : "bg-subtle-100 text-subtle-500")}>{job.status}</span>
  {job.error_message && <div className="text-xs text-danger-500 max-w-xs truncate">{job.error_message}</div>}
  </div>
  ))}
  </div>
  )}
  </div>
  )}

  {/* ===== MANUAL BILLS TAB ===== */}
  {utilTab === "bills" && (<>
  {/* Toolbar — search stays out; Status / Owed-by / Hide-$0 / Biller / Property
      collapse behind one Filters button (badge = how many are active). */}
  {(() => {
  const activeFilters = (utilFilterStatus !== "all" ? 1 : 0) + (utilFilterResp !== "all" ? 1 : 0)
    + (utilHideZero ? 1 : 0) + (utilFilterProviders.length ? 1 : 0) + (utilFilterProps.length ? 1 : 0);
  return (
  <div className="flex gap-2 mb-4 items-center">
  <Input placeholder="Search provider or property…" value={utilSearch} onChange={e => setUtilSearch(e.target.value)} className="flex-1 min-w-0" />
  <div className="relative">
  <Btn variant="secondary" onClick={() => setShowFilters(!showFilters)} className="whitespace-nowrap">
    Filters{activeFilters ? <span className="ml-1.5 text-2xs bg-brand-500 text-white rounded-full px-1.5 py-0.5">{activeFilters}</span> : ""}
  </Btn>
  {showFilters && (<>
  <div className="fixed inset-0 z-10" onClick={() => setShowFilters(false)} />
  <div className="absolute right-0 top-11 z-20 w-80 bg-white border border-neutral-200 rounded-xl shadow-pop p-4 space-y-3.5">
  <div>
    <label className="text-2xs uppercase tracking-wide text-neutral-400 mb-1 block">Status</label>
    <Select value={utilFilterStatus} onChange={e => setUtilFilterStatus(e.target.value)} className="w-full">
    <option value="all">All Status</option>
    <option value="pending_review">To review</option>
    <option value="authorized">Approved</option>
    <option value="paid">Paid</option>
    <option value="settled">Recharged</option>
    <option value="no_balance">No balance</option>
    <option value="no_bill">No bill yet</option>
    <option value="error">Read failed</option>
    </Select>
  </div>
  <div>
    <label className="text-2xs uppercase tracking-wide text-neutral-400 mb-1 block">Owed by</label>
    <Select value={utilFilterResp} onChange={e => setUtilFilterResp(e.target.value)} className="w-full">
    <option value="all">All Owed by</option>
    <option value="owner">Owner</option>
    <option value="tenant">Tenant</option>
    <option value="condo_fee">Condo fee</option>
    </Select>
  </div>
  <div>
    <label className="text-2xs uppercase tracking-wide text-neutral-400 mb-1 block">Biller</label>
    <MultiSelect ariaLabel="Filter by biller" allLabel="All Billers" searchPlaceholder="Filter billers…"
      value={utilFilterProviders} onChange={setUtilFilterProviders}
      options={[...new Set(utilities.map(u => u.provider).filter(Boolean))].sort((a, b) => a.localeCompare(b))
        .map(p => ({ value: p, label: p, hint: String(utilities.filter(u => u.provider === p).length) }))} />
  </div>
  <div>
    <label className="text-2xs uppercase tracking-wide text-neutral-400 mb-1 block">Property</label>
    <MultiSelect ariaLabel="Filter by property" allLabel="All Properties" searchPlaceholder="Filter properties…"
      value={utilFilterProps} onChange={setUtilFilterProps}
      options={[...new Set(utilities.map(u => u.property).filter(Boolean))].sort((a, b) => a.localeCompare(b))
        .map(p => ({ value: p, label: p }))} />
  </div>
  <label className="flex items-center justify-between text-sm text-neutral-600 cursor-pointer pt-1">
    <span>Hide $0 balances</span>
    <input type="checkbox" checked={utilHideZero} onChange={e => setUtilHideZero(e.target.checked)} className="accent-brand-500 w-4 h-4" />
  </label>
  {activeFilters > 0 && <button onClick={() => { setUtilFilterStatus("all"); setUtilFilterResp("all"); setUtilHideZero(false); setUtilFilterProviders([]); setUtilFilterProps([]); }} className="text-xs text-brand-600 hover:underline">Clear all filters</button>}
  </div>
  </>)}
  </div>
  <div className="flex bg-brand-50 rounded-lg p-0.5">
  {[["card","▦"],["table","☰"]].map(([m,icon]) => (
  <button key={m} onClick={() => setUtilView(m)} title={m === "card" ? "Cards" : "Table"} aria-label={(m === "card" ? "Cards" : "Table") + " view"} aria-pressed={utilView === m} className={`px-3 py-1.5 text-sm rounded-lg ${utilView === m ? "bg-white shadow-card text-brand-700 font-semibold" : "text-neutral-400"}`}>{icon}</button>
  ))}
  </div>
  <Btn onClick={() => setShowForm(!showForm)} className="whitespace-nowrap">+ Bill</Btn>
  </div>
  );
  })()}

  {/* Stats — asked of BILLS, which is the first time they can mean anything.
      "Pending" counted accounts with a status flag; overdue was unanswerable
      because no bill carried its own due date. */}
  {(() => {
    const open = utilities.filter(u => u.responsibility !== "condo_fee" && !["paid", "settled", "excluded", "no_bill", "no_balance"].includes(u.status));
    const overdue = open.filter(u => { const d = billAge(u, todayRef); return d !== null && d < 0; });
    const soon = open.filter(u => { const d = billAge(u, todayRef); return d !== null && d >= 0 && d <= 7; });
    const owed = open.reduce((t, u) => t + safeNum(u.amount), 0);
    // A pending final bill reads as tenant-responsible but is the OWNER's, so it
    // is excluded from the tenants' share.
    const tenantOwed = open.filter(u => u.responsibility === "tenant").reduce((t, u) => t + safeNum(u.amount), 0);
    // Compact single strip (was six separate cards). Minimal colour: only a
    // real Overdue count is red; everything else is neutral.
    const cells = [
      [utilities.length, "Accounts", "text-neutral-800"],
      [open.length, "To pay", "text-neutral-800"],
      [overdue.length, "Overdue", overdue.length ? "text-danger-600" : "text-neutral-300"],
      [soon.length, "Due in 7 days", "text-neutral-800"],
      [formatCurrency(owed), "Outstanding", "text-neutral-800"],
      ...(tenantOwed > 0 ? [[formatCurrency(tenantOwed), "Tenants' share", "text-neutral-800"]] : []),
    ];
    return (
      <div className="flex mb-4 bg-white rounded-xl border border-neutral-200 shadow-card overflow-hidden">
        {cells.map(([v, l, c], i) => (
          <div key={l} className={`flex-1 min-w-0 px-3 py-2.5 ${i < cells.length - 1 ? "border-r border-neutral-100" : ""}`}>
            <div className={`text-base font-bold tabular-nums ${c}`}>{v}</div>
            <div className="text-2xs uppercase tracking-wide text-neutral-400 mt-0.5">{l}</div>
          </div>
        ))}
      </div>
    );
  })()}

  {showForm && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card p-4 mb-4">
  <h3 className="font-semibold text-neutral-700 mb-3">New Utility Bill</h3>
  <div className="grid grid-cols-2 gap-3">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Property *</label><PropertySelect value={form.property} onChange={v => setForm({ ...form, property: v })} companyId={companyId} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Provider</label>
  <Select value={providers.some(p => p.display_name === form.provider) ? form.provider : (form.provider ? "__keep__" : "")} onChange={async e => {
    const v = e.target.value;
    if (v === "__add__") { const name = window.prompt("New utility provider name:"); if (name && name.trim()) { const dn = await addUtilityProvider(name); if (dn) setForm(f => ({ ...f, provider: dn })); } }
    else if (v !== "__keep__") { setForm(f => ({ ...f, provider: v })); }
  }}>
    <option value="">Select provider…</option>
    {form.provider && !providers.some(p => p.display_name === form.provider) && <option value="__keep__">{form.provider} (current)</option>}
    {providers.map(p => <option key={p.id} value={p.display_name}>{p.display_name}{p.approval_status === "pending" ? " (pending)" : ""}</option>)}
    <option value="__add__">+ Add new provider…</option>
  </Select></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Amount ($)</label><Input placeholder="150.00" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Due Date</label><Input type="date" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Responsibility</label><Select value={form.responsibility} onChange={e => setForm({ ...form, responsibility: e.target.value })}>
  <option value="owner">Owner</option>
  <option value="tenant">Tenant</option>
  <option value="shared">Shared</option>
  <option value="condo_fee">Covered by condo fee</option>
  </Select></div>
  <div className="col-span-2 border-t border-neutral-100 pt-2 mt-1"><p className="text-xs text-neutral-400 mb-2">Portal Login (encrypted)</p>
  <div className="grid grid-cols-3 gap-2">
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Website</label><Input type="url" value={form.website||""} onChange={e => setForm({...form, website: e.target.value})} placeholder="https://..." /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Username</label><Input value={form.username||""} onChange={e => setForm({...form, username: e.target.value})} /></div>
  <div><label className="text-xs font-medium text-neutral-400 mb-1 block">Password</label><Input type="password" value={form.password||""} onChange={e => setForm({...form, password: e.target.value})} /></div>
  </div></div>
  </div>
  <div className="flex gap-2 mt-3">
  <Btn onClick={addUtility}>Save</Btn>
  <Btn variant="slate" onClick={() => setShowForm(false)}>Cancel</Btn>
  </div>
  </div>
  )}

  {(() => {
  const filteredUtils = utilities.filter(u =>
  (utilFilterStatus === "all" || u.status === utilFilterStatus) &&
  (utilFilterResp === "all" || (u.responsibility || "owner") === utilFilterResp) &&
  (!utilHideZero || safeNum(u.amount) > 0) &&
  (utilFilterProps.length === 0 || utilFilterProps.includes(u.property)) &&
  (utilFilterProviders.length === 0 || utilFilterProviders.includes(u.provider)) &&
  (!utilSearch || u.provider?.toLowerCase().includes(utilSearch.toLowerCase()) || u.property?.toLowerCase().includes(utilSearch.toLowerCase()))
  );
  // Sorted here rather than in DataTable: the primitive draws the header
  // affordance and reports the click, the caller owns the order. Amount and
  // due date compare as number and date; everything else as text, so
  // "BGE" before "Pepco" and $27.40 before $403.02 rather than "$27.40"
  // before "$403.02" as strings would have it.
  const fu = (() => {
    const { key, dir } = utilSort;
    if (!key) return filteredUtils;
    const mul = dir === "desc" ? -1 : 1;
    const val = (u) => {
      if (key === "amount") return safeNum(u.amount);
      if (key === "due") return u.due || "";           // ISO date sorts as text
      if (key === "login") return (u.website || "").toLowerCase();
      return String(u[key] ?? "").toLowerCase();
    };
    // Slice first: sort mutates, and mutating the filtered array in a render
    // is how a list starts reordering itself on unrelated state changes.
    return filteredUtils.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return 0;
      // Blanks last in both directions -- a bill with no amount read yet is
      // not "the cheapest".
      if (x === "" || x === null) return 1;
      if (y === "" || y === null) return -1;
      return (x > y ? 1 : -1) * mul;
    });
  })();
  return <>
  {utilView === "card" && (
  <div className="space-y-3">
  {fu.map(u => (
  <div key={u.id} className="bg-white rounded-xl border border-neutral-200 shadow-card p-4">
  <div className="flex justify-between items-start">
  <div><div className="font-semibold text-neutral-800">{u.provider}{u.is_final_bill && <span className="ml-1.5 text-2xs px-1.5 py-0.5 rounded-full bg-warn-100 text-warn-700 align-middle" title="Closeout bill in the owner's name after the tenant took over">Final bill</span>}</div><div className="text-xs text-neutral-400 mt-0.5">{u.property}</div></div>
  <div className="text-right"><div className="text-lg font-display font-bold text-neutral-800">${u.amount}</div>
  <span className={`inline-block text-xs px-2 py-0.5 rounded-full ${STATUS_CLASS[(BILL_STATUS[u.status] || BILL_STATUS.pending_review).tone]}`}>{(BILL_STATUS[u.status] || BILL_STATUS.pending_review).label}</span></div>
  </div>
  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
  <div><span className="text-neutral-400">Due</span><div className="font-semibold text-neutral-700">{fmtDate(u.due)}</div></div>
  <div><span className="text-neutral-400">Responsibility</span><div className="font-semibold text-neutral-700">{respLabel(u.responsibility)}</div></div>
  <div><span className="text-neutral-400">Paid</span><div className="font-semibold text-neutral-700">{fmtDate(u.paid_at, "—")}</div></div>
  </div>
  {/* Actions — Online Payment / Statements / Receipts stay outside; the rest
      (manual payment, history, portal login, re-auth, audit) move into the ⋯
      menu. Card and table stay at parity. */}
  <div className="mt-3 flex items-center gap-2">
  {payablePortalFor(u.provider_display || u.provider) && !["paid","settled","excluded"].includes(u.status) && u.responsibility !== "condo_fee" && (
    (u.responsibility !== "tenant" || userRole === "admin")
      ? <TextLink tone="brand" size="xs" underline={false} onClick={() => setPayingBill({ ...u, due: u.due || u.due_date })} className="border border-brand-100 px-3 py-1 rounded-lg hover:bg-brand-50/30">Online Payment</TextLink>
      : <span className="text-xs text-neutral-300 border border-neutral-200 px-3 py-1 rounded-lg cursor-not-allowed" title="Tenant-owed — an admin must approve before it can be paid on their behalf">Online Payment</span>
  )}
  {u.has_statements && <TextLink tone="neutral" size="xs" underline={false} onClick={() => setDocPicker({ kind: "statements", accountId: u.id })} className="border border-neutral-200 px-3 py-1 rounded-lg hover:bg-neutral-50">Statements</TextLink>}
  {u.has_receipts && <TextLink tone="positive" size="xs" underline={false} onClick={() => setDocPicker({ kind: "receipts", accountId: u.id })} className="border border-positive-200 px-3 py-1 rounded-lg hover:bg-positive-50">Receipts</TextLink>}
  <div className="relative ml-auto">
    <button aria-label="More actions" onClick={() => setMenuOpenId(menuOpenId === u.id ? null : u.id)} className="w-8 h-8 rounded-lg border border-neutral-200 text-neutral-400 hover:text-neutral-700 hover:border-neutral-300 leading-none text-lg">⋯</button>
    {menuOpenId === u.id && (<>
      <div className="fixed inset-0 z-10" onClick={() => setMenuOpenId(null)} />
      <div className="absolute right-0 top-9 z-20 w-56 bg-white border border-neutral-200 rounded-xl shadow-pop p-1">
        {u.bill_id && !["paid","settled","excluded"].includes(u.status) && <button onClick={() => { setMenuOpenId(null); setPayBill(u); setPayForm({ amount: String(safeNum(u.amount) || ""), paid_on: formatLocalDate(new Date()), bank_account_id: "", confirmation: "", method: "", recharge: u.responsibility === "tenant" }); loadBankAccounts(); }} className="w-full text-left text-sm text-neutral-700 px-3 py-2 rounded-lg hover:bg-neutral-50">Record manual payment</button>}
        <button onClick={() => { setMenuOpenId(null); setHistoryFor(u.id); }} className="w-full text-left text-sm text-neutral-700 px-3 py-2 rounded-lg hover:bg-neutral-50">Bill history</button>
        {u.username_encrypted && <button onClick={async () => { setMenuOpenId(null); const s = new Set(showCreds); if (s.has(u.id)) { s.delete(u.id); setShowCreds(new Set(s)); return; } u._decUser = await decryptCredential(u.username_encrypted, u.encryption_iv_username || u.encryption_iv, companyId, u.encryption_salt); u._decPass = await decryptCredential(u.password_encrypted, u.encryption_iv, companyId, u.encryption_salt); s.add(u.id); setShowCreds(new Set(s)); }} className="w-full text-left text-sm text-neutral-700 px-3 py-2 rounded-lg hover:bg-neutral-50">{showCreds.has(u.id) ? "Hide portal login" : "Portal login"}</button>}
        {payablePortalFor(u.provider_display || u.provider) && <button onClick={() => { setMenuOpenId(null); setPayingBill({ ...u, __enroll: true }); }} title="Sign in to the provider in a secure browser so Housy can fetch bills automatically" className="w-full text-left text-sm text-neutral-700 px-3 py-2 rounded-lg hover:bg-neutral-50">Re-authenticate portal</button>}
        <div className="border-t border-neutral-100 my-1" />
        <button onClick={() => { setMenuOpenId(null); openAuditLog(u); }} className="w-full text-left text-sm text-neutral-500 px-3 py-2 rounded-lg hover:bg-neutral-50">Audit trail</button>
      </div>
    </>)}
  </div>
  </div>
  {showCreds.has(u.id) && u.username_encrypted && (
    <div className="mt-2 text-xs text-neutral-600 truncate" title={`${u._decUser || "—"} / ${u._decPass || "—"}`}>
      {u._decUser || "—"} / {u._decPass || "—"}
      {u.website && <a href={u.website} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline ml-2">open portal</a>}
    </div>
  )}
  </div>
  ))}
  </div>
  )}
  {utilView === "table" && (
  <div className="bg-white rounded-xl border border-neutral-200 shadow-card overflow-x-auto">
  <DataTable
    // Every column carries a width because resizing needs fixed layout: without
    // a starting width per column the browser divides the table equally and the
    // first render looks wrong. Widths a user drags are remembered per viewer
    // under storageKey.
    columns={[
      { key: "provider", label: "Provider", sort: true, width: 120, className: "font-medium text-neutral-800 truncate", render: u => (
        <span>{u.provider}{u.is_final_bill && <span className="ml-1 text-2xs px-1 py-0.5 rounded-full bg-warn-100 text-warn-700 whitespace-nowrap" title="Closeout bill in the owner's name after the tenant took over">Final bill</span>}</span>
      ) },
      { key: "property", label: "Property", sort: true, width: 260, className: "text-neutral-500 truncate" },
      { key: "amount", label: "Amount", sort: true, width: 100, align: "right", className: "font-semibold",
        render: u => u.amount === null
          ? <span className="text-neutral-300">—</span>
          : formatCurrency(safeNum(u.amount)) },
      { key: "due", label: "Due", sort: true, width: 100, className: "text-neutral-400 whitespace-nowrap",
        render: u => <>{fmtDate(u.due)}</> },
      { key: "status", label: "Status", sort: true, width: 120, render: u => {
        const meta = BILL_STATUS[u.status] || BILL_STATUS.pending_review;
        const days = billAge(u, todayRef);
        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className={`text-2xs px-1.5 py-0.5 rounded-full ${STATUS_CLASS[meta.tone]}`}>{meta.label}</span>
            {days !== null && days < 0 && <span className="text-2xs text-danger-600 font-semibold">{-days}d late</span>}
            {days !== null && days >= 0 && days <= 7 && <span className="text-2xs text-warn-600">in {days}d</span>}
          </div>
        );
      } },
      // Who owes it. utilities.responsibility has always held this and
      // nothing ever acted on it; a tenant-responsible bill you paid should
      // become that tenant's debt, not an owner expense.
      { key: "responsibility", label: "Owed by", sort: true, width: 118, render: u => (
        <span className={`text-2xs px-1.5 py-0.5 rounded-full ${u.responsibility === "tenant" ? "bg-brand-100 text-brand-700" : u.responsibility === "condo_fee" ? "bg-info-100 text-info-700" : "bg-neutral-100 text-neutral-500"}`}>
          {respLabel(u.responsibility)}
        </span>
      ) },
      // One line. This cell used to stack three things -- the portal link, a
      // "Show login" toggle, and the revealed credentials underneath -- which
      // set the height of every row in the table whether or not anything was
      // revealed. The link and the toggle now sit side by side, and revealing
      // replaces the link rather than growing the row.
      { key: "login", label: "Portal", sort: true, width: 190, className: "text-xs",
        render: u => (
        <div className="flex items-center gap-2 whitespace-nowrap">
          {showCreds.has(u.id)
            ? <span className="text-neutral-600 truncate" title={`${u._decUser || "—"} / ${u._decPass || "—"}`}>{u._decUser || "\u2014"} / {u._decPass || "\u2014"}</span>
            : (u.website
                ? <a href={u.website} target="_blank" rel="noopener noreferrer" title={u.website}
                    className="text-brand-600 hover:underline truncate">{u.website.replace(/^https?:\/\//, "")}</a>
                : <span className="text-neutral-300">\u2014</span>)}
          {u.username_encrypted && (
            <TextLink tone="brand" size="xs" className="shrink-0" onClick={async () => {
              const s = new Set(showCreds);
              if (s.has(u.id)) { s.delete(u.id); setShowCreds(s); return; }
              u._decUser = await decryptCredential(u.username_encrypted, u.encryption_iv_username || u.encryption_iv, companyId, u.encryption_salt);
              u._decPass = await decryptCredential(u.password_encrypted, u.encryption_iv, companyId, u.encryption_salt);
              s.add(u.id); setShowCreds(new Set(s));
            }}>{showCreds.has(u.id) ? "Hide" : "Login"}</TextLink>
          )}
        </div>
      ) },
      // Parity with the card view: Online Payment / Statements / Receipts stay
      // visible; the rest live in the ⋯ menu. The menu is positioned FIXED (see
      // tableMenu) so the table's horizontal scroll container cannot clip it.
      { key: "actions", label: "Actions", width: 210, align: "right", className: "whitespace-nowrap", render: u => (
        <div className="flex items-center justify-end gap-2.5">
        {payablePortalFor(u.provider_display || u.provider) && u.status !== "paid" && u.status !== "settled" && u.status !== "excluded" && u.responsibility !== "condo_fee" && (
          (u.responsibility !== "tenant" || userRole === "admin")
            ? <TextLink tone="brand" size="xs" onClick={() => setPayingBill({ ...u, due: u.due || u.due_date })}>Pay online</TextLink>
            : <span className="text-2xs text-neutral-300 cursor-not-allowed" title="Tenant-owed — an admin must approve before it can be paid on their behalf">Pay online</span>
        )}
        {u.has_statements && <TextLink tone="neutral" size="xs" onClick={() => setDocPicker({ kind: "statements", accountId: u.id })}>Stmts</TextLink>}
        {u.has_receipts && <TextLink tone="positive" size="xs" onClick={() => setDocPicker({ kind: "receipts", accountId: u.id })}>Rcpts</TextLink>}
        <button aria-label="More actions" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setTableMenu(tableMenu?.id === u.id ? null : { id: u.id, top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }); }} className="w-7 h-7 rounded-md border border-neutral-200 text-neutral-400 hover:text-neutral-700 hover:border-neutral-300 leading-none text-base">⋯</button>
        </div>
      ) },
    ]}
    rows={fu}
    rowKey={u => u.id}
    density="compact"
    resizable storageKey="utilities-bills"
    sort={utilSort}
    onSort={key => setUtilSort(s2 => s2.key === key ? { key, dir: s2.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" })}
    empty="No utility bills found"
    scroll={false}
    ariaLabel="Utility bills"
  />
  </div>
  )}
  {tableMenu && (() => {
    const u = fu.find(x => x.id === tableMenu.id);
    if (!u) return null;
    const item = "w-full text-left text-sm text-neutral-700 px-3 py-2 rounded-lg hover:bg-neutral-50";
    return (<>
      <div className="fixed inset-0 z-40" onClick={() => setTableMenu(null)} />
      <div className="fixed z-50 w-56 bg-white border border-neutral-200 rounded-xl shadow-pop p-1" style={{ top: tableMenu.top, right: tableMenu.right }}>
        {u.bill_id && !["paid","settled","excluded"].includes(u.status) && <button className={item} onClick={() => { setTableMenu(null); setPayBill(u); setPayForm({ amount: String(safeNum(u.amount) || ""), paid_on: formatLocalDate(new Date()), bank_account_id: "", confirmation: "", method: "", recharge: u.responsibility === "tenant" }); loadBankAccounts(); }}>Record manual payment</button>}
        <button className={item} onClick={() => { setTableMenu(null); setHistoryFor(u.id); }}>Bill history</button>
        {u.username_encrypted && <button className={item} onClick={async () => { setTableMenu(null); const s = new Set(showCreds); if (s.has(u.id)) { s.delete(u.id); setShowCreds(new Set(s)); return; } u._decUser = await decryptCredential(u.username_encrypted, u.encryption_iv_username || u.encryption_iv, companyId, u.encryption_salt); u._decPass = await decryptCredential(u.password_encrypted, u.encryption_iv, companyId, u.encryption_salt); s.add(u.id); setShowCreds(new Set(s)); }}>{showCreds.has(u.id) ? "Hide portal login" : "Portal login"}</button>}
        {payablePortalFor(u.provider_display || u.provider) && <button className={item} onClick={() => { setTableMenu(null); setPayingBill({ ...u, __enroll: true }); }}>Re-authenticate portal</button>}
        <div className="border-t border-neutral-100 my-1" />
        <button className={item + " text-neutral-500"} onClick={() => { setTableMenu(null); openAuditLog(u); }}>Audit trail</button>
      </div>
    </>);
  })()}
  {fu.length === 0 && <EmptyState size="compact" title={"No utility bills found"} />}
  </>;
  })()}
  </>)}

  {/* ---- Pay by card in the streamed secure browser ----------------- */}
  {payingBill && (
    <PayBillModal
      bill={payingBill} enroll={payingBill.__enroll === true} companyId={companyId} userProfile={userProfile}
      showToast={showToast}
      onClose={() => setPayingBill(null)}
      onPaid={() => { setPayingBill(null); fetchAutomationData(); }}
    />
  )}

  {/* ---- Record a payment ------------------------------------------- */}
  {payBill && payForm && (
  <Modal title={`Record payment — ${payBill.provider}`} onClose={() => { setPayBill(null); setPayForm(null); }}>
  <div className="space-y-3">
  <div className="bg-subtle-50 rounded-lg p-3 text-xs">
  <div className="font-semibold text-neutral-800">{payBill.property}</div>
  <div className="text-neutral-500 mt-0.5">
    {payBill.statement_period ? `Statement ${payBill.statement_period}` : "No statement period"}
    {payBill.due ? ` · due ${fmtDate(payBill.due)}` : ""}
    {payBill.account_number ? ` · account ${payBill.account_number}` : ""}
  </div>
  <div className="text-neutral-700 mt-1">Billed <span className="font-semibold">{formatCurrency(safeNum(payBill.amount))}</span></div>
  </div>

  <div className="grid grid-cols-2 gap-3">
  <div>
    <label className="text-xs font-medium text-neutral-500 block mb-1">Amount paid</label>
    {/* Editable: a part payment is a real thing, and recording the billed
        figure when a different one left the bank is how the books and the
        statement quietly diverge. */}
    <Input type="number" step="0.01" value={payForm.amount}
      onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} />
  </div>
  <div>
    <label className="text-xs font-medium text-neutral-500 block mb-1">Date paid</label>
    <Input type="date" value={payForm.paid_on}
      onChange={e => setPayForm(f => ({ ...f, paid_on: e.target.value }))} />
  </div>
  </div>

  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Paid from</label>
  <Select value={payForm.bank_account_id} onChange={e => setPayForm(f => ({ ...f, bank_account_id: e.target.value }))}>
    <option value="">Choose an account…</option>
    {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.code ? a.code + " " : ""}{a.name}</option>)}
  </Select>
  </div>

  <div>
  <label className="text-xs font-medium text-neutral-500 block mb-1">Confirmation number <span className="text-neutral-400">(optional)</span></label>
  <Input value={payForm.confirmation}
    onChange={e => setPayForm(f => ({ ...f, confirmation: e.target.value }))}
    placeholder="From the provider's receipt" />
  </div>

  {payBill.responsibility === "tenant" && (
  <label className="flex items-start gap-2 bg-brand-50 border border-brand-100 rounded-lg p-3 cursor-pointer">
    <input type="checkbox" className="mt-0.5 rounded accent-brand-600" checked={!!payForm.recharge}
      onChange={e => setPayForm(f => ({ ...f, recharge: e.target.checked }))} />
    <span className="text-xs text-neutral-700">
      <span className="font-semibold">Charge this back to the tenant.</span>
      <span className="block text-neutral-500 mt-0.5">
        This bill is the tenant's responsibility. Ticked, it is posted as money they owe you
        rather than as your expense.
      </span>
    </span>
  </label>
  )}

  {payBill.website && (
  <a href={payBill.website} target="_blank" rel="noopener noreferrer"
     className="block text-xs text-brand-600 hover:underline">Open {payBill.provider}'s site to pay →</a>
  )}

  <div className="flex gap-2 pt-1">
  <Btn onClick={recordBillPayment}>Record payment</Btn>
  <Btn variant="slate" onClick={() => { setPayBill(null); setPayForm(null); }}>Cancel</Btn>
  </div>
  </div>
  </Modal>
  )}

  {/* ---- Bill history ------------------------------------------------ */}
  {docPicker && (() => {
  const acct = utilAccounts.find(a => a.id === docPicker.accountId);
  const isReceipts = docPicker.kind === "receipts";
  // Every statement / receipt for this biller at this property, newest first.
  // These are the same PDFs filed under the property's Documents -- listed here
  // where the bill lives, so the user opens the one they want without hunting.
  const rows = historyFor(docPicker.accountId).filter(b => isReceipts ? b.receipt_path : b.pdf_storage_path);
  return (
  <Modal title={`${acct?.provider || "Utility"} — ${isReceipts ? "receipts" : "statements"}`} onClose={() => setDocPicker(null)}>
  <div className="space-y-3">
  <div className="text-xs text-neutral-500">{acct?.property}{acct?.account_number ? ` · account ${acct.account_number}` : ""}</div>
  {rows.length === 0
    ? <EmptyState size="compact" title={`No ${isReceipts ? "receipts" : "statements"} on file`}
        hint={isReceipts
          ? "A receipt appears here after a payment is confirmed with the provider."
          : "A statement appears here the first time this account is read."} />
    : <ul className="divide-y divide-neutral-100">
        {rows.map(b => (
          <li key={b.id} className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm text-neutral-700">{b.statement_period || (b.due_date ? fmtDate(b.due_date) : "—")}</div>
              <div className="text-2xs text-neutral-400">
                {formatCurrency(safeNum(b.amount))}{b.due_date ? ` · due ${fmtDate(b.due_date)}` : ""}
              </div>
            </div>
            <TextLink tone="brand" size="xs" underline={false} className="border border-brand-100 px-3 py-1 rounded-lg hover:bg-brand-50/30"
              onClick={async () => {
                const path = isReceipts ? b.receipt_path : b.pdf_storage_path;
                const url = await getSignedUrl("documents", path, 300);
                if (url) window.open(url, "_blank", "noopener");
                else showToast(`Could not open that ${isReceipts ? "receipt" : "statement"}.`, "error");
              }}>Open</TextLink>
          </li>
        ))}
      </ul>}
  </div>
  </Modal>
  );
  })()}

  {historyFor_ != null && (() => {
  const acct = utilAccounts.find(a => a.id === historyFor_);
  const rows = historyFor(historyFor_);
  return (
  <Modal title={`${acct?.provider || "Utility"} — bill history`} onClose={() => setHistoryFor(null)}>
  <div className="space-y-3">
  <div className="text-xs text-neutral-500">{acct?.property}{acct?.account_number ? ` · account ${acct.account_number}` : ""}</div>
  {rows.length === 0
    ? <EmptyState size="compact" title="No bills recorded yet"
        hint="A bill appears here the first time this account is read, or when you add one by hand." />
    : (<DataTable
        density="compact"
        columns={[
          { key: "statement_period", label: "Statement", width: 90, render: b => <>{b.statement_period || "—"}</> },
          { key: "amount", label: "Billed", align: "right", width: 90, render: b => <>{formatCurrency(safeNum(b.amount))}</> },
          { key: "amount_paid", label: "Paid", align: "right", width: 90,
            render: b => b.amount_paid == null ? <span className="text-neutral-300">—</span> : <>{formatCurrency(safeNum(b.amount_paid))}</> },
          { key: "due_date", label: "Due", width: 96, render: b => <>{b.due_date ? fmtDate(b.due_date) : "—"}</> },
          { key: "status", label: "Status", width: 96, render: b => {
            const m = BILL_STATUS[b.status] || BILL_STATUS.pending_review;
            return <span className={`text-2xs px-1.5 py-0.5 rounded-full ${STATUS_CLASS[m.tone]}`}>{m.label}</span>;
          } },
          { key: "payment_confirmation", label: "Confirmation", render: b => <span className="text-2xs text-neutral-500">{b.payment_confirmation || "—"}</span> },
          { key: "pdf_storage_path", label: "Statement", width: 80, render: b => b.pdf_storage_path
            ? <TextLink tone="brand" size="xs" onClick={async () => {
                const url = await getSignedUrl("documents", b.pdf_storage_path, 300);
                if (url) window.open(url, "_blank", "noopener"); else showToast("Could not open that statement.", "error");
              }}>Open</TextLink>
            : <span className="text-neutral-300 text-2xs">—</span> },
          { key: "receipt_path", label: "Receipt", width: 80, render: b => b.receipt_path
            ? <TextLink tone="positive" size="xs" onClick={async () => {
                const url = await getSignedUrl("documents", b.receipt_path, 300);
                if (url) window.open(url, "_blank", "noopener"); else showToast("Could not open that receipt.", "error");
              }}>Open</TextLink>
            : <span className="text-neutral-300 text-2xs">—</span> },
        ]}
        rows={rows} rowKey={b => b.id} empty="No bills" scroll={false} />)}
  <p className="text-2xs text-neutral-400">
    Rows marked <em>migrated</em> in the data were the single balance this account
    carried before bills were kept separately — there is no history before that point.
  </p>
  </div>
  </Modal>
  );
  })()}

  </div>
  );
}

export { Utilities };
