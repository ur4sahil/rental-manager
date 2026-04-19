// ═══════════════════════════════════════════════════════════════
// PROPERTY TAX BILLS — data-layer test
// Exercises migration 20260410_property_tax_bills and the bill
// lifecycle (pending → paid → pending) plus dedup / CHECK guards.
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

async function seedProperty(addressLine, city, state, zip, county) {
  const { data, error } = await svc.from("properties").insert([{
    company_id: COMPANY_ID,
    address_line_1: addressLine,
    city, state, zip,
    county,
    type: "Single Family", status: "vacant", rent: 2000,
  }]).select().single();
  if (error) throw new Error("seedProperty: " + error.message);
  return data;
}

async function cleanupProperty(prop) {
  if (!prop?.id) return;
  await svc.from("property_tax_bills").delete().eq("company_id", COMPANY_ID).eq("property_id", prop.id);
  await svc.from("properties").delete().eq("id", prop.id);
}

async function testInsertRoundTrip() {
  console.log("\n📝 insert + round-trip");
  const prop = await seedProperty("ZZZ-BILL 1 Test St", "Rockville", "MD", "20850", "Montgomery County");
  try {
    const { data: bill, error } = await svc.from("property_tax_bills").insert([{
      company_id: COMPANY_ID,
      property: prop.address,
      property_id: prop.id,
      tax_year: 2026,
      installment_label: "1st half (MD)",
      due_date: "2026-09-30",
      expected_amount: 2600,
      status: "pending",
      auto_generated: true,
    }]).select().single();
    assert(!error, "bill insert", error?.message);
    assert(bill?.status === "pending", "status defaults/stores as pending");
    assert(bill?.auto_generated === true, "auto_generated stored");
    assert(Number(bill?.expected_amount) === 2600, "expected_amount round-trip");
    assert(bill?.installment_label === "1st half (MD)", "installment_label stored");
    assert(bill?.due_date === "2026-09-30", "due_date stored");
  } finally {
    await cleanupProperty(prop);
  }
}

async function testStatusCheck() {
  console.log("\n🚧 CHECK constraint on status");
  const prop = await seedProperty("ZZZ-BILL 2 Test St", "Rockville", "MD", "20850", "Montgomery County");
  try {
    const { error } = await svc.from("property_tax_bills").insert([{
      company_id: COMPANY_ID,
      property: prop.address,
      property_id: prop.id,
      tax_year: 2026,
      installment_label: "bogus",
      due_date: "2026-09-30",
      status: "not-a-status",
      auto_generated: true,
    }]);
    assert(!!error, "CHECK rejects invalid status", error ? null : "insert succeeded unexpectedly");
  } finally {
    await cleanupProperty(prop);
  }
}

async function testDedupUniqueIndex() {
  console.log("\n🔁 dedup unique index (auto_generated)");
  const prop = await seedProperty("ZZZ-BILL 3 Test St", "Chantilly", "VA", "20151", "Fairfax County");
  try {
    const base = {
      company_id: COMPANY_ID,
      property: prop.address,
      property_id: prop.id,
      tax_year: 2026,
      installment_label: "1st half (VA)",
      due_date: "2026-07-28",
      expected_amount: 3000,
      status: "pending",
      auto_generated: true,
    };
    const { error: e1 } = await svc.from("property_tax_bills").insert([base]);
    assert(!e1, "first auto_generated row inserts", e1?.message);

    // same (company, property, year, label) with auto_generated=true should be rejected
    const { error: e2 } = await svc.from("property_tax_bills").insert([{ ...base, due_date: "2026-07-30" }]);
    assert(!!e2, "duplicate auto_generated row rejected");

    // manual row with same key is allowed (partial index is WHERE auto_generated=true)
    const { error: e3 } = await svc.from("property_tax_bills").insert([{ ...base, auto_generated: false, due_date: "2026-07-31" }]);
    assert(!e3, "manual row with same key allowed", e3?.message);
  } finally {
    await cleanupProperty(prop);
  }
}

async function testPaidTransition() {
  console.log("\n💵 pending → paid → pending transitions");
  const prop = await seedProperty("ZZZ-BILL 4 Test St", "Chantilly", "VA", "20151", "Fairfax County");
  try {
    const { data: bill } = await svc.from("property_tax_bills").insert([{
      company_id: COMPANY_ID,
      property: prop.address,
      property_id: prop.id,
      tax_year: 2026,
      installment_label: "2nd half (VA)",
      due_date: "2026-12-05",
      expected_amount: 3100,
      status: "pending",
      auto_generated: true,
    }]).select().single();

    const { error: e1 } = await svc.from("property_tax_bills").update({
      status: "paid",
      paid_date: "2026-12-01",
      paid_amount: 3100,
      paid_notes: "test",
    }).eq("id", bill.id).eq("company_id", COMPANY_ID);
    assert(!e1, "mark paid update", e1?.message);
    const { data: paid } = await svc.from("property_tax_bills").select("*").eq("id", bill.id).single();
    assert(paid.status === "paid", "status is paid");
    assert(paid.paid_date === "2026-12-01", "paid_date persisted");
    assert(Number(paid.paid_amount) === 3100, "paid_amount persisted");

    const { error: e2 } = await svc.from("property_tax_bills").update({
      status: "pending",
      paid_date: null,
      paid_amount: null,
      paid_notes: null,
    }).eq("id", bill.id).eq("company_id", COMPANY_ID);
    assert(!e2, "unmark paid update", e2?.message);
    const { data: back } = await svc.from("property_tax_bills").select("*").eq("id", bill.id).single();
    assert(back.status === "pending", "status reverted to pending");
    assert(back.paid_date === null, "paid_date cleared");
    assert(back.paid_amount === null, "paid_amount cleared");
  } finally {
    await cleanupProperty(prop);
  }
}

async function run() {
  console.log("═══════════════════════════════════════");
  console.log("🧪 property-tax-bills tests");
  console.log("═══════════════════════════════════════");
  try {
    await testInsertRoundTrip();
    await testStatusCheck();
    await testDedupUniqueIndex();
    await testPaidTransition();
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
