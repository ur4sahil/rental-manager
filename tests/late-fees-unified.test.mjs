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
const p2 = fnBody(tn, "async function applyLateFeeForTenant(");
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
assert("imports: Tenants.js from utils/lateFees", /import \{[^}]*postTenantLateFee[^}]*lateFeeAlreadyPosted[^}]*\} from "\.\.\/utils\/lateFees"/.test(tn));

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
assert("this migration is the latest definition of batch_post_late_fees", latest("batch_post_late_fees") === path.basename(MIG), latest("batch_post_late_fees"));
const sqlFn = (name) => {
  const i = mig.indexOf("CREATE OR REPLACE FUNCTION public." + name + "(");
  return i < 0 ? "" : mig.slice(i, mig.indexOf("$function$;", i));
};
const batch = sqlFn("batch_post_late_fees");
const dupSql = sqlFn("late_fee_already_posted");
const arSql = sqlFn("_late_fee_tenant_ar");
const code = (s) => s.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");  // strip comments
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
assert("how much: flat rounded to cents, percent = round(rent * pct)/100", /v_fee := round\(v_amount, 2\);/.test(batch) && /v_fee := round\(v_t\.rent \* v_amount\) \/ 100\.0;/.test(batch));
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
assert("creates 1100-NNN (3-digit pad) named 'AR - <name> (<street>)' under 1100",
  /'1100-' \|\| lpad\(v_seq::text, 3, '0'\)/.test(arSql) && /split_part\(coalesce\(p_property, ''\), ',', 1\)/.test(arSql) && /parent_id, tenant_id/.test(arSql));
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
  assert("tenant button uses the shared terms + eligibility with the company rule", /resolveLateFeeTerms\(\{ tenant: t, rule: lfRule \}\)/.test(tn) && /lateFeeEligibility\(/.test(tn) && /lateFeeBusinessDate\(\)/.test(tn));
  assert("tenant button no longer computes percent/flat by hand", !/late_fee_type === "percent"/.test(tn));
  assert("tenant button shows whenever the tenant owes money (rule OR own setting)", /lateFeeAction=\{safeNum\(selectedTenant\?\.balance\) > 0 && !selectedTenant\?\.archived_at/.test(tn));

  const sql = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../supabase/migrations/20260928050000_late_fees_one_rule_tenant_ar.sql"), "utf8");
  const job = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.batch_post_late_fees"));
  assert("job: New York date", /now\(\) AT TIME ZONE 'America\/New_York'/.test(job) && !/CURRENT_DATE/.test(job));
  assert("job: charges notice tenants", /lease_status IN \('active','current','notice'\)/.test(job));
  assert("job: 'fixed' = flat, 'percentage' = percent, unknown skipped", /IN \('flat','fixed'\) THEN 'flat'/.test(job) && /IN \('percent','percentage','pct','%'\) THEN 'percent'/.test(job) && /ELSE NULL END/.test(job));
  assert("job: tenant's own setting first", /IF coalesce\(v_t\.late_fee_amount, 0\) > 0 THEN/.test(job));
  assert("job: grace counted from the tenant's due day", /payment_due_day/.test(job) && /day_of_month/.test(job) && /\(v_today - v_due_date\) <= v_grace/.test(job));
  assert("job: no longer stops for everyone on a day-of-month grace check", !/EXTRACT\(DAY FROM v_today\)::int <= coalesce\(v_rule\.grace_days/.test(job));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
