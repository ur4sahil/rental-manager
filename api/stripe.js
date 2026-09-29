// ════════════════════════════════════════════════════════════════════
// Stripe dispatcher — single Vercel function handling all Stripe-
// adjacent flows. We're at the Hobby-plan 12-function cap, so every
// new Stripe action routes through here via ?action=.
//
// Actions:
//   ?action=create-intent         Phase 1. POST, JWT-authed. Creates a
//                                 PaymentIntent for a one-time rent
//                                 payment. Returns client_secret +
//                                 total/fee/rent breakdown.
//   ?action=create-setup-intent   Phase 2. POST, JWT-authed. Creates a
//                                 SetupIntent so the tenant can save a
//                                 card for autopay without charging
//                                 right now. Returns client_secret +
//                                 customer_id.
//   ?action=save-payment-method   Phase 2. POST, JWT-authed. Called
//                                 after the SetupIntent confirms in
//                                 the browser. Persists the
//                                 PaymentMethod to autopay_schedules.
//   ?action=disable-autopay       Phase 2. POST, JWT-authed. Archives
//                                 the tenant's stripe-autopay row and
//                                 detaches the PaymentMethod.
//   ?action=charge-autopay-due    Phase 2. GET (Vercel Cron) or POST.
//                                 Bearer CRON_SECRET charges every due
//                                 row; a JWT of an active company admin
//                                 charges only that admin's companies.
//                                 Charges every autopay row whose
//                                 next_charge_date <= today.
//   ?action=webhook               Stripe → us. Verifies signature,
//                                 posts JE on payment_intent.succeeded,
//                                 stamps last_error on
//                                 payment_intent.payment_failed, and
//                                 reverses the payment's JE on
//                                 charge.refunded / charge.dispute.created
//                                 (re-posting it on charge.dispute.closed
//                                 when the dispute is won). The Stripe
//                                 endpoint must have those events enabled:
//                                 payment_intent.succeeded,
//                                 payment_intent.payment_failed,
//                                 charge.refunded, charge.dispute.created,
//                                 charge.dispute.closed.
//
// Required env vars (Vercel production):
//   STRIPE_SECRET_KEY            — sk_test_… or sk_live_…
//   STRIPE_WEBHOOK_SECRET        — whsec_… (signing secret of the
//                                  endpoint configured in Stripe)
//   SUPABASE_URL +
//   SUPABASE_SERVICE_ROLE_KEY    — for the server-side post on
//                                  webhook success (no caller JWT
//                                  available there)
//   CRON_SECRET                  — bearer for charge-autopay-due (>= 8
//                                  chars; Vercel Cron sends it as
//                                  "Authorization: Bearer <CRON_SECRET>")
// ════════════════════════════════════════════════════════════════════
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { isCronSecretBearer } = require("./_auth");
const webpush = require("web-push");
// Pure rules shared with the browser bundle (CommonJS, no imports).
const {
  pickRentReceiptCredit, isTenantOwnArAccount, localBusinessDate,
  billingPeriodOf, autopayIdempotencyKey, autopayMethodFromPmType, isAchAutopayMethod,
  refundReference, disputeReference, disputeWonReference,
  chargeDateInPeriod, nextChargeDateAfterPeriod, paymentStatusBlockers, autopayRunCompanyIds,
} = require("../src/utils/paymentRules");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-09-30.clover" }) : null;

// Configure web-push once at module load. Env vars must match what
// _send-push-impl.js uses so subscriptions registered there are
// deliverable from the webhook here.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || process.env.REACT_APP_VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@housify365.com";
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); }
  catch (e) { console.warn("[stripe] VAPID setup failed:", e.message); }
}

// ── Notification helper ──────────────────────────────────────────
// Called from the webhook on payment_intent.succeeded / payment_failed.
// Queues the email row in notification_queue (worker drains on its
// next tick, or fire-and-forget triggers it) AND fans out push
// notifications to all the recipients' registered devices.
//
// Recipients = the tenant (owner of the AR) + every active staff
// member of the company. Pulls staff via company_members (NOT app_users
// — that table returns null and silently breaks delivery, see
// project memory).
async function notifyPaymentEvent(sb, kind, ctx) {
  const { companyId, tenantName, tenantEmail, property, amount, date } = ctx;
  // 1. Resolve recipient set: tenant + every active staff. Track
  //    each address with its role so we can route tenant vs staff
  //    to different email templates (tenants get a "thank you"
  //    letter; staff get a payment-received heads-up).
  const tenantLower = (tenantEmail || "").toLowerCase();
  const { data: staff } = await sb.from("company_members")
    .select("user_email").eq("company_id", companyId)
    .eq("status", "active").neq("role", "tenant");
  const byRole = new Map(); // email -> "tenant" | "staff"
  if (tenantLower) byRole.set(tenantLower, "tenant");
  for (const s of (staff || [])) {
    const e = (s.user_email || "").toLowerCase();
    if (!e) continue;
    if (!byRole.has(e)) byRole.set(e, "staff");
  }
  if (byRole.size === 0) return;

  // 2. Queue email rows with role-appropriate templates. Two distinct
  //    types so the worker renders the right copy:
  //    payment_received       → "Hi {tenant}, we received your payment"
  //    payment_received_admin → "{tenant} paid {amount} for {property}"
  const dataPayload = {
    tenant: tenantName, property,
    amount: typeof amount === "number" ? "$" + amount.toFixed(2) : String(amount || ""),
    date,
  };
  if (kind === "failed") {
    dataPayload.error = ctx.error || "Card declined";
  }
  const queueRows = [];
  for (const [email, role] of byRole.entries()) {
    let type;
    if (kind === "succeeded") {
      type = role === "tenant" ? "payment_received" : "payment_received_admin";
    } else {
      type = role === "tenant" ? "payment_failed" : "payment_failed_admin";
    }
    queueRows.push({
      company_id: companyId, type,
      recipient_email: email,
      data: JSON.stringify(dataPayload),
      status: "pending",
    });
  }
  const { error: qErr } = await sb.from("notification_queue").insert(queueRows);
  if (qErr) console.warn("[stripe notify] notification_queue insert:", qErr.message);

  // Fire-and-forget: trigger the worker so the email goes out within
  // seconds instead of waiting for the next cron tick. CRON_SECRET
  // is the bearer the worker accepts for this path. The worker is
  // idempotent — the email send loop drains all pending rows then
  // returns, so concurrent triggers don't double-send.
  // The worker lives on THIS deployment: VERCEL_URL, else APP_URL. With
  // neither set, skip the trigger (the worker's own cron drains the queue)
  // rather than guess a host -- the old fallback sent a test deployment's
  // trigger, bearing its CRON_SECRET, to production.
  const workerBase = process.env.VERCEL_URL
    ? "https://" + process.env.VERCEL_URL.replace(/^https?:\/\//, "")
    : (process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://") : "");
  if (CRON_SECRET && workerBase) {
    fetch(workerBase + "/api/notifications?action=worker", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CRON_SECRET },
      body: "{}",
    }).catch(e => console.warn("[stripe notify] worker trigger failed (non-fatal):", e.message));
  }

  // 3. Push fan-out. setVapidDetails is at module load; if it failed
  //    (no env var) skip push and rely on email only.
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const title = kind === "succeeded"
    ? "Payment received · " + (tenantName || "")
    : "Autopay failed · " + (tenantName || "");
  const body = kind === "succeeded"
    ? "$" + Number(amount || 0).toFixed(2) + (property ? " · " + String(property).split(",")[0].trim() : "")
    : (ctx.error || "Card was declined") + (property ? " · " + String(property).split(",")[0].trim() : "");
  const url = kind === "succeeded" ? "/portal/ledger" : "/portal/autopay";
  const payload = JSON.stringify({ title, body, url });

  for (const email of byRole.keys()) {
    // The schema stores the whole PushSubscription as a JSONB blob in
    // a single `subscription` column ({ endpoint, keys: { p256dh, auth } }).
    // _send-push-impl.js reads it the same way — keep them in sync.
    const { data: subs } = await sb.from("push_subscriptions")
      .select("id, subscription")
      .eq("company_id", companyId).eq("user_email", email);
    for (const row of (subs || [])) {
      const subscription = row.subscription;
      if (!subscription?.endpoint) continue;
      try {
        // urgency:'high' bypasses iOS Notification Summary so the
        // banner lands live instead of getting rolled into the next
        // scheduled summary digest. Same flag on _send-push-impl.js.
        await webpush.sendNotification(subscription, payload, { TTL: 60 * 60 * 24, urgency: "high" });
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await sb.from("push_subscriptions").delete().eq("id", row.id);
        } else {
          console.warn("[stripe notify] push failed for", email, e.statusCode || e.message);
        }
      }
    }
  }
}

