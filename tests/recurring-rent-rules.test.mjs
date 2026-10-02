// Recurring rent: who is billed, where, and when it stops.
//
// Four faults, all of which put rent on people who no longer owed it or put
// it in the wrong place:
//   1. autoPostRecurringEntries billed any schedule marked active, whatever
//      had happened to the tenant -- archived, evicted, moved out.
//   2. The debit account was captured once when the schedule was made, so a
//      schedule pointing at a stale or a sibling's AR account kept billing it.
//   3. Two schedules for one tenant billed the same AR account twice a month.
//   4. Archive, lease terminate, eviction, property deactivate and bulk
//      "past" left the schedule running; renew / rent increase on the Leases
//      page never changed its amount; a lease created there made no schedule.
//
// Part 1 tests the pure rules (src/utils/recurringRules.js) directly.
// Part 2 holds each call site to the rule statically.
// Part 3 checks, read-only against the TEST project, that the double-bill
// query's embedded filters are ones PostgREST accepts.
import fs from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const src = (f) => fs.readFileSync(path.join(root, "src", f), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}

// recurringRules.js has no imports, so it loads as-is.
const rules = await import("data:text/javascript," + encodeURIComponent(src("utils/recurringRules.js")));
const { isTenantBillable, recurringTenantSkipReason, pickTenantArAccount, monthBounds, arAlreadyBilledInMonth, hasTenantId } = rules;

// ─── 1. PURE RULES ────────────────────────────────────────────────────────
console.log("\n🧮 WHO MAY BE BILLED");
assert("active tenant is billable", isTenantBillable({ lease_status: "active", archived_at: null }));
assert("tenant on notice is billable (still lives there)", isTenantBillable({ lease_status: "notice" }));
assert("status is case/space-insensitive", isTenantBillable({ lease_status: " Active " }));
for (const st of ["past", "inactive", "expired", "review", "", null, "current"]) {
  assert(`lease_status ${JSON.stringify(st)} is NOT billable`, !isTenantBillable({ lease_status: st }));
}
assert("archived active tenant is NOT billable", !isTenantBillable({ lease_status: "active", archived_at: "2026-09-01T00:00:00Z" }));
assert("missing tenant row is NOT billable", !isTenantBillable(null) && !isTenantBillable(undefined));

console.log("\n⛔ SKIP DECISION");
const sched = { id: "s1", tenant_id: 42 };
assert("schedule without tenant_id (mortgage) is never skipped", recurringTenantSkipReason({ id: "m", tenant_id: null }, null) === null);
assert("schedule with tenant_id '' is treated as no tenant", recurringTenantSkipReason({ tenant_id: "" }, null) === null);
assert("tenant_id 0 still counts as a tenant schedule", hasTenantId({ tenant_id: 0 }));
assert("tenant row missing -> skip", recurringTenantSkipReason(sched, undefined) === "tenant-missing");
assert("archived tenant -> skip", recurringTenantSkipReason(sched, { lease_status: "active", archived_at: "x" }) === "tenant-archived");
assert("past tenant -> skip", recurringTenantSkipReason(sched, { lease_status: "past" }) === "tenant-not-active");
assert("active tenant -> post", recurringTenantSkipReason(sched, { lease_status: "active" }) === null);
assert("notice tenant -> post", recurringTenantSkipReason(sched, { lease_status: "notice" }) === null);

