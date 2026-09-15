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
// Keep in sync with ROLES in src/App.js and src/components/Admin.js —
// any role the Admin form can assign must be invitable. Previously
// this allowlist missed manager/accountant/maintenance, so Team &
// Roles would save the user row but the follow-up invite 400'd.
const VALID_ROLES = new Set(["admin", "owner", "pm", "manager", "office_assistant", "accountant", "maintenance", "tenant"]);
// Managers sit below admin/owner in the approval chain — they can
// issue team invites too. Accountant/maintenance are specialized and
// shouldn't be adding team members.
const TEAM_ISSUER_ROLES = new Set(["admin", "owner", "pm", "manager"]);
const TENANT_ISSUER_ROLES = new Set(["admin", "owner", "pm", "manager", "office_assistant"]);
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

  // MEMBERSHIP FIRST, EMAIL SECOND.
  //
  // This used to run the other way round, and the old comment on the
  // failure path said so plainly: "Email is out the door; surface the DB
  // error so caller can retry." If the membership write failed, the
  // invitee had already received an invitation to a company they were not
  // a member of -- they click the link, sign in, and find nothing. A retry
  // then sends them a second email.
  //
  // Reversed, the worst case is a membership row for someone who never got
  // an email: invisible to them, visible to the admin as a pending invite,
  // and fixed by pressing Resend. An unsent email is recoverable; an
  // un-backed invitation is confusing to someone who cannot see why.
  //
  // status stays 'invited' either way -- it means "not yet accepted", which
  // is true from the moment the row exists.
  const { error: preMemErr } = await admin.from("company_members").upsert([{
    company_id: companyId,
    user_email: email,
    user_name: userName || email.split("@")[0],
    role,
    status: "invited",
    invited_by: callerEmail,
  }], { onConflict: "company_id,user_email" });
  if (preMemErr) {
    return res.status(500).json({ error: "Membership record failed: " + preMemErr.message });
  }

  let userCreated = false;
  let alreadyRegistered = false;
  let magicLinkSent = false;
  let invitedAuthUserId = null;
  try {
    const { data: invRes, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { name: userName || email.split("@")[0], role },
    });
    if (invErr) {
      // Existing user — inviteUserByEmail refuses. Fall back to a
      // magic-link email so the invitee still receives something
      // actionable: "log in to see your new pending invite". Without
      // this, hitting "Resend Invite" for an already-registered
      // teammate is a no-op with no feedback to them — Sahil hit
      // that and (rightly) called it a bug.
      //
      // We deliberately do NOT use the Recovery / reset-password
      // template here — a cross-company invite isn't a
      // password-reset event, and using that template had caused
      // prior confusion (see commit 7e177a7). Magic-link is the
      // correct semantic: "here's a way to log in and see the invite."
      const msg = (invErr.message || "").toLowerCase();
      const isAlreadyRegistered = msg.includes("already") || msg.includes("registered") || (invErr.status === 422);
      if (!isAlreadyRegistered) {
        return res.status(502).json({ error: "Invite email failed: " + invErr.message });
      }
      alreadyRegistered = true;
      // Use anon client with signInWithOtp — admin.generateLink
      // returns the URL only (no email). signInWithOtp triggers
      // Supabase's Magic Link email template.
      try {
        const anonClient = createClient(
          process.env.REACT_APP_SUPABASE_URL,
          process.env.REACT_APP_SUPABASE_ANON_KEY,
          { auth: { persistSession: false, autoRefreshToken: false } }
        );
        const { error: otpErr } = await anonClient.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false },
        });
        if (!otpErr) magicLinkSent = true;
      } catch (_otpE) { /* swallow — client still gets already_registered=true */ }
    } else if (invRes?.user) {
      userCreated = true;
      invitedAuthUserId = invRes.user.id || null;
    }
  } catch (e) {
    return res.status(500).json({ error: "Auth admin call failed: " + (e.message || "unknown") });
  }

  // Link the membership to the auth user that was just created.
  //
  // inviteUserByEmail returns the new user's id and nothing was storing it,
  // so every invited member sat with auth_user_id NULL. It still worked,
  // because get_staff_company_ids() and is_company_staff() both fall back
  // to matching on email -- but the moment someone changes their email
  // address, a membership keyed only on the old one stops matching them and
  // they silently lose access to the company.
  //
  // Best-effort on purpose: the invitation has already been sent and the
  // membership already exists, so failing here must not turn a successful
  // invite into an error. The email fallback keeps working meanwhile.
  if (invitedAuthUserId) {
    const { error: linkErr } = await admin.from("company_members")
      .update({ auth_user_id: invitedAuthUserId })
      .eq("company_id", companyId)
      .ilike("user_email", emailFilterValue(email));
    if (linkErr) {
      console.warn("invite: could not link auth_user_id for", companyId, linkErr.message);
    }
  }

  return res.status(200).json({
    ok: true,
    created_user: userCreated,
    // True when the email was already registered — we tried to send a
    // magic-link so the invitee can log in and accept the pending
    // membership row we just upserted. `magic_link_sent` tells the
    // client whether that second-channel email actually went out.
    already_registered: alreadyRegistered,
    magic_link_sent: magicLinkSent,
  });
};
