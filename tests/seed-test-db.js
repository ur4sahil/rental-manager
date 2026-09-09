// Copy the two fixture companies the database suites depend on from
// production into the TEST project.
//
//   node seed-test-db.js
//
// The 20 database suites are written against "Sandbox LLC" and "Smith
// Properties LLC". Both live in production, so repointing the suite at
// the test project (see sandbox-env.js) left them failing on absent
// fixtures rather than on anything real -- the test project has neither
// company.
//
// READS production. WRITES only the test project. There is no mutating
// call on the production client anywhere in this file.
//
// Idempotent: rows whose id already exists in the test project are
// skipped, so re-running tops up rather than duplicating.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");

const PROD_REF = "hoymytpyaudjvsgiiibn";
const TEST_REF = "vpeewlplgxthckpidhxo";

const prodUrl = process.env.SUPABASE_URL;
const prodKey = process.env.SUPABASE_SERVICE_KEY;
const testUrl = process.env.TEST_SUPABASE_URL;
const testKey = process.env.TEST_SUPABASE_SERVICE_KEY;

if (!prodUrl || !prodUrl.includes(PROD_REF)) { console.error("SUPABASE_URL is not the production project"); process.exit(1); }
if (!testUrl || !testUrl.includes(TEST_REF)) { console.error("TEST_SUPABASE_URL is not the test project"); process.exit(1); }
if (!testKey) { console.error("TEST_SUPABASE_SERVICE_KEY is not set — see sandbox-env.js"); process.exit(1); }

const prod = createClient(prodUrl, prodKey, { auth: { persistSession: false } });
const test = createClient(testUrl, testKey, { auth: { persistSession: false } });

const COMPANIES = ["sandbox-llc", "dce4974d-afa9-4e65-afdf-1189b815195d"];

// FK order: a child is never copied before its parent.
const TABLES = [
  "acct_accounts", "acct_classes", "properties", "tenants", "leases",
  "acct_journal_entries", "acct_journal_lines", "payments",
  "company_members", "company_settings", "utilities", "hoa_payments",
  "property_loans", "property_insurance", "property_taxes",
  "recurring_journal_entries", "work_orders", "documents", "owners",
];

// PostgREST caps a response at 1000 rows, so page rather than trusting
// a single select to return everything.
async function pageAll(client, table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from(table).select("*")
      .in("company_id", COMPANIES).range(from, from + 999);
    if (error) return { rows: null, error };
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { rows: out };
}

(async () => {
  const { data: comps, error: cErr } = await prod.from("companies").select("*").in("id", COMPANIES);
  if (cErr) { console.error("read companies:", cErr.message); process.exit(1); }

  const { data: existingComps } = await test.from("companies").select("id").in("id", COMPANIES);
  const haveComp = new Set((existingComps || []).map(c => c.id));
  const newComps = (comps || []).filter(c => !haveComp.has(c.id));
  if (newComps.length) {
    const { error } = await test.from("companies").insert(newComps);
    if (error) { console.error("write companies:", error.message); process.exit(1); }
  }
  console.log(`companies                 ${newComps.length} copied, ${haveComp.size} already present`);

  for (const table of TABLES) {
    const { rows, error } = await pageAll(prod, table);
    if (error) { console.log(`${table.padEnd(26)}skipped (${error.message.slice(0, 60)})`); continue; }
    if (!rows.length) { console.log(`${table.padEnd(26)}nothing in production`); continue; }

    // Skip ids already in the test project so a re-run tops up.
    // .in() takes at most 100 values per call.
    const ids = rows.map(r => r.id).filter(v => v !== undefined && v !== null);
    const have = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await test.from(table).select("id").in("id", ids.slice(i, i + 100));
      (data || []).forEach(r => have.add(String(r.id)));
    }
    const fresh = rows.filter(r => !have.has(String(r.id)));
    if (!fresh.length) { console.log(`${table.padEnd(26)}all ${rows.length} already present`); continue; }

    let written = 0, failed = 0, firstErr = "";
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      const { error: wErr } = await test.from(table).insert(chunk);
      if (wErr) {
        // One bad row must not cost the whole batch — retry singly so as
        // much of the fixture lands as can.
        for (const row of chunk) {
          const { error: rErr } = await test.from(table).insert([row]);
          if (rErr) { failed++; if (!firstErr) firstErr = rErr.message; } else written++;
        }
      } else written += chunk.length;
    }
    console.log(`${table.padEnd(26)}${written} copied${failed ? `, ${failed} failed (${firstErr.slice(0, 60)})` : ""}`);
  }

  console.log("\ndone — production was only read from");
})();