console.log("\n🏦 WHICH AR ACCOUNT");
const A = { id: "a", code: "1100-003", tenant_id: 42, is_active: true };
const B = { id: "b", code: "1100-001", tenant_id: 42, is_active: true };
const OFF = { id: "off", code: "1100-000", tenant_id: 42, is_active: false };
const SIB = { id: "sib", code: "1100-002", tenant_id: 43, is_active: true };
assert("no accounts -> null (caller creates one)", pickTenantArAccount([], 42, "x") === null);
assert("only a sibling's account -> null, never the sibling's", pickTenantArAccount([SIB], 42, "sib") === null);
assert("stored account that is the tenant's and active is kept", pickTenantArAccount([A, B], 42, "a").id === "a");
assert("stored account belonging to a SIBLING is replaced by the tenant's own", pickTenantArAccount([A, SIB], 42, "sib").id === "a");
assert("stored account unknown -> tenant's active account with lowest code", pickTenantArAccount([A, B], 42, "zzz").id === "b");
assert("inactive stored account loses to an active one", pickTenantArAccount([OFF, A], 42, "off").id === "a");
assert("only inactive accounts -> the stored one if it is the tenant's", pickTenantArAccount([OFF, { ...OFF, id: "off2", code: "1100-009" }], 42, "off2").id === "off2");
assert("tenant_id compared as string (bigint arrives as number or string)", pickTenantArAccount([{ ...A, tenant_id: "42" }], 42, null).id === "a");
assert("null tenantId -> null", pickTenantArAccount([A], null, "a") === null);

console.log("\n📅 DOUBLE-BILL GUARD");
assert("monthBounds Feb 2028 (leap)", JSON.stringify(monthBounds("2028-02")) === JSON.stringify({ start: "2028-02-01", end: "2028-02-29" }));
assert("monthBounds Sep", monthBounds("2026-09").end === "2026-09-30");
const line = (o) => ({ account_id: "a", debit: 1500, acct_journal_entries: { reference: "RECUR-abcdef12-2026-09", date: "2026-09-01", status: "posted", ...o } });
assert("a RECUR debit on the account in the month blocks a second bill", arAlreadyBilledInMonth([line({})], "a", "2026-09"));
assert("embedded entry as an array is understood too", arAlreadyBilledInMonth([{ ...line({}), acct_journal_entries: [line({}).acct_journal_entries] }], "a", "2026-09"));
assert("last day of the month counts", arAlreadyBilledInMonth([line({ date: "2026-09-30" })], "a", "2026-09"));
assert("previous month does not count", !arAlreadyBilledInMonth([line({ date: "2026-08-31" })], "a", "2026-09"));
assert("next month does not count", !arAlreadyBilledInMonth([line({ date: "2026-10-01" })], "a", "2026-09"));
assert("voided entry does not count", !arAlreadyBilledInMonth([line({ status: "voided" })], "a", "2026-09"));
assert("non-RECUR reference (payment, late fee, first month) does not count", !arAlreadyBilledInMonth([line({ reference: "LATE-123" })], "a", "2026-09"));
assert("a debit on a DIFFERENT account does not count", !arAlreadyBilledInMonth([{ ...line({}), account_id: "b" }], "a", "2026-09"));
assert("a zero debit (credit line) does not count", !arAlreadyBilledInMonth([{ ...line({}), debit: 0 }], "a", "2026-09"));
assert("no lines -> not billed", !arAlreadyBilledInMonth([], "a", "2026-09") && !arAlreadyBilledInMonth(null, "a", "2026-09"));
assert("no account -> not billed", !arAlreadyBilledInMonth([line({})], null, "2026-09"));

// ─── 2. STATIC: every site follows the rule ───────────────────────────────
console.log("\n🔎 CALL SITES");
const acct = src("utils/accounting.js");
const fnStart = acct.indexOf("export async function autoPostRecurringEntries");
const fnBody = acct.slice(fnStart, acct.indexOf("\n// ZIP", fnStart));
assert("autoPostRecurringEntries loads tenants and skips via recurringTenantSkipReason",
  /from\("tenants"\)[\s\S]*archived_at, lease_status/.test(fnBody) && /if \(recurringTenantSkipReason\(entry, entryTenant\)\) continue;/.test(fnBody));
assert("tenant load failure fails CLOSED (posts nothing)", /if \(tErr\)[^\n]*return \{ posted: 0 \}/.test(fnBody));
assert("rent debits the resolved account, not the stored one",
  /account_id: debitAcct\.id/.test(fnBody) && !/account_id: entry\.debit_account_id/.test(fnBody));
assert("a corrected account is written back to the schedule",
  /update\(\{ debit_account_id: debitAcct\.id, debit_account_name: debitAcct\.name \}\)/.test(fnBody));
