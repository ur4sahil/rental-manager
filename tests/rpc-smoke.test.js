// Smoke-test the DATABASE, which no other audit in this repo touches.
//
// Why this exists: batch_post_rent_charges had never worked. It raised
// 42883 ("operator does not exist: date <= text") on its FIRST statement,
// so it had posted no rent, ever. Nothing caught it for months because
// every audit here tests JavaScript or the browser -- test:undef,
// test:routes, column-integrity, the click sweep, the e2e specs. None of
// them calls a database function, and there are 209 of them plus 41
// triggers. A function that throws on line one is indistinguishable from
// one that works if nothing ever asks it.
//
// It does NOT check that the accounting is right. It checks that each
// function still MATCHES THE SCHEMA -- which is the failure mode that
// actually occurred, and would have occurred again: these functions were
// written when several columns were text and the ledger was a table.
//
// TWO HARD-WON RULES, both from running the first version:
//
//  1. NEVER call a function whose name suggests it destroys things. The
//     trial sweep called hard_delete_company('sandbox-llc') and was
//     saved only by that function's own guard refusing to remove the
//     last admin. One guard away from deleting the fixture company.
//
//  2. Call with a REAL staff identity, not a null company id. With a null
//     id the access check fails first (P0001) and the schema mismatch
//     underneath stays hidden -- which is precisely how rent posting hid.
//     Consequence: functions that work will WRITE, so this restores
//     balances and removes anything it posted afterwards.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");

const TEST_REF = "vpeewlplgxthckpidhxo";
const URL_ = process.env.TEST_SUPABASE_URL;
const KEY_ = process.env.TEST_SUPABASE_SERVICE_KEY;
const COMPANY = "sandbox-llc";

// Never invoked. Names, not behaviour, because behaviour is what we are
// trying to discover -- we cannot know a function is safe before calling
// it, so anything that sounds destructive is excluded by name.
const NEVER_CALL = /(^|_)(hard_)?delete|purge|drop|truncate|wipe|remove_|cascade|reset_/i;

// SQLSTATEs that mean "this function no longer fits the schema".
const SCHEMA_BREAK = {
  "42883": "operator/function does not exist (type mismatch)",
  "42804": "wrong datatype passed to a column",
  "42703": "column does not exist",
  "42P01": "table or view does not exist",
  "22P02": "invalid input syntax for type",
  "22003": "numeric value out of range",
  "55000": "object not in prerequisite state (e.g. insert into a view)",
};
// Reaching a guard or a constraint means the function RAN. Not a failure.
const REACHED_LOGIC = new Set(["P0001", "23502", "23503", "23505", "42501", "23514"]);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("  ❌ " + m)); };

(async () => {
  if (!URL_ || !KEY_) { console.log("SKIP: TEST_SUPABASE_* not set"); process.exit(0); }
  if (!URL_.includes(TEST_REF)) { console.error("refusing to run: not the test project"); process.exit(1); }
  const sb = createClient(URL_, KEY_, { auth: { persistSession: false } });

  const { data, error } = await sb.rpc("exec_rpc_smoke", { p_company_id: COMPANY });
  if (error) {
    // The helper is created by migration 20260912010000. Without it this
    // test cannot introspect, and saying so beats passing vacuously.
    console.log("  ❌ exec_rpc_smoke is unavailable: " + error.message);
    console.log("\n✅ Passed: 0\n❌ Failed: 1");
    process.exit(1);
  }

  const rows = data || [];
  const broken = rows.filter(r => SCHEMA_BREAK[r.err_state]);
  const reached = rows.filter(r => REACHED_LOGIC.has(r.err_state));
  const ran = rows.filter(r => r.err_state === "00000");
  const skipped = rows.filter(r => r.err_state === "SKIP");
  const other = rows.filter(r => !SCHEMA_BREAK[r.err_state] && !REACHED_LOGIC.has(r.err_state)
                                 && r.err_state !== "00000" && r.err_state !== "SKIP");

  console.log(`\nswept ${rows.length} callable functions`);
  console.log(`  ran clean      ${ran.length}`);
  console.log(`  hit a guard    ${reached.length}`);
  console.log(`  skipped        ${skipped.length}`);
  console.log(`  other          ${other.length}`);
  console.log(`  SCHEMA BROKEN  ${broken.length}`);
  broken.forEach(r => console.log(`     ${r.fn}  ${r.err_state}  ${SCHEMA_BREAK[r.err_state]}\n        ${r.msg}`));
  skipped.forEach(r => console.log(`     (skipped) ${r.fn} — ${r.msg}`));
  other.forEach(r => console.log(`     (other) ${r.fn}  ${r.err_state}  ${r.msg}`));

  ok(rows.length > 0, "the sweep found callable functions to test");
  ok(broken.length === 0, `${broken.length} database function(s) no longer match the schema`);

  console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
