// The property import and the setup wizard must not lose or change data.
//
// Audit theme J (owner-approved). Before 20260928140000:
//   - the import's create path sent loans / insurance / taxes without
//     `enabled: true`, so commit_property_wizard ignored every one of them;
//   - the import's "Owner"/"Tenant" responsibility became 'tenant' either way
//     (the RPC only knew the wizard's 'owner_pays');
//   - an edit save of the wizard reset utility/HOA due dates to the 1st, the
//     lease's payment_due_day to 1, marked PAID HOA bills pending, zeroed
//     utility amounts, archived every insurance policy / tax record when the
//     step was not enabled in the payload, and wiped websites it never loaded.
//
// After the adversarial review (same migration, revised): an edit writes only
// the fields the user changed (`_orig` / `_db` per record) and refuses one that
// someone else changed since the wizard opened; old-shape payloads are refused;
// rows are matched by id only; ids from another property are ignored; the
// import matches utilities on provider + account number, refuses duplicate
// keys, and never writes an unrecognised enum as raw text.
//
// STATIC checks read the source; LIVE checks run the real RPC on the TEST
// project as a real signed-in admin, on rows tagged QA-WIZ in the sandbox
// company, diff every row before/after, and delete everything afterwards.
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
require("./sandbox-env");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✅" : "❌"} ${n}${!c && d ? "\n   " + d : ""}`); };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const props = read("src/components/Properties.js");
const imp = read("src/components/PropertyImport.js");
const util = read("src/utils/propertyImport.js");
const MIG = "20260928140000_wizard_keep_existing_data.sql";
const mig = read("supabase/migrations/" + MIG);
const body = mig.slice(mig.indexOf("CREATE OR REPLACE FUNCTION public.commit_property_wizard"));

