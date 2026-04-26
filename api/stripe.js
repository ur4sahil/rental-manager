// ════════════════════════════════════════════════════════════════════
// Stripe dispatcher — single Vercel function handling all Stripe-
// adjacent flows. We're at the Hobby-plan 12-function cap, so every
// new Stripe action (create-intent, webhook, save-customer in Phase 2,
// charge-saved-card in Phase 2, etc.) routes through here via ?action=.
//
// Phase 1 actions:
//   ?action=create-intent  — POST, JWT-authed. Creates a Stripe
//                            PaymentIntent for a tenant rent payment.
//                            Returns { client_secret, total_charge,
//                            convenience_fee } so the client-side
//                            Stripe Elements form can confirm the
//                            payment without holding the secret key.
//   ?action=webhook        — POST, signature-authed via Stripe's
//                            X-Stripe-Signature header. On
//                            payment_intent.succeeded posts a JE +
//                            payments-table row and notifies the
//                            tenant.
//
// Required env vars (Vercel production):
//   STRIPE_SECRET_KEY            — sk_test_… or sk_live_…
//   STRIPE_WEBHOOK_SECRET        — whsec_… (set after creating the
//                                  webhook endpoint in the Stripe
//                                  dashboard)
//   SUPABASE_URL +
//   SUPABASE_SERVICE_ROLE_KEY    — for the server-side post on
//                                  webhook success (no caller JWT
//                                  available there)
// ════════════════════════════════════════════════════════════════════
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

// Read the raw request body. Required for the webhook handler so we
// can verify Stripe's signature against the exact bytes they signed.
// The dispatcher disables Vercel's default body parser (see config at
// bottom of this file); both handlers route through this helper.
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

// Pin the API version that ships with stripe@22 (acacia release).
// If we don't pin, Stripe uses the version from your account's
// "default API version", which can drift unexpectedly.
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2025-09-30.clover" }) : null;

// Pass-through fee math — gross-up so the company nets the rent
// amount after Stripe's fee is taken on payout. Stripe's standard
// US rate is 2.9% + $0.30 per successful card charge.
//
//   total = (rent + 0.30) / (1 - 0.029)
//   convenience_fee = total - rent
//
// Returned in cents (Stripe API uses cents). The fee shown to the
// tenant is total - rent, displayed as a "Processing fee" line.
function grossUpForStripeFee(rentDollars) {
  const rentCents = Math.round(rentDollars * 100);
  // Solve for total such that total - 2.9%*total - 30¢ = rent
  const totalCents = Math.ceil((rentCents + 30) / 0.971);
  const feeCents = totalCents - rentCents;
  return { totalCents, feeCents, rentCents };
}

// ── Action: create-intent ─────────────────────────────────────────
async function handleCreateIntent(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return res.status(401).json({ error: "missing bearer token" });

  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "invalid token" });

  // bodyParser is disabled on this route (so the webhook handler can
  // read raw bytes) — read + parse the JSON ourselves.
  const raw = await readRawBody(req);
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch { return res.status(400).json({ error: "invalid JSON body" }); }
  const { amount, tenant_id, company_id } = body;
  if (!amount || amount <= 0) return res.status(400).json({ error: "amount required and > 0" });
  if (!tenant_id || !company_id) return res.status(400).json({ error: "tenant_id + company_id required" });

  // Authorize the caller — must be either the tenant themselves OR
  // an active member of the company. Tenants pay their own rent;
  // admins/managers may also create a charge on a tenant's behalf.
  const { data: tenant } = await sb.from("tenants").select("id, name, email, property, balance, company_id")
    .eq("id", tenant_id).eq("company_id", company_id).maybeSingle();
  if (!tenant) return res.status(404).json({ error: "tenant not found" });

  const callerEmail = (user.email || "").toLowerCase();
  const isTenant = (tenant.email || "").toLowerCase() === callerEmail;
  let isMember = false;
  if (!isTenant) {
    const { data: mem } = await sb.from("company_members").select("role, status")
      .eq("company_id", company_id).ilike("user_email", callerEmail).eq("status", "active").maybeSingle();
    isMember = !!mem;
  }
  if (!isTenant && !isMember) return res.status(403).json({ error: "not authorized for this tenant" });

  const { totalCents, feeCents, rentCents } = grossUpForStripeFee(amount);

  // Create the PaymentIntent. metadata.* is what the webhook reads to
  // post the JE — keep all fields the post handler needs.
  try {
    const intent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: "usd",
      automatic_payment_methods: { enabled: true },
      description: `Rent — ${tenant.name} — ${tenant.property || ""}`.slice(0, 250),
      metadata: {
        company_id: String(company_id),
        tenant_id: String(tenant_id),
        tenant_name: tenant.name || "",
        property: tenant.property || "",
        rent_cents: String(rentCents),
        fee_cents: String(feeCents),
      },
    });
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

