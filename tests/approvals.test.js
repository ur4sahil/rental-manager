// An approvable request must be actionable.
//
// Staff without delete rights file a property_change_request for an admin to
// approve. One request type -- 'delete_tenant', written by Tenants.js -- had
// no branch in the approval handler. It appeared exactly once in the entire
// repository: at the insert. So the flow ran end to end and did nothing:
//
//   * Sanya files it            -> row created, "submitted for approval"
//   * the admin sees it         -> labelled "Edit Property: Essence Ford",
//                                  the tenant's name in the address slot
//   * the admin approves it     -> falls through add/edit/delete, matches
//                                  none, status set to 'approved'
//   * the audit trail records   -> "Approved delete_tenant request"
//
// The tenant stayed. Nothing errored, and the audit trail asserted the
// archive had happened -- which is worse than failing, because it is the
// record you would check to find out whether it had.
//
// This suite asserts the RULE, not the instance: every request type any
// insert can write must have an arm in the handler that approves it. A new
// request type added next year without a branch fails here.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

const SRC = path.join(__dirname, "..", "src");
const read = f => fs.readFileSync(path.join(SRC, f), "utf8");
const all = (() => {
  const out = {};
  const walk = d => fs.readdirSync(d).forEach(f => {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".js")) out[path.relative(SRC, p)] = fs.readFileSync(p, "utf8");
  });
  walk(SRC);
  return out;
})();

console.log("\n=== APPROVAL REQUESTS ===\n");

