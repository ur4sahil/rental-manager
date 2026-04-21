// Vercel API Route: Daily data-integrity sweep.
//
// Iterates every company and runs the same checks that the in-app
// runDataIntegrityChecks (src/utils/company.js) performs from the Admin
// "Run Health Check" button — but nightly, without requiring a human to
// click. Violations land in error_log so the ErrorLogDashboard shows them.
//
// Auth: Bearer CRON_SECRET (same pattern as teller-sync-transactions and
// tax-bill-reminders).
const { createClient } = require("@supabase/supabase-js");

const CRON_SECRET = process.env.CRON_SECRET || "";

// Severity table — duplicated from PM_ERRORS so Node doesn't need the bundler.
const SEV = {
  "PM-9001": "critical",
  "PM-9006": "critical",
  "PM-9007": "warning",
};

async function logViolation(supabase, companyId, code, message, meta) {
  try {
    await supabase.from("error_log").insert([{
      company_id: companyId,
      error_code: code,
      message,
      raw_message: null,
      severity: SEV[code] || "warning",
      module: "data_integrity",
      context: "nightly integrity sweep",
      meta: meta || {},
      user_email: "cron",
      user_role: "system",
      url: null,
      user_agent: "integrity-check-cron",
      reported_by_user: false,
    }]);
  } catch (e) {
    console.error("integrity-check: error_log insert failed", e.message);
  }
}

async function checkUnbalancedJEs(supabase, companyId) {
  // Leans on the find_unbalanced_jes RPC — after migration 20260411 it
  // returns (id text, number text, difference numeric, date date).
  const { data, error } = await supabase.rpc("find_unbalanced_jes", { p_company_id: companyId });
  if (error) {
    await logViolation(supabase, companyId, "PM-8003", "find_unbalanced_jes RPC failed: " + error.message, { rpc: "find_unbalanced_jes" });
    return 0;
  }
  for (const je of data || []) {
    await logViolation(supabase, companyId, "PM-9001",
      `JE ${je.number} is out of balance by $${Number(je.difference || 0).toFixed(2)}`,
      { jeId: je.id, jeNumber: je.number, difference: je.difference, date: je.date });
  }
  return (data || []).length;
}

// Hard caps so a degenerate company (or a runaway retry) can't wedge the DB.
// Generous for real portfolios but bounded.
const MAX_TENANTS = 10000;
const MAX_LEDGER = 200000;
const MAX_RECURRING = 2000;
const MAX_ACCOUNTS = 5000;

async function checkRecurringTemplates(supabase, companyId) {
  const [{ data: recurs }, { data: accts }] = await Promise.all([
    supabase.from("recurring_journal_entries").select("id, description, template_lines_json").eq("company_id", companyId).eq("status", "active").limit(MAX_RECURRING),
    supabase.from("acct_accounts").select("id").eq("company_id", companyId).eq("is_active", true).limit(MAX_ACCOUNTS),
  ]);
  const active = new Set((accts || []).map(a => a.id));
  let count = 0;
  for (const r of (recurs || [])) {
    const lines = r.template_lines_json || [];
    for (const l of lines) {
      if (l.account_id && !active.has(l.account_id)) {
        await logViolation(supabase, companyId, "PM-9007",
          `Recurring entry "${r.description}" references inactive account`,
          { recurId: r.id, accountId: l.account_id });
        count++;
        break;
      }
    }
  }
  return count;
}

async function checkTenantBalanceVsLedger(supabase, companyId) {
  // Pulls tenants + ledger_entries in two reads per company rather than N+1.
  // Both capped so a company with an extreme history can't stall the cron.
  // Also selects `tenant` (name) so we can account for legacy rows that
  // lack tenant_id — otherwise every tenant with name-keyed history
  // reports as unbalanced and drowns the real PM-9006 signal.
  const [{ data: tenants }, { data: ledger }] = await Promise.all([
    supabase.from("tenants").select("id, name, balance").eq("company_id", companyId).is("archived_at", null).limit(MAX_TENANTS),
    supabase.from("ledger_entries").select("tenant_id, tenant, amount").eq("company_id", companyId).limit(MAX_LEDGER),
  ]);
  // Coerce ids to string so integer vs bigint serialization quirks don't
  // create phantom mismatches across Supabase client versions.
  const byId = new Map();
  const byNameOnly = new Map();
  for (const e of (ledger || [])) {
    const amt = Number(e.amount || 0);
    if (e.tenant_id) {
      const key = String(e.tenant_id);
      byId.set(key, (byId.get(key) || 0) + amt);
    } else if (e.tenant) {
      const key = (e.tenant || "").toLowerCase();
      byNameOnly.set(key, (byNameOnly.get(key) || 0) + amt);
    }
  }
  let count = 0;
  for (const t of (tenants || [])) {
    const idTotal = byId.get(String(t.id)) || 0;
    const nameTotal = byNameOnly.get((t.name || "").toLowerCase()) || 0;
    const ledgerTotal = idTotal + nameTotal;
    const stored = Number(t.balance || 0);
    if (Math.abs(stored - ledgerTotal) > 0.01) {
      await logViolation(supabase, companyId, "PM-9006",
        `Tenant "${t.name}" balance ($${stored.toFixed(2)}) doesn't match ledger ($${ledgerTotal.toFixed(2)})`,
        { tenantId: t.id, storedBalance: stored, ledgerTotal });
      count++;
    }
  }
  return count;
}

const { setCors } = require("./_cors");

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

    // One row per company from companies table. Fall back to DISTINCT
    // company_id on properties if the companies table isn't populated.
    const { data: companies } = await supabase.from("companies").select("id").is("archived_at", null);
    const companyIds = (companies || []).map(c => c.id);

    let totals = { companies: 0, unbalancedJEs: 0, recurringTemplates: 0, tenantBalance: 0, errors: 0 };

    for (const companyId of companyIds) {
      totals.companies++;
      try {
        totals.unbalancedJEs += await checkUnbalancedJEs(supabase, companyId);
        totals.recurringTemplates += await checkRecurringTemplates(supabase, companyId);
        totals.tenantBalance += await checkTenantBalanceVsLedger(supabase, companyId);
      } catch (e) {
        totals.errors++;
        console.error(`integrity-check: ${companyId} failed`, e.message);
      }
    }

    return res.status(200).json({ ok: true, ...totals, at: new Date().toISOString() });
  } catch (e) {
    console.error("integrity-check: fatal", e.message);
    return res.status(500).json({ error: e.message });
  }
};
