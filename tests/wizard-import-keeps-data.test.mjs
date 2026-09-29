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
assert("removal is limited to rows the form SAW (seen ids / names)",
  /utilities_seen_ids/.test(body) && /hoas_seen_ids/.test(body) && (body.match(/NOT \(id = ANY\(v_matched_(util|hoa)\)\)/g) || []).length >= 4);
assert("an existing HOA row never has status / paid_date written",
  !/UPDATE hoa_payments SET[\s\S]{0,4000}?\bstatus\s*=/.test(body.slice(body.indexOf("HOAs — merge"))) && !/paid_date\s*=/.test(body));
assert("the lease update no longer forces payment_due_day = 1",
  !/UPDATE leases SET[^;]*payment_due_day = 1/.test(body));
assert("insurance / tax / loan are archived only when the payload names the record",
  /ELSIF v_mode = 'edit' AND v_insurance IS NOT NULL AND NULLIF\(v_insurance->>'id',''\) IS NOT NULL/.test(body)
  && /ELSIF v_mode = 'edit' AND v_taxes IS NOT NULL AND NULLIF\(v_taxes->>'id',''\) IS NOT NULL/.test(body)
  && /ELSIF v_mode = 'edit' AND v_loan IS NOT NULL AND NULLIF\(v_loan->>'id',''\) IS NOT NULL/.test(body)
  && !/UPDATE property_insurance SET archived_at = now\(\)\s+WHERE company_id = v_company_id AND property = v_address AND archived_at IS NULL;/.test(body));
assert("websites: blank keeps the stored one on every update",
  ["v_u", "v_h", "v_loan", "v_insurance"].every(v => body.includes(`website = COALESCE(NULLIF(${v}->>'website',''), website)`)));
assert("responsibility maps the import's 'owner'/'tenant', and blank is not guessed",
  /WHEN 'owner' THEN 'owner'/.test(body) && /WHEN 'tenant' THEN 'tenant'/.test(body) && !/ELSE 'tenant' END/.test(body));
for (const t of ["utilities", "hoa_payments", "property_loans", "property_insurance"]) {
  const ins = new RegExp(`INSERT INTO ${t} \\([^)]*credential_key_fp`).test(body);
  assert(`credential_key_fp persisted on insert into ${t}`, ins);
}
assert("credential_key_fp persisted on every credential UPDATE",
  (body.match(/credential_key_fp = /g) || []).length >= 4);
