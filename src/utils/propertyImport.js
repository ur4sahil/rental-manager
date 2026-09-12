// ============ BULK PROPERTY IMPORT ============
//
// Pure parsing, validation and planning for the Excel property importer.
// No React, no Supabase — so the whole thing is testable against real
// exports without a browser or a database.
//
// The template is generated PER COMPANY and pre-filled with what already
// exists, each row carrying its database id in a locked column. Matching
// is therefore by id, never by address. That is deliberate: `address` is
// derived by a trigger from the component columns, so a QuickBooks
// property reads "7919 Mandan Rd" until someone fills in the city, at
// which point it becomes "7919 Mandan Rd, Landover, MD 20785". Matching
// on that string would create a duplicate property, a second accounting
// class, and strand the whole ledger on the old one.

import JSZip from "jszip";
import {
  EXTRA_SHEETS, SHEET_RECURRING, UTILITY_RESPONSIBILITY, HOA_FREQUENCY,
  LOAN_TYPES, PREMIUM_FREQUENCY, TAX_FREQUENCY, RECURRING_FREQUENCY,
} from "./propertyImportSheets.js";   // .js required: the unit tests load
                                     // this module through Node's ESM
                                     // loader, which does not resolve
                                     // extensionless paths the way
                                     // webpack does.

// Re-exported so callers have one import for the whole import schema.
export {
  SHEET_UTILITIES, SHEET_HOA, SHEET_LOANS, SHEET_INSURANCE, SHEET_TAXES, SHEET_RECURRING,
  UTILITY_COLUMNS, HOA_COLUMNS, LOAN_COLUMNS, INSURANCE_COLUMNS, TAX_COLUMNS, RECURRING_COLUMNS,
  EXTRA_SHEETS, UTILITY_RESPONSIBILITY, HOA_FREQUENCY, LOAN_TYPES,
  PREMIUM_FREQUENCY, TAX_FREQUENCY, RECURRING_FREQUENCY,
} from "./propertyImportSheets.js";

export const SHEET_PROPERTIES = "Properties";
export const SHEET_TENANTS = "Tenants";
export const SHEET_REFERENCE = "Instructions";

// `key` is the payload field; `locked` marks columns the user must not
// edit; `readOnly` marks context shown purely to inform a decision.
export const PROPERTY_COLUMNS = [
  { key: "id",             header: "Property ID",    width: 12, locked: true,
    note: "Do not edit. Blank means a new property will be created." },
  { key: "address_line_1", header: "Street Address", width: 30, required: true },
  { key: "address_line_2", header: "Unit / Apt",     width: 12 },
  { key: "city",           header: "City",           width: 16 },
  { key: "state",          header: "State",          width: 7,  maxLength: 2 },
  { key: "zip",            header: "ZIP",            width: 9 },
  { key: "county",         header: "County",         width: 14 },
  { key: "short_name",     header: "Short Name",     width: 22,
    note: "Shown in reports. Leave as-is to keep your QuickBooks naming." },
  { key: "type",           header: "Type",           width: 15, list: "propertyTypes" },
  { key: "status",         header: "Status",         width: 11, list: "propertyStatuses" },
  { key: "bedrooms",       header: "Beds",           width: 7,  numeric: true, integer: true },
  { key: "bathrooms",      header: "Baths",          width: 7,  numeric: true },
  { key: "sqft",           header: "Sq Ft",          width: 9,  numeric: true, integer: true },
  { key: "owner_name",     header: "Owner",          width: 20, list: "owners" },
  { key: "rent",           header: "Monthly Rent",   width: 13, numeric: true },
  { key: "security_deposit", header: "Deposit",      width: 11, numeric: true },
  { key: "notes",          header: "Notes",          width: 30 },
];

export const TENANT_COLUMNS = [
  { key: "id",           header: "Tenant ID",     width: 11, locked: true,
    note: "Do not edit. Blank means a new tenant will be created." },
  { key: "property",     header: "Property",      width: 30, required: true, list: "properties" },
  { key: "name",         header: "Tenant Name",   width: 28, required: true },
  { key: "tenant_status", header: "Status",       width: 14, list: "tenantStatuses",
    note: "Pre-filled from ledger activity. Override if wrong." },
  { key: "email",        header: "Email",         width: 24 },
  { key: "phone",        header: "Phone",         width: 14 },
  { key: "move_in",      header: "Move In",       width: 12, date: true },
  { key: "move_out",     header: "Move Out",      width: 12, date: true },
  { key: "lease_start",  header: "Lease Start",   width: 12, date: true },
  { key: "lease_end_date", header: "Lease End",   width: 12, date: true },
  { key: "rent",         header: "Rent",          width: 11, numeric: true },
  { key: "is_voucher",   header: "Voucher?",      width: 9,  list: "yesNo" },
  { key: "voucher_number",  header: "Voucher #",  width: 13 },
  { key: "tenant_portion",  header: "Tenant Pays",  width: 12, numeric: true },
  { key: "voucher_portion", header: "Voucher Pays", width: 12, numeric: true },
  // Context only — never written back. These are what let someone judge
  // whether a tenant is current without opening the ledger.
  { key: "_balance",      header: "Balance",       width: 12, readOnly: true },
  { key: "_lastActivity", header: "Last Activity", width: 13, readOnly: true },
  { key: "_ledgerLines",  header: "Ledger Lines",  width: 12, readOnly: true },
];

