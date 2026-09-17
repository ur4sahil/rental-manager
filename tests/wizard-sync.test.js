// The wizard must not write stale values over newer ones.
//
// commit_property_wizard writes EIGHT tables, and reopening a COMPLETED
// wizard restored all of them from wizard_data -- a snapshot of the form as
// it was when the wizard last finished. An edit made afterwards on the
// Utilities, HOA, Loans, Insurance, Tax Bills or Tenants page was therefore
// overwritten the next time anyone saved the wizard for any reason.
//
// The tenant step was the last and worst, because fixing it exposed a second
// bug underneath: the deposit and first month's rent are de-duplicated by a
// reference built from the lease START DATE. Reading a corrected date changes
// the reference, the duplicate check misses, and the deposit posts AGAIN.
// The stale snapshot had been hiding that by writing the old date back.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

const props = fs.readFileSync(path.join(__dirname, "..", "src", "components", "Properties.js"), "utf8");

console.log("\n=== WIZARD / PAGES SYNC ===\n");

// ---- 1. the live tables are read on reopening a completed wizard ---------
assert("reopening a completed wizard reads the live tables",
  /await loadLiveWizardData\(addr\)/.test(props),
  "restoring only from wizard_data is what overwrote newer edits");

for (const [what, needle] of [
  ["hoa_payments", 'from("hoa_payments")'],
  ["utilities", 'from("utilities")'],
  ["property_loans", 'from("property_loans")'],
  ["property_insurance", 'from("property_insurance")'],
  ["property_taxes", 'from("property_taxes")'],
  ["tenants", 'from("tenants")'],
  ["leases", 'from("leases")'],
  ["recurring_journal_entries", 'from("recurring_journal_entries")'],
]) {
  const fn = props.slice(props.indexOf("async function loadLiveWizardData"),
                         props.indexOf("async function commitWizard"));
  assert(`the live read covers ${what}`, fn.includes(needle),
    `${what} is written by the commit, so it must be read back or it gets stale values`);
}

// ---- 2. the deposit posts at most once, whatever the date does ----------
// The references are DEP-T<id>-<leaseStart>. Matching them EXACTLY meant a
// corrected lease start produced a reference that was not in the posted set,
// and the deposit posted again. The prefix is stable; the date is not.
assert("the deposit check is the SHARED cross-path one",
  /const depPosted = await depositAlreadyPosted\(companyId, resTenantId\)/.test(props),
  "four places post this deposit; each having its own check is how it double-posted");

assert("first-month and prorated rent match by reference PREFIX, not the date",
  /\.like\('reference', fam \+ tPrefix \+ '%'\)/.test(props)
  && /const tPrefix = escapeFilterValue\('T' \+ resTenantId \+ '-'\)/.test(props),
  "an exact-reference check charges the first month again when the lease start moves");

assert("a FAILED posted-already lookup counts as posted",
  /r\.error \|\| \(r\.data \|\| \[\]\)\.length/.test(props),
  "treating a query error as 'nothing posted' is how a duplicate deposit gets through");

// REGRESSION GUARD. Gating these posts on 'first commit' looks like the
// obvious fix and silently breaks onboarding: "Add Tenant" on an existing
// vacant property opens the wizard with a property id ALREADY set, so a
// first-commit gate skips a genuine first deposit -- and it would also skip
// autoPostRecurringEntries, which sits in the same block and must run every
// time to catch up missed periods.
assert("the posts are NOT gated on being a first commit",
  !/isFirstCommit/.test(props),
  "savedPropertyId is set at mount for Add Tenant and every Edit; gating on it stops real postings");

assert("the recurring catch-up still runs on every commit",
  /await autoPostRecurringEntries\(companyId\)/.test(props),
  "this is what posts rent for periods between the lease start and today");

assert("the lease is treated as the authority on its own dates",
  /lease\?\.start_date \|\| primary\.lease_start/.test(props),
  "tenants carries a denormalised copy of the lease dates that can lag behind");

assert("recurring start_date is NOT overwritten from next_post_date",
  /Deliberately NOT overwriting start_date from next_post_date/.test(props),
  "next_post_date rolls forward, so copying it would drag the floor forward every save");

// ---- 3. the commit deletes only what the user removed -------------------
assert("the commit reports what the form was holding",
  /hoas_seen: seenHoaNames\.current/.test(props) && /utilities_seen: seenUtilProviders\.current/.test(props),
  "without this the RPC cannot tell 'removed' from 'added while you were editing'");

// ---- 4. an in-progress wizard still trusts its snapshot ----------------
// That work has never been committed and exists nowhere else.
assert("the live read is scoped to COMPLETED wizards",
  props.indexOf("await loadLiveWizardData(addr)") > props.indexOf("wizard data restore (edit mode)"),
  "an in-progress draft must keep its snapshot -- nothing else holds that work");

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
