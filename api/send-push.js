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

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    res.status(500).json({ error: "VAPID keys not configured on server" });
    return;
  }

  // 1. Verify the caller's Supabase JWT.
  const authHeader = req.headers.authorization || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) { res.status(401).json({ error: "missing bearer token" }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;
  const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON || !SUPABASE_SVC) {
    res.status(500).json({ error: "Supabase env not configured" });
    return;
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: "Bearer " + jwt } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: authRes, error: authErr } = await userClient.auth.getUser(jwt);
  if (authErr || !authRes?.user) { res.status(401).json({ error: "invalid bearer token" }); return; }
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
  //    here. app_users.user_email is compared case-insensitively because
  //    the table stores whatever case the invite flow recorded.
  const svc = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  const { data: member } = await svc.from("app_users")
    .select("role, status")
    .eq("company_id", company_id)
    .ilike("user_email", callerEmail)
    .eq("status", "active")
    .maybeSingle();
  if (!member) { res.status(403).json({ error: "caller is not an active member of this company" }); return; }

  // 4. Look up every registered subscription for the target recipient.
  const recipient = user_email.toLowerCase();
  const { data: subs, error: subErr } = await svc.from("push_subscriptions")
    .select("id, subscription")
    .eq("company_id", company_id)
    .ilike("user_email", recipient);
  if (subErr) { res.status(500).json({ error: "subscription lookup failed: " + subErr.message }); return; }
  if (!subs || subs.length === 0) { res.status(200).json({ delivered: 0, pruned: 0, note: "no subscriptions" }); return; }

  // 5. Fan out. Gather stale IDs for post-hoc cleanup — 410/404 means
  //    the push service rejected the endpoint, usually because the
  //    browser uninstalled the app or the user revoked permission.
  const payload = JSON.stringify({
    title, message: text || "", url: url || "/", tag: tag || "housify",
  });
  const stale = [];
  let delivered = 0;
  await Promise.all(subs.map(async (row) => {
    const sub = row.subscription;
    if (!sub || !sub.endpoint) return;
    try {
      await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 24 });
      delivered += 1;
    } catch (e) {
      const status = e && (e.statusCode || e.status);
      if (status === 404 || status === 410) stale.push(row.id);
      // Other errors (network, 5xx) surface via the aggregate log; don't
      // delete the row in case the failure is transient.
    }
  }));
  if (stale.length > 0) {
    await svc.from("push_subscriptions").delete().in("id", stale);
  }
  res.status(200).json({ delivered, pruned: stale.length });
};