export const TENANT_STATUSES = ["Current", "Past", "Review", "Not a tenant"];
export const PROPERTY_STATUSES = ["occupied", "vacant"];
export const PROPERTY_TYPES = ["Single Family", "Condo", "Townhouse", "Multi-Family", "Apartment", "Commercial"];

// ---- tenant status inference ---------------------------------------
//
// Balance alone looks like a clean signal on real data — every tenant
// carrying one is active, every zero-balance tenant is dormant — but that
// is a coincidence of this dataset, not a rule. A tenant who has simply
// paid up in full is indistinguishable from one who left. Ledger recency
// is the causal signal, and it isolates exactly the ambiguous cases.
export const ACTIVE_DAYS = 92;      // ~3 months
export const DORMANT_DAYS = 365;

export function inferTenantStatus(t, asOf = new Date()) {
  const lines = Number(t.ledgerLines || 0);
  const hasAr = !!t.arAccountId;

  // What the app already says wins. This used to re-derive the status
  // from ledger activity alone and ignore lease_status entirely, so the
  // sheet would say "Review" for a tenant the Tenants page plainly
  // showed as Past -- one had an ended lease, a $4,500 balance and
  // recent collection activity, which the activity rule reads as
  // "Current" and a human reads as "Past, still owing".
  //
  // Only guess when the app has no answer.
  const known = String(t.lease_status || "").toLowerCase();
  if (known === "current") return "Current";
  if (known === "past") return "Past";
  // No AR account and nothing in the ledger: the QuickBooks import turned
  // every customer name into a tenant, including lenders, title companies
  // and one chart-of-accounts line called "Rent receivable".
  if (!hasAr && lines === 0) return "Not a tenant";
  if (!t.lastActivity) return "Review";

  const days = Math.floor((asOf - new Date(t.lastActivity)) / 86400000);
  if (days <= ACTIVE_DAYS) return "Current";
  if (days > DORMANT_DAYS) return "Past";
  // Between three months and a year: settled up but not long gone.
  return Number(t.balance || 0) !== 0 ? "Current" : "Review";
}

// ---- cell coercion --------------------------------------------------

export function cellString(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v.text) return String(v.text).trim();
    if (v.result !== undefined) return String(v.result).trim();
    if (v.richText) return v.richText.map(r => r.text).join("").trim();
    return "";
  }
  return String(v).trim();
}

export function cellNumber(v) {
  const s = cellString(v).replace(/[$,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;   // NaN signals "present but unparseable"
}

// Excel dates arrive as Date objects, serial numbers, or text. All three
// have to become YYYY-MM-DD without drifting a day across timezones.
export function cellDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  const s = cellString(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Four-digit year.
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  // Two-digit year. Excel shows dates this way by default on a US
  // locale, and people type them this way, so "1/12/25" arrives as text
  // and used to be rejected outright -- 36 of one real import's 69
  // errors were nothing but this. Pivot at 70, the usual convention:
  // 00-69 is 2000-2069, 70-99 is 1970-1999. A lease is never dated
  // before 1970, and one dated after 2069 is not a date anyone typed.
  const m2 = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/);
  if (m2) {
    const yy = Number(m2[3]);
    const year = yy < 70 ? 2000 + yy : 1900 + yy;
    return `${year}-${m2[1].padStart(2, "0")}-${m2[2].padStart(2, "0")}`;
  }
  // Excel serial: days since 1899-12-30
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 60000) {
    const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return NaN;   // present but not a date we understand
}

// Mirrors compute_property_address() in the database exactly. The importer
// needs to predict the address the trigger WILL derive, so the preview can
// tell you which properties are about to be renamed before anything is
// written.
export function computeAddress({ address_line_1, address_line_2, city, state, zip }) {
  const t = (s) => (s === null || s === undefined ? "" : String(s).trim());
  const stateZip = [t(state), t(zip)].filter(Boolean).join(" ");
  return [t(address_line_1), t(address_line_2), t(city), stateZip].filter(Boolean).join(", ").trim();
}

export default { PROPERTY_COLUMNS, TENANT_COLUMNS, inferTenantStatus, computeAddress };

// ---- template generation -------------------------------------------
//
// The workbook is built FOR a company and pre-filled with what exists.
// That is what makes matching by id possible, and therefore what makes
// it impossible to duplicate a QuickBooks property or split a tenant's
// AR balance across two records.

const HEADER_FILL   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };
const LOCKED_FILL   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
const READONLY_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
const GAP_FILL      = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF9C3" } };

