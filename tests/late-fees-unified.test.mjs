// Late fees: three paths, one rule, one reference, the tenant's own AR.
//
// The Late Fees page, the tenant "Late Fee" button and the nightly SQL job
// (batch_post_late_fees) each used a different reference, and each duplicate
// check looked only for its own -- so running two of them in one month
// charged the tenant twice. Two of the three also debited the SHARED 1100
// receivable and bumped tenants.balance by hand.
//
// Part 1 tests the pure rule (src/utils/lateFeeRules.js).
// Part 2 holds each of the three paths to it statically.
// Part 3 holds the SQL twin (migration 20260928050000) to the same rule.
// Part 4 runs the real check (lateFeeAlreadyPostedWith) read-only against
//        the TEST project, and compares it with the SQL function when that
//        migration has been applied there.
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const src = (f) => fs.readFileSync(path.join(root, "src", f), "utf8");
const MIG = "supabase/migrations/20260928050000_late_fees_one_rule_tenant_ar.sql";
const mig = fs.readFileSync(path.join(root, MIG), "utf8");
// batch_post_late_fees was re-created (same body, deterministic ORDER BYs and
// a tidy-scale percent fee) by the parity migration; it is the live definition.
const MIG_BATCH = "supabase/migrations/20260928080000_late_fee_parity.sql";
const migBatch = fs.readFileSync(path.join(root, MIG_BATCH), "utf8");
// _late_fee_tenant_ar was re-created with a non-truncating lpad (codes past
// 1100-999); that migration holds the live definition.
const MIG_AR = "supabase/migrations/20260928160000_bank_undo_qa_fixes.sql";
const migAr = fs.readFileSync(path.join(root, MIG_AR), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}

// lateFeeRules.js has no imports, so it loads as-is.
const R = await import("data:text/javascript," + encodeURIComponent(src("utils/lateFeeRules.js")));
const { lateFeeAlreadyPostedWith } = R;
assert("lateFeeRules.js imports nothing", !/^\s*import\s/m.test(src("utils/lateFeeRules.js")));

// ─── 1. PURE RULE ─────────────────────────────────────────────────────────
console.log("\n🧮 REFERENCE");
assert("canonical reference is LATEFEE-<tid>-YYYYMM", R.lateFeeReference(41, "2026-09") === "LATEFEE-41-202609");
assert("string tenant id works the same", R.lateFeeReference("41", "2026-09") === "LATEFEE-41-202609");
assert("no tenant id -> null (never LATEFEE-undefined-...)",
  R.lateFeeReference(null, "2026-09") === null && R.lateFeeReference(undefined, "2026-09") === null && R.lateFeeReference("", "2026-09") === null);
assert("bad month -> null", R.lateFeeReference(41, "2026-9") === null && R.lateFeeReference(41, "202609") === null && R.lateFeeReference(41, null) === null);
assert("all three historical forms are recognised",
  JSON.stringify(R.lateFeeReferences(41, "2026-09")) === JSON.stringify(["LATEFEE-41-202609", "LATEFEE-41-2026-09", "LATE-41-202609"]));
assert("lateFeeMonth(Date) uses the local calendar", R.lateFeeMonth(new Date(2026, 0, 31, 23, 59)) === "2026-01");
assert("lateFeeMonth('YYYY-MM-DD')", R.lateFeeMonth("2026-12-05") === "2026-12");
assert("lateFeeMonth(garbage) -> null", R.lateFeeMonth("Sep 2026") === null && R.lateFeeMonth(undefined) === null);
const fb = R.lateFeeMonthBounds("2028-02");
assert("month bounds handle leap February", fb.start === "2028-02-01" && fb.end === "2028-02-29");
assert("income account = code 4010 or name 'Late Fee Income'",
  R.isLateFeeIncomeAccount({ code: "4010" }) && R.isLateFeeIncomeAccount({ name: "Late Fee Income" }) &&
  !R.isLateFeeIncomeAccount({ code: "4000", name: "Rental Income" }) && !R.isLateFeeIncomeAccount(null));

console.log("\n🧮 ONE FEE PER TENANT PER MONTH");
const AR = "ar-41", AR_OTHER = "ar-99", INC = "inc", SHARED = "ar-1100", RENT = "rent";
const base = { tenantId: 41, month: "2026-09", tenantArIds: [AR], incomeIds: [INC] };
const has = (entries) => R.lateFeeAlreadyPostedInMonth({ ...base, entries });
const je = (o) => ({ reference: "", date: "2026-09-15", status: "posted", lines: [], ...o });
const fee = (ar, amt = 50) => [{ account_id: ar, debit: amt, credit: 0 }, { account_id: INC, debit: 0, credit: amt }];

assert("nothing on the books -> no fee yet", !has([]));
assert("canonical LATEFEE-41-202609 blocks", has([je({ reference: "LATEFEE-41-202609" })]));
assert("nightly job's old LATEFEE-41-2026-09 blocks", has([je({ reference: "LATEFEE-41-2026-09" })]));
assert("Late Fees page's old LATE-41-202609 blocks (even on the shared 1100)",
  has([je({ reference: "LATE-41-202609", lines: fee(SHARED) })]));
assert("hand-entered DR tenant AR / CR late-fee income, blank reference, blocks", has([je({ lines: fee(AR) })]));
assert("a draft counts (only voided is ignored)", has([je({ reference: "LATEFEE-41-202609", status: "draft" })]));
assert("a null status counts", has([je({ reference: "LATEFEE-41-202609", status: null })]));
assert("VOIDED canonical reference does NOT block", !has([je({ reference: "LATEFEE-41-202609", status: "voided" })]));
assert("VOIDED hand entry does NOT block", !has([je({ lines: fee(AR), status: "voided" })]));
assert("a fee dated in another month does NOT block",
  !has([je({ reference: "LATEFEE-41-202608", date: "2026-08-31" }), je({ lines: fee(AR), date: "2026-10-01" })]));
assert("month edges are inside: the 1st and the 30th",
  has([je({ lines: fee(AR), date: "2026-09-01" })]) && has([je({ lines: fee(AR), date: "2026-09-30" })]));
assert("timestamps are compared by date", has([je({ lines: fee(AR), date: "2026-09-30T23:00:00Z" })]));
assert("another tenant's reference does NOT block (41 vs 411)",
  !has([je({ reference: "LATEFEE-411-202609" }), je({ reference: "LATE-4-202609" })]));
assert("another tenant's AR / late-fee income does NOT block", !has([je({ lines: fee(AR_OTHER) })]));
assert("shared 1100 / late-fee income with no reference does NOT block (not this tenant's)", !has([je({ lines: fee(SHARED) })]));
assert("rent charge on the tenant's AR does NOT block",
  !has([je({ reference: "RECUR-x-2026-09", lines: [{ account_id: AR, debit: 2000, credit: 0 }, { account_id: RENT, debit: 0, credit: 2000 }] })]));
