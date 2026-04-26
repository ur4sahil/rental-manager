// Vercel API Route: drains notification_queue and delivers emails
// via Resend. Runs every 5 minutes via the cron schedule defined in
// vercel.json. Until this file existed, queueNotification calls
// across the app were quietly piling up rows in notification_queue
// with no delivery — push went out tonight (via /api/send-push)
// but email had no worker.
//
// Auth: Bearer CRON_SECRET. Manual invocation by an admin works
// the same way (curl with the cron secret) for force-drains.
//
// Strategy:
//   - Pull the next BATCH_SIZE rows where status='pending'
//   - For each row, render the template registered for that
//     notification type (defaults below; companies can override
//     via notification_settings.template per event_type)
//   - Send via Resend; on success mark 'sent' + processed_at; on
//     failure mark 'failed' + error_message (capped to keep the
//     log compact). Failed rows are NOT retried automatically;
//     a small TTL sweep here catches anything stuck >24h.
//
// Required env vars on Vercel:
//   RESEND_API_KEY     — from resend.com (free tier: 3K/mo)
//   EMAIL_FROM         — verified sender, e.g. "Housify <notifications@sigmahousingllc.com>"
//   APP_URL            — used in template links (defaults to prod)
//   CRON_SECRET        — same secret used by other cron routes
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

const { Resend } = require("resend");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { isCronSecretBearer, cronSecretMatches } = require("./_auth");

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "";
const APP_URL = process.env.APP_URL || "https://rental-manager-one.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BATCH_SIZE = 50;
const MAX_ERROR_MSG_LEN = 500;