console.log("\n=== STATIC: commit_property_wizard ===");
{
  const dir = path.join(__dirname, "..", "supabase", "migrations");
  const hits = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort()
    .filter(f => /CREATE OR REPLACE FUNCTION public\.commit_property_wizard\(/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert("140000 is the latest definition of commit_property_wizard", hits[hits.length - 1] === MIG, hits.slice(-2).join(", "));
}
assert("keeps SECURITY DEFINER and the same signature",
  /FUNCTION public\.commit_property_wizard\(p_payload jsonb\)\s+RETURNS jsonb\s+LANGUAGE plpgsql\s+SECURITY DEFINER/.test(body));
assert("no GRANT/REVOKE on commit_property_wizard (ACL kept by CREATE OR REPLACE)",
  !/(GRANT|REVOKE)[^;]*commit_property_wizard/.test(mig));
assert("utilities are no longer archived wholesale",
  !/UPDATE utilities SET archived_at = now\(\)\s+WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL AND is_final_bill IS NOT TRUE;/.test(body));
assert("HOA dues are no longer archived wholesale",
  !/UPDATE hoa_payments SET archived_at = now\(\), archived_by = v_caller_email\s+WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;/.test(body));
assert("removal is limited to rows the form SAW and the payload dropped",
  /id::text NOT IN \(SELECT e->>'id' FROM jsonb_array_elements\(v_utilities\)/.test(body)
  && /id::text NOT IN \(SELECT e->>'id' FROM jsonb_array_elements\(v_hoas\)/.test(body));
assert("rows are matched by id only: no provider / HOA-name fallback that merges a new row into an old one",
  !/lower\(btrim\(provider\)\) = lower\(btrim\(v_u->>'provider'\)\)/.test(body) && !/lower\(btrim\(hoa_name\)\) = lower/.test(body));
assert("an edit from an out-of-date client is refused",
  /payload_version/.test(body) && /Please reload the app/.test(body));
assert("only staff may commit (owner and pm removed)",
  /v_caller_role NOT IN \('admin','manager','office_assistant'\)/.test(body));
assert("a field is written only if the user changed it, and refused if someone else changed it since",
  (body.match(/_wizard_chg\(/g) || []).length > 80 && (body.match(/PERFORM public\._wizard_guard\(/g) || []).length >= 9);
assert("loan / insurance / tax ids are looked up within THIS property",
  ["property_loans", "property_insurance", "property_taxes"].every(t =>
    new RegExp(`FROM ${t} x\\s+WHERE id::text = v_(loan|ins|tax)_id AND company_id = v_company_id AND property = v_address`).test(body)));
assert("an existing HOA row never has status / paid_date written",
  !/UPDATE hoa_payments SET[\s\S]{0,4000}?\bstatus\s*=/.test(body.slice(body.indexOf("─── HOAs"))) && !/paid_date\s*=/.test(body));
assert("the lease update no longer forces payment_due_day = 1",
  !/UPDATE leases SET[^;]*payment_due_day = 1/.test(body));
assert("insurance / tax / loan are archived only when the payload names the record",
  /ELSIF v_mode = 'edit' AND v_insurance IS NOT NULL AND NULLIF\(v_insurance->>'id',''\) IS NOT NULL/.test(body)
  && /ELSIF v_mode = 'edit' AND v_taxes IS NOT NULL AND NULLIF\(v_taxes->>'id',''\) IS NOT NULL/.test(body)
  && /ELSIF v_mode = 'edit' AND v_loan IS NOT NULL AND NULLIF\(v_loan->>'id',''\) IS NOT NULL/.test(body)
  && !/UPDATE property_insurance SET archived_at = now\(\)\s+WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;/.test(body));
assert("websites: blank keeps the stored one on every update",
  ["v_u", "v_h", "v_loan", "v_insurance"].every(v => body.includes(`COALESCE(NULLIF(${v}->>'website',''), website)`)));
assert("responsibility maps the import's 'owner'/'tenant', and blank is not guessed",
  /WHEN 'owner' THEN 'owner'/.test(body) && /WHEN 'tenant' THEN 'tenant'/.test(body) && !/ELSE 'tenant' END/.test(body));
for (const t of ["utilities", "hoa_payments", "property_loans", "property_insurance"]) {
  const ins = new RegExp(`INSERT INTO ${t} \\([^)]*credential_key_fp`).test(body);
  assert(`credential_key_fp persisted on insert into ${t}`, ins);
}
assert("credential_key_fp persisted on every credential UPDATE",
  (body.match(/credential_key_fp = /g) || []).length >= 4);
assert("tenant late fee / move_in / notice are kept",
  /COALESCE\(NULLIF\(v_tenant->>'late_fee_amount',''\)::numeric, late_fee_amount\)/.test(body)
  && /COALESCE\(move_in,/.test(body)
  && /OR lease_status = 'notice'\s+THEN lease_status ELSE 'active' END/.test(body));
assert("recurring rent is stopped only on an explicit clear", /recurring_cleared/.test(body));
assert("the wizard no longer creates or updates a mortgage recurring schedule (owner decision, theme K)",
  !/INSERT INTO recurring_journal_entries[\s\S]{0,400}Mortgage\/Loan Payment/.test(body) && !/setup_recurring/.test(body.replace(/--.*$/gm, "")));
assert("NULLs written by other pages are not turned into '' / 0 / false",
  /_wizard_txt\(v_insurance->>'policy_number', policy_number\)/.test(body) && /_wizard_num\(v_insurance->>'coverage_amount', coverage_amount\)/.test(body)
  && /_wizard_bool\(v_tenant->>'is_voucher', is_voucher\)/.test(body));

console.log("\n=== STATIC: wizard client ===");
assert("due day is parsed from the stored DATE, not Number(date) || 1",
  !/Number\([uh]\.due_date\) \|\| 1/.test(props) && (props.match(/due_day: dueDayOf\(/g) || []).length === 2);
assert("the live loader keeps each utility / HOA row id",
  /seenHoaIds\.current = hoaRows\.map\(h => h\.id\)/.test(props) && /seenUtilIds\.current = utilRows\.map\(u => u\.id\)/.test(props)
  && /\.\.\.\(u\.id \? \{ id: u\.id, \.\.\.withOrig\("utility"/.test(props) && /\.\.\.\(h\.id \? \{ id: h\.id, \.\.\.withOrig\("hoa"/.test(props));
assert("every loaded record is sent with how it was loaded (_orig / _db) and payload_version 2",
  /payload_version: 2/.test(props) && ["property", "tenant", "loan", "insurance", "taxes", "recurring"].every(k => props.includes(`withOrig("${k}"`)));
assert("a tenant on notice is loaded (LIVE_TENANCY), so a save never treats them as absent",
  /\.in\("lease_status", LIVE_TENANCY\)/.test(props));
assert("an existing HOA with no amount no longer blocks every save", /if \(!h\.id && \(!h\.amount/.test(props));
assert("the commit sends the seen ids",
  /hoas_seen_ids:/.test(props) && /utilities_seen_ids:/.test(props));
assert("a switched-off loan / policy / tax record is named, anything else sends null",
  /loan: pre\.loan \|\| \(loan\.id \? \{ enabled: false, id: loan\.id \} : null\)/.test(props)
  && /insurance: pre\.insurance \|\| \(insurance\.id \? \{ enabled: false, id: insurance\.id \} : null\)/.test(props)
  && /\(taxes\.id \? \{ enabled: false, id: taxes\.id \} : null\)/.test(props));
assert("the never-wizarded path uses the shared loader (no private copy dropping websites)",
  /await loadLiveWizardData\(existProp\.address\)/.test(props)
  && !/setInsurance\(\{ enabled: true, provider: i\.provider/.test(props));
assert("a completed wizard refreshes property details from the live row",
  /loadLiveWizardData\(addr, \{ refreshProperty: true \}\)/.test(props));
assert("tenant late fee is read back so a save carries it",
  /late_fee_amount: primary\.late_fee_amount \?\? ""/.test(props));

console.log("\n=== STATIC: property import ===");
assert("the create path goes through importCreatePayload (enabled flags)", /importCreatePayload\(recs,/.test(imp));
assert("loans past the first are written for a NEW property", /const moreLoans = \(recs\.loans \|\| \[\]\)\.slice\(1\)/.test(imp));
assert("re-import never resets a utility's status or a loan's status",
  /onInsert: \{ status: "pending" \}/.test(imp) && /onInsert: \{ status: loanStatus \|\| "active" \}/.test(imp)
  && !/responsibility: u\.responsibility, status: "pending"/.test(imp));
assert("the download pre-fills Next Due from `due` (the column the app uses)",
  /select\("property,provider,account_number,responsibility,amount,due,due_date,website"\)/.test(imp));
assert("the download carries websites for every sheet that has one",
  /hoa_name,amount,frequency,due_date,notes,website/.test(imp) && /maturity_date,website/.test(imp) && /expiration_date,notes,website/.test(imp));
assert("utilities are matched on provider AND account number", /put\("utilities", \{ provider: u\.provider, account_number: u\.account_number \|\| null \}/.test(imp));
assert("a blank cell keeps the stored value on re-import (utility, HOA due, tax next due, websites)",
  /keepIfBlank: \["amount", "due", "responsibility", "website"\]/.test(imp)
  && /keepIfBlank: \["amount", "frequency", "due_date", "notes", "website"\]/.test(imp)
  && /keepIfBlank: \["next_due_date"/.test(imp));
assert("a new property keeps its beds/baths/sqft/rent/licences", /await writeLicences\(r, created\.property_id/.test(imp));
assert("recurring rows that cannot be imported are shown on the Done step", /result\.recurringSkipped > 0/.test(imp));
assert("the subRecordsFor field mapping this test mirrors is still the component's",
  imp.includes('provider: cellString(u.provider), account_number: cellString(u.account_number) || null,')
  && imp.includes('responsibility: enumVal("responsibility", u.responsibility),')
  && imp.includes('amount: u.amount ?? null, due_date: u.due_date || null,'));

const { importCreatePayload, importEnumValue, buildTemplate, parseWorkbook, buildImportPlan, computeAddress, cellString,
        PROPERTY_COLUMNS, UTILITY_COLUMNS, HOA_COLUMNS, LOAN_COLUMNS, INSURANCE_COLUMNS, TAX_COLUMNS,
        SHEET_PROPERTIES, SHEET_UTILITIES, SHEET_HOA, SHEET_LOANS, SHEET_INSURANCE, SHEET_TAXES } =
  await import("../src/utils/propertyImport.js");

console.log("\n=== UNIT: importCreatePayload ===");
{
  const reports = [];
  const out = importCreatePayload({
    utilities: [], hoas: [{ hoa_name: "X", amount: 10, due_date: "15th" }, { hoa_name: "Y", amount: 20, due_date: "2026-10-20" }, { hoa_name: "Z", amount: null }],
    loan: { lender_name: "L" }, loans: [{ lender_name: "L" }, { lender_name: "M" }],
    insurance: { provider: "I" }, taxes: { county: "C", annual_tax_amount: null }, recurring: null,
  }, (w) => reports.push(w));
  assert("loan and insurance are sent enabled", out.loan?.enabled === true && out.insurance?.enabled === true);
  assert("a tax row / new HOA with no amount is skipped and REPORTED (not a failed property)",
    out.taxes === null && out.hoas.length === 2 && reports.length === 2, JSON.stringify(reports));
  assert("an HOA due of '15th' becomes day 15; a date stays a date",
    out.hoas[0].due_day === 15 && out.hoas[0].due_date === null && out.hoas[1].due_date === "2026-10-20");
  assert("the RPC payload does not carry the extra-loans list", !("loans" in out));
  const withTax = importCreatePayload({ utilities: [], hoas: [], taxes: { annual_tax_amount: 10 } });
  assert("a tax row with an amount is sent enabled", withTax.taxes?.enabled === true);
  assert("'Owner' maps to owner, blank to null (not guessed)",
    importEnumValue("responsibility", "Owner") === "owner" && importEnumValue("responsibility", "") === null);
  assert("responsibility read the way people type it; unknown text is never written raw",
    importEnumValue("responsibility", "OWNER PAYS") === "owner" && importEnumValue("responsibility", "Landlord") === "owner"
    && importEnumValue("responsibility", "Tenant pays") === "tenant" && importEnumValue("responsibility", "condo fee") === "condo_fee"
    && importEnumValue("responsibility", "split 50/50") === null && importEnumValue("hoaFrequency", "fortnightly") === null
    && importEnumValue("loanType", "Balloon") === null);
}

console.log("\n=== UNIT: the import plan ===");
{
  const A = "1 Plan St, Town, MD 20001";
  const plan = buildImportPlan({
    properties: [{ _row: 2, address_line_1: "1 Plan St", city: "Town", state: "MD", zip: "20001", type: "Single Family", status: "vacant" }],
    tenants: [], existingProperties: [], existingTenants: [],
    utilities: [{ _row: 2, property: A, provider: "Pepco", account_number: "1", responsibility: "Owner" },
                { _row: 3, property: A, provider: "Pepco", account_number: "2", responsibility: "Tenant" },
                { _row: 4, property: A, provider: "pepco", account_number: "1", responsibility: "split" }],
    hoas: [{ _row: 2, property: A, hoa_name: "Oaks", amount: 10 }, { _row: 3, property: A, hoa_name: "OAKS", amount: 20 }],
    loan: [{ _row: 2, property: A, lender_name: "Chase" }, { _row: 3, property: A, lender_name: "chase" }],
    insurance: [], taxes: [], recurring: [],
  });
  const msgs = plan.errors.map(e => `${e.sheet} ${e.row}`);
  assert("two utilities with the same provider + account number are refused; different accounts are fine",
    msgs.includes("Utilities 4") && !msgs.includes("Utilities 3"), JSON.stringify(msgs));
  assert("two HOAs / two loans with the same name on one property are refused",
    msgs.includes("HOA 3") && msgs.includes("Loans 3"), JSON.stringify(msgs));
  const { hoaDue } = await import("../src/utils/propertyImport.js");
  assert("HOA due: '15' / '15th' is a day, a date is a date, junk is reported",
    hoaDue("15").day === 15 && hoaDue("15th").day === 15 && hoaDue("2026-10-20").date === "2026-10-20" && !!hoaDue("mid-month").bad && hoaDue("") === null);
  const p2 = buildImportPlan({
    properties: [{ _row: 2, address_line_1: "1 Plan St", city: "Town", state: "MD", zip: "20001", type: "Single Family", status: "vacant" }],
    tenants: [], existingProperties: [], existingTenants: [],
    utilities: [{ _row: 2, property: A, provider: "Pepco", responsibility: "split 50/50" }], hoas: [], loan: [], insurance: [], taxes: [], recurring: [],
  });
  assert("an unrecognised Paid By is warned about (it will be left blank)", p2.warnings.some(w => /split 50\/50/.test(w.message)));
}

// ─────────────────────────────── LIVE ───────────────────────────────
const { createClient } = require("@supabase/supabase-js");
const URL_ = process.env.TEST_SUPABASE_URL, ANON = process.env.TEST_SUPABASE_ANON_KEY;
const svc = createClient(URL_, process.env.TEST_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const user = createClient(URL_, ANON, { auth: { persistSession: false } });
const { error: authErr } = await user.auth.signInWithPassword({ email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD });
const CID = "sandbox-llc";
const TAG = "QA-WIZ";
const EVIDENCE = process.env.WIZ_EVIDENCE === "1";

const SUBS = ["utilities", "hoa_payments", "property_loans", "property_insurance", "property_taxes", "leases", "tenants", "property_licenses"];
async function cleanup() {
  const { data: ps } = await svc.from("properties").select("id,address").eq("company_id", CID).like("address", TAG + "%");
  const addrs = (ps || []).map(p => p.address), ids = (ps || []).map(p => p.id);
  const { data: ts } = await svc.from("tenants").select("id").eq("company_id", CID).like("name", TAG + "%");
  const tids = (ts || []).map(t => t.id);
  // The utility-account bridge makes one utility_accounts row per utility.
  await svc.from("utility_accounts").delete().eq("company_id", CID).like("property", TAG + "%");
  if (tids.length) {
    await svc.from("recurring_journal_entries").delete().eq("company_id", CID).in("tenant_id", tids);
    await svc.from("acct_accounts").delete().eq("company_id", CID).in("tenant_id", tids);
  }
  if (addrs.length) {
    for (const t of ["utilities", "hoa_payments", "property_loans", "property_insurance", "property_taxes", "leases", "tenants", "recurring_journal_entries", "property_setup_wizard"]) {
      const col = t === "property_setup_wizard" ? "property_address" : "property";
      await svc.from(t).delete().eq("company_id", CID).in(col, addrs);
    }
    await svc.from("property_licenses").delete().eq("company_id", CID).in("property_id", ids);
    await svc.from("acct_classes").delete().eq("company_id", CID).in("name", addrs);
    await svc.from("properties").delete().eq("company_id", CID).in("id", ids);
  }
}
async function leftovers() {
  const n = {};
  const like = async (t, col) => {
    const { count } = await svc.from(t).select("*", { count: "exact", head: true }).eq("company_id", CID).like(col, TAG + "%");
    n[`${t}.${col}`] = count || 0;
  };
  await like("properties", "address");
  await like("utility_accounts", "property");
  for (const t of ["utilities", "hoa_payments", "property_loans", "property_insurance", "property_taxes", "leases", "tenants", "recurring_journal_entries"]) await like(t, "property");
  await like("tenants", "name");
  await like("acct_classes", "name");
  await like("property_setup_wizard", "property_address");
  return n;
}

if (authErr) {
  console.log(`\n(skipping live checks: ${authErr.message})`);
} else {
  await cleanup();
  const rpc = async (payload) => user.rpc("commit_property_wizard", { p_payload: payload });
  try {
    // ── 1. IMPORT: a new property with every optional sheet ──────────────
    console.log("\n=== LIVE: import creates a property with loans / insurance / taxes / owner-paid utility ===");
    const ExcelJS = require(path.join(__dirname, "..", "node_modules", "exceljs"));
    const rec = { address_line_1: `${TAG} 11 Import Way`, city: "Testville", state: "MD", zip: "20001",
                  type: "Single Family", status: "vacant", bedrooms: 3, sqft: 1400, year_built: 1965, rent: 2100 };
    const ADDR1 = computeAddress(rec);
    const wb = await buildTemplate(ExcelJS, { companyName: "QA", mode: "add", blankRows: 5 });
    const put = (sheet, cols, rowNo, obj) => {
      const ws = wb.getWorksheet(sheet);
      const hdr = {}; ws.getRow(1).eachCell((c, i) => { hdr[cellString(c.value).toLowerCase()] = i; });
      for (const [k, v] of Object.entries(obj)) {
        const col = cols.find(c => c.key === k);
        if (!col) throw new Error(`no column ${k} on ${sheet}`);
        ws.getRow(rowNo).getCell(hdr[col.header.toLowerCase()]).value = v;
      }
    };
    put(SHEET_PROPERTIES, PROPERTY_COLUMNS, 2, rec);
    put(SHEET_UTILITIES, UTILITY_COLUMNS, 2, { property: ADDR1, provider: `${TAG} Power`, responsibility: "Owner", amount: 120, due_date: "2026-10-15" });
    put(SHEET_UTILITIES, UTILITY_COLUMNS, 3, { property: ADDR1, provider: `${TAG} Water`, responsibility: "Tenant", amount: 40 });
    put(SHEET_HOA, HOA_COLUMNS, 2, { property: ADDR1, hoa_name: `${TAG} HOA`, amount: 250, frequency: "Monthly", due_date: "15" });
    put(SHEET_LOANS, LOAN_COLUMNS, 2, { property: ADDR1, lender_name: `${TAG} Bank A`, loan_type: "Mortgage", original_amount: 200000, current_balance: 150000, interest_rate: 4.5, monthly_payment: 1200, loan_start_date: "2020-01-01" });
    put(SHEET_LOANS, LOAN_COLUMNS, 3, { property: ADDR1, lender_name: `${TAG} Bank B`, loan_type: "HELOC", original_amount: 30000, current_balance: 10000 });
    put(SHEET_INSURANCE, INSURANCE_COLUMNS, 2, { property: ADDR1, provider: `${TAG} Insure`, policy_number: "P-1", coverage_amount: 300000, premium_amount: 1200, premium_frequency: "Annually", expiration_date: "2027-01-01" });
    put(SHEET_TAXES, TAX_COLUMNS, 2, { property: ADDR1, county: "Testco", jurisdiction: "Testville", parcel_id: "PX-1", tax_year: 2026, annual_tax_amount: 3600, billing_frequency: "Semi-Annually", next_due_date: "2026-12-31" });
    const parsed = await parseWorkbook(ExcelJS, await wb.xlsx.writeBuffer());
    const plan = buildImportPlan({ ...parsed, existingProperties: [], existingTenants: [], loan: parsed.loan });
    assert("the sheet plans 1 new property with 2 utilities, 1 HOA, 2 loans, 1 policy, 1 tax row",
      plan.creates.length === 1 && plan.summary.utilities === 2 && plan.summary.hoas === 1 && plan.summary.loans === 2
      && plan.summary.insurance === 1 && plan.summary.taxes === 1, JSON.stringify(plan.summary) + JSON.stringify(plan.errors));

    // subRecordsFor, field for field (no logins: that part is someone else's
    // and needs /api/encrypt). The static check above pins these lines.
    const ex = plan.extras, mine = (l) => (l || []).filter(r => r._address === ADDR1);
    const yes = (v) => /^(y|yes|true|1)$/i.test(cellString(v));
    const loanRows = mine(ex.loan).map(l => ({
      lender_name: cellString(l.lender_name), loan_type: importEnumValue("loanType", l.loan_type), status: "active",
      account_number: cellString(l.account_number) || null, original_amount: l.original_amount ?? null,
      current_balance: l.current_balance ?? null, interest_rate: l.interest_rate ?? null, monthly_payment: l.monthly_payment ?? null,
      escrow_included: yes(l.escrow_included), escrow_amount: l.escrow_amount ?? null,
      loan_start_date: l.loan_start_date || null, maturity_date: l.maturity_date || null, website: null }));
    const i0 = mine(ex.insurance)[0], t0 = mine(ex.taxes)[0];
    const recs = {
      utilities: mine(ex.utilities).map(u => ({ provider: cellString(u.provider), responsibility: importEnumValue("responsibility", u.responsibility),
        amount: u.amount ?? null, due_date: u.due_date || null, website: null })),
      hoas: mine(ex.hoas).map(h => ({ hoa_name: cellString(h.hoa_name), amount: h.amount ?? null, frequency: importEnumValue("hoaFrequency", h.frequency),
        due_date: cellString(h.due_date) || null, notes: cellString(h.notes) || null, website: null })),
      loan: loanRows[0], loans: loanRows,
      insurance: { provider: cellString(i0.provider), policy_number: cellString(i0.policy_number) || null, coverage_amount: i0.coverage_amount ?? null,
        premium_amount: i0.premium_amount ?? null, premium_frequency: importEnumValue("premiumFrequency", i0.premium_frequency),
        expiration_date: i0.expiration_date || null, notes: null, website: null },
      taxes: { county: cellString(t0.county) || null, jurisdiction: cellString(t0.jurisdiction) || null, parcel_id: cellString(t0.parcel_id) || null,
        tax_year: t0.tax_year ?? null, annual_tax_amount: t0.annual_tax_amount ?? null, assessed_value: t0.assessed_value ?? null,
        billing_frequency: importEnumValue("taxFrequency", t0.billing_frequency), next_due_date: t0.next_due_date || null,
        escrow_paid_by_lender: yes(t0.escrow_paid_by_lender), records_url: null },
      recurring: null,
    };
    const r = plan.creates[0].record;
    const { data: created, error: cErr } = await rpc({
      company_id: CID, wizard_id: null, mode: "fresh", property_id_for_edit: null,
      property: { address: ADDR1, address_line_1: r.address_line_1, address_line_2: r.address_line_2 || "", city: r.city, state: r.state,
                  zip: r.zip, county: r.county || "", type: r.type, status: r.status, notes: r.notes || "" },
      tenant: null, ...importCreatePayload(recs),
    });
    assert("commit_property_wizard accepted the import payload", !cErr && created?.property_id, cErr?.message);
    // PropertyImport then writes loans past the first (put -> insert, status on insert only).
    for (const ln of loanRows.slice(1)) {
      const { status, ...rest } = ln;
      await svc.from("property_loans").insert([{ status: status || "active", ...rest, property_id: String(created.property_id), company_id: CID, property: ADDR1 }]);
    }
    const q = (t) => svc.from(t).select("*").eq("company_id", CID).eq("property", ADDR1).is("archived_at", null);
    const [{ data: u1 }, { data: h1 }, { data: l1 }, { data: in1 }, { data: tx1 }] = await Promise.all([q("utilities"), q("hoa_payments"), q("property_loans"), q("property_insurance"), q("property_taxes")]);
    const power = (u1 || []).find(u => u.provider === `${TAG} Power`), water = (u1 || []).find(u => u.provider === `${TAG} Water`);
    assert("owner-paid utility lands as OWNER, with its amount and due date",
      power?.responsibility === "owner" && Number(power?.amount) === 120 && power?.due === "2026-10-15", JSON.stringify(power));
    assert("tenant-paid utility lands as TENANT; a blank Next Due stays blank (no invented 1st)",
      water?.responsibility === "tenant" && Number(water?.amount) === 40 && water?.due === null, JSON.stringify(water));
    assert("the HOA lands with due day 15", (h1 || []).length === 1 && /-15$/.test(h1[0].due_date), JSON.stringify(h1));
    assert("both loans land", (l1 || []).length === 2, `${(l1 || []).length}`);
    assert("the insurance policy lands (annual)", (in1 || []).length === 1 && in1[0].premium_frequency === "annual" && in1[0].policy_number === "P-1", JSON.stringify(in1));
    assert("the tax record lands with county / jurisdiction / amount",
      (tx1 || []).length === 1 && tx1[0].county === "Testco" && tx1[0].jurisdiction === "Testville" && Number(tx1[0].annual_tax_amount) === 3600
      && tx1[0].billing_frequency === "semi_annual", JSON.stringify(tx1));
    if (EVIDENCE) console.log("   evidence(import):", JSON.stringify({ utilities: u1.map(u => [u.provider, u.responsibility, u.amount, u.due]),
      hoa: h1.map(h => [h.hoa_name, h.due_date]), loans: l1.map(l => l.lender_name), insurance: in1.map(i => i.provider), taxes: tx1.map(t => [t.county, t.annual_tax_amount]) }));

    // ── 2. WIZARD EDIT: an existing property with data entered elsewhere ──
    console.log("\n=== LIVE: wizard edit save keeps everything it did not change ===");
    const P2 = { address_line_1: `${TAG} 22 Edit St`, address_line_2: "", city: "Testville", state: "MD", zip: "20001", county: "Testco",
                 type: "Single Family", status: "occupied", notes: "original notes" };
    const TEN = { tenant: `${TAG} Tenant`, tenant_first: "QA", tenant_mi: "", tenant_last: "Tenant", tenant_email: "qa-wiz@example.com",
                  tenant_phone: "555-0100", rent: "1500", security_deposit: "1500", lease_start: "2025-01-01", lease_end: "2026-12-31" };
    const { data: c2, error: c2e } = await rpc({ company_id: CID, mode: "fresh", property: P2, tenant: TEN, utilities: [], hoas: [] });
    assert("set-up property created", !c2e && c2?.property_id, c2e?.message);
    const ADDR2 = c2.address, PID = c2.property_id;
    // A rent schedule as the Accounting page would hold it. (Created directly:
    // the sandbox company's AR codes include "1100-T28", which the pre-existing
    // _wizard_get_tenant_ar cannot number past.)
    await svc.from("recurring_journal_entries").insert([{ company_id: CID, description: `Monthly rent — ${TAG} Tenant — ${TAG} 22 Edit St`,
      frequency: "monthly", day_of_month: 1, amount: 1500, tenant_name: `${TAG} Tenant`, tenant_id: c2.tenant_id, property: ADDR2,
      status: "active", next_post_date: "2026-10-01" }]);
    // What other pages would have stored since.
    await svc.from("properties").update({ year_built: 1970 }).eq("id", PID);
    await svc.from("leases").update({ payment_due_day: 5 }).eq("company_id", CID).eq("property", ADDR2);
    await svc.from("tenants").update({ late_fee_amount: 75, late_fee_type: "percent", move_in: "2024-12-15" }).eq("id", c2.tenant_id);
    const cred = (p) => ({ username_encrypted: p + "-u", password_encrypted: p + "-p", encryption_iv: p + "-iv",
                           encryption_iv_username: p + "-ivu", encryption_salt: p + "-salt", credential_key_fp: p + "-fp" });
    const ins = async (t, row) => { const { data, error } = await svc.from(t).insert([{ company_id: CID, property: ADDR2, ...row }]).select("*").single(); if (error) throw new Error(t + ": " + error.message); return data; };
    const uPow = await ins("utilities", { provider: `${TAG} Power`, type: "Electric", account_number: "A-1", amount: 133.45, due: "2026-10-15", responsibility: "owner", status: "paid", website: "https://power.example", ...cred("u1") });
    await ins("utilities", { provider: `${TAG} Gas`, type: "Gas", account_number: "G-7", amount: 61.2, due: "2026-10-22", responsibility: "tenant", status: "pending", website: "https://gas.example" });
    await ins("hoa_payments", { hoa_name: `${TAG} HOA`, amount: 250, due_date: "2026-10-20", frequency: "Monthly", status: "paid", paid_date: "2026-09-10", notes: "hoa notes",
      website: "https://hoa.example", ...cred("h1"), management_company: "QA Mgmt", mgmt_website: "https://mgmt.example", contact_name: "Pat", contact_email: "pat@example.com", contact_phone: "555-0101" });
    await ins("property_loans", { property_id: String(PID), lender_name: `${TAG} Lender`, loan_type: "Conventional", original_amount: 250000, current_balance: 200000, interest_rate: 5,
      monthly_payment: 1500, account_number: "L-9", notes: "loan notes", website: "https://lender.example", ...cred("l1") });
    await ins("property_insurance", { property_id: String(PID), provider: `${TAG} Insure A`, policy_number: "IA-1", premium_amount: 900, premium_frequency: "annual",
      coverage_amount: 250000, expiration_date: "2027-03-01", notes: "policy a", website: "https://insa.example", ...cred("i1") });
    await new Promise(r => setTimeout(r, 20));
    await ins("property_insurance", { property_id: String(PID), provider: `${TAG} Insure B`, policy_number: "IB-2", premium_amount: 300, premium_frequency: "annual",
      coverage_amount: 50000, expiration_date: "2027-05-01", notes: "flood", website: "https://insb.example" });
    await ins("property_taxes", { property_id: PID, county: "Testco", jurisdiction: "Testville", parcel_id: "PX-2", tax_year: 2026, annual_tax_amount: 4200,
      billing_frequency: "semi_annual", next_due_date: "2026-12-31", records_url: "https://tax.example", notes: "tax notes" });

    const snapshot = async () => {
      const out = {};
      for (const t of ["utilities", "hoa_payments", "property_loans", "property_insurance", "property_taxes", "leases", "recurring_journal_entries"]) {
        const { data } = await svc.from(t).select("*").eq("company_id", CID).eq("property", ADDR2).order("id");
        out[t] = data || [];
      }
      out.properties = (await svc.from("properties").select("*").eq("id", PID)).data || [];
      out.tenants = (await svc.from("tenants").select("*").eq("id", c2.tenant_id)).data || [];
      return out;
    };
    const VOLATILE = new Set(["updated_at"]);
    const diff = (a, b) => {
      const d = [];
      for (const t of Object.keys(a)) {
        const byId = new Map(b[t].map(r => [String(r.id), r]));
        if (a[t].length !== b[t].length) d.push(`${t}: ${a[t].length} rows -> ${b[t].length}`);
        for (const r of a[t]) {
          const s = byId.get(String(r.id));
          if (!s) { d.push(`${t}#${r.id} gone`); continue; }
          for (const k of Object.keys(r)) if (!VOLATILE.has(k) && JSON.stringify(r[k]) !== JSON.stringify(s[k])) d.push(`${t}#${r.id}.${k}: ${JSON.stringify(r[k])} -> ${JSON.stringify(s[k])}`);
        }
      }
      return d;
    };

    // The form and payload exactly as the wizard builds them: the helpers are
    // taken from Properties.js itself, so this cannot drift from the client.
    const H = (() => {
      const src = props;
      const block = src.slice(src.indexOf("const respToForm = "), src.indexOf("const loadedRow = "));
      const lr = src.slice(src.indexOf("const loadedRow = ")).split("\n")[0];
      return new Function(block + "\n" + lr + "\nreturn { respToForm, dueDayOf, pickCols, WIZ_DB_COLS, WIZ_FIELDS, withOrig, loadedRow };")();
    })();
    const loadForm = async () => {
      const q = (t) => user.from(t).select("*").eq("company_id", CID).eq("property", ADDR2).is("archived_at", null);
      const [hoas, utils, loans, inss, taxes] = await Promise.all([q("hoa_payments"), q("utilities"), q("property_loans"),
        q("property_insurance").order("created_at", { ascending: true }), q("property_taxes").order("created_at", { ascending: true })]);
      const f = {};
      f.hoas = (hoas.data || []).map(h => H.loadedRow({ id: h.id, hoa_name: h.hoa_name || "", amount: h.amount ?? "", due_date: H.dueDayOf(h.due_date) ?? "",
        frequency: h.frequency || "Monthly", notes: h.notes || "", website: h.website || "", management_company: h.management_company || "",
        mgmt_website: h.mgmt_website || "", pay_portal_website: h.pay_portal_website || "", contact_name: h.contact_name || "",
        contact_email: h.contact_email || "", contact_phone: h.contact_phone || "" }, h, "hoa"));
      f.utilities = (utils.data || []).map(u => H.loadedRow({ id: u.id, provider: u.provider || "", type: u.type || "", account_number: u.account_number || "",
        due_date: H.dueDayOf(u.due || u.due_date) ?? "", responsibility: H.respToForm(u.responsibility), website: u.website || "" }, u, "utility"));
      f.seenHoaIds = (hoas.data || []).map(h => String(h.id)); f.seenUtilIds = (utils.data || []).map(u => String(u.id));
      const l = (loans.data || [])[0];
      f.loan = H.loadedRow({ enabled: true, id: l.id, lender_name: l.lender_name || "", loan_type: l.loan_type || "Conventional", original_amount: l.original_amount ?? "",
        current_balance: l.current_balance ?? "", interest_rate: l.interest_rate ?? "", monthly_payment: l.monthly_payment ?? "", escrow_included: !!l.escrow_included,
        escrow_amount: l.escrow_amount ?? "", loan_start_date: l.loan_start_date || "", maturity_date: l.maturity_date || "", account_number: l.account_number || "",
        notes: l.notes || "", website: l.website || "" }, l, "loan");
      const i = (inss.data || [])[0];
      f.insurance = H.loadedRow({ enabled: true, id: i.id, provider: i.provider || "", policy_number: i.policy_number || "", premium_amount: i.premium_amount ?? "",
        premium_frequency: i.premium_frequency || "annual", coverage_amount: i.coverage_amount ?? "", expiration_date: i.expiration_date || "",
        notes: i.notes || "", website: i.website || "" }, i, "insurance");
      const t = (taxes.data || [])[0];
      f.taxes = H.loadedRow({ enabled: true, id: t.id, parcel_id: t.parcel_id || "", assessed_value: t.assessed_value ?? "", tax_year: t.tax_year ?? "",
        annual_tax_amount: t.annual_tax_amount ?? "", billing_frequency: t.billing_frequency || "semi_annual", next_due_date: t.next_due_date || "",
        exemptions: t.exemptions || "", escrow_paid_by_lender: !!t.escrow_paid_by_lender, records_url: t.records_url || "", notes: t.notes || "" }, t, "taxes");
      const p = (await user.from("properties").select(H.WIZ_DB_COLS.property.join(", ")).eq("id", PID).single()).data;
      f.prop = { address_line_1: p.address_line_1 || "", address_line_2: p.address_line_2 || "", city: p.city || "", state: p.state || "", zip: p.zip || "",
        county: p.county || "", type: p.type || "Single Family", status: p.status || "vacant", notes: p.notes || "", year_built: p.year_built ? String(p.year_built) : "" };
      f.propLoaded = { form: { ...f.prop }, db: H.pickCols(p, H.WIZ_DB_COLS.property) };
      const tn = (await user.from("tenants").select(H.WIZ_DB_COLS.tenant.join(", ") + ", security_deposit").eq("id", c2.tenant_id).single()).data;
      const ls = (await user.from("leases").select(H.WIZ_DB_COLS.lease.join(", ")).eq("company_id", CID).eq("property", ADDR2).eq("status", "active").limit(1)).data[0];
      f.tenant = { tenant: tn.name || "", tenant_first: tn.first_name || "", tenant_mi: tn.middle_initial || "", tenant_last: tn.last_name || "",
        tenant_email: tn.email || "", tenant_phone: tn.phone || "", late_fee_amount: tn.late_fee_amount ?? "", late_fee_type: tn.late_fee_type || "",
        rent: (ls?.rent_amount ?? tn.rent) ?? "", security_deposit: (ls?.security_deposit ?? tn.security_deposit) ?? "",
        lease_start: ls?.start_date || tn.lease_start || "", lease_end: ls?.end_date || tn.lease_end_date || "", is_voucher: !!tn.is_voucher,
        voucher_number: tn.voucher_number || "", reexam_date: tn.reexam_date || "", case_manager_name: tn.case_manager_name || "",
        case_manager_email: tn.case_manager_email || "", case_manager_phone: tn.case_manager_phone || "", voucher_portion: tn.voucher_portion ?? "",
        tenant_portion: tn.tenant_portion ?? "" };
      for (const n of [2, 3, 4, 5]) for (const s of ["", "_email", "_phone"]) f.tenant[`tenant_${n}${s}`] = p[`tenant_${n}${s}`] || "";
      f.tenantLoaded = { form: { ...f.tenant }, db: H.pickCols(tn, H.WIZ_DB_COLS.tenant), dbLease: ls ? H.pickCols(ls, H.WIZ_DB_COLS.lease) : null };
      const rc = (await user.from("recurring_journal_entries").select(H.WIZ_DB_COLS.recurring.join(", ")).eq("company_id", CID).eq("tenant_id", c2.tenant_id).eq("status", "active").limit(1)).data[0];
      f.recurring = { amount: rc.amount, frequency: rc.frequency || "monthly", day_of_month: rc.day_of_month || 1, start_date: "" };
      f.recurringLoaded = { form: { ...f.recurring }, db: H.pickCols(rc, H.WIZ_DB_COLS.recurring) };
      return f;
    };
    const buildPayload = (f) => ({
      company_id: CID, wizard_id: null, mode: "edit", property_id_for_edit: PID, payload_version: 2,
      property: { address: ADDR2, ...H.WIZ_FIELDS.property(f.prop), ...H.withOrig("property", f.propLoaded.form, f.propLoaded.db) },
      tenant: { ...H.WIZ_FIELDS.tenant(f.tenant), ...H.withOrig("tenant", f.tenantLoaded.form, f.tenantLoaded.db), _db_lease: f.tenantLoaded.dbLease },
      utilities: f.utilities.map(u => ({ ...(u.id ? { id: u.id, ...H.withOrig("utility", u._loaded, u._db) } : {}), ...H.WIZ_FIELDS.utility(u) })),
      hoas: f.hoas.map(h => ({ ...(h.id ? { id: h.id, ...H.withOrig("hoa", h._loaded, h._db) } : {}), ...H.WIZ_FIELDS.hoa(h) })),
      hoas_seen_ids: f.seenHoaIds, utilities_seen_ids: f.seenUtilIds,
      loan: f.loan.enabled ? { enabled: true, id: f.loan.id, ...H.withOrig("loan", f.loan._loaded, f.loan._db), ...H.WIZ_FIELDS.loan(f.loan) } : { enabled: false, id: f.loan.id },
      insurance: f.insurance.enabled ? { enabled: true, id: f.insurance.id, ...H.withOrig("insurance", f.insurance._loaded, f.insurance._db), ...H.WIZ_FIELDS.insurance(f.insurance) } : { enabled: false, id: f.insurance.id },
      taxes: f.taxes.enabled ? { enabled: true, id: f.taxes.id, ...H.withOrig("taxes", f.taxes._loaded, f.taxes._db), ...H.WIZ_FIELDS.taxes(f.taxes) } : { enabled: false, id: f.taxes.id },
      recurring_cleared: false,
      recurring: { ...H.WIZ_FIELDS.recurring(f.recurring), ...H.withOrig("recurring", f.recurringLoaded.form, f.recurringLoaded.db) },
    });

    const s0 = await snapshot();
    // (a) re-save with NO changes
    const { error: e1 } = await rpc(buildPayload(await loadForm()));
    const s1 = await snapshot();
    const d1 = diff(s0, s1);
    assert("re-save with no changes: RPC ok", !e1, e1?.message);
    assert("re-save with no changes: NO row differs in any column", d1.length === 0, d1.join("\n   "));

    // (b) change ONE unrelated field (property notes)
    const fb = await loadForm(); fb.prop.notes = "edited notes";
    const { error: e2 } = await rpc(buildPayload(fb));
    const s2 = await snapshot();
    const d2 = diff(s1, s2);
    assert("one-field edit: RPC ok", !e2, e2?.message);
    assert("one-field edit: the ONLY difference is properties.notes",
      d2.length === 1 && /^properties#\d+\.notes: "original notes" -> "edited notes"$/.test(d2[0]), d2.join("\n   "));
    const u2 = s2.utilities.find(u => u.provider === `${TAG} Power`), h2 = s2.hoa_payments[0], l2 = s2.property_loans[0];
    assert("due dates kept (utility 15th, HOA 20th, lease day 5, rent next post)",
      u2.due === "2026-10-15" && h2.due_date === "2026-10-20" && s2.leases[0].payment_due_day === 5
      && s2.recurring_journal_entries[0].next_post_date === "2026-10-01");
    assert("PAID HOA stays paid; paid utility stays paid", h2.status === "paid" && h2.paid_date === "2026-09-10" && u2.status === "paid");
    assert("both insurance policies still live", s2.property_insurance.filter(i => !i.archived_at).length === 2);
    assert("websites kept", u2.website === "https://power.example" && h2.website === "https://hoa.example" && l2.website === "https://lender.example"
      && s2.property_insurance.every(i => /^https:/.test(i.website)));
    assert("logins kept (ciphertext + key fingerprint)", u2.username_encrypted === "u1-u" && u2.credential_key_fp === "u1-fp"
      && h2.username_encrypted === "h1-u" && l2.credential_key_fp === "l1-fp");
    assert("tenant late fee / move-in kept", Number(s2.tenants[0].late_fee_amount) === 75 && s2.tenants[0].late_fee_type === "percent" && s2.tenants[0].move_in === "2024-12-15");
    if (EVIDENCE) console.log("   evidence(edit):", JSON.stringify({ diffNoChange: d1, diffOneField: d2 }));

    // (c) a STALE wizard: opened, then another page edits; the wizard saves
    // with no changes / an unrelated change -> the other page's edit stands.
    const fc = await loadForm();
    await svc.from("hoa_payments").update({ amount: 300, notes: "changed on HOA page" }).eq("id", h2.id);
    await svc.from("utilities").update({ account_number: "A-1-NEW" }).eq("id", uPow.id);
    await svc.from("tenants").update({ phone: "555-9999" }).eq("id", c2.tenant_id);
    fc.prop.notes = "stale tab edit";
    const sc0 = await snapshot();
    const { error: e3 } = await rpc(buildPayload(fc));
    const dc = diff(sc0, await snapshot());
    assert("stale wizard: other pages' edits survive, only the user's own change lands",
      !e3 && dc.length === 1 && /properties#\d+\.notes/.test(dc[0]), (e3?.message || "") + dc.join("\n   "));

    // (d) the user changes a field SOMEONE ELSE also changed since the wizard
    // opened -> refused, nothing written.
    const fd = await loadForm();
    await svc.from("hoa_payments").update({ amount: 325 }).eq("id", h2.id);
    fd.hoas[0].amount = 999; fd.prop.notes = "should not land";
    const sd0 = await snapshot();
    const { error: e4 } = await rpc(buildPayload(fd));
    const dd = diff(sd0, await snapshot());
    assert("conflicting edit is refused with 'changed by someone else', nothing written",
      /changed by someone else since you opened/.test(e4?.message || "") && dd.length === 0, (e4?.message || "no error") + dd.join("\n   "));

    // (e) a payload from an out-of-date client (no payload_version) is refused
    const pe = buildPayload(await loadForm()); delete pe.payload_version;
    const { error: e5 } = await rpc(pe);
    assert("an old-shape edit payload is refused with 'Please reload the app'", /reload the app/i.test(e5?.message || ""), e5?.message);

    // (f) switch off ONE policy: only that one goes; skipped steps archive nothing
    const ff = await loadForm(); ff.insurance.enabled = false;
    const pf = buildPayload(ff);
    const { error: e6 } = await rpc(pf);
    const sf = await snapshot();
    const liveIns = sf.property_insurance.filter(i => !i.archived_at).map(i => i.provider);
    assert("switching off one policy archives exactly that policy", !e6 && liveIns.length === 1 && liveIns[0] === `${TAG} Insure B`, (e6?.message || "") + liveIns);
    const pskip = buildPayload(await loadForm()); pskip.insurance = null; pskip.taxes = null; pskip.loan = null;
    const { error: e7 } = await rpc(pskip);
    const dskip = diff(sf, await snapshot());
    assert("skipped / unloaded steps archive nothing", !e7 && dskip.length === 0, (e7?.message || "") + dskip.join("\n   "));

    // (g) remove one utility, change one due day, add a new row with the SAME
    // provider as an existing one -> removed one archived, kept one updated in
    // place in the same month, new one inserted (never merged by name).
    const fg = await loadForm();
    fg.utilities = fg.utilities.filter(u => u.provider !== `${TAG} Gas`);
    fg.utilities[0].due_date = 18;
    fg.utilities.push({ provider: `${TAG} Power`, type: "Electric", account_number: "A-2", due_date: 3, responsibility: "tenant_pays", website: "" });
    const { error: e8 } = await rpc(buildPayload(fg));
    const sg = await snapshot();
    const gas = sg.utilities.find(u => u.provider === `${TAG} Gas`), pw = sg.utilities.find(u => u.id === uPow.id);
    const pw2 = sg.utilities.find(u => u.account_number === "A-2");
    assert("removed utility archived; kept one updated IN PLACE (same id, paid, amount) with the new day in the same month",
      !e8 && gas.archived_at && !pw.archived_at && pw.due === "2026-10-18" && pw.status === "paid" && Number(pw.amount) === 133.45,
      (e8?.message || "") + JSON.stringify({ gas: gas?.archived_at, pw }));
    assert("a new same-provider row is inserted, not merged into the existing one", pw2 && pw2.id !== uPow.id && pw2.responsibility === "tenant");

    // (h) a loan id belonging to ANOTHER property is ignored (not overwritten)
    const { data: other } = await rpc({ company_id: CID, mode: "fresh", property: { address_line_1: `${TAG} 33 Other Rd`, city: "Testville", state: "MD", zip: "20001", type: "Single Family", status: "vacant" },
      utilities: [], hoas: [], loan: { enabled: true, lender_name: `${TAG} Other Bank`, monthly_payment: 10 } });
    const oLoan = (await svc.from("property_loans").select("*").eq("company_id", CID).eq("property", other.address)).data[0];
    const fh = await loadForm(); const ph = buildPayload(fh);
    ph.loan = { ...ph.loan, id: oLoan.id, lender_name: "HIJACKED", _orig: undefined, _db: undefined };
    const { error: e9 } = await rpc(ph);
    const oAfter = (await svc.from("property_loans").select("lender_name, archived_at").eq("id", oLoan.id).single()).data;
    assert("another property's loan id is ignored", !e9 && oAfter.lender_name === `${TAG} Other Bank` && !oAfter.archived_at, (e9?.message || "") + JSON.stringify(oAfter));

    // (i) rows written by OTHER pages often hold NULL where the form holds
    // "" / 0 / false. A no-change save must not turn one into the other.
    await svc.from("property_loans").update({ notes: null, account_number: null, interest_rate: null, escrow_amount: null }).eq("company_id", CID).eq("property", ADDR2);
    await svc.from("property_insurance").update({ notes: null, policy_number: null, coverage_amount: null, premium_frequency: null }).eq("company_id", CID).eq("property", ADDR2);
    await svc.from("property_taxes").update({ tax_year: null, escrow_paid_by_lender: null }).eq("company_id", CID).eq("property", ADDR2);
    await svc.from("tenants").update({ phone: null, middle_initial: null, is_voucher: null }).eq("id", c2.tenant_id);
    await svc.from("properties").update({ notes: null, address_line_2: null, tenant_2_email: null }).eq("id", PID);
    await svc.from("hoa_payments").update({ notes: null, contact_phone: null, frequency: null }).eq("company_id", CID).eq("property", ADDR2);
    await svc.from("utilities").update({ responsibility: null }).eq("id", uPow.id);
    const s6 = await snapshot();
    const { error: e10 } = await rpc(buildPayload(await loadForm()));
    const d6 = diff(s6, await snapshot());
    assert("re-save over NULL-holding rows changes nothing (no NULL -> '' / 0 / false / default)", !e10 && d6.length === 0, (e10?.message || "") + d6.join("\n   "));
  } catch (e) {
    assert("live checks ran without throwing", false, e.stack || String(e));
  } finally {
    await cleanup();
    const left = await leftovers();
    const bad = Object.entries(left).filter(([, n]) => n);
    assert("cleanup: zero QA-WIZ rows left behind", bad.length === 0, JSON.stringify(left));
    if (EVIDENCE) console.log("   evidence(cleanup):", JSON.stringify(left));
  }
}

console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
process.exit(fail ? 1 : 0);