// ── Fee math ──────────────────────────────────────────────────────
// Pass-through gross-up so the company nets `rent` after Stripe takes
// 2.9% + $0.30 on card. ACH fees are different — handled separately
// when method='us_bank_account'.
function grossUpForCardFee(rentDollars) {
  const rentCents = Math.round(rentDollars * 100);
  const totalCents = Math.ceil((rentCents + 30) / 0.971);
  const feeCents = totalCents - rentCents;
  return { totalCents, feeCents, rentCents };
}

// Stripe ACH (us_bank_account): 0.8% capped at $5.00 per charge, no
// $0.30 fixed. Solving net-of-fee: rent = total - min(0.008*total, 500).
// Below the cap, total = rent / 0.992. At/above the cap, total = rent + 500.
// Cap kicks in at rent ≥ $620.
function grossUpForAchFee(rentDollars) {
  const rentCents = Math.round(rentDollars * 100);
  const totalUncapped = Math.ceil(rentCents / 0.992);
  const feeUncapped = totalUncapped - rentCents;
  if (feeUncapped >= 500) {
    const totalCents = rentCents + 500;
    return { totalCents, feeCents: 500, rentCents };
  }
  return { totalCents: totalUncapped, feeCents: feeUncapped, rentCents };
}

// ── Customer lookup/create helper ─────────────────────────────────
// Returns a Stripe Customer ID for the tenant, creating one if needed.
// Idempotent — safe to call repeatedly. Persists the ID on the tenant
// row so future calls hit the cache instead of re-creating.
async function ensureStripeCustomer(sb, tenant) {
  if (tenant.stripe_customer_id) return tenant.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: tenant.email || undefined,
    name: tenant.name || undefined,
    metadata: { tenant_id: String(tenant.id), company_id: String(tenant.company_id) },
  });
  await sb.from("tenants").update({ stripe_customer_id: customer.id }).eq("id", tenant.id);
  return customer.id;
}

// ── JWT auth helper ───────────────────────────────────────────────
async function authJwt(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return { error: "missing bearer token", status: 401 };
  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return { error: "invalid token", status: 401 };
  return { sb, user };
}

// Authorize: caller must be the tenant themselves OR an active member
// of the company. Returns { tenant } on success or { error, status }.
async function authTenantOrMember(sb, user, tenant_id, company_id) {
  const { data: tenant } = await sb.from("tenants").select("id, name, email, property, balance, company_id, stripe_customer_id, rent")
    .eq("id", tenant_id).eq("company_id", company_id).maybeSingle();
  if (!tenant) return { error: "tenant not found", status: 404 };
  const callerEmail = (user.email || "").toLowerCase();
  const isTenant = (tenant.email || "").toLowerCase() === callerEmail;
  let isMember = false;
  if (!isTenant) {
    const { data: mem } = await sb.from("company_members").select("role, status")
      .eq("company_id", company_id).ilike("user_email", callerEmail).eq("status", "active").maybeSingle();
    isMember = !!mem;
  }
  if (!isTenant && !isMember) return { error: "not authorized for this tenant", status: 403 };
  return { tenant };
}

// ── Books helpers (server side) ──────────────────────────────────
// Shared by the payment_intent.succeeded post and the refund / dispute
// reversals so all three number, date and class their entries the same way
// the app does (src/utils/accounting.js autoPostJournalEntry).

// The property's cost-center class, as getPropertyClassId resolves it:
// properties.class_id when it points at a live class, else the class named
// by the address (stored back on the property), else a new one.
async function resolvePropertyClassId(sb, companyId, property) {
  if (!companyId || !property) return null;
  try {
    const { data: prop } = await sb.from("properties").select("id, class_id")
      .eq("company_id", companyId).eq("address", property).maybeSingle();
    if (prop?.class_id) {
      const { data: cls } = await sb.from("acct_classes").select("id").eq("id", prop.class_id).eq("company_id", companyId).maybeSingle();
      if (cls?.id) return cls.id;
    }
    const { data: byName } = await sb.from("acct_classes").select("id").eq("company_id", companyId).eq("name", property).maybeSingle();
    let classId = byName?.id || null;
    if (!classId) {
      // No id in the payload: the column default supplies it.
      const { data: created } = await sb.from("acct_classes").insert({
        company_id: companyId, name: property, description: "Auto-created for " + String(property).split(",")[0].trim(),
        is_active: true,
      }).select("id").maybeSingle();
      classId = created?.id || null;
    }
    if (classId && prop?.id) await sb.from("properties").update({ class_id: classId }).eq("id", prop.id).eq("company_id", companyId);
    return classId;
  } catch (e) {
    console.warn("[stripe] class lookup failed (non-fatal):", e.message);
    return null;
  }
}

