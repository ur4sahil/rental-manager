// ═══════════════════════════════════════════════════════════════
// PROPERTY TAXES + COUNTY — data-layer test
// Exercises the migrations from 20260408 + 20260409 and the
// 5700 Property Taxes account registration.
// ═══════════════════════════════════════════════════════════════
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const COMPANY_ID = "sandbox-llc";

let pass = 0, fail = 0, errors = [];
function assert(ok, name, detail) {
  if (ok) { console.log("  ✅ " + name); pass++; }
  else { console.log("  ❌ " + name + (detail ? " — " + detail : "")); fail++; errors.push(name); }
}

async function cleanup(propId) {
  if (!propId) return;
  await svc.from("property_taxes").delete().eq("company_id", COMPANY_ID).eq("property_id", propId);
  await svc.from("properties").delete().eq("id", propId);
}

async function testCountyColumn() {
  console.log("\n🏛️  properties.county column");
  const { data: prop, error: insErr } = await svc.from("properties").insert([{
    company_id: COMPANY_ID,
    address_line_1: "ZZZ-TAX 1 Test St",
    city: "Rockville", state: "MD", zip: "20850",
    county: "Montgomery County",
    type: "Single Family", status: "vacant", rent: 2000,
  }]).select().single();
  assert(!insErr, "property insert with county", insErr?.message);
  assert(prop?.county === "Montgomery County", "county persisted");

  const { data: updated } = await svc.from("properties").update({ county: "Howard County" }).eq("id", prop.id).select().single();
  assert(updated?.county === "Howard County", "county update round-trip");
  await cleanup(prop.id);
  return prop.id;
}

async function testPropertyTaxes() {
  console.log("\n📄 property_taxes CRUD");
  const { data: prop } = await svc.from("properties").insert([{
    company_id: COMPANY_ID,
    address_line_1: "ZZZ-TAX 2 Test Ave",
    city: "Chantilly", state: "VA", zip: "20151",
    county: "Fairfax County",
    type: "Single Family", status: "vacant", rent: 2500,
  }]).select().single();

  try {
    const { data: tax, error } = await svc.from("property_taxes").insert([{
      company_id: COMPANY_ID,
      property: prop.address,
      property_id: prop.id,
      county: prop.county,
      jurisdiction: prop.county + ", " + prop.state,
      assessed_value: 450000,
      tax_year: 2026,
      annual_tax_amount: 5200,
      billing_frequency: "semi_annual",
      next_due_date: "2026-06-05",
      parcel_id: "GPIN-0123-45-6789",
      records_url: "https://icare.fairfaxcounty.gov/",
    }]).select().single();
    assert(!error, "property_taxes insert", error?.message);
    assert(tax?.annual_tax_amount === 5200, "annual_tax_amount round-trip");
    assert(tax?.billing_frequency === "semi_annual", "billing_frequency stored");
    assert(tax?.jurisdiction === "Fairfax County, VA", "jurisdiction composed");

    // CHECK constraint should reject an unknown billing frequency
    const { error: badFreq } = await svc.from("property_taxes").insert([{
      company_id: COMPANY_ID,
      property: prop.address,
      property_id: prop.id,
      annual_tax_amount: 1,
      billing_frequency: "fortnightly",
    }]);
    assert(!!badFreq, "CHECK constraint rejects invalid billing_frequency");

    // Update flow — what saveTaxes does on re-save.
    const { error: updErr } = await svc.from("property_taxes").update({
      annual_tax_amount: 5400,
      escrow_paid_by_lender: true,
    }).eq("id", tax.id).eq("company_id", COMPANY_ID);
    assert(!updErr, "property_taxes update");
    const { data: updated } = await svc.from("property_taxes").select("*").eq("id", tax.id).single();
    assert(updated.annual_tax_amount === 5400, "updated amount persisted");
    assert(updated.escrow_paid_by_lender === true, "escrow_paid_by_lender flag persisted");
  } finally {
    await cleanup(prop.id);
  }
}

async function testPropertyTaxesAccount() {
  console.log("\n💰 5710 Property Taxes account");
  // saveTaxes uses resolveAccountId("5710", companyId). Some companies
  // have 5700 pre-allocated to "Legal & Professional" (older seed), so
  // we give Property Taxes its own code (5710) to avoid the collision.
  const { data: existing } = await svc.from("acct_accounts").select("id, code, name, type").eq("company_id", COMPANY_ID).eq("code", "5710").maybeSingle();
  if (!existing) {
    const { data: inserted, error } = await svc.from("acct_accounts").insert([{
      company_id: COMPANY_ID,
      code: "5710",
      name: "Property Taxes",
      type: "Expense",
      is_active: true,
      old_text_id: COMPANY_ID + "-5710",
    }]).select().single();
    assert(!error, "5710 account insert succeeds", error?.message);
    assert(inserted?.type === "Expense", "5710 typed as Expense");
    assert(inserted?.name === "Property Taxes", "5710 named Property Taxes");
  } else {
    assert(existing.type === "Expense", "5710 already present, typed as Expense");
    assert(existing.name === "Property Taxes", "5710 named Property Taxes");
  }
}

async function run() {
  console.log("═══════════════════════════════════════");
  console.log("🧪 property-taxes tests");
  console.log("═══════════════════════════════════════");
  try {
    await testCountyColumn();
    await testPropertyTaxes();
    await testPropertyTaxesAccount();
  } catch (e) {
    console.error("\nFATAL:", e.message); fail++;
  }
  console.log("\n═══════════════════════════════════════");
  console.log("✅ Passed: " + pass);
  console.log("❌ Failed: " + fail);
  if (errors.length) { console.log("\nFailed:"); errors.forEach(e => console.log("  - " + e)); }
  process.exit(fail > 0 ? 1 : 0);
}
run();
