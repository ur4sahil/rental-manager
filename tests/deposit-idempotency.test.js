// A tenant's security deposit must be posted once, from any of the four
// places that post it: the property setup wizard, the property form, the
// Tenants page and the Leases page.
//
// Three of the four used `"DEP-" + shortId()` -- a RANDOM reference -- so no
// path could see another's posting, and none could see its own on a re-save.
// Onboard on the Tenants page, then save the wizard, and the deposit was on
// the books twice. The sandbox company has one property carrying five, same
// date, five different random references.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}
const src = f => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
const acct = src("utils/accounting.js");
const PATHS = {
  "the wizard": "components/Properties.js",
  "the property form": "components/Properties.js",
  "the Tenants page": "components/Tenants.js",
  "the Leases page": "components/Leases.js",
};

console.log("\n=== SECURITY DEPOSIT IDEMPOTENCY ===\n");

// ---- 1. ONE place posts a deposit: the shared engine --------------------
// (2026-10-02) The four screens used to carry four copies of the posting.
// They now hand over to startTenancyBooks (utils/tenantOnboarding.js), so
// "every path uses the same reference and the same check" is true by
// construction rather than by four people remembering.
const engine = src("utils/tenantOnboarding.js");
for (const [label, file] of Object.entries(PATHS)) {
  const body = src(file);
  assert(`${label} no longer posts a deposit itself`,
    !/description: ['"]Security deposit received/.test(body),
    "a second copy of the posting is how the four paths drifted apart");
  assert(`${label} no longer mints a random deposit reference`,
    !/['"]DEP-['"] \+ shortId\(\)/.test(body));
}
for (const file of new Set(Object.values(PATHS))) {
  assert(`${file} hands over to the shared engine`,
    /startTenancyBooks\(|<StartTenancyModal /.test(src(file)));
}
assert("the dialog three screens share calls the engine", /startTenancyBooks\(\{/.test(src("components/StartTenancyModal.js")));

// ---- 2. the engine uses the one shared reference and the one check -----
const depositCallSites = engine.match(/description: "Security deposit received/g) || [];
assert("the engine posts the deposit in exactly one place", depositCallSites.length === 1, `${depositCallSites.length} site(s)`);
const depStep = engine.slice(engine.indexOf("// ── 3. security deposit"), engine.indexOf("// ── 4. first month's rent"));
assert("the deposit is checked with depositAlreadyPosted BEFORE it is posted",
  depStep.indexOf("depositAlreadyPosted(companyId, tid)") > -1 && depStep.indexOf("depositAlreadyPosted(companyId, tid)") < depStep.indexOf("atomicPostJEAndLedger("));
assert("the deposit is posted under depositReference(tenant id)", /reference: depositReference\(tid\)/.test(depStep));

// ---- 3. the reference must not collapse when the id is missing ---------
// 'DEP-T' + undefined is 'DEP-Tundefined'. Under a UNIQUE index that is ONE
// row per company, so the second tenant-less deposit anywhere would be
// silently refused.
assert("depositReference returns null rather than 'DEP-Tundefined'",
  /tenantId === null \|\| tenantId === undefined \|\| tenantId === ''\) \? null/.test(acct),
  "a stringified undefined in a unique key blocks every later tenant-less deposit");
assert("the engine refuses to run at all without a tenant id (nothing to key a deposit on)",
  /tenantId === null \|\| tenantId === undefined \|\| tenantId === "" \|\| !tenantName \|\| !property\) \{\s*add\("input", "Tenant details", "failed"/.test(engine));

// ---- 4. the check must fail CLOSED ------------------------------------
const fn = acct.slice(acct.indexOf("export async function depositAlreadyPosted"));
const fnBody = fn.slice(0, fn.indexOf("\n}"));
assert("a lookup error reports 'already posted', not 'not posted'",
  /if \(exact\.error \|\| legacy\.error\) return true/.test(fnBody),
  "reading a network blip as 'nothing posted' is how a duplicate gets through");
assert("a thrown error also reports 'already posted'",
  /catch \(_e\) \{\s*return true;/.test(fnBody));
assert("a missing company or tenant id does NOT claim already-posted",
  /if \(!companyId \|\| !tenantId\) return false;/.test(fnBody),
  "with no id there is nothing to check, and blocking would lose a real deposit");

// ---- 5. the legacy date-keyed wizard reference is still recognised -----
assert("the old DEP-T<id>-<leaseStart> rows are still matched",
  /canonical \+ '-'\)? \+ '%'/.test(fnBody) || /canonical \+ '-'/.test(fnBody),
  "real data carries the wizard's earlier date-keyed references");
assert("the legacy match is escaped before being used in a LIKE",
  /escapeFilterValue\(canonical \+ '-'\)/.test(fnBody),
  "unescaped % or _ in a LIKE pattern is a wildcard");

// ---- 6. the database is the actual enforcement ------------------------
// idx_je_company_reference_unique is UNIQUE (company_id, reference)
// WHERE status <> 'voided' AND reference <> ''. A deterministic reference is
// what lets that index do the work for paths written later.
assert("the helper documents the index that enforces this",
  /idx_je_company_reference_unique/.test(acct),
  "the reason a deterministic reference is the fix, not just a nicer key");

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
