import React, { useState, useEffect } from "react";
import { supabase } from "../supabase";
import { Btn, FileInput, Input, PageHeader, Select, Textarea } from "../ui";
import { safeNum, formatLocalDate, shortId, formatCurrency, sanitizeFileName, exportToCSV, getSignedUrl } from "../utils/helpers";
import { pmError } from "../utils/errors";
import { guardSubmit, guardRelease } from "../utils/guards";
import { logAudit } from "../utils/audit";
import { queueNotification } from "../utils/notifications";
import { Spinner, DocUploadModal, generatePaymentReceipt } from "./shared";

function TenantPortal({ currentUser, companyId, showToast, showConfirm }) {
  const [tenantData, setTenantData] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [payments, setPayments] = useState([]);
  const [messages, setMessages] = useState([]);
  const [workOrders, setWorkOrders] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [paymentProcessing, setPaymentProcessing] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  // Maintenance request form
  const [showMaintForm, setShowMaintForm] = useState(false);
  const [maintForm, setMaintForm] = useState({ issue: "", priority: "normal", notes: "" });
  const [maintPhotos, setMaintPhotos] = useState([]);
  const [showTenantDocUpload, setShowTenantDocUpload] = useState(false);

  useEffect(() => {
  async function fetchData() {
  const email = currentUser?.email;
  if (!email || !email.includes("@")) { setLoading(false); return; }
  const { data: tenant } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", email).maybeSingle();
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
  : supabase.from("payments").select("*").eq("company_id", companyId).ilike("tenant", tname).eq("property", tenant.property).is("archived_at", null).order("date", { ascending: false }),
  supabase.from("work_orders").select("*").eq("company_id", companyId).eq("tenant", tname).eq("property", tenant.property).is("archived_at", null).order("created", { ascending: false }),
  supabase.from("documents").select("*").eq("company_id", companyId).eq("tenant", tname).eq("tenant_visible", true).is("archived_at", null).order("uploaded_at", { ascending: false }),
  ]);
  setLedger(l.data || []);
  setMessages(m.data || []);
  setPayments(p.data || []);
  setWorkOrders(w.data || []);
  setDocuments(d.data || []);
  // Check autopay status
  if (tenant.name) {
  const { data: ap } = await supabase.from("autopay_schedules").select("enabled").eq("company_id", companyId).eq("tenant", tenant.name).maybeSingle();
  if (ap?.enabled) setAutopayEnabled(true);
  }
  setLoading(false);
  }
  fetchData();
  }, [currentUser]);

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
  const { data: t } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", currentUser?.email || "").maybeSingle();
  if (t) setTenantData(t);
  }

  // ---- STRIPE PAYMENT ----
  async function handleStripePayment() {
  if (!guardSubmit("handleStripePayment")) return;
  try {
  if (!paymentAmount || isNaN(Number(paymentAmount)) || Number(paymentAmount) <= 0) {
  showToast("Please enter a valid payment amount.", "error"); return;
  }
  if (Number(paymentAmount) > safeNum(tenantData.balance)) {
  if (!await showConfirm({ message: "Payment amount ($" + paymentAmount + ") exceeds your balance ($" + safeNum(tenantData.balance).toFixed(2) + "). The overpayment will be applied as a credit. Continue?" })) return;
  }
  setPaymentProcessing(true);
  try {
  const amt = Number(paymentAmount);
  // Try Stripe Checkout via Supabase Edge Function
  try {
  const { data, error } = await supabase.functions.invoke("create-checkout-session", {
  body: {
  amount: amt, // Send dollars — edge function converts to cents once
  tenantId: tenantData.id,
  tenantName: tenantData.name,
  property: tenantData.property,
  companyId: companyId,
  successUrl: window.location.origin + "?payment=success",
  cancelUrl: window.location.origin + "?payment=cancelled",
  }
  });
  if (!error && data?.url) {
  // Validate Stripe URL before redirect (prevents open redirect if API compromised)
  if (!data.url || !data.url.startsWith("https://checkout.stripe.com/")) { showToast("Invalid payment URL. Please try again.", "error"); return; }
  window.location.href = data.url;
  return;
  }
  } catch (stripeErr) { pmError("PM-8006", { raw: stripeErr, context: "Stripe edge function, using fallback", silent: true }); }
  // Fallback: record payment as pending_approval (no Stripe integration yet)
  const today = formatLocalDate(new Date());
  const { error: payErr } = await supabase.from("payments").insert([{ company_id: companyId,
  tenant: tenantData.name, property: tenantData.property, amount: amt,
  type: "rent", method: "stripe", status: "pending_approval", date: today,
  }]);
  if (payErr) throw new Error("Failed to record payment: " + payErr.message);
  setPaymentSuccess(true);
  setPaymentAmount("");
  addNotification("💳", "Payment of $" + amt.toFixed(2) + " submitted for approval");
  queueNotification("payment_received", currentUser?.email, { tenant: tenantData.name, amount: amt, date: today, status: "pending_approval" }, companyId);
  const { data: refreshed } = await supabase.from("tenants").select("*").eq("company_id", companyId).ilike("email", currentUser?.email || "").maybeSingle();
  if (refreshed) setTenantData(refreshed);
  } catch (e) {
  showToast("Payment failed: " + e.message, "error");
  }
  setPaymentProcessing(false);
  } finally { guardRelease("handleStripePayment"); }
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
  if (!newMessage.trim() || !tenantData) return;
  // Persist tenant_id on the row so the initial load query (which filters
  // by tenant_id) can read it back. Without this the message inserts with
  // tenant_id=NULL, and on next refresh the useEffect's tenant_id-scoped
  // fetch misses the row — the message appears to "vanish."
  const { error: insErr } = await supabase.from("messages").insert([{
    company_id: companyId,
    tenant_id: tenantData.id,
    tenant: tenantData.name,
    property: tenantData.property,
    sender: tenantData.name,
    message: newMessage,
    read: false,
  }]);
  if (insErr) {
    pmError("PM-8006", { raw: insErr, context: "messages write" });
    return; // keep the text in the box so user can retry
  }
  setNewMessage("");
  // Re-fetch with the SAME predicate as the initial load so the view stays
  // consistent across refreshes.
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

  const tabs = [
  ["overview", "\ud83c\udfe0 Overview"],
  ["pay", "\ud83d\udcb3 Pay Rent"],
  ["autopay", "🔄 Autopay"],
  ["history", "📋 History"],
  ["maintenance", "🔧 Maintenance"],
  ["documents", "\ud83d\udcc1 Documents"],
  ["messages", "\ud83d\udcac Messages"],
  ];

  return (
  <div>
  {/* Tenant Header */}
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

  {/* Tab Navigation */}
  <div className="flex gap-1 mb-5 overflow-x-auto pb-1 border-b border-brand-50">
  {tabs.map(([id, label]) => (
  <button key={id} onClick={() => setActiveTab(id)} className={"px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-colors " + (activeTab === id ? "border-brand-600 text-brand-700" : "border-transparent text-neutral-400 hover:text-neutral-700")}>{label}</button>
  ))}
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
  <Btn variant="danger-fill" size="xs" onClick={() => setActiveTab("pay")}>Pay Now</Btn>
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
  <div className="bg-positive-50 border border-positive-200 rounded-3xl p-4 mb-4 text-center">
  <div className="text-2xl mb-1">✅</div>
  <div className="text-positive-800 font-semibold">Payment Successful!</div>
  <div className="text-positive-600 text-sm">Your payment has been recorded and your balance updated.</div>
  </div>
  )}
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
  <button onClick={() => setPaymentAmount(String(tenantData.rent || 0))} className="text-xs bg-neutral-100 text-neutral-500 px-3 py-1 rounded-2xl hover:bg-neutral-100">Full Rent (${safeNum(tenantData.rent)})</button>
  {safeNum(tenantData.balance) > 0 && <button onClick={() => setPaymentAmount(String(tenantData.balance))} className="text-xs bg-danger-50 text-danger-600 px-3 py-1 rounded-lg hover:bg-danger-100">Full Balance (${safeNum(tenantData.balance)})</button>}
  </div>
  </div>
  <div className="mb-4 p-3 bg-brand-50/30 rounded-lg">
  <div className="flex items-center gap-2 mb-2">
  <div className="w-8 h-5 bg-gradient-to-r from-brand-600 to-highlight-600 rounded text-white text-xs flex items-center justify-center font-bold">S</div>
  <span className="text-sm text-neutral-500">Powered by Stripe</span>
  </div>
  <div className="text-xs text-neutral-400">Secure payment processing. Your card information is encrypted and never stored on our servers.</div>
  </div>
  <button onClick={handleStripePayment} disabled={paymentProcessing} className={"w-full py-3 rounded-xl text-white font-semibold text-sm transition-all " + (paymentProcessing ? "bg-neutral-400 cursor-not-allowed" : "bg-brand-600 hover:bg-brand-700 active:scale-98")}>
  {paymentProcessing ? "Processing..." : "Pay $" + (paymentAmount || "0")}
  </button>
  <div className="text-xs text-neutral-400 text-center mt-3">A receipt will be available after payment is confirmed.</div>
  </div>
  </div>
  )}

  {/* ---- AUTOPAY TAB ---- */}
  {activeTab === "autopay" && tenantData && (
  <div className="max-w-md mx-auto">
  <h3 className="font-manrope font-bold text-neutral-800 mb-4">Recurring Payments</h3>
  <div className="bg-white rounded-3xl border border-brand-50 shadow-card p-6">
  <div className="flex items-center justify-between mb-4">
  <div>
  <div className="text-sm font-semibold text-neutral-700">Monthly Autopay</div>
  <div className="text-xs text-neutral-400">Automatically pay rent on the 1st</div>
  </div>
  <button onClick={async () => {
  setAutopayLoading(true);
  try {
  if (autopayEnabled) {
  await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant", tenantData.name);
  setAutopayEnabled(false);
  addNotification("🔄", "Autopay disabled");
  } else {
  const { data: existing } = await supabase.from("autopay_schedules").select("id").eq("company_id", companyId).eq("tenant", tenantData.name).maybeSingle();
  if (existing) {
  await supabase.from("autopay_schedules").update({ enabled: true, amount: safeNum(tenantData.rent), method: "stripe" }).eq("id", existing.id);
  } else {
  await supabase.from("autopay_schedules").insert([{ company_id: companyId, tenant: tenantData.name, property: tenantData.property, amount: safeNum(tenantData.rent), method: "stripe", day_of_month: 1, enabled: true }]);
  }
  setAutopayEnabled(true);
  addNotification("🔄", "Autopay enabled — $" + safeNum(tenantData.rent) + "/month");
  }
  } catch (e) { pmError("PM-6001", { raw: e, context: "enable autopay" }); }
  setAutopayLoading(false);
  }} disabled={autopayLoading} className={`relative w-12 h-6 rounded-full transition-colors ${autopayEnabled ? "bg-success-500" : "bg-neutral-300"}`}>
  <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${autopayEnabled ? "tranneutral-x-6" : "tranneutral-x-0.5"}`} />
  </button>
  </div>
  {autopayEnabled && (
  <div className="bg-success-50 rounded-2xl p-4 space-y-2">
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Amount</span><span className="font-bold text-success-700">${safeNum(tenantData.rent).toLocaleString()}/month</span></div>
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Payment Day</span><span className="font-medium text-neutral-700">1st of each month</span></div>
  <div className="flex justify-between text-sm"><span className="text-neutral-400">Method</span><span className="font-medium text-neutral-700">Stripe</span></div>
  </div>
  )}
  {!autopayEnabled && (
  <div className="bg-brand-50/30 rounded-2xl p-4 text-center">
  <span className="material-icons-outlined text-neutral-300 text-3xl mb-2">autorenew</span>
  <p className="text-sm text-neutral-400">Enable autopay to schedule your rent payment on the 1st of each month via Stripe.</p>
  </div>
  )}
  </div>
  </div>
  )}

  {/* ---- PAYMENT HISTORY TAB ---- */}
  {activeTab === "history" && (
  <div>
  <div className="flex justify-between items-center mb-3">
  <h3 className="font-semibold text-neutral-700">Payment History</h3>
  <Btn variant="secondary" size="xs" onClick={() => exportToCSV(payments, [
  { label: "Date", key: "date" }, { label: "Type", key: "type" }, { label: "Amount", key: "amount" },
  { label: "Method", key: "method" }, { label: "Status", key: "status" },
  ], "my-payments", showToast)}><span className="material-icons-outlined text-xs align-middle mr-1">download</span>Export</Btn>
  </div>
  <div className="space-y-2">
  {payments.map(p => (
  <div key={p.id} className="bg-white border border-brand-50 rounded-2xl px-4 py-3 flex justify-between items-center">
  <div>
  <div className="text-sm font-medium text-neutral-800">{p.type === "rent" ? "Rent Payment" : p.type}</div>
  <div className="text-xs text-neutral-400">{p.date} · {p.method}</div>
  </div>
  <div className="flex items-center gap-3">
  {p.status === "paid" && <Btn variant="secondary" size="xs" onClick={() => generatePaymentReceipt(p)}>Receipt</Btn>}
  <div className="text-right">
  <div className="text-sm font-bold text-positive-600">${safeNum(p.amount).toLocaleString()}</div>
  <span className={"text-xs px-2 py-0.5 rounded-full " + (p.status === "paid" ? "bg-positive-100 text-positive-700" : "bg-warn-100 text-warn-700")}>{p.status}</span>
  </div>
  </div>
  </div>
  ))}
  {payments.length === 0 && <div className="text-center py-8 text-neutral-400">No payments recorded yet</div>}
  </div>
  {/* Ledger / Account Balance */}
  <h3 className="font-semibold text-neutral-700 mt-6 mb-3">Account Ledger</h3>
  <div className="space-y-2">
  {ledger.map(e => (
  <div key={e.id} className="bg-white border border-brand-50 rounded-2xl px-4 py-3">
  <div className="flex justify-between">
  <div><div className="text-sm font-medium text-neutral-800">{e.description}</div><div className="text-xs text-neutral-400">{e.date}</div></div>
  <div className="text-right">
  <div className={"text-sm font-bold " + (e.type === "payment" || e.type === "credit" ? "text-positive-600" : "text-danger-500")}>{e.type === "payment" || e.type === "credit" ? "+" + formatCurrency(Math.abs(e.amount)) : "-" + formatCurrency(Math.abs(e.amount))}</div>
  <div className="text-xs text-neutral-400">Bal: ${e.balance}</div>
  </div>
  </div>
  </div>
  ))}
  {ledger.length === 0 && <div className="text-center py-8 text-neutral-400">No ledger entries yet</div>}
  </div>
  </div>
  )}

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
  {activeTab === "messages" && (
  <div className="bg-white rounded-3xl border border-brand-50">
  <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
  {messages.map(m => (
  <div key={m.id} className={"flex " + (m.sender !== tenantData.name ? "justify-start" : "justify-end")}>
  <div className={"max-w-xs rounded-2xl px-4 py-2.5 " + (m.sender !== tenantData.name ? "bg-brand-600 text-white" : "bg-neutral-100 text-neutral-800")}>
  <div className="text-sm">{m.message}</div>
  <div className={"text-xs mt-1 " + (m.sender !== tenantData.name ? "text-brand-200" : "text-neutral-400")}>{m.sender} · {new Date(m.created_at).toLocaleDateString()}</div>
  </div>
  </div>
  ))}
  {messages.length === 0 && <div className="text-center py-6 text-neutral-400 text-sm">No messages yet. Send a message to your property manager below.</div>}
  </div>
  <div className="p-3 border-t border-brand-50 flex gap-2">
  <Input value={newMessage} onChange={e => setNewMessage(e.target.value)} onKeyDown={e => e.key === "Enter" && sendMessage()} placeholder="Message your property manager..." className="flex-1" />
  <Btn onClick={sendMessage}>Send</Btn>
  </div>
  </div>
  )}
  </div>
  );
}

export { TenantPortal };
