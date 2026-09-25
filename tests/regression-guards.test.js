// Regression guards for the DB-side bugs that shipped in Sep 2026 because the
// suite exercised neither the cascade, the role-gate wiring, nor the loan
// credential constraint end-to-end.
//
//  A. STATIC migration checks (source of truth, no DB needed):
//     - the property-rename cascade updates EVERY address-keyed table
//       (it had silently dropped loans/portfolio/insurance/taxes/etc.);
//     - the destructive-action gate trigger stays SECURITY INVOKER — as
//       SECURITY DEFINER, current_user is the owner and the gate never fires;
//       and it is attached to every gated table;
//     - batch_post_late_fees skips disabled (is_active=false) rules.
//  B. LIVE DB checks (test DB via tests/.env):
//     - property_loans forbids '' credentials (must write real ciphertext or
//       NULL) — the '' fallback failed every credential save;
//     - the is_active column and notification_inbox_state table exist.
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "  — " + detail : ""}`); }
}

const migDir = path.join(__dirname, "..", "supabase", "migrations");
const migs = fs.readdirSync(migDir).filter(f => f.endsWith(".sql")).sort();
// Latest migration that CREATE-OR-REPLACEs the given function.
function latestFnText(fnName) {
  let found = null;
  const re = new RegExp("CREATE OR REPLACE FUNCTION\\s+(public\\.)?" + fnName + "\\b");
  for (const f of migs) {
    const t = fs.readFileSync(path.join(migDir, f), "utf8");
    if (re.test(t)) found = { file: f, text: t };
  }
  return found;
}

console.log("==============================================");
console.log("Regression guards — cascade / role-gate / late-fee / loan creds");
console.log("==============================================");

// ---- A1. rename cascade covers every address-keyed table ------------------
{
  const c = latestFnText("_cascade_property_rename");
  const expected = [
    "tenants", "payments", "leases", "work_orders", "documents", "utilities",
    "acct_journal_entries", "autopay_schedules", "hoa_payments", "inspections",
    "property_insurance", "property_loans", "property_taxes", "property_tax_bills",
    "recurring_journal_entries", "utility_accounts", "utility_bills",
    "vendor_invoices", "work_order_photos", "portfolio_loan_properties",
  ];
  if (!c) { assert("cascade migration found", false, "no _cascade_property_rename definition"); }
  else {
    const missing = expected.filter(t => !new RegExp("UPDATE\\s+" + t + "\\b").test(c.text));
    assert("rename cascade updates all address-keyed tables", missing.length === 0,
      missing.length ? "MISSING: " + missing.join(", ") : c.file);
  }
}

// ---- A2. destructive-gate trigger is SECURITY INVOKER + attached widely ----
{
  const g = latestFnText("enforce_management_tier_destructive");
  if (!g) { assert("mgmt-gate migration found", false, "no enforce_management_tier_destructive"); }
  else {
    // The trigger fn must be INVOKER (DEFINER makes current_user the owner and
    // the current_user='authenticated' guard never matches -> gate disabled).
    const defBlock = g.text.slice(g.text.indexOf("enforce_management_tier_destructive"));
    const isInvoker = /enforce_management_tier_destructive\(\)[\s\S]{0,120}SECURITY INVOKER/.test(g.text);
    const isDefiner = /enforce_management_tier_destructive\(\)[\s\S]{0,120}SECURITY DEFINER/.test(g.text);
    assert("destructive-gate trigger fn is SECURITY INVOKER", isInvoker && !isDefiner,
      isDefiner ? "is SECURITY DEFINER — gate will not enforce" : g.file);
    // Trigger presence is the NET of CREATE/DROP across all migrations in order
    // (utility_accounts was deliberately ungated in a later migration).
    const triggerPresent = (table) => {
      let present = false;
      for (const f of migs) {
        const t = fs.readFileSync(path.join(migDir, f), "utf8");
        if (new RegExp("DROP TRIGGER[\\s\\S]{0,80}ON public\\." + table + "\\b").test(t)) present = false;
        if (new RegExp("CREATE TRIGGER[\\s\\S]{0,120}ON public\\." + table + "\\b").test(t)) present = true;
      }
      return present;
    };
    const expectedTrigger = ["properties", "acct_journal_entries", "leases", "autopay_schedules",
      "owners", "vendors", "tenants", "work_orders", "acct_accounts", "owner_distributions"];
    const missing = expectedTrigger.filter(t => !triggerPresent(t));
    // utility_accounts is intentionally NOT gated (routine ops), so it must NOT have the trigger.
    const shouldNotHave = ["utility_accounts"].filter(t => triggerPresent(t));
    assert("gate trigger attached to exactly the gated tables", missing.length === 0 && shouldNotHave.length === 0,
      missing.length ? "MISSING: " + missing.join(", ") : shouldNotHave.length ? "UNEXPECTED: " + shouldNotHave.join(", ") : "10 gated, utility_accounts ungated");
  }
}

// ---- A3. batch_post_late_fees honours is_active ----------------------------
{
  const b = latestFnText("batch_post_late_fees");
  assert("batch_post_late_fees skips disabled rules (is_active)",
    !!b && /is_active/.test(b.text), b ? b.file : "no batch_post_late_fees");
}

// ---- B. live DB checks ----------------------------------------------------
(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("\n⏭  SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping live DB checks");
  } else {
    const sb = createClient(url, key, { auth: { persistSession: false } });

    // B1. columns/table that Wave-2 added must exist
    const isActive = await sb.from("late_fee_rules").select("is_active").limit(1);
    assert("late_fee_rules.is_active column exists",
      !(isActive.error && /does not exist|column/i.test(isActive.error.message || "")),
      isActive.error ? isActive.error.message : "ok");
    const inboxState = await sb.from("notification_inbox_state").select("inbox_id").limit(1);
    assert("notification_inbox_state table exists",
      !(inboxState.error && /does not exist|relation/i.test(inboxState.error.message || "")),
      inboxState.error ? inboxState.error.message : "ok");

    // B2. property_loans forbids '' credentials, allows NULL
    const co = await sb.from("properties").select("company_id").limit(1).maybeSingle();
    const companyId = co.data && co.data.company_id;
    if (!companyId) {
      console.log("⏭  no company found — skipping loan-credential constraint check");
    } else {
      await sb.from("property_loans").delete().eq("lender_name", "__guard_probe__"); // clean leftovers
      const bad = await sb.from("property_loans").insert([{
        company_id: companyId, property: "__guard_probe__", lender_name: "__guard_probe__",
        username_encrypted: "", password_encrypted: "x", encryption_iv: "x",
      }]);
      assert("property_loans rejects blank ('') credentials", !!bad.error,
        bad.error ? "rejected" : "INSERTED a blank credential — constraint missing!");
      const good = await sb.from("property_loans").insert([{
        company_id: companyId, property: "__guard_probe__", lender_name: "__guard_probe__",
        username_encrypted: null, password_encrypted: null, encryption_iv: null,
      }]).select("id");
      assert("property_loans accepts NULL credentials", !good.error,
        good.error ? good.error.message : "ok");
      await sb.from("property_loans").delete().eq("lender_name", "__guard_probe__"); // cleanup
    }
  }

  console.log("\n----------------------------------------------");
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
