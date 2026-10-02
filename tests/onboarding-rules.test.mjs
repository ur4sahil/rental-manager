// What converting a prospect puts on the books (src/utils/onboardingRules.js).
//
// The plan is shown to the user before anything is posted and then posted
// exactly as shown, so these are the amounts and dates a real tenant is
// charged. Proration is Sahil's rule: rent x remaining days / days in that
// month.
import { planTenancyCharges, describeTenancyCharges, nextMonth, isRentCharge, defaultTenancyMode, runningBillFrom, describeRunningTenancy } from "../src/utils/onboardingRules.js";
import fs from "fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const plan = (leaseStart, today, rent = 1800, deposit = 1800) => planTenancyCharges({ leaseStart, rent, deposit, today });

// ── the first month
let p = plan("2026-10-01", "2026-10-02");
ok("a lease starting on the 1st is charged the full month", p.ok && p.firstMonth.kind === "full" && p.firstMonth.amount === 1800 && p.firstMonth.date === "2026-10-01", JSON.stringify(p.firstMonth));
p = plan("2026-10-15", "2026-10-02");
ok("starting on the 15th of a 31-day month is 17/31", p.firstMonth.kind === "prorated" && p.firstMonth.days === 17 && p.firstMonth.daysInMonth === 31 && p.firstMonth.amount === 987.1, JSON.stringify(p.firstMonth));
p = plan("2026-02-28", "2026-02-01", 2800);
ok("the last day of February is one day's rent", p.firstMonth.days === 1 && p.firstMonth.amount === 100);
p = plan("2028-02-29", "2028-02-01", 2900);
ok("a leap-year February has 29 days", p.ok && p.firstMonth.daysInMonth === 29 && p.firstMonth.amount === 100);
ok("the first month is dated the lease start, not today", plan("2026-11-03", "2026-10-02").firstMonth.date === "2026-11-03");

// ── the deposit
ok("the deposit is charged on the lease start", plan("2026-10-15", "2026-10-02").deposit.amount === 1800 && plan("2026-10-15", "2026-10-02").deposit.date === "2026-10-15");
ok("no deposit, no deposit entry", plan("2026-10-15", "2026-10-02", 1800, 0).deposit === null && planTenancyCharges({ leaseStart: "2026-10-15", rent: 1800, today: "2026-10-02" }).deposit === null);

// ── the schedule, and the months in between
ok("the monthly schedule starts the 1st of the following month", plan("2026-10-15", "2026-10-02").scheduleFrom === "2026-11-01" && plan("2026-12-20", "2026-12-21").scheduleFrom === "2027-01-01");
ok("a lease starting this month has no months to catch up", plan("2026-10-01", "2026-10-02").catchUp.length === 0);
ok("a lease starting last month has none either (this month is the schedule's)", plan("2026-09-10", "2026-10-02").catchUp.length === 0);
ok("a lease starting in the future has none", plan("2026-12-01", "2026-10-02").catchUp.length === 0);
p = plan("2026-07-15", "2026-10-02");
ok("entered three months late: the whole months in between are charged once", JSON.stringify(p.catchUp) === '["2026-08","2026-09"]', JSON.stringify(p.catchUp));
p = plan("2025-11-20", "2026-02-10");
ok("catch-up crosses a year end", JSON.stringify(p.catchUp) === '["2025-12","2026-01"]', JSON.stringify(p.catchUp));
ok("nextMonth rolls December into January", nextMonth("2026-12") === "2027-01" && nextMonth("2026-01") === "2026-02");

// ── refusing nonsense
ok("no start date is refused", !plan("", "2026-10-02").ok && !plan(null, "2026-10-02").ok);
ok("zero or negative rent is refused", !plan("2026-10-01", "2026-10-02", 0).ok && !plan("2026-10-01", "2026-10-02", -5).ok && !plan("2026-10-01", "2026-10-02", "abc").ok);
ok("a date that does not exist is refused", !plan("2026-02-30", "2026-02-01").ok);
ok("rent arriving as text is read as a number", plan("2026-10-01", "2026-10-02", "1800.50").monthly === 1800.5);
ok("amounts are rounded to cents", plan("2026-10-11", "2026-10-02", 1000).firstMonth.amount === 677.42);

