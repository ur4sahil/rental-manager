// Guards a bug class that is invisible at runtime: a malformed
// PostgREST filter.
//
// escapeFilterValue() escapes LIKE wildcards. It does NOT make a value
// safe inside or=(...) / and(...), where a comma ends the argument and
// parentheses nest. Property addresses carry two commas now that they
// include city, state and zip -- "7200 Bogley, District Heights, MD
// 20747" -- so every or=/and() filter built from an address was
// malformed. PostgREST answers 400 "failed to parse logic tree", the
// caller does `data || []`, and the screen shows "no rows" instead of
// an error. It looked like missing data, not a bug.
//
// Found when the tenant ledger tests started failing; the same
// malformed filter had already been shipped on the tenant-archive path,
// where it silently failed to terminate the tenant's lease.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "  — " + detail : ""}`); }
}

console.log("==============================================");
console.log("PostgREST filter quoting");
console.log("==============================================");

(async () => {
  // helpers.js imports the Supabase client, which will not resolve under
  // plain Node, so the function is lifted out of the source instead. That
  // also means this test fails if the function is renamed or removed.
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "helpers.js"), "utf8");
  const m = src.match(/export function pgrestQuote[\s\S]*?\n\}/);
  if (!m) { console.log("❌ pgrestQuote not found in helpers.js"); process.exit(1); }
  // eslint-disable-next-line no-eval
  const pgrestQuote = eval("(" + m[0].replace("export function", "function") + ")");

  assert("plain value is quoted", pgrestQuote("John Smith") === '"John Smith"', pgrestQuote("John Smith"));
  assert("commas survive quoting",
    pgrestQuote("7200 Bogley, District Heights, MD 20747") === '"7200 Bogley, District Heights, MD 20747"');
  assert("embedded quote is escaped", pgrestQuote('Jim "JJ" Ray') === '"Jim \\"JJ\\" Ray"', pgrestQuote('Jim "JJ" Ray'));
  assert("null/undefined does not throw", pgrestQuote(undefined) === '""' && pgrestQuote(null) === '""');

  const url = process.env.TEST_SUPABASE_URL, key = process.env.TEST_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log("(skipping live filter check: no credentials)");
    console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
    process.exit(failed ? 1 : 0);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const addr = "7200 Bogley, District Heights, MD 20747";

  // The whole point: an address with commas must produce a filter
  // PostgREST accepts.
  const ok = await sb.from("documents").select("id").eq("company_id", "e2e-sandbox")
    .or(`tenant_id.eq.1,and(tenant.eq.${pgrestQuote("John Smith")},property.eq.${pgrestQuote(addr)})`);
  assert("quoted or=/and() filter is accepted", !ok.error, ok.error ? ok.error.message : "200");

  // And prove the unquoted form really is broken, so this test fails
  // loudly if someone reverts to escapeFilterValue here.
  const bad = await sb.from("documents").select("id").eq("company_id", "e2e-sandbox")
    .or(`tenant_id.eq.1,and(tenant.eq.John Smith,property.eq.${addr})`);
  assert("unquoted filter with commas is rejected (proving the guard is real)",
    !!bad.error, bad.error ? bad.error.message.slice(0, 50) : "UNEXPECTEDLY ACCEPTED");

  console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