function writeHeader(ws, columns) {
  ws.columns = columns.map(c => ({ key: c.key, width: c.width || 14 }));
  const row = ws.getRow(1);
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    cell.value = c.header;
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    if (c.note) cell.note = c.note;
  });
  row.height = 22;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
}

// Shading is not decoration here: a locked column that looks like every
// other column WILL be edited, and an edited id silently retargets a row
// at a different property.
function styleRow(ws, rowIdx, columns, record) {
  const row = ws.getRow(rowIdx);
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    if (c.locked)        { cell.fill = LOCKED_FILL;   cell.font = { color: { argb: "FF6B7280" } }; }
    else if (c.readOnly) { cell.fill = READONLY_FILL; cell.font = { color: { argb: "FF6B7280" }, italic: true }; }
    else if (record && (cell.value === null || cell.value === undefined || cell.value === "")) {
      cell.fill = GAP_FILL;   // a blank on an existing row is something to fill in
    }
    if (c.numeric) cell.numFmt = c.integer ? "0" : "#,##0.00";
    if (c.date) cell.numFmt = "yyyy-mm-dd";
  });
}

function addListValidation(ws, colIdx, rowCount, values) {
  if (!values || !values.length) return;
  // Excel caps an inline list at 255 characters; longer lists are left
  // free-text rather than silently truncated to a wrong set of options.
  const joined = values.join(",");
  if (joined.length > 250) return;
  for (let r = 2; r <= rowCount + 1; r++) {
    ws.getCell(r, colIdx).dataValidation = {
      type: "list", allowBlank: true, formulae: [`"${joined}"`],
      showErrorMessage: true, errorTitle: "Not a valid value",
      error: `Choose one of: ${values.join(", ")}`,
    };
  }
}

