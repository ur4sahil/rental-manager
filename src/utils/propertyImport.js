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
