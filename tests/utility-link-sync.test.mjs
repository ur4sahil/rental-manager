// A wizard edit of a utility (type, website, provider, account number, who
// pays) must reach the Utilities page's account row. Live on TEST, rolled
// back row-by-row; static check on the migration.
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
require("./sandbox-env");
const { createClient } = require("@supabase/supabase-js");
let passed = 0, failed = 0;
const assert = (n, ok, d = "") => { if (ok) { passed++; console.log("  ✅ " + n); } else { failed++; console.log("  ❌ " + n + (d ? "  — " + d : "")); } };
const mig = fs.readFileSync(new URL("../supabase/migrations/20260929070000_utility_link_type_website.sql", import.meta.url), "utf8");
assert("bridge UPDATE syncs type -> account_type", /account_type = CASE WHEN NEW\.type IS DISTINCT FROM OLD\.type/.test(mig));
assert("bridge UPDATE syncs website", /website = CASE WHEN NEW\.website IS DISTINCT FROM OLD\.website/.test(mig));

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const co = "sandbox-llc";
const { data: p } = await sb.from("properties").select("address").eq("company_id", co).is("archived_at", null).limit(1).single();
const { data: u, error } = await sb.from("utilities").insert({ company_id: co, property: p.address, provider: "QA-LINKSYNC Power", type: "Electric", account_number: "LS-1", amount: 0, status: "pending", website: "https://old.example", responsibility: "owner" }).select("id").single();
try {
  if (error) throw error;
  await sb.from("utilities").update({ type: "Gas", website: "https://new.example", provider: "QA-LINKSYNC Gas", account_number: "LS-2", responsibility: "tenant" }).eq("id", u.id);
  const { data: a } = await sb.from("utility_accounts").select("account_type, website, provider_display, account_number, responsibility").eq("legacy_utility_id", u.id).single();
  assert("type reaches the account", a.account_type === "gas", a.account_type);
  assert("website reaches the account", a.website === "https://new.example", a.website);
  assert("provider, account number, who pays still reach it", a.provider_display === "QA-LINKSYNC Gas" && a.account_number === "LS-2" && a.responsibility === "tenant", JSON.stringify(a));
} finally {
  // The owner->tenant switch also creates an owner final-bill closeout line
  // (and its account): clean everything the test touched, by tag.
  const { data: left } = await sb.from("utilities").select("id").eq("company_id", co).ilike("provider", "QA-LINKSYNC%");
  const ids = (left || []).map(r => r.id);
  if (ids.length) { await sb.from("utility_accounts").delete().in("legacy_utility_id", ids); await sb.from("utilities").delete().in("id", ids); }
  await sb.from("utility_accounts").delete().eq("company_id", co).ilike("provider", "QA-LINKSYNC%");
  const { count } = await sb.from("utilities").select("id", { count: "exact", head: true }).ilike("provider", "QA-LINKSYNC%");
  assert("cleanup: no leftovers", count === 0);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
