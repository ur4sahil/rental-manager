// Column definitions for the six optional sheets of the property import.
//
// Split out of propertyImport.js to keep that file from carrying the
// whole schema: refactor-validation.test.js watches for growth
// concentrating in a single file and says to extract rather than let one
// balloon. This module is data only -- no logic, no imports -- so the
// parser and the planner stay side by side in propertyImport.js.
//
// Every `key` is a real database column, read out of information_schema
// rather than recalled. Writing a column that does not exist is the most
// productive bug class in this codebase and it fails silently.

export const SHEET_UTILITIES = "Utilities";
export const SHEET_HOA = "HOA";
export const SHEET_LOANS = "Loans";
export const SHEET_INSURANCE = "Insurance";
export const SHEET_TAXES = "Property Tax";
export const SHEET_RECURRING = "Recurring Rent";

// Utilities, HOA, loans and insurance all store credentials the same
// way: username_encrypted / password_encrypted with their own iv and
// salt. There is no plaintext column in any of them, so these three
// spreadsheet columns are encrypted on import exactly as the wizard
// encrypts them. The FILE holds plaintext; the database never does.
const CRED_COLUMNS = (what) => [
  { key: "website",  header: "Website",  width: 24 },
  { key: "username", header: "Username", width: 18, credential: true,
    note: `Login for the ${what} account. Encrypted on import; plaintext here.` },
  { key: "password", header: "Password", width: 16, credential: true,
    note: "Encrypted on import. Delete this file once you are done." },
];

export const UTILITY_COLUMNS = [
  { key: "property",       header: "Property",       width: 30, required: true, list: "properties" },
  { key: "provider",       header: "Provider",       width: 22, required: true },
  { key: "responsibility", header: "Paid By",        width: 12, list: "utilityResponsibility" },
  { key: "amount",         header: "Typical Amount", width: 14, numeric: true },
  { key: "due_date",       header: "Next Due",       width: 12, date: true },
  ...CRED_COLUMNS("utility"),
];

export const HOA_COLUMNS = [
  { key: "property",  header: "Property",  width: 30, required: true, list: "properties" },
  { key: "hoa_name",  header: "HOA Name",  width: 24, required: true },
  { key: "amount",    header: "Amount",    width: 12, numeric: true },
  { key: "frequency", header: "Frequency", width: 12, list: "hoaFrequency" },
  { key: "due_date",  header: "Due Date",  width: 12 },
  { key: "notes",     header: "Notes",     width: 26 },
  ...CRED_COLUMNS("HOA"),
];

export const LOAN_COLUMNS = [
  { key: "property",        header: "Property",        width: 30, required: true, list: "properties" },
  { key: "lender_name",     header: "Lender",          width: 22, required: true },
  { key: "loan_type",       header: "Loan Type",       width: 14, list: "loanTypes" },
  { key: "account_number",  header: "Account Number",  width: 18 },
  { key: "original_amount", header: "Original Amount", width: 15, numeric: true },
  { key: "current_balance", header: "Current Balance", width: 15, numeric: true },
  { key: "interest_rate",   header: "Rate %",          width: 9,  numeric: true },
  { key: "monthly_payment", header: "Monthly Payment", width: 15, numeric: true },
  { key: "escrow_included", header: "Escrow Included", width: 15, list: "yesNo" },
  { key: "escrow_amount",   header: "Escrow Amount",   width: 14, numeric: true },
  { key: "loan_start_date", header: "Start Date",      width: 12, date: true },
  { key: "maturity_date",   header: "Maturity Date",   width: 13, date: true },
  ...CRED_COLUMNS("lender"),
];

export const INSURANCE_COLUMNS = [
  { key: "property",          header: "Property",      width: 30, required: true, list: "properties" },
  { key: "provider",          header: "Provider",      width: 22, required: true },
  { key: "policy_number",     header: "Policy Number", width: 18 },
  { key: "coverage_amount",   header: "Coverage",      width: 14, numeric: true },
  { key: "premium_amount",    header: "Premium",       width: 12, numeric: true },
  { key: "premium_frequency", header: "Premium Every", width: 13, list: "premiumFrequency" },
  { key: "expiration_date",   header: "Expires",       width: 12, date: true },
  { key: "notes",             header: "Notes",         width: 24 },
  ...CRED_COLUMNS("insurer"),
];

export const TAX_COLUMNS = [
  { key: "property",              header: "Property",         width: 30, required: true, list: "properties" },
  { key: "county",                header: "County",           width: 16 },
  { key: "jurisdiction",          header: "Jurisdiction",     width: 16 },
  { key: "parcel_id",             header: "Parcel ID",        width: 16 },
  { key: "tax_year",              header: "Tax Year",         width: 10, numeric: true, integer: true },
  { key: "annual_tax_amount",     header: "Annual Amount",    width: 14, numeric: true, required: true },
  { key: "assessed_value",        header: "Assessed Value",   width: 15, numeric: true },
  { key: "billing_frequency",     header: "Billed",           width: 12, list: "taxFrequency" },
  { key: "next_due_date",         header: "Next Due",         width: 12, date: true },
  { key: "escrow_paid_by_lender", header: "Paid From Escrow", width: 16, list: "yesNo" },
  { key: "records_url",           header: "Records URL",      width: 24 },
];

export const RECURRING_COLUMNS = [
  { key: "property",     header: "Property",     width: 30, required: true, list: "properties" },
  { key: "tenant_name",  header: "Tenant",       width: 26, required: true },
  { key: "amount",       header: "Amount",       width: 12, numeric: true, required: true },
  { key: "frequency",    header: "Frequency",    width: 12, list: "recurringFrequency" },
  { key: "day_of_month", header: "Day of Month", width: 13, numeric: true, integer: true },
  { key: "start_date",   header: "Starts",       width: 12, date: true },
];

// `many` marks the sheets that take several rows per property. The rest
// take one, and a second row for the same property is an error rather
// than a silent last-one-wins.
export const EXTRA_SHEETS = [
  { sheet: SHEET_UTILITIES, columns: UTILITY_COLUMNS,   key: "utilities", many: true },
  { sheet: SHEET_HOA,       columns: HOA_COLUMNS,       key: "hoas",      many: true },
  { sheet: SHEET_LOANS,     columns: LOAN_COLUMNS,      key: "loan",      many: false },
  { sheet: SHEET_INSURANCE, columns: INSURANCE_COLUMNS, key: "insurance", many: false },
  { sheet: SHEET_TAXES,     columns: TAX_COLUMNS,       key: "taxes",     many: false },
  { sheet: SHEET_RECURRING, columns: RECURRING_COLUMNS, key: "recurring", many: false },
];

export const UTILITY_RESPONSIBILITY = ["Owner", "Tenant"];
export const HOA_FREQUENCY = ["Monthly", "Quarterly", "Annually"];
export const LOAN_TYPES = ["Mortgage", "HELOC", "Private", "Commercial"];
export const PREMIUM_FREQUENCY = ["Monthly", "Quarterly", "Annually"];
export const TAX_FREQUENCY = ["Annually", "Semi-Annually", "Quarterly"];
export const RECURRING_FREQUENCY = ["Monthly", "Quarterly", "Annually"];