// ── the sentences shown before converting
const lines = describeTenancyCharges(plan("2026-07-15", "2026-10-02"));
ok("the confirmation lists the deposit, the first month, the catch-up and the schedule", lines.length === 4 && /deposit/i.test(lines[0]) && /17 of 31 days/.test(lines[1]) && /2026-08, 2026-09/.test(lines[2]) && /from 2026-08-01/.test(lines[3]), lines.join(" | "));
ok("nothing is described for a plan that was refused", describeTenancyCharges(plan("", "2026-10-02")).length === 0);

// ── the posting code uses the wizard's references, so nothing is charged twice
const src = fs.readFileSync(new URL("../src/utils/tenantOnboarding.js", import.meta.url), "utf8");
ok("deposit posts under the shared per-tenant reference and checks first", /depositAlreadyPosted\(companyId, tid\)/.test(src) && /reference: depositReference\(tid\)/.test(src));
ok("first month posts as RENT1-/PRORENT-T<id>-<date> and is matched by prefix", /"PRORENT-T" : "RENT1-T"/.test(src) && /\.like\("reference", fam \+ prefix \+ "%"\)/.test(src));
ok("a failed 'already posted?' lookup is not read as 'not posted'", /hits\.some\(h => h\.error\)/.test(src));
ok("catch-up months use the schedule's own RECUR- reference", /"RECUR-" \+ String\(schedule\.id\)\.slice\(0, 8\) \+ "-" \+ month/.test(src));
ok("a locked period is reported, not posted into", (src.match(/checkPeriodLock\(companyId/g) || []).length >= 3);
ok("the schedule is created once per tenant", /\.eq\("tenant_id", tid\)\.eq\("status", "active"\)\.is\("archived_at", null\)/.test(src) && /if \(schedule\) add\("schedule", "Monthly rent schedule", "already"\)/.test(src));

// ══════════ ONE WAY TO START A TENANCY (2026-10-02) ══════════
// Five screens used to start a tenant's books five ways. Stanley Ibe ended
// up with no rent schedule; Toni Tillman, a tenant of years, was charged a
// second deposit and a 28-day "first month" when her renewal began on the
// 3rd. These hold the rules that replaced them.

// ── move-in, or already lives there?
ok("a lease starting this month is offered as a move-in", defaultTenancyMode({ leaseStart: "2026-10-15", today: "2026-10-02" }) === "new");
ok("a lease starting last month is still a move-in", defaultTenancyMode({ leaseStart: "2026-09-01", today: "2026-10-31" }) === "new");
ok("a lease starting in the future is a move-in", defaultTenancyMode({ leaseStart: "2027-01-01", today: "2026-10-02" }) === "new");
ok("a lease that started two months ago is someone being entered late", defaultTenancyMode({ leaseStart: "2026-08-31", today: "2026-10-02" }) === "running");
ok("a lease that started years ago is never offered as a move-in", defaultTenancyMode({ leaseStart: "2023-05-01", today: "2026-10-02" }) === "running");
ok("last month wraps over a year end", defaultTenancyMode({ leaseStart: "2025-12-10", today: "2026-01-05" }) === "new" && defaultTenancyMode({ leaseStart: "2025-11-30", today: "2026-01-05" }) === "running");
ok("a renewal is never a move-in, whatever its start date (Toni)", defaultTenancyMode({ leaseStart: "2026-11-03", today: "2026-10-02", continuing: true }) === "running");
ok("no lease start: not a move-in", defaultTenancyMode({ leaseStart: "", today: "2026-10-02" }) === "running");

// ── which month the schedule starts with, for someone already there
ok("already there: billed from this month", runningBillFrom({ today: "2026-10-02" }) === "2026-10-01");
ok("already there and this month already charged: from next month", runningBillFrom({ today: "2026-10-02", chargedThisMonth: true }) === "2026-11-01");
ok("next month rolls over December", runningBillFrom({ today: "2026-12-20", chargedThisMonth: true }) === "2027-01-01");
const rl = describeRunningTenancy({ monthly: 1900, billFrom: "2026-10-01" });
ok("already there: the dialog says no deposit and no first-month charge", rl.length === 2 && /1900\.00/.test(rl[0]) && /from 2026-10-01/.test(rl[0]) && /No deposit/.test(rl[1]));

// ── what counts as a rent charge on a ledger (to never bill a month twice)
ok("the schedule's own postings are rent", isRentCharge({ reference: "RECUR-1a2b3c4d-2026-10" }) && isRentCharge({ reference: "RENT1-T12-20261001" }) && isRentCharge({ reference: "PRORENT-T12-20261015" }));
ok("rent posted by hand is rent", isRentCharge({ description: "October rent" }) && isRentCharge({ memo: "Rent - Stanley Ibe" }) && isRentCharge({ description: "Rental income Oct" }));
ok("a deposit is not rent", !isRentCharge({ reference: "DEP-T12" }) && !isRentCharge({ memo: "Security deposit from X" }) && !isRentCharge({ description: "Deposit for rent" }));
ok("a late fee is not rent, even when its text says rent", !isRentCharge({ description: "Late fee on October rent" }) && !isRentCharge({ memo: "late charge" }));
ok("an unrelated charge is not rent", !isRentCharge({ description: "Water bill reimbursement" }) && !isRentCharge({}) && !isRentCharge({ description: "Parent teacher" }));

// ── the engine
ok("the engine reads the tenant's ledger before posting anything", src.indexOf("const facts = await tenantLedgerFacts(") < src.indexOf("atomicPostJEAndLedger({"));
ok("a tenant already charged before the lease start is a renewal: no deposit, no first month",
  /if \(effectiveMode === "new" && continuing\) effectiveMode = "running";/.test(src)
  && /add\("deposit", "Security deposit", "skipped", why\);\s*add\("first", "First month's rent", "skipped", why\);/.test(src));
ok("'charged before the lease start' ignores voided entries and deposits, counts lines with no memo",
  /neq\("acct_journal_entries\.status", "voided"\)\.lt\("acct_journal_entries\.date", start\)\s*\.or\("memo\.is\.null,memo\.not\.ilike\.%deposit%"\)/.test(src));
ok("the first month is not charged when that month already has a rent charge", /else if \(rentMonths\.has\(plan\.firstMonth\.date\.slice\(0, 7\)\)\) add\("first", "First month's rent", "already"/.test(src));
ok("a catch-up month is not charged when that month already has a rent charge", /if \(rentMonths\.has\(month\)\) \{ add\("catchup-" \+ month, label, "already"/.test(src));
ok("the wizard's mode: months already passed are charged only in the run that posts the first month", /plan\.catchUp\.length && \(catchUp !== "first-run" \|\| firstPostedNow\)/.test(src) && /firstPostedNow = !!res\?\.jeId;/.test(src));
ok("already-there mode posts no deposit and no first month", (() => { const run = src.slice(src.indexOf('if (effectiveMode === "running") {'), src.indexOf("// ── 3. security deposit")); return !/atomicPostJEAndLedger|autoPostJournalEntry/.test(run); })());
ok("a caller that makes its own schedule (the wizard) never gets a second one", /else if \(!createSchedule\) add\("schedule", "Monthly rent schedule", "skipped"/.test(src));
ok("a ledger that cannot be read stops everything (nothing is posted blind)", /if \(!arId \|\| !revenueId \|\| !facts\.ok\) \{[\s\S]{0,260}return finish\(\);/.test(src));
ok("'skipped' is not a failure; 'locked' and 'failed' are", /steps\.every\(s => s\.status === "done" \|\| s\.status === "already" \|\| s\.status === "skipped"\)/.test(src) && /s\.status === "failed" \|\| s\.status === "locked"/.test(src));

// ── the five screens
const read = (f) => fs.readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
const tenantsJs = read("components/Tenants.js"), leasesJs = read("components/Leases.js"), propsJs = read("components/Properties.js"), prospectsJs = read("components/Prospects.js"), modalJs = read("components/StartTenancyModal.js"), sharedJs = read("components/shared.js");
for (const [label, body] of [["Tenants page", tenantsJs], ["Leases page", leasesJs], ["Properties (form and wizard)", propsJs]]) {
  ok(label + ": posts no deposit or first-month entry of its own", !/Security deposit received/.test(body) && !/First month rent/.test(body) && !/Prorated rent \(/.test(body));
  ok(label + ": no longer creates a rent schedule inline", !/from\("recurring_journal_entries"\)\s*\.?insert/.test(body) && !/recurring_journal_entries"\)\.insert/.test(body));
}
ok("Tenants page hands a new tenant to the shared dialog, with the deposit", /setPendingRecurringEntry\(\{ tenantName: _name, tenantId: tenantId, property: _property, rent: _rent, deposit: _secDep,/.test(tenantsJs) && /<StartTenancyModal entry=\{pendingRecurringEntry\}/.test(tenantsJs));
ok("Leases 'Create lease' hands over to the shared dialog, with the deposit", /deposit: Number\(form\.security_deposit \|\| 0\)/.test(leasesJs) && /<StartTenancyModal entry=\{pendingRecurringEntry\}/.test(leasesJs));
ok("the property form hands a new tenant (or one with no schedule) to the shared dialog", /if \(tenantId && \(!existingTenant \|\| !\(await tenantHasRentSchedule\(companyId, tenantId\)\)\)\)/.test(propsJs) && /if \(_startBilling\) setPendingRecurringEntry\(_startBilling\);/.test(propsJs));
ok("the wizard calls the engine with its own schedule and no going back to bill", /mode: tenancyMode, createSchedule: false, catchUp: "first-run"/.test(propsJs));
ok("the wizard's mode: a migrated lease is 'already there'; else what the rent step was told; else the shared rule",
  /const tenancyMode = isLeaseMigration \? "running"\s*: \(recurring\?\.tenancy === "new" \|\| recurring\?\.tenancy === "running"\) \? recurring\.tenancy\s*: defaultTenancyMode\(\{ leaseStart: tenantForm\.lease_start, today: formatLocalDate\(new Date\(\)\) \}\);/.test(propsJs));
ok("the wizard asks move-in or already-there only for a tenant it is adding, and shows what will be charged",
  /\{!tenantLoadedRef\.current && tenantForm\.tenant\.trim\(\) && tenantForm\.lease_start && !wizardMigrating && /.test(propsJs) && /setRecurring\(\{ \.\.\.recurring, tenancy: "new" \}\)/.test(propsJs) && /setRecurring\(\{ \.\.\.recurring, tenancy: "running" \}\)/.test(propsJs));
ok("the wizard reports a failed step, and does not call a closed period a failure", /if \(st\.status === "failed"\) phaseCFailures\.push\(/.test(propsJs));
ok("Prospects converts through the same engine", /startTenancyBooks\(\{/.test(prospectsJs));
ok("the old closable 'Set Up Recurring Rent' pop-ups are gone", !/RecurringEntryModal/.test(sharedJs + tenantsJs + leasesJs + propsJs) && !/showRecurringSetup/.test(propsJs) && !/debit_account_id: "1200"/.test(propsJs));
ok("the dialog picks its default from the ledger, and a renewal cannot be started as a move-in", /defaultTenancyMode\(\{ leaseStart: entry\.leaseStart, today, continuing: f\.continuing \}\)/.test(modalJs) && /const canNew = plan\.ok && !facts\?\.continuing;/.test(modalJs));
ok("the dialog says what closing it means", /is not billed and is listed there under "Not being billed"/.test(modalJs));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