assert("a reversal (CR tenant AR / DR late-fee income) does NOT count as a fee",
  !has([je({ lines: [{ account_id: AR, debit: 0, credit: 50 }, { account_id: INC, debit: 50, credit: 0 }] })]));
assert("zero-amount lines do not count", !has([je({ lines: fee(AR, 0) })]));
assert("no tenant id -> never 'already posted' by accident",
  !R.lateFeeAlreadyPostedInMonth({ ...base, tenantId: null, entries: [je({ lines: fee(AR) })] }));
assert("ids compare as strings (uuid vs string)",
  R.lateFeeAlreadyPostedInMonth({ ...base, tenantArIds: ["ABC"], incomeIds: ["DEF"], entries: [je({ lines: [{ account_id: "ABC", debit: 5 }, { account_id: "DEF", credit: 5 }] })] }));

// ─── 2. THE THREE PATHS ───────────────────────────────────────────────────
console.log("\n🔗 PATHS 1 + 2 (app) USE THE ONE ROUTINE");
const lf = src("components/LateFees.js");
const tn = src("components/Tenants.js");
const lib = src("utils/lateFees.js");
const fnBody = (text, sig) => {
  const i = text.indexOf(sig);
  if (i < 0) return "";
  const next = text.slice(i + sig.length).search(/\n  (async )?function \w+\(/);
  return next < 0 ? text.slice(i) : text.slice(i, i + sig.length + next);
};
const p1 = fnBody(lf, "async function applyLateFee(");
// The tenant button's logic lives in utils/lateFeeApply.js since 2026-10-02,
// shared with the Accounting ledger button; Tenants.js only calls it.
const ap = src("utils/lateFeeApply.js");
const p2 = fnBody(ap, "export async function applyLateFee(");
assert("path 1 (Late Fees page) found", p1.length > 200);
assert("path 2 (tenant Late Fee button) found", p2.length > 200);
for (const [name, body] of [["path 1 LateFees.applyLateFee", p1], ["path 2 Tenants.applyLateFeeForTenant", p2]]) {
  assert(`${name} posts through postTenantLateFee`, /postTenantLateFee\(/.test(body));
  assert(`${name} does not post a JE itself`, !/atomicPostJEAndLedger\(|autoPostJournalEntry\(/.test(body));
  assert(`${name} builds no reference of its own (no "LATE-" / "LATEFEE-" literal)`, !/["'`]LATE(FEE)?-/.test(body));
  assert(`${name} has no shared-1100 AR leg`, !/["']1100["']/.test(body) && !/resolveAccountId\(/.test(body));
  assert(`${name} passes no balanceUpdate / manual balance bump`, !/balanceUpdate\s*:|update_tenant_balance|\.update\(\{\s*balance/.test(body));
  assert(`${name} does not use the old ledger_entries duplicate check`, !/ledger_entries/.test(body));
}
assert("path 2 checks the shared rule before its confirm dialog", /lateFeeAlreadyPosted\(/.test(p2) && p2.indexOf("lateFeeAlreadyPosted(") < p2.indexOf("showConfirm("));
assert("path 1 finds the tenant by id, not by name alone", /String\(t\.id\) === String\(payment\.tenant_id\)/.test(p1));
assert("imports: LateFees.js from utils/lateFees", /import \{[^}]*postTenantLateFee[^}]*\} from "\.\.\/utils\/lateFees"/.test(lf));
assert("imports: lateFeeApply.js from utils/lateFees; Tenants.js and Accounting.js call it", /import \{[^}]*postTenantLateFee[^}]*lateFeeAlreadyPosted[^}]*\} from "\.\/lateFees"/.test(ap) && /applyLateFee\(\{ companyId, tenant: t, companySettings/.test(tn) && /applyLateFee\(\{ companyId, tenant, companySettings/.test(src("components/Accounting.js")));

console.log("\n🔗 THE ROUTINE (utils/lateFees.js)");
const post = fnBody(lib, "export async function postTenantLateFee(");
assert("postTenantLateFee found", post.length > 200);
assert("uses the canonical reference builder", /lateFeeReference\(tenant\.id, month\)/.test(post) && /reference,/.test(post));
assert("checks the shared rule before posting", post.indexOf("lateFeeAlreadyPosted(") > 0 && post.indexOf("lateFeeAlreadyPosted(") < post.indexOf("atomicPostJEAndLedger("));
assert("refuses when the check fails (fail closed)", /dup\.error\) return \{ status: "check-failed"/.test(post));
assert("AR leg is the tenant's own account (resolveTenantLateFeeAR)", /resolveTenantLateFeeAR\(companyId, tenant\)/.test(post) && /account_id: ar\.id/.test(post));
assert("no shared-1100 anywhere in the routine", !/["']1100["']/.test(lib));
assert("balanceUpdate is null (the trigger owns tenants.balance)", /balanceUpdate: null/.test(post) && !/balanceUpdate: \{/.test(lib));
const resolveAr = fnBody(lib, "export async function resolveTenantLateFeeAR(");
assert("tenant AR comes from getOrCreateTenantAR", /getOrCreateTenantAR\(companyId, tenant\.name, tenant\.id\)/.test(resolveAr));
assert("…and getOrCreateTenantAR's shared-1100 fallback is refused (tenant_id must match)",
  /String\(data\.tenant_id\) !== String\(tenant\.id\)\) return null/.test(resolveAr) && !/\|\|\s*await resolveAccountId/.test(resolveAr));
assert("no remaining LATE-<...> reference builder anywhere in src",
  !["components/LateFees.js", "components/Tenants.js", "utils/lateFees.js", "utils/accounting.js"].some(f => /["'`]LATE-["'`]\s*\+/.test(src(f))));

// ─── 3. PATH 3: THE NIGHTLY SQL JOB ───────────────────────────────────────
console.log("\n🗄️  PATH 3 (batch_post_late_fees, " + path.basename(MIG) + ")");
const migDir = path.join(root, "supabase/migrations");
const latest = (fn) => {
  let found = null;
  const re = new RegExp("CREATE OR REPLACE FUNCTION\\s+(public\\.)?" + fn + "\\(");
  for (const f of fs.readdirSync(migDir).filter(f => f.endsWith(".sql")).sort()) {
    const t = fs.readFileSync(path.join(migDir, f), "utf8");
    if (re.test(t)) found = f;
  }
  return found;
};
assert("the parity migration is the latest definition of batch_post_late_fees", latest("batch_post_late_fees") === path.basename(MIG_BATCH), latest("batch_post_late_fees"));
assert("…050000 is still the latest late_fee_already_posted, 160000 the latest _late_fee_tenant_ar",
  latest("late_fee_already_posted") === path.basename(MIG) && latest("_late_fee_tenant_ar") === path.basename(MIG_AR), latest("_late_fee_tenant_ar"));
const sqlFn = (name, text = mig) => {
  const i = text.indexOf("CREATE OR REPLACE FUNCTION public." + name + "(");
  return i < 0 ? "" : text.slice(i, text.indexOf("$function$;", i));
};
const batch = (() => {
  const i = migBatch.indexOf("CREATE OR REPLACE FUNCTION public.batch_post_late_fees(");
  return i < 0 ? "" : migBatch.slice(i, migBatch.indexOf("$function$;", i));
})();
const dupSql = sqlFn("late_fee_already_posted");
const arSql = sqlFn("_late_fee_tenant_ar", migAr);
const code = (s) => s.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");  // strip comments
{
  // 160000 changed only the lpad width: everything else is 050000's body.
  const norm = (s) => code(s).replace(/lpad\(v_seq::text, .*?, '0'\)/, "LPAD").replace(/\s+/g, " ").trim();
  assert("160000's _late_fee_tenant_ar is 050000's body except the lpad width",
    norm(arSql) === norm(sqlFn("_late_fee_tenant_ar")) && /REVOKE ALL ON FUNCTION public\._late_fee_tenant_ar\(text, bigint, text, text\) FROM PUBLIC, anon, authenticated;/.test(migAr)
    && /GRANT EXECUTE ON FUNCTION public\._late_fee_tenant_ar\(text, bigint, text, text\) TO service_role;/.test(migAr));
}
assert("uses next_je_number", /next_je_number\(p_company_id\)/.test(batch));
assert("does not use next_journal_number", !/next_journal_number/.test(code(batch)));
assert("retries only a JE-number collision", /GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME/.test(batch) && /v_constraint <> 'unique_je_number_per_company' THEN RAISE/.test(batch));
assert("a reference collision (backstop index) skips the tenant, not retries", /v_constraint = 'idx_je_company_reference_unique' THEN v_je_id := NULL; EXIT/.test(batch));
assert("duplicate check is the shared function", /IF public\.late_fee_already_posted\(p_company_id, v_t\.id, v_month\) THEN/.test(batch));
assert("new reference is LATEFEE-<tid>-YYYYMM", /v_ref := 'LATEFEE-' \|\| v_t\.id::text \|\| '-' \|\| replace\(v_month, '-', ''\)/.test(batch));
assert("no manual tenants.balance increment", !/UPDATE\s+tenants\s+SET\s+balance/i.test(code(batch)) && !/update_tenant_balance/.test(code(batch)));
assert("AR leg is the tenant's own account, never the shared 1100",
  /v_ar_id := public\._late_fee_tenant_ar\(/.test(batch) && !/name = 'Accounts Receivable'/.test(code(batch)) && !/code = '1100'/.test(code(batch)));
assert("a tenant with no AR account is skipped and reported", /skipped_no_ar_account/.test(batch) && /IF v_ar_id IS NULL THEN/.test(batch));
assert("who: active/current/notice, balance > 0, not archived (same as the app)",
  /lease_status IN \('active','current','notice'\) AND coalesce\(balance,0\) > 0/.test(batch) && /archived_at IS NULL/.test(batch));
assert("how much: flat rounded to cents, percent = round(round(rent * pct) / 100, 2)", /v_fee := round\(v_amount, 2\);/.test(batch) && /v_fee := round\(round\(v_t\.rent \* v_amount\) \/ 100, 2\);/.test(batch));
assert("disabled rules ignored; an active rule is the on/off switch for the job", /coalesce\(is_active, true\)/.test(batch) && /no late fee rule configured/.test(batch));

console.log("\n🗄️  SQL RULE == JS RULE");
for (const form of ["'LATEFEE-' || p_tenant_id::text || '-' || replace(p_month, '-', '')",
                    "'LATEFEE-' || p_tenant_id::text || '-' || p_month",
                    "'LATE-'    || p_tenant_id::text || '-' || replace(p_month, '-', '')"]) {
  assert("SQL recognises " + form.replace(/\s+/g, " "), dupSql.includes(form));
}
assert("SQL ignores only voided entries", (dupSql.match(/je\.status IS DISTINCT FROM 'voided'/g) || []).length === 2);
assert("SQL matches the month as [1st, 1st of next month)", (dupSql.match(/je\.date >= m\.s AND je\.date < m\.e/g) || []).length === 2);
assert("SQL (b): debit on an account whose tenant_id is the tenant", /ar\.tenant_id = p_tenant_id/.test(dupSql) && /coalesce\(dl\.debit, 0\) > 0/.test(dupSql));
assert("SQL (b): credit on code 4010 or 'Late Fee Income', same entry",
  /inc\.code = '4010' OR inc\.name = 'Late Fee Income'/.test(dupSql) && /coalesce\(cl\.credit, 0\) > 0/.test(dupSql) && /cl\.journal_entry_id = je\.id/.test(dupSql));
assert("JS income constants match SQL", R.LATE_FEE_INCOME_CODE === "4010" && R.LATE_FEE_INCOME_NAME === "Late Fee Income");

console.log("\n🗄️  TENANT AR CREATION MIRRORS getOrCreateTenantAR");
assert("looks up by tenant_id first (Asset)", /type = 'Asset' AND tenant_id = p_tenant_id/.test(arSql));
assert("legacy 'AR - <name>' adoption only when unique and unlinked", /name = 'AR - ' \|\| p_tenant_name/.test(arSql) && /tenant_id IS NULL/.test(arSql));
assert("creates 1100-NNN (at least 3 digits, never truncated past 999 -- like padStart) named 'AR - <name> (<street>)' under 1100",
  /'1100-' \|\| lpad\(v_seq::text, greatest\(3, length\(v_seq::text\)\), '0'\)/.test(arSql) && !/lpad\(v_seq::text, 3, '0'\)/.test(code(arSql)) && /split_part\(coalesce\(p_property, ''\), ',', 1\)/.test(arSql) && /parent_id, tenant_id/.test(arSql));
assert("old_text_id = company-code, as the app writes it", /p_company_id \|\| '-' \|\| v_code/.test(arSql));
const acct = src("utils/accounting.js");
assert("…and the app still names them that way", /"AR - " \+ tenantName \+ " \(" \+ shortProp \+ "\)"/.test(acct) && /padStart\(3, "0"\)/.test(acct) && /companyId \+ "-" \+ newCode/.test(acct));

console.log("\n🔒 PRIVILEGES");
for (const [sig, extra] of [["public.batch_post_late_fees(text)", "authenticated"], ["public._late_fee_tenant_ar(text, bigint, text, text)", "authenticated"], ["public.late_fee_already_posted(text, bigint, text)", null]]) {
  const revoke = new RegExp("REVOKE ALL ON FUNCTION " + sig.replace(/[().]/g, "\\$&") + " FROM PUBLIC, anon" + (extra ? ", " + extra : "") + ";");
  assert("REVOKE ... FROM PUBLIC, anon" + (extra ? ", " + extra : "") + " on " + sig, revoke.test(mig));
  assert("service_role keeps EXECUTE on " + sig, new RegExp("GRANT EXECUTE ON FUNCTION " + sig.replace(/[().]/g, "\\$&") + " TO [^;]*service_role").test(mig));
}
assert("SECURITY DEFINER only where it was already (batch job)", (mig.match(/SECURITY DEFINER/g) || []).length === 1);
assert("apply_late_fee_atomic (dead, manual balance bump) is dropped", /DROP FUNCTION IF EXISTS public\.apply_late_fee_atomic\(/.test(mig));
assert("…and nothing in src/ or api/ calls it",
  !fs.readdirSync(path.join(root, "src/components")).concat(fs.readdirSync(path.join(root, "src/utils")))
    .some(f => /apply_late_fee_atomic/.test(fs.existsSync(path.join(root, "src/components", f)) ? fs.readFileSync(path.join(root, "src/components", f), "utf8") : fs.readFileSync(path.join(root, "src/utils", f), "utf8")))
  && !fs.readdirSync(path.join(root, "api")).some(f => f.endsWith(".js") && /apply_late_fee_atomic/.test(fs.readFileSync(path.join(root, "api", f), "utf8"))));

// ─── 4. LIVE (read-only, TEST project) ────────────────────────────────────
console.log("\n🌐 REAL CHECK AGAINST THE TEST DB (read-only)");
try {
  require("./sandbox-env");
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Every query shape the check uses is accepted by PostgREST.
  const { data: inc, error: incErr } = await sb.from("acct_accounts").select("id, code, name")
    .or(`code.eq.4010,name.eq."Late Fee Income"`).limit(5);
  assert("income-account .or() filter is accepted", !incErr && (inc || []).length > 0, incErr?.message);

  // A tenant with a known late fee, in any of the recognised forms.
  const { data: known } = await sb.from("acct_journal_entries").select("company_id, reference, date")
    .or("reference.like.LATEFEE-*,reference.like.LATE-*").neq("status", "voided").limit(20);
  const probe = (known || []).map(k => ({ ...k, m: /^LATE(?:FEE)?-(\d+)-/.exec(k.reference) })).find(k => k.m);
  if (!probe) {
    assert("found a late fee on the test DB to probe with", false, "none found");
  } else {
    const tid = Number(probe.m[1]); const month = String(probe.date).slice(0, 7);
    const hit = await lateFeeAlreadyPostedWith(sb, probe.company_id, tid, month);
    assert(`check sees ${probe.reference} (tenant ${tid}, ${month})`, !hit.error && hit.already === true, JSON.stringify(hit));
    const miss = await lateFeeAlreadyPostedWith(sb, probe.company_id, tid, "1990-01");
    assert("…and nothing for the same tenant in a month with no fee", !miss.error && miss.already === false, JSON.stringify(miss));

    // Parity with the SQL twin, once the migration is on the test DB.
    const { data: sqlHit, error: rpcErr } = await sb.rpc("late_fee_already_posted", { p_company_id: probe.company_id, p_tenant_id: tid, p_month: month });
    if (rpcErr && /Could not find the function|does not exist/i.test(rpcErr.message)) {
      console.log("  ⏭️  late_fee_already_posted not on the test DB yet (migration not applied) — SQL parity skipped");
    } else {
      assert("SQL late_fee_already_posted agrees (fee month)", !rpcErr && sqlHit === hit.already, rpcErr?.message || String(sqlHit));
      const { data: sqlMiss } = await sb.rpc("late_fee_already_posted", { p_company_id: probe.company_id, p_tenant_id: tid, p_month: "1990-01" });
      assert("SQL late_fee_already_posted agrees (empty month)", sqlMiss === miss.already, String(sqlMiss));
    }
  }
  const bad = await lateFeeAlreadyPostedWith(sb, "", 1, "2026-09");
  assert("missing company fails closed", bad.already === true && !!bad.error);
} catch (e) {
  assert("live check ran", false, e.message);
}


// ── Same who / when / how much in all three paths ────────────────────────
{
  console.log("\n— same who, when and how much everywhere —");
  const t = { lease_status: "active", balance: 500, rent: 2000 };
  assert("'fixed' is a dollar fee (was charged as 50% of rent)", R.normalizeLateFeeType("fixed") === "flat" && R.computeLateFeeAmount(R.resolveLateFeeTerms({ tenant: t, rule: { fee_type: "fixed", fee_amount: 50, grace_days: 5 } }), 2000) === 50);
  assert("'percentage' is a percent of rent", R.computeLateFeeAmount(R.resolveLateFeeTerms({ tenant: t, rule: { fee_type: "percentage", fee_amount: 5, grace_days: 0 } }), 2000) === 100);
  assert("an unknown fee type is refused, not guessed", !!R.resolveLateFeeTerms({ tenant: t, rule: { fee_type: "weekly", fee_amount: 5 } }).error);
  assert("the tenant's own setting beats the rule", R.resolveLateFeeTerms({ tenant: { ...t, late_fee_amount: 25, late_fee_type: "flat" }, rule: { fee_type: "flat", fee_amount: 50, grace_days: 3 } }).amount === 25);
  assert("…and still uses the rule's grace days", R.resolveLateFeeTerms({ tenant: { ...t, late_fee_amount: 25 }, rule: { fee_type: "flat", fee_amount: 50, grace_days: 3 } }).graceDays === 3);
  assert("no setting and no rule -> refused", !!R.resolveLateFeeTerms({ tenant: t, rule: null }).error);
  assert("percent with no rent -> no fee", R.computeLateFeeAmount({ type: "percent", amount: 5 }, 0) === null);
  const e = (o) => R.lateFeeEligibility({ tenant: { ...t, ...(o.t || {}) }, today: o.today, dueDay: o.dueDay, graceDays: o.grace });
  assert("on notice is charged", e({ t: { lease_status: "notice" }, today: "2026-10-10", dueDay: 1, grace: 5 }).ok);
  assert("archived is not charged", !e({ t: { archived_at: "2026-10-01" }, today: "2026-10-10", dueDay: 1, grace: 5 }).ok);
  assert("moved out ('past') is not charged", !e({ t: { lease_status: "past" }, today: "2026-10-10", dueDay: 1, grace: 5 }).ok);
  assert("owes nothing -> not charged", !e({ t: { balance: 0 }, today: "2026-10-10", dueDay: 1, grace: 5 }).ok);
  assert("grace counts from the DUE DAY, not the 1st (due 10th, grace 5, on the 14th = not yet)", !e({ today: "2026-10-14", dueDay: 10, grace: 5 }).ok);
  assert("…and charged on the 16th", e({ today: "2026-10-16", dueDay: 10, grace: 5 }).ok);
  assert("last grace day is still grace", !e({ today: "2026-10-06", dueDay: 1, grace: 5 }).ok && e({ today: "2026-10-07", dueDay: 1, grace: 5 }).ok);
  assert("due day 31 clamps to Feb 28", R.lateFeeDueDate("2026-02-10", 31) === "2026-02-28");
  assert("due day: lease first, then rent schedule, then the 1st", R.lateFeeDueDay({ leases: [{ payment_due_day: 5 }], schedules: [{ day_of_month: 9 }] }) === 5 && R.lateFeeDueDay({ leases: [], schedules: [{ day_of_month: 9 }] }) === 9 && R.lateFeeDueDay({}) === 1);
  assert("New York day, not UTC (Oct 1 02:00 UTC is Sep 30 in NY)", R.lateFeeBusinessDate(new Date("2026-10-01T02:00:00Z")) === "2026-09-30");

  const lf = src("components/LateFees.js"), tn = src("components/Tenants.js");
  assert("Late Fees page lists active AND on-notice tenants", /in\("lease_status", LIVE_TENANCY\)/.test(lf));
  assert("Late Fees page uses the shared terms + eligibility", /resolveLateFeeTerms\(/.test(lf) && /lateFeeEligibility\(/.test(lf) && /computeLateFeeAmount\(/.test(lf) && /lateFeeBusinessDate\(\)/.test(lf));
  assert("Late Fees page no longer tests fee_type === 'flat' by hand", !/rule\.fee_type === "flat"/.test(lf));
  assert("Late Fees page saves the canonical fee type", /fee_type: normalizeLateFeeType\(form\.fee_type\)/.test(lf));
  assert("tenant button uses the shared terms + eligibility with the company rule, then Settings", /resolveLateFeeTerms\(\{ tenant: t, rule, settings: companySettings \}\)/.test(ap) && /lateFeeEligibility\(/.test(ap) && /lateFeeBusinessDate\(\)/.test(ap));
  // Sahil, 2026-10-02: no automatic late fees; the button charges 5% of rent,
  // or of the tenant's own portion on a voucher tenancy.
  assert("with no rule, Settings' 5% applies", (() => { const r = R.resolveLateFeeTerms({ tenant: { rent: 1800 }, rule: null, settings: { late_fee_amount: 5, late_fee_type: "percent", late_fee_grace_days: 5 } }); return r.type === "percent" && r.amount === 5 && r.graceDays === 5 && r.source === "settings"; })());
  assert("a rule still beats Settings; the tenant's own setting beats both", R.resolveLateFeeTerms({ tenant: {}, rule: { fee_type: "flat", fee_amount: 30, grace_days: 3 }, settings: { late_fee_amount: 5, late_fee_type: "percent" } }).source === "rule" && R.resolveLateFeeTerms({ tenant: { late_fee_amount: 25 }, rule: null, settings: { late_fee_amount: 5, late_fee_type: "percent" } }).source === "tenant");
  assert("nothing anywhere: refused, and says so", /Settings has no late fee/.test(R.resolveLateFeeTerms({ tenant: {}, rule: null, settings: { late_fee_amount: 0 } }).error || "") && /Settings has no late fee/.test(R.resolveLateFeeTerms({ tenant: {}, rule: null }).error || ""));
  assert("5% of $1,800 rent is $90.00", R.computeLateFeeAmount({ type: "percent", amount: 5 }, R.lateFeeBase({ rent: 1800 })) === 90);
  assert("a voucher tenant is charged on their own portion, not the whole rent", R.lateFeeBase({ rent: 2000, is_voucher: true, tenant_portion: 406 }) === 406 && R.computeLateFeeAmount({ type: "percent", amount: 5 }, R.lateFeeBase({ rent: 2000, is_voucher: true, tenant_portion: 406 })) === 20.3);
  assert("a voucher tenant with no portion recorded falls back to the rent, and a non-voucher tenant's portion is ignored", R.lateFeeBase({ rent: 2000, is_voucher: true, tenant_portion: 0 }) === 2000 && R.lateFeeBase({ rent: 2000, is_voucher: false, tenant_portion: 406 }) === 2000 && R.lateFeeBase(null) === 0);
  assert("the button and the Late Fees page charge on that base", /computeLateFeeAmount\(terms, base\)/.test(ap) && /const base = lateFeeBase\(t\)/.test(ap) && /computeLateFeeAmount\(terms, lateFeeBase\(tenant\)\)/.test(lf));
  assert("a new lease no longer carries a forced $50; blank means the company default", !/late_fee_amount \|\| 50/.test(src("components/Leases.js")) && /late_fee_amount: form\.late_fee_amount === "" \? null/.test(src("components/Leases.js")) && !/auto-apply/.test(src("components/Leases.js")));
  assert("tenant button no longer computes percent/flat by hand", !/late_fee_type === "percent"/.test(tn) && !/late_fee_type === "percent"/.test(ap));
  assert("the Accounting ledger of a tenant's receivable offers the same button", /ledgerTenantId != null && onApplyLateFee/.test(src("components/Accounting.js")) && /tenant_id \?\? null/.test(src("components/Accounting.js")));
  assert("tenant button shows whenever the tenant owes money (rule OR own setting)", /lateFeeAction=\{safeNum\(selectedTenant\?\.balance\) > 0 && !selectedTenant\?\.archived_at/.test(tn));

  const sql = migBatch;  // the live batch_post_late_fees definition
  const job = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.batch_post_late_fees"));
  assert("job: New York date", /now\(\) AT TIME ZONE 'America\/New_York'/.test(job) && !/CURRENT_DATE/.test(job));
  assert("job: charges notice tenants", /lease_status IN \('active','current','notice'\)/.test(job));
  assert("job: 'fixed' = flat, 'percentage' = percent, unknown skipped", /IN \('flat','fixed'\) THEN 'flat'/.test(job) && /IN \('percent','percentage','pct','%'\) THEN 'percent'/.test(job) && /ELSE NULL END/.test(job));
  assert("job: tenant's own setting first", /IF coalesce\(v_t\.late_fee_amount, 0\) > 0 THEN/.test(job));
  assert("job: grace counted from the tenant's due day", /payment_due_day/.test(job) && /day_of_month/.test(job) && /\(v_today - v_due_date\) <= v_grace/.test(job));
  assert("job: no longer stops for everyone on a day-of-month grace check", !/EXTRACT\(DAY FROM v_today\)::int <= coalesce\(v_rule\.grace_days/.test(job));
}

// ── QA gaps (2026-09-28): JS == SQL to the cent and the row ──────────────
{
  console.log("\n— QA gaps: same cent, same row, same account —");
  const fee = (type, amount, rent) => R.computeLateFeeAmount({ type, amount }, rent);
  assert("685 at 5.1% is $34.94, as SQL charges it (float gave $34.93)", fee("percent", 5.1, 685) === 34.94);
  assert("…and from strings too", fee("percent", "5.1", "685") === 34.94);
  assert("flat 1.005 -> 1.01, 2.675 -> 2.68, 10.005 -> 10.01 (half away from zero, like SQL round(x, 2))",
    fee("flat", 1.005) === 1.01 && fee("flat", 2.675) === 2.68 && fee("flat", 10.005) === 10.01);
  assert("12.5% of $1.16 -> $0.15 (exactly 0.145)", fee("percent", 12.5, 1.16) === 0.15);
  assert("unchanged: whole numbers, no rent, bad amount", fee("percent", 7, 1000) === 70 && fee("percent", 5, 0) === null && fee("percent", 5, null) === null && fee("flat", "NaN") === 0 && R.computeLateFeeAmount({ error: "x" }, 1) === null);
  // Brute force against an independent exact-decimal reference (BigInt,
  // written here, not the code under test). SQL numeric is exact, so this
  // is SQL's answer; the migration's brute force proved the new SQL
  // expression equals the old one over 8M (rent, pct) pairs.
  const exactPctCents = (rentCents, pctStr) => {
    const [a, b = ""] = pctStr.split(".");
    const n = BigInt(rentCents) * BigInt(a + b), d = BigInt(10) ** BigInt(2 + b.length);
    let q = n / d; if ((n % d) * BigInt(2) >= d) q += BigInt(1);
    return Number(q);
  };
  let bad = [], n = 0;
  for (let c = 1; c <= 200000; c += 7) for (const p of ["5.1", "7.5", "3.33", "12.5", "0.1234", "2.675", "1.005", "4.99999", "10"]) {
    n++; const js = fee("percent", Number(p), c / 100), ex = exactPctCents(c, p) / 100;
    if (js !== ex && bad.length < 3) bad.push({ rent: c / 100, pct: p, js, exact: ex });
  }
  for (let m = 1; m <= 200000; m++) {
    n++; const js = fee("flat", m / 1000, 0), ex = (Math.floor(m / 10) + (m % 10 >= 5 ? 1 : 0)) / 100;
    if (js !== ex && bad.length < 3) bad.push({ flat: m / 1000, js, exact: ex });
  }
  assert(`computeLateFeeAmount is exact to the cent on ${n.toLocaleString()} inputs`, bad.length === 0, JSON.stringify(bad));
  const rulesSrc = src("utils/lateFeeRules.js");
  assert("no float rounding of the fee left (no Math.round(... * ...))", !/Math\.round\([^)]*\*/.test(rulesSrc.slice(rulesSrc.indexOf("function decimalOf"))));
  assert("no BigInt literals or ** (Babel turns ** into Math.pow, which throws on BigInt)",
    !/\b\d+n\b/.test(rulesSrc.replace(/\/\/.*$/gm, "")) && !/\*\*/.test(rulesSrc.replace(/\/\/.*$/gm, "")));

  console.log("\n  dates");
  assert("lateFeeDueDate: month 13 -> null", R.lateFeeDueDate("2026-13-01", 1) === null);
  assert("lateFeeDueDate: Feb 31 -> null", R.lateFeeDueDate("2026-02-31", 1) === null && R.lateFeeDueDate("2026-00-10", 1) === null && R.lateFeeDueDate("2026-09-00", 1) === null);
  assert("lateFeeDueDate: leap day is real", R.lateFeeDueDate("2028-02-29", 31) === "2028-02-29" && R.lateFeeDueDate("2026-02-29", 1) === null);
  assert("lateFeeBusinessDate(invalid Date) -> null, not a throw", R.lateFeeBusinessDate(new Date("x")) === null);
  assert("lateFeeBusinessDate(non-Date) -> null", R.lateFeeBusinessDate("2026-09-28") === null && R.lateFeeBusinessDate(null) === null);
  assert("lateFeeBusinessDate() still today in NY", /^\d{4}-\d{2}-\d{2}$/.test(R.lateFeeBusinessDate()));
  assert("eligibility refuses an invalid day", !R.lateFeeEligibility({ tenant: { lease_status: "active", balance: 5 }, today: "2026-02-31", dueDay: 1, graceDays: 0 }).ok);

  console.log("\n  who: exact lease_status, like SQL");
  const el = (s) => R.lateFeeEligibility({ tenant: { lease_status: s, balance: 5 }, today: "2026-09-28", dueDay: 1, graceDays: 0 }).ok;
  assert("'active' / 'current' / 'notice' are charged", el("active") && el("current") && el("notice"));
  assert("'Active', ' active ', 'NOTICE' are not (SQL IN (...) is case-sensitive)", !el("Active") && !el(" active ") && !el("NOTICE"));
  assert("the SQL job still uses the exact list", /lease_status IN \('active','current','notice'\)/.test(batch));

  console.log("\n  which row: the job's ORDER BYs everywhere");
  assert("SQL rule: ORDER BY created_at, id", /coalesce\(is_active, true\) ORDER BY created_at, id LIMIT 1/.test(batch));
  assert("SQL lease: ORDER BY start_date DESC NULLS LAST, id", /ORDER BY l\.start_date DESC NULLS LAST, l\.id LIMIT 1/.test(batch));
  assert("SQL schedule fallback: ORDER BY created_at, id (had no ORDER BY)", /ORDER BY r\.created_at, r\.id LIMIT 1/.test(batch));
  const LO = JSON.stringify(R.LATE_FEE_LEASE_ORDER), SO = JSON.stringify(R.LATE_FEE_SCHEDULE_ORDER), RO = JSON.stringify(R.LATE_FEE_RULE_ORDER);
  assert("JS lease order = start_date desc nulls last, id", LO === JSON.stringify([["start_date", { ascending: false, nullsFirst: false }], ["id", { ascending: true }]]));
  assert("JS schedule + rule order = created_at, id", SO === JSON.stringify([["created_at", { ascending: true }], ["id", { ascending: true }]]) && RO === SO);
  const calls = []; const fakeQ = { order(c, o) { calls.push([c, o]); return fakeQ; } };
  R.lateFeeOrdered(fakeQ, R.LATE_FEE_LEASE_ORDER);
  assert("lateFeeOrdered applies each .order() in turn", JSON.stringify(calls) === LO);
  assert("due day takes the FIRST usable row (so order decides)", R.lateFeeDueDay({ leases: [{ payment_due_day: 27 }, { payment_due_day: 5 }] }) === 27);
  const tn2 = src("components/Tenants.js"), lf2 = src("components/LateFees.js");
  const btn = fnBody(src("utils/lateFeeApply.js"), "export async function applyLateFee(");
  assert("tenant button: rules / leases / schedules use the job's order",
    /lateFeeOrdered\(supabase\.from\("late_fee_rules"\)[^\n]*LATE_FEE_RULE_ORDER\)/.test(btn) &&
    /lateFeeOrdered\(supabase\.from\("leases"\)[^\n]*LATE_FEE_LEASE_ORDER\)/.test(btn) &&
    /lateFeeOrdered\(supabase\.from\("recurring_journal_entries"\)[^\n]*LATE_FEE_SCHEDULE_ORDER\)/.test(btn));
  assert("tenant button: only usable due days are fetched (> 0, as in SQL)", /\.gt\("payment_due_day", 0\)/.test(btn) && /\.gt\("day_of_month", 0\)/.test(btn));
  const fetchLF = fnBody(lf2, "async function fetchData(");
  assert("Late Fees page: rules / leases / schedules use the job's order",
    /LATE_FEE_RULE_ORDER/.test(fetchLF) && /LATE_FEE_LEASE_ORDER/.test(fetchLF) && /LATE_FEE_SCHEDULE_ORDER/.test(fetchLF));
  assert("Late Fees page: leases matched by tenant_id only (name fallback removed, same as button + job)",
    !/tenant_name === tn\.name/.test(fetchLF) && /leases\.filter\(l => String\(l\.tenant_id\) === String\(tn\.id\)\)/.test(fetchLF));
  assert("Late Fees page: no date -> nothing listed (lateFeeBusinessDate null is handled)", /if \(!today\) throw/.test(fetchLF));

  console.log("\n  row links = drawer button");
  const rowLinks = tn2.match(/\{safeNum\(t\.balance\) > 0 && [^<\n]*<TextLink.{0,200}?applyLateFeeForTenant/g) || [];
  assert("both row 'Late Fee' links found", rowLinks.length === 2, String(rowLinks.length));
  assert("…shown when balance > 0 and not archived (not only with a tenant-level fee)",
    rowLinks.every(s => /safeNum\(t\.balance\) > 0 && !t\.archived_at && <TextLink/.test(s)) && !/safeNum\(t\.late_fee_amount\) > 0 && <TextLink/.test(tn2));

  console.log("\n  races report 'already charged'");
  const post2 = fnBody(lib, "export async function postTenantLateFee(");
  assert("a failed AR lookup re-checks for the winner's fee before saying no-ar",
    /settledByRace\(\)\) return \{ status: "duplicate"/.test(post2) && post2.indexOf("settledByRace()") < post2.indexOf('return { status: "no-ar" }'));
  assert("a failed journal entry (reference collision) re-checks too",
    /if \(!result\.jeId\) \{\s*if \(await settledByRace\(\)\) return \{ status: "duplicate", reference \};/.test(post2));
  assert("the re-check never turns a failed check into 'posted' (error -> not settled)", /return !again\.error && again\.already;/.test(post2));

  console.log("\n  manual late fee (owner: must always be possible)");
  const add = fnBody(tn2, "async function addLedgerEntry(");
  assert("Add Transaction still offers Late Fee", /<option value="late_fee">Late Fee<\/option>/.test(tn2) && /newCharge\.type === "late_fee"/.test(add));
  assert("manual late fee: existing-fee notice is a confirm the user can click through",
    /lateFeeAlreadyPosted\(companyId, selectedTenant\.id/.test(add) && /Add another late fee anyway\?/.test(add) && /confirmText: "Add anyway"/.test(add));
  assert("…a failed check never blocks the save (only `already` without error asks)", /if \(!lfPrior\.error && lfPrior\.already\)/.test(add));
  assert("…posts to the tenant's own AR first (resolveTenantLateFeeAR), then the usual lookup",
    /if \(newCharge\.type === "late_fee"\) \{\s*const ownAr = await resolveTenantLateFeeAR\(companyId, selectedTenant\);/.test(add) &&
    /if \(!tenantArId\) tenantArId = await getOrCreateTenantAR\(/.test(add));
  assert("…keeps a MANUAL- reference (a second manual fee must not hit the LATEFEE unique index)",
    /reference: "MANUAL-" \+ shortId\(\)/.test(add) && !/lateFeeReference\(/.test(add));
  assert("…credits Late Fee Income 4010 (so the once-a-month rule recognises it)", /account_id: "4010", account_name: "Late Fee Income"/.test(add));
}

// ── resolveTenantLateFeeAR against the TEST project ──────────────────────
// lateFees.js imports the browser client and accounting.js; both are
// replaced here (the client with a TEST service client, getOrCreateTenantAR
// with a stub whose answer each case sets), so the real function runs.
{
  console.log("\n🌐 TENANT AR CHOICE + RACES (TEST project; rows created and removed)");
  require("./sandbox-env");
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const CO = "lf-test-" + Math.random().toString(36).slice(2, 10);
  let stubAR = null;
  globalThis.__lfTest = {
    supabase: sb,
    getOrCreateTenantAR: async () => { globalThis.__lfTest.gocCalls++; return stubAR; },
    gocCalls: 0,
    resolveAccountId: async (code, cid) => ((await sb.from("acct_accounts").select("id").eq("company_id", cid).eq("code", code).maybeSingle()).data || {}).id || null,
    atomicPostJEAndLedger: async ({ companyId, date, description, reference, property, lines }) => {
      const { data, error } = await sb.rpc("post_je_and_ledger", { p_company_id: companyId, p_date: date, p_description: description, p_reference: reference, p_property: property || "", p_status: "posted",
        p_lines: lines.map(l => ({ account_id: l.account_id, account_name: l.account_name, debit: l.debit, credit: l.credit, class_id: null, memo: l.memo || "" })),
        p_ledger_tenant: null, p_ledger_tenant_id: null, p_ledger_property: null, p_ledger_amount: 0, p_ledger_type: null, p_ledger_description: null, p_balance_change: 0 });
      return error ? { jeId: null, error: "Journal entry failed" } : { jeId: data, error: null };
    },
  };
  const rulesUrl = "data:text/javascript," + encodeURIComponent(src("utils/lateFeeRules.js"));
  const libSrc = src("utils/lateFees.js")
    .replace(/import \{ supabase \} from "\.\.\/supabase";/, "const supabase = globalThis.__lfTest.supabase;")
    .replace(/import \{ ([^}]+) \} from "\.\/accounting";/, "const { $1 } = globalThis.__lfTest;")
    .replace(/from "\.\/lateFeeRules";/, `from "${rulesUrl}";`);
  const F = await import("data:text/javascript," + encodeURIComponent(libSrc));
  const cleanup = async () => {
    const { data: jes } = await sb.from("acct_journal_entries").select("id").eq("company_id", CO);
    const ids = (jes || []).map(j => j.id);
    for (let i = 0; i < ids.length; i += 100) await sb.from("acct_journal_lines").delete().in("journal_entry_id", ids.slice(i, i + 100));
    // audit_trail rows are written by triggers on the rows above
    for (const tb of ["acct_journal_entries", "acct_accounts", "tenants", "audit_trail"]) await sb.from(tb).delete().eq("company_id", CO);
    await sb.from("companies").delete().eq("id", CO);
  };
  try {
    const ok = (r, w) => { if (r.error) throw new Error(w + ": " + r.error.message); return r.data; };
    ok(await sb.from("companies").insert([{ id: CO, name: "late fee test (temp)" }]), "company");
    const acct = async (code, name, extra = {}) => ok(await sb.from("acct_accounts").insert([{ company_id: CO, code, name, type: "Asset", is_active: true, old_text_id: CO + "-" + code, ...extra }]).select("*").single(), "acct " + code);
    const parent = await acct("1100", "Accounts Receivable");
    await acct("4010", "Late Fee Income", { type: "Revenue" });
    const ten = async (name) => ok(await sb.from("tenants").insert([{ company_id: CO, name, property: name + " St", lease_status: "active", balance: 0, rent: 1000 }]).select("*").single(), "tenant " + name);
    const a = await ten("LFT Two"), b = await ten("LFT Other"), c = await ten("LFT Foreign"), d = await ten("LFT Race");
    const aOld = await acct("1100-T01", "AR - LFT Two (old)", { is_active: false, tenant_id: a.id });
    const aCur = await acct("1100-T02", "AR - LFT Two", { tenant_id: a.id });
    const bAr = await acct("1100-T03", "AR - LFT Foreign", { tenant_id: b.id });
    const dAr = await acct("1100-T04", "AR - LFT Race", { tenant_id: d.id });

    stubAR = aOld.id;  // even if getOrCreateTenantAR would say otherwise
    const r1 = await F.resolveTenantLateFeeAR(CO, a);
    assert("two linked accounts (inactive + active): the ACTIVE one, as the job picks", r1?.id === aCur.id, JSON.stringify(r1));
    stubAR = bAr.id;
    assert("an account linked to a DIFFERENT tenant is refused", (await F.resolveTenantLateFeeAR(CO, c)) === null);
    stubAR = parent.id;
    assert("the shared 1100 parent is refused", (await F.resolveTenantLateFeeAR(CO, c)) === null);
    const before = globalThis.__lfTest.gocCalls;
    assert("lookupOnly (the race retries) never calls getOrCreateTenantAR, so never creates an account",
      (await F.resolveTenantLateFeeAR(CO, c, { lookupOnly: true })) === null && globalThis.__lfTest.gocCalls === before);
    stubAR = null;
    const t0 = Date.now();
    const noAr = await F.postTenantLateFee({ companyId: CO, tenant: c, amount: 50, date: R.lateFeeBusinessDate(), description: "LFT", ledgerDescription: "LFT" });
    assert("no account anywhere -> 'no-ar' after the retries; getOrCreateTenantAR asked twice (first try + last retry), never more",
      noAr.status === "no-ar" && globalThis.__lfTest.gocCalls === before + 2, JSON.stringify(noAr) + " calls=" + (globalThis.__lfTest.gocCalls - before) + " ms=" + (Date.now() - t0));
    stubAR = bAr.id;
    assert("getOrCreateTenantAR's own linked answer is accepted", (await F.resolveTenantLateFeeAR(CO, b))?.id === bAr.id);
    assert("pickLinkedTenantAR: active first, never another tenant's",
      F.pickLinkedTenantAR([{ id: 1, tenant_id: 9, is_active: false }, { id: 2, tenant_id: 9 }, { id: 3, tenant_id: 8 }], 9)?.id === 2 &&
      F.pickLinkedTenantAR([{ id: 3, tenant_id: 8 }], 9) === null && F.pickLinkedTenantAR([{ id: 1, tenant_id: 9, is_active: false }], 9)?.id === 1);

    // four clicks at once: one fee, three "already charged this month"
    const date = R.lateFeeBusinessDate();
    const res = await Promise.all([1, 2, 3, 4].map(() => F.postTenantLateFee({ companyId: CO, tenant: d, amount: 50, date, description: "LFT", ledgerDescription: "LFT" })));
    const st = res.map(r => r.status).sort().join(",");
    assert("4 racing posts: 1 posted + 3 'duplicate' (not no-ar / journal failure)", st === "duplicate,duplicate,duplicate,posted", st);
    const { data: onBooks } = await sb.from("acct_journal_entries").select("id").eq("company_id", CO).like("reference", "LATEFEE-" + d.id + "-%");
    assert("…and exactly one fee on the books", (onBooks || []).length === 1, String((onBooks || []).length));
    const { data: drLine } = await sb.from("acct_journal_lines").select("account_id, debit").eq("journal_entry_id", onBooks?.[0]?.id).gt("debit", 0);
    assert("…debited to the tenant's own AR", drLine?.[0]?.account_id === dAr.id);
    assert("duplicate reads as 'already on the books'", /already on the books/.test(F.lateFeeFailureReason({ status: "duplicate" })));

    // Codes past 1100-999: lpad('1009', 3) used to cut it to '1100-100',
    // which collided, so this tenant (and every later one) got no account.
    await acct("1100-1008", "AR - LFT Seq (existing)");
    const e = await ten("LFT Seq");
    const r1009 = await sb.rpc("_late_fee_tenant_ar", { p_company_id: CO, p_tenant_id: e.id, p_tenant_name: e.name, p_property: e.property });
    const a1009 = r1009.data ? ok(await sb.from("acct_accounts").select("code, tenant_id").eq("id", r1009.data).single(), "acct 1009") : null;
    assert("seq >= 1000: the next tenant AR is 1100-1009, linked to the tenant", a1009?.code === "1100-1009" && a1009?.tenant_id === e.id, r1009.error?.message || JSON.stringify(a1009));
    const e2 = await ten("LFT Seq Two");
    const r1010 = await sb.rpc("_late_fee_tenant_ar", { p_company_id: CO, p_tenant_id: e2.id, p_tenant_name: e2.name, p_property: e2.property });
    const a1010 = r1010.data ? ok(await sb.from("acct_accounts").select("code").eq("id", r1010.data).single(), "acct 1010") : null;
    assert("…and the one after is 1100-1010 (not NULL)", a1010?.code === "1100-1010", r1010.error?.message || JSON.stringify(a1010));
  } catch (e) {
    assert("tenant AR / race checks ran", false, e.message);
  } finally {
    await cleanup();
    const { count } = await sb.from("acct_accounts").select("id", { count: "exact", head: true }).eq("company_id", CO);
    assert("test rows removed", count === 0, String(count));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
