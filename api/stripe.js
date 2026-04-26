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
//   ?action=charge-autopay-due    Phase 2. POST, CRON_SECRET-authed.
//                                 Charges every autopay row whose
//                                 next_charge_date <= today.
//   ?action=webhook               Stripe → us. Verifies signature,
//                                 posts JE on payment_intent.succeeded,
//                                 stamps last_error on
//                                 payment_intent.payment_failed.
//
// Required env vars (Vercel production):
//   STRIPE_SECRET_KEY            — sk_test_… or sk_live_…
//   STRIPE_WEBHOOK_SECRET        — whsec_… (signing secret of the
//                                  endpoint configured in Stripe)
//   SUPABASE_URL +
//   SUPABASE_SERVICE_ROLE_KEY    — for the server-side post on
//                                  webhook success (no caller JWT
//                                  available there)
//   CRON_SECRET                  — bearer for charge-autopay-due
// ════════════════════════════════════════════════════════════════════
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const webpush = require("web-push");

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
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@housify.app";
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
  // 1. Resolve recipient set: tenant email + every active staff.
  const { data: staff } = await sb.from("company_members")
    .select("user_email").eq("company_id", companyId)
    .eq("status", "active").neq("role", "tenant");
  const recipients = new Set();
  if (tenantEmail) recipients.add(tenantEmail.toLowerCase());
  for (const s of (staff || [])) {
    if (s.user_email) recipients.add(s.user_email.toLowerCase());
  }
  if (recipients.size === 0) return;

  // 2. Queue email rows. The worker template "payment_received"
  //    interpolates {{tenant}}, {{amount}}, {{date}}, {{property}}.
  const dataPayload = {
    tenant: tenantName, property,
    amount: typeof amount === "number" ? "$" + amount.toFixed(2) : String(amount || ""),
    date,
  };
  if (kind === "failed") {
    dataPayload.error = ctx.error || "Card declined";
  }
  const emailType = kind === "succeeded" ? "payment_received" : "payment_failed";
  const queueRows = Array.from(recipients).map(email => ({
    company_id: companyId, type: emailType,
    recipient_email: email,
    data: JSON.stringify(dataPayload),
    status: "pending",
  }));
  const { error: qErr } = await sb.from("notification_queue").insert(queueRows);
  if (qErr) console.warn("[stripe notify] notification_queue insert:", qErr.message);

  // Fire-and-forget: trigger the worker so the email goes out within
  // seconds instead of waiting for the next cron tick. CRON_SECRET
  // is the bearer the worker accepts for this path. The worker is
  // idempotent — the email send loop drains all pending rows then
  // returns, so concurrent triggers don't double-send.
  if (CRON_SECRET) {
    const host = (process.env.VERCEL_URL || "rental-manager-one.vercel.app").replace(/^https?:\/\//, "");
    fetch("https://" + host + "/api/notifications?action=worker", {
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
  const url = kind === "succeeded" ? "/#tenant_ledger" : "/#tenant_autopay";
  const payload = JSON.stringify({ title, body, url });

  for (const email of recipients) {
    const { data: subs } = await sb.from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("company_id", companyId).eq("user_email", email);
    for (const sub of (subs || [])) {
      const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
      try {
        await webpush.sendNotification(subscription, payload, { TTL: 60 * 60 * 24 });
      } catch (e) {
        // 410/404 = subscription is dead, prune it so we don't keep retrying.
        if (e.statusCode === 410 || e.statusCode === 404) {
          await sb.from("push_subscriptions").delete().eq("id", sub.id);
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
      method: "stripe_card",
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
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const authHeader = req.headers.authorization || "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  // Accept either CRON_SECRET (Vercel cron) or a Supabase user JWT
  // (manual admin trigger). Cron path is preferred in prod.
  let authed = false;
  if (CRON_SECRET && provided === CRON_SECRET) authed = true;
  if (!authed) {
    const sb0 = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
    const { data: { user } } = await sb0.auth.getUser(provided);
    if (user) authed = true;
  }
  if (!authed) return res.status(401).json({ error: "unauthorized" });

  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  const today = new Date().toISOString().slice(0, 10);

  const { data: due, error: dueErr } = await sb.from("autopay_schedules")
    .select("id, company_id, tenant_id, tenant, property, amount, day_of_month, stripe_customer_id, stripe_payment_method_id, method")
    .eq("provider", "stripe").eq("enabled", true).is("archived_at", null)
    .lte("next_charge_date", today);
  if (dueErr) {
    console.error("[stripe charge-autopay-due] query failed:", dueErr.message);
    return res.status(500).json({ error: "query failed: " + dueErr.message });
  }

  const results = [];
  for (const row of (due || [])) {
    const isAch = row.method === "stripe_us_bank_account";
    const fees = isAch ? grossUpForAchFee(row.amount) : grossUpForCardFee(row.amount);
    try {
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
          payment_method_kind: isAch ? "us_bank_account" : "card",
        },
      });
      // Bump next_charge_date forward one month (clamped to day_of_month).
      const next = new Date();
      next.setMonth(next.getMonth() + 1);
      next.setDate(Math.min(row.day_of_month || 1, 28));
      await sb.from("autopay_schedules").update({
        next_charge_date: next.toISOString().slice(0, 10),
        last_charge_at: new Date().toISOString(),
        last_error: null, last_error_at: null,
      }).eq("id", row.id);
      results.push({ autopay_id: row.id, intent: intent.id, status: intent.status });
    } catch (e) {
      // Off-session failure (declined, requires_action, etc.) — stamp
      // last_error so the Autopay tab can surface it.
      await sb.from("autopay_schedules").update({
        last_error: e.message?.slice(0, 500) || "unknown",
        last_error_at: new Date().toISOString(),
      }).eq("id", row.id);
      results.push({ autopay_id: row.id, error: e.message });
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

    // Resolve accounts. Two strict requirements + one auto-create:
    //   1. Tenant's per-tenant AR sub-account MUST exist (created at
    //      tenant creation time by the property wizard). NO bare-AR
    //      fallback — falling through silently aggregates per-lease
    //      AR into a single consolidated account and breaks tenant
    //      ledger views. Legacy "AR - <name>" rows (from before the
    //      tenant_id migration) get adopted by populating tenant_id.
    //   2. "Stripe Receivable" GL account (code 1015, Asset) MUST
    //      exist or be auto-created — this is the DR side of the
    //      charge, NOT Checking. Stripe holds funds 2-5 days before
    //      payout, so the money isn't in the bank yet. Reconciled
    //      against Checking when the Stripe payout deposit lands
    //      (matched in Teller bank rec).
    let tenantAR = null;
    {
      const { data } = await sb.from("acct_accounts")
        .select("id, name, tenant_id").eq("company_id", companyId)
        .eq("tenant_id", tenantId).eq("type", "Asset")
        .maybeSingle();
      tenantAR = data;
    }
    if (!tenantAR && md.tenant_name) {
      // Legacy adopt: a name-only AR row exists for this tenant but
      // tenant_id was never populated. Adopt only if exactly one
      // active tenant at this company shares the name (otherwise
      // we'd link an unrelated lease's AR).
      const { data: byName } = await sb.from("acct_accounts")
        .select("id, name, tenant_id").eq("company_id", companyId)
        .eq("type", "Asset").eq("name", "AR - " + md.tenant_name)
        .maybeSingle();
      if (byName?.id) {
        const { data: sameName } = await sb.from("tenants")
          .select("id").eq("company_id", companyId).eq("name", md.tenant_name)
          .is("archived_at", null);
        if ((sameName || []).length <= 1 && !byName.tenant_id) {
          await sb.from("acct_accounts").update({ tenant_id: tenantId }).eq("id", byName.id);
          tenantAR = { ...byName, tenant_id: tenantId };
        } else if (byName.tenant_id && String(byName.tenant_id) === String(tenantId)) {
          tenantAR = byName;
        }
      }
    }
    if (!tenantAR) {
      console.error("[stripe webhook] no per-tenant AR for tenant_id=" + tenantId + " name=" + md.tenant_name + " (company=" + companyId + ")");
      return res.status(500).json({ error: "tenant has no AR sub-account — fix tenant data integrity (the wizard normally creates this on tenant creation)" });
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

    const today = new Date().toISOString().slice(0, 10);
    const reference = "STRIPE-" + intent.id;
    const description = "Rent payment — " + (md.tenant_name || "tenant") + " — " + (md.property || "");
    const rentDollars = rentCents / 100;

    // Build the lines + assert the JE balances BEFORE inserting the
    // header. A balance mismatch here means a code bug; refuse to
    // post and 500. Stripe will retry, giving us a chance to see the
    // failure in webhook logs instead of producing half-entries.
    const lines = [
      { company_id: companyId, account_id: stripeReceivable.id, account_name: stripeReceivable.name, debit: rentDollars, credit: 0, memo: "Stripe charge " + intent.id.slice(0, 16) },
      { company_id: companyId, account_id: tenantAR.id, account_name: tenantAR.name, debit: 0, credit: rentDollars, memo: "AR settlement" },
    ];
    const sumDebit = lines.reduce((a, l) => a + l.debit, 0);
    const sumCredit = lines.reduce((a, l) => a + l.credit, 0);
    if (Math.abs(sumDebit - sumCredit) > 0.005) {
      console.error("[stripe webhook] balance check failed", { sumDebit, sumCredit, lines });
      return res.status(500).json({ error: "JE would be unbalanced — refused to post" });
    }

    // Sequential JE number with retry on collision (created_at ties
    // make order-by-created_at non-deterministic; bump attempt on
    // unique-violation). Mirrors src/utils/accounting.js.
    let je = null, jeErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: lastJE } = await sb.from("acct_journal_entries")
        .select("number").eq("company_id", companyId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const lastNum = lastJE?.number ? parseInt(lastJE.number.replace(/\D/g, "")) || 0 : 0;
      const jeNumber = "JE-" + String(lastNum + 1 + attempt).padStart(4, "0");
      const ins = await sb.from("acct_journal_entries").insert({
        company_id: companyId, number: jeNumber, date: today,
        description: description.slice(0, 500), reference,
        stripe_payment_intent_id: intent.id, property: md.property || "",
        status: "posted",
      }).select("id").maybeSingle();
      je = ins.data; jeErr = ins.error;
      if (!jeErr && je) break;
      const msg = (jeErr?.message || "") + " " + (jeErr?.details || "");
      if (/\b(reference)\b|idx_je_company_reference_unique/i.test(msg)) {
        return res.status(200).json({ received: true, idempotent: true });
      }
      if (!/\b(number)\b|acct_journal_entries_number/i.test(msg)) break;
    }
    if (jeErr || !je) {
      console.error("[stripe webhook] JE insert failed:", jeErr?.message);
      return res.status(500).json({ error: "JE insert failed: " + (jeErr?.message || "unknown") });
    }

    const linesWithJE = lines.map(l => ({ ...l, journal_entry_id: je.id }));
    const { error: linesErr } = await sb.from("acct_journal_lines").insert(linesWithJE);
    if (linesErr) {
      console.error("[stripe webhook] JE lines insert failed:", linesErr.message);
      await sb.from("acct_journal_entries").update({ status: "voided", description: "[ORPHANED — lines failed] " + description }).eq("id", je.id);
      return res.status(500).json({ error: "JE lines insert failed" });
    }

    // payments table is the tenant-portal-side history. Amount is the
    // rent (what Sheeba's AR was actually credited) — fee is between
    // tenant and Stripe and doesn't appear on our books.
    await sb.from("payments").insert({
      company_id: companyId,
      tenant: md.tenant_name || "",
      property: md.property || "",
      amount: rentDollars,
      date: today,
      type: "rent",
      method: md.payment_method_kind === "us_bank_account" ? "ach" : "stripe",
      status: "paid",
      stripe_session_id: intent.id,
    }).then(() => {}).catch((e) => console.warn("[stripe webhook] payments table insert (non-fatal):", e.message));

    // Resync tenants.balance from the AR sub-account's posted lines.
    // The dashboard "Balance Due" tile reads this column directly (a
    // denormalized cache); the Ledger tab computes from JE lines and
    // is always correct. If we don't update the cache here, the
    // tenant sees a stale balance after a Stripe payment until the
    // next manual edit on the staff side.
    try {
      const { data: arLines } = await sb.from("acct_journal_lines")
        .select("debit, credit, acct_journal_entries(status)")
        .eq("company_id", companyId).eq("account_id", tenantAR.id);
      const newBalance = (arLines || [])
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

module.exports.config = {
  api: { bodyParser: false },
};
