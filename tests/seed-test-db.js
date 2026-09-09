// Copy the two fixture companies the database suites depend on from
// production into the TEST project.
//
//   node seed-test-db.js
//
// The 20 database suites are written against "Sandbox LLC" and "Smith
// Properties LLC". Both live in production, so repointing the suite at
// the test project (see sandbox-env.js) left them failing on absent
// fixtures rather than on anything real -- the test project has neither
// company.
//
// READS production. WRITES only the test project. There is no mutating
// call on the production client anywhere in this file.
//
// Idempotent: rows whose id already exists in the test project are
// skipped, so re-running tops up rather than duplicating.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");

const PROD_REF = "hoymytpyaudjvsgiiibn";
const TEST_REF = "vpeewlplgxthckpidhxo";

const prodUrl = process.env.SUPABASE_URL;
const prodKey = process.env.SUPABASE_SERVICE_KEY;
const testUrl = process.env.TEST_SUPABASE_URL;
const testKey = process.env.TEST_SUPABASE_SERVICE_KEY;

if (!prodUrl || !prodUrl.includes(PROD_REF)) { console.error("SUPABASE_URL is not the production project"); process.exit(1); }
if (!testUrl || !testUrl.includes(TEST_REF)) { console.error("TEST_SUPABASE_URL is not the test project"); process.exit(1); }
if (!testKey) { console.error("TEST_SUPABASE_SERVICE_KEY is not set — see sandbox-env.js"); process.exit(1); }

const prod = createClient(prodUrl, prodKey, { auth: { persistSession: false } });
const test = createClient(testUrl, testKey, { auth: { persistSession: false } });

const COMPANIES = ["sandbox-llc", "dce4974d-afa9-4e65-afdf-1189b815195d"];

// EVERY base table carrying a company_id, so the fixture is complete
// rather than whatever a hand-written list happened to remember. The
// first version listed 19 tables and the suites then failed on a
// missing lease_templates row; there were 41 more where that came from.
//
// Order is roughly FK order -- owners and accounts before the things
// that point at them -- but it cannot be exactly right: acct_accounts
// references itself, and several tables reference each other. The
// convergence rounds below clean up whatever this order misses, so this
// only has to be close.
const TABLES = [
  // parents first
  "owners", "vendors", "app_users", "company_members", "company_settings",
  "acct_accounts", "acct_classes", "doc_templates", "lease_templates",
  "utility_providers", "utility_accounts",
  // core records
  "properties", "tenants", "leases", "lease_signatures",
  // accounting
  "acct_journal_entries", "acct_journal_lines", "acct_period_balances",
  "accounting_period_lock", "payments", "ledger_entries_legacy_table",
  "budgets", "recurring_journal_entries", "late_fee_rules",
  "owner_statements", "owner_distributions",
  // property detail
  "utilities", "utility_bills", "utility_audit", "hoa_payments",
  "property_loans", "property_insurance", "property_taxes",
  "property_tax_bills", "property_licenses", "property_setup_wizard",
  "property_change_requests", "inspections",
  // operations
  "work_orders", "work_order_photos", "vendor_invoices", "eviction_cases",
  "documents", "doc_generated", "doc_signatures", "doc_signature_audit_log",
  "doc_exception_requests", "tenant_invite_codes", "autopay_schedules",
  // banking
  "bank_connection", "bank_account_feed", "bank_import_batch",
  "bank_import_mapping_profile", "bank_feed_transaction",
  "bank_feed_transaction_link", "bank_posting_decision",
  "bank_posting_decision_line", "bank_reconciliations",
  "bank_transaction_rule", "plaid_sync_event",
  // messaging and logs
  "messages", "notification_settings", "notification_templates",
  "notification_inbox", "notification_queue", "notification_log",
  "push_subscriptions", "push_attempts", "automation_jobs",
  "audit_trail", "error_log",
];

