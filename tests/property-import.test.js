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

  // ---- round trip: build a template from real data, edit it, read it back
  const ExcelJS = require(path.join(__dirname, "..", "node_modules", "exceljs"));
  const { buildTemplate, parseWorkbook, buildImportPlan } =
    await import(path.join(__dirname, "..", "src", "utils", "propertyImport.js"));

  const { data: tRows } = await sb.from("tenants").select("id,name,property,balance");
  const existingProperties = props.map(p => ({ ...p, short_name: p.address }));
  const existingTenants = (tRows || []).map(t => ({ ...t, tenant_status: "Current" }));

  const wb = await buildTemplate(ExcelJS, {
    companyName: "Sahil LLC", properties: existingProperties, tenants: existingTenants,
    owners: ["Sigma Housing LLC"], blankRows: 5,
  });
  assert("template has all three sheets",
    !!wb.getWorksheet("Properties") && !!wb.getWorksheet("Tenants") && !!wb.getWorksheet("Instructions"));

  const buf = await wb.xlsx.writeBuffer();
  assert("template writes a non-trivial workbook", buf.byteLength > 5000, `${buf.byteLength} bytes`);

  const back = await parseWorkbook(ExcelJS, buf);
  assert("no fatal parse problems", back.fatal.length === 0, back.fatal.join("; "));
  assert("round trip preserves every property row",
    back.properties.length === existingProperties.length,
    `${back.properties.length} of ${existingProperties.length}`);
  assert("round trip preserves every tenant row",
    back.tenants.length === existingTenants.length,
    `${back.tenants.length} of ${existingTenants.length}`);

  // Unchanged file must be a no-op: nothing created, nothing renamed.
  const noop = buildImportPlan({ ...back, existingProperties, existingTenants });
  assert("unchanged file creates nothing", noop.summary.propertiesToCreate === 0, `${noop.summary.propertiesToCreate}`);
  assert("unchanged file renames nothing", noop.summary.addressChanges === 0, `${noop.summary.addressChanges}`);
  assert("unchanged file has no errors", noop.summary.errors === 0,
    noop.errors.slice(0, 2).map(e => `r${e.row}: ${e.message}`).join(" ; "));

  // Now edit it the way a user would: fill in city/state/zip on one row.
  const edited = JSON.parse(JSON.stringify(back));
  const target = edited.properties.find(r => r.address_line_1 === "7200 Bogley");
  assert("found a property to edit", !!target);
  if (target) {
    target.city = "District Heights"; target.state = "MD"; target.zip = "20747";
  }
  const plan = buildImportPlan({ ...edited, existingProperties, existingTenants });
  assert("filling in a city produces exactly one rename", plan.summary.addressChanges === 1,
    `${plan.summary.addressChanges}`);
  assert("the rename shows old and new", plan.renames[0] &&
    plan.renames[0].from === "7200 Bogley" &&
    plan.renames[0].to === "7200 Bogley, District Heights, MD 20747",
    plan.renames[0] ? `${plan.renames[0].from} -> ${plan.renames[0].to}` : "none");
  assert("still creates nothing", plan.summary.propertiesToCreate === 0);

  // ---- adversarial: the ways this could silently corrupt data --------
  const mangle = (fn) => { const c = JSON.parse(JSON.stringify(back)); fn(c); return buildImportPlan({ ...c, existingProperties, existingTenants }); };

  assert("an edited Property ID is rejected, not applied to the wrong property",
    mangle(c => { c.properties[0].id = "999999"; }).errors.some(e => /No property with id/.test(e.message)));

  // When the conflicting property is present in the file (the normal case,
  // since the template is pre-filled) the duplicate-row check fires first.
  assert("a new row duplicating an address already in the file is rejected",
    mangle(c => { c.properties.push({ _row: 999, id: "", address_line_1: "7200 Bogley" }); })
      .errors.some(e => /Same address as row/.test(e.message)));

  // With that row deleted from the sheet, the check against the database
  // has to catch it instead — otherwise deleting a row would be a way to
  // smuggle a duplicate past validation.
  assert("a new row duplicating an address NOT in the file is still rejected",
    mangle(c => { c.properties = c.properties.filter(r => r.address_line_1 !== "7200 Bogley");
                  c.properties.push({ _row: 999, id: "", address_line_1: "7200 Bogley" }); })
      .errors.some(e => /already exists/.test(e.message)));

  assert("two rows resolving to the same address are rejected",
    mangle(c => { c.properties.push({ _row: 998, id: "", address_line_1: "Brand New St" });
                  c.properties.push({ _row: 997, id: "", address_line_1: "Brand New St" }); })
      .errors.some(e => /Same address as row/.test(e.message)));

  assert("renaming onto an address already in the file is rejected",
    mangle(c => { const a = c.properties.find(r => r.address_line_1 === "7200 Bogley");
                  a.address_line_1 = "35 Watkins"; })
      .errors.some(e => /Same address as row/.test(e.message)));

  assert("renaming onto an address NOT in the file is still rejected",
    mangle(c => { c.properties = c.properties.filter(r => r.address_line_1 !== "35 Watkins");
                  const a = c.properties.find(r => r.address_line_1 === "7200 Bogley");
                  a.address_line_1 = "35 Watkins"; })
      .errors.some(e => /already belongs to property/.test(e.message)));

  // A row simply left out of the sheet must not be treated as a deletion.
  assert("omitting a row leaves that property alone",
    mangle(c => { c.properties = c.properties.filter(r => r.address_line_1 !== "35 Watkins"); })
      .summary.errors === 0);

  assert("a duplicate tenant name on the same property is rejected",
    mangle(c => { const t0 = c.tenants[0];
                  c.tenants.push({ _row: 996, id: "", name: t0.name, property: t0.property, tenant_status: "Current" }); })
      .errors.some(e => /already exists at/.test(e.message)));

  assert("text in a numeric cell is caught",
    mangle(c => { c.properties[0].bedrooms = NaN; }).errors.some(e => /numeric cell contains text/.test(e.message)));

  assert("a missing street address is caught",
    mangle(c => { c.properties[0].address_line_1 = ""; }).errors.some(e => /Street Address is required/.test(e.message)));

  assert("move-out before move-in is caught",
    mangle(c => { c.tenants[0].move_in = "2026-05-01"; c.tenants[0].move_out = "2026-01-01"; })
      .errors.some(e => /Move Out is before Move In/.test(e.message)));

  assert("an unknown tenant status is caught",
    mangle(c => { c.tenants[0].id = ""; c.tenants[0].tenant_status = "Maybe"; })
      .errors.some(e => /is not one of/.test(e.message)));

  assert("missing city/state/zip becomes a pendency, not an error",
    noop.summary.pendencies > 0 && noop.summary.errors === 0,
    `${noop.summary.pendencies} pendencies`);

  console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