// Post a balanced journal entry: header numbered by the next_je_number RPC
// (retried on a number collision, re-calling the RPC each time), then lines.
// Returns { id } on success, { idempotent: true } when the reference already
// exists (the dedup index did its job), or { error }.
async function postJournalEntry(sb, { companyId, date, description, reference, property, lines, extra }) {
  const dr = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0);
  const cr = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  if (!lines.length || Math.abs(dr - cr) > 0.005) return { error: "JE would be unbalanced — refused to post" };
  let je = null, jeErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: jeNumber, error: numErr } = await sb.rpc("next_je_number", { p_company_id: companyId });
    if (numErr || !jeNumber) return { error: "next_je_number failed: " + (numErr?.message || "null") };
    const ins = await sb.from("acct_journal_entries").insert({
      company_id: companyId, number: jeNumber, date,
      description: String(description || "").slice(0, 500), reference,
      property: property || "", status: "posted", ...(extra || {}),
    }).select("id").maybeSingle();
    je = ins.data; jeErr = ins.error;
    if (!jeErr && je) break;
    const msg = (jeErr?.message || "") + " " + (jeErr?.details || "");
    if (/\b(reference)\b|idx_je_company_reference_unique/i.test(msg)) return { idempotent: true };
    if (!/\b(number)\b|acct_journal_entries_number|unique_je_number_per_company/i.test(msg)) break;
  }
  if (jeErr || !je) return { error: "JE insert failed: " + (jeErr?.message || "unknown") };
  const { error: linesErr } = await sb.from("acct_journal_lines").insert(lines.map(l => ({
    company_id: companyId, journal_entry_id: je.id,
    account_id: l.account_id, account_name: l.account_name || "",
    debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
    class_id: l.class_id || null, memo: l.memo || "",
  })));
  if (linesErr) {
    await sb.from("acct_journal_entries").update({ status: "voided", description: "[ORPHANED — lines failed] " + description }).eq("id", je.id);
    return { error: "JE lines insert failed: " + linesErr.message };
  }
  return { id: je.id };
}

// The tenant's OWN AR account for a Stripe receipt, via the stripe_tenant_ar
// RPC (supabase/migrations/20260928070000): the shared SQL helper
// _late_fee_tenant_ar (find -- active first, then lowest code -- / adopt an
// unambiguous legacy "AR - <name>" / create 1100-NNN with retry) under a
// per-tenant advisory lock, so two first payments racing for a new tenant
// both land on the one account instead of the loser falling back to Rental
// Income.
// Returns { account } (the acct_accounts row), { tenantMissing: true } when
// the tenant row does not exist in the company, or { error } -- the caller
// must then fail the webhook so Stripe retries.
async function getOrCreateTenantArServer(sb, companyId, tenantId) {
  const tid = Number(tenantId);
  if (!companyId || !Number.isFinite(tid)) return { tenantMissing: true };
  const { data: arId, error } = await sb.rpc("stripe_tenant_ar", { p_company_id: companyId, p_tenant_id: tid });
  if (error) return { error: "tenant AR lookup failed: " + error.message };
  if (!arId) return { tenantMissing: true };
  const { data: acct, error: readErr } = await sb.from("acct_accounts")
    .select("id, name, code, tenant_id, is_active").eq("company_id", companyId).eq("id", arId).maybeSingle();
  if (readErr || !acct) return { error: "tenant AR account " + arId + " could not be read: " + (readErr?.message || "not found") };
  if (!isTenantOwnArAccount(acct, tid)) return { error: "AR account " + arId + " is not linked to tenant " + tid };
  return { account: acct };
}

// The posted STRIPE-<pi> entry and its lines (webhook-global lookup: the PI
// id is unique across companies, and a webhook has no current company).
async function findStripePaymentEntry(sb, paymentIntentId) {
  if (!paymentIntentId) return null;
  // company-scope-exempt: keyed on a globally unique Stripe id; the row found
  // is what tells us the company.
  const { data: je } = await sb.from("acct_journal_entries")
    .select("id, company_id, property, description, status, lines:acct_journal_lines(account_id, account_name, debit, credit, class_id, memo)")
    .eq("reference", "STRIPE-" + paymentIntentId).neq("status", "voided").maybeSingle();
  return je || null;
}

// Is this PaymentIntent one of ours (created by this app, so it carries our
// metadata)? Used to decide between "retry later" (ours, the succeeded post
// has not landed yet) and "ignore" (not a rent payment).
async function isOurPaymentIntent(paymentIntentId) {
  if (!paymentIntentId || !stripe) return false;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    return !!(pi?.metadata?.company_id && pi?.metadata?.tenant_id);
  } catch (_e) { return false; }
}

// "Rent payment — Name — Property" -> "<label> — Name — Property", so the
// Payments page (which reads the tenant from the second " — " part) still
// shows the tenant on a reversal.
function reversalDescription(label, original, piId) {
  const d = String(original?.description || "");
  return /^Rent payment\s—/.test(d) ? d.replace(/^Rent payment/, label) : label + " — " + (d || piId);
}

// Status only moves forward (paymentStatusBlockers): a conditional update, so
// an out-of-order older event cannot downgrade what a newer one wrote.
async function setPaymentStatus(sb, companyId, paymentIntentId, status) {
  let q = sb.from("payments").update({ status })
    .eq("company_id", companyId).eq("stripe_session_id", paymentIntentId);
  for (const blocked of paymentStatusBlockers(status)) q = q.neq("status", blocked);
  const { error } = await q;
  if (error) console.warn("[stripe webhook] payments status update (non-fatal):", error.message);
}

// Post a refund / dispute reversal (or a dispute-won re-post) through the
// stripe_post_reversal RPC (supabase/migrations/20260928070000). The RPC
// holds a per-payment advisory lock while it computes what is already
// reversed and caps the new reversal at booked rent minus that, so
// concurrent or overlapping refund and dispute events can never reverse
// more than was booked. Returns { id } | { idempotent } | { skipped } | { error }.
async function postStripeReversal(sb, original, { piId, chargeId, kind, reference, amountCents, description, memo, disputeId, disputeStatus }) {
  const { data, error } = await sb.rpc("stripe_post_reversal", {
    p_company_id: original.company_id,
    p_payment_intent_id: piId,
    p_charge_id: chargeId || null,
    p_kind: kind,
    p_reference: reference,
    p_amount_cents: amountCents === null || amountCents === undefined ? null : Math.round(Number(amountCents) || 0),
    p_description: description,
    p_memo: memo,
    p_dispute_id: disputeId || null,
    p_dispute_status: disputeStatus || null,
    p_date: localBusinessDate(),
  });
  if (error) return { error: "stripe_post_reversal failed: " + error.message };
  const r = data || {};
  if (r.error) return { error: "stripe_post_reversal: " + r.error };
  return r;
}

