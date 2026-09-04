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
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
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

export async function buildTemplate(ExcelJS, {
  companyName = "", properties = [], tenants = [], owners = [], blankRows = 25,
} = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Housify";
  wb.created = new Date();

  // --- Properties -----------------------------------------------------
  const wsP = wb.addWorksheet(SHEET_PROPERTIES, { views: [{ state: "frozen", ySplit: 1 }] });
  writeHeader(wsP, PROPERTY_COLUMNS);
  properties.forEach((p, i) => {
    const row = wsP.getRow(i + 2);
    PROPERTY_COLUMNS.forEach((c, ci) => { row.getCell(ci + 1).value = p[c.key] ?? null; });
    styleRow(wsP, i + 2, PROPERTY_COLUMNS, p);
  });
  for (let i = 0; i < blankRows; i++) styleRow(wsP, properties.length + 2 + i, PROPERTY_COLUMNS, null);

  const pTypeIdx   = PROPERTY_COLUMNS.findIndex(c => c.key === "type") + 1;
  const pStatusIdx = PROPERTY_COLUMNS.findIndex(c => c.key === "status") + 1;
  const pOwnerIdx  = PROPERTY_COLUMNS.findIndex(c => c.key === "owner_name") + 1;
  const pRows = properties.length + blankRows;
  addListValidation(wsP, pTypeIdx, pRows, PROPERTY_TYPES);
  addListValidation(wsP, pStatusIdx, pRows, PROPERTY_STATUSES);
  addListValidation(wsP, pOwnerIdx, pRows, owners);

  // --- Tenants --------------------------------------------------------
  const wsT = wb.addWorksheet(SHEET_TENANTS, { views: [{ state: "frozen", ySplit: 1 }] });
  writeHeader(wsT, TENANT_COLUMNS);
  tenants.forEach((t, i) => {
    const row = wsT.getRow(i + 2);
    TENANT_COLUMNS.forEach((c, ci) => { row.getCell(ci + 1).value = t[c.key] ?? null; });
    styleRow(wsT, i + 2, TENANT_COLUMNS, t);
  });
  for (let i = 0; i < blankRows; i++) styleRow(wsT, tenants.length + 2 + i, TENANT_COLUMNS, null);

  const tStatusIdx = TENANT_COLUMNS.findIndex(c => c.key === "tenant_status") + 1;
  const tVoucherIdx = TENANT_COLUMNS.findIndex(c => c.key === "is_voucher") + 1;
  const tRows = tenants.length + blankRows;
  addListValidation(wsT, tStatusIdx, tRows, TENANT_STATUSES);
  addListValidation(wsT, tVoucherIdx, tRows, ["Yes", "No"]);

  // --- Instructions ---------------------------------------------------
  const wsI = wb.addWorksheet(SHEET_REFERENCE);
  wsI.columns = [{ width: 4 }, { width: 30 }, { width: 78 }];
  const lines = [
    ["", `Property import — ${companyName}`, ""],
    ["", "", ""],
    ["", "How this works", ""],
    ["", "1.", "Rows already filled in are your existing records. Fill the yellow gaps."],
    ["", "2.", "Add new properties or tenants in the blank rows at the bottom."],
    ["", "3.", "Upload the file back. You will see exactly what will change before anything is saved."],
    ["", "", ""],
    ["", "Do not edit grey columns", "Property ID and Tenant ID identify the record being updated."],
    ["", "", "Changing one retargets the row at a different record. Leave blank to create."],
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

export async function parseWorkbook(ExcelJS, data) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const wsP = wb.getWorksheet(SHEET_PROPERTIES);
  const wsT = wb.getWorksheet(SHEET_TENANTS);
  const p = readSheet(wsP, PROPERTY_COLUMNS);
  const t = readSheet(wsT, TENANT_COLUMNS);
  const fatal = [];
  if (!wsP) fatal.push(`The workbook has no "${SHEET_PROPERTIES}" sheet. Use the downloaded template.`);
  if (p.missingHeaders.length) fatal.push(`Properties sheet is missing: ${p.missingHeaders.join(", ")}`);
  return { properties: p.rows, tenants: t.rows, fatal };
}

// ---- planning -------------------------------------------------------
//
// Produces exactly what will happen, so the preview is the truth rather
// than a summary of it. Nothing here writes.

export function buildImportPlan({ properties = [], tenants = [], existingProperties = [], existingTenants = [] }) {
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
          message: `No property with id ${id}. Do not edit the ID column.` });
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
        errors.push({ sheet: SHEET_TENANTS, row: r._row, field: "Tenant ID",
          message: `No tenant with id ${id}. Do not edit the ID column.` });
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

  return {
    creates, updates, renames, tenantCreates, tenantUpdates, errors, warnings,
    summary: {
      propertiesToCreate: creates.length,
      propertiesToUpdate: updates.length,
      addressChanges: renames.length,
      tenantsToCreate: tenantCreates.length,
      tenantsToUpdate: tenantUpdates.length,
      errors: errors.length,
      pendencies: warnings.length,
    },
  };
}