// mode "edit" is the round trip: pre-filled, ID columns present so a row
// still matches its record after its address changes. mode "add" is a
// blank book -- the ID columns are removed entirely, which is what makes
// "No property with id TEST-1001" impossible rather than merely unlikely.
export async function buildTemplate(ExcelJS, {
  companyName = "", properties = [], tenants = [], owners = [], blankRows = 25,
  mode = "edit",
} = {}) {
  const isAdd = mode === "add";
  const dropId = (cols) => isAdd ? cols.filter(c => c.key !== "id") : cols;
  const propertyColumns = dropId(PROPERTY_COLUMNS);
  const tenantColumns = dropId(TENANT_COLUMNS);
  if (isAdd) { properties = []; tenants = []; blankRows = Math.max(blankRows, 40); }
  const wb = new ExcelJS.Workbook();
  wb.creator = "Housify";
  wb.created = new Date();

  // --- Properties -----------------------------------------------------
  const wsP = wb.addWorksheet(SHEET_PROPERTIES, { views: [{ state: "frozen", ySplit: 1 }] });
  writeHeader(wsP, propertyColumns);
  properties.forEach((p, i) => {
    const row = wsP.getRow(i + 2);
    propertyColumns.forEach((c, ci) => { row.getCell(ci + 1).value = p[c.key] ?? null; });
    styleRow(wsP, i + 2, propertyColumns, p);
  });
  for (let i = 0; i < blankRows; i++) styleRow(wsP, properties.length + 2 + i, propertyColumns, null);

  const pTypeIdx   = propertyColumns.findIndex(c => c.key === "type") + 1;
  const pStatusIdx = propertyColumns.findIndex(c => c.key === "status") + 1;
  const pOwnerIdx  = propertyColumns.findIndex(c => c.key === "owner_name") + 1;
  const pRows = properties.length + blankRows;
  addListValidation(wsP, pTypeIdx, pRows, PROPERTY_TYPES);
  addListValidation(wsP, pStatusIdx, pRows, PROPERTY_STATUSES);
  addListValidation(wsP, pOwnerIdx, pRows, owners);

  // --- Tenants --------------------------------------------------------
  const wsT = wb.addWorksheet(SHEET_TENANTS, { views: [{ state: "frozen", ySplit: 1 }] });
  writeHeader(wsT, tenantColumns);
  tenants.forEach((t, i) => {
    const row = wsT.getRow(i + 2);
    tenantColumns.forEach((c, ci) => { row.getCell(ci + 1).value = t[c.key] ?? null; });
    styleRow(wsT, i + 2, tenantColumns, t);
  });
  for (let i = 0; i < blankRows; i++) styleRow(wsT, tenants.length + 2 + i, tenantColumns, null);

  const tStatusIdx = tenantColumns.findIndex(c => c.key === "tenant_status") + 1;
  const tVoucherIdx = tenantColumns.findIndex(c => c.key === "is_voucher") + 1;
  const tRows = tenants.length + blankRows;
  addListValidation(wsT, tStatusIdx, tRows, TENANT_STATUSES);
  addListValidation(wsT, tVoucherIdx, tRows, ["Yes", "No"]);

  // --- The six optional sheets ----------------------------------------
  // Always blank: these are things you are telling the app, never things
  // it is asking you to confirm.
  const LISTS = {
    properties: properties.map(p => p.address).filter(Boolean),
    utilityResponsibility: UTILITY_RESPONSIBILITY, hoaFrequency: HOA_FREQUENCY,
    loanTypes: LOAN_TYPES, premiumFrequency: PREMIUM_FREQUENCY,
    taxFrequency: TAX_FREQUENCY, recurringFrequency: RECURRING_FREQUENCY,
    yesNo: ["Yes", "No"],
  };
  for (const { sheet, columns } of EXTRA_SHEETS) {
    const ws = wb.addWorksheet(sheet, { views: [{ state: "frozen", ySplit: 1 }] });
    writeHeader(ws, columns);
    for (let i = 0; i < blankRows; i++) styleRow(ws, i + 2, columns, null);
    columns.forEach((c, ci) => {
      const opts = c.list ? LISTS[c.list] : null;
      if (opts && opts.length) addListValidation(ws, ci + 1, blankRows, opts);
    });
  }

  // --- Instructions ---------------------------------------------------
  const wsI = wb.addWorksheet(SHEET_REFERENCE);
  wsI.columns = [{ width: 4 }, { width: 30 }, { width: 78 }];
  const lines = [
    ["", `${isAdd ? "Add properties" : "Edit properties"} — ${companyName}`, ""],
    ["", "", ""],
    ["", "How this works", ""],
    ...(isAdd ? [
      ["", "1.", "Type your new properties into the Properties sheet, one per row."],
      ["", "2.", "Fill in any of the other sheets you have details for. All optional."],
      ["", "3.", "Upload the file back. You will see what will be created before anything is saved."],
      ["", "", ""],
      ["", "This file only creates", "There is no ID column, so nothing here can overwrite a property you"],
      ["", "", "already have. To change existing records, use Edit properties instead."],
    ] : [
      ["", "1.", "Rows already filled in are your existing records. Fill the yellow gaps."],
      ["", "2.", "Add new properties or tenants in the blank rows at the bottom."],
      ["", "3.", "Upload the file back. You will see exactly what will change before anything is saved."],
      ["", "", ""],
      ["", "Do not edit grey columns", "Property ID and Tenant ID identify the record being updated."],
      ["", "", "Changing one retargets the row at a different record. Leave blank to create."],
    ]),
    ["", "", ""],
    ["", "The other six sheets", "Utilities, HOA, Loans, Insurance, Property Tax and Recurring Rent."],
    ["", "", "Every one is optional — leave a sheet empty and nothing is created for it."],
    ["", "", "Each row names its property in the Property column. Utilities and HOA take"],
    ["", "", "as many rows per property as you need; the other four take one each."],
    ["", "", ""],
    ["", "PASSWORDS IN THIS FILE", "The Username and Password columns hold real logins in plain text."],
    ["", "", "They are encrypted when you upload — the database never stores plaintext —"],
    ["", "", "but this FILE does. Do not email it or leave it in Downloads. Delete it once"],
    ["", "", "the import is done. Leave both blank to set logins in the app instead."],
    ["", "", ""],
    ["", "Documents", "Cannot be imported from a spreadsheet — a file cannot hold files."],
    ["", "", "Attach them on the property once it exists."],
    ["", "", ""],
    ["", "Short Name", "What reports and dropdowns display. Pre-filled with your QuickBooks naming,"],
    ["", "", "so reports keep reading the way they do today even after you add city and ZIP."],
    ["", "", ""],
    ["", "Tenant Status", "Pre-filled from ledger activity, not guesswork:"],
    ["", "", "Current — active in the last 3 months."],
    ["", "", "Past — nothing for over a year. Kept visible with their history."],
    ["", "", "Review — settled up but recently active. Please confirm which they are."],
    ["", "", "Not a tenant — no AR account and no ledger activity (lenders, title companies)."],
    ["", "", "Balance, Last Activity and Ledger Lines are shown so you can check each call."],
    ["", "", ""],
    ["", "Nothing is posted to the ledger", "This import never creates journal entries. Your books are untouched."],
    ["", "", "Anything left blank becomes a pending item for a manager or admin to approve."],
  ];
  lines.forEach((l, i) => {
    const row = wsI.getRow(i + 1);
    row.getCell(2).value = l[1];
    row.getCell(3).value = l[2];
    if (i === 0) row.getCell(2).font = { bold: true, size: 14 };
    if (["How this works", "Do not edit grey columns", "Short Name", "Tenant Status", "Nothing is posted to the ledger"].includes(l[1])) {
      row.getCell(2).font = { bold: true };
    }
  });

  return wb;
}

