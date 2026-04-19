// Vercel API Route: Expire stale company_members invites.
//
// Daily cron. Any row with status="invited" and created_at older than
// 30 days gets flipped to status="expired". Without this, an
// unaccepted invite sits forever — an ex-employee's old email becomes
// a lingering backdoor the day someone else registers that address.
//
// Auth: Bearer CRON_SECRET, matching the other cron routes.
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

const CRON_SECRET = process.env.CRON_SECRET || "";
const INVITE_TTL_DAYS = 30;

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const authHeader = req.headers.authorization || "";
  const bodySecret = (req.body && typeof req.body === "object" && req.body.cron_secret) || "";
  const isCronAuth = CRON_SECRET && CRON_SECRET.length >= 8 && (
    authHeader === `Bearer ${CRON_SECRET}` || bodySecret === CRON_SECRET
  );
  if (!isCronAuth) return res.status(401).json({ error: "Unauthorized" });

  try {
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const cutoff = new Date(Date.now() - INVITE_TTL_DAYS * 86400000).toISOString();
    const { data: expired, error } = await supabase.from("company_members")
      .update({ status: "expired" }, { count: "exact" })
      .eq("status", "invited")
      .lt("created_at", cutoff)
      .select("id, company_id, user_email");

    if (error) {
      console.error("expire-invites: update failed", error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      ok: true,
      expired_count: (expired || []).length,
      ttl_days: INVITE_TTL_DAYS,
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("expire-invites: fatal", e.message);
    return res.status(500).json({ error: e.message });
  }
};
