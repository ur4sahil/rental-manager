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

// One key per schedule, billing period and ATTEMPT DAY. Stripe returns the
// original PaymentIntent for a repeated key instead of charging again, and it
// remembers a key for 24h. Same-day overlaps therefore cannot double-charge
// (the atomic period claim is the primary guard; this backs it up). The day is
// part of the key so a retry on a later day -- after a decline, or after the
// tenant replaces their card -- is a real new attempt, not a replay of the old
// decline or a "same key, different parameters" rejection. A successful
// charge moves next_charge_date to the next period, so later days never
// re-attempt a period that was paid.
function autopayIdempotencyKey(scheduleId, period, attemptDate) {
  if (!scheduleId || !billingPeriodOf(period)) throw new Error("autopayIdempotencyKey needs a schedule id and a YYYY-MM period");
  const day = String(attemptDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("autopayIdempotencyKey needs the attempt date (YYYY-MM-DD)");
  return "autopay-" + scheduleId + "-" + billingPeriodOf(period) + "-" + day;
}

// Days in month `m` (1-12) of year `y`, computed in UTC so the host's time
// zone can never shift it.
function daysInMonthUtc(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// The due date inside billing period `period` ("YYYY-MM") for a schedule
// charged on `dayOfMonth`: that day, clamped to the month's last day
// (day 31 in February -> the 28th/29th). Null for a malformed period.
function chargeDateInPeriod(period, dayOfMonth) {
  const p = billingPeriodOf(period);
  if (!p) return null;
  const y = parseInt(p.slice(0, 4), 10), m = parseInt(p.slice(5, 7), 10);
  const want = Math.max(1, Math.floor(num(dayOfMonth)) || 1);
  const d = Math.min(want, daysInMonthUtc(y, m));
  return p + "-" + String(d).padStart(2, "0");
}

// WHEN AN AUTOPAY SCHEDULE IS NEXT DUE after it has been charged for
// `period`: the month AFTER the claimed period -- never "a month from
// today". A schedule that fell behind (due 2026-08-01, charged 2026-09-28)
// is next due 2026-09-01, so September is billed on the next run instead of
// being skipped; a charge that lands on the 31st does not overflow into the
// month after next. Pure string/UTC arithmetic (no setMonth overflow, no
// local-vs-ISO mixing).
function nextChargeDateAfterPeriod(period, dayOfMonth) {
  const p = billingPeriodOf(period);
  if (!p) return null;
  let y = parseInt(p.slice(0, 4), 10), m = parseInt(p.slice(5, 7), 10) + 1;
  if (m > 12) { m = 1; y += 1; }
  return chargeDateInPeriod(y + "-" + String(m).padStart(2, "0"), dayOfMonth);
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

// ── payments.status of a Stripe payment ─────────────────────────────────
// Stripe does not guarantee event order, so the status is DERIVED from the
// books rather than copied from whichever event arrived last. For refunds
// and disputes the stripe_post_reversal RPC derives it under the payment's
// lock (migration 20260928090000, _stripe_sync_payment_status); this is the
// same rule in JS, for tests and documentation. Precedence, top down:
//
//   dispute_lost        a dispute reversal was posted and the dispute closed lost
//   disputed            a dispute reversal was posted, not yet won or lost
//   refunded            refund reversals >= booked rent, or Stripe says the
//                       charge is fully refunded, or it already said refunded
//   partially_refunded  any refund reversal, or it already said so
//   paid                otherwise -- including a dispute that was WON
//
// So: a won dispute on a partially refunded payment is partially_refunded,
// not paid; a partial-refund event cannot overwrite disputed; a dispute that
// reversed nothing (the payment was already fully refunded) leaves refunded.
function derivePaymentStatus({ lostDisputes = 0, openDisputes = 0, refundedCents = 0, bookedCents = 0, refundFull = false, current = null } = {}) {
  if (num(lostDisputes) > 0) return "dispute_lost";
  if (num(openDisputes) > 0) return "disputed";
  if ((num(bookedCents) > 0 && num(refundedCents) >= num(bookedCents)) || refundFull || current === "refunded") return "refunded";
  if (num(refundedCents) > 0 || current === "partially_refunded") return "partially_refunded";
  return "paid";
}

// When the books cannot be consulted (the payment's entry was voided), the
// webhook still writes the event's status, but only FORWARD along the same
// order: paid < partially_refunded < refunded, paid < disputed < dispute_lost,
// and a refunded payment is never later marked disputed/lost (a dispute on a
// fully refunded charge reverses nothing). Returns the current statuses that
// block writing `incoming`; applied as a conditional update (no read-then-
// write race).
const PAYMENT_STATUS_BLOCKERS = {
  paid: ["partially_refunded", "refunded", "disputed", "dispute_lost"],
  partially_refunded: ["refunded", "disputed", "dispute_lost"],
  refunded: ["dispute_lost"],
  disputed: ["refunded", "dispute_lost"],
  dispute_lost: ["refunded"],
};
function paymentStatusBlockers(incoming) {
  return (PAYMENT_STATUS_BLOCKERS[incoming] || []).slice();
}
function paymentStatusMayMove(current, incoming) {
  return !paymentStatusBlockers(incoming).includes(String(current || ""));
}

// What a Stripe dispute event means for the books (api/stripe.js):
//   "reverse"  a chargeback is open: funds were withdrawn -> reverse the payment
//   "lost"     closed lost: make sure it is reversed; record the loss
//   "won"      closed won: re-post what was reversed
//   "noop"     nothing moves
// Inquiries (status warning_needs_response / warning_under_review /
// warning_closed) withdraw no funds, so every inquiry event is a no-op; an
// inquiry that escalates arrives with a chargeback status (needs_response /
// under_review) on charge.dispute.updated / .funds_withdrawn / .created and
// is reversed then. docs.stripe.com/disputes/how-disputes-work#inquiries
const DISPUTE_OPEN_STATUSES = ["needs_response", "under_review"];
function disputeEventAction(eventType, status) {
  const st = String(status || "");
  if (/^warning_/.test(st)) return "noop";
  if (eventType === "charge.dispute.closed") return st === "lost" ? "lost" : st === "won" ? "won" : "noop";
  if (eventType === "charge.dispute.created" || eventType === "charge.dispute.updated" || eventType === "charge.dispute.funds_withdrawn") {
    if (DISPUTE_OPEN_STATUSES.includes(st)) return "reverse";
    // An unchallengeable dispute is created already lost.
    if (eventType === "charge.dispute.created" && st === "lost") return "lost";
    // created with no status at all (older payloads): funds are withdrawn
    // when a chargeback opens.
    if (eventType === "charge.dispute.created" && st === "") return "reverse";
    return "noop";
  }
  return "noop";
}

// Only these company roles may trigger the autopay charger with their own
// login (the cron uses CRON_SECRET). company_members.role "owner" is the
// OWNER-PORTAL role (a property owner, not a company owner) and is excluded.
const AUTOPAY_RUN_ROLES = ["admin"];
function autopayRunCompanyIds(memberships) {
  return [...new Set((memberships || [])
    .filter(m => m && m.company_id && String(m.status || "") === "active" && AUTOPAY_RUN_ROLES.includes(String(m.role || "").toLowerCase()))
    .map(m => String(m.company_id)))];
}

// Is this recurring_journal_entries row the tenant's RENT schedule (as
// opposed to, say, a pet fee or parking charge billed to the same tenant)?
// Rent schedules credit Rental Income (code 4000). `rentalIncomeIds` are the
// company's acct_accounts ids for 4000. Stored ids may be the uuid or the
// legacy code string "4000".
function isRentSchedule(schedule, rentalIncomeIds) {
  if (!schedule) return false;
  const ids = new Set((rentalIncomeIds || []).filter(Boolean).map(String));
  const credit = String(schedule.credit_account_id || "");
  if (credit && (ids.has(credit) || credit === "4000")) return true;
  if (/^rental income\b/i.test(String(schedule.credit_account_name || "").trim())) return true;
  return false;
}

// ── Tenant AR account (getOrCreateTenantAR) ──────────────────────────────
// Legacy fallback by name: the accounts named exactly "AR - <tenant name>".
// Mirrors the SQL helper _late_fee_tenant_ar: adopt only when the name is
// unambiguous (exactly one such account) AND that account is not linked to
// any tenant. An account linked to a DIFFERENT tenant -- for example the
// archived tenant row of someone who has moved back in -- is never returned;
// the caller creates a fresh one instead. Without a tenant id (legacy
// name-only callers) the single same-name account is returned as before.
function pickLegacyNamedArAccount(rows, tenantId) {
  const list = (rows || []).filter(r => r && r.id);
  if (list.length !== 1) return null;
  const only = list[0];
  const hasTid = !(tenantId === null || tenantId === undefined || tenantId === "");
  if (!hasTid) return only;
  const linked = !(only.tenant_id === null || only.tenant_id === undefined || only.tenant_id === "");
  if (linked) return String(only.tenant_id) === String(tenantId) ? only : null;
  return only;
}

// Next per-tenant AR sequence N (for code "1100-" + N padded to 3) from the
// existing codes: numeric max + 1 (a string sort puts "1100-1000" below
// "1100-999"), plus `bump` for a retry after a collision.
function nextTenantArSeq(codes, bump) {
  let max = 0;
  for (const c of codes || []) {
    const m = /^1100-(\d+)$/.exec(String(c || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1 + Math.max(0, Math.floor(num(bump)));
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
  chargeDateInPeriod, nextChargeDateAfterPeriod,
  autopayMethodFromPmType, isAchAutopayMethod,
  refundReference, disputeReference, disputeWonReference, refundDeltaCents, buildReversalLines,
  paymentStatusBlockers, paymentStatusMayMove, derivePaymentStatus, disputeEventAction, autopayRunCompanyIds, isRentSchedule,
  pickLegacyNamedArAccount, nextTenantArSeq,
  matchAutopayTenant, isStripeSchedule,
};