// ---- parsing --------------------------------------------------------

function headerIndex(ws, columns) {
  const map = {};
  const header = ws.getRow(1);
  header.eachCell((cell, col) => {
    const text = cellString(cell.value).toLowerCase();
    const def = columns.find(c => c.header.toLowerCase() === text);
    if (def) map[def.key] = col;
  });
  return map;
}

function readSheet(ws, columns) {
  if (!ws) return { rows: [], missingHeaders: columns.filter(c => c.required).map(c => c.header) };
  const idx = headerIndex(ws, columns);
  const missingHeaders = columns.filter(c => c.required && !idx[c.key]).map(c => c.header);
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rec = { _row: r };
    let any = false;
    for (const c of columns) {
      if (c.readOnly) continue;              // context columns are never read back
      const col = idx[c.key];
      if (!col) { rec[c.key] = null; continue; }
      const raw = row.getCell(col).value;
      let v;
      if (c.numeric) v = cellNumber(raw);
      else if (c.date) v = cellDate(raw);
      else v = cellString(raw);
      rec[c.key] = v;
      if (v !== null && v !== "" && !(typeof v === "number" && Number.isNaN(v))) any = true;
    }
    if (any) rows.push(rec);                 // silently skip wholly blank rows
  }
  return { rows, missingHeaders };
}

// Excel rewrites the workbook's comment links with ABSOLUTE targets
// ("/xl/comments/comment1.xml") where ExcelJS writes relative ones.
// ExcelJS looks the target up in a map it built from the relative form,
// gets undefined, and dereferences it:
//
//   TypeError: Cannot read properties of undefined (reading 'comments')
//     at worksheet-xform.js:453
//
// Our own template puts a help note on several columns, so every file
// that has been opened and saved in Excel comes back unreadable -- the
// app could not read its own template. The comments are decorative and
// carry no data we parse, so strip them and try again.
async function loadWorkbookTolerantly(ExcelJS, data) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data);
    return wb;
  } catch (e) {
    if (!/reading 'comments'|reading 'vmlDrawings'|comments/i.test(String(e && e.message))) throw e;
  }
  const zip = await JSZip.loadAsync(data);
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/comments\//i.test(name) || /vml/i.test(name)) zip.remove(name);
  }
  for (const name of Object.keys(zip.files)) {
    if (!/\.rels$/i.test(name) && name !== "[Content_Types].xml") continue;
    const xml = await zip.file(name).async("string");
    const cleaned = xml
      .replace(/<Relationship\b[^>]*?(?:comments|vmlDrawing)[^>]*?\/>/gi, "")
      .replace(/<Override\b[^>]*?(?:comments|vmlDrawing)[^>]*?\/>/gi, "");
    if (cleaned !== xml) zip.file(name, cleaned);
  }
  const rebuilt = await zip.generateAsync({ type: "arraybuffer" });
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(rebuilt);
  return wb2;
}

export async function parseWorkbook(ExcelJS, data) {
  const wb = await loadWorkbookTolerantly(ExcelJS, data);
  const wsP = wb.getWorksheet(SHEET_PROPERTIES);
  const wsT = wb.getWorksheet(SHEET_TENANTS);
  const p = readSheet(wsP, PROPERTY_COLUMNS);
  const t = readSheet(wsT, TENANT_COLUMNS);
  const fatal = [];
  if (!wsP) fatal.push(`The workbook has no "${SHEET_PROPERTIES}" sheet. Use the downloaded template.`);
  if (p.missingHeaders.length) fatal.push(`Properties sheet is missing: ${p.missingHeaders.join(", ")}`);
  // The six optional sheets. A missing sheet contributes nothing -- an
  // older template, or a tab someone deleted, is not an error. A sheet
  // that IS present but has lost its headers is worth saying out loud,
  // because importing none of its rows silently is what nobody notices.
  const extras = {};
  for (const { sheet, columns, key } of EXTRA_SHEETS) {
    const ws = wb.getWorksheet(sheet);
    if (!ws) { extras[key] = []; continue; }
    const r = readSheet(ws, columns);
    if (r.missingHeaders.length) fatal.push(`${sheet} sheet is missing: ${r.missingHeaders.join(", ")}`);
    extras[key] = r.rows;
  }
  return { properties: p.rows, tenants: t.rows, ...extras, fatal };
}

// ---- planning -------------------------------------------------------
//
// Produces exactly what will happen, so the preview is the truth rather
// than a summary of it. Nothing here writes.

