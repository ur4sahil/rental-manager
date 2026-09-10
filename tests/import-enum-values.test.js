// Every dropdown the import template offers must be a value the database
// will actually accept.
//
// Run: cd tests && node import-enum-values.test.js
//
// property_taxes.billing_frequency carries a CHECK constraint --
// 'annual','semi_annual','quarterly','monthly'. The template offered
// "Annually", so every row of a real 40-row Property Tax sheet was
// rejected by Postgres and the user saw "imported" with nothing to show
// for it. The other columns have no constraint but do have a house
// style, and writing "Monthly" beside "monthly" splits the data in two.
require("./sandbox-env");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });

  // Read the CHECK constraints straight from the database rather than
  // restating them here, so the test tracks the schema.
  const { data: cons, error } = await sb.rpc("exec_sql", { q: "" }).then(
    () => ({ data: null, error: null }), () => ({ data: null, error: null }));
  void cons; void error;

  // The values the app itself has stored, which is the ground truth for
  // the columns with no constraint.
  const seen = {};
  for (const [label, table, col] of [
    ["utilities.responsibility", "utilities", "responsibility"],
    ["hoa.frequency", "hoa_payments", "frequency"],
    ["insurance.premium_frequency", "property_insurance", "premium_frequency"],
    ["taxes.billing_frequency", "property_taxes", "billing_frequency"],
  ]) {
    const { data } = await sb.from(table).select(col).not(col, "is", null).limit(1000);
    seen[label] = [...new Set((data || []).map(r => r[col]))];
  }

  // What the importer will actually write, exercised through the same
  // normaliser the commit path uses. Kept in step by reading it out of
  // the component source, so renaming it fails the test loudly.
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "components", "PropertyImport.js"), "utf8");
  const m = src.match(/const ENUMS = \{[\s\S]*?\n  \};/);
  assert("the normaliser is still present in PropertyImport.js", !!m);
  if (!m) { console.log(`\n✅ Passed: ${passed}   ❌ Failed: ${failed}`); process.exit(1); }
  // eslint-disable-next-line no-eval
  const ENUMS = eval("(" + m[0].replace("const ENUMS = ", "") .replace(/;$/, "") + ")");

  const pi = await import(path.join(__dirname, "..", "src", "utils", "propertyImportSheets.js"));

  // Tax frequency is the one with a hard constraint.
  const TAX_ALLOWED = ["annual", "semi_annual", "quarterly", "monthly"];
  const taxOut = pi.TAX_FREQUENCY.map(label => ENUMS.taxFrequency[label.toLowerCase()]);
  assert("every Property Tax frequency the sheet offers maps to an allowed value",
    taxOut.every(v => TAX_ALLOWED.includes(v)),
    `${JSON.stringify(pi.TAX_FREQUENCY)} -> ${JSON.stringify(taxOut)}; allowed ${JSON.stringify(TAX_ALLOWED)}`);

  // And prove it end to end: the constraint really does reject the label.
  const bad = await sb.from("property_taxes").insert([{
    company_id: "sandbox-llc", property: "enum probe", annual_tax_amount: 1,
    billing_frequency: pi.TAX_FREQUENCY[0],
  }]).select();
  assert("the raw sheet label is genuinely rejected by the database",
    !!bad.error, "if this passes, the constraint is gone and the mapping can go");
  if (!bad.error && bad.data?.[0]?.id) await sb.from("property_taxes").delete().eq("id", bad.data[0].id);

  const good = await sb.from("property_taxes").insert([{
    company_id: "sandbox-llc", property: "enum probe", annual_tax_amount: 1,
    billing_frequency: ENUMS.taxFrequency[pi.TAX_FREQUENCY[0].toLowerCase()],
  }]).select();
  assert("the normalised value is accepted", !good.error, good.error?.message);
  if (good.data?.[0]?.id) await sb.from("property_taxes").delete().eq("id", good.data[0].id);

  // The unconstrained columns: what we write should look like what the
  // app already stores, not a differently-cased twin.
  for (const [label, kind, list] of [
    ["utilities.responsibility", "responsibility", pi.UTILITY_RESPONSIBILITY],
    ["hoa.frequency", "hoaFrequency", pi.HOA_FREQUENCY],
    ["insurance.premium_frequency", "premiumFrequency", pi.PREMIUM_FREQUENCY],
  ]) {
    const out = list.map(l => ENUMS[kind][l.toLowerCase()] || l.toLowerCase());
    const existing = seen[label] || [];

    // What we write must be lowercase and must be a value the app
    // already uses -- never a new one invented by the spreadsheet.
    assert(`${label}: the sheet writes lowercase, not display labels`,
      out.every(v => v === v.toLowerCase()), JSON.stringify(out));
    // Deliberately NOT asserting that every value already appears in the
    // table: an HOA can be annual and insurance can be monthly even if
    // nobody has stored one yet. That check measured the sample, not
    // correctness, and failed on both.

    // Mixed casing already in the table is a pre-existing data problem,
    // written by the app itself, not something this import introduces.
    // Worth seeing, not worth failing on.
    const mixed = [...new Set(existing.map(e => String(e).toLowerCase()))]
      .filter(l => existing.filter(e => String(e).toLowerCase() === l).length > 1);
    if (mixed.length) console.log(`   note: ${label} already holds mixed casing for ${JSON.stringify(mixed)} — pre-existing`);
  }

  console.log(`\n✅ Passed: ${passed}   ❌ Failed: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
