// Vercel API Route: Send a user invite (team member or tenant).
//
// Moves invite issuance off the browser's public Supabase auth endpoint so
// it bypasses Supabase's Bot Protection captcha. The widget on LoginPage
// protects unauthenticated traffic (signup/login/password reset); admins
// issuing invites from inside the app are already authenticated, so making
// them solve a captcha every time would be hostile UX.
//
// Auth model:
//   - Caller presents their Supabase session JWT (as Authorization: Bearer).
//     We verify via Supabase's anon key + RLS — so a stolen service role key
//     alone can't impersonate an admin here.
//   - Caller must be an ACTIVE member of the target company with a role that
//     can issue invites:
//       • team invite (role != tenant): admin | owner | pm
//       • tenant invite (role == tenant): admin | owner | pm | office_assistant
//   - Only after those checks do we use the service role to call
//     auth.admin.inviteUserByEmail (bypasses captcha) and upsert
//     company_members.
//
// Contract:
//   POST /api/invite-user
//   Body: { email, companyId, userName, role, inviteType: "team" | "tenant" }
//   Response: 200 { ok: true, created_user: bool } | 4xx { error }
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



const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = new Set(["admin", "owner", "pm", "office_assistant", "tenant"]);
const TEAM_ISSUER_ROLES = new Set(["admin", "owner", "pm"]);
const TENANT_ISSUER_ROLES = new Set(["admin", "owner", "pm", "office_assistant"]);
const MAX_EMAIL_LEN = 254;
const MAX_NAME_LEN = 128;
const MAX_COMPANYID_LEN = 128;

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // ─── Cheap local validation BEFORE any Supabase call.
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ") || authHeader.length < 20 || authHeader.length > 4096) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const companyId = typeof body.companyId === "string" ? body.companyId : "";
  const userName = typeof body.userName === "string" ? body.userName.trim() : "";
  const role = typeof body.role === "string" ? body.role : "";
  const inviteType = body.inviteType === "tenant" ? "tenant" : "team";

  if (!email || email.length > MAX_EMAIL_LEN || !EMAIL_RE.test(email)) return res.status(400).json({ error: "Invalid email" });
  if (!companyId || companyId.length > MAX_COMPANYID_LEN) return res.status(400).json({ error: "Invalid companyId" });
  if (userName.length > MAX_NAME_LEN) return res.status(400).json({ error: "Invalid name" });
  if (!VALID_ROLES.has(role)) return res.status(400).json({ error: "Invalid role" });
  if (inviteType === "tenant" && role !== "tenant") return res.status(400).json({ error: "Tenant invite must have role=tenant" });
  if (inviteType === "team" && role === "tenant") return res.status(400).json({ error: "Team invite cannot have role=tenant" });

  const token = authHeader.slice(7);

  // Step 1: verify caller's session + company membership via their own JWT.
  const userClient = createClient(
    process.env.REACT_APP_SUPABASE_URL,
    process.env.REACT_APP_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return res.status(401).json({ error: "Invalid session" });
  const callerEmail = (userData.user.email || "").toLowerCase();
  if (!callerEmail) return res.status(401).json({ error: "Session has no email" });

  const { data: callerMembership } = await userClient
    .from("company_members")
    .select("role, status")
    .eq("company_id", companyId)
    .ilike("user_email", emailFilterValue(callerEmail))
    .eq("status", "active")
    .maybeSingle();
  if (!callerMembership) return res.status(403).json({ error: "Not a member of this company" });

  const callerRole = callerMembership.role;
  const allowedIssuers = inviteType === "tenant" ? TENANT_ISSUER_ROLES : TEAM_ISSUER_ROLES;
  if (!allowedIssuers.has(callerRole)) {
    return res.status(403).json({ error: "Your role cannot issue this invite type" });
  }

  // Step 2: send the invite and upsert membership via service role.
  const admin = createClient(
    process.env.REACT_APP_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  let userCreated = false;
  let alreadyRegistered = false;
  try {
    const { data: invRes, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { name: userName || email.split("@")[0], role },
    });
    if (invErr) {
      // Existing user — inviteUserByEmail refuses. Don't send a
      // "reset your password" email (Supabase's Recovery template
      // is what that triggers, and a cross-company invite isn't a
      // password-reset event — the recipient has a working account
      // already). Instead, rely on the Pending Invites section on
      // the Company Selector: the membership row we upsert below
      // with status="invited" shows up there the next time the user
      // logs in, and they accept it from that UI. No confusing auth
      // email is needed.
      const msg = (invErr.message || "").toLowerCase();
      const isAlreadyRegistered = msg.includes("already") || msg.includes("registered") || (invErr.status === 422);
      if (!isAlreadyRegistered) {
        return res.status(502).json({ error: "Invite email failed: " + invErr.message });
      }
      alreadyRegistered = true;
    } else if (invRes?.user) {
      userCreated = true;
    }
  } catch (e) {
    return res.status(500).json({ error: "Auth admin call failed: " + (e.message || "unknown") });
  }

  // Step 3: record the membership row. Service role ensures write lands
  // even if the caller's JWT has narrower RLS permissions than expected.
  const { error: memErr } = await admin.from("company_members").upsert([{
    company_id: companyId,
    user_email: email,
    user_name: userName || email.split("@")[0],
    role,
    status: "invited",
    invited_by: callerEmail,
  }], { onConflict: "company_id,user_email" });
  if (memErr) {
    // Email is out the door; surface the DB error so caller can retry.
    return res.status(500).json({ error: "Membership record failed: " + memErr.message });
  }

  return res.status(200).json({
    ok: true,
    created_user: userCreated,
    // True when the email was already registered — the membership row
    // was still inserted with status="invited" and the user will see
    // it on their Company Selector next login. No auth email fires in
    // this case; the client should communicate that to the admin.
    already_registered: alreadyRegistered,
  });
};
