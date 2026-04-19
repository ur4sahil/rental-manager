// Vercel API Route: Teller Cron Health
// Read-only diagnostics for the daily sync cron.
// Auth: JWT+company_id (per-company stats) OR CRON_SECRET (global stats)
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

const CRON_SECRET = process.env.CRON_SECRET || "";

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const authHeader = req.headers.authorization || "";
    const isCronAuth = CRON_SECRET && CRON_SECRET.length >= 8 && authHeader === `Bearer ${CRON_SECRET}`;
    let companyFilter = null;

    if (isCronAuth) {
      companyFilter = null;
    } else if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: "Unauthorized" });

      const companyId = req.query?.company_id;
      if (!companyId) return res.status(400).json({ error: "company_id required" });

      const { data: mem } = await supabase
        .from("company_members")
        .select("role")
        .eq("company_id", companyId)
        .ilike("user_email", user.email || "")
        .eq("status", "active")
        .maybeSingle();
      if (!mem) return res.status(403).json({ error: "Not a member of this company" });
      companyFilter = companyId;
    } else {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Sync events (last 24h)
    let eventsQ = supabase
      .from("plaid_sync_event")
      .select("id, company_id, bank_connection_id, status, started_at, completed_at, added_count, error_json")
      .gte("started_at", since)
      .order("started_at", { ascending: false });
    if (companyFilter) eventsQ = eventsQ.eq("company_id", companyFilter);
    const { data: events } = await eventsQ;

    // Connection snapshot
    let connQ = supabase
      .from("bank_connection")
      .select("id, company_id, connection_status, last_successful_sync_at, last_error_code, last_error_message, created_at")
      .eq("source_type", "teller");
    if (companyFilter) connQ = connQ.eq("company_id", companyFilter);
    const { data: conns } = await connQ;

    const evts = events || [];
    const successes = evts.filter((e) => e.status === "success").length;
    const failures = evts.filter((e) => e.status === "failed").length;
    const stuck = evts.filter((e) => e.status === "syncing").length;
    const totalAdded = evts.reduce((s, e) => s + (e.added_count || 0), 0);
    const lastRun = evts[0]?.started_at || null;

    // Health verdict — cron ran in last ~25h AND had at least one success (if any conns exist)
    const hoursSinceRun = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 3_600_000 : null;
    const connList = conns || [];
    const hasAnyConns = connList.length > 0;
    const recentRun = hoursSinceRun !== null && hoursSinceRun < 25;
    const healthy = !hasAnyConns || (recentRun && successes > 0 && stuck === 0);

    return res.status(200).json({
      healthy,
      window_hours: 24,
      last_run_at: lastRun,
      hours_since_last_run: hoursSinceRun,
      sync_events: { total: evts.length, success: successes, failed: failures, in_flight: stuck },
      total_transactions_added: totalAdded,
      connections: connList.map((c) => ({
        id: c.id,
        company_id: c.company_id,
        status: c.connection_status,
        last_successful_sync_at: c.last_successful_sync_at,
        last_error: c.last_error_message,
      })),
      recent_failures: evts.filter((e) => e.status === "failed").slice(0, 10).map((e) => ({
        bank_connection_id: e.bank_connection_id,
        started_at: e.started_at,
        error: e.error_json?.message || null,
      })),
    });
  } catch (e) {
    console.error("teller-cron-health error:", e.message);
    return res.status(500).json({ error: "Health check failed" });
  }
};