assert("double-bill check queries RECUR debits on the resolved account in the month",
  /\.eq\("account_id", debitAcct\.id\)\.gt\("debit", 0\)/.test(fnBody) && /like\("acct_journal_entries\.reference", "RECUR-%"\)/.test(fnBody)
  && /arAlreadyBilledInMonth\(billedLines, debitAcct\.id, monthStr\)/.test(fnBody));
assert("double-bill check fails CLOSED on a query error", /if \(billedErr \|\| arAlreadyBilledInMonth/.test(fnBody));
assert("forward-only guard (created_at floor) is still there", /if \(cursor < createdFloor\) cursor = createdFloor;/.test(fnBody));
assert("resolver never retargets to the 1100 parent (verifies tenant_id of what it gets)",
  /pickTenantArAccount\(created \? \[created\] : \[\], entry\.tenant_id/.test(acct));

const deact = acct.slice(acct.indexOf("export async function deactivateTenantRecurring"));
assert("deactivateTenantRecurring uses move_out_commit_state's shape: status 'inactive' + archived_at, by tenant_id",
  /update\(\{ status: "inactive", archived_at:/.test(deact) && /\.in\("tenant_id", chunk\)/.test(deact) && /\.eq\("status", "active"\)/.test(deact));
const moveOutSql = fs.readFileSync(path.join(root, "supabase/migrations/20260922070000_move_out_optional_lease.sql"), "utf8");
assert("…which really is what move_out_commit_state writes", /UPDATE recurring_journal_entries SET status='inactive', archived_at=now\(\)/.test(moveOutSql));

const archive = src("utils/tenantArchive.js");
const leases = src("components/Leases.js");
const life = src("components/Lifecycle.js");
const props = src("components/Properties.js");
const tenants = src("components/Tenants.js");
assert("archiveTenant stops the tenant's rent", /deactivateTenantRecurring\(companyId, tenantId\)/.test(archive));
// Terminating a lease now runs through ONE function, terminateLeaseCascade
// (utils/destructive.js), shared by the Leases page and the approval queue.
// These checks used to read the Leases page, where the code no longer is.
const destructive = src("utils/destructive.js");
const term = destructive.slice(destructive.indexOf("export async function terminateLeaseCascade"), destructive.indexOf("export async function archiveOwnerRow"));
assert("the Leases page terminates through terminateLeaseCascade", /terminateLeaseCascade\(\{ companyId, lease, userProfile, userRole \}\)/.test(leases));
assert("lease terminate stops the tenant's rent", /deactivateTenantRecurring\(companyId, lease\.tenant_id\)/.test(term));
assert("lease terminate disables autopay with enabled:false (what the Stripe charger reads)",
  /update\(\{ enabled: false \}\)\.eq\("company_id", companyId\)\.eq\("tenant_id", lease\.tenant_id\)/.test(term) && !/active: false/.test(term));
assert("lease terminate falls back to name AND property only without tenant_id",
  /\.eq\("tenant", lease\.tenant_name\)\.eq\("property", lease\.property\)/.test(term));
const close = life.slice(life.indexOf("async function closeCase"));
assert("completed eviction stops the tenant's rent", /deactivateTenantRecurring\(companyId, evictedIds\)/.test(close));
const deactProp = props.slice(props.indexOf("async function deactivateProperty"), props.indexOf("async function reactivateProperty"));
assert("property deactivation stops its tenants' rent", /deactivateTenantRecurring\(companyId, \(pastTenants/.test(deactProp));
assert("bulk status 'past' stops rent", /newStatus === "past"[\s\S]{0,120}deactivateTenantRecurring\(companyId, ids\)/.test(tenants));

console.log("\n💲 AMOUNT SYNC + LEASE CREATE");
assert("tenant edit uses the shared syncTenantRecurringAmount", /syncTenantRecurringAmount\(companyId, editingTenant\.id, _rent\)/.test(tenants));
const renew = leases.slice(leases.indexOf("async function renewLease"), leases.indexOf("async function terminateLease"));
assert("lease renew syncs the recurring amount", /syncTenantRecurringAmount\(companyId, lease\.tenant_id,/.test(renew));
assert("rent increase syncs the recurring amount", /syncTenantRecurringAmount\(companyId, showRentIncrease\.tenant_id, newAmt\)/.test(leases));
assert("no inline recurring amount update remains in Tenants/Leases",
  !/from\("recurring_journal_entries"\)[\s\S]{0,80}update\(\{ amount/.test(tenants + leases));
const save = leases.slice(leases.indexOf("async function saveLease"), leases.indexOf("function resetForm"));
assert("lease create queues the shared RecurringEntryModal", /setPendingRecurringEntry\(_queueRecurring\)/.test(save)
  && /<RecurringEntryModal entry=\{pendingRecurringEntry\}/.test(leases) && /RecurringEntryModal \} from "\.\/shared"/.test(leases));
assert("the do-nothing 'backdated rent accruals' prompt is gone", !/backdated rent accrual/.test(leases) && !/autoPostRentCharges\(/.test(leases));

// ─── 2b. PART A: one tenant-status vocabulary ─────────────────────────────
console.log("\n🏷️  LEASE STATUS VOCABULARY");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(f =>
  f.isDirectory() ? walk(path.join(d, f.name)) : f.name.endsWith(".js") ? [path.join(d, f.name)] : []);
const writesCurrent = [];
for (const f of walk(path.join(root, "src"))) {
  const body = fs.readFileSync(f, "utf8");
  body.split("\n").forEach((ln, i) => {
    if (/lease_status\s*[:=]\s*[^,;)]*["']current["']/.test(ln)) writesCurrent.push(path.relative(root, f) + ":" + (i + 1));
  });
}
assert("no code writes lease_status 'current' (canonical is 'active')", writesCurrent.length === 0, writesCurrent.join(", "));
assert("Tenants notice no longer writes the forbidden lease status 'notice'", !/from\("leases"\)\.update\(\{ status: "notice" \}\)/.test(tenants));
assert("move-out accepts tenants on notice (Tenants page gate)", /if \(!LIVE_TENANCY\.includes\(st\)\)/.test(tenants) && !/set them to Current/.test(tenants));
assert("move-out loader lists tenants on notice", /\.in\("lease_status", LIVE_TENANCY\)/.test(life));
assert("LIVE_TENANCY includes active and notice", /export const LIVE_TENANCY = \[\.\.\.ACTIVE_LEASE, "notice"\]/.test(src("utils/helpers.js")));
const mig = fs.readFileSync(path.join(root, "supabase/migrations/20260928020000_tenant_status_notice_occupies.sql"), "utf8");
assert("migration: occupancy counts active AND notice tenants, active first",
  (mig.match(/lease_status IN \('active','notice'\)/g) || []).length === 2 && /ORDER BY \(lease_status = 'active'\) DESC, id/.test(mig));
assert("migration: 'notice given' when the live tenant is on notice", /WHEN v_notice AND status IN \('vacant','occupied','in_setup','notice given'\) THEN 'notice given'/.test(mig));
assert("migration: 'current' is normalised to 'active' before insert/update", /BEFORE INSERT OR UPDATE OF lease_status ON public\.tenants/.test(mig) && /NEW\.lease_status := 'active'/.test(mig));
assert("migration does not touch idx_tenants_one_active_per_property", !/CREATE UNIQUE INDEX|DROP INDEX/i.test(mig));
assert("migration keeps SECURITY DEFINER + search_path on the occupancy functions",
  (mig.match(/SECURITY DEFINER\nSET search_path TO 'public', 'pg_temp'/g) || []).length === 2);

// ─── 3. LIVE (read-only, TEST project): the query shape PostgREST accepts ──
console.log("\n🌐 QUERY SHAPE (test DB, read-only)");
try {
  require("./sandbox-env");
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: anyLine } = await sb.from("acct_journal_lines")
    .select("company_id, account_id, acct_journal_entries!inner(reference, date)")
    .like("acct_journal_entries.reference", "RECUR-%").gt("debit", 0).limit(1);
  const probe = anyLine?.[0];
  if (!probe) { assert("found a RECUR line to probe with", false, "no RECUR lines in the test DB"); }
  else {
    const month = String(probe.acct_journal_entries.date).slice(0, 7);
    const { start, end } = monthBounds(month);
    const { data, error } = await sb.from("acct_journal_lines")
      .select("account_id, debit, acct_journal_entries!inner(reference, date, status)")
      .eq("company_id", probe.company_id).eq("account_id", probe.account_id).gt("debit", 0)
      .like("acct_journal_entries.reference", "RECUR-%")
      .neq("acct_journal_entries.status", "voided")
      .gte("acct_journal_entries.date", start).lte("acct_journal_entries.date", end)
      .limit(5);
    assert("double-bill query runs without error", !error, error?.message);
    assert("…and finds the known RECUR debit in its month", arAlreadyBilledInMonth(data, probe.account_id, month),
      JSON.stringify(data));
    const { data: none } = await sb.from("acct_journal_lines")
      .select("account_id, debit, acct_journal_entries!inner(reference, date, status)")
      .eq("company_id", probe.company_id).eq("account_id", probe.account_id).gt("debit", 0)
      .like("acct_journal_entries.reference", "RECUR-%")
      .gte("acct_journal_entries.date", "1990-01-01").lte("acct_journal_entries.date", "1990-01-31").limit(5);
    assert("…and finds nothing in a month with no billing", !arAlreadyBilledInMonth(none, probe.account_id, "1990-01"));
  }
} catch (e) {
  assert("live query shape check ran", false, e.message);
}

// ── A renewal is not a move-in ────────────────────────────────────────
// Toni Tillman: billed $2,900 a month, renewal lease starting 2026-11-03.
// The lease-start test alone prorated November to 28/30.
{
  const p = rules.leaseStartProration;
  const fresh = p({ leaseStart: "2026-11-03", monthStr: "2026-11", amount: 2900, hasEarlierCharges: false });
  assert("a NEW tenancy starting on the 3rd is prorated 28/30", fresh && fresh.days === 28 && fresh.daysInMonth === 30 && fresh.amount === 2706.67, JSON.stringify(fresh));
  assert("a RENEWAL starting on the 3rd is charged in full", p({ leaseStart: "2026-11-03", monthStr: "2026-11", amount: 2900, hasEarlierCharges: true }) === null);
  assert("a lease starting on the 1st is never prorated", p({ leaseStart: "2026-11-01", monthStr: "2026-11", amount: 2900, hasEarlierCharges: false }) === null);
  assert("a later month is never prorated", p({ leaseStart: "2026-11-03", monthStr: "2026-12", amount: 2900, hasEarlierCharges: false }) === null);
  assert("the last day of a month is one day's rent", p({ leaseStart: "2026-02-28", monthStr: "2026-02", amount: 2800, hasEarlierCharges: false })?.amount === 100);
  assert("a missing or malformed lease start is charged in full", p({ leaseStart: null, monthStr: "2026-11", amount: 2900 }) === null && p({ leaseStart: "11/03/2026", monthStr: "2026-11", amount: 2900 }) === null);
  const acct = src("utils/accounting.js");
  assert("the recurring worker prorates through leaseStartProration, not its own date test",
    /leaseStartProration\(\{ leaseStart: lease\.start_date, monthStr, amount: entry\.amount, hasEarlierCharges \}\)/.test(acct) && !/const startsMidMonth/.test(acct));
  assert("…and asks the tenant's own ledger whether they were charged before this month",
    /\.eq\("account_id", debitAcct\.id\)\.gt\("debit", 0\)[\s\S]{0,200}\.lt\("acct_journal_entries\.date", monthStr \+ "-01"\)/.test(acct));
}

// ── What the Recurring rent page flags ───────────────────────────────
// Each case below is something that actually happened on Sigma's books.
{
  const today = "2026-10-02";
  const T = (id, name, rent, extra = {}) => ({ id, name, rent, lease_status: "active", archived_at: null, ...extra });
  const S = (id, tenant_id, amount, extra = {}) => ({ id, tenant_id, tenant_name: "t" + tenant_id, amount, status: "active", archived_at: null, day_of_month: 1, next_post_date: "2026-11-01", last_posted_date: "2026-10-01", ...extra });
  const find = (list, kind, tenantId) => list.find(a => a.kind === kind && String(a.tenantId) === String(tenantId));
  const run = (o) => rules.recurringAttention({ today, chargedThisMonth: new Set(), ...o });

  let a = run({ tenants: [T(1, "Stanley", 1900)], schedules: [] });
  assert("a live tenant with no schedule is 'not being billed', and the missed month is named", !!find(a, "not_billed", 1) && /October has not been charged/.test(find(a, "not_billed", 1).text), JSON.stringify(a));
  a = run({ tenants: [T(1, "Tamara", 2500)], schedules: [], chargedThisMonth: new Set(["1"]) });
  assert("…but if this month was entered by hand, it does not claim the month was missed", !!find(a, "not_billed", 1) && !/has not been charged/.test(find(a, "not_billed", 1).text));
  a = run({ tenants: [T(1, "Paused", 1900)], schedules: [S("s1", 1, 1900, { status: "paused" })] });
  assert("a tenant whose schedule is paused is told apart from one with no schedule", !!find(a, "paused", 1) && find(a, "paused", 1).scheduleId === "s1" && !find(a, "not_billed", 1), JSON.stringify(a));
  a = run({ tenants: [T(1, "Gone", 1900, { lease_status: "past" }), T(2, "Archived", 1900, { archived_at: "2026-09-20" })], schedules: [] });
  assert("past and archived tenants are not expected to be billed", a.length === 0, JSON.stringify(a));

  a = run({ tenants: [T(1, "Amanda", 2084)], schedules: [S("s1", 1, 2839)], chargedThisMonth: new Set(["1"]) });
  assert("a schedule charging a different amount than the tenant's rent is flagged with both figures", !!find(a, "amount_differs", 1) && /\$2,839\.00/.test(find(a, "amount_differs", 1).text) && /\$2,084\.00/.test(find(a, "amount_differs", 1).text), JSON.stringify(a));
  a = run({ tenants: [T(1, "Fine", 1800)], schedules: [S("s1", 1, 1800)], chargedThisMonth: new Set(["1"]) });
  assert("a schedule that matches, posted this month, raises nothing", a.length === 0, JSON.stringify(a));
  a = run({ tenants: [T(1, "NoRentOnFile", 0)], schedules: [S("s1", 1, 1800)], chargedThisMonth: new Set(["1"]) });
  assert("no rent on the tenant record is not a mismatch", !find(a, "amount_differs", 1));

  a = run({ tenants: [T(1, "Toni", 2900)], schedules: [S("s1", 1, 2900, { next_post_date: "2026-12-01", last_posted_date: null })] });
  assert("a schedule that starts in two months skips this month and the next", JSON.stringify(find(a, "skips_months", 1)?.months) === '["2026-10","2026-11"]' && /October and November are not charged/.test(find(a, "skips_months", 1).text), JSON.stringify(a));
  a = run({ tenants: [T(1, "Tamara", 2500)], schedules: [S("s1", 1, 2500, { next_post_date: "2026-11-01", last_posted_date: null })], chargedThisMonth: new Set(["1"]) });
  assert("starting next month is fine when this month is already on the ledger", a.length === 0, JSON.stringify(a));
  a = run({ tenants: [T(1, "Stanley", 1900)], schedules: [S("s1", 1, 1900, { next_post_date: "2026-11-01", last_posted_date: null })] });
  assert("starting next month with nothing charged this month is flagged", JSON.stringify(find(a, "skips_months", 1)?.months) === '["2026-10"]', JSON.stringify(a));
  a = run({ tenants: [T(1, "NewNextMonth", 1900, { lease_start: "2026-11-01" })], schedules: [S("s1", 1, 1900, { next_post_date: "2026-11-01", last_posted_date: null })] });
  assert("a tenant whose lease starts next month owes nothing this month", a.length === 0, JSON.stringify(a));
  assert("skippedMonths is empty for a paused or archived schedule", rules.skippedMonths(S("s", 1, 1, { status: "paused", next_post_date: "2027-01-01" }), today).length === 0 && rules.skippedMonths(S("s", 1, 1, { archived_at: "x", next_post_date: "2027-01-01" }), today).length === 0);
  assert("skippedMonths crosses a year end", JSON.stringify(rules.skippedMonths(S("s", 1, 1, { next_post_date: "2027-02-01", last_posted_date: "2026-11-01" }), "2026-11-15")) === '["2026-12","2027-01"]');

  a = run({ tenants: [T(1, "Due", 1800)], schedules: [S("s1", 1, 1800, { next_post_date: "2026-10-01", last_posted_date: "2026-09-01" })] });
  assert("rent that is due but has not posted is 'not charged yet'", !!find(a, "not_charged", 1), JSON.stringify(a));
  a = run({ tenants: [T(1, "LaterInMonth", 1800)], schedules: [S("s1", 1, 1800, { day_of_month: 15, next_post_date: "2026-10-15", last_posted_date: "2026-09-15" })] });
  assert("rent billed on the 15th is not 'late' on the 2nd", !find(a, "not_charged", 1), JSON.stringify(a));

  a = run({ tenants: [T(1, "Left", 1800, { lease_status: "past" })], schedules: [S("s1", 1, 1800), S("s2", 99, 500)] });
  assert("a schedule for a past or missing tenant is 'will never post'", !!find(a, "will_not_post", 1) && !!find(a, "will_not_post", 99), JSON.stringify(a));
  a = run({ tenants: [], schedules: [{ id: "m", tenant_id: null, amount: 1234, status: "active", archived_at: null, next_post_date: "2027-06-01" }] });
  assert("a non-rent schedule (mortgage) is never judged against a tenant", a.length === 0, JSON.stringify(a));
  a = run({ tenants: [T(2, "B", 100), T(1, "A", 100), T(3, "C", 2084)], schedules: [S("s3", 3, 2839)], chargedThisMonth: new Set(["3"]) });
  assert("unbilled tenants come first, then by name", a.map(x => x.name).join(",") === "A,B,C", a.map(x => x.kind + ":" + x.name).join(","));
}

// ── The Recurring rent page does not undo a schedule when it is edited ──
{
  const pageSrc = src("components/RecurringRent.js");
  const saveEdit = pageSrc.slice(pageSrc.indexOf("async function saveEdit"), pageSrc.indexOf("function closePanelNow"));
  assert("an edit writes only the fields that changed", /\.update\(changes\)/.test(saveEdit) && /Object\.keys\(changes\)\.length === 0/.test(saveEdit));
  assert("an edit never writes the status (it used to un-pause a paused schedule)", !/status\s*:/.test(saveEdit));
  assert("an edit moves the next posting only when that field was changed", /if \(\(form\.next_post_date \|\| null\) !== \(entry\.next_post_date \|\| null\)\) changes\.next_post_date/.test(saveEdit) && (saveEdit.match(/changes\.next_post_date\s*=/g) || []).length === 1);
  const createRent = pageSrc.slice(pageSrc.indexOf("async function createRent"), pageSrc.indexOf("async function createOther"));
  assert("a new rent schedule carries the tenant id", /tenant_id: Number\(t\.id\)/.test(createRent));
  assert("…and bills the tenant's OWN ledger and a real income account, not the codes 1200/4000", /tenantOwnArAccountId\(companyId, t\.name, t\.id\)/.test(createRent) && /debit_account_id: arId/.test(createRent) && /credit_account_id: revenueId/.test(createRent) && !/"1200"/.test(createRent) && !/account_id: "4000"/.test(createRent));
  assert("…and refuses to exist without that ledger", /if \(!arId \|\| !revenueId\)/.test(createRent));
  assert("the list is not capped at 200 rows", !/\.limit\(200\)/.test(pageSrc) && /fetchAllPaged\(\(\) => supabase\.from\("recurring_journal_entries"\)/.test(pageSrc));
  assert("Accounting uses this page and no longer carries its own copy", /import \{ RecurringJournalEntries \} from "\.\/RecurringRent"/.test(src("components/Accounting.js")) && !/function RecurringJournalEntries/.test(src("components/Accounting.js")));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