export function buildImportPlan({
  properties = [], tenants = [], existingProperties = [], existingTenants = [],
  utilities = [], hoas = [], loan = [], insurance = [], taxes = [], recurring = [],
  archivedTenantIds = [],
}) {
  // Tenants this import has already archived as "Not a tenant". They stay
  // in the sheet, so a second upload of the same file would otherwise
  // fail on every one of them -- and re-uploading after a fix is the
  // documented workflow. One real file had 8: Carpenter's Shelter,
  // District Title, a chart-of-accounts line called "Rent receivable".
  const archivedIds = new Set((archivedTenantIds || []).map(String));
  const byId = new Map(existingProperties.map(p => [String(p.id), p]));
  const tById = new Map(existingTenants.map(t => [String(t.id), t]));
  const errors = [], warnings = [], creates = [], updates = [], renames = [];
  const tenantCreates = [], tenantUpdates = [];

  const seenAddresses = new Map();

  for (const r of properties) {
    const id = cellString(r.id);
    const where = `Properties row ${r._row}`;

    if (!cellString(r.address_line_1)) {
      errors.push({ sheet: SHEET_PROPERTIES, row: r._row, field: "Street Address", message: "Street Address is required" });
      continue;
    }
    if (Number.isNaN(r.bedrooms) || Number.isNaN(r.bathrooms) || Number.isNaN(r.sqft) ||
        Number.isNaN(r.rent) || Number.isNaN(r.security_deposit)) {
      errors.push({ sheet: SHEET_PROPERTIES, row: r._row, field: "Numbers", message: "A numeric cell contains text" });
      continue;
    }
    const state = cellString(r.state);
    if (state && state.length !== 2) {
      errors.push({ sheet: SHEET_PROPERTIES, row: r._row, field: "State", message: `State should be 2 letters, got "${state}"` });
      continue;
    }

    const newAddress = computeAddress(r);
    // Two rows resolving to one address would collide on
    // idx_properties_unique_address, so catch it here rather than as a
    // database error halfway through the import.
    if (seenAddresses.has(newAddress)) {
      errors.push({ sheet: SHEET_PROPERTIES, row: r._row, field: "Street Address",
        message: `Same address as row ${seenAddresses.get(newAddress)}` });
      continue;
    }
    seenAddresses.set(newAddress, r._row);

    if (id) {
      const existing = byId.get(id);
      if (!existing) {
        errors.push({ sheet: SHEET_PROPERTIES, row: r._row, field: "Property ID",
          message: `No property with id ${id}. Leave Property ID blank to create a new property; only fill it in to update one that already exists.` });
        continue;
      }
      const addressChanged = newAddress !== (existing.address || "");
      if (addressChanged) {
        const collision = existingProperties.find(p => String(p.id) !== id && p.address === newAddress);
        if (collision) {
          errors.push({ sheet: SHEET_PROPERTIES, row: r._row, field: "Street Address",
            message: `That address already belongs to property ${collision.id}` });
          continue;
        }
        renames.push({ id, row: r._row, from: existing.address, to: newAddress, className: existing.address });
      }
      updates.push({ id, row: r._row, record: r, existing, addressChanged, newAddress });
    } else {
      const clash = existingProperties.find(p => p.address === newAddress);
      if (clash) {
        errors.push({ sheet: SHEET_PROPERTIES, row: r._row, field: "Street Address",
          message: `"${newAddress}" already exists (property ${clash.id}). Fill in that row instead of adding a new one.` });
        continue;
      }
      creates.push({ row: r._row, record: r, newAddress });
    }
  }

  // Address changes have to be applied before tenant rows are matched by
  // property, because the cascade rewrites tenants.property.
  const addressAfter = new Map();
  for (const u of updates) addressAfter.set(String(u.id), u.newAddress);
  const validProperties = new Set([
    ...existingProperties.map(p => addressAfter.get(String(p.id)) || p.address),
    ...creates.map(c => c.newAddress),
  ]);

  for (const r of tenants) {
    const id = cellString(r.id);
    const name = cellString(r.name);
    const prop = cellString(r.property);
    if (!name) {
      errors.push({ sheet: SHEET_TENANTS, row: r._row, field: "Tenant Name", message: "Tenant Name is required" });
      continue;
    }
    const status = cellString(r.tenant_status) || "Review";
    if (!TENANT_STATUSES.includes(status)) {
      errors.push({ sheet: SHEET_TENANTS, row: r._row, field: "Status",
        message: `"${status}" is not one of: ${TENANT_STATUSES.join(", ")}` });
      continue;
    }
    if (r.move_out && r.move_in && r.move_out < r.move_in) {
      errors.push({ sheet: SHEET_TENANTS, row: r._row, field: "Move Out", message: "Move Out is before Move In" });
      continue;
    }
    if (Number.isNaN(r.move_in) || Number.isNaN(r.move_out) ||
        Number.isNaN(r.lease_start) || Number.isNaN(r.lease_end_date)) {
      errors.push({ sheet: SHEET_TENANTS, row: r._row, field: "Dates", message: "A date cell could not be read" });
      continue;
    }

    if (id) {
      const existing = tById.get(id);
      if (!existing) {
        if (archivedIds.has(id)) {
          // Already dealt with. Say so and move on rather than blocking
          // the whole upload on a row whose answer is settled.
          warnings.push({ sheet: SHEET_TENANTS, row: r._row, kind: "pendency",
            message: `${cellString(r.name) || "This row"} was archived as "Not a tenant" by an earlier import — left alone. Delete the row, or clear its Tenant ID to add them back.` });
          continue;
        }
        errors.push({ sheet: SHEET_TENANTS, row: r._row, field: "Tenant ID",
          message: `No tenant with id ${id}. Leave Tenant ID blank to create a new tenant; only fill it in to update one that already exists.` });
        continue;
      }
      tenantUpdates.push({ id, row: r._row, record: r, existing, status });
    } else {
      if (prop && !validProperties.has(prop)) {
        errors.push({ sheet: SHEET_TENANTS, row: r._row, field: "Property",
          message: `"${prop}" is not one of the properties in this file` });
        continue;
      }
      // Refuse to create a second tenant of the same name on the same
      // property: they carry AR balances, and a duplicate splits the
      // ledger across two records that look identical.
      const dupe = existingTenants.find(t =>
        t.name.trim().toLowerCase() === name.toLowerCase() &&
        (t.property || "") === prop);
      if (dupe) {
        errors.push({ sheet: SHEET_TENANTS, row: r._row, field: "Tenant Name",
          message: `"${name}" already exists at ${prop} (tenant ${dupe.id}). Fill in that row instead.` });
        continue;
      }
      tenantCreates.push({ row: r._row, record: r, status });
    }
  }

  // Gaps become pendencies rather than blocking the import.
  for (const u of updates) {
    const missing = [];
    if (!cellString(u.record.city)) missing.push("city");
    if (!cellString(u.record.state)) missing.push("state");
    if (!cellString(u.record.zip)) missing.push("ZIP");
    if (!cellString(u.record.owner_name)) missing.push("owner");
    if (u.record.bedrooms === null) missing.push("bedrooms");
    if (missing.length) warnings.push({ sheet: SHEET_PROPERTIES, row: u.row, kind: "pendency",
      message: `${u.newAddress}: still missing ${missing.join(", ")}` });
  }
  for (const t of tenantUpdates) {
    if (t.status === "Review") warnings.push({ sheet: SHEET_TENANTS, row: t.row, kind: "pendency",
      message: `${cellString(t.record.name)}: status left as Review — please confirm current or past` });
  }

  // ---- the six optional sheets ---------------------------------------
  //
  // Each row names its property by address, the only handle someone
  // filling in a spreadsheet has. That address must resolve to a property
  // this import is creating or one that already exists; anything else is
  // a typo the user must see, since the alternative is a row that
  // vanishes without trace. Matching forgives case and spacing and
  // nothing else -- a silent near-miss is worse than a named one.
  const norm = (v) => cellString(v).trim().toLowerCase().replace(/\s+/g, " ");
  // Just the street line: "353 Gatewater Ct" out of
  // "353 Gatewater Ct, Glen Burnie, MD 21061". People filling in the
  // Utilities or HOA sheet write the short form, and matching only on
  // the full address rejected every row whose property already carried
  // a city and ZIP -- 9 errors on one real import, all of them
  // properties that existed.
  // Deliberately NOT propertyLabel(): an import matching key, compared
  // against street lines from the spreadsheet. A label is for display.
  const street = (v) => norm(String(cellString(v)).split(",")[0]);
  const addressTargets = new Map();
  const addStreet = (map, key, val) => { if (key && !map.has(key)) map.set(key, val); };
  const streetTargets = new Map();

  creates.forEach(c => {
    addressTargets.set(norm(c.newAddress), { address: c.newAddress, creating: true });
    addStreet(streetTargets, street(c.newAddress), { address: c.newAddress, creating: true });
  });
  updates.forEach(u => {
    addressTargets.set(norm(u.newAddress), { address: u.newAddress, id: u.id });
    addStreet(streetTargets, street(u.newAddress), { address: u.newAddress, id: u.id });
  });
  existingProperties.forEach(p => {
    const k = norm(p.address);
    if (!addressTargets.has(k)) addressTargets.set(k, { address: p.address, id: String(p.id) });
    addStreet(streetTargets, street(p.address), { address: p.address, id: String(p.id) });
    // The property may be mid-rename in this very import, in which case
    // its OLD street line should still resolve.
    addStreet(streetTargets, street(p.address_line_1), { address: p.address, id: String(p.id) });
  });
  // Exact address wins; street line is the fallback. A street line that
  // is ambiguous across two properties is not used at all -- guessing
  // which one the user meant is worse than saying so.
  const streetCounts = new Map();
  const bump = (k) => streetCounts.set(k, (streetCounts.get(k) || 0) + 1);
  creates.forEach(c => bump(street(c.newAddress)));
  updates.forEach(u => bump(street(u.newAddress)));
  existingProperties.forEach(p => { if (!updates.some(u => String(u.id) === String(p.id))) bump(street(p.address)); });
  const resolveTarget = (v) => {
    const exact = addressTargets.get(norm(v));
    if (exact) return exact;
    const k = street(v);
    if (streetCounts.get(k) > 1) return null;   // ambiguous: refuse to guess
    return streetTargets.get(k) || null;
  };

  const attached = { utilities: [], hoas: [], loan: [], insurance: [], taxes: [], recurring: [] };
  const singleSeen = new Map();
  const bySheet = { utilities, hoas, loan, insurance, taxes, recurring };

  for (const { sheet, key, many, columns } of EXTRA_SHEETS) {
    for (const r of (bySheet[key] || [])) {
      const where = `${sheet} row ${r._row}`;
      const target = resolveTarget(r.property);
      if (!target) {
        errors.push({ sheet, row: r._row, field: "Property",
          message: `${where}: no property called "${cellString(r.property)}". It must match a property on the Properties sheet, or one you already have.` });
        continue;
      }
      const missing = columns
        .filter(c => c.required && c.key !== "property" && !cellString(r[c.key]))
        .map(c => c.header);
      if (missing.length) {
        errors.push({ sheet, row: r._row, field: missing[0],
          message: `${where}: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required.` });
        continue;
      }
      if (!many) {
        const k = `${sheet}|${norm(r.property)}`;
        if (singleSeen.has(k)) {
          errors.push({ sheet, row: r._row, field: "Property",
            message: `${where}: ${sheet} takes one row per property, and row ${singleSeen.get(k)} already covers "${cellString(r.property)}".` });
          continue;
        }
        singleSeen.set(k, r._row);
      }
      // Half a credential signs in to nothing.
      if (columns.some(c => c.credential)) {
        const u = cellString(r.username), pw = cellString(r.password);
        if ((u && !pw) || (pw && !u)) {
          warnings.push({ sheet, row: r._row, kind: "pendency",
            message: `${where}: ${u ? "username with no password" : "password with no username"} — the login will not be usable.` });
        }
      }
      // An HOA with no name is named after its property, so the row
      // survives and still has a stable key to match on next time.
      const row = { ...r };
      if (key === "hoas" && !cellString(row.hoa_name)) {
        // Deliberately NOT propertyLabel(): this WRITES hoa_name to the
        // database. Changing how it is derived would rename existing HOAs
        // on the next import rather than just relabelling a column.
        row.hoa_name = `${String(target.address).split(",")[0].trim()} HOA`;
        warnings.push({ sheet, row: r._row, kind: "pendency",
          message: `${where}: no HOA name given — saved as "${row.hoa_name}". Rename it on the property if you like.` });
      }
      // property_taxes.annual_tax_amount is NOT NULL, so a row without
      // one can only update a tax record that already exists. Say so
      // rather than rejecting the county and parcel id outright.
      if (key === "taxes" && !cellString(row.annual_tax_amount)) {
        warnings.push({ sheet, row: r._row, kind: "pendency",
          message: `${where}: no annual amount — the other details are saved only if this property already has a tax record.` });
      }
      attached[key].push({ ...row, _address: target.address, _propertyId: target.id || null,
                           _creating: !!target.creating });
    }
  }

  // Recurring rent for a property that already exists cannot be written
  // by the import: the entry posts money and needs its debit and credit
  // accounts resolved, which only the wizard's RPC does. Say so, once
  // per row, rather than dropping it in silence.
  //
  // The other five sheets used to warn here too -- "already exists, this
  // row will be added to it" -- on every single row. That was 132 of one
  // real import's 195 approvals, it told the user nothing they did not
  // already know, and it was false: nothing was being added at all.
  for (const r of attached.recurring) {
    if (!r._creating) {
      warnings.push({ sheet: SHEET_RECURRING, row: r._row, kind: "pendency",
        message: `${r._address}: recurring rent must be set on the property itself — this row is not imported.` });
    }
  }

  const extraRecords = Object.values(attached).reduce((n, a) => n + a.length, 0);

  return {
    creates, updates, renames, tenantCreates, tenantUpdates, errors, warnings,
    extras: attached,
    summary: {
      propertiesToCreate: creates.length,
      propertiesToUpdate: updates.length,
      addressChanges: renames.length,
      tenantsToCreate: tenantCreates.length,
      tenantsToUpdate: tenantUpdates.length,
      utilities: attached.utilities.length, hoas: attached.hoas.length,
      loans: attached.loan.length, insurance: attached.insurance.length,
      taxes: attached.taxes.length, recurring: attached.recurring.length,
      extraRecords,
      errors: errors.length,
      pendencies: warnings.length,
    },
  };
}