// ── Action: webhook ───────────────────────────────────────────────
// Stripe POSTs here on payment_intent.succeeded / .payment_failed /
// charge.refunded etc. We validate the signature, then on success
// post the JE that the Payments tab will render.
async function handleWebhook(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!stripe) return res.status(500).json({ error: "STRIPE_SECRET_KEY not configured" });
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).json({ error: "STRIPE_WEBHOOK_SECRET not configured" });

  // Stripe sends the raw body — we need the raw bytes for signature
  // verification, NOT the JSON-parsed body. Vercel by default parses
  // JSON; the workaround is reading req.rawBody (Vercel exposes it
  // when the runtime is Node.js with bodyParser disabled). We fall
  // back to JSON.stringify(req.body) if rawBody isn't available, but
  // the signature will fail in that case — log and 400.
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

  // Idempotency: every webhook event has a unique id; if we've seen
  // it before, return 200 without processing again.
  const { data: existing } = await sb.from("acct_journal_entries")
    .select("id").eq("reference", "STRIPE-" + event.data.object.id).maybeSingle();
  if (existing && event.type === "payment_intent.succeeded") {
    return res.status(200).json({ received: true, idempotent: true });
  }

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    const md = intent.metadata || {};
    const companyId = md.company_id;
    const tenantId = md.tenant_id;
    const rentCents = parseInt(md.rent_cents || "0", 10);
    const feeCents = parseInt(md.fee_cents || "0", 10);
    const totalCents = intent.amount;
    if (!companyId || !tenantId) {
      console.error("[stripe webhook] payment_intent missing company_id/tenant_id metadata", intent.id);
      return res.status(200).json({ received: true, skipped: "missing metadata" });
    }

    // Resolve account IDs (Checking / Tenant AR / Stripe Pass-Through)
    const { data: accounts } = await sb.from("acct_accounts")
      .select("id, code, name, tenant_id, type")
      .eq("company_id", companyId);
    const checking = (accounts || []).find(a => a.code === "1000" || a.name === "Checking");
    // Per-tenant AR sub-account if present, else bare AR
    const tenantAR = (accounts || []).find(a => String(a.tenant_id) === String(tenantId))
      || (accounts || []).find(a => a.code === "1100" || a.name === "Accounts Receivable");
    // Pass-through fee account — create on first use
    let passThru = (accounts || []).find(a => a.name === "Stripe Pass-Through Income");
    if (!passThru && feeCents > 0) {
      const ins = await sb.from("acct_accounts").insert({
        company_id: companyId, code: "4900", name: "Stripe Pass-Through Income",
        type: "Revenue", subtype: "Other Income", is_active: true,
      }).select("id").single();
      passThru = ins.data;
    }
    if (!checking || !tenantAR) {
      console.error("[stripe webhook] missing core accounts", { hasChecking: !!checking, hasAR: !!tenantAR });
      return res.status(200).json({ received: true, skipped: "missing accounts" });
    }

    // Post the JE: DR Checking total, CR Tenant AR rent, CR Pass-Through fee
    const today = new Date().toISOString().slice(0, 10);
    const reference = "STRIPE-" + intent.id;
    const description = "Rent payment — " + (md.tenant_name || "tenant") + " — " + (md.property || "");

    // Use the highest existing JE number + 1 (matches autoPostJournalEntry)
    const { data: lastJE } = await sb.from("acct_journal_entries")
      .select("number").eq("company_id", companyId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const lastNum = lastJE?.number ? parseInt(lastJE.number.replace(/\D/g, "")) || 0 : 0;
    const jeNumber = "JE-" + String(lastNum + 1).padStart(4, "0");

    const { data: je, error: jeErr } = await sb.from("acct_journal_entries").insert({
      company_id: companyId,
      number: jeNumber,
      date: today,
      description: description.slice(0, 500),
      reference,
      stripe_payment_intent_id: intent.id,
      property: md.property || "",
      status: "posted",
    }).select("id").single();
    if (jeErr) {
      console.error("[stripe webhook] JE insert failed:", jeErr.message);
      return res.status(500).json({ error: "JE insert failed: " + jeErr.message });
    }

    const lines = [
      { company_id: companyId, journal_entry_id: je.id, account_id: checking.id, account_name: checking.name, debit: totalCents / 100, credit: 0, memo: "Stripe charge " + intent.id.slice(0, 12) },
      { company_id: companyId, journal_entry_id: je.id, account_id: tenantAR.id, account_name: tenantAR.name, debit: 0, credit: rentCents / 100, memo: "AR settlement" },
    ];
    if (feeCents > 0 && passThru) {
      lines.push({ company_id: companyId, journal_entry_id: je.id, account_id: passThru.id, account_name: passThru.name, debit: 0, credit: feeCents / 100, memo: "Stripe processing fee (pass-through)" });
    }
    const { error: linesErr } = await sb.from("acct_journal_lines").insert(lines);
    if (linesErr) {
      console.error("[stripe webhook] JE lines insert failed:", linesErr.message);
      // Void the orphan header so the GL stays clean
      await sb.from("acct_journal_entries").update({ status: "voided", description: "[ORPHANED — lines failed] " + description }).eq("id", je.id);
      return res.status(500).json({ error: "JE lines insert failed" });
    }

    // Also drop a row in payments table so the Tenant Portal History
    // and any external integrations see it. The Payments tab itself
    // reads from acct_journal_entries (above), so this is for
    // tenant-side visibility.
    await sb.from("payments").insert({
      company_id: companyId,
      tenant: md.tenant_name || "",
      property: md.property || "",
      amount: rentCents / 100,
      date: today,
      type: "rent",
      method: "stripe",
      status: "paid",
      stripe_session_id: intent.id, // legacy column name kept for back-compat
    }).then(() => {}).catch((e) => console.warn("[stripe webhook] payments table insert (non-fatal):", e.message));

    return res.status(200).json({ received: true, posted_je: je.id });
  }

  // Other events (failed / refunded / etc) — ack but don't act yet.
  // Phase 1 is success-path only; failures and refunds get handled
  // in Phase 2 along with autopay.
  return res.status(200).json({ received: true, type: event.type, action: "noop" });
}

// ── Top-level dispatcher ──────────────────────────────────────────
module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = (req.query?.action || "").toString();
  if (action === "create-intent") return handleCreateIntent(req, res);
  if (action === "webhook") return handleWebhook(req, res);
  return res.status(404).json({ error: "unknown action — try ?action=create-intent or ?action=webhook" });
};

// Webhook needs the raw body — disable Next.js / Vercel's default JSON
// parser so we can read req.body as a string for signature verification.
module.exports.config = {
  api: { bodyParser: false },
};
