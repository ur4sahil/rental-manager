// Notices and move-out (Phase 3 of docs/PLAN-tenant-documents.md).
import fs from "fs";
import { checkNotice, defaultMoveOutDate, noticeTemplateFor, rentPeriodLabel, depositStatement, deductionsText, depositDueBy, depositStatementValues } from "../src/utils/noticeRules.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

// ── recording notice
const base = { givenBy: "tenant", noticeDate: "2026-10-02", moveOutDate: "2026-12-01", today: "2026-10-02", noticeDays: 60 };
ok("60 days' notice is clean", checkNotice(base).ok && checkNotice(base).days === 60 && !checkNotice(base).warning);
let n = checkNotice({ ...base, moveOutDate: "2026-11-01" });
ok("short notice is recorded, not refused, and flagged with the date the full period ends", n.ok && n.days === 30 && /30 days' notice; 60 is required/.test(n.warning) && /2026-12-01/.test(n.warning));
ok("one day's notice reads as one day", /That is 1 day' notice/.test(checkNotice({ ...base, moveOutDate: "2026-10-03" }).warning));
ok("who gave it must be said", !checkNotice({ ...base, givenBy: "" }).ok && !checkNotice({ ...base, givenBy: "someone" }).ok);
ok("both dates are needed", !checkNotice({ ...base, noticeDate: "" }).ok && !checkNotice({ ...base, moveOutDate: "" }).ok);
ok("notice cannot be dated in the future", !checkNotice({ ...base, noticeDate: "2026-10-03", moveOutDate: "2026-12-30" }).ok);
ok("move-out cannot be before the notice", !checkNotice({ ...base, moveOutDate: "2026-10-01" }).ok);
ok("moving out the day notice is given is recorded (and flagged)", checkNotice({ ...base, moveOutDate: "2026-10-02" }).ok && checkNotice({ ...base, moveOutDate: "2026-10-02" }).days === 0);
ok("the landlord's notice follows the same dates", checkNotice({ ...base, givenBy: "landlord" }).ok);
ok("the default move-out date is the notice date plus the period", defaultMoveOutDate("2026-10-02", 60) === "2026-12-01" && defaultMoveOutDate("2026-12-15", 30) === "2027-01-14" && defaultMoveOutDate("", 30) === "");
ok("a tenant's notice is acknowledged; the landlord's is a notice to vacate", noticeTemplateFor("tenant") === "move_out_acknowledgment" && noticeTemplateFor("landlord") === "notice_to_vacate");
ok("the rent period is the month in words", rentPeriodLabel("2026-10-05") === "October 2026" && rentPeriodLabel("2027-01-31") === "January 2027" && rentPeriodLabel("") === "");

// ── the deposit after move-out: the statement is the ledger's own arithmetic
let s = depositStatement({ held: 1800, deductions: [{ desc: "Carpet", amount: 250 }], balanceBefore: 0 });
ok("deposit 1,800, 250 withheld, nothing owed: 1,550 goes back", s.returned === 1550 && s.owed === 0 && s.totalDeductions === 250 && s.appliedToBalance === 0);
s = depositStatement({ held: 2000, deductions: [{ desc: "Carpet", amount: 300 }], balanceBefore: 500 });
ok("unpaid rent comes out of the deposit before any refund", s.returned === 1200 && s.appliedToBalance === 500 && s.owed === 0, JSON.stringify(s));
s = depositStatement({ held: 2000, deductions: [{ desc: "Walls", amount: 2500 }], balanceBefore: 0 });
ok("damage beyond the deposit is owed, not refunded", s.returned === 0 && s.owed === 500 && s.appliedToBalance === 0);
s = depositStatement({ held: 1000, deductions: [], balanceBefore: 1800 });
ok("rent owed beyond the deposit: the whole deposit is applied and the rest is owed", s.returned === 0 && s.owed === 800 && s.appliedToBalance === 1000);
s = depositStatement({ held: 1000, deductions: [], balanceBefore: 1800, waived: true });
ok("a written-off balance is not shown as owed", s.owed === 0 && s.writtenOff === 800 && s.returned === 0);
s = depositStatement({ held: 1500, deductions: [], balanceBefore: -200 });
ok("a credit already on the ledger is refunded with the deposit", s.returned === 1700 && s.owed === 0);
s = depositStatement({ held: 1500, released: 500, deductions: [{ desc: "Keys", amount: 100 }], balanceBefore: 0 });
ok("only what this move-out released is accounted; the part returned earlier is shown as such", s.released === 500 && s.releasedEarlier === 1000 && s.returned === 400);
s = depositStatement({ held: 0, deductions: [{ desc: "Cleaning", amount: 150 }], balanceBefore: 0 });
ok("no deposit: a charge is simply owed", s.owed === 150 && s.returned === 0);
s = depositStatement({ held: 1000, deductions: [{ desc: "x", amount: 0 }, { desc: "y", amount: -5 }, { desc: "", amount: 40 }], balanceBefore: 0 });
ok("zero and negative deductions are ignored; an unnamed one still counts", s.items.length === 1 && s.totalDeductions === 40 && s.returned === 960);
s = depositStatement({ held: 1000.1, deductions: [{ desc: "a", amount: 0.2 }, { desc: "b", amount: 0.1 }], balanceBefore: 0 });
ok("cents do not drift", s.returned === 999.8 && s.totalDeductions === 0.3);
s = depositStatement({ held: 1800, interest: 27, deductions: [], balanceBefore: 0 });
ok("interest on the deposit is returned with it", s.returned === 1827);
for (const c of [{ held: 1800, d: 250, b: 0 }, { held: 2000, d: 300, b: 500 }, { held: 2000, d: 2500, b: 0 }, { held: 1000, d: 0, b: 1800 }, { held: 1500, d: 0, b: -200 }]) {
  const st = depositStatement({ held: c.held, deductions: [{ desc: "x", amount: c.d }], balanceBefore: c.b });
  const end = c.b + c.d - c.held;   // what the tenant's ledger ends at after the move-out's entries
  ok(`ledger ${end}: the statement says exactly that (returned ${st.returned}, owed ${st.owed})`, Math.abs((st.owed - st.returned) - end) < 0.005);
}
ok("the itemised list is one line per item", deductionsText([{ desc: "Carpet", amount: 250 }, { desc: "", amount: 40 }]) === "Carpet: $250.00\nDeduction: $40.00" && deductionsText([]) === "Nothing was withheld for damage.");
ok("the statement is due a set number of days after the tenancy ends", depositDueBy("2026-10-22", 45) === "2026-12-06" && depositDueBy("2026-10-22", 30) === "2026-11-21" && depositDueBy("", 45) === "");
const v = depositStatementValues(depositStatement({ held: 1800, deductions: [{ desc: "Carpet", amount: 250 }], balanceBefore: 0 }), { moveOutDate: "2026-10-22", forwardingAddress: "12 New St" });
ok("the statement's fields are filled from that arithmetic", v.deposit_held === "$1,800.00" && v.total_deductions === "$250.00" && v.amount_returned === "$1,550.00" && v.balance_owed === "$0.00" && v.deductions_list === "Carpet: $250.00" && v.forwarding_address === "12 New St" && v.move_out_date === "2026-10-22");

// ── wiring
const tenants = read("src/components/Tenants.js"), life = read("src/components/Lifecycle.js"), notices = read("src/components/Notices.js"),
  card = read("src/components/TenancyDocuments.js"), page = read("src/components/TenantPage.js"), std = read("src/utils/standardTemplates.js"),
  mig = read("supabase/migrations/20261003050000_notice_and_forwarding.sql"), prospects = read("src/components/Prospects.js");
ok("the status-only 'Generate Move-Out Notice' is gone", !/generateMoveOutNotice/.test(tenants) && !/Generate Move-Out Notice/.test(tenants));
ok("recording notice writes who gave it and when, with the move-out date", /\.update\(\{ lease_status: "notice", move_out: moveOutDate, notice_given_on: noticeDate, notice_given_by: givenBy \}\)\s*\.eq\("company_id", companyId\)\.eq\("id", tenant\.id\)/.test(notices));
ok("the lease is not ended by a notice", !/from\("leases"\)/.test(notices));
ok("the notice is then written up in the builder for that tenant by id", /templateKey: noticeTemplateFor\(givenBy\), tenantId: Number\(tenant\.id\), returnTo,/.test(notices));
ok("bulk notice records the same two facts", /notice_given_on: formatLocalDate\(new Date\(\)\), notice_given_by: "landlord"/.test(tenants));
ok("the tenant page shows who gave notice and when", /Given by you/.test(page) && /Given by tenant/.test(page));
ok("a late rent notice is offered only when something is owed, with the amount", /safeNum\(t\.balance\) > 0 \? \[\{ label: "Late rent notice"/.test(tenants) && /total_due: formatCurrency\(t\.balance\)/.test(tenants));
ok("move-out from the tenant page carries the tenant", /setPage\("moveout", \{ tenantId: t\.id \}\)/.test(tenants) && /const id = initialAction\?\.tenantId;/.test(life));
ok("a tenant on notice opens the wizard on their move-out date", /=== "notice" && t\.move_out\) setMoveOutDate\(/.test(life));
ok("the forwarding address is saved before the tenant is archived", life.indexOf("forwarding_address: forwardingAddress.trim() || null") > 0 && life.indexOf("forwarding_address: forwardingAddress.trim() || null") < life.indexOf('supabase.rpc("move_out_commit_state"'));
ok("the finished screen writes the statement from what the move-out actually posted", /depositStatement\(\{ held: depositAmount, released: releasedAmount, deductions, balanceBefore: outstandingBalance, waived: arAction === "waive" \}\)/.test(life));
ok("the statement opens for the former tenant by id and returns to their page", /templateKey: "deposit_disposition", tenantId: Number\(summary\.tenantId\)/.test(life));
ok("a prospect with a lease for the vacated home is pointed out", /\.in\("status", \["signed", "lease_sent"\]\)/.test(life) && /has \{waiting\.status === "signed" \? "a signed lease" : "a lease out for signature"\} for this home/.test(life));
ok("a notice can be marked served, with how", /served_at: serving\.date \+ "T12:00:00Z", served_method: serving\.method/.test(card) && /\["certified", "Certified mail"\]/.test(card));
ok("only notices are 'served'; a lease is signed", /SERVED_KINDS = \["notice_to_vacate", "rent_increase_notice", "late_notice", "notice_of_intent", "move_out_acknowledgment", "deposit_disposition"\]/.test(card));
ok("Prospects shows when an occupied home becomes available", /available from " \+ fmtDate\(untilOf\(occ\)\)/.test(prospects));
for (const key of ["move_out_acknowledgment", "notice_to_vacate", "late_fee_notice", "deposit_disposition"]) ok("standard template '" + key + "' is defined and unsigned", new RegExp("\\n  " + key + ": \\{\\s*name: \"[^\"]+\", category: \"notices\", template_type: \"html\", signing_mode: \"none\"").test(std));
for (const [key, names] of [["move_out_acknowledgment", ["notice_received", "move_out_date", "deposit_days"]], ["notice_to_vacate", ["notice_date", "vacate_date", "vacate_reason"]], ["late_fee_notice", ["total_due", "rent_period"]], ["deposit_disposition", ["move_out_date", "forwarding_address", "deposit_held", "deposit_interest", "deductions_list", "total_deductions", "other_owed", "amount_returned", "balance_owed"]]]) {
  const block = std.slice(std.indexOf("\n  " + key + ": {"), std.indexOf("\n  },", std.indexOf("\n  " + key + ": {")));
  ok(key + ": has every field the app fills, and prints each one", names.every(x => block.includes('field("' + x + '"') && block.includes("{{" + x + "}}")), names.filter(x => !block.includes('field("' + x + '"') || !block.includes("{{" + x + "}}")).join(","));
}
ok("the database records who gave notice as one of two values", /notice_given_by IN \('tenant', 'landlord'\)/.test(mig) && /ADD COLUMN IF NOT EXISTS forwarding_address text/.test(mig) && !/\bDROP\b/.test(mig));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