assert("tenant late fee / move_in / notice are kept",
  /late_fee_amount = COALESCE\(NULLIF\(v_tenant->>'late_fee_amount',''\)::numeric, late_fee_amount\)/.test(body)
  && /move_in = COALESCE\(move_in,/.test(body)
  && /lease_status = CASE WHEN lease_status = 'notice'/.test(body));
assert("recurring rent is stopped only on an explicit clear", /recurring_cleared/.test(body));
assert("the wizard no longer creates or updates a mortgage recurring schedule (owner decision, theme K)",
  !/INSERT INTO recurring_journal_entries[\s\S]{0,400}Mortgage\/Loan Payment/.test(body) && !/setup_recurring/.test(body.replace(/--.*$/gm, "")));
assert("NULLs written by other pages are not turned into '' / 0 / false",
  /_wizard_txt\(v_loan->>'account_number', account_number\)/.test(body) && /_wizard_num\(v_insurance->>'coverage_amount', coverage_amount\)/.test(body)
  && /_wizard_bool\(v_tenant->>'is_voucher', is_voucher\)/.test(body));

console.log("\n=== STATIC: wizard client ===");
assert("due day is parsed from the stored DATE, not Number(date) || 1",
  !/Number\([uh]\.due_date\) \|\| 1/.test(props) && (props.match(/due_day: dueDayOf\(/g) || []).length === 2);
assert("the live loader keeps each utility / HOA row id",
  /seenHoaIds\.current = hoaRows\.map\(h => h\.id\)/.test(props) && /seenUtilIds\.current = utilRows\.map\(u => u\.id\)/.test(props)
  && /\.\.\.\(u\.id \? \{ id: u\.id \} : \{\}\)/.test(props) && /\.\.\.\(h\.id \? \{ id: h\.id \} : \{\}\)/.test(props));
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
  /select\("property,provider,responsibility,amount,due,due_date"\)/.test(imp));
assert("a blank amount / due / Paid By keeps the stored value on re-import",
  /keepIfBlank: \["amount", "due", "responsibility"\]/.test(imp));
assert("a new property keeps its beds/baths/sqft/rent/licences", /await writeLicences\(r, created\.property_id/.test(imp));
assert("recurring rows that cannot be imported are shown on the Done step", /result\.recurringSkipped > 0/.test(imp));
assert("the subRecordsFor field mapping this test mirrors is still the component's",
  imp.includes('provider: cellString(u.provider), responsibility: enumVal("responsibility", u.responsibility),')
  && imp.includes('amount: u.amount ?? null, due_date: u.due_date || null,'));

const { importCreatePayload, importEnumValue, buildTemplate, parseWorkbook, buildImportPlan, computeAddress, cellString,
        PROPERTY_COLUMNS, UTILITY_COLUMNS, HOA_COLUMNS, LOAN_COLUMNS, INSURANCE_COLUMNS, TAX_COLUMNS,
        SHEET_PROPERTIES, SHEET_UTILITIES, SHEET_HOA, SHEET_LOANS, SHEET_INSURANCE, SHEET_TAXES } =
  await import("../src/utils/propertyImport.js");

console.log("\n=== UNIT: importCreatePayload ===");
{
  const reports = [];
  const out = importCreatePayload({
    utilities: [], hoas: [{ hoa_name: "X", due_date: "15" }, { hoa_name: "Y", due_date: "2026-10-20" }],
    loan: { lender_name: "L" }, loans: [{ lender_name: "L" }, { lender_name: "M" }],
    insurance: { provider: "I" }, taxes: { county: "C", annual_tax_amount: null }, recurring: null,
  }, (w) => reports.push(w));
  assert("loan and insurance are sent enabled", out.loan?.enabled === true && out.insurance?.enabled === true);
  assert("a tax row with no amount is skipped and REPORTED (not a failed property)", out.taxes === null && reports.length === 1);
  assert("an HOA due of '15' becomes day 15; a date stays a date",
    out.hoas[0].due_day === 15 && out.hoas[0].due_date === null && out.hoas[1].due_date === "2026-10-20");
  assert("the RPC payload does not carry the extra-loans list", !("loans" in out));
  const withTax = importCreatePayload({ utilities: [], hoas: [], taxes: { annual_tax_amount: 10 } });
  assert("a tax row with an amount is sent enabled", withTax.taxes?.enabled === true);
  assert("'Owner' maps to owner, blank to null (not guessed)",
    importEnumValue("responsibility", "Owner") === "owner" && importEnumValue("responsibility", "") === null);
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
    // What other pages would have stored since.
    await svc.from("properties").update({ year_built: 1970 }).eq("id", PID);
    await svc.from("leases").update({ payment_due_day: 5 }).eq("company_id", CID).eq("property", ADDR2);
    await svc.from("tenants").update({ late_fee_amount: 75, late_fee_type: "percent", move_in: "2024-12-15" }).eq("id", c2.tenant_id);
    const cred = (p) => ({ username_encrypted: p + "-u", password_encrypted: p + "-p", encryption_iv: p + "-iv",
                           encryption_iv_username: p + "-ivu", encryption_salt: p + "-salt", credential_key_fp: p + "-fp" });
    const ins = async (t, row) => { const { data, error } = await svc.from(t).insert([{ company_id: CID, property: ADDR2, ...row }]).select("*").single(); if (error) throw new Error(t + ": " + error.message); return data; };
    await ins("utilities", { provider: `${TAG} Power`, type: "Electric", account_number: "A-1", amount: 133.45, due: "2026-10-15", responsibility: "owner", status: "paid", website: "https://power.example", ...cred("u1") });
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

    const TABLES = { properties: ["id", PID], tenants: ["id", c2.tenant_id] };
    const snapshot = async () => {
      const out = {};
      for (const t of ["utilities", "hoa_payments", "property_loans", "property_insurance", "property_taxes", "leases"]) {
        const { data } = await svc.from(t).select("*").eq("company_id", CID).eq("property", ADDR2).order("id");
        out[t] = data || [];
      }
      for (const [t, [col, v]] of Object.entries(TABLES)) {
        const { data } = await svc.from(t).select("*").eq(col, v);
        out[t] = data || [];
      }
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

    // The payload exactly as the wizard now builds it after loadLiveWizardData
    // (the form holds what the live rows hold; no logins re-entered).
    const dueDayOf = (v) => { if (v == null || v === "") return null; const m = String(v).match(/^\d{4}-\d{2}-(\d{2})/); if (m) return Number(m[1]); const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null; };
    const respToForm = (r) => r === "owner" ? "owner_pays" : r === "tenant" ? "tenant_pays" : r === "condo_fee" ? "condo_fee" : "owner_pays";
    const buildPayload = (s, over = {}) => {
      const p = s.properties[0], t = s.tenants[0], lease = s.leases.find(l => l.status === "active");
      const utils = s.utilities.filter(u => !u.archived_at), hoas = s.hoa_payments.filter(h => !h.archived_at);
      const loan = s.property_loans.find(l => !l.archived_at);
      const insr = s.property_insurance.filter(i => !i.archived_at).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      const tax = s.property_taxes.find(x => !x.archived_at);
      return {
        company_id: CID, wizard_id: null, mode: "edit", property_id_for_edit: PID,
        property: { address: p.address, address_line_1: p.address_line_1, address_line_2: p.address_line_2 || "", city: p.city, state: p.state, zip: p.zip,
                    county: p.county || "", type: p.type, status: p.status, year_built: p.year_built || null, notes: p.notes || "" },
        tenant: { tenant: t.name, tenant_first: t.first_name || "", tenant_mi: t.middle_initial || "", tenant_last: t.last_name || "", tenant_email: t.email || "",
                  tenant_phone: t.phone || "", rent: lease.rent_amount, security_deposit: lease.security_deposit || 0, lease_start: lease.start_date, lease_end: lease.end_date,
                  late_fee_amount: t.late_fee_amount ?? "", late_fee_type: t.late_fee_type || "", is_voucher: !!t.is_voucher, voucher_number: t.voucher_number || "",
                  reexam_date: t.reexam_date || "", case_manager_name: t.case_manager_name || "", case_manager_email: t.case_manager_email || "",
                  case_manager_phone: t.case_manager_phone || "", voucher_portion: t.voucher_portion ?? "", tenant_portion: t.tenant_portion ?? "",
                  tenant_2: p.tenant_2 || "", tenant_2_email: p.tenant_2_email || "", tenant_2_phone: p.tenant_2_phone || "",
                  tenant_3: p.tenant_3 || "", tenant_3_email: p.tenant_3_email || "", tenant_3_phone: p.tenant_3_phone || "",
                  tenant_4: p.tenant_4 || "", tenant_4_email: p.tenant_4_email || "", tenant_4_phone: p.tenant_4_phone || "",
                  tenant_5: p.tenant_5 || "", tenant_5_email: p.tenant_5_email || "", tenant_5_phone: p.tenant_5_phone || "" },
        utilities: utils.map(u => ({ id: u.id, provider: u.provider, type: u.type || "", account_number: u.account_number || "", due_day: dueDayOf(u.due || u.due_date),
                                     responsibility: respToForm(u.responsibility), website: u.website || "" })),
        hoas: hoas.map(h => ({ id: h.id, hoa_name: h.hoa_name, amount: Number(h.amount), due_day: dueDayOf(h.due_date), frequency: h.frequency || "Monthly",
                               notes: (h.notes || "").trim(), website: h.website || "", management_company: (h.management_company || "").trim(), mgmt_website: h.mgmt_website || "",
                               pay_portal_website: h.pay_portal_website || "", contact_name: h.contact_name || "", contact_email: (h.contact_email || "").toLowerCase(), contact_phone: h.contact_phone || "" })),
        hoas_seen: hoas.map(h => h.hoa_name), utilities_seen: utils.map(u => u.provider),
        hoas_seen_ids: hoas.map(h => String(h.id)), utilities_seen_ids: utils.map(u => String(u.id)),
        loan: loan ? { enabled: true, id: loan.id, lender_name: loan.lender_name, loan_type: loan.loan_type, original_amount: Number(loan.original_amount) || 0,
                       current_balance: Number(loan.current_balance) || 0, interest_rate: Number(loan.interest_rate) || 0, monthly_payment: Number(loan.monthly_payment),
                       escrow_included: !!loan.escrow_included, escrow_amount: loan.escrow_included ? (Number(loan.escrow_amount) || 0) : 0,
                       loan_start_date: loan.loan_start_date || null, maturity_date: loan.maturity_date || null, account_number: (loan.account_number || "").trim(),
                       notes: (loan.notes || "").trim(), website: loan.website || "", setup_recurring: false } : null,
        insurance: insr ? { enabled: true, id: insr.id, provider: insr.provider, policy_number: insr.policy_number || "", premium_amount: Number(insr.premium_amount),
                            premium_frequency: insr.premium_frequency, coverage_amount: Number(insr.coverage_amount) || 0, expiration_date: insr.expiration_date || null,
                            notes: (insr.notes || "").trim(), website: insr.website || "" } : null,
        taxes: tax ? { enabled: true, id: tax.id, parcel_id: tax.parcel_id || "", assessed_value: tax.assessed_value ?? "", tax_year: tax.tax_year,
                       annual_tax_amount: tax.annual_tax_amount ?? "", billing_frequency: tax.billing_frequency, next_due_date: tax.next_due_date || "",
                       exemptions: tax.exemptions || "", escrow_paid_by_lender: !!tax.escrow_paid_by_lender, records_url: tax.records_url || "", notes: tax.notes || "" } : null,
        recurring_cleared: false, recurring: null,
        ...over,
      };
    };

    const s0 = await snapshot();
    // (a) re-save with NO changes
    let { error: e1 } = await rpc(buildPayload(s0));
    const s1 = await snapshot();
    const d1 = diff(s0, s1);
    assert("re-save with no changes: RPC ok", !e1, e1?.message);
    assert("re-save with no changes: NO row differs in any column", d1.length === 0, d1.join("\n   "));

    // (b) change ONE unrelated field (property notes)
    const pl = buildPayload(s1); pl.property.notes = "edited notes";
    const { error: e2 } = await rpc(pl);
    const s2 = await snapshot();
    const d2 = diff(s1, s2);
    assert("one-field edit: RPC ok", !e2, e2?.message);
    assert("one-field edit: the ONLY difference is properties.notes",
      d2.length === 1 && /^properties#\d+\.notes: "original notes" -> "edited notes"$/.test(d2[0]), d2.join("\n   "));
    const u2 = s2.utilities.find(u => u.provider === `${TAG} Power`), h2 = s2.hoa_payments[0], l2 = s2.property_loans[0];
    assert("due dates kept (utility 15th, HOA 20th, lease day 5)",
      u2.due === "2026-10-15" && h2.due_date === "2026-10-20" && s2.leases[0].payment_due_day === 5);
    assert("PAID HOA stays paid; paid utility stays paid", h2.status === "paid" && h2.paid_date === "2026-09-10" && u2.status === "paid");
    assert("both insurance policies still live", s2.property_insurance.filter(i => !i.archived_at).length === 2);
    assert("websites kept", u2.website === "https://power.example" && h2.website === "https://hoa.example" && l2.website === "https://lender.example"
      && s2.property_insurance.every(i => /^https:/.test(i.website)));
    assert("logins kept (ciphertext + key fingerprint)", u2.username_encrypted === "u1-u" && u2.credential_key_fp === "u1-fp"
      && h2.username_encrypted === "h1-u" && l2.credential_key_fp === "l1-fp");
    assert("tenant late fee / move-in kept", Number(s2.tenants[0].late_fee_amount) === 75 && s2.tenants[0].late_fee_type === "percent" && s2.tenants[0].move_in === "2024-12-15");
    if (EVIDENCE) console.log("   evidence(edit):", JSON.stringify({ diffNoChange: d1, diffOneField: d2 }));

    // (c) the step-skipped / not-loaded case: no insurance / tax / loan section
    const pSkip = buildPayload(s2, { insurance: null, taxes: null, loan: null, utilities: [], hoas: [], hoas_seen: [], utilities_seen: [], hoas_seen_ids: [], utilities_seen_ids: [] });
    const { error: e3 } = await rpc(pSkip);
    const s3 = await snapshot();
    const d3 = diff(s2, s3);
    assert("skipped / unloaded steps archive NOTHING (policies, taxes, loan, utilities, HOA)", !e3 && d3.length === 0, (e3?.message || "") + d3.join("\n   "));

    // (d) the user switches off ONE policy: only that one goes
    const polA = s3.property_insurance.find(i => i.provider === `${TAG} Insure A`);
    const { error: e4 } = await rpc(buildPayload(s3, { insurance: { enabled: false, id: polA.id } }));
    const s4 = await snapshot();
    const liveIns = s4.property_insurance.filter(i => !i.archived_at).map(i => i.provider);
    assert("switching off one policy archives exactly that policy", !e4 && liveIns.length === 1 && liveIns[0] === `${TAG} Insure B`, (e4?.message || "") + liveIns);

    // (e) the user removes one utility and changes one due day
    const payE = buildPayload(s4);
    payE.utilities = payE.utilities.filter(u => u.provider !== `${TAG} Gas`).map(u => ({ ...u, due_day: 18 }));
    const { error: e5 } = await rpc(payE);
    const s5 = await snapshot();
    const gas = s5.utilities.find(u => u.provider === `${TAG} Gas`), pw5 = s5.utilities.find(u => u.provider === `${TAG} Power`);
    assert("a removed utility is archived; the kept one is updated IN PLACE (same id) with the new day in the same month",
      !e5 && gas.archived_at && !pw5.archived_at && pw5.id === u2.id && pw5.due === "2026-10-18" && pw5.status === "paid" && Number(pw5.amount) === 133.45,
      (e5?.message || "") + JSON.stringify({ gas: gas.archived_at, pw5 }));

    // (f) rows written by OTHER pages often hold NULL where the wizard's form
    // holds "" or 0. Re-saving must not turn one into the other.
    await svc.from("property_loans").update({ notes: null, account_number: null, interest_rate: null, escrow_amount: null }).eq("company_id", CID).eq("property", ADDR2);
    await svc.from("property_insurance").update({ notes: null, policy_number: null, coverage_amount: null }).eq("company_id", CID).eq("property", ADDR2);
    await svc.from("tenants").update({ phone: null, middle_initial: null, is_voucher: null }).eq("id", c2.tenant_id);
    await svc.from("properties").update({ notes: null, address_line_2: null }).eq("id", PID);
    await svc.from("hoa_payments").update({ notes: null, contact_phone: null }).eq("company_id", CID).eq("property", ADDR2);
    const s6 = await snapshot();
    const { error: e6 } = await rpc(buildPayload(s6));
    const d6 = diff(s6, await snapshot());
    assert("re-save over NULL-holding rows changes nothing (no NULL -> '' / 0 / false)", !e6 && d6.length === 0, (e6?.message || "") + d6.join("\n   "));
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