// ── Action: create-intent ─────────────────────────────────────────
async function handleCreateIntent(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const auth = await authJwt(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { sb, user } = auth;

  const raw = await readRawBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { return res.status(400).json({ error: "invalid JSON body" }); }
  const { amount, tenant_id, company_id, payment_method = "card" } = body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "amount required and > 0" });
  if (!tenant_id || !company_id) return res.status(400).json({ error: "tenant_id + company_id required" });

  const a = await authTenantOrMember(sb, user, tenant_id, company_id);
  if (a.error) return res.status(a.status).json({ error: a.error });
  const { tenant } = a;

  // Pick fee math by method. Card is the default; us_bank_account
  // (Phase 3) gets the cheaper ACH fee.
  const fees = payment_method === "us_bank_account"
    ? grossUpForAchFee(amount)
    : grossUpForCardFee(amount);
  const { totalCents, feeCents, rentCents } = fees;

  try {
    // Always attach the PaymentIntent to a Stripe Customer for this
    // tenant. Without this, manually-entered ACH bank accounts float
    // on the PI alone — they don't appear under the Customer's
    // payment methods, which means the dashboard "Verify
    // microdeposits" button has nowhere to live and the saved-card
    // path can't reuse them. ensureStripeCustomer is idempotent:
    // returns the cached id from tenants.stripe_customer_id if set,
    // creates a new Customer otherwise.
    const customerId = await ensureStripeCustomer(sb, tenant);

    // Lock the PaymentIntent to the method the tenant chose in our UI
    // so the fee math holds. Card intents include Apple/Google Pay
    // automatically since both wallet-wrap a card payment under the
    // hood — Stripe surfaces them as wallet buttons inside the
    // PaymentElement when the device + browser support them.
    const methodTypes = payment_method === "us_bank_account"
      ? ["us_bank_account"]
      : ["card"];
    const intentParams = {
      amount: totalCents,
      currency: "usd",
      customer: customerId,
      payment_method_types: methodTypes,
      description: `Rent — ${tenant.name} — ${tenant.property || ""}`.slice(0, 250),
      metadata: {
        company_id: String(company_id),
        tenant_id: String(tenant_id),
        tenant_name: tenant.name || "",
        property: tenant.property || "",
        rent_cents: String(rentCents),
        fee_cents: String(feeCents),
        payment_method_kind: payment_method,
      },
    };
    const intent = await stripe.paymentIntents.create(intentParams);
    return res.status(200).json({
      client_secret: intent.client_secret,
      total_cents: totalCents,
      fee_cents: feeCents,
      rent_cents: rentCents,
    });
  } catch (e) {
    console.error("[stripe create-intent]", e.message);
    return res.status(500).json({ error: "Failed to create payment intent: " + e.message });
  }
}

// ── Action: create-setup-intent ───────────────────────────────────
// Phase 2 — saves a card for future autopay charges WITHOUT charging
// the tenant right now. Tenant clicks "Set up autopay" → SetupIntent
// returns client_secret → Stripe Elements collects the card → on
// confirm, the resulting PaymentMethod is attached to a Customer we
// create here. The tenant then calls save-payment-method to wire it
// to the autopay row.
async function handleCreateSetupIntent(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const auth = await authJwt(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { sb, user } = auth;

  const raw = await readRawBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { return res.status(400).json({ error: "invalid JSON body" }); }
  const { tenant_id, company_id, payment_method_types } = body;
  if (!tenant_id || !company_id) return res.status(400).json({ error: "tenant_id + company_id required" });

  const a = await authTenantOrMember(sb, user, tenant_id, company_id);
  if (a.error) return res.status(a.status).json({ error: a.error });
  const { tenant } = a;

  try {
    const customerId = await ensureStripeCustomer(sb, tenant);
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: payment_method_types || ["card", "us_bank_account"],
      usage: "off_session",
      metadata: {
        company_id: String(company_id),
        tenant_id: String(tenant_id),
        tenant_name: tenant.name || "",
        property: tenant.property || "",
      },
    });
    return res.status(200).json({
      client_secret: setupIntent.client_secret,
      customer_id: customerId,
    });
  } catch (e) {
    console.error("[stripe create-setup-intent]", e.message);
    return res.status(500).json({ error: "Failed to create setup intent: " + e.message });
  }
}

