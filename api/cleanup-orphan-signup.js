// Vercel API Route: delete a Supabase auth user that got created during
// a failed tenant signup, so a race-losing invite redemption doesn't
// leave a zombie account behind.
//
// The client's tenant signup flow is:
//   1. validate_invite_code   (read-only check)
//   2. supabase.auth.signUp   (creates auth user)
//   3. redeem_invite_code     (mark code used, bind to user)
//
// Step 2 succeeds unconditionally. Step 3 can fail when another user
// races to the same code first — the loser ends up with a Supabase auth
// account that has no company membership and no way to self-recover.
// This endpoint lets the client ask the server to delete that orphan.
//
// Auth model:
//   - Caller presents their own freshly-issued session JWT
//     (Authorization: Bearer). We verify via Supabase's anon key — so
//     the caller really did just sign up as that user.
//   - We cross-check that the invite code has no pending redemption for
//     this user's email. If it doesn't (meaning the redemption genuinely
//     failed), we delete the auth user via service role.
//   - Refuse to delete anyone who is already a member of a company —
//     that would let a compromised client self-delete a real account.
//
// Contract:
//   POST /api/cleanup-orphan-signup
//   Body: { inviteCode? }
//   Response: 200 { ok: true } | 4xx { error }
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

// Case-insensitive email equality in a Postgres LIKE pattern — escape
// the _ and % chars so "john_doe@x.com" doesn't wildcard-match
// "johnxdoe@x.com". Kept inline because api/ routes don't share the
// src/utils/helpers bundle.
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

  // Verify the caller's identity via the anon client so RLS applies.
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

  // Service-role client for the sensitive reads/deletes below.
  const admin = createClient(supaUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Refuse to delete anyone who's already a member of a company — even
  // an "invited" or "pending" membership counts. A signed-up tenant
  // with a working membership must not be removable via this path.
  const { data: memberships, error: memErr } = await admin
    .from("company_members")
    .select("status")
    .ilike("user_email", emailFilterValue(userEmail));
  if (memErr) {
    return res.status(500).json({ error: "Membership lookup failed" });
  }
  if ((memberships || []).some(m => m.status === "active" || m.status === "invited" || m.status === "pending")) {
    return res.status(403).json({ error: "Account has active or pending memberships" });
  }

  // If the client claimed an invite code, double-check it hasn't been
  // redeemed FOR this user. If it has, this isn't an orphan — refuse.
  const body = req.body || {};
  const claimedCode = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";
  if (claimedCode) {
    const { data: invite } = await admin
      .from("tenant_invite_codes")
      .select("used, redeemed_by_email")
      .eq("code", claimedCode)
      .maybeSingle();
    if (invite?.used && (invite.redeemed_by_email || "").toLowerCase() === userEmail) {
      return res.status(403).json({ error: "Invite was redeemed by this user — not an orphan" });
    }
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(userId);
  if (delErr) {
    return res.status(500).json({ error: "Delete failed: " + delErr.message });
  }
  return res.status(200).json({ ok: true });
};
