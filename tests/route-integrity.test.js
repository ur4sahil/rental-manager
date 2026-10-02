// Two whole-app invariants that were each violated in production.
//
// 1. Every page a role is allowed to reach must have a component.
//    "autopay" sat in the admin allowlist with no pageComponents entry,
//    so selecting it silently rendered the Dashboard -- no error, no
//    404, just the wrong page.
// 2. Columns the app writes must exist. Three did not: utilities had no
//    archived_by and inspections had neither archived_at nor
//    archived_by, so deleting a property left its utilities and
//    inspections live while the dialog promised they were removed;
//    tenants had no updated_at, so the concurrent-edit guard never
//    fired once.
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "  — " + detail : ""}`); }
}

console.log("==============================================");
console.log("Route + column integrity");
console.log("==============================================");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.js"), "utf8");

// ---- 1. every allowed page resolves to a component
const pcStart = app.indexOf("const pageComponents = {");
const pcBlock = app.slice(pcStart, app.indexOf("\n};", pcStart));
const pcKeys = new Set([...pcBlock.matchAll(/^\s{2}([a-z_]+):/gm)].map(m => m[1]));

const rolesBlock = app.slice(app.indexOf("const ROLES = {"), app.indexOf("const ALL_NAV = ["));
const rolePages = new Set([...rolesBlock.matchAll(/"([a-z_]+)"/g)].map(m => m[1]));
const orphanPages = [...rolePages].filter(p => !pcKeys.has(p));
assert("every role page has a component", orphanPages.length === 0, orphanPages.join(", ") || "none");

// ---- 2. every nav id resolves to a component
const navBlock = app.slice(app.indexOf("const ALL_NAV = ["), app.indexOf("const ALL_NAV_FLAT"));
const navIds = [...navBlock.matchAll(/id: "([a-z_]+)"/g)].map(m => m[1]);
const orphanNav = navIds.filter(id => !pcKeys.has(id));
assert("every nav id has a component", orphanNav.length === 0, orphanNav.join(", ") || "none");

(async () => {
  // Targets the TEST project, where migrations land first -- production
  // is intentionally behind until Sahil has reviewed on test.housify365.com.
  // The anon key is enough: PostgREST rejects an unknown column with 400
  // before RLS is consulted, so a column that exists returns [] and one
  // that does not returns an error, regardless of what rows are visible.
  const url = process.env.TEST_SUPABASE_URL;
  const key = process.env.TEST_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log("(skipping column checks: no credentials)");
    console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
    process.exit(failed ? 1 : 0);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Columns the client writes and previously did not exist.
  const required = [
    ["utilities", "archived_by"],
    ["inspections", "archived_at"],
    ["inspections", "archived_by"],
    ["tenants", "updated_at"],
    ["payments", "tenant_id"],
    ["documents", "tenant_id"],
    // Utilities "Accounts" tab delete + login save (20260928130000).
    ["utility_accounts", "archived_reason"],
    ["utility_accounts", "credential_key_fp"],
    ["utilities", "credential_key_fp"],
    ["property_loans", "credential_key_fp"],
    // Prospects (20261003010000): the lease link and the files.
    ["doc_generated", "prospect_id"],
    ["documents", "prospect_id"],
    ["acct_accounts", "prospect_id"],
    ["company_settings", "rent_increase_notice_days"],
    ["tenants", "notice_given_on"],
    ["tenants", "forwarding_address"],
  ];
  for (const [table, col] of required) {
    const { error } = await sb.from(table).select(col).limit(1);
    assert(`${table}.${col} exists`, !error, error ? error.message : "");
  }

  // The prospects table holds applicants' names, emails and lease terms, and
  // nothing public reads it. A logged-out request must be refused outright
  // (no table privilege at all), not merely filtered to zero rows by RLS --
  // "permission denied" proves both that the table exists and that the
  // public key cannot touch it.
  {
    const { error } = await sb.from("prospects").select("id, attention, converted_tenant_id").limit(1);
    assert("prospects exists and refuses the public key", !!error && /permission denied/i.test(error.message || ""), error ? error.message : "anon could read it");
  }

  // Same for lease_changes (20261003040000): a tenant's upcoming rent and
  // renewal terms. Refused outright for the public key.
  {
    const { error } = await sb.from("lease_changes").select("id, doc_id, effective_date, payload").limit(1);
    assert("lease_changes exists and refuses the public key", !!error && /permission denied/i.test(error.message || ""), error ? error.message : "no error: the public key can read it");
  }

  console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
