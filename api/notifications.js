// ════════════════════════════════════════════════════════════════════
// Notifications dispatcher — consolidates two former routes into one
// Vercel function so we stay under the Hobby-plan 12-function cap.
//
// Was previously:
//   /api/send-push           → web-push delivery
//   /api/notification-worker → Resend email worker (drains the queue)
//
// Now both behaviors live in /api/notifications behind ?action=:
//   ?action=push    → fan out a push notification to all of a user's
//                     registered devices. JWT-authed; caller must be
//                     an active member of the target company.
//   ?action=worker  → drain notification_queue rows, send via Resend.
//                     Bearer CRON_SECRET (cron path) OR a regular user
//                     JWT (in-app fire-on-insert path) accepted.
//
// Implementations live in /api/_send-push-impl.js and
// /api/_notification-worker-impl.js. Files prefixed with `_` are not
// counted by Vercel as serverless functions, so the impl modules
// don't burn slots. Same pattern as daily-reminders.js +
// _license-expiry-reminders-impl.js + _tax-bill-reminders-impl.js.
// ════════════════════════════════════════════════════════════════════
const sendPushImpl = require("./_send-push-impl");
const notificationWorkerImpl = require("./_notification-worker-impl");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

// Diagnostic beacon. The service worker POSTs here when it receives
// a push event so we can correlate "push delivered to APNS"
// (push_attempts row, server-side) with "push received by SW"
// (sibling row, this endpoint). Anonymous on purpose — the SW has
// no Supabase auth context and the worst-case spam writes some
// extra debug rows. payload_tag is server-generated random so a
// spammer can't forge a meaningful correlation.
async function pushBeacon(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SVC) return res.status(500).json({ error: "supabase env missing" });
  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const { payload_tag, status, error_message, title, body: text, recipient_email, company_id } = body || {};
  await sb.from("push_attempts").insert({
    company_id: company_id || "?",
    recipient_email: recipient_email || "?",
    title: title || null,
    body: text || null,
    status: status || "sw_received",
    delivered_count: 0,
    pruned_count: 0,
    error_message: error_message ? String(error_message).slice(0, 1000) : null,
    payload_tag: payload_tag || null,
  });

  // Stamp the subscription's last_sw_received_at when the SW reports
  // it received a push. This is the ONLY reliable per-subscription
  // health signal we have — APNS 201s for dead subs forever, so we
  // can't infer health from server-side delivery alone.
  // Beacons can come from any of the SW's status flags (sw_received,
  // sw_displayed_*, sw_show_error_*); any of them mean the device
  // woke up at least far enough to run our SW handler.
  const aliveStatuses = new Set([
    "sw_received", "sw_displayed_main", "sw_displayed_fallback_main",
    "sw_displayed_parse_error", "sw_displayed_fallback_parse_error",
    "sw_show_error_main", "sw_show_error_parse_error",
    "sw_subscription_change",
  ]);
  if (recipient_email && company_id && aliveStatuses.has(status)) {
    await sb.from("push_subscriptions")
      .update({ last_sw_received_at: new Date().toISOString(), dead_marked_at: null })
      .eq("company_id", company_id)
      .ilike("user_email", recipient_email);
  }

  return res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const action = (req.query?.action || "").toString();
  if (action === "push") return sendPushImpl(req, res);
  if (action === "worker") return notificationWorkerImpl(req, res);
  if (action === "beacon") return pushBeacon(req, res);
  return res.status(404).json({
    error: "unknown action — try ?action=push, ?action=worker, or ?action=beacon",
  });
};
