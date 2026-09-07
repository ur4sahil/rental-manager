// Error codes must name the actual fault.
//
// Production logged this, three times, from the property setup wizard:
//
//   column "account_number_encrypted" of relation "property_loans"
//   does not exist
//
// It was reported as PM-8002, "A required database table is missing."
// Every table existed. The real fault was three phantom COLUMNS, and
// the misnomer sent the investigation after a missing table instead --
// a schema diff, a sweep of every function, view and policy, and a
// sequence check, all of them clean, before the raw text settled it.
// Postgres phrases a missing column using the words "relation" and
// "does not exist", so the table rule matched first and won.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

// errors.js is an ES module and pulls in the Supabase client, so the
// classifier is lifted out of the source rather than imported -- the
// same technique as pgrest-filters.test.js. It also means this test
// fails loudly if either piece is renamed or removed.
const src = fs.readFileSync(path.join(__dirname, "..", "src", "utils", "errors.js"), "utf8");
const mapSrc = src.match(/const SQLSTATE_MAP = \{[\s\S]*?\n\};/);
const fnSrc = src.match(/export function detectInfrastructureCode[\s\S]*?\n\}/);
if (!mapSrc || !fnSrc) {
  console.log("❌ SQLSTATE_MAP or detectInfrastructureCode not found in errors.js");
  process.exit(1);
}
// eslint-disable-next-line no-eval
const detectInfrastructureCode = eval(
  "(function(){" + mapSrc[0] + "\n" +
  fnSrc[0].replace("export function", "function") +
  "\nreturn detectInfrastructureCode;})()"
);

const REAL = 'column "account_number_encrypted" of relation "property_loans" does not exist';

assert("the wizard's real error is a missing COLUMN, not a missing table",
  detectInfrastructureCode(REAL, "PM-2002") === "PM-8008",
  "got " + detectInfrastructureCode(REAL, "PM-2002"));

assert("SQLSTATE 42703 maps to the column code",
  detectInfrastructureCode({ code: "42703", message: REAL }, "PM-2002") === "PM-8008");

assert("a genuinely missing table still reports as one",
  detectInfrastructureCode('relation "public.widgets" does not exist', "PM-2002") === "PM-8002");

assert("SQLSTATE 42P01 still maps to the table code",
  detectInfrastructureCode({ code: "42P01", message: 'relation "x" does not exist' }, "PM-2002") === "PM-8002");

assert("a missing function is unaffected",
  detectInfrastructureCode('function public.foo() does not exist', "PM-2002") === "PM-8003");

assert("an RLS rejection is unaffected",
  detectInfrastructureCode({ code: "42501", message: 'new row violates row-level security policy for table "app_users"' }, "PM-2002") === "PM-8005");

assert("an unrelated message falls through to the caller's code",
  detectInfrastructureCode("something else entirely", "PM-2002") === "PM-2002");

console.log(`\n✅ Passed: ${passed}   ❌ Failed: ${failed}`);
process.exit(failed ? 1 : 0);