// PostgREST caps a response at 1000 rows, so page rather than trusting
// a single select to return everything.
//
// Ordered, because range() without an ORDER BY is not stable: Postgres
// may return rows in a different order per page, so a row can appear
// twice and another never. That produced 6,919 duplicate-key rejections
// on error_log, the only table here big enough to page.
async function pageAll(client, table) {
  const out = [];
  const seen = new Set();
  for (let from = 0; ; from += 1000) {
    let q = client.from(table).select("*").in("company_id", COMPANIES);
    // Not every table has an id to sort on; fall back to unordered and
    // let the id de-dupe below catch the overlap.
    const { data, error } = await q.order("id", { ascending: true }).range(from, from + 999);
    let rows = data, err = error;
    if (err && /column .*id.* does not exist|order/i.test(err.message)) {
      const retry = await client.from(table).select("*")
        .in("company_id", COMPANIES).range(from, from + 999);
      rows = retry.data; err = retry.error;
    }
    if (err) return { rows: null, error: err };
    for (const r of rows || []) {
      const k = r.id === undefined || r.id === null ? JSON.stringify(r) : String(r.id);
      if (!seen.has(k)) { seen.add(k); out.push(r); }
    }
    if (!rows || rows.length < 1000) break;
  }
  return { rows: out };
}

const pending = [];   // rows a foreign key rejected, retried below

(async () => {
  const { data: comps, error: cErr } = await prod.from("companies").select("*").in("id", COMPANIES);
  if (cErr) { console.error("read companies:", cErr.message); process.exit(1); }

  const { data: existingComps } = await test.from("companies").select("id").in("id", COMPANIES);
  const haveComp = new Set((existingComps || []).map(c => c.id));
  const newComps = (comps || []).filter(c => !haveComp.has(c.id));
  if (newComps.length) {
    const { error } = await test.from("companies").insert(newComps);
    if (error) { console.error("write companies:", error.message); process.exit(1); }
  }
  console.log(`companies                 ${newComps.length} copied, ${haveComp.size} already present`);

  for (const table of TABLES) {
    const { rows, error } = await pageAll(prod, table);
    if (error) { console.log(`${table.padEnd(26)}skipped (${error.message.slice(0, 60)})`); continue; }
    if (!rows.length) { console.log(`${table.padEnd(26)}nothing in production`); continue; }

    // Skip ids already in the test project so a re-run tops up.
    // .in() takes at most 100 values per call.
    const ids = rows.map(r => r.id).filter(v => v !== undefined && v !== null);
    const have = new Set();
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await test.from(table).select("id").in("id", ids.slice(i, i + 100));
      (data || []).forEach(r => have.add(String(r.id)));
    }
    const fresh = rows.filter(r => !have.has(String(r.id)));
    if (!fresh.length) { console.log(`${table.padEnd(26)}all ${rows.length} already present`); continue; }

    let written = 0, deferred = 0;
    for (let i = 0; i < fresh.length; i += 200) {
      const chunk = fresh.slice(i, i + 200);
      const { error: wErr } = await test.from(table).insert(chunk);
      if (wErr) {
        // One bad row must not cost the whole batch — retry singly, and
        // hand anything still failing to the convergence rounds rather
        // than giving up on it here. Most of these are a parent that has
        // not been copied yet.
        for (const row of chunk) {
          const { error: rErr } = await test.from(table).insert([row]);
          if (rErr) { pending.push({ table, row, err: rErr.message }); deferred++; }
          else written++;
        }
      } else written += chunk.length;
    }
    console.log(`${table.padEnd(26)}${written} copied${deferred ? `, ${deferred} deferred` : ""}`);
  }

  // ---- convergence ---------------------------------------------------
  // A row rejected on a foreign key is usually waiting on a parent that
  // sorts later -- acct_accounts references itself, and several tables
  // reference each other. Retry the whole backlog until a full round
  // adds nothing, which is the point at which the remainder is genuinely
  // unresolvable rather than merely out of order.
  for (let round = 1; round <= 8 && pending.length; round++) {
    const still = [];
    let recovered = 0;
    for (const item of pending) {
      const { error } = await test.from(item.table).insert([item.row]);
      if (error) { item.err = error.message; still.push(item); } else recovered++;
    }
    console.log(`round ${round}: ${recovered} recovered, ${still.length} still pending`);
    pending.length = 0;
    pending.push(...still);
    if (!recovered) break;
  }

  if (pending.length) {
    console.log("\nunresolved:");
    const byTable = {};
    for (const p of pending) (byTable[p.table] = byTable[p.table] || []).push(p);
    for (const [t, rows] of Object.entries(byTable)) {
      console.log(`  ${t.padEnd(24)} ${rows.length}  — ${rows[0].err.slice(0, 90)}`);
    }
  } else {
    console.log("\neverything copied");
  }

  console.log("\ndone — production was only read from");
})();
