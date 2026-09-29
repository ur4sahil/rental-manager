// Autopay and online (Stripe) payments — theme E.
//
//  1. Rent receipts settle the tenant's OWN AR instead of booking new income
//  2. autoOwnerDistribution no longer always bails (accrual lookup fixed)
//  3. Move-out proration finds the real RECUR- rent charge
//  4. Stripe autopay cron: idempotency key + atomic period claim
//  5. ACH autopay stored/charged as ACH, not card
//  6. "Run Now" never books a Stripe schedule; payments row only after the JE
//  7. Refunds / disputes reverse the payment's journal entry
//  8. Stripe payments carry tenant_id (tenant portal visibility)
//  9. Webhook JE: next_je_number, local business date, property class
// 10. Autopay schedules store and match by tenant_id
//
// QA fixes (2026-09-28, independent QA run against TEST with Stripe stubbed):
// Q1  concurrent charge.refunded events over-reversed  -> stripe_post_reversal RPC (lock + cap)
// Q2  refund then dispute exceeded booked rent          -> disputes go through the same RPC
// Q3  dispute won delivered before created              -> durable 'won' marker; created skips
// Q4  stale partial refund downgraded refunded          -> status only moves forward
// Q5  AR creation race sent receipts to Rental Income   -> stripe_tenant_ar RPC; 500 not income;
//                                                          client getOrCreateTenantAR fixed
// Q6  async ACH failure never released the claim        -> payment_failed releases it
// Q7  next_charge_date from "today" skipped months      -> nextChargeDateAfterPeriod
// Q8  cron accepted only POST (Vercel Cron sends GET)
// Q9  cron accepted any signed-in user                  -> CRON_SECRET or company admin, scoped
// Q10 Run Now credited Rental Income for an unmatched tenant -> refused
// minor: no dead-end "Run again?" confirm; no housify365.com worker fallback;
//        move-out proration only looks at RENT schedules
//
// QA re-test (v2):
// N1  a LATE failure of an EARLIER attempt reopened a period a later attempt paid
//     -> release only for the schedule's current attempt (last_payment_intent_id)
//        and never for a paid period (last_paid_period)
// N2  status regressions (dispute on refunded -> "disputed"; won on partially
//     refunded -> "paid"; partial refund overwrote "disputed"; created+won race)
//     -> payments.status derived from the books under the payment's lock
// P1  refund/dispute of a payment whose entry was VOIDED returned 500 forever -> 200
// P2  inquiries (warning_*) reversed money -> no-op until escalated
//
// Part 1: pure helpers (src/utils/paymentRules.js).
// Part 2: static checks that each call site uses them.
// Part 3: api/stripe.js handlers driven end-to-end with a MOCKED Stripe
//         client and an in-memory Supabase fake (no network).
// Part 4: read-only query-shape check against the TEST project.
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n     " + detail : "")); }
}

const R = require(path.join(root, "src/utils/paymentRules.js"));

// ─── 1. PURE HELPERS ──────────────────────────────────────────────────────
console.log("\n🧾 1. RECEIPT ACCOUNT SELECTION");
{
  const own = { id: "ar-42", name: "AR - Jo (1 Main)", tenant_id: 42 };
  const c = R.pickRentReceiptCredit({ tenantAr: own, tenantId: 42 });
  assert("tenant's own AR -> credit it", c.kind === "tenant_ar" && c.account_id === "ar-42" && c.settlesAr);
  assert("tenant_id compared as string (42 vs '42')", R.pickRentReceiptCredit({ tenantAr: own, tenantId: "42" }).kind === "tenant_ar");
  assert("bare 1100 parent (no tenant_id) is NOT the tenant's AR -> income", R.pickRentReceiptCredit({ tenantAr: { id: "p", tenant_id: null }, tenantId: 42 }).kind === "income");
  assert("another tenant's AR -> income, never a sibling's", R.pickRentReceiptCredit({ tenantAr: { id: "x", tenant_id: 43 }, tenantId: 42 }).kind === "income");
  assert("no AR at all -> Rental Income 4000", (() => { const r = R.pickRentReceiptCredit({ tenantAr: null, tenantId: 42 }); return r.account_id === "4000" && !r.settlesAr; })());
  assert("no tenant -> income", R.pickRentReceiptCredit({ tenantAr: own, tenantId: null }).kind === "income");
  assert("no args -> income (no throw)", R.pickRentReceiptCredit().kind === "income");
}

console.log("\n📅 2. RENT-CHARGE (ACCRUAL) LOOKUP");
{
  for (const ref of ["RECUR-6a0e0d78-2026-09", "RENT1-T12-20260901", "PRORENT-T12-20260915", "RENT-AUTO-7-2026-09", "ACCR-2026-09-x"]) {
    assert(`${ref} is a rent charge`, R.isRentChargeReference(ref));
  }
  for (const ref of ["APAY-12-20260901", "STRIPE-pi_1", "LATE-12-2026-09", "MANUAL-abc", "", null, "XRECUR-1"]) {
    assert(`${JSON.stringify(ref)} is NOT a rent charge`, !R.isRentChargeReference(ref));
  }
  const L = (ref, date, extra = {}) => ({ account_id: "ar", debit: 1500, acct_journal_entries: { reference: ref, date, status: "posted" }, ...extra });
  assert("RECUR debit on tenant AR in month -> true", R.hasRentChargeInMonth([L("RECUR-abcdefgh-2026-09", "2026-09-01")], ["ar"], "2026-09"));
  assert("embedded entry as 1-element array is read", R.hasRentChargeInMonth([{ account_id: "ar", debit: 5, acct_journal_entries: [{ reference: "RECUR-a-2026-09", date: "2026-09-30", status: "posted" }] }], ["ar"], "2026-09"));
  assert("charge in another month -> false", !R.hasRentChargeInMonth([L("RECUR-a-2026-08", "2026-08-31")], ["ar"], "2026-09"));
  assert("voided charge -> false", !R.hasRentChargeInMonth([{ ...L("RECUR-a-2026-09", "2026-09-01"), acct_journal_entries: { reference: "RECUR-a-2026-09", date: "2026-09-01", status: "voided" } }], ["ar"], "2026-09"));
  assert("credit (a payment) -> false", !R.hasRentChargeInMonth([L("RECUR-a-2026-09", "2026-09-01", { debit: 0 })], ["ar"], "2026-09"));
  assert("different account -> false", !R.hasRentChargeInMonth([L("RECUR-a-2026-09", "2026-09-01")], ["other"], "2026-09"));
  assert("late fee debit on the AR -> false", !R.hasRentChargeInMonth([L("LATE-1-2026-09", "2026-09-06")], ["ar"], "2026-09"));
  assert("no AR accounts -> false", !R.hasRentChargeInMonth([L("RECUR-a-2026-09", "2026-09-01")], [], "2026-09"));
  assert("monthBounds Feb 2028 (leap)", R.monthBounds("2028-02").end === "2028-02-29");
}

console.log("\n🚪 3. MOVE-OUT PRORATION LOOKUP");
{
  const sid = "6a0e0d78-1111-2222-3333-444455556666";
  assert("RECUR ref mirrors autoPostRecurringEntries", R.recurringRentRef(sid, "2026-09") === "RECUR-6a0e0d78-2026-09");
  const acc = read("src/utils/accounting.js");
  assert("…and autoPostRecurringEntries still builds it that way", acc.includes('const ref = "RECUR-" + (entry.id || shortId()).toString().slice(0, 8) + "-" + monthStr;'));
  const refs = R.recurringRentRefsForMonth([sid, sid, "ffffffff-0", null, ""], "2026-09");
  assert("refs de-duplicated, blanks dropped", refs.length === 2 && refs[0] === "RECUR-6a0e0d78-2026-09" && refs[1] === "RECUR-ffffffff-2026-09");
  const hit = R.pickMoveOutRentCharge([{ id: 1, reference: "RECUR-ffffffff-2026-09", status: "posted" }], refs);
  assert("finds the tenant's RECUR charge", hit?.id === 1);
  assert("voided charge is ignored", R.pickMoveOutRentCharge([{ id: 1, reference: refs[0], status: "voided" }], refs) === null);
  assert("unrelated reference is ignored", R.pickMoveOutRentCharge([{ id: 1, reference: "RECUR-00000000-2026-09", status: "posted" }], refs) === null);
  assert("preference follows refs order", R.pickMoveOutRentCharge([{ id: 2, reference: refs[1] }, { id: 1, reference: refs[0] }], refs).id === 1);
  assert("empty inputs -> null", R.pickMoveOutRentCharge(null, null) === null);
}

console.log("\n🔑 4. IDEMPOTENCY KEY / PERIOD");
{
  assert("key = autopay-<id>-<YYYY-MM>-<attempt day>", R.autopayIdempotencyKey("sched-1", "2026-10", "2026-10-01") === "autopay-sched-1-2026-10-2026-10-01");
  assert("key from a full due date uses its month", R.autopayIdempotencyKey("s", "2026-10-01", "2026-10-02") === "autopay-s-2026-10-2026-10-02");
  assert("same schedule + period + day -> same key (overlapping runs / HTTP retry cannot double-charge)", R.autopayIdempotencyKey("s", "2026-10-01", "2026-10-03") === R.autopayIdempotencyKey("s", "2026-10-28", "2026-10-03"));
  assert("retry on a LATER day -> new key (a decline is not replayed; a replaced card is not rejected)", R.autopayIdempotencyKey("s", "2026-10", "2026-10-03") !== R.autopayIdempotencyKey("s", "2026-10", "2026-10-04"));
  assert("next period -> different key", R.autopayIdempotencyKey("s", "2026-10", "2026-10-01") !== R.autopayIdempotencyKey("s", "2026-11", "2026-10-01"));
  { let t = false; try { R.autopayIdempotencyKey("s", "2026-10"); } catch { t = true; } assert("key without an attempt date throws", t); }
  let threw = false; try { R.autopayIdempotencyKey("s", null); } catch { threw = true; }
  assert("missing period throws (never a key without a period)", threw);
  threw = false; try { R.autopayIdempotencyKey("", "2026-10"); } catch { threw = true; }
  assert("missing schedule id throws", threw);
  assert("billingPeriodOf rejects garbage", R.billingPeriodOf("abc") === null && R.billingPeriodOf(undefined) === null);
}

console.log("\n🏦 5. PAYMENT METHOD TYPE -> METHOD");
{
  assert("card -> stripe_card", R.autopayMethodFromPmType("card") === "stripe_card");
  assert("us_bank_account -> stripe_us_bank_account", R.autopayMethodFromPmType("us_bank_account") === "stripe_us_bank_account");
  assert("unknown/missing -> stripe_card (existing default fee)", R.autopayMethodFromPmType("link") === "stripe_card" && R.autopayMethodFromPmType(undefined) === "stripe_card");
  assert("fee logic reads the same value", R.isAchAutopayMethod(R.autopayMethodFromPmType("us_bank_account")) && !R.isAchAutopayMethod(R.autopayMethodFromPmType("card")));
}

console.log("\n↩️  7. REFUND / DISPUTE REVERSAL BUILDER");
{
  const orig = [
    { account_id: "1015", account_name: "Stripe Receivable", debit: 1500, credit: 0, class_id: "c1", memo: "x" },
    { account_id: "ar", account_name: "AR - Jo", debit: 0, credit: 1500, class_id: "c1", memo: "y" },
  ];
  const full = R.buildReversalLines(orig, 150000, "refund");
  const dr = full.reduce((a, l) => a + l.debit, 0), cr = full.reduce((a, l) => a + l.credit, 0);
  assert("full reversal swaps sides", full.find(l => l.account_id === "ar").debit === 1500 && full.find(l => l.account_id === "1015").credit === 1500);
  assert("full reversal balances", Math.abs(dr - cr) < 0.001 && dr === 1500);
  assert("class_id carried", full.every(l => l.class_id === "c1"));
  const part = R.buildReversalLines(orig, 33333, "p");
  assert("partial reversal = requested cents", part.find(l => l.account_id === "ar").debit === 333.33 && part.find(l => l.account_id === "1015").credit === 333.33);
  assert("over-ask is capped at the original", R.buildReversalLines(orig, 999999).find(l => l.account_id === "ar").debit === 1500);
  const three = R.buildReversalLines([
    { account_id: "a", debit: 0.01, credit: 0 }, { account_id: "b", debit: 0.02, credit: 0 }, { account_id: "c", debit: 0, credit: 0.03 },
  ], 2);
  const d3 = Math.round(three.reduce((a, l) => a + l.debit, 0) * 100), c3 = Math.round(three.reduce((a, l) => a + l.credit, 0) * 100);
  assert("rounding absorbed so DR == CR to the cent", d3 === 2 && c3 === 2);
  assert("zero / empty -> no lines", R.buildReversalLines(orig, 0).length === 0 && R.buildReversalLines([], 100).length === 0);
  assert("refund ref keyed on charge + cumulative", R.refundReference("ch_1", 5000) === "STRIPE-REFUND-ch_1-5000");
  assert("dispute refs", R.disputeReference("dp_1") === "STRIPE-DISPUTE-dp_1" && R.disputeWonReference("dp_1") === "STRIPE-DISPUTE-WON-dp_1");
  assert("refund delta: first partial", R.refundDeltaCents(150000, 50000, 0) === 50000);
  assert("refund delta: second step reverses only the difference", R.refundDeltaCents(150000, 120000, 50000) === 70000);
  assert("refund delta: gross refund (rent+fee) capped at rent", R.refundDeltaCents(150000, 154800, 120000) === 30000);
  assert("refund delta: resend reverses nothing", R.refundDeltaCents(150000, 154800, 150000) === 0);
}

