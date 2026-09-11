// Adversarial tests for sameAddress/normalizeAddress.
//
// helpers.js imports the Supabase client, so it cannot be imported in
// plain node. Extract the two functions from the real source and evaluate
// them, so this tests the shipped implementation rather than a copy that
// can drift away from it.
import fs from "fs";
import path from "path";
const src = fs.readFileSync(path.join(import.meta.dirname, "../src/utils/helpers.js"), "utf8");
const grab = (name) => {
  const i = src.indexOf(`export const ${name} =`);
  if (i < 0) throw new Error(`${name} not found in helpers.js`);
  const end = src.indexOf("\nexport ", i + 10);
  return src.slice(i, end < 0 ? undefined : end).replace(/^export /, "");
};
const { sameAddress, normalizeAddress } = await import(
  "data:text/javascript," + encodeURIComponent(
    `${grab("normalizeAddress")}\n${grab("sameAddress")}\nexport { sameAddress, normalizeAddress };`)
);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("  ❌", m)); };

// Must match: differ only by case or whitespace.
ok(sameAddress("13431 Marble Rock Dr, Chantilly, VA 20151 ", "13431 Marble Rock Dr, Chantilly, VA 20151"), "trailing space (the real Rent Roll failure)");
ok(sameAddress(" 123 Oak St", "123 Oak St "), "leading + trailing");
ok(sameAddress("123  Oak   St", "123 Oak St"), "repeated inner spaces");
ok(sameAddress("123 OAK ST", "123 oak st"), "case");
ok(sameAddress("123 Oak St\t", "123 Oak St"), "tab");
ok(sameAddress("123 Oak St\n", "123 Oak St"), "newline");

// Must NOT match: genuinely different places. Collapsing a unit suffix
// would attach one unit's tenant to the whole building and, with several
// units, show the wrong tenant's name and rent.
ok(!sameAddress("100 Oak Street, Unit A", "100 Oak Street"), "unit suffix must NOT collapse");
ok(!sameAddress("200 Maple Ave, Apt 2B", "200 Maple Ave"), "apt suffix must NOT collapse");
ok(!sameAddress("100 Oak Street, Unit A", "100 Oak Street, Unit B"), "different units");
ok(!sameAddress("123 Oak St", "124 Oak St"), "different street number");

// Must NOT match on absent values: two unset addresses are not the same
// address, or every tenant with no property would match every property
// with no address.
ok(!sameAddress("", ""), "empty vs empty");
ok(!sameAddress(null, null), "null vs null");
ok(!sameAddress(undefined, undefined), "undefined vs undefined");
ok(!sameAddress("   ", "  "), "whitespace-only vs whitespace-only");
ok(!sameAddress(undefined, "123 Oak St"), "undefined vs real");
ok(normalizeAddress(null) === "", "normalize(null) is empty");
ok(normalizeAddress(undefined) === "", "normalize(undefined) is empty");

console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
process.exit(fail ? 1 : 0);
