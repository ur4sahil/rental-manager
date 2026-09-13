// The edit workbook must contain the data it claims to edit.
//
// All six one-to-many sheets -- Utilities, HOA Dues, Loans, Insurance,
// Taxes, Recurring Rent -- were written as headers over BLANK rows: the
// export loaded only properties, tenants, owners and accounts. So the
// workbook could ADD a loan or an insurance policy but never show or
// correct one that already existed. "Bulk edit" was add-only for six of
// the eight sheets, and nothing said so.
import ExcelJS from "exceljs";
import fs from "fs";
import path from "path";

const mod = await import(path.join(import.meta.dirname, "../src/utils/propertyImport.js"));
const { buildTemplate, EXTRA_SHEETS } = mod;

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

const extras = {
  utilities: [{ property: "1 Test St", provider: "City Water", responsibility: "tenant", amount: 42, due_date: "2026-01-15" }],
  hoas:      [{ property: "1 Test St", hoa_name: "Test HOA", amount: 120, frequency: "monthly" }],
  loan:      [{ property: "1 Test St", lender_name: "Test Bank", current_balance: 123456 }],
  insurance: [{ property: "1 Test St", provider: "Test Insurer", policy_number: "POL-1" }],
  taxes:     [{ property: "1 Test St", annual_tax_amount: 4200, tax_year: 2026 }],
  recurring: [{ property: "1 Test St", tenant_name: "A Tenant", amount: 1500, frequency: "monthly" }],
};
const properties = [{ id: 1, address: "1 Test St", address_line_1: "1 Test St", short_name: "1 Test St" }];

// --- edit mode carries the existing rows --------------------------------
const wb = await buildTemplate(ExcelJS, { companyName: "T", properties, tenants: [], owners: [], extras, mode: "edit", blankRows: 3 });
for (const { sheet, key } of EXTRA_SHEETS) {
  const ws = wb.getWorksheet(sheet);
  check(`${sheet}: sheet exists`, !!ws);
  if (!ws) continue;
  // row 1 is the header; row 2 must be the existing record, not a blank
  const first = ws.getRow(2);
  const filled = first.values.filter(v => v !== null && v !== undefined && v !== "").length;
  check(`${sheet}: the existing row is present, not a blank sheet`, filled > 0,
    `row 2 is empty — the sheet came down blank, so this data cannot be edited`);
  const text = JSON.stringify(first.values);
  check(`${sheet}: the row is the right record`, text.includes("1 Test St"), text.slice(0, 80));
}

// --- add mode stays blank -----------------------------------------------
// A fresh-add workbook must NOT be pre-filled with the whole portfolio.
const wbAdd = await buildTemplate(ExcelJS, { companyName: "T", properties, tenants: [], owners: [], extras, mode: "add", blankRows: 3 });
for (const { sheet } of EXTRA_SHEETS) {
  const ws = wbAdd.getWorksheet(sheet);
  const filled = ws.getRow(2).values.filter(v => v !== null && v !== undefined && v !== "").length;
  check(`${sheet}: add mode is blank`, filled === 0,
    "an add workbook must not arrive pre-filled with existing records");
}

// --- and the blank rows for new entries are still there ------------------
const ws = wb.getWorksheet(EXTRA_SHEETS[0].sheet);
check("blank rows follow the existing ones, so new records can still be added",
  ws.rowCount >= 1 + extras.utilities.length + 3,
  `rowCount=${ws.rowCount}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
