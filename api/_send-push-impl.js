// Vercel API Route: deliver web-push notifications.
//
// The client calls this whenever queueNotification fires with the push
// channel enabled. It looks up all push_subscriptions rows matching
// (company_id, user_email) and fans out to each — a user may be
// subscribed on multiple devices (desktop + PWA on phone), so we
// deliver to every registered endpoint.
//
// Dead subscriptions (410 Gone / 404 Not Found from the push service)
// are pruned so the next send doesn't retry them.
//
// Auth model:
//   - Caller presents their Supabase session JWT via Authorization: Bearer.
//     We verify via the anon-key client so RLS + expiry are enforced.
//   - Caller must be an ACTIVE member of the target company. Otherwise
//     a logged-in user from Company A could push-spam users in Company B.
//   - Only after those checks do we use the service role + VAPID private
//     key to dispatch. The private key never leaves the server.
//
// Contract:
//   POST /api/send-push
//   Headers: Authorization: Bearer <supabase_jwt>
//   Body: { company_id, user_email, title, body, url?, tag? }
//   Response: 200 { delivered, pruned } | 4xx { error }

const webpush = require("web-push");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || process.env.REACT_APP_VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@sigmahousingllc.com";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  // Audit log every dispatch so we can answer "what happened to that
  // push" without digging through Vercel function logs. Lazy-init the
  // service client; it's also used by the auth + lookup paths below.
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;
  const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let svc = null;
  if (SUPABASE_URL && SUPABASE_SVC) {
    svc = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  }
  async function logAttempt(row) {
    if (!svc) return;
    try { await svc.from("push_attempts").insert(row); }
    catch (_e) { /* non-fatal — log table is best-effort */ }
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    await logAttempt({ company_id: "?", recipient_email: "?", status: "auth_failed", error_message: "VAPID keys not configured" });
    res.status(500).json({ error: "VAPID keys not configured on server" });
    return;
  }

  // 1. Verify the caller's Supabase JWT.
  const authHeader = req.headers.authorization || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) {
    await logAttempt({ company_id: "?", recipient_email: "?", status: "auth_failed", error_message: "missing bearer token" });
    res.status(401).json({ error: "missing bearer token" }); return;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON || !SUPABASE_SVC) {
    res.status(500).json({ error: "Supabase env not configured" });
    return;
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: "Bearer " + jwt } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: authRes, error: authErr } = await userClient.auth.getUser(jwt);
  if (authErr || !authRes?.user) {
    await logAttempt({ company_id: "?", recipient_email: "?", status: "auth_failed", error_message: "invalid bearer token" });
    res.status(401).json({ error: "invalid bearer token" }); return;
  }
  const callerEmail = (authRes.user.email || "").toLowerCase();

  // 2. Read + validate body.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const { company_id, user_email, title, body: text, url, tag } = body || {};
  if (!company_id || typeof company_id !== "string") { res.status(400).json({ error: "company_id required" }); return; }
  if (!user_email || typeof user_email !== "string") { res.status(400).json({ error: "user_email required" }); return; }
  if (!title || typeof title !== "string") { res.status(400).json({ error: "title required" }); return; }

  // 3. Confirm caller is an active member of this company — otherwise
  //    a logged-in user from another company could push-spam tenants
  //    here. company_members is the real membership table (app_users
  //    is a compatibility shim that returns null here). user_email is
  //    compared case-insensitively because the table stores whatever
  //    case the invite flow recorded.
  const { data: member } = await svc.from("company_members")
    .select("role, status")
    .eq("company_id", company_id)
    .ilike("user_email", callerEmail)
    .eq("status", "active")
    .maybeSingle();
  if (!member) {
    await logAttempt({ company_id, caller_email: callerEmail, recipient_email: user_email, title, body: text, status: "auth_failed", error_message: "caller is not an active member of this company" });
    res.status(403).json({ error: "caller is not an active member of this company" }); return;
  }

  // 4. Look up every registered subscription for the target recipient.
  //    Filter out subs that have been dispatch-spammed for >7 days
  //    without a single SW beacon. Apple keeps 201ing those forever
  //    even though the device will never display anything; sending
  //    to them is pure waste and inflates our delivered_count noise.
  const recipient = user_email.toLowerCase();
  const { data: subs, error: subErr } = await svc.from("push_subscriptions")
    .select("id, subscription, last_sw_received_at, last_dispatch_at, dead_marked_at, created_at")
    .eq("company_id", company_id)
    .ilike("user_email", recipient);
  if (subErr) {
    await logAttempt({ company_id, caller_email: callerEmail, recipient_email: recipient, title, body: text, status: "error", error_message: "subscription lookup failed: " + subErr.message });
    res.status(500).json({ error: "subscription lookup failed: " + subErr.message }); return;
  }
  if (!subs || subs.length === 0) {
    await logAttempt({ company_id, caller_email: callerEmail, recipient_email: recipient, title, body: text, status: "no_subs" });
    res.status(200).json({ delivered: 0, pruned: 0, note: "no subscriptions" }); return;
  }
  // Health filter: a sub is "dead" if we've been dispatching to it
  // for at least 7 days but the SW has never beaconed back.
  // last_sw_received_at IS NULL is fine for new subs (we just
  // registered them); only suspect once we've actually tried to
  // push to them for a while.
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const liveSubs = [];
  const deadIds = [];
  for (const s of subs) {
    const lastRecv = s.last_sw_received_at ? new Date(s.last_sw_received_at).getTime() : 0;
    const firstDispatch = s.last_dispatch_at ? new Date(s.last_dispatch_at).getTime() : 0;
    const subAge = s.created_at ? now - new Date(s.created_at).getTime() : 0;
    // Mark dead if: been around >7d AND never received a beacon AND we've dispatched at least once.
    const neverAcked = !lastRecv;
    const stale = lastRecv > 0 && (now - lastRecv) > SEVEN_DAYS_MS;
    const oldEnoughToTrust = subAge > SEVEN_DAYS_MS && firstDispatch > 0;
    if ((neverAcked && oldEnoughToTrust) || stale) {
      deadIds.push(s.id);
    } else {
      liveSubs.push(s);
    }
  }
  if (deadIds.length > 0) {
    await svc.from("push_subscriptions")
      .update({ dead_marked_at: new Date().toISOString() })
      .in("id", deadIds);
  }
  if (liveSubs.length === 0) {
    await logAttempt({ company_id, caller_email: callerEmail, recipient_email: recipient, title, body: text, status: "all_subs_dead", error_message: "all " + subs.length + " sub(s) marked dead — no SW beacons in 7d" });
    return res.status(200).json({ delivered: 0, pruned: 0, note: "all subs dead — user needs to re-enable" });
  }

  // 5. Fan out. Gather stale IDs for post-hoc cleanup — 410/404 means
  //    the push service rejected the endpoint, usually because the
  //    browser uninstalled the app or the user revoked permission.
  // payload_tag is a server-generated random correlation id. We embed
  // it in the push body and the SW echoes it back via /api/notifications
  // ?action=beacon so we can join APNS-acknowledged with SW-received.
  const payloadTag = "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const payload = JSON.stringify({
    title, message: text || "", url: url || "/", tag: tag || "housify",
    payload_tag: payloadTag,
    company_id, recipient_email: recipient,
  });
  const stale = [];
  const errorMessages = [];
  let delivered = 0;
  await Promise.all(liveSubs.map(async (row) => {
    const sub = row.subscription;
    if (!sub || !sub.endpoint) return;
    try {
      // urgency:'high' tells the push service to deliver immediately
      // and tells iOS to bypass Notification Summary (otherwise the
      // banner gets bundled into the 8am/6pm summary digest instead
      // of popping live). On Android this also wakes a sleeping
      // device sooner than the default normal urgency.
      await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24, urgency: "high" });
      delivered += 1;
    } catch (e) {
      const status = e && (e.statusCode || e.status);
      const msg = (e && (e.message || e.body)) || String(e);
      if (status === 404 || status === 410) stale.push(row.id);
      errorMessages.push("[" + (status || "?") + "] " + String(msg).slice(0, 200));
      // Other errors (network, 5xx) surface via the aggregate log; don't
      // delete the row in case the failure is transient.
    }
  }));
  if (stale.length > 0) {
    await svc.from("push_subscriptions").delete().in("id", stale);
  }
  // Stamp last_dispatch_at on every sub we attempted, so the
  // health-filter clock starts ticking from the first real send.
  const dispatchedIds = liveSubs.map(s => s.id).filter(id => !stale.includes(id));
  if (dispatchedIds.length > 0) {
    await svc.from("push_subscriptions")
      .update({ last_dispatch_at: new Date().toISOString() })
      .in("id", dispatchedIds);
  }
  await logAttempt({
    company_id, caller_email: callerEmail, recipient_email: recipient,
    title, body: text,
    status: delivered > 0 ? "delivered" : "attempted",
    delivered_count: delivered, pruned_count: stale.length,
    error_message: errorMessages.length > 0 ? errorMessages.join(" | ").slice(0, 1000) : null,
    payload_tag: payloadTag,
  });
  res.status(200).json({ delivered, pruned: stale.length, payload_tag: payloadTag });
};
