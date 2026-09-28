// Rent receipts, autopay and Stripe: the pure rules.
//
// PURE and CommonJS -- no imports, no I/O -- so the same file is used by the
// browser bundle (webpack interops module.exports), by api/stripe.js (a
// Vercel Node function that require()s it, as it does notificationTemplates)
// and by tests/payments-autopay-stripe.test.mjs in plain node.
//
// Why these exist: rent receipts were deciding where to post by looking for
// charge references ("RENT-AUTO-", "ACCR-") that nothing produces any more.
// Real rent charges are RECUR-<schedule id8>-YYYY-MM (autoPostRecurringEntries)
// and RENT1-/PRORENT- (the property wizard). So every autopay receipt was
// booked as NEW rental income on top of the rent charge that had already been
// recognised, the tenant's receivable never went down, the owner distribution
// never fired and move-out proration never found anything to prorate.

// Every reference family that posts a RENT CHARGE (DR tenant AR / CR 4000).
// RENT-AUTO- and ACCR- are legacy families still present in old books.
const RENT_CHARGE_PREFIXES = ["RECUR-", "RENT1-", "PRORENT-", "RENT-AUTO-", "ACCR-"];

function isRentChargeReference(ref) {
  const r = String(ref || "");
  return RENT_CHARGE_PREFIXES.some(p => r.startsWith(p));
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function monthBounds(monthStr) {
  const [y, m] = String(monthStr).split("-").map(n => parseInt(n, 10));
  const last = new Date(y, m, 0).getDate();
  return { start: monthStr + "-01", end: monthStr + "-" + String(last).padStart(2, "0") };
}

// Is this acct_accounts row the tenant's OWN receivable (a per-tenant AR
// sub-account carrying tenant_id)? The bare 1100 parent is not.
function isTenantOwnArAccount(acct, tenantId) {
  if (!acct || !acct.id) return false;
  if (tenantId === null || tenantId === undefined || tenantId === "") return false;
  if (acct.tenant_id === null || acct.tenant_id === undefined || acct.tenant_id === "") return false;
  return String(acct.tenant_id) === String(tenantId);
}

// WHERE A RENT RECEIPT IS CREDITED.
//
// Rule: a rent receipt always settles the tenant's OWN receivable. Rent is
// billed to that account by the recurring engine, so the receipt must relieve
// it. Only when the tenant has no AR account of their own (none exists and one
// could not be created -- or there is no tenant at all) does the receipt fall
// back to crediting Rental Income directly.
//
// `tenantAr` is the acct_accounts row ({ id, name, tenant_id }) the caller
// resolved or created for this tenant, or null.
function pickRentReceiptCredit({ tenantAr, tenantId } = {}) {
  if (isTenantOwnArAccount(tenantAr, tenantId)) {
    return { kind: "tenant_ar", account_id: tenantAr.id, account_name: tenantAr.name || "Accounts Receivable", settlesAr: true };
  }
  return { kind: "income", account_id: "4000", account_name: "Rental Income", settlesAr: false };
}

// Does the tenant have a rent charge dated in `monthStr`? `lines` are journal
// lines on the tenant's AR account(s) with their entry embedded as
// acct_journal_entries: { reference, date, status } (object or 1-element
// array, as PostgREST returns it). Only debits of a rent-charge family count;
// voided entries do not.
function hasRentChargeInMonth(lines, arAccountIds, monthStr) {
  const ids = new Set((arAccountIds || []).map(String));
  if (ids.size === 0) return false;
  const { start, end } = monthBounds(monthStr);
  return (lines || []).some(l => {
    if (!l) return false;
    const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
    if (!je) return false;
    if (!ids.has(String(l.account_id))) return false;
    if (!(num(l.debit) > 0)) return false;
    if (String(je.status || "") === "voided") return false;
    if (!isRentChargeReference(je.reference)) return false;
    const d = String(je.date || "").slice(0, 10);
    return d >= start && d <= end;
  });
}

// The references the recurring engine gives a tenant's rent for one month:
// "RECUR-" + first 8 chars of the schedule id + "-" + YYYY-MM. Mirrors
// autoPostRecurringEntries exactly.
function recurringRentRef(scheduleId, monthStr) {
  return "RECUR-" + String(scheduleId).slice(0, 8) + "-" + monthStr;
}
function recurringRentRefsForMonth(scheduleIds, monthStr) {
  return [...new Set((scheduleIds || []).filter(id => id !== null && id !== undefined && id !== "").map(id => recurringRentRef(id, monthStr)))];
}

// From candidate journal entries, the move-out month's rent charge: the first
// non-voided entry whose reference is one of `refs` (in `refs` order, so the
// caller controls preference).
function pickMoveOutRentCharge(entries, refs) {
  const live = (entries || []).filter(e => e && String(e.status || "") !== "voided");
  for (const ref of refs || []) {
    const hit = live.find(e => e.reference === ref);
    if (hit) return hit;
  }
  return null;
}

// The business's calendar date (YYYY-MM-DD) in its own time zone. A Vercel
// function runs in UTC, so new Date().toISOString() dates an 8pm-Eastern
// payment tomorrow -- in the wrong month on the last evening of a month.
function localBusinessDate(date, timeZone) {
  const d = date instanceof Date ? date : (date ? new Date(date) : new Date());
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => (parts.find(p => p.type === t) || {}).value;
  return get("year") + "-" + get("month") + "-" + get("day");
}

// ── Stripe autopay ────────────────────────────────────────────────────────
// The billing period a charge is for: the month of the schedule's
// next_charge_date as it was when the run claimed it.
function billingPeriodOf(dateStr) {
  const s = String(dateStr || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
}

// One key per schedule per billing period. Stripe returns the original
// PaymentIntent for a repeated key instead of charging again.
function autopayIdempotencyKey(scheduleId, period) {
  if (!scheduleId || !billingPeriodOf(period)) throw new Error("autopayIdempotencyKey needs a schedule id and a YYYY-MM period");
  return "autopay-" + scheduleId + "-" + billingPeriodOf(period);
}

// PaymentMethod.type -> autopay_schedules.method. Anything that is not a US
// bank account is charged as a card (the fee the app has always applied).
function autopayMethodFromPmType(pmType) {
  return pmType === "us_bank_account" ? "stripe_us_bank_account" : "stripe_card";
}
function isAchAutopayMethod(method) {
  return method === "stripe_us_bank_account";
}

// ── Refunds and disputes ─────────────────────────────────────────────────
// Deterministic references so a resent webhook collides on
// idx_je_company_reference_unique instead of reversing twice.
// A charge can be refunded in several partial steps; charge.refunded carries
// the CUMULATIVE amount_refunded, so the reference is keyed on it.
function refundReference(chargeId, cumulativeRefundedCents) {
  return "STRIPE-REFUND-" + chargeId + "-" + Math.round(num(cumulativeRefundedCents));
}
function disputeReference(disputeId) { return "STRIPE-DISPUTE-" + disputeId; }
function disputeWonReference(disputeId) { return "STRIPE-DISPUTE-WON-" + disputeId; }

// How much rent (cents) a refund event should reverse now: the cumulative
// refunded amount, capped at the rent that was booked, less what earlier
// refund reversals already took back. Never negative.
function refundDeltaCents(rentCents, cumulativeRefundedCents, alreadyReversedCents) {
  const cap = Math.max(0, Math.round(num(rentCents)));
  const target = Math.min(cap, Math.max(0, Math.round(num(cumulativeRefundedCents))));
  return Math.max(0, target - Math.max(0, Math.round(num(alreadyReversedCents))));
}

// Reversing lines for (part of) a posted entry: debits and credits swapped,
// scaled so the entry reverses `amountCents` of the original total. The last
// line on each side absorbs rounding so DR == CR to the cent. Carries
// account_id/account_name/class_id; memo is `memo`.
function buildReversalLines(originalLines, amountCents, memo) {
  const lines = (originalLines || []).filter(l => l && (num(l.debit) > 0 || num(l.credit) > 0));
  const totalCents = Math.round(lines.reduce((s, l) => s + num(l.debit), 0) * 100);
  const amt = Math.round(num(amountCents));
  if (totalCents <= 0 || amt <= 0) return [];
  const want = Math.min(amt, totalCents);
  const scaleSide = (side) => {
    const idx = lines.map((l, i) => (num(l[side]) > 0 ? i : -1)).filter(i => i >= 0);
    const out = {};
    let used = 0;
    idx.forEach((i, k) => {
      const orig = Math.round(num(lines[i][side]) * 100);
      const c = k === idx.length - 1 ? want - used : Math.round(orig * want / totalCents);
      used += c;
      out[i] = c;
    });
    return out;
  };
  const dr = scaleSide("debit"), cr = scaleSide("credit");
  return lines.map((l, i) => ({
    account_id: l.account_id, account_name: l.account_name || "",
    // original debit becomes a credit and vice versa
    debit: (cr[i] || 0) / 100, credit: (dr[i] || 0) / 100,
    class_id: l.class_id || null, memo: memo || l.memo || "",
  })).filter(l => l.debit > 0 || l.credit > 0);
}

// ── Autopay schedule -> tenant ───────────────────────────────────────────
// By tenant_id when the schedule has one; only a schedule without one falls
// back to (case-insensitive name + property), and only when that is unique.
function matchAutopayTenant(tenants, schedule) {
  const list = tenants || [];
  if (!schedule) return null;
  if (schedule.tenant_id !== null && schedule.tenant_id !== undefined && schedule.tenant_id !== "") {
    return list.find(t => String(t.id) === String(schedule.tenant_id)) || null;
  }
  const name = String(schedule.tenant || "").trim().toLowerCase();
  if (!name) return null;
  const hits = list.filter(t => String(t.name || "").trim().toLowerCase() === name && (t.property || "") === (schedule.property || ""));
  return hits.length === 1 ? hits[0] : null;
}

// Stripe-provider schedules are charged by the cron (api/stripe.js); the
// staff "Run Now" button must never book one by hand.
function isStripeSchedule(schedule) {
  return !!schedule && String(schedule.provider || "").toLowerCase() === "stripe";
}

module.exports = {
  RENT_CHARGE_PREFIXES, isRentChargeReference, monthBounds,
  isTenantOwnArAccount, pickRentReceiptCredit, hasRentChargeInMonth,
  recurringRentRef, recurringRentRefsForMonth, pickMoveOutRentCharge,
  localBusinessDate, billingPeriodOf, autopayIdempotencyKey,
  autopayMethodFromPmType, isAchAutopayMethod,
  refundReference, disputeReference, disputeWonReference, refundDeltaCents, buildReversalLines,
  matchAutopayTenant, isStripeSchedule,
};
