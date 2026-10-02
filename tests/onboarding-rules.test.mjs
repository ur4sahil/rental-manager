// What converting a prospect puts on the books (src/utils/onboardingRules.js).
//
// The plan is shown to the user before anything is posted and then posted
// exactly as shown, so these are the amounts and dates a real tenant is
// charged. Proration is Sahil's rule: rent x remaining days / days in that
// month.
import { planTenancyCharges, describeTenancyCharges, nextMonth } from "../src/utils/onboardingRules.js";
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
ok("the schedule is created once per tenant", /\.eq\("tenant_id", tid\)\s*\.eq\("status", "active"\)\.is\("archived_at", null\)/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
