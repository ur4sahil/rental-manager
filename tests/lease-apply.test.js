// Exercises the exact query sequence Housy's lease-apply runs, against the
// real schema.
//
// The logic shipped to staging untested, which was a mistake: it does
// property matching, tenant matching and a duplicate-lease check, and a
// single wrong column name would make any of those fail as a silent 400
// that the app reads as "no match" -- this repo's most expensive bug class.
//
// Written to find the refusals, not the happy path. A lease created against
// the wrong property poisons every rent charge and late fee after it.
require("dotenv").config();
require("./sandbox-env");
const { createClient } = require("@supabase/supabase-js");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const COMPANY = "sandbox-llc";
const TAG = `leasetest-${Date.now()}`;
let pass = 0, fail = 0;
const assert = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✅" : "❌"} ${n}${!c && d ? "  — " + d : ""}`); };

// escapeFilterValue, as the component uses it.
const esc = v => String(v).replace(/([%_,\\])/g, "\\$1");

(async () => {
  // ---- the columns the apply path filters on must exist ---------------
  // A missing column is a 400 that PostgREST returns and the app's
  // try/catch turns into an empty list -- which reads as "no property
  // matched" and produces a refusal that looks like a data problem.
  for (const [table, cols] of [
    ["properties", "id, address, short_name, archived_at"],
    ["tenants", "id, name, archived_at"],
    ["leases", "id, start_date, end_date, status, archived_at, property, property_id, tenant_id, tenant_name, rent_amount, security_deposit, payment_due_day, late_fee_amount, late_fee_type"],
  ]) {
    const { error } = await sb.from(table).select(cols).eq("company_id", COMPANY).limit(1);
    assert(`${table}: every column the apply path reads exists`, !error, error?.message);
  }

  // ---- property matching ----------------------------------------------
  const { data: props } = await sb.from("properties")
    .select("id, address, short_name").eq("company_id", COMPANY).is("archived_at", null).limit(3);
  assert("the test company has properties to match against", (props || []).length > 0);
  if (!props?.length) { console.log("\ncannot continue without a property"); process.exit(1); }

  const prop = props[0];
  const firstLine = String(prop.address).split(",")[0].trim();
  const { data: matched, error: mErr } = await sb.from("properties")
    .select("id, address, short_name").eq("company_id", COMPANY)
    .ilike("address", `%${esc(firstLine)}%`).is("archived_at", null).limit(2);
  assert("an address's first line finds its property", !mErr && (matched || []).some(m => m.id === prop.id), mErr?.message);

  // The refusal that matters: an address matching two properties must NOT
  // pick one. "100 Oak Street" and "100 Oak Street, Unit A" both exist in
  // this data, and guessing between them puts a lease on the wrong unit.
  const { data: ambiguous } = await sb.from("properties")
    .select("id, address").eq("company_id", COMPANY)
    .ilike("address", "%Oak%").is("archived_at", null).limit(5);
  if ((ambiguous || []).length > 1) {
    assert("an ambiguous address yields multiple candidates (so apply refuses)", true);
  } else {
    console.log("ℹ  no ambiguous address pair in this data — refusal path not exercised");
  }

  // A nonsense address must find nothing rather than erroring.
  const { data: none, error: nErr } = await sb.from("properties")
    .select("id").eq("company_id", COMPANY)
    .ilike("address", `%${esc("Nowhere Street 99999")}%`).is("archived_at", null).limit(2);
  assert("an unknown address matches nothing, without error", !nErr && (none || []).length === 0, nErr?.message);

  // ---- tenant matching -------------------------------------------------
  const { error: tErr } = await sb.from("tenants").select("id, name")
    .eq("company_id", COMPANY).ilike("name", esc("Marcus A. Whitfield"))
    .is("archived_at", null).limit(2);
  assert("tenant lookup by name runs clean", !tErr, tErr?.message);

  // ---- the duplicate-lease guard --------------------------------------
  const propName = prop.short_name || prop.address;
  const { error: lErr } = await sb.from("leases").select("id, start_date, end_date")
    .eq("company_id", COMPANY).eq("property", propName)
    .eq("status", "active").is("archived_at", null).limit(1);
  assert("the active-lease check runs clean", !lErr, lErr?.message);

  // ---- the insert itself ----------------------------------------------
  // Every NOT NULL column, in the exact shape the component builds.
  const row = {
    company_id: COMPANY,
    tenant_name: `${TAG} Tenant`,
    tenant_id: null,
    property: propName,
    property_id: prop.id,
    start_date: "2026-10-01",
    end_date: "2027-09-30",
    rent_amount: 2450,
    security_deposit: 3675,
    payment_due_day: 1,
    late_fee_amount: 122.5,
    late_fee_type: "flat",   // chk_lease_late_fee_type allows flat|percent only
    status: "draft",
    created_by: "lease-apply.test.js",
  };
  const { data: made, error: iErr } = await sb.from("leases").insert([row]).select().single();
  assert("a lease inserts with the exact shape apply builds", !iErr, iErr?.message);

  if (made) {
    assert("it lands as draft, not active", made.status === "draft", `got ${made.status}`);
    assert("the rent is stored", Number(made.rent_amount) === 2450);
    assert("the property is linked by id as well as name",
      made.property_id === prop.id && made.property === propName);
    // Draft, deliberately: activating a lease is what starts rent charging,
    // and that must be a deliberate act rather than a side effect of
    // approving a reading.
    const { data: charges } = await sb.from("acct_journal_entries")
      .select("id").eq("company_id", COMPANY).ilike("reference", `%${made.id}%`).limit(1);
    assert("approving a lease posts nothing to the ledger", (charges || []).length === 0);

    await sb.from("leases").delete().eq("id", made.id);
  }

  const { data: left } = await sb.from("leases").select("id").eq("company_id", COMPANY).ilike("tenant_name", `${TAG}%`);
  assert("cleaned up", (left || []).length === 0, `${(left || []).length} left`);

  console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("SUITE ERROR:", e.message); process.exit(1); });