// Default templates per notification type. Subject + plain-text body
// (Resend will auto-generate the HTML representation). Variables in
// {{double-curlies}} are substituted from the row's `data` JSON,
// plus a few injected from the company / app context.
//
// To override per company, set notification_settings.template for
// that (company_id, event_type) row — that takes precedence.
const DEFAULTS = {
  rent_due: {
    subject: "Rent due reminder — {{property}}",
    body:
`Hi {{tenant}},

This is a reminder that your rent of {{amount}} for {{property}} is due on {{due_date}}.

You can pay through your tenant portal: {{app_url}}/#tenant_portal

— {{company_name}}`,
  },
  rent_overdue: {
    subject: "Rent past due — {{property}}",
    body:
`Hi {{tenant}},

Your rent for {{property}} is past due. Current balance: {{balance}}.

Please pay as soon as possible to avoid late fees: {{app_url}}/#tenant_portal

— {{company_name}}`,
  },
  // Sent to the TENANT after their payment lands. "Thank you" framing.
  payment_received: {
    subject: "Payment received — {{amount}}",
    body:
`Hi {{tenant}},

We received your payment of {{amount}} on {{date}}. Thank you.

— {{company_name}}`,
  },
  // Sent to STAFF (admins, managers, accountants) when a tenant pays.
  // Same trigger as payment_received but different copy — admins want
  // the tenant + property + amount as a heads-up, not a thank-you note
  // addressed to them. Without this split, "Hi Anish Gupta…" lands in
  // every staff inbox.
  payment_received_admin: {
    subject: "Payment received — {{amount}} from {{tenant}}",
    body:
`{{tenant}} paid {{amount}} on {{date}} for {{property}}.

View in Housify: {{app_url}}/#payments

— {{company_name}}`,
  },
  // Off-session autopay decline. Triggered from the Stripe webhook on
  // payment_intent.payment_failed when metadata.autopay_id is set.
  // On-session declines surface in Stripe Elements directly and don't
  // queue an email (would be redundant for the tenant who's looking
  // at the failure on screen).
  payment_failed: {
    subject: "Autopay payment failed — {{property}}",
    body:
`Hi {{tenant}},

Your scheduled rent payment of {{amount}} on {{date}} could not be processed: {{error}}.

Please update your card on file in your tenant portal so the next charge can run successfully: {{app_url}}/#tenant_autopay

— {{company_name}}`,
  },
  payment_failed_admin: {
    subject: "Autopay failed — {{tenant}}",
    body:
`Autopay charge for {{tenant}} failed on {{date}}: {{error}}.

Amount attempted: {{amount}}
Property: {{property}}

The tenant has been emailed to update their card. View in Housify: {{app_url}}/#payments

— {{company_name}}`,
  },
  late_fee_applied: {
    subject: "Late fee applied — {{property}}",
    body:
`Hi {{tenant}},

A late fee of {{fee_amount}} was applied to your account on {{date}}. Updated balance: {{balance}}.

— {{company_name}}`,
  },
  lease_created: {
    subject: "Your lease is ready to sign — {{property}}",
    body:
`Hi {{tenant}},

Your lease for {{property}} is ready. You'll receive a separate email with a signing link shortly.

— {{company_name}}`,
  },
  lease_expiring: {
    subject: "Lease expiring soon — {{property}}",
    body:
`Hi {{tenant}},

Your lease for {{property}} expires on {{end_date}} ({{days_left}} days). Please contact us to discuss renewal.

— {{company_name}}`,
  },
  lease_expiry: {
    subject: "Lease expiring soon — {{property}}",
    body:
`Hi {{tenant}},

Your lease for {{property}} expires on {{end_date}}. Please contact us to discuss renewal.

— {{company_name}}`,
  },
  message_received: {
    subject: "New message from {{sender}}",
    body:
`{{sender}} sent you a message:

{{preview}}

Reply at {{app_url}}/#messages

— {{company_name}}`,
  },
  work_order_created: {
    subject: "Maintenance request received — {{property}}",
    body:
`Hi {{tenant}},

We received your maintenance request: {{title}}.

We'll follow up shortly with a schedule.

— {{company_name}}`,
  },
  work_order_completed: {
    subject: "Maintenance completed — {{property}}",
    body:
`Hi {{tenant}},

Your maintenance request "{{title}}" has been marked complete on {{date}}.

If anything's still wrong, reply to this email or open a new request.

— {{company_name}}`,
  },
  work_order_update: {
    subject: "Maintenance update — {{property}}",
    body:
`Hi {{tenant}},

Status update on "{{title}}": {{status}}.

— {{company_name}}`,
  },
  deposit_returned: {
    subject: "Security deposit settlement — {{property}}",
    body:
`Hi {{tenant}},

Your security deposit settlement details:
  Returned to you: {{returned}}
  Deductions: {{deducted}}

— {{company_name}}`,
  },
  move_in: {
    subject: "Welcome to {{property}}!",
    body:
`Hi {{tenant}},

Welcome to {{property}}, official as of {{move_in_date}}.

Your tenant portal: {{app_url}}/#tenant_portal

— {{company_name}}`,
  },
  move_out: {
    subject: "Move-out completed — {{property}}",
    body:
`Hi {{tenant}},

Your move-out from {{property}} on {{moveOutDate}} has been processed. You'll receive a separate notice once your security deposit settlement is finalized.

— {{company_name}}`,
  },
  approval_pending: {
    subject: "Approval needed — {{summary}}",
    body:
`A request from your team needs your review.

Open the dashboard: {{app_url}}/#tasks

— {{company_name}}`,
  },
  approval_request: {
    subject: "Approval needed — {{summary}}",
    body:
`A request needs your review: {{app_url}}/#tasks

— {{company_name}}`,
  },
  owner_statement: {
    subject: "Owner statement available — {{period}}",
    body:
`Your owner statement for {{period}} is available.

View it in your owner portal: {{app_url}}/#owner_portal

— {{company_name}}`,
  },
  signed_doc_copy: {
    subject: "Your signed copy: {{doc_name}}",
    body:
`Hi {{signer_name}},

Your signed copy of {{doc_name}} is ready.

Hash on file (SHA-256): {{signed_pdf_hash}}

A short-lived download link will follow shortly. If you misplaced it, contact {{company_name}} for another copy.

— {{company_name}}`,
  },
  document_uploaded: {
    subject: "New document uploaded",
    body:
`A new document has been added to your account: {{name}}.

— {{company_name}}`,
  },
  invoice_approved: {
    subject: "Invoice approved",
    body:
`Invoice {{invoice_number}} has been approved.

— {{company_name}}`,
  },
  invoice_rejected: {
    subject: "Invoice rejected",
    body:
`Invoice {{invoice_number}} was rejected: {{reason}}.

— {{company_name}}`,
  },
  insurance_expiring: {
    subject: "Vendor insurance expiring — {{vendor}}",
    body:
`The COI on file for {{vendor}} expires on {{expiry_date}}. Please request a current certificate before scheduling new work.

— {{company_name}}`,
  },
  inspection_due: {
    subject: "Inspection due — {{property}}",
    body:
`Inspection scheduled for {{property}} on {{date}}.

— {{company_name}}`,
  },
  error_reported: {
    subject: "Error in your account — {{code}}",
    body:
`An error was logged in your account ({{code}}: {{message}}). The development team has been notified.

— {{company_name}}`,
  },
};

