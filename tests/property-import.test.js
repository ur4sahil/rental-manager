// Bulk property import — pure logic, checked against the real Sahil LLC
// data in the test database rather than invented fixtures.
//
// Two things here are load-bearing and worth attacking:
//   - computeAddress() must agree with the database's
//     compute_property_address() on every real row, because the preview
//     predicts which properties are about to be renamed. If it disagrees,
//     the preview lies and someone approves a rename they didn't see.
//   - inferTenantStatus() decides whether a person is a current tenant.
//     Getting it wrong marks a live tenancy as ended.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✅" : "❌"} ${n}${d ? "  — " + d : ""}`); };

(async () => {
const { inferTenantStatus, computeAddress, cellDate, cellNumber, cellString,
        PROPERTY_COLUMNS, TENANT_COLUMNS } =
  await import(path.join(__dirname, "..", "src", "utils", "propertyImport.js"));

// ---- cell coercion, including the shapes ExcelJS actually produces ----
assert("cellString unwraps a formula cell", cellString({ result: "abc" }) === "abc");
assert("cellString unwraps rich text", cellString({ richText: [{ text: "a" }, { text: "b" }] }) === "ab");
assert("cellString on null is empty", cellString(null) === "");
assert("cellNumber strips $ and commas", cellNumber("$1,250.50") === 1250.5);
assert("cellNumber blank is null, not 0", cellNumber("  ") === null,
  "0 would silently zero a rent");
assert("cellNumber flags garbage as NaN", Number.isNaN(cellNumber("twelve")));
assert("cellDate passes ISO through", cellDate("2026-03-04") === "2026-03-04");
assert("cellDate converts US format", cellDate("3/4/2026") === "2026-03-04");
assert("cellDate handles a Date object without day drift",
  cellDate(new Date(Date.UTC(2026, 2, 4))) === "2026-03-04");
assert("cellDate handles an Excel serial", cellDate(46085) === "2026-03-04",
  cellDate(46085));
assert("cellDate flags garbage as NaN", Number.isNaN(cellDate("last tuesday")));
assert("cellDate on blank is null", cellDate("") === null);

// ---- column definitions -------------------------------------------
assert("Property ID column is locked", PROPERTY_COLUMNS.find(c => c.key === "id").locked === true);
assert("Tenant ID column is locked", TENANT_COLUMNS.find(c => c.key === "id").locked === true);
assert("context columns are read-only and prefixed",
  TENANT_COLUMNS.filter(c => c.key.startsWith("_")).every(c => c.readOnly === true));
assert("street address is required", PROPERTY_COLUMNS.find(c => c.key === "address_line_1").required === true);
assert("no duplicate column keys",
  new Set(PROPERTY_COLUMNS.map(c => c.key)).size === PROPERTY_COLUMNS.length &&
  new Set(TENANT_COLUMNS.map(c => c.key)).size === TENANT_COLUMNS.length);

// ---- against the real database -------------------------------------
  // Runs against the TEST environment, never production — this suite
  // reads the same data a real import would touch.
  const TEST_URL = process.env.TEST_SUPABASE_URL;
  const TEST_KEY = process.env.TEST_SUPABASE_ANON_KEY;
  if (!TEST_URL || !TEST_KEY) {
    console.log("\n(skipping database checks: TEST_SUPABASE_URL/ANON_KEY not set)");
    console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
    process.exit(fail ? 1 : 0);
  }
  const sb = createClient(TEST_URL, TEST_KEY);
  const { error: authErr } = await sb.auth.signInWithPassword({
    email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD,
  }).catch(() => ({ error: { message: "no key" } }));

  if (authErr) {
    console.log(`\n(skipping database checks: ${authErr.message})`);
    console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
    process.exit(fail ? 1 : 0);
  }

  const { data: props } = await sb.from("properties")
    .select("id,address,address_line_1,address_line_2,city,state,zip");
  assert("read real properties", (props || []).length > 0, `${(props || []).length}`);

  // The load-bearing agreement: our JS must reproduce the trigger's output.
  const mismatches = (props || []).filter(p => computeAddress(p) !== (p.address || ""));
  assert("computeAddress matches the database on every real property",
    mismatches.length === 0,
    mismatches.slice(0, 2).map(p => `${JSON.stringify(computeAddress(p))} != ${JSON.stringify(p.address)}`).join(" ; "));

  console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
