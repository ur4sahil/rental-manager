// The client's address formula must agree with the database's, to the character.
//
// properties.address is a DERIVED column: the sync_addr_ins/upd triggers
// compute it from the component columns via compute_property_address(). The
// client needs the same value before a row exists -- to pre-check for a
// duplicate address, and to stamp a document uploaded mid-wizard -- so it
// carries a port. A port that drifts is worse than no port: a document
// stamped with a near-miss address is invisible on the property page, and
// nothing errors.
//
// Three implementations of this existed. computeCompositeAddress() in
// Properties.js (Apr 15), commit_property_wizard's own concatenation
// (Apr 22), and the trigger (Sep 4) which arrived last and took ownership
// of the column without the older two being retired. Measured across 292
// live properties: properties.address equalled the trigger's output every
// time, and the RPC's formula differed on four -- so on those four a wizard
// edit filed the property's utilities, HOA and documents under an address
// the Properties page never queries.
//
// The RPC now calls compute_property_address itself and re-reads the stored
// value. This file guards the remaining copy, the JS one.
//
// EXPECTATIONS BELOW ARE NOT HAND-WRITTEN. Each was produced by running
// compute_property_address() on the database with those exact inputs, on
// 2026-09-16, and pasted back. If this suite fails, the port has drifted --
// re-run the function rather than adjusting the expectation to match.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

// Load the function out of helpers.js without pulling in the whole module
// (it imports the Supabase client, which needs env vars this suite has no
// business requiring).
const src = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "helpers.js"), "utf8");
const m = src.match(/export function composePropertyAddress\([\s\S]*?\n\}/);
if (!m) {
  console.log("❌ composePropertyAddress not found in src/utils/helpers.js");
  process.exit(1);
}
// eslint-disable-next-line no-eval
const composePropertyAddress = eval("(" + m[0].replace(/^export /, "") + ")");

console.log("\n=== ADDRESS FORMULA ===\n");

const CASES = [
  // [line1, line2, city, state, zip, expected-from-the-database]
  ["8453 Greenbelt Rd", "101", "Greenbelt", "MD", "20770", "8453 Greenbelt Rd, 101, Greenbelt, MD 20770"],
  // leading space in city: the real divergence on production property 551
  ["1040 alice ave", "unit 204", " Oxon Hill", "MD", "20745", "1040 alice ave, unit 204, Oxon Hill, MD 20745"],
  // trailing space in city: production property 145
  ["4826 Cross meadow pl", "", "Chantilly ", "VA", "20151", "4826 Cross meadow pl, Chantilly, VA 20151"],
  // a comma that came in WITH the data. The database keeps it; the old RPC
  // formula stripped it, which is why neither was uniformly "better" and why
  // there must only be one. Production properties 1131 and 1172.
  ["2311 Columbia Pl,", "", "", "", "", "2311 Columbia Pl,"],
  ["1865 Dutch Village", "J-290", " Hyattsville ", "MD", "20785", "1865 Dutch Village, J-290, Hyattsville, MD 20785"],
  // no state and no zip: the old client formula produced state + " " + zip
  // = " ", which passes filter(Boolean), leaving a stray ", " on the end
  ["12 Main St", "", "Bowie", "", "", "12 Main St, Bowie"],
  ["9 Oak Ave", "", "", "MD", "20601", "9 Oak Ave, MD 20601"],
  ["  padded  ", "  unit 3  ", "  Town  ", "  VA  ", "  22030  ", "padded, unit 3, Town, VA 22030"],
  ["Only Line One", "", "", "", "", "Only Line One"],
  ["", "", "Orphan City", "MD", "20001", "Orphan City, MD 20001"],
];

for (const [l1, l2, city, state, zip, expected] of CASES) {
  const got = composePropertyAddress({
    address_line_1: l1, address_line_2: l2, city, state, zip,
  });
  assert(`[${l1}|${l2}|${city}|${state}|${zip}] → "${expected}"`,
    got === expected, `got "${got}"`);
}

// Nothing in, nothing out -- and no crash. The wizard calls this on an empty
// form every time it opens.
assert("an empty form composes to an empty string",
  composePropertyAddress({}) === "" && composePropertyAddress() === "",
  `got "${composePropertyAddress({})}" / "${composePropertyAddress()}"`);

assert("null and undefined parts do not become the string \"null\"",
  composePropertyAddress({ address_line_1: "1 A St", address_line_2: null, city: undefined, state: "MD", zip: "20001" })
    === "1 A St, MD 20001",
  `got "${composePropertyAddress({ address_line_1: "1 A St", address_line_2: null, city: undefined, state: "MD", zip: "20001" })}"`);

// The old formula must not come back. It is a one-liner that looks correct.
const props = fs.readFileSync(path.join(__dirname, "..", "src", "components", "Properties.js"), "utf8");
// Narrowed to formulas that compose the FULL address from the component
// fields. A card that prints "city, state, zip" for display is a different
// thing and legitimately joins with commas.
//
// The broad version of this check earned its keep immediately: it found two
// MORE formulas in saveProperty that the first pass had missed, bringing the
// count to five. One of them joined state and zip with ", " and was used as
// the duplicate-address check -- against production it can only match 92 of
// 292 live addresses, so for the other 200 it has never caught a duplicate.
const FULL_ADDRESS_FORMULA = /\[\s*(form|propForm|p)\.address_line_1[\s\S]{0,160}?\.filter\(Boolean\)\.join\(", "\)/;
assert("nothing composes a full address except the shared function",
  !FULL_ADDRESS_FORMULA.test(props),
  "an inline [address_line_1, …].filter(Boolean).join(', ') is back in Properties.js — use composePropertyAddress");

assert("the wizard delegates to the shared function",
  /composePropertyAddress\(propForm\)/.test(props),
  "computeCompositeAddress must call the shared port, not compose its own");

// There were SIX copies in the end, not three: the wizard, the RPC, the
// trigger, two in saveProperty, and computeAddress in propertyImport.js. That
// last one was a CORRECT mirror -- which is exactly how a duplicate survives
// review, since being right today says nothing about staying in step.
const imp = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "propertyImport.js"), "utf8");
assert("the importer delegates rather than mirroring",
  /computeAddress = composePropertyAddress/.test(imp),
  "propertyImport.js has its own copy of the formula again");

const helpers = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "helpers.js"), "utf8");
assert("there is exactly one definition of the formula",
  (helpers.match(/export function composePropertyAddress/g) || []).length === 1,
  "composePropertyAddress must be defined once, in helpers.js");

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
