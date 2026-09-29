// Saving without a login, and the "LOGIN MISSING" to-dos that follow.
//
// (A) A utility, insurance policy, loan or HOA saved WITHOUT a portal login
//     used to be rejected by the database: chk_<table>_creds_not_blank forbids
//     '' in the credential columns, but those columns DEFAULTed to '' -- so an
//     insert that simply omitted the login failed. 20260928120000 makes the
//     default NULL, and the app's writers send NULL (never '') when blank.
//
// (B) Tasks & Approvals lists each such record as a "login missing" to-do,
//     grouped under its property, skipping utilities the tenant pays, and the
//     to-do disappears once a login is stored (computed, no task table).
//
// Part 1: pure rules (src/utils/loginMissing.js, no imports).
// Part 2: static checks on the migration, writers, Tasks page and deep links.
// Part 3: live against the TEST project (tagged QA-LOGIN rows, removed after).
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const src = (f) => read(path.join("src", f));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}

const M = await import("data:text/javascript," + encodeURIComponent(src("utils/loginMissing.js")));
assert("loginMissing.js imports nothing (runs in node and the browser alike)", !/^\s*import\s/m.test(src("utils/loginMissing.js")));

// Same grouping TasksList does: one card per task.address.
function groupByProperty(tasks) {
  const by = new Map();
  for (const t of tasks) {
    if (!t.address) continue;
    if (!by.has(t.address)) by.set(t.address, []);
    by.get(t.address).push(t);
  }
  return by;
}

// ─── 1. PURE RULES ────────────────────────────────────────────────────────
console.log("\n🧮 LOGIN-MISSING RULES");
assert("tenant-paid: 'tenant' and 'tenant_pays' (any case)", M.isTenantPaid("tenant") && M.isTenantPaid("tenant_pays") && M.isTenantPaid(" Tenant "));
assert("not tenant-paid: owner / owner_pays / condo_fee / null", !M.isTenantPaid("owner") && !M.isTenantPaid("owner_pays") && !M.isTenantPaid("condo_fee") && !M.isTenantPaid(null));
assert("'' and whitespace are not a login", !M.hasValue("") && !M.hasValue("  ") && !M.hasValue(null) && !M.hasValue(undefined) && M.hasValue("abc"));

const A = "1 Alpha St, Town, MD 20601", B = "2 Beta Rd, Town, MD 20601";
const rows = {
  utility: [
    { id: 1, property: A, provider: "Pepco", responsibility: "owner", is_final_bill: false, username_encrypted: null },
    { id: 2, property: A, provider: "WSSC", responsibility: "tenant", username_encrypted: null },            // tenant pays -> skip
    { id: 3, property: A, provider: "Washington Gas", responsibility: "tenant_pays", username_encrypted: null }, // tenant pays -> skip
    { id: 4, property: A, provider: "BGE", responsibility: "owner", is_final_bill: true, username_encrypted: null }, // final bill -> skip
    { id: 5, property: A, provider: "Verizon", responsibility: null, username_encrypted: "cipher" },       // has login
    { id: 6, property: B, provider: "Dominion", responsibility: "owner", archived_at: "2026-01-01", username_encrypted: null }, // archived
    { id: 7, property: B, provider: "Fairfax Water", responsibility: "condo_fee", username_encrypted: "" },  // '' = missing
    { id: 8, property: B, provider: "fairfax water ", responsibility: "owner", username_encrypted: null },   // same provider -> one to-do
    { id: 9, property: B, provider: "Comcast", responsibility: "owner", username_encrypted: null },
    { id: 10, property: B, provider: "Comcast", responsibility: "owner", username_encrypted: "cipher" },     // a duplicate with login covers it
  ],
  insurance: [
    { id: "i1", property: A, provider: "State Farm", username_encrypted: null },
    { id: "i2", property: B, provider: "Allstate", username_encrypted: "cipher" },
    { id: "i3", property: B, provider: "Old Policy", archived_at: "2026-01-01", username_encrypted: null },
  ],
  loan: [{ id: "l1", property: B, lender_name: "Chase", username_encrypted: "" }],
  hoa: [
    { id: 11, property: A, hoa_name: "Alpha HOA", username_encrypted: null, mgmt_username_encrypted: null, pay_username_encrypted: null },
    { id: 12, property: B, hoa_name: "Beta HOA", username_encrypted: null, mgmt_username_encrypted: null, pay_username_encrypted: "cipher" }, // pay login counts
  ],
};
const tasks = M.buildLoginMissingTasks(rows, new Map([[A, 101]]));
const titles = tasks.map(t => t.title).sort();
assert("exactly the records without a login become to-dos", JSON.stringify(titles) === JSON.stringify([
  "Alpha HOA — login missing (HOA)", "Chase — login missing (Loan)", "Fairfax Water — login missing (Utility)",
  "Pepco — login missing (Utility)", "State Farm — login missing (Insurance)"]), JSON.stringify(titles));
