// Shared caller verification for routes that run with the service key.
//
// A service-role client bypasses RLS, so the ONLY thing standing between
// one company's data and another's is the check in the route. Every
// browser-facing action that names a companyId goes through requireMember:
// bearer token -> auth.getUser -> an ACTIVE company_members row for that
// company -> (optionally) a role in the allowed set. Nothing about the
// caller is taken from the body.
const { createClient } = require("@supabase/supabase-js");

// Roles that do the company's work. Portal roles (tenant, owner) and the
// maintenance role are members too, but they never operate the books, the
// AI assistant, bank sync, or credentials.
const STAFF_ROLES = new Set(["admin", "pm", "manager", "office_assistant", "accountant"]);
const MANAGEMENT_ROLES = new Set(["admin", "pm", "manager"]);

// `%` and `_` are LIKE wildcards; `\` escapes. An email is compared with
// ilike (case-insensitive) so it MUST be escaped, or `j_hn@x.com` matches
// `john@x.com` and the caller passes as someone else.
function emailFilterValue(email) {
  const s = String(email || "").trim().toLowerCase();
  return s.replace(/[%_\\]/g, c => "\\" + c);
}

function serviceClient() {
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function bearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

// Resolves { user, membership, sb } or { error, status }.
//   companyId  required; the company the caller claims to act in
//   roles      optional Set of roles allowed (default: any active member)
//   sb         optional service client to reuse
async function requireMember(req, { companyId, roles = null, sb = null } = {}) {
  const token = bearerToken(req);
  if (!token) return { error: "unauthorized", status: 401 };
  const cid = String(companyId || "");
  if (!cid || cid.length > 128) return { error: "companyId is required", status: 400 };
  const client = sb || serviceClient();
  if (!client) return { error: "server is not configured for database access", status: 500 };
  const { data: userData, error: userErr } = await client.auth.getUser(token);
  const user = userData && userData.user;
  if (userErr || !user || !user.email) return { error: "unauthorized", status: 401 };
  const { data: membership, error: memErr } = await client
    .from("company_members")
    .select("role, status, user_email")
    .eq("company_id", cid)
    .ilike("user_email", emailFilterValue(user.email))
    .eq("status", "active")
    .maybeSingle();
  if (memErr) return { error: "membership lookup failed", status: 500 };
  if (!membership) return { error: "not a member of this company", status: 403 };
  if (roles && !roles.has(membership.role)) return { error: "your role cannot do this", status: 403 };
  return { user, membership, sb: client };
}

module.exports = { requireMember, emailFilterValue, bearerToken, serviceClient, STAFF_ROLES, MANAGEMENT_ROLES };
