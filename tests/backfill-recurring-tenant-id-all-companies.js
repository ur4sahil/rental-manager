// Backfill recurring_journal_entries.tenant_id for every company.
//
// Phase 1 from sync-tenant-balances.js generalized: matches each
// row by (company_id, tenant_name, property) → tenants.id. This is
// the prerequisite for adding the (tenant_name IS NULL) =
// (tenant_id IS NULL) CHECK constraint cleanly.
//
// Does NOT touch tenants.balance — that's a per-company audit
// (Smith done separately). Only sets tenant_id on rows that
// already have a clean (name+property) match in tenants.
//
// Run dry: node backfill-recurring-tenant-id-all-companies.js
// Run apply: node backfill-recurring-tenant-id-all-companies.js --apply

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");

(async () => {
  console.log(`Backfill recurring_journal_entries.tenant_id (${APPLY ? "APPLY" : "DRY-RUN"})`);
  console.log("================================================================\n");

  // Find every row with tenant_name set but tenant_id null.
  const { data: rows } = await sb.from("recurring_journal_entries")
    .select("id, company_id, tenant_name, property")
    .not("tenant_name", "is", null).neq("tenant_name", "")
    .is("tenant_id", null);

  if (!rows || rows.length === 0) { console.log("No rows need backfill."); return; }

  // Group by company so we can fetch tenants once per company.
  const byCompany = {};
  for (const r of rows) (byCompany[r.company_id] ||= []).push(r);

  let totalMatched = 0, totalUnmatched = 0, totalUpdated = 0, totalErr = 0;
  for (const [companyId, list] of Object.entries(byCompany)) {
    console.log(`[${companyId}] ${list.length} rows to consider`);
    const { data: tenants } = await sb.from("tenants")
      .select("id, name, property")
      .eq("company_id", companyId);
    const idx = {};
    (tenants || []).forEach(t => {
      const k = ((t.name || "") + "::" + (t.property || "")).toLowerCase().trim();
      idx[k] = t.id;
    });
    for (const r of list) {
      const k = ((r.tenant_name || "") + "::" + (r.property || "")).toLowerCase().trim();
      const tid = idx[k];
      if (!tid) {
        console.log(`  ⚠️  no match: "${r.tenant_name}" / "${r.property}"`);
        totalUnmatched++;
        continue;
      }
      totalMatched++;
      console.log(`  → ${r.id} → tenant_id=${tid} (${r.tenant_name})`);
      if (APPLY) {
        const { error } = await sb.from("recurring_journal_entries")
          .update({ tenant_id: tid }).eq("id", r.id);
        if (error) { console.log(`    ❌ ${error.message}`); totalErr++; }
        else totalUpdated++;
      }
    }
  }

  console.log("\n================================================================");
  console.log(`Matched: ${totalMatched}  Unmatched: ${totalUnmatched}`);
  if (APPLY) console.log(`Updated: ${totalUpdated}  Errors: ${totalErr}`);
  console.log(APPLY ? "✓ APPLIED" : "(dry-run only)");

  // Verify post-condition (only meaningful in apply mode)
  if (APPLY) {
    const { data: leftover } = await sb.from("recurring_journal_entries")
      .select("id").not("tenant_name", "is", null).neq("tenant_name", "").is("tenant_id", null);
    console.log(`\nPost-check: ${leftover?.length || 0} rows still violate (tenant_name set, tenant_id null)`);
  }
})();