console.log("\n🕗 9. LOCAL BUSINESS DATE");
{
  // 2026-10-01T02:30Z is still Sept 30 in New York (EDT, UTC-4).
  assert("UTC past midnight -> previous day in New York", R.localBusinessDate(new Date("2026-10-01T02:30:00Z")) === "2026-09-30");
  assert("…which is the month-end case that mattered", new Date("2026-10-01T02:30:00Z").toISOString().slice(0, 10) === "2026-10-01");
  assert("winter (EST, UTC-5)", R.localBusinessDate(new Date("2026-01-01T04:59:00Z")) === "2025-12-31" && R.localBusinessDate(new Date("2026-01-01T05:00:00Z")) === "2026-01-01");
  assert("explicit zone honoured", R.localBusinessDate(new Date("2026-10-01T02:30:00Z"), "UTC") === "2026-10-01");
  assert("format YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(R.localBusinessDate()));
}

console.log("\n👤 10. SCHEDULE -> TENANT MATCH");
{
  const T = [{ id: 1, name: "Jo Smith", property: "1 Main" }, { id: 2, name: "Jo Smith", property: "2 Oak" }, { id: 3, name: "Al", property: "1 Main" }];
  assert("by tenant_id", R.matchAutopayTenant(T, { tenant_id: 2, tenant: "Jo Smith", property: "1 Main" })?.id === 2);
  assert("tenant_id wins over a mismatching name (renamed tenant)", R.matchAutopayTenant(T, { tenant_id: 3, tenant: "Old Name" })?.id === 3);
  assert("tenant_id not found -> null, never a name fallback", R.matchAutopayTenant(T, { tenant_id: 99, tenant: "Al", property: "1 Main" }) === null);
  assert("legacy: name (case-insensitive) + property", R.matchAutopayTenant(T, { tenant: "jo smith", property: "2 Oak" })?.id === 2);
  assert("legacy: ambiguous -> null", R.matchAutopayTenant([...T, { id: 4, name: "Al", property: "1 Main" }], { tenant: "Al", property: "1 Main" }) === null);
  assert("stripe schedule detection", R.isStripeSchedule({ provider: "stripe" }) && R.isStripeSchedule({ provider: "Stripe" }) && !R.isStripeSchedule({ provider: "manual" }) && !R.isStripeSchedule(null));
}

// ─── 2. STATIC CHECKS ─────────────────────────────────────────────────────
console.log("\n📆 Q7. NEXT CHARGE DATE = the month AFTER the claimed period");
{
  assert("overdue: due 2026-08-01 charged 2026-09-28 -> next 2026-09-01 (September billed next)", R.nextChargeDateAfterPeriod(R.billingPeriodOf("2026-08-01"), 1) === "2026-09-01");
  assert("charged on Oct 31 for October -> 2026-11-01 (November not skipped)", R.nextChargeDateAfterPeriod("2026-10", 1) === "2026-11-01");
  assert("day 31, January -> February 28", R.nextChargeDateAfterPeriod("2026-01", 31) === "2026-02-28");
  assert("day 31, January of a leap year -> February 29", R.nextChargeDateAfterPeriod("2028-01", 31) === "2028-02-29");
  assert("day 30 after February -> March 30 (clamp per month, not sticky)", R.nextChargeDateAfterPeriod("2026-02", 30) === "2026-03-30");
  assert("day 31, March -> April 30", R.nextChargeDateAfterPeriod("2026-03", 31) === "2026-04-30");
  assert("December rolls the year", R.nextChargeDateAfterPeriod("2026-12", 15) === "2027-01-15");
  assert("day 29-31 honoured when the month has it", R.nextChargeDateAfterPeriod("2026-06", 31) === "2026-07-31");
  assert("missing / 0 day -> the 1st", R.nextChargeDateAfterPeriod("2026-05", 0) === "2026-06-01" && R.nextChargeDateAfterPeriod("2026-05", null) === "2026-06-01");
  assert("garbage period -> null (never a guessed date)", R.nextChargeDateAfterPeriod("abc", 1) === null && R.nextChargeDateAfterPeriod(undefined, 1) === null);
  assert("chargeDateInPeriod clamps to the month", R.chargeDateInPeriod("2026-02", 31) === "2026-02-28" && R.chargeDateInPeriod("2026-09", 5) === "2026-09-05");
  // Every month of two years: next is always exactly one calendar month on.
  let ok = true;
  for (let y = 2026; y <= 2027; y++) for (let m = 1; m <= 12; m++) for (const d of [1, 15, 28, 29, 30, 31]) {
    const per = y + "-" + String(m).padStart(2, "0");
    const n = R.nextChargeDateAfterPeriod(per, d);
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    if (n !== ny + "-" + String(nm).padStart(2, "0") + "-" + String(Math.min(d, last)).padStart(2, "0")) { ok = false; break; }
  }
  assert("24 months x 6 days: always the next calendar month, day clamped", ok);
}

console.log("\n🚦 Q4. PAYMENT STATUS ONLY MOVES FORWARD");
{
  assert("refunded blocks a stale partially_refunded", !R.paymentStatusMayMove("refunded", "partially_refunded"));
  assert("paid -> partially_refunded allowed", R.paymentStatusMayMove("paid", "partially_refunded"));
  assert("partially_refunded -> refunded allowed", R.paymentStatusMayMove("partially_refunded", "refunded"));
  assert("dispute_lost blocks a late 'disputed'", !R.paymentStatusMayMove("dispute_lost", "disputed"));
  assert("blockers: partially_refunded never overwrites refunded / disputed / dispute_lost", JSON.stringify(R.paymentStatusBlockers("partially_refunded")) === '["refunded","disputed","dispute_lost"]');
  assert("blockers: a refunded payment is never marked disputed", !R.paymentStatusMayMove("refunded", "disputed") && !R.paymentStatusMayMove("refunded", "dispute_lost"));
  assert("blockers: paid never overwrites a refund / dispute state", ["partially_refunded", "refunded", "disputed", "dispute_lost"].every(c => !R.paymentStatusMayMove(c, "paid")));
  assert("blockers: paid -> disputed -> dispute_lost allowed", R.paymentStatusMayMove("paid", "disputed") && R.paymentStatusMayMove("disputed", "dispute_lost"));
}

console.log("\n🧮 N2. payments.status DERIVED FROM THE BOOKS (mirrors _stripe_sync_payment_status)");
{
  const D = R.derivePaymentStatus;
  assert("nothing reversed -> paid", D({ bookedCents: 100000 }) === "paid");
  assert("partial refund -> partially_refunded", D({ bookedCents: 100000, refundedCents: 30000 }) === "partially_refunded");
  assert("refunds >= booked -> refunded", D({ bookedCents: 100000, refundedCents: 100000 }) === "refunded");
  assert("Stripe says fully refunded -> refunded", D({ bookedCents: 100000, refundedCents: 50000, refundFull: true }) === "refunded");
  assert("refunded is sticky (a stale partial event cannot regress it)", D({ bookedCents: 100000, refundedCents: 30000, current: "refunded" }) === "refunded");
  assert("open dispute outranks a partial refund (a late partial-refund event cannot overwrite disputed)", D({ bookedCents: 100000, refundedCents: 30000, openDisputes: 1, current: "disputed" }) === "disputed");
  assert("dispute WON on a partially refunded payment -> partially_refunded (not paid)", D({ bookedCents: 100000, refundedCents: 30000, openDisputes: 0, current: "disputed" }) === "partially_refunded");
  assert("dispute won, no refunds -> paid", D({ bookedCents: 100000, current: "disputed" }) === "paid");
  assert("lost outranks everything", D({ bookedCents: 100000, lostDisputes: 1, openDisputes: 1, refundedCents: 100000 }) === "dispute_lost");
  assert("a dispute that reversed nothing is not counted -> refunded stays", D({ bookedCents: 100000, refundedCents: 100000, openDisputes: 0, current: "refunded" }) === "refunded");
}

console.log("\n🕵️  P2. DISPUTE EVENT -> BOOKS ACTION (inquiries move no money)");
{
  const A = R.disputeEventAction;
  for (const st of ["warning_needs_response", "warning_under_review", "warning_closed"]) {
    for (const ev of ["charge.dispute.created", "charge.dispute.updated", "charge.dispute.funds_withdrawn", "charge.dispute.closed"]) assert(`inquiry ${st} on ${ev.slice(15)} -> noop`, A(ev, st) === "noop");
  }
  assert("chargeback created (needs_response) -> reverse", A("charge.dispute.created", "needs_response") === "reverse");
  assert("escalated inquiry: funds_withdrawn needs_response -> reverse", A("charge.dispute.funds_withdrawn", "needs_response") === "reverse");
  assert("escalated inquiry: updated needs_response / under_review -> reverse", A("charge.dispute.updated", "needs_response") === "reverse" && A("charge.dispute.updated", "under_review") === "reverse");
  assert("closed lost -> lost; won -> won", A("charge.dispute.closed", "lost") === "lost" && A("charge.dispute.closed", "won") === "won");
  assert("unchallengeable dispute created already lost -> lost", A("charge.dispute.created", "lost") === "lost");
  assert("created whose snapshot is won -> noop (never reverse a won dispute)", A("charge.dispute.created", "won") === "noop");
  assert("updated with won/lost -> noop (closed handles it)", A("charge.dispute.updated", "won") === "noop" && A("charge.dispute.updated", "lost") === "noop");
  assert("charge_refunded status -> noop", A("charge.dispute.closed", "charge_refunded") === "noop" && A("charge.dispute.updated", "charge_refunded") === "noop");
  assert("unknown event -> noop", A("charge.dispute.funds_reinstated", "won") === "noop");
}

console.log("\n🔐 Q9. WHO MAY RUN THE AUTOPAY CHARGER");
{
  const m = [
    { company_id: "a", role: "admin", status: "active" }, { company_id: "b", role: "Admin", status: "active" },
    { company_id: "c", role: "admin", status: "pending" }, { company_id: "d", role: "owner", status: "active" },
    { company_id: "e", role: "tenant", status: "active" }, { company_id: "f", role: "manager", status: "active" },
    { company_id: "a", role: "admin", status: "active" },
  ];
  assert("only ACTIVE ADMIN companies, de-duplicated", JSON.stringify(R.autopayRunCompanyIds(m)) === '["a","b"]');
  assert("owner-portal role 'owner' cannot charge tenants' cards", !R.autopayRunCompanyIds(m).includes("d"));
  assert("no memberships -> none", R.autopayRunCompanyIds(null).length === 0);
}

console.log("\n🏠 minor. MOVE-OUT PRORATION LOOKS AT RENT SCHEDULES ONLY");
{
  assert("schedule crediting the 4000 account id -> rent", R.isRentSchedule({ credit_account_id: "uuid-4000" }, ["uuid-4000"]));
  assert("legacy code '4000' -> rent", R.isRentSchedule({ credit_account_id: "4000" }, []));
  assert("named Rental Income -> rent", R.isRentSchedule({ credit_account_id: "x", credit_account_name: "Rental Income" }, []));
  assert("pet fee crediting Other Income -> not rent", !R.isRentSchedule({ credit_account_id: "uuid-4100", credit_account_name: "Other Income" }, ["uuid-4000"]));
  assert("null -> not rent", !R.isRentSchedule(null, ["uuid-4000"]));
}

console.log("\n🧾 Q5. CLIENT getOrCreateTenantAR RULES (pure parts)");
{
  assert("legacy name: single unlinked account -> adopt", R.pickLegacyNamedArAccount([{ id: "x", tenant_id: null }], 7)?.id === "x");
  assert("legacy name: linked to a DIFFERENT tenant (archived row) -> never", R.pickLegacyNamedArAccount([{ id: "x", tenant_id: 3 }], 7) === null);
  assert("legacy name: linked to this tenant -> it", R.pickLegacyNamedArAccount([{ id: "x", tenant_id: 7 }], "7")?.id === "x");
  assert("legacy name: two same-name accounts -> ambiguous, none", R.pickLegacyNamedArAccount([{ id: "x", tenant_id: null }, { id: "y", tenant_id: null }], 7) === null);
  assert("legacy name without a tenant id -> the single account (unchanged)", R.pickLegacyNamedArAccount([{ id: "x", tenant_id: 3 }], null)?.id === "x");
  assert("next AR sequence is numeric max + 1", R.nextTenantArSeq(["1100-009", "1100-1000", "1100-999", "1100", "x"]) === 1001 && R.nextTenantArSeq([]) === 1);
  assert("…bumped on a retry after a collision", R.nextTenantArSeq(["1100-004"], 2) === 7);
}

console.log("\n🔍 STATIC: call sites");
const pay = read("src/components/Payments.js");
const acct = read("src/utils/accounting.js");
const life = read("src/components/Lifecycle.js");
const api = read("api/stripe.js");
const runNow = pay.slice(pay.indexOf("async function runNow("), pay.indexOf("function nextDue("));
// 1
assert("#1 runNow no longer uses checkAccrualExists", !runNow.includes("checkAccrualExists") && !pay.includes("checkAccrualExists"));
assert("#1 runNow credits via pickRentReceiptCredit + getOrCreateTenantAR", runNow.includes("pickRentReceiptCredit(") && runNow.includes("getOrCreateTenantAR("));
assert("#1 runNow never hard-codes a 4000 credit line", !/account_id: "4000"/.test(runNow));
assert("#1 runNow does not double-apply balance (trigger moves it)", /balanceUpdate: null/.test(runNow));
assert("#1 webhook credit chosen by pickRentReceiptCredit", /pickRentReceiptCredit\(\{ tenantAr: tenantAR, tenantId \}\)/.test(api));
assert("#1 webhook no longer 500s when the tenant has no AR (creates it)", !api.includes("tenant has no AR sub-account — fix tenant data integrity") && api.includes("getOrCreateTenantArServer(sb, companyId, tenantId"));
// 2
// The id-keyed rent-charge check moved to utils/ownerRules.js
// (tenantRentChargeInMonth) so the Stripe webhook runs the same code;
// checkAccrualExists delegates to it and keeps the legacy name path.
const cae = acct.slice(acct.indexOf("export async function checkAccrualExists"), acct.indexOf("// ============ OWNER DISTRIBUTION AUTOMATION"));
const ownerRulesSrc = read("src/utils/ownerRules.js");
const trc = ownerRulesSrc.slice(ownerRulesSrc.indexOf("async function tenantRentChargeInMonth"), ownerRulesSrc.indexOf("async function runOwnerDistributionAccrual"));
assert("#2 accrual lookup covers every rent family", cae.includes("RENT_CHARGE_PREFIXES") && trc.includes("hasRentChargeInMonth("));
assert("#2 accrual lookup keyed on tenant_id AR accounts", /\.eq\("tenant_id", tenantId\)/.test(trc) && cae.includes("tenantRentChargeInMonth(supabase, companyId, month, tenantId)"));
assert("#2 failed read still answers 'could not tell' (true)", /if \(arErr\) return true;/.test(trc) && /if \(lErr\) return true;/.test(trc));
assert("#2 autoOwnerDistribution passes tenantId through", /autoOwnerDistribution\(companyId, propertyAddress, paymentAmount, paymentDate, tenantName, tenantId\)/.test(acct) && /checkAccrualExists\(companyId, month, tenantName, tenantId\)/.test(acct));
assert("#2 runNow passes tenant id to autoOwnerDistribution", /autoOwnerDistribution\(companyId, s\.property, amt, today, tenantDisplayName, tenantRow\?\.id \|\| null\)/.test(runNow));
// Fee math: integer cents, in the SQL accrual (owner_accrual_sync).
const ownerMig = read("supabase/migrations/20260928170000_owner_accrual_rpc.sql");
assert("#2 owner fee math in integer cents (SQL accrual)", ownerMig.includes("v_fee := round(v_d * v_pct / 100)::bigint;") && ownerMig.includes("p_net := p_net || (v_d - v_fee)") && acct.includes("syncOwnerAccruals(supabase, companyId, tenantId)"));
// 3
assert("#3 move-out looks up the tenant's recurring schedules by tenant_id", /from\("recurring_journal_entries"\)\s*\n?\s*\.select\("id, credit_account_id, credit_account_name"\)\.eq\("company_id", cid\)\.eq\("tenant_id", selectedTenant\.id\)/.test(life));
assert("#3 move-out uses recurringRentRefsForMonth + pickMoveOutRentCharge", life.includes("recurringRentRefsForMonth(") && life.includes("pickMoveOutRentCharge(rentCharges, moveOutRentRefs)"));
assert("#3 proration math unchanged", life.includes("const proratedCents = Math.round(fullRentCents * moveOutDay / daysInMoveOutMonth);") && life.includes("reference: `RENT-PRORATE-${selectedLease.id}-${moveOutMonth}`"));
// 4
const cron = api.slice(api.indexOf("async function handleChargeAutopayDue"), api.indexOf("// ── Action: webhook"));
assert("#4 idempotencyKey passed to paymentIntents.create", /idempotencyKey: autopayIdempotencyKey\(row\.id, period, today\)/.test(cron));
assert("#4 claim is a conditional update on the observed next_charge_date", /\.eq\("id", row\.id\)\.eq\("next_charge_date", claimedDate\)/.test(cron) && cron.indexOf("claimed by another run") < cron.indexOf("paymentIntents.create"));
assert("#4 failure releases the claim (retry next run, as before)", /next_charge_date: claimedDate,[\s\S]*?\.eq\("next_charge_date", nextDate\)/.test(cron));
assert("Q7 next date = month after the claimed period (no setMonth from today)", cron.includes("const nextDate = nextChargeDateAfterPeriod(period, row.day_of_month || 1);") && !cron.includes("setMonth("));
assert("Q8 cron accepts GET (Vercel Cron) and POST", /req\.method !== "GET" && req\.method !== "POST"/.test(cron));
assert("Q9 cron: constant-time CRON_SECRET bearer, else an active ADMIN's companies only", cron.includes("isCronSecretBearer(authHeader, CRON_SECRET)") && cron.includes("autopayRunCompanyIds(mems)") && cron.includes('dueQ.in("company_id", companyFilter)') && !/if \(user\) authed = true/.test(cron));
assert("Q6 cron records the claim in PI metadata", /claimed_date: claimedDate,/.test(cron) && /advanced_date: nextDate,/.test(cron));
// 5
assert("#5 save-payment-method stores method from PM type", /method: autopayMethodFromPmType\(pm\.type\)/.test(api) && !/method: "stripe_card"/.test(api));
assert("#5 cron fee reads isAchAutopayMethod", /const isAch = isAchAutopayMethod\(method\);/.test(cron));
assert("#5 fee formulas untouched", api.includes("const totalCents = Math.ceil((rentCents + 30) / 0.971);") && api.includes("const totalUncapped = Math.ceil(rentCents / 0.992);"));
// 6
assert("#6 runNow refuses Stripe schedules", /if \(isStripeSchedule\(s\)\)/.test(runNow) && runNow.indexOf("isStripeSchedule(s)") < runNow.indexOf("atomicPostJEAndLedger"));
assert("#6 Run Now button hidden for Stripe schedules", /isStripeSchedule\(s\)\s*\n?\s*\? <span[^>]*>Charged by Stripe automatically<\/span>/.test(pay));
assert("#6 payments row inserted only after the JE posted", runNow.indexOf('from("payments").insert') > runNow.indexOf("atomicPostJEAndLedger(") && /if \(!result\.jeId\) \{[^}]*return; \}/.test(runNow));
// 7
for (const ev of ["charge.refunded", "charge.dispute.created", "charge.dispute.closed"]) assert(`#7 webhook handles ${ev}`, api.includes(`"${ev}"`));
assert("#7 reversals use deterministic references", api.includes("refundReference(charge.id, charge.amount_refunded)") && api.includes("disputeReference(dispute.id)"));
assert("#7 refunds/disputes go through the same verified constructEvent", (api.match(/stripe\.webhooks\.constructEvent/g) || []).length === 1);
// QA fixes (static)
const whAll = api.slice(api.indexOf("async function handleWebhook"));
assert("Q1/Q2 refunds and disputes post through the stripe_post_reversal RPC (no JS read-then-write)", (whAll.match(/postStripeReversal\(sb, original/g) || []).length >= 3 && api.includes('sb.rpc("stripe_post_reversal"') && !whAll.includes("refundDeltaCents(") && !whAll.includes('.like("reference", "STRIPE-REFUND-"'));
assert("Q3 created skips a dispute already won (event status via disputeEventAction, marker via RPC); won posts through the RPC", whAll.includes("disputeEventAction(event.type, dispute.status)") && whAll.includes('r.skipped === "dispute_already_won"') && whAll.includes('kind: "dispute_won"'));
assert("N2 the webhook no longer writes refund/dispute statuses itself (the RPC derives them)", (whAll.match(/setPaymentStatus\(/g) || []).length === 3 && /findVoidedStripePaymentEntry/.test(whAll));
assert("N1 cron: claim clears last_payment_intent_id; the created PI becomes the current attempt; sync success marks the period paid", cron.includes("last_payment_intent_id: null })") && cron.includes("last_payment_intent_id: intent.id,") && cron.includes('intent.status === "succeeded" ? { last_paid_period: period }'));
assert("N1 payment_failed releases only for the current attempt of an unpaid period", /const isCurrent = !!intent\.id && cur\?\.last_payment_intent_id === intent\.id;/.test(api) && /isCurrent && !paid/.test(api) && /\.eq\("last_payment_intent_id", intent\.id\)/.test(api));
assert("P2 dispute events handled: created / updated / funds_withdrawn / closed", ["charge.dispute.updated", "charge.dispute.funds_withdrawn"].every(e => whAll.includes('"' + e + '"')));
const mig2 = read("supabase/migrations/20260928090000_autopay_current_attempt.sql");
assert("N1 migration adds last_payment_intent_id + last_paid_period", /ADD COLUMN IF NOT EXISTS last_payment_intent_id text/.test(mig2) && /ADD COLUMN IF NOT EXISTS last_paid_period text/.test(mig2));
assert("N2 migration: status derived under the lock; core renamed; new functions server-only", mig2.includes("RENAME TO _stripe_post_reversal_core") && mig2.includes("v_status := public._stripe_sync_payment_status(") &&
  /REVOKE ALL ON FUNCTION public\._stripe_sync_payment_status\(text, text, text, text, boolean\) FROM PUBLIC, anon, authenticated;/.test(mig2) &&
  /REVOKE ALL ON FUNCTION public\.stripe_post_reversal\(text, text, text, text, text, bigint, text, text, text, text, date, boolean\) FROM PUBLIC, anon, authenticated;/.test(mig2) &&
  /REVOKE ALL ON FUNCTION public\._stripe_post_reversal_core\([^)]*\) FROM PUBLIC, anon, authenticated;/.test(mig2));
assert("Q4 setPaymentStatus is a forward-only conditional update", /for \(const blocked of paymentStatusBlockers\(status\)\) q = q\.neq\("status", blocked\);/.test(api));
assert("Q5 receipt AR via the locked stripe_tenant_ar RPC", api.includes('sb.rpc("stripe_tenant_ar"'));
assert("Q5 an existing tenant without AR -> 500 (Stripe retries), never Rental Income", /else if \(!arLookup\.tenantMissing\) \{\s*return res\.status\(500\)/.test(api) && /if \(arLookup\.error\) \{[\s\S]{0,200}return res\.status\(500\)/.test(api));
assert("Q6 payment_failed releases the claim conditionally", /\.update\(\{ next_charge_date: claimedDate \}\)\s*\.eq\("id", autopayId\)\.eq\("next_charge_date", advancedDate\)/.test(api));
assert("minor: worker trigger never falls back to housify365.com", !/VERCEL_URL \|\| "housify365\.com"/.test(api) && api.includes("process.env.APP_URL"));
assert("Q10 Run Now refuses a schedule with no matched tenant (before any posting)", runNow.indexOf("if (!tenantRow?.id) {") > 0 && runNow.indexOf("if (!tenantRow?.id) {") < runNow.indexOf("atomicPostJEAndLedger("));
assert("Q10 Run Now refuses when the tenant's own AR is not established (no Rental Income credit)", /if \(!credit\.settlesAr\) \{[^}]*return;\s*\}/.test(runNow));
assert("minor: no dead-end 'Run again?' confirm; already-recorded is just reported", !runNow.includes("Run again?") && !runNow.includes("showConfirm(") && runNow.includes("already recorded today"));
assert("minor: move-out proration filters the tenant's schedules to RENT schedules", life.includes("filter(r => isRentSchedule(r, rentalIncomeIds))"));
const gocta = acct.slice(acct.indexOf("export async function getOrCreateTenantAR("), acct.indexOf("// INTENTIONAL NO-OP: Rent is handled"));
assert("Q5 client: tenant_id lookup does not use .maybeSingle() and picks via pickTenantArAccount", !/\.eq\("tenant_id", tenantId\)\.maybeSingle\(\)/.test(gocta) && gocta.includes("pickTenantArAccount(linked || [], tenantId)"));
assert("Q5 client: name fallback via pickLegacyNamedArAccount (never another tenant's)", gocta.includes("pickLegacyNamedArAccount(named || []"));
assert("Q5 client: exactly one insert, always with tenant_id + parent (no unlinked retry)", (gocta.match(/from\("acct_accounts"\)\.insert\(/g) || []).length === 1 && gocta.includes("parent_id: parentArId || null, tenant_id: hasTid ? tenantId : null"));
assert("Q5 client: the parent fallback is not cached", !/_tenantArCache\[cacheKey\] = parentArId/.test(gocta));
const mig = read("supabase/migrations/20260928070000_stripe_atomic_reversals_and_tenant_ar.sql");
for (const sig of ["public.stripe_post_reversal(text, text, text, text, text, bigint, text, text, text, text, date)", "public.stripe_tenant_ar(text, bigint)"]) {
  const esc = sig.replace(/[().]/g, "\\$&");
  assert("migration: REVOKE ALL ... FROM PUBLIC, anon, authenticated on " + sig, new RegExp("REVOKE ALL ON FUNCTION " + esc + " FROM PUBLIC, anon, authenticated;").test(mig));
  assert("migration: service_role EXECUTE on " + sig, new RegExp("GRANT EXECUTE ON FUNCTION " + esc + " TO service_role;").test(mig));
}
assert("migration: per-payment advisory lock + posted-only pool net of WON", mig.includes("pg_advisory_xact_lock(hashtext('stripe:' || p_payment_intent_id))") && mig.includes("e.status = 'posted'") && mig.includes("WHEN reference LIKE 'STRIPE-DISPUTE-WON-%' THEN -cents"));
assert("migration: cap = booked - already reversed", mig.includes("v_amt := LEAST(v_req, v_booked - v_already);"));
assert("migration: tenant AR under a per-tenant lock via _late_fee_tenant_ar", mig.includes("pg_advisory_xact_lock(hashtext('tenant_ar:'") && mig.includes("public._late_fee_tenant_ar(p_company_id, p_tenant_id, v_t.name, v_t.property)"));
assert("migration: marker table is server-only (RLS on, revoked from anon/authenticated)", mig.includes("ALTER TABLE public.stripe_dispute_outcomes ENABLE ROW LEVEL SECURITY;") && mig.includes("REVOKE ALL ON TABLE public.stripe_dispute_outcomes FROM PUBLIC, anon, authenticated;"));
// 8
assert("#8 webhook payments insert carries tenant_id", /from\("payments"\)\.insert\(\{[\s\S]{0,200}tenant_id: Number\(tenantId\) \|\| null/.test(api));
// 9
const wh = api.slice(api.indexOf("async function handleWebhook"));
assert("#9 webhook numbers via next_je_number (no created_at digit parsing)", api.includes('sb.rpc("next_je_number"') && !/order\("created_at", \{ ascending: false \}\)\.limit\(1\)/.test(api));
assert("#9 webhook dates with localBusinessDate", /const today = localBusinessDate\(\);/.test(wh) && !/const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/.test(wh));
assert("#9 webhook lines carry class_id from the property", wh.includes("resolvePropertyClassId(sb, companyId") && /class_id: classId/.test(wh));
// 10
assert("#10 saveSchedule stores tenant_id", /tenant_id: Number\(form\.tenant_id\)/.test(pay) && /if \(!form\.tenant \|\| !form\.tenant_id\)/.test(pay));
assert("#10 runNow matches by tenant_id first", /\.eq\("id", s\.tenant_id\)/.test(runNow) && runNow.includes("matchAutopayTenant("));
assert("paymentRules.js has no imports (loads in node + browser + api)", !/^\s*import\s/m.test(read("src/utils/paymentRules.js")) && !/require\(["']/.test(read("src/utils/paymentRules.js")));
assert("late-fee code untouched by this change", !pay.includes("late_fee_rules") && !api.includes("batch_post_late_fees"));

// ─── 3. HANDLERS WITH MOCKED STRIPE + FAKE SUPABASE ───────────────────────
console.log("\n🧪 HANDLERS (mocked Stripe, in-memory Supabase)");

function makeDb(seed) {
  const T = JSON.parse(JSON.stringify(seed));
  let seq = 1000;
  const jeNum = {};
  const cmp = (a, b) => {
    const na = Number(a), nb = Number(b);
    if (a !== null && b !== null && a !== "" && b !== "" && !isNaN(na) && !isNaN(nb) && typeof a !== "boolean") return na - nb;
    return String(a).localeCompare(String(b));
  };
  const likeRe = (p) => new RegExp("^" + String(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
  function embed(table, sel, rows) {
    return rows.map(r => {
      const o = { ...r };
      if (table === "acct_journal_entries" && /lines:acct_journal_lines\(/.test(sel)) o.lines = (T.acct_journal_lines || []).filter(l => l.journal_entry_id === r.id).map(l => ({ ...l }));
      if (table === "acct_journal_lines" && /acct_journal_entries(!inner)?\(/.test(sel)) o.acct_journal_entries = (T.acct_journal_entries || []).find(j => j.id === r.journal_entry_id) || null;
      return o;
    });
  }
  function from(table) {
    T[table] = T[table] || [];
    const st = { op: "select", filters: [], sel: "*", ret: false, single: null, limit: null, order: null, payload: null };
    const b = {
      select(sel) { if (st.op === "select") st.sel = sel || "*"; else { st.ret = true; st.sel = sel || "*"; } return b; },
      insert(p) { st.op = "insert"; st.payload = Array.isArray(p) ? p : [p]; return b; },
      update(p) { st.op = "update"; st.payload = p; return b; },
      delete() { st.op = "delete"; return b; },
      eq(c, v) { st.filters.push(r => String(r[c]) === String(v)); return b; },
      neq(c, v) { st.filters.push(r => String(r[c]) !== String(v)); return b; },
      is(c, v) { st.filters.push(r => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return b; },
      lte(c, v) { st.filters.push(r => r[c] != null && cmp(r[c], v) <= 0); return b; },
      gte(c, v) { st.filters.push(r => r[c] != null && cmp(r[c], v) >= 0); return b; },
      gt(c, v) { st.filters.push(r => r[c] != null && cmp(r[c], v) > 0); return b; },
      like(c, p) { const re = likeRe(p); st.filters.push(r => re.test(String(r[c] ?? ""))); return b; },
      ilike(c, p) { const re = new RegExp(likeRe(p).source, "i"); st.filters.push(r => re.test(String(r[c] ?? ""))); return b; },
      in(c, arr) { const s = new Set(arr.map(String)); st.filters.push(r => s.has(String(r[c]))); return b; },
      order(c, o) { st.order = { c, asc: o?.ascending !== false }; return b; },
      limit(n) { st.limit = n; return b; },
      range(a, z) { st.limit = z - a + 1; return b; },
      maybeSingle() { st.single = "maybe"; return b; },
      single() { st.single = "one"; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function run() {
      const rows = T[table];
      const match = rows.filter(r => st.filters.every(f => f(r)));
      let out;
      if (st.op === "insert") {
        const added = [];
        for (const p of st.payload) {
          const row = { id: p.id ?? (table === "tenants" || table === "payments" ? ++seq : "id-" + (++seq)), ...p };
          if (table === "acct_journal_entries") {
            const dupRef = row.reference && rows.some(r => r.company_id === row.company_id && r.reference === row.reference && r.status !== "voided");
            if (dupRef) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_je_company_reference_unique"' } };
            if (rows.some(r => r.company_id === row.company_id && r.number === row.number)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "unique_je_number_per_company"' } };
          }
          if (table === "acct_accounts" && row.code && rows.some(r => r.company_id === row.company_id && r.code === row.code)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "acct_accounts_company_code_unique"' } };
          if (T.__failInsert && T.__failInsert[table]) return { data: null, error: { code: "XX000", message: "forced failure" } };
          rows.push(row); added.push(row);
        }
        out = added;
        if (!st.ret) return { data: null, error: null };
      } else if (st.op === "update") {
        match.forEach(r => Object.assign(r, st.payload));
        out = match;
        if (!st.ret) return { data: null, error: null };
      } else if (st.op === "delete") {
        T[table] = rows.filter(r => !match.includes(r));
        return { data: null, error: null };
      } else out = match;
      if (st.order) out = [...out].sort((a, z) => (st.order.asc ? 1 : -1) * cmp(a[st.order.c], z[st.order.c]));
      if (st.limit != null) out = out.slice(0, st.limit);
      out = embed(table, st.sel, out);
      if (st.single) {
        if (out.length > 1) return { data: null, error: { message: "multiple rows" } };
        return { data: out[0] || null, error: null };
      }
      return { data: out, error: null };
    }
    return b;
  }
  const db = {
    T,
    from,
    rpc(fn, args) {
      if (fn === "next_je_number") {
        const cid = args.p_company_id;
        const max = (T.acct_journal_entries || []).filter(j => j.company_id === cid && /^JE-\d+$/.test(j.number || "")).reduce((m, j) => Math.max(m, parseInt(j.number.slice(3), 10)), 0);
        jeNum[cid] = (jeNum[cid] || 0) + 1;
        return Promise.resolve({ data: "JE-" + String(max + 1).padStart(4, "0"), error: null });
      }
      if (fn === "stripe_tenant_ar") return Promise.resolve(fakeStripeTenantAr(T, args));
      if (fn === "stripe_post_reversal") return this.rpc("next_je_number", { p_company_id: args.p_company_id }).then(({ data: num }) => fakeStripePostReversal(T, args, num));
      return Promise.resolve({ data: null, error: { message: "unknown rpc " + fn } });
    },
    auth: { getUser: async (tok) => ({ data: { user: ({ good: { email: "tenant@x.com" }, admin: { email: "admin@x.com" }, owner: { email: "owner@x.com" }, other: { email: "other@x.com" } })[tok] || null }, error: null }) },
  };
  return db;
}

// In-memory stand-ins for the two RPCs (supabase/migrations/20260928070000).
// They follow the SQL's rules so the handler logic can be driven here; the
// real SQL -- locks, caps, privileges -- is exercised against TEST in part 4.
function fakeStripeTenantAr(T, { p_company_id, p_tenant_id }) {
  if (T.__rpcError?.stripe_tenant_ar) return { data: null, error: { message: T.__rpcError.stripe_tenant_ar } };
  const t = (T.tenants || []).find(x => x.company_id === p_company_id && String(x.id) === String(p_tenant_id));
  if (!t) return { data: null, error: null };
  const mine = (T.acct_accounts || []).filter(a => a.company_id === p_company_id && a.type === "Asset" && String(a.tenant_id) === String(p_tenant_id))
    .sort((a, b) => (b.is_active !== false) - (a.is_active !== false) || String(a.code).localeCompare(String(b.code)));
  if (mine.length) return { data: mine[0].id, error: null };
  const parent = (T.acct_accounts || []).find(a => a.company_id === p_company_id && a.code === "1100");
  const code = "1100-" + String(R.nextTenantArSeq((T.acct_accounts || []).filter(a => a.company_id === p_company_id).map(a => a.code))).padStart(3, "0");
  const row = { id: "ar-new-" + p_tenant_id, company_id: p_company_id, code, name: "AR - " + t.name, type: "Asset", is_active: true, parent_id: parent?.id || null, tenant_id: t.id };
  T.acct_accounts.push(row);
  return { data: row.id, error: null };
}
function fakeStripePostReversal(T, a, jeNumber) {
  const res = fakeStripePostReversalCore(T, a, jeNumber);
  if (res.error || res.data?.error) return res;
  res.data.payment_status = fakeSyncPaymentStatus(T, a);
  return res;
}
// Mirrors _stripe_sync_payment_status (migration 20260928090000).
function fakeSyncPaymentStatus(T, a) {
  const JE = T.acct_journal_entries, JL = T.acct_journal_lines;
  const cents = (id) => Math.round(JL.filter(l => l.journal_entry_id === id).reduce((s, l) => s + (Number(l.debit) || 0), 0) * 100);
  const orig = JE.find(j => j.company_id === a.p_company_id && j.reference === "STRIPE-" + a.p_payment_intent_id && j.status !== "voided");
  if (!orig) return null;
  const pool = JE.filter(j => j.company_id === a.p_company_id && j.status === "posted" && (
    (j.stripe_payment_intent_id === a.p_payment_intent_id && /^STRIPE-(REFUND|DISPUTE)-/.test(j.reference || "")) ||
    (a.p_charge_id && (j.reference || "").startsWith("STRIPE-REFUND-" + a.p_charge_id + "-")) ||
    (a.p_dispute_id && ["STRIPE-DISPUTE-" + a.p_dispute_id, "STRIPE-DISPUTE-WON-" + a.p_dispute_id].includes(j.reference))));
  let refundedCents = 0, openDisputes = 0, lostDisputes = 0;
  for (const j of pool) {
    if (/^STRIPE-REFUND-/.test(j.reference)) { refundedCents += cents(j.id); continue; }
    if (/^STRIPE-DISPUTE-WON-/.test(j.reference) || cents(j.id) <= 0) continue;
    const dp = j.reference.slice("STRIPE-DISPUTE-".length);
    if (JE.some(x => x.company_id === a.p_company_id && x.status === "posted" && x.reference === "STRIPE-DISPUTE-WON-" + dp)) continue;
    if ((T.stripe_dispute_outcomes || []).some(m => m.dispute_id === dp && m.status === "lost")) lostDisputes++; else openDisputes++;
  }
  const pays = (T.payments || []).filter(x => x.company_id === a.p_company_id && x.stripe_session_id === a.p_payment_intent_id);
  const st = R.derivePaymentStatus({ lostDisputes, openDisputes, refundedCents, bookedCents: cents(orig.id), refundFull: !!a.p_refund_full, current: pays[0]?.status || null });
  pays.forEach(x => { x.status = st; });
  return st;
}
function fakeStripePostReversalCore(T, a, jeNumber) {
  T.stripe_dispute_outcomes = T.stripe_dispute_outcomes || [];
  const JE = T.acct_journal_entries, JL = T.acct_journal_lines;
  const cents = (id) => Math.round(JL.filter(l => l.journal_entry_id === id).reduce((s, l) => s + (Number(l.debit) || 0), 0) * 100);
  if (a.p_kind === "dispute_won" || (a.p_kind === "dispute" && ["won", "lost"].includes(a.p_dispute_status))) {
    const st = a.p_kind === "dispute_won" ? "won" : a.p_dispute_status;
    const m = T.stripe_dispute_outcomes.find(x => x.dispute_id === a.p_dispute_id);
    if (m) m.status = st; else T.stripe_dispute_outcomes.push({ dispute_id: a.p_dispute_id, company_id: a.p_company_id, status: st });
  }
  if (a.p_kind === "dispute" && a.p_dispute_status !== "lost" && T.stripe_dispute_outcomes.some(x => x.dispute_id === a.p_dispute_id && x.status === "won")) return { data: { skipped: "dispute_already_won" }, error: null };
  const orig = JE.find(j => j.company_id === a.p_company_id && j.reference === "STRIPE-" + a.p_payment_intent_id && j.status !== "voided");
  if (!orig) return { data: { error: "original_not_found" }, error: null };
  const booked = cents(orig.id);
  const dup = JE.find(j => j.company_id === a.p_company_id && j.reference === a.p_reference && j.status !== "voided");
  if (dup) return { data: { idempotent: true, id: dup.id }, error: null };
  const pool = JE.filter(j => j.company_id === a.p_company_id && j.status === "posted" && (
    (j.stripe_payment_intent_id === a.p_payment_intent_id && /^STRIPE-(REFUND|DISPUTE)-/.test(j.reference || "")) ||
    (a.p_charge_id && (j.reference || "").startsWith("STRIPE-REFUND-" + a.p_charge_id + "-")) ||
    (a.p_dispute_id && ["STRIPE-DISPUTE-" + a.p_dispute_id, "STRIPE-DISPUTE-WON-" + a.p_dispute_id].includes(j.reference))));
  const already = pool.reduce((s, j) => s + (/^STRIPE-DISPUTE-WON-/.test(j.reference) ? -cents(j.id) : cents(j.id)), 0);
  const refunded = pool.filter(j => /^STRIPE-REFUND-/.test(j.reference)).reduce((s, j) => s + cents(j.id), 0);
  let src = orig, amt;
  if (a.p_kind === "dispute_won") {
    src = JE.find(j => j.company_id === a.p_company_id && j.reference === "STRIPE-DISPUTE-" + a.p_dispute_id && j.status === "posted");
    if (!src) return { data: { skipped: "nothing_to_repost", marker: "won" }, error: null };
    amt = cents(src.id);
  } else {
    const req = a.p_kind === "refund" ? Math.min(booked, Math.max(0, a.p_amount_cents || 0)) - refunded : Math.min(booked, Math.max(0, a.p_amount_cents ?? booked));
    amt = Math.min(req, booked - already);
  }
  if (!(amt > 0)) return { data: { skipped: "nothing_to_reverse", booked_cents: booked, already_cents: already }, error: null };
  const lines = R.buildReversalLines(JL.filter(l => l.journal_entry_id === src.id), amt, a.p_memo);
  const id = "je-rev-" + (JE.length + 1);
  JE.push({ id, company_id: a.p_company_id, number: jeNumber, date: a.p_date, description: a.p_description, reference: a.p_reference, property: orig.property || "", status: "posted", stripe_payment_intent_id: a.p_payment_intent_id });
  for (const l of lines) JL.push({ id: "jl-" + (JL.length + 1), company_id: a.p_company_id, journal_entry_id: id, ...l });
  return { data: { id, amount_cents: amt, booked_cents: booked, already_cents: already }, error: null };
}

// Mock Stripe.
const stripeCalls = { piCreate: [], pmRetrieve: [] };
const stripeState = { pmType: {}, piMeta: {}, failCreate: false, events: [] };
function FakeStripe() {
  return {
    paymentIntents: {
      create: async (params, opts) => {
        stripeCalls.piCreate.push({ params, opts });
        if (stripeState.failCreate) { const e = new Error("Your card was declined."); throw e; }
        return { id: "pi_" + stripeCalls.piCreate.length, status: "succeeded" };
      },
      retrieve: async (id) => ({ id, metadata: stripeState.piMeta[id] || {} }),
    },
    paymentMethods: { retrieve: async (id) => { stripeCalls.pmRetrieve.push(id); return { id, type: stripeState.pmType[id] || "card", card: { brand: "visa", last4: "4242" }, us_bank_account: { last4: "6789" } }; }, detach: async () => ({}) },
    setupIntents: { retrieve: async (id) => ({ id, status: "succeeded", payment_method: stripeState.setupPm, customer: "cus_1" }) },
    customers: { create: async () => ({ id: "cus_new" }) },
    charges: { retrieve: async (id) => ({ id, payment_intent: stripeState.chargePi?.[id] || null }) },
    webhooks: { constructEvent: (_raw, sig) => { if (sig !== "valid") throw new Error("bad sig"); return stripeState.events.shift(); } },
  };
}

let currentDb = null;
const Module = require("module");
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "stripe") return FakeStripe;
  if (req === "@supabase/supabase-js") return { createClient: () => currentDb };
  if (req === "web-push") return { setVapidDetails() {}, sendNotification: async () => {} };
  return origLoad.apply(this, arguments);
};
process.env.STRIPE_SECRET_KEY = "sk_test_mock";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
process.env.SUPABASE_URL = "http://fake";
delete process.env.CRON_SECRET; delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.REACT_APP_VAPID_PUBLIC_KEY;
const handler = require(path.join(root, "api/stripe.js"));
Module._load = origLoad;

function call(action, { body = {}, headers = {}, method = "POST" } = {}) {
  const req = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method = method; req.headers = headers; req.query = { action };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    handler(req, res);
  });
}
const CO = "co-1";
const baseSeed = () => ({
  tenants: [{ id: 42, company_id: CO, name: "Jo Smith", email: "tenant@x.com", property: "1 Main St, Town, MD", rent: 1500, archived_at: null }],
  company_members: [
    { company_id: CO, user_email: "admin@x.com", role: "admin", status: "active" },
    { company_id: CO, user_email: "owner@x.com", role: "owner", status: "active" },
    { company_id: "co-2", user_email: "other@x.com", role: "admin", status: "active" },
  ],
  properties: [{ id: 7, company_id: CO, address: "1 Main St, Town, MD", class_id: "cls-1" }],
  acct_classes: [{ id: "cls-1", company_id: CO, name: "1 Main St, Town, MD" }],
  acct_accounts: [
    { id: "a1100", company_id: CO, code: "1100", name: "Accounts Receivable", type: "Asset", tenant_id: null, is_active: true },
    { id: "a4000", company_id: CO, code: "4000", name: "Rental Income", type: "Revenue", tenant_id: null, is_active: true },
    { id: "ar42", company_id: CO, code: "1100-001", name: "AR - Jo Smith (1 Main St)", type: "Asset", tenant_id: 42, is_active: true },
  ],
  acct_journal_entries: [{ id: "je-old", company_id: CO, number: "JE-0041", reference: "RECUR-aaaaaaaa-2026-09", status: "posted", date: "2026-09-01" }],
  acct_journal_lines: [],
  payments: [],
  autopay_schedules: [],
  notification_queue: [],
  push_subscriptions: [],
});

// — #4 cron: overlapping runs charge once, with the idempotency key —
{
  currentDb = makeDb({ ...baseSeed(), autopay_schedules: [
    { id: "ap-1", company_id: CO, tenant_id: 42, tenant: "Jo Smith", property: "1 Main", amount: 1500, day_of_month: 1, provider: "stripe", enabled: true, archived_at: null, next_charge_date: "2026-09-01", method: "stripe_card", stripe_customer_id: "cus_1", stripe_payment_method_id: "pm_card" },
    { id: "ap-2", company_id: CO, tenant_id: 43, tenant: "Al", property: "2 Oak", amount: 1000, day_of_month: 5, provider: "stripe", enabled: true, archived_at: null, next_charge_date: "2026-09-05", method: "stripe_card", stripe_customer_id: "cus_2", stripe_payment_method_id: "pm_bank" },
  ] });
  stripeState.pmType = { pm_card: "card", pm_bank: "us_bank_account" };
  stripeCalls.piCreate.length = 0;
  process.env.CRON_SECRET = "";
  const [a, b] = await Promise.all([
    call("charge-autopay-due", { headers: { authorization: "Bearer admin" } }),
    call("charge-autopay-due", { headers: { authorization: "Bearer admin" } }),
  ]);
  const charges = stripeCalls.piCreate;
  assert("#4 two overlapping runs -> each schedule charged exactly once", charges.length === 2, JSON.stringify([a.body, b.body]));
  const skipped = [...a.body.results, ...b.body.results].filter(r => r.skipped === "claimed by another run").length;
  assert("#4 …the losing run skipped both as 'claimed by another run'", skipped === 2, JSON.stringify([a.body, b.body]));
  const byId = Object.fromEntries(charges.map(c => [c.params.metadata.autopay_id, c]));
  assert("#4 idempotencyKey = autopay-<id>-<period of the claimed due date>-<attempt day>", /^autopay-ap-1-2026-09-\d{4}-\d{2}-\d{2}$/.test(byId["ap-1"]?.opts?.idempotencyKey || "") && /^autopay-ap-2-2026-09-\d{4}-\d{2}-\d{2}$/.test(byId["ap-2"]?.opts?.idempotencyKey || ""));
  const ap2 = currentDb.T.autopay_schedules.find(r => r.id === "ap-2");
  assert("#5 legacy 'stripe_card' row whose PM is a bank account is charged the ACH fee", byId["ap-2"]?.params.metadata.payment_method_kind === "us_bank_account" && byId["ap-2"].params.amount === 100000 + 500);
  assert("#5 …and the row is corrected to stripe_us_bank_account", ap2.method === "stripe_us_bank_account");
  assert("#5 card row keeps the card fee", byId["ap-1"]?.params.amount === Math.ceil((150000 + 30) / 0.971));
  const ap1 = currentDb.T.autopay_schedules.find(r => r.id === "ap-1");
  assert("#4 claimed rows moved past the period", ap1.next_charge_date > "2026-09-01" && ap2.next_charge_date > "2026-09-05");
  assert("Q7 next = month after the claimed period on day_of_month (2026-10-01 / 2026-10-05)", ap1.next_charge_date === "2026-10-01" && ap2.next_charge_date === "2026-10-05", ap1.next_charge_date + " " + ap2.next_charge_date);
  assert("Q6 the PI carries the claim (claimed_date / advanced_date)", byId["ap-1"]?.params.metadata.claimed_date === "2026-09-01" && byId["ap-1"]?.params.metadata.advanced_date === "2026-10-01");
  // a third run the same day charges nothing
  await call("charge-autopay-due", { headers: { authorization: "Bearer admin" } });
  assert("#4 a later run the same day charges nothing more", stripeCalls.piCreate.length === 2);
}
// — #4 failure releases the claim —
{
  currentDb = makeDb({ ...baseSeed(), autopay_schedules: [
    { id: "ap-9", company_id: CO, tenant_id: 42, tenant: "Jo", property: "1 Main", amount: 1500, day_of_month: 1, provider: "stripe", enabled: true, archived_at: null, next_charge_date: "2026-09-01", method: "stripe_card", stripe_customer_id: "c", stripe_payment_method_id: "pm_card" },
  ] });
  stripeState.failCreate = true;
  const r = await call("charge-autopay-due", { headers: { authorization: "Bearer admin" } });
  stripeState.failCreate = false;
  const row = currentDb.T.autopay_schedules[0];
  assert("#4 declined charge -> claim released (due again next run)", row.next_charge_date === "2026-09-01" && /declined/.test(row.last_error || ""), JSON.stringify(r.body));
}

// — #5 save-payment-method stores the real method —
{
  currentDb = makeDb(baseSeed());
  stripeState.setupPm = "pm_bank";
  stripeState.pmType = { pm_bank: "us_bank_account" };
  const r = await call("save-payment-method", { headers: { authorization: "Bearer good" }, body: { setup_intent_id: "seti_1", tenant_id: 42, company_id: CO, day_of_month: 1, amount: 1500 } });
  const row = currentDb.T.autopay_schedules[0];
  assert("#5 bank account saved as stripe_us_bank_account", r.status === 200 && row?.method === "stripe_us_bank_account", JSON.stringify(r.body));
  currentDb = makeDb(baseSeed());
  stripeState.setupPm = "pm_card"; stripeState.pmType = { pm_card: "card" };
  await call("save-payment-method", { headers: { authorization: "Bearer good" }, body: { setup_intent_id: "seti_2", tenant_id: 42, company_id: CO } });
  assert("#5 card saved as stripe_card", currentDb.T.autopay_schedules[0]?.method === "stripe_card");
}

// — #1/#8/#9 webhook payment_intent.succeeded —
const piEvent = (id, extra = {}) => ({ type: "payment_intent.succeeded", data: { object: { id, metadata: { company_id: CO, tenant_id: "42", tenant_name: "Jo Smith", property: "1 Main St, Town, MD", rent_cents: "150000", fee_cents: "4548", ...extra } } } });
{
  currentDb = makeDb(baseSeed());
  stripeState.events.push(piEvent("pi_A"));
  const r = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  const je = currentDb.T.acct_journal_entries.find(j => j.reference === "STRIPE-pi_A");
  const lines = currentDb.T.acct_journal_lines.filter(l => l.journal_entry_id === je?.id);
  assert("#1 webhook credits the tenant's own AR", r.status === 200 && lines.some(l => l.account_id === "ar42" && l.credit === 1500) && !lines.some(l => l.account_id === "a4000"), JSON.stringify(r.body));
  assert("#9 JE numbered by next_je_number (max JE-0041 -> JE-0042)", je?.number === "JE-0042");
  assert("#9 JE dated with the New York business date", je?.date === R.localBusinessDate());
  assert("#9 every line carries the property's class", lines.length === 2 && lines.every(l => l.class_id === "cls-1"));
  const p = currentDb.T.payments.find(x => x.stripe_session_id === "pi_A");
  assert("#8 payments row carries tenant_id", p?.tenant_id === 42 && p.status === "paid");
  // resend is idempotent
  stripeState.events.push(piEvent("pi_A"));
  const r2 = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("resend of the same PI is idempotent", r2.body?.idempotent === true && currentDb.T.acct_journal_entries.filter(j => j.reference === "STRIPE-pi_A").length === 1);
  const bad = await call("webhook", { headers: { "stripe-signature": "forged" }, body: "{}" });
  assert("#7 unsigned/forged events still rejected (400)", bad.status === 400);
}
{
  // tenant with no AR account yet -> one is created and credited
  const seed = baseSeed();
  seed.acct_accounts = seed.acct_accounts.filter(a => a.id !== "ar42");
  currentDb = makeDb(seed);
  stripeState.events.push(piEvent("pi_B"));
  const r = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  const created = currentDb.T.acct_accounts.find(a => String(a.tenant_id) === "42");
  const je = currentDb.T.acct_journal_entries.find(j => j.reference === "STRIPE-pi_B");
  const lines = currentDb.T.acct_journal_lines.filter(l => l.journal_entry_id === je?.id);
  assert("#1 missing tenant AR is created (1100-NNN under 1100) and credited", r.status === 200 && created?.code === "1100-001" && created.parent_id === "a1100" && lines.some(l => l.account_id === created.id && l.credit === 1500), JSON.stringify(r.body));
}

// — #7 refunds and disputes —
{
  currentDb = makeDb(baseSeed());
  stripeState.events.push(piEvent("pi_R"));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  const refundEv = (amt, full) => ({ type: "charge.refunded", data: { object: { id: "ch_R", payment_intent: "pi_R", amount_refunded: amt, refunded: full } } });
  const arNet = () => currentDb.T.acct_journal_lines.filter(l => l.account_id === "ar42").reduce((a, l) => a + (l.debit || 0) - (l.credit || 0), 0);
  stripeState.events.push(refundEv(50000, false));
  const r1 = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 partial refund reverses $500 onto the tenant AR", r1.status === 200 && Math.abs(arNet() - (-1500 + 500)) < 0.001, JSON.stringify(r1.body));
  assert("#7 …payment marked partially_refunded", currentDb.T.payments.find(p => p.stripe_session_id === "pi_R")?.status === "partially_refunded");
  stripeState.events.push(refundEv(50000, false));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 resent refund event reverses nothing more", Math.abs(arNet() - (-1000)) < 0.001);
  stripeState.events.push(refundEv(154548, true));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 full (gross) refund reverses the rest, capped at the rent", Math.abs(arNet()) < 0.001);
  assert("#7 …payment marked refunded", currentDb.T.payments.find(p => p.stripe_session_id === "pi_R")?.status === "refunded");
  const refs = currentDb.T.acct_journal_entries.filter(j => /^STRIPE-REFUND-ch_R-/.test(j.reference)).map(j => j.reference).sort();
  assert("#7 refund references are deterministic", JSON.stringify(refs) === JSON.stringify(["STRIPE-REFUND-ch_R-154548", "STRIPE-REFUND-ch_R-50000"]));
  const allBalanced = currentDb.T.acct_journal_entries.every(j => { const ls = currentDb.T.acct_journal_lines.filter(l => l.journal_entry_id === j.id); return Math.abs(ls.reduce((a, l) => a + l.debit - l.credit, 0)) < 0.001; });
  assert("#7 every entry balances", allBalanced);
}
{
  currentDb = makeDb(baseSeed());
  stripeState.events.push(piEvent("pi_D"));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  const arNet = () => currentDb.T.acct_journal_lines.filter(l => l.account_id === "ar42").reduce((a, l) => a + (l.debit || 0) - (l.credit || 0), 0);
  const dEv = (type, status) => ({ type, data: { object: { id: "dp_1", charge: "ch_D", payment_intent: "pi_D", amount: 154548, status } } });
  stripeState.events.push(dEv("charge.dispute.created", "needs_response"));
  const r = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 dispute opened -> payment reversed (tenant owes the rent again)", r.status === 200 && Math.abs(arNet()) < 0.001 && currentDb.T.acct_journal_entries.some(j => j.reference === "STRIPE-DISPUTE-dp_1"), JSON.stringify(r.body));
  assert("#7 …payment marked disputed", currentDb.T.payments.find(p => p.stripe_session_id === "pi_D")?.status === "disputed");
  stripeState.events.push(dEv("charge.dispute.created", "needs_response"));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 resent dispute event does not reverse twice", currentDb.T.acct_journal_entries.filter(j => j.reference === "STRIPE-DISPUTE-dp_1").length === 1 && Math.abs(arNet()) < 0.001);
  stripeState.events.push(dEv("charge.dispute.closed", "won"));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 dispute won -> payment re-posted", Math.abs(arNet() - (-1500)) < 0.001 && currentDb.T.payments.find(p => p.stripe_session_id === "pi_D")?.status === "paid");
  // lost path on a fresh DB where .created was never delivered
  currentDb = makeDb(baseSeed());
  stripeState.events.push(piEvent("pi_D"));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  stripeState.events.push(dEv("charge.dispute.closed", "lost"));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 dispute lost (created never seen) -> reversal posted, payment dispute_lost", Math.abs(arNet()) < 0.001 && currentDb.T.payments.find(p => p.stripe_session_id === "pi_D")?.status === "dispute_lost");
  // refund for a PI that is not ours -> 200 noop; ours but not posted -> 500 retry
  stripeState.events.push({ type: "charge.refunded", data: { object: { id: "ch_X", payment_intent: "pi_foreign", amount_refunded: 100, refunded: true } } });
  const n = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 refund of a non-app payment is a no-op", n.status === 200 && n.body.action === "noop");
  stripeState.piMeta.pi_late = { company_id: CO, tenant_id: "42" };
  stripeState.events.push({ type: "charge.refunded", data: { object: { id: "ch_L", payment_intent: "pi_late", amount_refunded: 100, refunded: true } } });
  const l = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("#7 refund arriving before its payment post -> 500 so Stripe retries", l.status === 500);
}

// — Q8/Q9 cron authorization —
{
  const sched = () => [
    { id: "ap-a", company_id: CO, tenant_id: 42, tenant: "Jo", property: "1 Main", amount: 1500, day_of_month: 1, provider: "stripe", enabled: true, archived_at: null, next_charge_date: "2026-09-01", method: "stripe_card", stripe_customer_id: "c", stripe_payment_method_id: "pm_card" },
    { id: "ap-b", company_id: "co-2", tenant_id: 77, tenant: "Bo", property: "9 Elm", amount: 900, day_of_month: 1, provider: "stripe", enabled: true, archived_at: null, next_charge_date: "2026-09-01", method: "stripe_card", stripe_customer_id: "c2", stripe_payment_method_id: "pm_card" },
  ];
  stripeState.pmType = { pm_card: "card" };
  const run = async (opts) => { currentDb = makeDb({ ...baseSeed(), autopay_schedules: sched() }); stripeCalls.piCreate.length = 0; const r = await call("charge-autopay-due", opts); return { r, ids: stripeCalls.piCreate.map(c => c.params.metadata.autopay_id).sort() }; };
  process.env.CRON_SECRET = "";
  let { r, ids } = await run({ headers: { authorization: "Bearer good" } });
  assert("Q9 a tenant's JWT is refused (403) and charges nothing", r.status === 403 && ids.length === 0, JSON.stringify(r.body));
  ({ r, ids } = await run({ headers: { authorization: "Bearer owner" } }));
  assert("Q9 an owner-portal user is refused (403)", r.status === 403 && ids.length === 0);
  ({ r, ids } = await run({ headers: { authorization: "Bearer admin" } }));
  assert("Q9 an admin charges ONLY their own company's schedules", r.status === 200 && JSON.stringify(ids) === '["ap-a"]', JSON.stringify(ids));
  ({ r, ids } = await run({ headers: { authorization: "Bearer other" }, method: "GET" }));
  assert("Q9 …another company's admin charges only theirs", r.status === 200 && JSON.stringify(ids) === '["ap-b"]', JSON.stringify(ids));
  ({ r, ids } = await run({ headers: {} }));
  assert("Q9 no bearer -> 401", r.status === 401 && ids.length === 0);
  ({ r, ids } = await run({ headers: { authorization: "Bearer nobody" } }));
  assert("Q9 unknown token -> 401", r.status === 401 && ids.length === 0);
  // The module read CRON_SECRET at load; re-load it with a secret set.
  const cronSecret = "cron-secret-for-tests-123";
  process.env.CRON_SECRET = cronSecret;
  const modPath = path.join(root, "api/stripe.js");
  delete require.cache[require.resolve(modPath)];
  Module._load = function (req, parent, isMain) {
    if (req === "stripe") return FakeStripe;
    if (req === "@supabase/supabase-js") return { createClient: () => currentDb };
    if (req === "web-push") return { setVapidDetails() {}, sendNotification: async () => {} };
    return origLoad.apply(this, arguments);
  };
  const handler2 = require(modPath);
  Module._load = origLoad;
  const call2 = (action, { body = {}, headers = {}, method = "POST" } = {}) => new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = method; req.headers = headers; req.query = { action };
    handler2(req, { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { resolve({ status: this.statusCode, body: o }); return this; }, end() { resolve({ status: this.statusCode, body: null }); return this; } });
  });
  currentDb = makeDb({ ...baseSeed(), autopay_schedules: sched() }); stripeCalls.piCreate.length = 0;
  const g = await call2("charge-autopay-due", { method: "GET", headers: { authorization: "Bearer " + cronSecret } });
  assert("Q8 GET with Bearer CRON_SECRET (what Vercel Cron sends) runs every company", g.status === 200 && stripeCalls.piCreate.length === 2, JSON.stringify(g.body));
  currentDb = makeDb({ ...baseSeed(), autopay_schedules: sched() }); stripeCalls.piCreate.length = 0;
  const w = await call2("charge-autopay-due", { method: "GET", headers: { authorization: "Bearer wrong-secret-xyz" } });
  assert("Q8 GET with a wrong secret -> 401, nothing charged", w.status === 401 && stripeCalls.piCreate.length === 0);
  const put = await call2("charge-autopay-due", { method: "PUT", headers: { authorization: "Bearer " + cronSecret } });
  assert("Q8 other methods -> 405", put.status === 405);
  process.env.CRON_SECRET = "";
}

// — Q6 async ACH failure releases the claim —
{
  const failEv = (md) => ({ type: "payment_intent.payment_failed", data: { object: { id: "pi_f", last_payment_error: { message: "ACH return R01" }, metadata: { company_id: CO, tenant_id: "42", tenant_name: "Jo Smith", rent_cents: "150000", ...md } } } });
  const seedAp = (next, extra = {}) => ({ ...baseSeed(), autopay_schedules: [{ id: "ap-f", company_id: CO, tenant_id: 42, amount: 1500, day_of_month: 5, provider: "stripe", enabled: true, archived_at: null, next_charge_date: next, method: "stripe_us_bank_account", last_payment_intent_id: "pi_f", last_paid_period: null, ...extra }] });
  currentDb = makeDb(seedAp("2026-10-05"));
  stripeState.events.push(failEv({ autopay_id: "ap-f", billing_period: "2026-09", claimed_date: "2026-09-05", advanced_date: "2026-10-05" }));
  let r = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  let row = currentDb.T.autopay_schedules[0];
  assert("Q6 payment_failed gives the period back (next_charge_date -> claimed date) + last_error", r.status === 200 && row.next_charge_date === "2026-09-05" && /R01/.test(row.last_error || ""), JSON.stringify(row));
  currentDb = makeDb(seedAp("2026-10-05"));
  stripeState.events.push(failEv({ autopay_id: "ap-f", billing_period: "2026-09" }));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("Q6 …older PI without claim metadata: derived from day_of_month", currentDb.T.autopay_schedules[0].next_charge_date === "2026-09-05");
  currentDb = makeDb(seedAp("2026-11-05"));
  stripeState.events.push(failEv({ autopay_id: "ap-f", billing_period: "2026-09", claimed_date: "2026-09-05", advanced_date: "2026-10-05" }));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  row = currentDb.T.autopay_schedules[0];
  assert("Q6 …but never rewinds a date that has moved on since (conditional)", row.next_charge_date === "2026-11-05" && /R01/.test(row.last_error || ""));
  currentDb = makeDb(seedAp("2026-10-05"));
  stripeState.events.push(failEv({ autopay_id: "ap-f" }));
  await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("Q6 …no billing_period -> only last_error (unchanged behaviour)", currentDb.T.autopay_schedules[0].next_charge_date === "2026-10-05" && /R01/.test(currentDb.T.autopay_schedules[0].last_error || ""));
}

// — Q1-Q4 refunds / disputes through the RPC —
{
  const arNet = () => currentDb.T.acct_journal_lines.filter(l => l.account_id === "ar42").reduce((a, l) => a + (l.debit || 0) - (l.credit || 0), 0);
  const ev = async (e) => { stripeState.events.push(e); return call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" }); };
  const refundEv = (ch, pi, amt, full) => ({ type: "charge.refunded", data: { object: { id: ch, payment_intent: pi, amount_refunded: amt, refunded: full } } });
  const dEv = (type, dp, pi, amount, status) => ({ type, data: { object: { id: dp, charge: "ch_" + dp, payment_intent: pi, amount, status } } });
  const payStatus = (pi) => currentDb.T.payments.find(p => p.stripe_session_id === pi)?.status;

  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_S"));
  await ev(refundEv("ch_S", "pi_S", 30000, false));
  await ev(refundEv("ch_S", "pi_S", 154548, true));
  const stale = await ev(refundEv("ch_S", "pi_S", 30000, false));
  assert("Q4 stale partial refund after the full one: nothing reversed, status stays refunded", stale.status === 200 && payStatus("pi_S") === "refunded" && Math.abs(arNet()) < 0.001, payStatus("pi_S"));

  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_E"));
  await ev(refundEv("ch_E", "pi_E", 30000, false));
  await ev(dEv("charge.dispute.created", "dp_E", "pi_E", 154548 - 30000, "needs_response"));
  const revTotal = currentDb.T.acct_journal_entries.filter(j => /^STRIPE-(REFUND|DISPUTE)-/.test(j.reference)).reduce((s, j) => s + currentDb.T.acct_journal_lines.filter(l => l.journal_entry_id === j.id).reduce((a, l) => a + l.debit, 0), 0);
  assert("Q2 refund 300 then dispute on the remainder: total reversed == booked 1,500, never more", Math.abs(revTotal - 1500) < 0.001 && Math.abs(arNet()) < 0.001, String(revTotal));

  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_W"));
  const won = await ev(dEv("charge.dispute.closed", "dp_W", "pi_W", 154548, "won"));
  const late = await ev(dEv("charge.dispute.created", "dp_W", "pi_W", 154548, "needs_response"));
  assert("Q3 won delivered BEFORE created: marker recorded, created reverses nothing", won.status === 200 && late.status === 200 && late.body.reason === "dispute already won" && Math.abs(arNet() - (-1500)) < 0.001 && currentDb.T.stripe_dispute_outcomes?.some(m => m.dispute_id === "dp_W" && m.status === "won"), JSON.stringify(late.body));
  assert("Q3 …payment stays paid", payStatus("pi_W") === "paid");
  const snap = await ev(dEv("charge.dispute.created", "dp_W2", "pi_W", 154548, "won"));
  assert("Q3 created whose own snapshot says won -> no reversal", snap.status === 200 && snap.body.action === "noop" && Math.abs(arNet() - (-1500)) < 0.001, JSON.stringify(snap.body));

  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_L"));
  await ev(dEv("charge.dispute.closed", "dp_L", "pi_L", 154548, "lost"));
  await ev(dEv("charge.dispute.created", "dp_L", "pi_L", 154548, "needs_response"));
  const lostRevs = currentDb.T.acct_journal_entries.filter(j => j.reference === "STRIPE-DISPUTE-dp_L");
  assert("Q3 lost delivered before created: exactly one reversal, status dispute_lost kept", lostRevs.length === 1 && Math.abs(arNet()) < 0.001 && payStatus("pi_L") === "dispute_lost", payStatus("pi_L"));
}

// — Q5 receipts never fall back to Rental Income for an existing tenant —
{
  const seed = baseSeed(); seed.acct_accounts = seed.acct_accounts.filter(a => a.id !== "ar42");
  currentDb = makeDb(seed); currentDb.T.__rpcError = { stripe_tenant_ar: "could not serialize access" };
  stripeState.events.push(piEvent("pi_X"));
  const r = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  assert("Q5 existing tenant, AR not established -> 500 (Stripe retries), no entry, no payment row", r.status === 500 && !currentDb.T.acct_journal_entries.some(j => j.reference === "STRIPE-pi_X") && !currentDb.T.payments.some(p => p.stripe_session_id === "pi_X"), JSON.stringify(r.body));
  currentDb = makeDb(baseSeed());
  stripeState.events.push(piEvent("pi_G", { tenant_id: "999" }));
  const g = await call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" });
  const je = currentDb.T.acct_journal_entries.find(j => j.reference === "STRIPE-pi_G");
  const lines = currentDb.T.acct_journal_lines.filter(l => l.journal_entry_id === je?.id);
  assert("Q5 tenant row gone entirely -> still booked (Rental Income), not lost", g.status === 200 && lines.some(l => l.account_id === "a4000" && l.credit === 1500));
}

// — Q5 client getOrCreateTenantAR, driven against an in-memory Supabase —
{
  process.chdir(path.join(root, "tests"));
  // pmError (errors.js) reads window/navigator; give it a browser-ish shell.
  if (typeof globalThis.window === "undefined") globalThis.window = { location: { href: "node-test" } };
  await import("./esm-extensionless.mjs");
  const { supabase } = await import("../src/supabase.js");
  const acctMod = await import("../src/utils/accounting.js");
  const realFrom = supabase.from.bind(supabase);
  const reset = () => { for (const k of Object.keys(acctMod._tenantArCache)) delete acctMod._tenantArCache[k]; for (const k of Object.keys(acctMod._acctIdCache)) delete acctMod._acctIdCache[k]; };
  const use = (seed) => { reset(); const db = makeDb(seed); supabase.from = db.from; return db; };
  const base = () => ({
    tenants: [{ id: 7, company_id: CO, name: "Ann Lee", property: "5 Pine St, Town", archived_at: null }, { id: 3, company_id: CO, name: "Ann Lee", property: "5 Pine St, Town", archived_at: "2025-01-01" }],
    acct_accounts: [{ id: "p1100", company_id: CO, code: "1100", name: "Accounts Receivable", type: "Asset", tenant_id: null, is_active: true }],
  });
  try {
    // two linked accounts (one inactive): the active one, no junk
    let db = use({ ...base(), acct_accounts: [...base().acct_accounts,
      { id: "old", company_id: CO, code: "1100-001", name: "AR - Ann Lee", type: "Asset", tenant_id: 7, is_active: false },
      { id: "cur", company_id: CO, code: "1100-004", name: "AR - Ann Lee (5 Pine St)", type: "Asset", tenant_id: 7, is_active: true }] });
    let id = await acctMod.getOrCreateTenantAR(CO, "Ann Lee", 7);
    assert("Q5 client: tenant with 2 linked AR accounts -> the ACTIVE one, nothing created", id === "cur" && db.T.acct_accounts.length === 3, id);
    db = use({ ...base(), acct_accounts: [...base().acct_accounts,
      { id: "a1", company_id: CO, code: "1100-002", name: "AR - Ann Lee", type: "Asset", tenant_id: 7, is_active: true },
      { id: "a2", company_id: CO, code: "1100-009", name: "AR - Ann Lee (5 Pine St)", type: "Asset", tenant_id: 7, is_active: true }] });
    id = await acctMod.getOrCreateTenantAR(CO, "Ann Lee", 7);
    assert("Q5 client: two ACTIVE linked -> lowest code, no junk account", id === "a1" && db.T.acct_accounts.length === 3);
    // returning tenant: same-name account belongs to the ARCHIVED tenant row
    db = use({ ...base(), acct_accounts: [...base().acct_accounts,
      { id: "arch", company_id: CO, code: "1100-003", name: "AR - Ann Lee", type: "Asset", tenant_id: 3, is_active: true }] });
    id = await acctMod.getOrCreateTenantAR(CO, "Ann Lee", 7);
    const made = db.T.acct_accounts.find(a => a.id === id);
    assert("Q5 client: returning tenant never gets the archived row's account; a new linked one is made", id !== "arch" && made && String(made.tenant_id) === "7" && made.parent_id === "p1100" && made.code === "1100-004", JSON.stringify(made));
    assert("Q5 client: …and the archived row's account is untouched", db.T.acct_accounts.find(a => a.id === "arch").tenant_id === 3);
    // unlinked legacy account -> adopted
    db = use({ ...base(), acct_accounts: [...base().acct_accounts,
      { id: "leg", company_id: CO, code: "1100-005", name: "AR - Ann Lee", type: "Asset", tenant_id: null, is_active: true }] });
    id = await acctMod.getOrCreateTenantAR(CO, "Ann Lee", 7);
    assert("Q5 client: unlinked legacy 'AR - <name>' is adopted (tenant_id set)", id === "leg" && String(db.T.acct_accounts.find(a => a.id === "leg").tenant_id) === "7" && db.T.acct_accounts.length === 2);
    // code collision: next code taken between read and insert -> retry, all linked
    db = use(base());
    const origFrom = db.from;
    let injected = false;
    supabase.from = (t) => {
      const b = origFrom(t);
      if (t === "acct_accounts" && !injected) {
        const ins = b.insert;
        b.insert = (payload) => { if (!injected) { injected = true; db.T.acct_accounts.push({ id: "racer", company_id: CO, code: payload[0].code, name: "AR - Someone", type: "Asset", tenant_id: 55, is_active: true }); } return ins(payload); };
      }
      return b;
    };
    id = await acctMod.getOrCreateTenantAR(CO, "Ann Lee", 7);
    const unlinked = db.T.acct_accounts.filter(a => /^1100-/.test(a.code || "") && (a.tenant_id === null || a.tenant_id === undefined));
    const mineAcct = db.T.acct_accounts.find(a => a.id === id);
    assert("Q5 client: code collision -> retried with the next code, still linked + parented", injected && mineAcct && String(mineAcct.tenant_id) === "7" && mineAcct.parent_id === "p1100" && mineAcct.code !== db.T.acct_accounts.find(a => a.id === "racer").code, JSON.stringify(mineAcct));
    assert("Q5 client: no unlinked junk 'AR - <name>' account left behind", unlinked.length === 0, JSON.stringify(unlinked));
    // insert keeps failing (non-unique error) -> parent fallback, nothing unlinked, not cached
    db = use(base()); db.T.__failInsert = { acct_accounts: true };
    id = await acctMod.getOrCreateTenantAR(CO, "Ann Lee", 7);
    assert("Q5 client: creation failure -> 1100 parent (callers check tenant_id), no unlinked account", id === "p1100" && db.T.acct_accounts.length === 1);
    assert("Q5 client: …and the fallback is not cached", !Object.values(acctMod._tenantArCache).includes("p1100"));
  } finally {
    supabase.from = realFrom; reset();
  }
}

// — N1 a late failure of an EARLIER attempt never reopens a paid period —
{
  const failEv = (pi, md) => ({ type: "payment_intent.payment_failed", data: { object: { id: pi, last_payment_error: { message: "ACH return R01" }, metadata: { company_id: CO, tenant_id: "42", tenant_name: "Jo Smith", rent_cents: "150000", autopay_id: "ap-n", billing_period: "2026-09", claimed_date: "2026-09-05", advanced_date: "2026-10-05", ...md } } } });
  const seed = (extra) => ({ ...baseSeed(), autopay_schedules: [{ id: "ap-n", company_id: CO, tenant_id: 42, tenant: "Jo Smith", property: "1 Main", amount: 1500, day_of_month: 5, provider: "stripe", enabled: true, archived_at: null, next_charge_date: "2026-10-05", method: "stripe_us_bank_account", stripe_customer_id: "c", stripe_payment_method_id: "pm_bank", ...extra }] });
  const ev = async (e) => { stripeState.events.push(e); return call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" }); };
  currentDb = makeDb(seed({ last_payment_intent_id: "pi_day1", last_paid_period: null }));
  await ev(failEv("pi_day0"));
  assert("N1 failure of an EARLIER attempt (not the current one) does not release", currentDb.T.autopay_schedules[0].next_charge_date === "2026-10-05" && /R01/.test(currentDb.T.autopay_schedules[0].last_error || ""));
  currentDb = makeDb(seed({ last_payment_intent_id: "pi_day1", last_paid_period: "2026-09" }));
  await ev(failEv("pi_day1"));
  assert("N1 even the current attempt cannot reopen a PAID period", currentDb.T.autopay_schedules[0].next_charge_date === "2026-10-05");
  currentDb = makeDb(seed({ last_payment_intent_id: null, last_paid_period: null }));
  await ev(failEv("pi_old"));
  assert("N1 schedules charged before the column existed (null) never release (safe)", currentDb.T.autopay_schedules[0].next_charge_date === "2026-10-05");
  currentDb = makeDb(seed({ last_payment_intent_id: "pi_day1", last_paid_period: "2026-08" }));
  await ev(failEv("pi_day1"));
  assert("N1 the current attempt of an unpaid period releases", currentDb.T.autopay_schedules[0].next_charge_date === "2026-09-05");
  // succeeded webhook records the paid period (forward only)
  currentDb = makeDb(seed({ last_payment_intent_id: "pi_s", last_paid_period: "2026-08" }));
  await ev(piEvent("pi_s", { autopay_id: "ap-n", billing_period: "2026-09" }));
  assert("N1 payment_intent.succeeded marks the period paid", currentDb.T.autopay_schedules[0].last_paid_period === "2026-09");
  currentDb = makeDb(seed({ last_payment_intent_id: "pi_s", last_paid_period: "2026-10" }));
  await ev(piEvent("pi_s2", { autopay_id: "ap-n", billing_period: "2026-09" }));
  assert("N1 …and never moves it backwards", currentDb.T.autopay_schedules[0].last_paid_period === "2026-10");
  // cron: claim clears, PI recorded; processing ACH is not "paid"; a decline carrying its PI records it
  currentDb = makeDb(seed({ next_charge_date: "2026-09-05", last_payment_intent_id: "pi_stale" }));
  stripeState.pmType = { pm_bank: "us_bank_account" };
  const origCreate = FakeStripe;
  stripeCalls.piCreate.length = 0;
  await call("charge-autopay-due", { headers: { authorization: "Bearer admin" } });
  const row = currentDb.T.autopay_schedules[0];
  assert("N1 cron records the new PaymentIntent as the current attempt", row.last_payment_intent_id === "pi_" + stripeCalls.piCreate.length && row.next_charge_date === "2026-10-05");
  assert("N1 a synchronously succeeded charge marks the period paid", row.last_paid_period === "2026-09");
  void origCreate;
}

// — N2 / P1 / P2 through the webhook —
{
  const arNet = () => currentDb.T.acct_journal_lines.filter(l => l.account_id === "ar42").reduce((a, l) => a + (l.debit || 0) - (l.credit || 0), 0);
  const ev = async (e) => { stripeState.events.push(e); return call("webhook", { headers: { "stripe-signature": "valid" }, body: "{}" }); };
  const refundEv = (ch, pi, amt, full) => ({ type: "charge.refunded", data: { object: { id: ch, payment_intent: pi, amount_refunded: amt, refunded: full } } });
  const dEv = (type, dp, pi, amount, status) => ({ type, data: { object: { id: dp, charge: "ch_" + dp, payment_intent: pi, amount, status } } });
  const payStatus = (pi) => currentDb.T.payments.find(p => p.stripe_session_id === pi)?.status;

  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_M"));
  await ev(refundEv("ch_M", "pi_M", 154548, true));
  const m = await ev(dEv("charge.dispute.created", "dp_M", "pi_M", 154548, "needs_response"));
  assert("N2 dispute on a fully refunded payment: nothing reversed, status stays refunded", m.status === 200 && payStatus("pi_M") === "refunded" && !currentDb.T.acct_journal_entries.some(j => j.reference === "STRIPE-DISPUTE-dp_M"), JSON.stringify(m.body));

  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_P"));
  await ev(refundEv("ch_P", "pi_P", 30000, false));
  await ev(dEv("charge.dispute.created", "dp_P", "pi_P", 124548, "needs_response"));
  const sD = payStatus("pi_P");
  await ev(refundEv("ch_P", "pi_P", 30000, false));
  assert("N2 a late partial-refund event does not overwrite disputed", sD === "disputed" && payStatus("pi_P") === "disputed");
  await ev(dEv("charge.dispute.closed", "dp_P", "pi_P", 124548, "won"));
  assert("N2 dispute won on a partially refunded payment -> partially_refunded, not paid", payStatus("pi_P") === "partially_refunded" && Math.abs(arNet() - (-1500 + 300)) < 0.001, payStatus("pi_P"));

  // P1 voided original
  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_V"));
  currentDb.T.acct_journal_entries.find(j => j.reference === "STRIPE-pi_V").status = "voided";
  stripeState.piMeta.pi_V = { company_id: CO, tenant_id: "42" };
  const v1 = await ev(refundEv("ch_V", "pi_V", 154548, true));
  const v2 = await ev(dEv("charge.dispute.created", "dp_V", "pi_V", 154548, "needs_response"));
  assert("P1 refund / dispute of a VOIDED payment -> 200 'original voided', nothing posted", v1.status === 200 && v2.status === 200 && /voided/.test(v1.body.reason) && /voided/.test(v2.body.reason) && !currentDb.T.acct_journal_entries.some(j => /^STRIPE-(REFUND|DISPUTE)-/.test(j.reference)), JSON.stringify([v1.body, v2.body]));
  assert("P1 …status still moves forward (refunded; the later dispute does not overwrite it)", payStatus("pi_V") === "refunded");
  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_V2"));
  currentDb.T.acct_journal_entries.find(j => j.reference === "STRIPE-pi_V2").status = "voided";
  await ev(dEv("charge.dispute.closed", "dp_V2", "pi_V2", 154548, "lost"));
  assert("P1 dispute lost on a voided payment -> dispute_lost, 200", payStatus("pi_V2") === "dispute_lost");

  // P2 inquiries
  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_I"));
  const i1 = await ev(dEv("charge.dispute.created", "dp_I", "pi_I", 154548, "warning_needs_response"));
  const i2 = await ev(dEv("charge.dispute.updated", "dp_I", "pi_I", 154548, "warning_under_review"));
  assert("P2 inquiry created / updated -> no reversal, status paid", i1.body.action === "noop" && i2.body.action === "noop" && Math.abs(arNet() - (-1500)) < 0.001 && payStatus("pi_I") === "paid", JSON.stringify(i1.body));
  const e1 = await ev(dEv("charge.dispute.funds_withdrawn", "dp_I", "pi_I", 154548, "needs_response"));
  const e2 = await ev(dEv("charge.dispute.updated", "dp_I", "pi_I", 154548, "needs_response"));
  assert("P2 inquiry escalated (funds_withdrawn, then updated) -> reversed exactly once, disputed", e1.status === 200 && e2.status === 200 && currentDb.T.acct_journal_entries.filter(j => j.reference === "STRIPE-DISPUTE-dp_I").length === 1 && Math.abs(arNet()) < 0.001 && payStatus("pi_I") === "disputed");
  currentDb = makeDb(baseSeed());
  await ev(piEvent("pi_I2"));
  await ev(dEv("charge.dispute.created", "dp_I2", "pi_I2", 154548, "warning_needs_response"));
  const c = await ev(dEv("charge.dispute.closed", "dp_I2", "pi_I2", 154548, "warning_closed"));
  assert("P2 inquiry closed (warning_closed) -> no-op", c.body.action === "noop" && Math.abs(arNet() - (-1500)) < 0.001 && payStatus("pi_I2") === "paid");
}

// ─── 4. TEST DB (read-only): the accrual query shape PostgREST accepts ────
console.log("\n🌐 QUERY SHAPE (test DB, read-only)");
try {
  require("./sandbox-env");
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: acct } = await sb.from("acct_accounts").select("id, company_id, tenant_id").not("tenant_id", "is", null).limit(1);
  const a = acct?.[0];
  if (!a) assert("found a tenant AR account to probe", false);
  else {
    const { data, error } = await sb.from("acct_journal_lines")
      .select("account_id, debit, acct_journal_entries!inner(reference, date, status)")
      .eq("company_id", a.company_id).in("account_id", [a.id]).gt("debit", 0)
      .neq("acct_journal_entries.status", "voided")
      .gte("acct_journal_entries.date", "2000-01-01").lte("acct_journal_entries.date", "2100-12-31").limit(1000);
    assert("checkAccrualExists query runs without error", !error, error?.message);
    assert("…returns the embedded entry shape hasRentChargeInMonth reads", (data || []).every(l => l.acct_journal_entries && "reference" in l.acct_journal_entries));
    const { error: jeErr } = await sb.from("acct_journal_entries")
      .select("id, company_id, property, description, status, lines:acct_journal_lines(account_id, account_name, debit, credit, class_id, memo)")
      .eq("reference", "STRIPE-pi_does_not_exist").neq("status", "voided").maybeSingle();
    assert("findStripePaymentEntry query shape accepted", !jeErr, jeErr?.message);
    const { error: payErr } = await sb.from("payments").select("id, tenant_id, stripe_session_id, status").limit(1);
    assert("payments.tenant_id / stripe_session_id exist", !payErr, payErr?.message);
    const { error: apErr } = await sb.from("autopay_schedules").select("id, tenant_id, next_charge_date, method, provider").limit(1);
    assert("autopay_schedules columns used by the claim exist", !apErr, apErr?.message);
  }
} catch (e) {
  assert("test DB reachable", false, e.message);
}

// ─── 5. TEST DB (writes, cleaned up): the two RPCs for real ──────────────
console.log("\n🔒 LIVE RPCs on TEST (stripe_post_reversal / stripe_tenant_ar)");
try {
  require("./sandbox-env");
  const { createClient } = require("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL;
  if (!/vpeewlplgxthckpidhxo/.test(url || "")) throw new Error("not the TEST project: " + url);
  const sb = createClient(url, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const LCO = "dce4974d-afa9-4e65-afdf-1189b815195d";
  const tag = "QAFIX " + Date.now().toString(36);
  const made = { tenants: [], jes: [], disputes: [] };
  try {
    const { data: t, error: tErr } = await sb.from("tenants").insert({ company_id: LCO, name: tag, property: tag + " Prop, Town, MD", rent: 1000, balance: 0 }).select("id").single();
    if (tErr) throw tErr;
    made.tenants.push(t.id);
    const ars = await Promise.all([1, 2, 3, 4].map(() => sb.rpc("stripe_tenant_ar", { p_company_id: LCO, p_tenant_id: t.id })));
    const ids = [...new Set(ars.map(x => x.data))];
    const { data: linked } = await sb.from("acct_accounts").select("id, code, tenant_id, parent_id").eq("company_id", LCO).eq("tenant_id", t.id);
    assert("LIVE Q5 4 concurrent stripe_tenant_ar calls for a NEW tenant -> one account, all callers get it", ars.every(x => !x.error) && ids.length === 1 && (linked || []).length === 1 && linked[0].id === ids[0] && !!linked[0].parent_id, JSON.stringify(ars.map(x => x.error?.message || x.data)));
    const none = await sb.rpc("stripe_tenant_ar", { p_company_id: LCO, p_tenant_id: 987654321 });
    assert("LIVE Q5 unknown tenant -> NULL (caller may fall back)", !none.error && none.data === null);
    const arId = ids[0];
    const { data: s1015 } = await sb.from("acct_accounts").select("id").eq("company_id", LCO).eq("code", "1015").maybeSingle();
    const mkPayment = async (pi) => {
      const { data: num } = await sb.rpc("next_je_number", { p_company_id: LCO });
      const { data: je, error } = await sb.from("acct_journal_entries").insert({ company_id: LCO, number: num, date: "2026-09-28", description: "Rent payment — " + tag, reference: "STRIPE-" + pi, property: "", status: "posted", stripe_payment_intent_id: pi }).select("id").single();
      if (error) throw error;
      made.jes.push(je.id);
      const { error: lErr } = await sb.from("acct_journal_lines").insert([
        { company_id: LCO, journal_entry_id: je.id, account_id: s1015.id, account_name: "Stripe Receivable", debit: 1000, credit: 0, class_id: null, memo: tag },
        { company_id: LCO, journal_entry_id: je.id, account_id: arId, account_name: "AR", debit: 0, credit: 1000, class_id: null, memo: tag },
      ]);
      if (lErr) throw lErr;
    };
    const rev = (a) => sb.rpc("stripe_post_reversal", { p_charge_id: null, p_dispute_id: null, p_dispute_status: null, p_date: null, p_description: "Stripe refund — " + tag, p_memo: tag, p_company_id: LCO, ...a });
    const reversed = async (pi) => {
      const { data } = await sb.from("acct_journal_entries").select("id, reference, status, lines:acct_journal_lines(debit, credit, account_id)").eq("company_id", LCO).eq("stripe_payment_intent_id", pi).neq("reference", "STRIPE-" + pi);
      for (const j of data || []) if (!made.jes.includes(j.id)) made.jes.push(j.id);
      return (data || []).reduce((s, j) => s + (j.reference.includes("-WON-") ? -1 : 1) * Math.round(j.lines.reduce((a, l) => a + Number(l.debit), 0) * 100), 0);
    };
    const pA = "pi_qafix_" + Date.now().toString(36) + "_A", chA = "ch_qafix_A_" + Date.now().toString(36);
    await mkPayment(pA);
    const conc = await Promise.all([
      rev({ p_payment_intent_id: pA, p_charge_id: chA, p_kind: "refund", p_reference: "STRIPE-REFUND-" + chA + "-30000", p_amount_cents: 30000 }),
      rev({ p_payment_intent_id: pA, p_charge_id: chA, p_kind: "refund", p_reference: "STRIPE-REFUND-" + chA + "-60000", p_amount_cents: 60000 }),
      rev({ p_payment_intent_id: pA, p_charge_id: chA, p_kind: "refund", p_reference: "STRIPE-REFUND-" + chA + "-60000", p_amount_cents: 60000 }),
    ]);
    assert("LIVE Q1 concurrent refunds (cum 300, 600, 600 resent) -> exactly 600 reversed", conc.every(x => !x.error) && await reversed(pA) === 60000, JSON.stringify(conc.map(x => x.error?.message || x.data)));
    const dsp = await rev({ p_payment_intent_id: pA, p_charge_id: chA, p_kind: "dispute", p_reference: "STRIPE-DISPUTE-dp_qafix_A", p_amount_cents: 103121, p_dispute_id: "dp_qafix_A_" + tag.length, p_dispute_status: "needs_response" });
    assert("LIVE Q2 dispute after 600 refunded -> capped at the remaining 400 (never above booked)", !dsp.error && dsp.data?.amount_cents === 40000 && await reversed(pA) === 100000, JSON.stringify(dsp.error?.message || dsp.data));
    const more = await rev({ p_payment_intent_id: pA, p_charge_id: chA, p_kind: "refund", p_reference: "STRIPE-REFUND-" + chA + "-103121", p_amount_cents: 103121 });
    assert("LIVE Q1 a further refund once fully reversed -> nothing posted", !more.error && more.data?.skipped === "nothing_to_reverse" && await reversed(pA) === 100000);
    const { data: revJes } = await sb.from("acct_journal_entries").select("number, date, lines:acct_journal_lines(debit, credit)").eq("company_id", LCO).eq("stripe_payment_intent_id", pA).neq("reference", "STRIPE-" + pA);
    assert("LIVE reversal entries are numbered JE-NNNN, dated, and balanced", (revJes || []).length >= 2 && revJes.every(j => /^JE-\d{4,}$/.test(j.number) && j.date && Math.abs(j.lines.reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0)) < 0.001));
    const pB = "pi_qafix_" + Date.now().toString(36) + "_B", dpB = "dp_qafix_B_" + Date.now().toString(36);
    made.disputes.push(dpB);
    await mkPayment(pB);
    const w = await rev({ p_payment_intent_id: pB, p_kind: "dispute_won", p_reference: "STRIPE-DISPUTE-WON-" + dpB, p_amount_cents: null, p_dispute_id: dpB, p_dispute_status: "won" });
    const c = await rev({ p_payment_intent_id: pB, p_kind: "dispute", p_reference: "STRIPE-DISPUTE-" + dpB, p_amount_cents: 103121, p_dispute_id: dpB, p_dispute_status: "needs_response" });
    assert("LIVE Q3 won before created: marker recorded, created skipped, net reversal 0", !w.error && w.data?.skipped === "nothing_to_repost" && !c.error && c.data?.skipped === "dispute_already_won" && await reversed(pB) === 0, JSON.stringify([w.error?.message || w.data, c.error?.message || c.data]));
    const cS = await rev({ p_payment_intent_id: pB, p_kind: "dispute", p_reference: "STRIPE-DISPUTE-" + dpB + "-x", p_amount_cents: 103121, p_dispute_id: dpB + "x", p_dispute_status: "needs_response", p_refund_full: false });
    assert("LIVE N2 the RPC returns the payment status it derived under the lock", !cS.error && typeof cS.data?.payment_status !== "undefined", JSON.stringify(cS.error?.message || cS.data));
    const anonSb = createClient(url, process.env.TEST_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const aS = await anonSb.rpc("_stripe_sync_payment_status", { p_company_id: LCO, p_payment_intent_id: pA, p_charge_id: null, p_dispute_id: null, p_refund_full: false });
    const aC = await anonSb.rpc("_stripe_post_reversal_core", { p_company_id: LCO, p_payment_intent_id: pA, p_charge_id: null, p_kind: "refund", p_reference: "x", p_amount_cents: 1, p_description: "x", p_memo: "x", p_dispute_id: null, p_dispute_status: null, p_date: null });
    assert("LIVE anon cannot execute _stripe_sync_payment_status / _stripe_post_reversal_core", !!aS.error && !!aC.error, JSON.stringify([aS.error?.message, aC.error?.message]));
    const a1 = await anonSb.rpc("stripe_post_reversal", { p_company_id: LCO, p_payment_intent_id: pA, p_charge_id: null, p_kind: "refund", p_reference: "STRIPE-REFUND-x-1", p_amount_cents: 1, p_description: "x", p_memo: "x", p_dispute_id: null, p_dispute_status: null, p_date: null });
    const a2 = await anonSb.rpc("stripe_tenant_ar", { p_company_id: LCO, p_tenant_id: t.id });
    const a3 = await anonSb.from("stripe_dispute_outcomes").select("dispute_id").limit(1);
    assert("LIVE anon cannot execute stripe_post_reversal / stripe_tenant_ar or read the marker table", !!a1.error && !!a2.error && (!!a3.error || (a3.data || []).length === 0), JSON.stringify([a1.error?.message, a2.error?.message, a3.error?.message]));
  } finally {
    const { data: stray } = await sb.from("acct_journal_entries").select("id").eq("company_id", LCO).like("stripe_payment_intent_id", "pi_qafix_%");
    for (const j of stray || []) if (!made.jes.includes(j.id)) made.jes.push(j.id);
    for (const id of made.jes) await sb.from("acct_journal_lines").delete().eq("journal_entry_id", id);
    if (made.jes.length) await sb.from("acct_journal_entries").delete().in("id", made.jes);
    if (made.disputes.length) await sb.from("stripe_dispute_outcomes").delete().in("dispute_id", made.disputes);
    await sb.from("stripe_dispute_outcomes").delete().like("dispute_id", "dp_qafix_%");
    for (const tid of made.tenants) {
      await sb.from("acct_accounts").delete().eq("company_id", LCO).eq("tenant_id", tid);
      await sb.from("tenants").delete().eq("id", tid);
      await sb.from("audit_trail").delete().eq("module", "tenants").eq("record_id", String(tid));
    }
    const { data: left } = await sb.from("acct_journal_entries").select("id").eq("company_id", LCO).like("reference", "%qafix%");
    assert("LIVE cleanup: no QAFIX rows left", (left || []).length === 0);
  }
} catch (e) {
  assert("live RPC section ran", false, e.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
