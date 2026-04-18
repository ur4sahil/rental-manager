// ─────────────────────────────────────────────────────────────────────────
// One-off backfill: fills properties.county for any legacy row that's
// currently NULL and whose ZIP is covered by the ZIP_TO_COUNTY map in
// src/utils/helpers.js. Anything unresolved stays NULL — the wizard's
// Step 1 validation (commit 336d966) will force the user to pick one on
// the next edit.
//
// Run: from the project root
//     node tests/backfill-property-county.js          → dry-run, shows what would change
//     node tests/backfill-property-county.js --write  → actually updates rows
// ─────────────────────────────────────────────────────────────────────────
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
// Re-declare the map here so this script is self-contained (no bundler).
// Must be kept in sync with src/utils/helpers.js → ZIP_TO_COUNTY.
const ZIP_TO_COUNTY = require("./zip-to-county.json");

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in tests/.env");
  process.exit(1);
}
const svc = createClient(URL, KEY);
const WRITE = process.argv.includes("--write");

async function run() {
  console.log("═══════════════════════════════════════════════════");
  console.log(WRITE ? "🟢 WRITE mode — rows will be updated" : "🔵 DRY-RUN — no changes will be made (pass --write to commit)");
  console.log("═══════════════════════════════════════════════════\n");

  const { data: rows, error } = await svc
    .from("properties")
    .select("id, address, zip, state, county")
    .is("archived_at", null)
    .is("county", null);
  if (error) { console.error("Fetch failed:", error.message); process.exit(1); }

  console.log(`Found ${rows.length} active properties with county=NULL.\n`);

  const unresolved = new Map(); // zip → count
  let resolved = 0, mismatch = 0, updated = 0, failed = 0;

  for (const r of rows) {
    const zip = (r.zip || "").trim();
    const lookup = ZIP_TO_COUNTY[zip];
    if (!lookup) {
      unresolved.set(zip, (unresolved.get(zip) || 0) + 1);
      continue;
    }
    if (r.state && r.state !== lookup.state) {
      console.log(`  ⚠️  state mismatch  id=${r.id}  zip=${zip}  row.state=${r.state}  zip.state=${lookup.state}  — skipping`);
      mismatch++;
      continue;
    }
    resolved++;
    console.log(`  ✅ ${r.id}  zip=${zip}  →  ${lookup.county}`);
    if (WRITE) {
      const patch = { county: lookup.county };
      if (!r.state) patch.state = lookup.state;
      const { error: upErr } = await svc.from("properties").update(patch).eq("id", r.id);
      if (upErr) { console.log(`     ❌ update failed: ${upErr.message}`); failed++; }
      else updated++;
    }
  }

  console.log("\n─── Summary ─────────────────────────────────");
  console.log(`  resolved by ZIP map:     ${resolved}`);
  console.log(`  state mismatches:        ${mismatch}`);
  console.log(`  unresolved ZIPs:         ${rows.length - resolved - mismatch}`);
  if (WRITE) console.log(`  rows actually updated:   ${updated}`);
  if (failed) console.log(`  update failures:         ${failed}`);

  if (unresolved.size > 0) {
    console.log("\n─── Unresolved ZIPs (add to ZIP_TO_COUNTY if needed) ───");
    const sorted = [...unresolved.entries()].sort((a, b) => b[1] - a[1]);
    for (const [zip, count] of sorted) {
      console.log(`  ${zip.padEnd(8)} × ${count}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}
run();
