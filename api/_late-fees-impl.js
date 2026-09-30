// Scheduled late fees.
//
// Thin on purpose. All the logic lives in the Postgres function
// batch_post_late_fees, which is a sibling of the batch_post_rent_charges
// your rent posting already uses. That is what keeps the scheduled path
// and the manual "Apply late fee" button from drifting: neither owns the
// rules, the database does.
//
// The function applies the same one-late-fee-per-tenant-per-month rule as
// the two manual paths (public.late_fee_already_posted, mirrored by
// src/utils/lateFeeRules.js) and writes the same reference,
// LATEFEE-<tenant>-YYYYMM, to the tenant's own AR account -- so a retry, a
// double-trigger or a fee already charged from the app cannot produce a
// second one. Tenants whose AR account could not be established come back
// in each result's skipped_no_ar_account.
const { createClient } = require("@supabase/supabase-js");
const { isCronSecretBearer, cronSecretMatches } = require("./_auth");

module.exports = async (req, res) => {
  // Cron only. This posts journal entries for every company; the licence
  // and tax reminders on the same dispatcher always required the secret,
  // this one did not (found in the 2026-09-30 audit) -- anyone could post
  // late fees for every company at any time after grace.
  const CRON_SECRET = process.env.CRON_SECRET || "";
  const authHeader = req.headers.authorization || "";
  const bodySecret = (req.body && typeof req.body === "object" && req.body.cron_secret) || "";
  const isCronAuth = CRON_SECRET.length >= 8 && (
    isCronSecretBearer(authHeader, CRON_SECRET) || cronSecretMatches(bodySecret, CRON_SECRET)
  );
  if (!isCronAuth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const url = process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY or URL not configured" });
    return;
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Every company with an active late fee rule. A company that has not
  // configured one is not charged anything -- silence is the correct
  // behaviour there, not a default fee.
  const { data: rules, error: rErr } = await sb
    .from("late_fee_rules")
    .select("company_id")
    .is("archived_at", null);
  if (rErr) { res.status(500).json({ error: rErr.message }); return; }

  const companies = [...new Set((rules || []).map(r => r.company_id).filter(Boolean))];
  const results = [];
  for (const companyId of companies) {
    // Sequentially, not in parallel: each call posts journal entries and
    // updates balances, and a partial failure needs to be attributable.
    const { data, error } = await sb.rpc("batch_post_late_fees", { p_company_id: companyId });
    results.push({ companyId, ...(error ? { error: error.message } : data) });
  }

  const posted = results.reduce((s, r) => s + (r.fees_posted || 0), 0);
  const failed = results.filter(r => r.error);
  res.status(failed.length ? 207 : 200).json({
    ok: failed.length === 0,
    companies: companies.length,
    fees_posted: posted,
    results,
  });
};