const g = groupByProperty(tasks);
assert("grouped: one card per property", g.size === 2 && g.get(A).length === 3 && g.get(B).length === 2);
const pepco = tasks.find(t => t.title.startsWith("Pepco"));
assert("each to-do links to its record's page with editRecordId", pepco.link === "utilities" && pepco.linkAction.editRecordId === 1
  && tasks.find(t => t.recordType === "insurance").link === "insurance" && tasks.find(t => t.recordType === "loan").link === "loans"
  && tasks.find(t => t.recordType === "hoa").link === "hoa");
assert("property id attached when known", pepco.propertyId === 101 && tasks.find(t => t.recordType === "loan").propertyId === null);
assert("to-dos are _kind login_missing (rendered as click-to-navigate rows, not wizard steps)", tasks.every(t => t._kind === "login_missing"));
const after = M.buildLoginMissingTasks({ ...rows, insurance: rows.insurance.map(r => r.id === "i1" ? { ...r, username_encrypted: "cipher" } : r) });
assert("a saved login removes its to-do", !after.some(t => t.recordType === "insurance") && after.length === tasks.length - 1);
assert("no rows -> no to-dos", M.buildLoginMissingTasks({}).length === 0 && M.buildLoginMissingTasks(null).length === 0);

// ─── 2. STATIC ────────────────────────────────────────────────────────────
console.log("\n📄 MIGRATION + WRITERS");
const mig = read("supabase/migrations/20260928120000_creds_default_null.sql");
for (const t of ["utilities", "property_insurance", "property_loans", "hoa_payments"]) {
  const block = (mig.split("ALTER TABLE public." + t)[1] || "").split(";")[0];
  assert(`migration: ${t} username/password/iv default NULL`,
    ["username_encrypted", "password_encrypted", "encryption_iv "].every(c => new RegExp(c.trim() + "\\s+SET DEFAULT NULL").test(block)));
}
assert("migration does not touch rows or the CHECK constraints", !/\bUPDATE\b|DROP CONSTRAINT|ADD CONSTRAINT/i.test(mig.replace(/--.*$/gm, "")));

const blankish = /(username_encrypted|password_encrypted|encryption_iv|encryption_salt)\s*=\s*res[UP]\.(encrypted|iv|salt)(\s*\|\|\s*res[UP]\.(iv|salt))?\s*;/;
for (const f of ["components/Insurance.js", "components/HOA.js", "components/Utilities.js"]) {
  assert(`${f}: credential fields map blank -> null (never '')`, !blankish.test(src(f)) && !/_encrypted[^;\n]*\|\|\s*""/.test(src(f)));
}
assert("Loans.js: insert writes NULL creds when none", /username_encrypted: creds \? creds\.username_encrypted : null/.test(src("components/Loans.js")));

console.log("\n📋 TASKS PAGE + DEEP LINKS");
const admin = src("components/Admin.js");
assert("Tasks page builds login-missing to-dos from the shared rules", /buildLoginMissingTasks\(loginRows/.test(admin) && /LOGIN_MISSING_SOURCES\.map/.test(admin));
assert("Tasks page pages its reads (fetchAllPaged) and excludes archived", /fetchAllPaged\(\(\) => \{[\s\S]{0,200}\.is\("archived_at", null\)/.test(admin));
assert("Tasks page excludes utility final bills", /not\("is_final_bill", "is", true\)/.test(admin));
for (const [f, list] of [["Utilities.js", "utilAccounts"], ["Insurance.js", "policies"], ["Loans.js", "loans"], ["HOA.js", "hoaPayments"]]) {
  const s = src("components/" + f);
  assert(`${f}: accepts initialAction and opens the edit form for editRecordId`,
    /showConfirm, initialAction \}\)/.test(s) && /initialAction\?\.editRecordId/.test(s) && new RegExp("\\}, \\[initialAction, " + list + "\\]\\)").test(s));
}
assert("Utilities deep link resolves the utilities row to its linked account", /a\.legacy_utility_id\) === String\(id\)/.test(src("components/Utilities.js")));
assert("App passes initialAction to every page", /initialAction=\{pageAction\}/.test(src("App.js")));

