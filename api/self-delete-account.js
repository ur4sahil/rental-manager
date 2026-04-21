// Vercel API Route: user-initiated "Delete my account".
//
// The existing deleteAccount flow in Admin.js flipped app_users.status
// to "deleted" and marked company_members.status = "removed". But it
// did NOT delete the Supabase auth row — the user could still sign in,
// and any UI path that didn't re-check app_users.status before
// trusting the auth session granted access to a supposedly-deleted
// account.
//
// Auth model:
//   - Caller presents their own session JWT (Authorization: Bearer).
//     We verify via the anon client so RLS applies.
//   - Cross-check that app_users.status for this email is "deleted" —
//     this endpoint is not a generic user-delete API, it only finishes
//     a self-delete that the client already initiated.
//   - Delete via service-role admin.auth.admin.deleteUser. That's the
//     only way to remove an auth row; the regular anon/service APIs
//     can't touch auth.users.
//
// Contract:
//   POST /api/self-delete-account
//   Response: 200 { ok: true } | 4xx { error }
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

function emailFilterValue(email) {
  const s = (email || "").trim().toLowerCase();
  return s.replace(/[%_,.*()\\]/g, c => "\\" + c);
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ") || authHeader.length < 20 || authHeader.length > 4096) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = authHeader.slice(7);

  const supaUrl = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !anonKey || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const anon = createClient(supaUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + token } },
  });
  const { data: userData, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userData?.user?.id || !userData?.user?.email) {
    return res.status(401).json({ error: "Invalid session" });
  }
  const userId = userData.user.id;
  const userEmail = (userData.user.email || "").toLowerCase();

  const admin = createClient(supaUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Enforce the soft-delete-first protocol. If the caller's app_users
  // row isn't status=deleted yet, refuse — a stray call to this
  // endpoint must not delete a live account. The client flips
  // app_users.status right before calling us.
  const { data: appUser } = await admin
    .from("app_users")
    .select("status")
    .ilike("email", emailFilterValue(userEmail))
    .maybeSingle();
  if (!appUser || appUser.status !== "deleted") {
    return res.status(409).json({ error: "app_users row is not in deleted state yet" });
  }

  // Also enforce that every membership is non-active. Prevents the
  // case where a client bug flipped app_users but left an active
  // company_members row — we'd rather error than orphan a membership
  // pointing at a deleted auth id.
  const { data: stillActive } = await admin
    .from("company_members")
    .select("company_id")
    .ilike("user_email", emailFilterValue(userEmail))
    .eq("status", "active");
  if ((stillActive || []).length > 0) {
    return res.status(409).json({ error: "Caller still has active company memberships" });
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    return res.status(500).json({ error: "Auth delete failed: " + delErr.message });
  }
  return res.status(200).json({ ok: true });
};
