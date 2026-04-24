// One-shot data fix for Smith Properties LLC:
//   1) Backfill recurring_journal_entries.tenant_id where tenant_id IS NULL
//      but tenant_name matches a tenant on the same company. Without this,
//      autoPostRecurringEntries posts the JE to the GL but skips the
//      update_tenant_balance RPC, so tenants.balance drifts.
//   2) Recompute tenants.balance from each tenant's AR sub-account
//      (1100-xxx) live GL balance. This is the source of truth — what
//      the Move-Out Wizard already reads from after the 2026-04-24 fix.
//
// Both phases run dry-first to print what will change. Re-run with
// `--apply` to actually write.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const COMPANY_ID = "dce4974d-afa9-4e65-afdf-1189b815195d"; // Smith Properties LLC
const APPLY = process.argv.includes("--apply");

(async () => {
  console.log(`Tenant balance sync — Smith Properties LLC (${APPLY ? "APPLY" : "DRY-RUN"})`);
  console.log("================================================================\n");

  // -- Phase 1 — backfill recurring_journal_entries.tenant_id ----
  // Migration 20260424000007 changed the column type from uuid to
  // bigint so backfill is now possible. Match by (tenant_name +
  // property) so a tenant who appears at multiple properties (e.g.
  // Sahil Agarwal) lands the recurring rent on the correct row.
  console.log("Phase 1: backfill recurring_journal_entries.tenant_id\n");
  const { data: tenants } = await sb.from("tenants").select("id, name, property, balance").eq("company_id", COMPANY_ID);
  const byNameProp = {};
  (tenants || []).forEach(t => {
    const k = ((t.name || "") + "::" + (t.property || "")).toLowerCase().trim();
    byNameProp[k] = t;
  });
  const { data: recurs } = await sb.from("recurring_journal_entries")
    .select("id, tenant_name, tenant_id, property")
    .eq("company_id", COMPANY_ID)
    .is("tenant_id", null);
  let matched = 0, unmatched = 0;
  for (const r of (recurs || [])) {
    const k = ((r.tenant_name || "") + "::" + (r.property || "")).toLowerCase().trim();
    const t = byNameProp[k];
    if (!t) { console.log(`  ⚠️  no match: "${r.tenant_name}" / "${r.property}"`); unmatched++; continue; }
    matched++;
    console.log(`  → set tenant_id=${t.id} on recur ${r.id} (${r.tenant_name})`);
    if (APPLY) {
      const { error } = await sb.from("recurring_journal_entries").update({ tenant_id: t.id }).eq("id", r.id);
      if (error) console.log(`    ❌ ${error.message}`);
    }
  }
  console.log(`  ${matched} matched, ${unmatched} unmatched (of ${recurs?.length || 0})`);

  // -- Phase 2 — sync tenants.balance from GL --------------------
  // Skip tenants whose AR sub-account is shared with other tenant rows
  // (same name, different property). The GL has one consolidated balance
  // for that name; we can't split it per-property without a policy
  // decision (rent share? equal split?). Flag those instead.
  console.log("\nPhase 2: recompute tenants.balance from GL AR sub-account\n");
  const nameCount = {};
  (tenants || []).forEach(t => { nameCount[t.name] = (nameCount[t.name] || 0) + 1; });
  const skipped = [];
  for (const t of (tenants || [])) {
    if (nameCount[t.name] > 1) {
      skipped.push(t);
      continue;
    }
    // Find tenant AR account by tenant_id (preferred) or name
    let arId = null;
    const { data: byId } = await sb.from("acct_accounts").select("id").eq("company_id", COMPANY_ID).eq("type", "Asset").eq("tenant_id", t.id).maybeSingle();
    arId = byId?.id || null;
    if (!arId) {
      const { data: byNameAcct } = await sb.from("acct_accounts").select("id").eq("company_id", COMPANY_ID).eq("type", "Asset").eq("name", "AR - " + t.name).maybeSingle();
      arId = byNameAcct?.id || null;
    }
    if (!arId) {
      console.log(`  ${t.name}: no AR sub-account found, skipping`);
      continue;
    }
    const { data: lines } = await sb.from("acct_journal_lines")
      .select("debit, credit, acct_journal_entries!inner(status)")
      .eq("company_id", COMPANY_ID).eq("account_id", arId)
      .neq("acct_journal_entries.status", "voided");
    const glBal = (lines || []).reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
    const stored = Number(t.balance || 0);
    const diff = Math.round((glBal - stored) * 100) / 100;
    const marker = Math.abs(diff) > 0.01 ? "⚠️ " : "  ";
    console.log(`  ${marker}${t.name.padEnd(25)} stored=${stored.toFixed(2).padStart(10)}  GL=${glBal.toFixed(2).padStart(10)}  Δ=${diff.toFixed(2)}`);
    if (APPLY && Math.abs(diff) > 0.01) {
      // Direct UPDATE — the update_tenant_balance RPC has a
      // company_members membership check via JWT email which the
      // service-role caller can't satisfy. Service role bypasses RLS
      // anyway, so the equivalent direct UPDATE is the right tool
      // for a one-shot data sync.
      const { error } = await sb.from("tenants").update({ balance: glBal }).eq("id", t.id).eq("company_id", COMPANY_ID);
      if (error) console.log(`      ❌ ${error.message}`);
    }
  }

  if (skipped.length > 0) {
    console.log("\nSkipped (shared AR sub-account — same name on multiple property rows):");
    for (const t of skipped) {
      console.log(`  ⏭  ${t.name} — ${t.property} (stored=${Number(t.balance || 0).toFixed(2)})`);
    }
    console.log("  These need manual attribution or a per-lease AR sub-account.");
  }

  console.log("\n================================================================");
  console.log(APPLY ? "✓ APPLIED" : "(dry-run only — re-run with --apply to write)");
})();