// ── Action: save-payment-method ───────────────────────────────────
// Browser calls this after SetupIntent.confirmSetup succeeds. We:
//   1. Read the SetupIntent to get the resulting payment_method ID
//   2. Make sure it's attached to the customer (Stripe usually does
//      this automatically when usage=off_session)
//   3. Persist the autopay row in autopay_schedules with provider='stripe'
async function handleSavePaymentMethod(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const auth = await authJwt(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { sb, user } = auth;

  const raw = await readRawBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { return res.status(400).json({ error: "invalid JSON body" }); }
  const { setup_intent_id, tenant_id, company_id, day_of_month = 1, amount } = body;
  if (!setup_intent_id || !tenant_id || !company_id) {
    return res.status(400).json({ error: "setup_intent_id + tenant_id + company_id required" });
  }

  const a = await authTenantOrMember(sb, user, tenant_id, company_id);
  if (a.error) return res.status(a.status).json({ error: a.error });
  const { tenant } = a;

  try {
    const setupIntent = await stripe.setupIntents.retrieve(setup_intent_id);
    if (setupIntent.status !== "succeeded") {
      return res.status(400).json({ error: "setup intent not succeeded — status=" + setupIntent.status });
    }
    const paymentMethodId = setupIntent.payment_method;
    if (!paymentMethodId) return res.status(400).json({ error: "setup intent missing payment_method" });
    const customerId = setupIntent.customer || tenant.stripe_customer_id;

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    const isCard = pm.type === "card";
    const cardBrand = isCard ? pm.card?.brand : pm.type;
    const cardLast4 = isCard ? pm.card?.last4 : pm.us_bank_account?.last4 || null;

    // Compute next_charge_date: the next occurrence of day_of_month
    // from today. If today is past day_of_month, jump to next month.
    const today = new Date();
    const target = new Date(today.getFullYear(), today.getMonth(), Math.min(day_of_month, 28));
    if (target <= today) target.setMonth(target.getMonth() + 1);
    const nextChargeDate = target.toISOString().slice(0, 10);

    // Upsert: replace any existing Stripe autopay row for this tenant.
    // The unique partial index on (company_id, tenant_id) WHERE
    // provider='stripe' enforces single-row semantics; soft-archive
    // the old row first, then insert the new one.
    await sb.from("autopay_schedules")
      .update({ archived_at: new Date().toISOString(), enabled: false })
      .eq("company_id", company_id).eq("tenant_id", tenant_id)
      .eq("provider", "stripe").is("archived_at", null);

    const { data: row, error: insErr } = await sb.from("autopay_schedules").insert({
      company_id, tenant_id,
      tenant: tenant.name, property: tenant.property,
      amount: amount || tenant.rent || 0,
      frequency: "monthly", day_of_month: Math.min(day_of_month, 28),
      provider: "stripe",
      // From the PaymentMethod's real type: a bank account saved here was
      // stored as "stripe_card" and then charged the card fee by the cron.
      method: autopayMethodFromPmType(pm.type),
      enabled: true, active: true,
      stripe_customer_id: customerId,
      stripe_payment_method_id: paymentMethodId,
      card_brand: cardBrand, card_last4: cardLast4,
      next_charge_date: nextChargeDate,
      start_date: nextChargeDate,
    }).select("id").maybeSingle();
    if (insErr) {
      console.error("[stripe save-payment-method] insert failed:", insErr.message);
      return res.status(500).json({ error: "Save failed: " + insErr.message });
    }

    return res.status(200).json({
      ok: true,
      autopay_id: row?.id,
      card_brand: cardBrand,
      card_last4: cardLast4,
      next_charge_date: nextChargeDate,
    });
  } catch (e) {
    console.error("[stripe save-payment-method]", e.message);
    return res.status(500).json({ error: "Save failed: " + e.message });
  }
}

// ── Action: disable-autopay ───────────────────────────────────────
async function handleDisableAutopay(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const auth = await authJwt(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { sb, user } = auth;

  const raw = await readRawBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { return res.status(400).json({ error: "invalid JSON body" }); }
  const { tenant_id, company_id } = body;
  if (!tenant_id || !company_id) return res.status(400).json({ error: "tenant_id + company_id required" });

  const a = await authTenantOrMember(sb, user, tenant_id, company_id);
  if (a.error) return res.status(a.status).json({ error: a.error });

  // Soft-archive the row + detach the PaymentMethod from the Customer.
  // Detach is best-effort — if it fails (PM already detached, etc.),
  // we still archive locally so the cron doesn't pick it up again.
  const { data: row } = await sb.from("autopay_schedules")
    .select("id, stripe_payment_method_id")
    .eq("company_id", company_id).eq("tenant_id", tenant_id)
    .eq("provider", "stripe").is("archived_at", null)
    .maybeSingle();
  if (!row) return res.status(404).json({ error: "no active stripe autopay for tenant" });

  if (row.stripe_payment_method_id) {
    try { await stripe.paymentMethods.detach(row.stripe_payment_method_id); }
    catch (e) { console.warn("[stripe disable-autopay] detach failed (non-fatal):", e.message); }
  }
  await sb.from("autopay_schedules")
    .update({ archived_at: new Date().toISOString(), enabled: false, active: false })
    .eq("id", row.id);

  return res.status(200).json({ ok: true, archived_id: row.id });
}

// ── Action: charge-autopay-due ────────────────────────────────────
// Cron-only. Runs once daily, charges every Stripe autopay whose
// next_charge_date <= today. For each: creates an off_session
// PaymentIntent that confirms immediately. Webhook handles JE post +
// failure stamping. We just enqueue the charges and bump
// next_charge_date forward; if the charge fails async, the webhook
// will stamp last_error and we'll surface it on the next dashboard
// load.
async function handleChargeAutopayDue(req, res) {
  // Vercel Cron invokes the path with GET (vercel.json "crons"); a manual
  // trigger may POST. Both need the same authorization.
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const authHeader = req.headers.authorization || "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  // Authorization (same model as plaid-sync-transactions / integrity-check):
  //   * Bearer CRON_SECRET (constant-time compare) -> every company;
  //   * otherwise a Supabase JWT whose user is an ACTIVE ADMIN of at least
  //     one company -> only that user's admin companies' schedules.
  // Any other signed-in user (a tenant, an owner-portal user, a manager) is
  // refused: this endpoint charges other people's cards.
  let companyFilter = null;
  if (!isCronSecretBearer(authHeader, CRON_SECRET)) {
    if (!provided) return res.status(401).json({ error: "unauthorized" });
    const { data: authData, error: authErr } = await sb.auth.getUser(provided);
    const user = authData?.user;
    if (authErr || !user) return res.status(401).json({ error: "unauthorized" });
    const { data: mems, error: memErr } = await sb.from("company_members")
      .select("company_id, role, status").ilike("user_email", String(user.email || "").replace(/[%_\\]/g, c => "\\" + c))
      .eq("status", "active");
    if (memErr) return res.status(500).json({ error: "membership lookup failed: " + memErr.message });
    companyFilter = autopayRunCompanyIds(mems);
    if (!user.email || companyFilter.length === 0) return res.status(403).json({ error: "only a company admin (or the cron) may run autopay charges" });
  }

  const today = new Date().toISOString().slice(0, 10);

  let dueQ = sb.from("autopay_schedules")
    .select("id, company_id, tenant_id, tenant, property, amount, day_of_month, next_charge_date, stripe_customer_id, stripe_payment_method_id, method")
    .eq("provider", "stripe").eq("enabled", true).is("archived_at", null)
    .lte("next_charge_date", today);
  if (companyFilter) dueQ = dueQ.in("company_id", companyFilter);
  const { data: due, error: dueErr } = await dueQ;
  if (dueErr) {
    console.error("[stripe charge-autopay-due] query failed:", dueErr.message);
    return res.status(500).json({ error: "query failed: " + dueErr.message });
  }

  const results = [];
  for (const row of (due || [])) {
    // Which billing period this charge is for: the month of the due date the
    // row carried when we read it. Same period -> same idempotency key.
    const claimedDate = String(row.next_charge_date || "").slice(0, 10);
    const period = billingPeriodOf(claimedDate);
    if (!period) { results.push({ autopay_id: row.id, skipped: "no next_charge_date" }); continue; }

    // Next date: the month AFTER the claimed period (not "a month from
    // today", which skipped a month whenever a charge ran late), on
    // day_of_month clamped to that month's last day.
    const nextDate = nextChargeDateAfterPeriod(period, row.day_of_month || 1);

    // CLAIM the period atomically before charging: move next_charge_date
    // forward only if it still holds the value we read. Two overlapping runs
    // both read the row, but only one UPDATE matches; the other skips it.
    const { data: claimed, error: claimErr } = await sb.from("autopay_schedules")
      .update({ next_charge_date: nextDate, last_charge_at: new Date().toISOString() })
      .eq("id", row.id).eq("next_charge_date", claimedDate)
      .eq("enabled", true).is("archived_at", null)
      .select("id");
    if (claimErr) { results.push({ autopay_id: row.id, error: "claim failed: " + claimErr.message }); continue; }
    if (!claimed || claimed.length === 0) { results.push({ autopay_id: row.id, skipped: "claimed by another run" }); continue; }

    try {
      // Fee by the PaymentMethod's actual type. Rows saved before the
      // save-payment-method fix say "stripe_card" even for a bank account;
      // read the type from Stripe and correct the row so it stays right.
      let method = row.method;
      try {
        const pm = await stripe.paymentMethods.retrieve(row.stripe_payment_method_id);
        const actual = autopayMethodFromPmType(pm?.type);
        if (pm?.type && actual !== method) {
          method = actual;
          await sb.from("autopay_schedules").update({ method: actual }).eq("id", row.id);
        }
      } catch (pmErr) {
        console.warn("[stripe charge-autopay-due] PM type lookup failed, using stored method:", pmErr.message);
      }
      const isAch = isAchAutopayMethod(method);
      const fees = isAch ? grossUpForAchFee(row.amount) : grossUpForCardFee(row.amount);
      const intent = await stripe.paymentIntents.create({
        amount: fees.totalCents,
        currency: "usd",
        customer: row.stripe_customer_id,
        payment_method: row.stripe_payment_method_id,
        confirm: true, off_session: true,
        description: `Autopay rent — ${row.tenant} — ${row.property || ""}`.slice(0, 250),
        metadata: {
          company_id: String(row.company_id),
          tenant_id: String(row.tenant_id),
          tenant_name: row.tenant || "",
          property: row.property || "",
          rent_cents: String(fees.rentCents),
          fee_cents: String(fees.feeCents),
          autopay_id: String(row.id),
          billing_period: period,
          // The claim this charge holds (claimed_date -> advanced_date), so an
          // ASYNC failure (ACH return, payment_intent.payment_failed) can give
          // the period back exactly as a synchronous decline does.
          claimed_date: claimedDate,
          advanced_date: nextDate,
          payment_method_kind: isAch ? "us_bank_account" : "card",
        },
      }, {
        // One charge per schedule per billing period, even if this request
        // is retried or a second run gets this far.
        idempotencyKey: autopayIdempotencyKey(row.id, period, today),
      });
      await sb.from("autopay_schedules").update({
        last_error: null, last_error_at: null,
      }).eq("id", row.id);
      results.push({ autopay_id: row.id, intent: intent.id, status: intent.status, period });
    } catch (e) {
      // Off-session failure (declined, requires_action, etc.). Release the
      // claim so the period is retried on the next run, as before, and stamp
      // last_error so the Autopay tab can surface it.
      await sb.from("autopay_schedules").update({
        next_charge_date: claimedDate,
        last_error: e.message?.slice(0, 500) || "unknown",
        last_error_at: new Date().toISOString(),
      }).eq("id", row.id).eq("next_charge_date", nextDate);
      results.push({ autopay_id: row.id, error: e.message, period });
    }
  }

  return res.status(200).json({ ran: results.length, results });
}

// ── Action: webhook ───────────────────────────────────────────────
async function handleWebhook(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET not configured" });

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("[stripe webhook] signature verification failed:", e.message);
    return res.status(400).json({ error: "signature verification failed" });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });

  // Idempotency: every PI succeeded webhook reuses the PI id as the JE
  // reference. If we've already POSTED a non-voided JE for this PI,
  // return 200 + idempotent. A voided JE means an admin reversed a
  // prior post and a Stripe resend should be allowed to write a fresh
  // one — filter status != 'voided' so the check matches only live
  // entries. The unique index on (company_id, reference) is partial
  // on the same predicate (see migration).
  if (event.type === "payment_intent.succeeded") {
    // company-scope-exempt: a webhook has no signed-in user and therefore
    // no current company. This is an idempotency check keyed on the Stripe
    // event id, which is globally unique -- scoping it by company would
    // require knowing the company before the lookup that determines it.
    const { data: existing } = await sb.from("acct_journal_entries")
      .select("id, status").eq("reference", "STRIPE-" + event.data.object.id)
      .neq("status", "voided").maybeSingle();
    if (existing) return res.status(200).json({ received: true, idempotent: true });
  }

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    const md = intent.metadata || {};
    const companyId = md.company_id;
    const tenantId = md.tenant_id;
    const rentCents = parseInt(md.rent_cents || "0", 10);
    const autopayId = md.autopay_id || null;
    if (!companyId || !tenantId) {
      console.error("[stripe webhook] payment_intent missing company_id/tenant_id metadata", intent.id);
      return res.status(200).json({ received: true, skipped: "missing metadata" });
    }
    if (!rentCents) {
      console.error("[stripe webhook] payment_intent missing rent_cents metadata", intent.id);
      return res.status(500).json({ error: "missing rent_cents metadata" });
    }

    // Resolve accounts.
    //   1. Credit: the tenant's OWN AR sub-account -- the receipt settles
    //      the rent the recurring engine billed there. Found / adopted /
    //      created under a per-tenant lock (stripe_tenant_ar). If the tenant
    //      EXISTS but its AR cannot be established, the webhook fails (500)
    //      and Stripe retries -- a receipt for a real tenant never lands in
    //      Rental Income. Only a tenant row that no longer exists at all
    //      falls back to Rental Income (pickRentReceiptCredit), so money
    //      already collected is still booked.
    //   2. Debit: "Stripe Receivable" (code 1015, Asset), auto-created --
    //      NOT Checking. Stripe holds funds 2-5 days before payout, so the
    //      money isn't in the bank yet. Reconciled against Checking when
    //      the Stripe payout deposit lands (matched in bank rec).
    const arLookup = await getOrCreateTenantArServer(sb, companyId, tenantId);
    if (arLookup.error) {
      console.error("[stripe webhook] tenant AR not established for tenant_id=" + tenantId + ":", arLookup.error);
      return res.status(500).json({ error: "tenant AR account could not be established — retry" });
    }
    const tenantAR = arLookup.account || null;
    const credit = pickRentReceiptCredit({ tenantAr: tenantAR, tenantId });
    let creditAccount = null;
    if (credit.kind === "tenant_ar") {
      creditAccount = { id: tenantAR.id, name: tenantAR.name };
    } else if (!arLookup.tenantMissing) {
      return res.status(500).json({ error: "tenant AR account could not be established — retry" });
    } else {
      console.error("[stripe webhook] tenant_id=" + tenantId + " does not exist in company " + companyId + "; crediting Rental Income");
      const { data: income } = await sb.from("acct_accounts").select("id, name").eq("company_id", companyId).eq("code", "4000").maybeSingle();
      if (!income?.id) return res.status(500).json({ error: "tenant has no AR account and Rental Income (4000) is missing" });
      creditAccount = income;
    }

    let stripeReceivable = null;
    {
      const { data } = await sb.from("acct_accounts")
        .select("id, name").eq("company_id", companyId).eq("code", "1015")
        .maybeSingle();
      stripeReceivable = data;
    }
    if (!stripeReceivable) {
      const ins = await sb.from("acct_accounts").insert({
        company_id: companyId, code: "1015", name: "Stripe Receivable",
        type: "Asset", is_active: true,
        old_text_id: companyId + "-1015",
      }).select("id, name").maybeSingle();
      if (ins.error || !ins.data) {
        console.error("[stripe webhook] couldn't create Stripe Receivable:", ins.error?.message);
        return res.status(500).json({ error: "couldn't create Stripe Receivable account" });
      }
      stripeReceivable = ins.data;
    }

    // The business's own calendar date, not UTC: an evening payment in
    // Eastern time is otherwise dated tomorrow (next month on the 31st).
    const today = localBusinessDate();
    const reference = "STRIPE-" + intent.id;
    const description = "Rent payment — " + (md.tenant_name || "tenant") + " — " + (md.property || "");
    const rentDollars = rentCents / 100;
    const classId = await resolvePropertyClassId(sb, companyId, md.property || "");

    const lines = [
      { account_id: stripeReceivable.id, account_name: stripeReceivable.name, debit: rentDollars, credit: 0, class_id: classId, memo: "Stripe charge " + intent.id.slice(0, 16) },
      { account_id: creditAccount.id, account_name: creditAccount.name, debit: 0, credit: rentDollars, class_id: classId, memo: credit.settlesAr ? "AR settlement" : "Rent received (no tenant AR account)" },
    ];
    // Numbered by the next_je_number RPC with collision retry, like every
    // other posting path. Refuses an unbalanced entry.
    const posted = await postJournalEntry(sb, {
      companyId, date: today, description, reference, property: md.property || "",
      lines, extra: { stripe_payment_intent_id: intent.id },
    });
    if (posted.idempotent) return res.status(200).json({ received: true, idempotent: true });
    if (posted.error) {
      console.error("[stripe webhook] JE post failed:", posted.error);
      return res.status(500).json({ error: posted.error });
    }
    const je = { id: posted.id };
    const tenantAROrNull = credit.settlesAr ? tenantAR : null;

    // payments table is the tenant-portal-side history. Amount is the
    // rent (what the tenant's AR was actually credited) — fee is between
    // tenant and Stripe and doesn't appear on our books. tenant_id is
    // what the tenant portal filters on; without it the payment was
    // invisible to the tenant.
    {
      const { error: payErr } = await sb.from("payments").insert({
        company_id: companyId,
        tenant: md.tenant_name || "",
        tenant_id: Number(tenantId) || null,
        property: md.property || "",
        amount: rentDollars,
        date: today,
        type: "rent",
        method: md.payment_method_kind === "us_bank_account" ? "ach" : "stripe",
        status: "paid",
        stripe_session_id: intent.id,
      });
      if (payErr) console.warn("[stripe webhook] payments table insert (non-fatal):", payErr.message);
    }

    // Resync tenants.balance from the AR sub-account's posted lines.
    // The dashboard "Balance Due" tile reads this column directly (a
    // denormalized cache); the Ledger tab computes from JE lines and
    // is always correct. If we don't update the cache here, the
    // tenant sees a stale balance after a Stripe payment until the
    // next manual edit on the staff side.
    if (tenantAROrNull) try {
      // PAGED. This writes tenants.balance, which the dashboard reads
      // directly as its Balance Due tile, and an unpaged select stops at
      // Supabase's 1000-row cap without any error. A long-running tenant
      // would have had a balance computed from the first thousand lines and
      // cached -- silently understating what they owe, on the one figure a
      // tenant is most likely to check.
      const arLines = [];
      for (let from = 0; ; from += 1000) {
        const { data: page, error: pageErr } = await sb.from("acct_journal_lines")
          .select("debit, credit, acct_journal_entries(status)")
          .eq("company_id", companyId).eq("account_id", tenantAROrNull.id)
          .order("id").range(from, from + 999);
        if (pageErr) throw pageErr;
        arLines.push(...(page || []));
        if (!page || page.length < 1000) break;
      }
      const newBalance = arLines
        .filter(l => l.acct_journal_entries?.status === "posted")
        .reduce((acc, l) => acc + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);
      await sb.from("tenants").update({ balance: newBalance }).eq("id", tenantId);
    } catch (e) {
      console.warn("[stripe webhook] balance recompute failed (non-fatal):", e.message);
    }

    // If this charge was triggered by the autopay cron, clear the
    // last_error stamp on the autopay row (the previous failure has
    // now been recovered). last_charge_at was already bumped at
    // schedule time but we re-stamp here to reflect actual success.
    if (autopayId) {
      await sb.from("autopay_schedules").update({
        last_charge_at: new Date().toISOString(),
        last_error: null, last_error_at: null,
      }).eq("id", autopayId);
    }

    // Email + push notifications. The worker drains notification_queue
    // on its cron tick (every few minutes); if you need instant email
    // delivery, the cron schedule controls latency. Push is dispatched
    // here directly via web-push so it lands the moment the JE posts.
    try {
      // Look up the tenant's email — metadata only carries name.
      const { data: tenantRow } = await sb.from("tenants")
        .select("email").eq("id", tenantId).maybeSingle();
      await notifyPaymentEvent(sb, "succeeded", {
        companyId, tenantName: md.tenant_name || "",
        tenantEmail: tenantRow?.email || null,
        property: md.property || "",
        amount: rentDollars, date: today,
      });
    } catch (e) {
      console.warn("[stripe webhook] notify failed (non-fatal):", e.message);
    }

    return res.status(200).json({ received: true, posted_je: je.id });
  }

  if (event.type === "payment_intent.payment_failed") {
    // Off-session failures (autopay cron). Stamp the autopay row so
    // the tenant + admin see "Visa ending 4242 was declined — please
    // update your card". On-session failures (tenant typing card)
    // are surfaced to the browser via Stripe Elements directly so we
    // skip the email/push for those (would be redundant).
    const intent = event.data.object;
    const md = intent.metadata || {};
    const autopayId = md.autopay_id;
    const lastError = intent.last_payment_error?.message || intent.last_payment_error?.code || "Card declined";
    if (autopayId) {
      await sb.from("autopay_schedules").update({
        last_error: String(lastError).slice(0, 500),
        last_error_at: new Date().toISOString(),
      }).eq("id", autopayId);

      // An ASYNC failure (an ACH debit returned days later) arrives here, not
      // in the cron's catch. Give the claimed period back so the next run
      // retries it -- the same release a synchronous decline gets --
      // conditionally, only where next_charge_date still holds the value the
      // claim advanced it to (a later run or an edit is never overwritten).
      const period = billingPeriodOf(md.billing_period);
      if (period) {
        let claimedDate = /^\d{4}-\d{2}-\d{2}$/.test(md.claimed_date || "") ? md.claimed_date : null;
        let advancedDate = /^\d{4}-\d{2}-\d{2}$/.test(md.advanced_date || "") ? md.advanced_date : null;
        if (!claimedDate || !advancedDate) {
          // Charges made before the claim was recorded in metadata: derive it
          // from the schedule's day of month.
          const { data: sched } = await sb.from("autopay_schedules").select("day_of_month").eq("id", autopayId).maybeSingle();
          const dom = sched?.day_of_month || 1;
          claimedDate = claimedDate || chargeDateInPeriod(period, dom);
          advancedDate = advancedDate || nextChargeDateAfterPeriod(period, dom);
        }
        if (claimedDate && advancedDate && claimedDate !== advancedDate) {
          const { error: relErr } = await sb.from("autopay_schedules")
            .update({ next_charge_date: claimedDate })
            .eq("id", autopayId).eq("next_charge_date", advancedDate);
          if (relErr) console.warn("[stripe webhook] claim release failed (non-fatal):", relErr.message);
        }
      }

      // Notify tenant + staff: card on file declined. Tenant needs to
      // update or autopay will keep failing on the next cron tick.
      try {
        const { data: tenantRow } = await sb.from("tenants")
          .select("email").eq("id", md.tenant_id).maybeSingle();
        const rentCents = parseInt(md.rent_cents || "0", 10);
        await notifyPaymentEvent(sb, "failed", {
          companyId: md.company_id, tenantName: md.tenant_name || "",
          tenantEmail: tenantRow?.email || null,
          property: md.property || "",
          amount: rentCents / 100,
          date: new Date().toISOString().slice(0, 10),
          error: lastError,
        });
      } catch (e) {
        console.warn("[stripe webhook] failure notify failed (non-fatal):", e.message);
      }
    }
    return res.status(200).json({ received: true, type: event.type, action: autopayId ? "autopay_failed" : "noop" });
  }

  if (event.type === "charge.refunded") {
    const charge = event.data.object;
    const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
    const original = await findStripePaymentEntry(sb, piId);
    if (!original) {
      // Ours but the succeeded post has not landed yet (events can arrive
      // out of order): 500 so Stripe retries. Not ours: nothing to do.
      if (await isOurPaymentIntent(piId)) return res.status(500).json({ error: "original payment not posted yet — retry" });
      return res.status(200).json({ received: true, type: event.type, action: "noop", reason: "no posted payment for " + piId });
    }
    // Refunds can come in several partial steps; amount_refunded is the
    // cumulative total. The RPC reverses only what is not already reversed
    // -- refunds AND disputes of this payment, under one lock -- and never
    // more than the rent that was booked.
    const status = charge.refunded ? "refunded" : "partially_refunded";
    const r = await postStripeReversal(sb, original, {
      piId, chargeId: charge.id, kind: "refund",
      amountCents: charge.amount_refunded,
      reference: refundReference(charge.id, charge.amount_refunded),
      description: reversalDescription("Stripe refund", original, piId),
      memo: "Refund of Stripe charge " + charge.id,
    });
    if (r.error) { console.error("[stripe webhook] refund reversal failed:", r.error); return res.status(500).json({ error: r.error }); }
    await setPaymentStatus(sb, original.company_id, piId, status);
    if (r.skipped) return res.status(200).json({ received: true, type: event.type, action: "already_reversed" });
    return res.status(200).json({ received: true, type: event.type, reversed_je: r.id || null, idempotent: !!r.idempotent });
  }

  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") {
    const dispute = event.data.object;
    let piId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
    if (!piId && dispute.charge) {
      try {
        const ch = await stripe.charges.retrieve(typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id);
        piId = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id;
      } catch (e) { console.warn("[stripe webhook] dispute charge lookup failed:", e.message); }
    }
    const original = await findStripePaymentEntry(sb, piId);
    if (!original) {
      if (await isOurPaymentIntent(piId)) return res.status(500).json({ error: "original payment not posted yet — retry" });
      return res.status(200).json({ received: true, type: event.type, action: "noop", reason: "no posted payment for " + piId });
    }
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : (dispute.charge?.id || null);
    // Capped inside the RPC at booked rent minus everything already reversed
    // for this payment (an earlier partial refund included).
    const reverse = () => postStripeReversal(sb, original, {
      piId, chargeId, kind: "dispute",
      amountCents: Number.isFinite(Number(dispute.amount)) && Number(dispute.amount) > 0 ? Math.round(Number(dispute.amount)) : null,
      reference: disputeReference(dispute.id),
      description: reversalDescription("Stripe dispute", original, piId),
      memo: "Disputed Stripe payment " + dispute.id,
      disputeId: dispute.id, disputeStatus: dispute.status || null,
    });
    if (event.type === "charge.dispute.created") {
      // Stripe withdraws the disputed funds when the dispute opens -- unless
      // this delivery is late and the dispute has already been won (the
      // event says so, or the RPC finds the durable 'won' marker the closed
      // event recorded).
      if (dispute.status === "won") {
        return res.status(200).json({ received: true, type: event.type, action: "noop", reason: "dispute already won" });
      }
      const r = await reverse();
      if (r.error) { console.error("[stripe webhook] dispute reversal failed:", r.error); return res.status(500).json({ error: r.error }); }
      if (r.skipped === "dispute_already_won") {
        return res.status(200).json({ received: true, type: event.type, action: "noop", reason: "dispute already won" });
      }
      await setPaymentStatus(sb, original.company_id, piId, "disputed");
      return res.status(200).json({ received: true, type: event.type, reversed_je: r.id || null, idempotent: !!r.idempotent });
    }
    // closed
    if (dispute.status === "lost") {
      // Make sure the reversal exists (idempotent if .created already ran;
      // a .created delivered later finds the reference and posts nothing).
      const r = await reverse();
      if (r.error) return res.status(500).json({ error: r.error });
      await setPaymentStatus(sb, original.company_id, piId, "dispute_lost");
      return res.status(200).json({ received: true, type: event.type, action: "dispute_lost", reversed_je: r.id || null });
    }
    if (dispute.status === "won") {
      // Funds returned: re-post the payment if it was reversed. The RPC
      // always records the durable 'won' marker -- even when there is nothing
      // to re-post yet because .created has not been delivered -- so a late
      // .created does not reverse a payment whose dispute was won.
      const r = await postStripeReversal(sb, original, {
        piId, chargeId, kind: "dispute_won", amountCents: null,
        reference: disputeWonReference(dispute.id),
        description: reversalDescription("Stripe dispute won", original, piId),
        memo: "Dispute won — " + dispute.id,
        disputeId: dispute.id, disputeStatus: "won",
      });
      if (r.error) return res.status(500).json({ error: r.error });
      await setPaymentStatus(sb, original.company_id, piId, "paid");
      return res.status(200).json({ received: true, type: event.type, action: "dispute_won", reposted_je: r.id || null });
    }
    return res.status(200).json({ received: true, type: event.type, action: "noop", status: dispute.status });
  }

  return res.status(200).json({ received: true, type: event.type, action: "noop" });
}

// ── Top-level dispatcher ──────────────────────────────────────────
module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query?.action || "").toString();
  if (action === "create-intent") return handleCreateIntent(req, res);
  if (action === "create-setup-intent") return handleCreateSetupIntent(req, res);
  if (action === "save-payment-method") return handleSavePaymentMethod(req, res);
  if (action === "disable-autopay") return handleDisableAutopay(req, res);
  if (action === "charge-autopay-due") return handleChargeAutopayDue(req, res);
  if (action === "webhook") return handleWebhook(req, res);
  return res.status(404).json({ error: "unknown action" });
};

// Exposed for tests (tests/payments-autopay-stripe.test.mjs), which drive the
// handlers with a mocked Stripe client and Supabase client.
module.exports._internals = { postJournalEntry, resolvePropertyClassId, getOrCreateTenantArServer, grossUpForCardFee, grossUpForAchFee };

module.exports.config = {
  api: { bodyParser: false },
};
