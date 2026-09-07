// The comprehensive property import: eight sheets, six of them optional.
//
// Run: cd tests && node property-import-sheets.test.js
//
// Two things this has to prove, because both are promises made in the UI:
//   1. Add mode cannot touch an existing property -- there is no ID column.
//   2. Every extra sheet is optional, and a filled one actually lands.
const path = require("path");
const ExcelJS = require(path.join(__dirname, "..", "node_modules", "exceljs"));

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

const EXISTING = [
  { id: 7, address: "12 Old Mill Rd, Reston, VA 20190", address_line_1: "12 Old Mill Rd",
    city: "Reston", state: "VA", zip: "20190" },
];

// Write values into a sheet by header name, so the test breaks loudly if
// a column is renamed rather than silently writing into the wrong one.
function fill(ws, rowIdx, values) {
  const headers = {};
  ws.getRow(1).eachCell((c, i) => { headers[String(c.value).trim()] = i; });
  for (const [header, v] of Object.entries(values)) {
    if (!headers[header]) throw new Error(`no "${header}" column on ${ws.name}; has: ${Object.keys(headers).join(", ")}`);
    ws.getRow(rowIdx).getCell(headers[header]).value = v;
  }
  return headers;
}

(async () => {
  const pi = await import(path.join(__dirname, "..", "src", "utils", "propertyImport.js"));

  // ---- Add mode: the shape of the template ------------------------
  const addWb = await pi.buildTemplate(ExcelJS, {
    companyName: "Test LLC", properties: EXISTING, tenants: [], owners: [], mode: "add",
  });
  const names = addWb.worksheets.map(w => w.name);
  assert("add template has all eight sheets plus instructions",
    ["Properties","Tenants","Utilities","HOA","Loans","Insurance","Property Tax","Recurring Rent","Instructions"]
      .every(n => names.includes(n)), names.join(", "));

  const addProps = addWb.getWorksheet("Properties");
  const addHeaders = [];
  addProps.getRow(1).eachCell(c => addHeaders.push(String(c.value).trim()));
  assert("add template has NO Property ID column — the TEST-1001 failure cannot recur",
    !addHeaders.includes("Property ID"), addHeaders.join(", "));
  assert("add template is not pre-filled with existing properties",
    !String(addProps.getRow(2).getCell(1).value || "").includes("Old Mill"));

  // ---- Edit mode keeps the ID column ------------------------------
  const editWb = await pi.buildTemplate(ExcelJS, {
    companyName: "Test LLC", properties: EXISTING, tenants: [], owners: [], mode: "edit",
  });
  const editHeaders = [];
  editWb.getWorksheet("Properties").getRow(1).eachCell(c => editHeaders.push(String(c.value).trim()));
  assert("edit template keeps Property ID", editHeaders.includes("Property ID"));
  assert("edit template is pre-filled with what you have",
    String(editWb.getWorksheet("Properties").getRow(2).getCell(2).value || "").includes("Old Mill"));

  // ---- A filled Add workbook, round-tripped -----------------------
  fill(addWb.getWorksheet("Properties"), 2, {
    "Street Address": "88 Rosewood Ln", City: "Vienna", State: "VA", ZIP: "22180",
    Type: "Single Family", Status: "vacant",
  });
  const ADDR = "88 Rosewood Ln, Vienna, VA 22180";
  fill(addWb.getWorksheet("Utilities"), 2, {
    Property: ADDR, Provider: "Dominion Energy", "Paid By": "Owner",
    "Typical Amount": 120, Username: "sigma", Password: "hunter2",
  });
  fill(addWb.getWorksheet("Utilities"), 3, {
    Property: ADDR, Provider: "Fairfax Water", "Typical Amount": 60,
  });
  fill(addWb.getWorksheet("HOA"), 2, {
    Property: ADDR, "HOA Name": "Rosewood HOA", Amount: 250, Frequency: "Monthly",
  });
  fill(addWb.getWorksheet("Loans"), 2, {
    Property: ADDR, Lender: "Wells Fargo", "Account Number": "44120099",
    "Original Amount": 300000, "Rate %": 6.25, "Monthly Payment": 1850,
  });
  fill(addWb.getWorksheet("Insurance"), 2, {
    Property: ADDR, Provider: "State Farm", "Policy Number": "SF-9912", Premium: 1400,
  });
  fill(addWb.getWorksheet("Property Tax"), 2, {
    Property: ADDR, County: "Fairfax", "Annual Amount": 5200, "Tax Year": 2026,
  });
  fill(addWb.getWorksheet("Recurring Rent"), 2, {
    Property: ADDR, Tenant: "Dana Reyes", Amount: 2400, Frequency: "Monthly", "Day of Month": 1,
  });

  const buf = await addWb.xlsx.writeBuffer();
  const parsed = await pi.parseWorkbook(ExcelJS, buf);
  assert("a filled workbook parses with no fatal errors", parsed.fatal.length === 0,
    JSON.stringify(parsed.fatal));
  assert("both utility rows are read", (parsed.utilities || []).length === 2,
    "got " + (parsed.utilities || []).length);

  const plan = pi.buildImportPlan({
    properties: parsed.properties, tenants: parsed.tenants,
    existingProperties: EXISTING, existingTenants: [],
    utilities: parsed.utilities, hoas: parsed.hoas, loan: parsed.loan,
    insurance: parsed.insurance, taxes: parsed.taxes, recurring: parsed.recurring,
  });

  assert("no problems on a well-formed workbook", plan.summary.errors === 0,
    JSON.stringify(plan.errors, null, 1));
  assert("the property is created", plan.summary.propertiesToCreate === 1);
  assert("two utilities attach", plan.summary.utilities === 2, "got " + plan.summary.utilities);
  assert("the HOA attaches", plan.summary.hoas === 1);
  assert("the loan attaches", plan.summary.loans === 1);
  assert("insurance attaches", plan.summary.insurance === 1);
  assert("property tax attaches", plan.summary.taxes === 1);
  assert("recurring rent attaches", plan.summary.recurring === 1);
  assert("every extra row is attached to the property being created",
    Object.values(plan.extras).flat().every(r => r._address === ADDR && r._creating));

  // ---- Every extra sheet is optional -------------------------------
  const bare = await pi.buildTemplate(ExcelJS, { companyName: "T", mode: "add" });
  fill(bare.getWorksheet("Properties"), 2, { "Street Address": "9 Plain St", City: "Reston", State: "VA", ZIP: "20190" });
  const bareParsed = await pi.parseWorkbook(ExcelJS, await bare.xlsx.writeBuffer());
  const barePlan = pi.buildImportPlan({
    properties: bareParsed.properties, tenants: bareParsed.tenants,
    existingProperties: [], existingTenants: [],
    utilities: bareParsed.utilities, hoas: bareParsed.hoas, loan: bareParsed.loan,
    insurance: bareParsed.insurance, taxes: bareParsed.taxes, recurring: bareParsed.recurring,
  });
  assert("a properties-only workbook still imports — the extra sheets are optional",
    barePlan.summary.errors === 0 && barePlan.summary.propertiesToCreate === 1,
    JSON.stringify(barePlan.errors));
  assert("nothing extra is invented when the sheets are blank",
    barePlan.summary.extraRecords === 0);

  // ---- Things that should be caught --------------------------------
  const badWb = await pi.buildTemplate(ExcelJS, { companyName: "T", mode: "add" });
  fill(badWb.getWorksheet("Properties"), 2, { "Street Address": "1 Real Rd", City: "Reston", State: "VA", ZIP: "20190" });
  fill(badWb.getWorksheet("Utilities"), 2, { Property: "Somewhere That Does Not Exist", Provider: "Ghost Power" });
  fill(badWb.getWorksheet("Loans"), 2, { Property: "1 Real Rd, Reston, VA 20190", Lender: "A" });
  fill(badWb.getWorksheet("Loans"), 3, { Property: "1 Real Rd, Reston, VA 20190", Lender: "B" });
  fill(badWb.getWorksheet("Insurance"), 2, { Property: "1 Real Rd, Reston, VA 20190", Provider: "X", Username: "u" });
  const badParsed = await pi.parseWorkbook(ExcelJS, await badWb.xlsx.writeBuffer());
  const badPlan = pi.buildImportPlan({
    properties: badParsed.properties, tenants: badParsed.tenants,
    existingProperties: [], existingTenants: [],
    utilities: badParsed.utilities, hoas: badParsed.hoas, loan: badParsed.loan,
    insurance: badParsed.insurance, taxes: badParsed.taxes, recurring: badParsed.recurring,
  });
  const msgs = badPlan.errors.map(e => e.message).join(" | ");
  assert("a utility pointing at a property that does not exist is caught",
    /no property called/i.test(msgs), msgs);
  assert("a second loan for the same property is caught",
    /one row per property/i.test(msgs), msgs);
  assert("a username with no password is flagged as a pendency, not silently stored",
    badPlan.warnings.some(w => /no password/i.test(w.message)),
    JSON.stringify(badPlan.warnings.map(w => w.message)));

  // Case and spacing in a hand-typed address must still match.
  const caseWb = await pi.buildTemplate(ExcelJS, { companyName: "T", mode: "add" });
  fill(caseWb.getWorksheet("Properties"), 2, { "Street Address": "5 Cobble Ct", City: "Vienna", State: "VA", ZIP: "22180" });
  fill(caseWb.getWorksheet("Utilities"), 2, { Property: "  5 cobble ct,  vienna, VA 22180 ", Provider: "Dominion" });
  const caseParsed = await pi.parseWorkbook(ExcelJS, await caseWb.xlsx.writeBuffer());
  const casePlan = pi.buildImportPlan({
    properties: caseParsed.properties, tenants: caseParsed.tenants,
    existingProperties: [], existingTenants: [],
    utilities: caseParsed.utilities, hoas: caseParsed.hoas, loan: caseParsed.loan,
    insurance: caseParsed.insurance, taxes: caseParsed.taxes, recurring: caseParsed.recurring,
  });
  assert("a hand-typed address matches despite case and extra spaces",
    casePlan.summary.utilities === 1 && casePlan.summary.errors === 0,
    JSON.stringify(casePlan.errors));

  console.log(`\n✅ Passed: ${passed}   ❌ Failed: ${failed}`);
  console.log(`Total: ${passed + failed} | Pass rate: ${Math.round(passed / (passed + failed) * 100)}%`);
  process.exit(failed ? 1 : 0);
})();