function render(template, data) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = data[k];
    if (v == null) return "";
    return String(v);
  });
}

function safe(str, max) {
  const s = String(str || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" }); return;
  }

  const authHeader = req.headers.authorization || "";
  const bodySecret = (req.body && typeof req.body === "object" && req.body.cron_secret) || "";
  const isCronAuth = CRON_SECRET && CRON_SECRET.length >= 8 && (
    isCronSecretBearer(authHeader, CRON_SECRET) || cronSecretMatches(bodySecret, CRON_SECRET)
  );

  if (!RESEND_API_KEY || !EMAIL_FROM) {
    res.status(500).json({ error: "RESEND_API_KEY or EMAIL_FROM not configured" });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SVC) {
    res.status(500).json({ error: "Supabase env not configured" });
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });

  // Allow any authenticated user as an alternative to CRON_SECRET. The
  // worker is idempotent (2nd call drains 0 rows), so an in-app trigger
  // posting from queueNotification() is safe — there's no abuse vector
  // beyond what an authenticated user can already do by inserting rows.
  // Cron-style external invocation still uses the bearer secret.
  let isUserAuth = false;
  if (!isCronAuth && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (!authErr && user?.id) isUserAuth = true;
  }
  if (!isCronAuth && !isUserAuth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const resend = new Resend(RESEND_API_KEY);

  // Pull pending rows oldest-first.
  const { data: pending, error: pendErr } = await sb.from("notification_queue")
    .select("id, company_id, type, recipient_email, data, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (pendErr) { res.status(500).json({ error: "queue read failed: " + pendErr.message }); return; }
  if (!pending || pending.length === 0) {
    res.status(200).json({ ok: true, attempted: 0, sent: 0, failed: 0 });
    return;
  }

  // Per-company name cache so we don't re-fetch company on every row.
  const companyCache = new Map();
  async function companyFor(id) {
    if (companyCache.has(id)) return companyCache.get(id);
    const { data } = await sb.from("companies").select("name").eq("id", id).maybeSingle();
    const name = data?.name || "Property Manager";
    companyCache.set(id, name);
    return name;
  }
  // Per-(company,type) template cache for company-specific overrides.
  const templateCache = new Map();
  async function templateFor(companyId, type) {
    const key = companyId + "::" + type;
    if (templateCache.has(key)) return templateCache.get(key);
    const { data } = await sb.from("notification_settings")
      .select("template, enabled")
      .eq("company_id", companyId).eq("event_type", type).maybeSingle();
    let tmpl = DEFAULTS[type] || { subject: type, body: "{{json}}" };
    // Custom template stored as plain text — used as the BODY only;
    // we keep the default subject. (notification_settings has no
    // separate subject column today.)
    if (data?.template) tmpl = { subject: tmpl.subject, body: data.template };
    const enabled = data ? data.enabled !== false : true;
    const result = { ...tmpl, enabled };
    templateCache.set(key, result);
    return result;
  }

  let sent = 0, failed = 0, skipped = 0;
  const errors = [];

  // Resend's free tier caps outbound at 5 requests/sec. When a tenant
  // messages all 5 staff (or a payment fans out to 6 recipients), the
  // worker fires them in tight succession and Resend rejects most with
  // "Too many requests". Stagger with a small gap so we stay under
  // 5/sec — 220ms gives ~4.5/sec, comfortable buffer. We also retry
  // a 429 once after a 1.2s backoff (cheap insurance against bursts).
  const MIN_GAP_MS = 220;
  let lastSendAt = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function paceForResend() {
    const since = Date.now() - lastSendAt;
    if (since < MIN_GAP_MS) await sleep(MIN_GAP_MS - since);
    lastSendAt = Date.now();
  }

  for (const row of pending) {
    const data = (() => {
      if (typeof row.data === "string") { try { return JSON.parse(row.data); } catch (_e) { return {}; } }
      return row.data || {};
    })();
    const companyName = await companyFor(row.company_id);
    const tmpl = await templateFor(row.company_id, row.type);

    if (!tmpl.enabled) {
      // Per-company kill-switch — mark as skipped, not failed, so we
      // don't keep retrying.
      await sb.from("notification_queue").update({
        status: "skipped",
        processed_at: new Date().toISOString(),
        error_message: "type disabled in notification_settings",
      }).eq("id", row.id);
      skipped++;
      continue;
    }

    const renderData = {
      ...data,
      company_name: companyName,
      app_url: APP_URL,
      json: JSON.stringify(data, null, 2),
    };
    const subject = render(tmpl.subject, renderData) || `[${row.type}]`;
    const body = render(tmpl.body, renderData);

    try {
      await paceForResend();
      let result = await resend.emails.send({
        from: EMAIL_FROM,
        to: row.recipient_email,
        subject,
        text: body,
      });
      // Resend SDK v3+: success → { data: { id }, error: null }.
      // Rate-limit error message contains "Too many requests"; back
      // off and retry once before giving up.
      let providerErr = result?.error;
      const isRateLimit = providerErr && /too many requests|429/i.test(providerErr.message || JSON.stringify(providerErr));
      if (isRateLimit) {
        await sleep(1200);
        lastSendAt = Date.now();
        result = await resend.emails.send({ from: EMAIL_FROM, to: row.recipient_email, subject, text: body });
        providerErr = result?.error;
      }
      const messageId = result?.data?.id;
      if (providerErr) throw new Error(providerErr.message || JSON.stringify(providerErr));
      await sb.from("notification_queue").update({
        status: "sent",
        processed_at: new Date().toISOString(),
        error_message: messageId ? "resend_id=" + messageId : null,
      }).eq("id", row.id);
      sent++;
    } catch (e) {
      const msg = safe(e?.message || String(e), MAX_ERROR_MSG_LEN);
      await sb.from("notification_queue").update({
        status: "failed",
        processed_at: new Date().toISOString(),
        error_message: msg,
      }).eq("id", row.id);
      failed++;
      errors.push({ id: row.id, type: row.type, error: msg });
    }
  }

  // TTL sweep — anything stuck pending >24h likely had a non-recoverable
  // error from before the worker existed. Mark them as expired so the
  // queue dashboard isn't permanently red.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await sb.from("notification_queue").update({
    status: "failed",
    processed_at: new Date().toISOString(),
    error_message: "expired before worker pickup (>24h pending)",
  }).eq("status", "pending").lt("created_at", cutoff);

  res.status(200).json({
    ok: true,
    attempted: pending.length,
    sent, failed, skipped,
    errors: errors.slice(0, 10), // keep response compact
  });
};
