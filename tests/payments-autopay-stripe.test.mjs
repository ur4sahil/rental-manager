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
  assert("key = autopay-<id>-<YYYY-MM>", R.autopayIdempotencyKey("sched-1", "2026-10") === "autopay-sched-1-2026-10");
  assert("key from a full date uses its month", R.autopayIdempotencyKey("s", "2026-10-01") === "autopay-s-2026-10");
  assert("same schedule + period -> same key (retry-safe)", R.autopayIdempotencyKey("s", "2026-10-01") === R.autopayIdempotencyKey("s", "2026-10-28"));
  assert("next period -> different key", R.autopayIdempotencyKey("s", "2026-10") !== R.autopayIdempotencyKey("s", "2026-11"));
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
const cae = acct.slice(acct.indexOf("export async function checkAccrualExists"), acct.indexOf("// ============ OWNER DISTRIBUTION AUTOMATION"));
assert("#2 accrual lookup covers every rent family", cae.includes("RENT_CHARGE_PREFIXES") && cae.includes("hasRentChargeInMonth("));
assert("#2 accrual lookup keyed on tenant_id AR accounts", /\.eq\("tenant_id", tenantId\)/.test(cae));
assert("#2 failed read still answers 'could not tell' (true)", /if \(arErr\) return true;/.test(cae) && /if \(lErr\) return true;/.test(cae));
assert("#2 autoOwnerDistribution passes tenantId through", /autoOwnerDistribution\(companyId, propertyAddress, paymentAmount, paymentDate, tenantName, tenantId\)/.test(acct) && /checkAccrualExists\(companyId, month, tenantName, tenantId\)/.test(acct));
assert("#2 runNow passes tenant id to autoOwnerDistribution", /autoOwnerDistribution\(companyId, s\.property, amt, today, tenantDisplayName, tenantRow\?\.id \|\| null\)/.test(runNow));
assert("#2 owner fee math untouched", acct.includes("const mgmtFeeCents = Math.round(paymentCents * feePct / 100);") && acct.includes("const feePct = safeNum(owner.management_fee_pct);"));
// 3
assert("#3 move-out looks up the tenant's recurring schedules by tenant_id", /from\("recurring_journal_entries"\)\s*\n?\s*\.select\("id"\)\.eq\("company_id", cid\)\.eq\("tenant_id", selectedTenant\.id\)/.test(life));
assert("#3 move-out uses recurringRentRefsForMonth + pickMoveOutRentCharge", life.includes("recurringRentRefsForMonth(") && life.includes("pickMoveOutRentCharge(rentCharges, moveOutRentRefs)"));
assert("#3 proration math unchanged", life.includes("const proratedCents = Math.round(fullRentCents * moveOutDay / daysInMoveOutMonth);") && life.includes("reference: `RENT-PRORATE-${selectedLease.id}-${moveOutMonth}`"));
// 4
const cron = api.slice(api.indexOf("async function handleChargeAutopayDue"), api.indexOf("// ── Action: webhook"));
assert("#4 idempotencyKey passed to paymentIntents.create", /idempotencyKey: autopayIdempotencyKey\(row\.id, period\)/.test(cron));
assert("#4 claim is a conditional update on the observed next_charge_date", /\.eq\("id", row\.id\)\.eq\("next_charge_date", claimedDate\)/.test(cron) && cron.indexOf("claimed by another run") < cron.indexOf("paymentIntents.create"));
assert("#4 failure releases the claim (retry next run, as before)", /next_charge_date: claimedDate,[\s\S]*?\.eq\("next_charge_date", nextDate\)/.test(cron));
assert("#4 next-date rule unchanged", cron.includes("next.setMonth(next.getMonth() + 1);") && cron.includes("next.setDate(Math.min(row.day_of_month || 1, 28));"));
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
  return {
    T,
    from,
    rpc(fn, args) {
      if (fn === "next_je_number") {
        const cid = args.p_company_id;
        const max = (T.acct_journal_entries || []).filter(j => j.company_id === cid && /^JE-\d+$/.test(j.number || "")).reduce((m, j) => Math.max(m, parseInt(j.number.slice(3), 10)), 0);
        jeNum[cid] = (jeNum[cid] || 0) + 1;
        return Promise.resolve({ data: "JE-" + String(max + 1).padStart(4, "0"), error: null });
      }
      return Promise.resolve({ data: null, error: { message: "unknown rpc " + fn } });
    },
    auth: { getUser: async (tok) => ({ data: { user: tok === "good" ? { email: "tenant@x.com" } : null }, error: null }) },
  };
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
  company_members: [],
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
    call("charge-autopay-due", { headers: { authorization: "Bearer good" } }),
    call("charge-autopay-due", { headers: { authorization: "Bearer good" } }),
  ]);
  const charges = stripeCalls.piCreate;
  assert("#4 two overlapping runs -> each schedule charged exactly once", charges.length === 2, JSON.stringify([a.body, b.body]));
  const skipped = [...a.body.results, ...b.body.results].filter(r => r.skipped === "claimed by another run").length;
  assert("#4 …the losing run skipped both as 'claimed by another run'", skipped === 2, JSON.stringify([a.body, b.body]));
  const byId = Object.fromEntries(charges.map(c => [c.params.metadata.autopay_id, c]));
  assert("#4 idempotencyKey = autopay-<id>-<period of the claimed due date>", byId["ap-1"]?.opts?.idempotencyKey === "autopay-ap-1-2026-09" && byId["ap-2"]?.opts?.idempotencyKey === "autopay-ap-2-2026-09");
  const ap2 = currentDb.T.autopay_schedules.find(r => r.id === "ap-2");
  assert("#5 legacy 'stripe_card' row whose PM is a bank account is charged the ACH fee", byId["ap-2"]?.params.metadata.payment_method_kind === "us_bank_account" && byId["ap-2"].params.amount === 100000 + 500);
  assert("#5 …and the row is corrected to stripe_us_bank_account", ap2.method === "stripe_us_bank_account");
  assert("#5 card row keeps the card fee", byId["ap-1"]?.params.amount === Math.ceil((150000 + 30) / 0.971));
  const ap1 = currentDb.T.autopay_schedules.find(r => r.id === "ap-1");
  assert("#4 claimed rows moved past the period", ap1.next_charge_date > "2026-09-01" && ap2.next_charge_date > "2026-09-05");
  // a third run the same day charges nothing
  await call("charge-autopay-due", { headers: { authorization: "Bearer good" } });
  assert("#4 a later run the same day charges nothing more", stripeCalls.piCreate.length === 2);
}
// — #4 failure releases the claim —
{
  currentDb = makeDb({ ...baseSeed(), autopay_schedules: [
    { id: "ap-9", company_id: CO, tenant_id: 42, tenant: "Jo", property: "1 Main", amount: 1500, day_of_month: 1, provider: "stripe", enabled: true, archived_at: null, next_charge_date: "2026-09-01", method: "stripe_card", stripe_customer_id: "c", stripe_payment_method_id: "pm_card" },
  ] });
  stripeState.failCreate = true;
  const r = await call("charge-autopay-due", { headers: { authorization: "Bearer good" } });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