// ---- 1. every filed request type has an approval branch -------------------
// Collect what the app WRITES, then check it against what the handler READS.
// Both sides are measured from source, so neither can be forgotten.
const filed = new Set();
for (const [, src] of Object.entries(all)) {
  for (const m of src.matchAll(/request_type:\s*["'`]([a-z_]+)["'`]/g)) filed.add(m[1]);
}
const properties = read("components/Properties.js");
const handler = properties.slice(
  properties.indexOf("async function approveRequest"),
  properties.indexOf("async function rejectRequest"),
);
const unhandled = [...filed].filter(t =>
  !new RegExp(`request_type === ["'\`]${t}["'\`]`).test(handler));

assert(
  "every request type the app files has an arm in approveRequest",
  unhandled.length === 0,
  `filed but never acted on: ${unhandled.join(", ")}\n   `
  + "A request with no branch is approved, audit-logged as approved, and does nothing.");

// Only two types are ever filed. approveRequest also carries 'add' and
// 'edit' arms, which nothing writes any more -- staff edit properties
// directly now. Dead arms are harmless; a filed type with no arm is not,
// which is why the check above runs in that direction and not this one.
assert("the filed request types are the ones we know about",
  [...filed].sort().join(",") === "delete,delete_tenant",
  `found: ${[...filed].sort().join(", ")} — a new type needs an arm in approveRequest`);

// ---- 2. one implementation of "archive a tenant" -------------------------
// The branch was missing because the work lived inside a component, where
// the only way to reuse it was to write it a second time -- and a second
// copy would have drifted from the first immediately. The procedure carries
// three fixes that were each learned from a production incident: multi-unit
// slot clearing, tenant_id-scoped lease termination, and a write-off that
// credits the tenant's own AR sub-account.
assert("the archive procedure lives in a shared module",
  fs.existsSync(path.join(SRC, "utils", "tenantArchive.js")),
  "src/utils/tenantArchive.js is the single implementation both paths call");

const util = read("utils/tenantArchive.js");
for (const [label, needle] of [
  ["clears only the archived tenant's slot at a multi-unit address", "slotUpdate"],
  ["terminates leases scoped to this tenant", "tenant_id.eq."],
  ["writes off against the tenant's own AR sub-account", "getOrCreateTenantAR"],
  ["deactivates the tenant's AR sub-accounts", 'eq("tenant_id", tenantId)'],
]) assert("the shared archive " + label, util.includes(needle));

assert("both the direct action and the approval call it",
  /archiveTenant\(/.test(read("components/Tenants.js")) && /archiveTenant\(/.test(properties),
  "if either path archives a tenant by hand, the two will diverge");

// Any OTHER place that sets archived_at + lease_status:'past' on a tenant is
// a second implementation, and the weaker one always wins by being shorter.
// Two exist, and they are not the same kind of thing:
//
//   * resolveReview("not_a_tenant") -- legitimately exempt. It archives a
//     row the QuickBooks import misclassified as a tenant: a lender, a title
//     company. There is no lease to terminate, no autopay to disable and no
//     receivable to write off, so running the full procedure would post
//     accounting for a party that was never a tenant.
//
//   * the bulk Archive modal -- FIXED. It used to set archived_at on N
//     tenants and stop: leases stayed 'active', the property slot kept their
//     name, AR sub-accounts stayed open and autopay stayed ENABLED, so a
//     bulk-archived tenant could still be charged. It now runs the shared
//     procedure once per tenant, sequentially. It still matches this pattern
//     only through resolveReview, below.
//
// Named, with the reason, so neither is mistaken for the other -- and the
// count cannot grow past these two without the suite going red.
const ARCHIVE_EXCEPTIONS = [
  ["components/Tenants.js", "resolveReview (misclassified import rows)"],
];
const copies = Object.entries(all).filter(([f, src]) =>
  f !== path.join("utils", "tenantArchive.js")
  && /update\(\{[\s\S]{0,120}archived_at[\s\S]{0,200}lease_status:\s*["'`]past/.test(src));
const unexpected = copies.filter(([f]) => !ARCHIVE_EXCEPTIONS.some(([e]) => e === f));
assert("no NEW place archives a tenant inline",
  unexpected.length === 0,
  unexpected.map(c => c[0]).join(", ") + " archives a tenant without the shared module");
// Bulk archive must go through the module, not around it. It is the path
// most likely to regress back to a single fast .in() update, because that
// version looks obviously better right up until you ask what happened to
// the leases.
const bulkBlock = read("components/Tenants.js");
assert("bulk archive runs the shared procedure per tenant",
  /for \(const tid of eligibleIds\)[\s\S]{0,400}archiveTenant\(/.test(bulkBlock),
  "a bulk .in() update on archived_at leaves leases active and autopay enabled");
assert("bulk archive reports the tenants it could not archive",
  /bulkFailed/.test(bulkBlock),
  "a partial bulk failure that reports only the success count hides the rest");

// ---- 3. the request has to name WHICH tenant ----------------------------
// It used to carry only the name, in the `address` column. Production holds
// five groups of same-name tenants, so approving by name could archive the
// wrong person -- terminating their lease and writing off their balance.
const tenants = read("components/Tenants.js");
const insert = tenants.slice(
  tenants.indexOf('request_type: "delete_tenant"') - 400,
  tenants.indexOf('request_type: "delete_tenant"') + 400);
assert("a tenant archive request records tenant_id",
  /tenant_id:/.test(insert),
  "without an id the approver is guessing between same-name tenants");

assert("approval refuses an ambiguous legacy request rather than guessing",
  /found\.length > 1/.test(handler) && /cannot say which one/.test(handler),
  "rows filed before tenant_id existed carry only a name; two matches must refuse");

assert("approval reports a request whose tenant is already gone",
  /No active tenant named/.test(handler),
  "an already-archived tenant must say so, not silently succeed");

// ---- 4. the label must not lie ------------------------------------------
// Every type that was not "add" was badged "Edit", so a tenant archive
// request read "Edit Property: Essence Ford" in the approvals list.
assert("the approvals list names a tenant request as a tenant request",
  /Archive Tenant/.test(read("components/Admin.js")),
  "Admin.js titled it 'Edit Property: <tenant name>'");
assert("the request badge distinguishes archive from edit",
  /Archive tenant/.test(properties),
  "Properties.js badged everything that was not 'add' as 'Edit'");

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
