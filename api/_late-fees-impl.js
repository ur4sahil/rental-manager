// Scheduled late fees.
//
// Thin on purpose. All the logic lives in the Postgres function
// batch_post_late_fees, which is a sibling of the batch_post_rent_charges
// your rent posting already uses. That is what keeps the scheduled path
// and the manual "Apply late fee" button from drifting: neither owns the
// rules, the database does.
//
// The function is idempotent on reference LATEFEE-<tenant>-<YYYY-MM>, so
// a retry, a double-trigger or a manual charge already made cannot
// produce a second fee.
const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
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