// ─── 3. LIVE (TEST project) ───────────────────────────────────────────────
let live = false;
try { require("./sandbox-env"); live = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY); } catch { live = false; }
if (!live) {
  console.log("\n(live checks skipped: no TEST credentials)");
} else {
  console.log("\n🧪 LIVE (TEST)");
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const CID = "sandbox-llc";
  const tag = "QA-LOGIN " + Date.now();
  const P1 = tag + " 1 Test St", P2 = tag + " 2 Test St";
  const cleanup = async () => {
    const out = {};
    const { data: us } = await sb.from("utilities").select("id").eq("company_id", CID).like("property", "QA-LOGIN%");
    const uids = (us || []).map(u => u.id);
    if (uids.length) await sb.from("utility_accounts").delete().in("legacy_utility_id", uids);
    await sb.from("utility_accounts").delete().eq("company_id", CID).like("property", "QA-LOGIN%");
    for (const t of ["utilities", "property_insurance", "property_loans", "hoa_payments"]) {
      await sb.from(t).delete().eq("company_id", CID).like("property", "QA-LOGIN%");
      const { count } = await sb.from(t).select("id", { count: "exact", head: true }).eq("company_id", CID).like("property", "QA-LOGIN%");
      out[t] = count;
    }
    const { count: ua } = await sb.from("utility_accounts").select("id", { count: "exact", head: true }).eq("company_id", CID).like("property", "QA-LOGIN%");
    out.utility_accounts = ua;
    return out;
  };
  try {
    await cleanup(); // leftovers from an interrupted run
    // Payload shapes as the app sends them when no login is entered.
    const ins = async (table, row) => sb.from(table).insert([{ company_id: CID, ...row }]).select().single();
    const u1 = await ins("utilities", { property: P1, provider: "QA Electric", amount: 100, due: "2026-10-01", responsibility: "owner", status: "pending", website: "" });
    const u2 = await ins("utilities", { property: P1, provider: "QA Water", amount: 50, due: "2026-10-01", responsibility: "tenant", status: "pending", website: "" });
    const pol = await ins("property_insurance", { property: P1, provider: "QA Insurer", policy_number: "", premium_amount: 1200, premium_frequency: "Annual", coverage_amount: 0, expiration_date: null, notes: "", website: "" });
    const loan = await ins("property_loans", { property: P2, lender_name: "QA Bank", loan_type: "Conventional", original_amount: 100000, current_balance: 100000, interest_rate: 0, monthly_payment: 0, escrow_included: false, escrow_amount: 0, escrow_covers: "", loan_start_date: null, maturity_date: null, account_number: "", notes: "", status: "active", website: "",
      username_encrypted: null, password_encrypted: null, encryption_iv: null, encryption_iv_username: null, encryption_salt: null });
    const hoa = await ins("hoa_payments", { property: P1, hoa_name: "QA HOA", amount: 75, due_date: "2026-10-01", frequency: "monthly", status: "pending", notes: "", website: "", contact_email: null, contact_name: null, contact_phone: null, management_company: null });
    for (const [n, r] of [["utility", u1], ["tenant-paid utility", u2], ["insurance", pol], ["loan", loan], ["HOA", hoa]]) {
      assert(`insert without login succeeds: ${n}`, !r.error && r.data, r.error && r.error.message);
    }
    assert("omitted credential columns are NULL, not ''", [u1, pol, hoa].every(r => r.data && r.data.username_encrypted === null && r.data.password_encrypted === null && r.data.encryption_iv === null));

    // The Tasks page's own queries (same sources, paged), then its grouping.
    async function loadTasks() {
      const byKind = {};
      for (const s of M.LOGIN_MISSING_SOURCES) {
        const all = [];
        for (let from = 0; ; from += 1000) {
          let q = sb.from(s.table).select(s.select).eq("company_id", CID).is("archived_at", null);
          if (s.kind === "utility") q = q.not("is_final_bill", "is", true);
          const { data, error } = await q.order("id").range(from, from + 999);
          if (error) throw new Error(s.table + ": " + error.message);
          all.push(...data);
          if (data.length < 1000) break;
        }
        byKind[s.kind] = all.filter(r => String(r.property || "").startsWith(tag));
      }
      return M.buildLoginMissingTasks(byKind);
    }
    const t1 = await loadTasks();
    const g1 = groupByProperty(t1);
    const names = (addr) => (g1.get(addr) || []).map(t => t.title).sort();
    assert("one card per property", g1.size === 2, [...g1.keys()].join(" | "));
    assert("property 1 card: utility + insurance + HOA (tenant-paid water skipped)",
      JSON.stringify(names(P1)) === JSON.stringify(["QA Electric — login missing (Utility)", "QA HOA — login missing (HOA)", "QA Insurer — login missing (Insurance)"]), JSON.stringify(names(P1)));
    assert("property 2 card: the loan", JSON.stringify(names(P2)) === JSON.stringify(["QA Bank — login missing (Loan)"]));
    assert("links carry the record id", t1.find(t => t.recordType === "loan").linkAction.editRecordId === loan.data.id);

    // Add a login (ciphertext shape, as the app writes it) -> the to-do goes.
    const up = await sb.from("property_insurance").update({ username_encrypted: "qa-cipher-u", password_encrypted: "qa-cipher-p", encryption_iv: "qa-iv" }).eq("id", pol.data.id).eq("company_id", CID);
    assert("adding a login to the policy saves", !up.error, up.error && up.error.message);
    const t2 = await loadTasks();
    assert("the policy's to-do is gone, the others remain", !t2.some(t => t.recordType === "insurance") && t2.length === t1.length - 1);
    const arch = await sb.from("hoa_payments").update({ archived_at: new Date().toISOString() }).eq("id", hoa.data.id).eq("company_id", CID);
    const t3 = await loadTasks();
    assert("an archived record drops out", !arch.error && !t3.some(t => t.recordType === "hoa"));
  } catch (e) {
    assert("live run completed", false, e.message);
  } finally {
    const left = await cleanup();
    assert("cleanup: zero QA-LOGIN rows left", Object.values(left).every(c => c === 0), JSON.stringify(left));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
