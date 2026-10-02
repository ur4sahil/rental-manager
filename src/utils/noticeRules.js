// Notices and move-out: the rules. PURE -- no imports, no I/O -- so tests
// can load this file in plain node. (Phase 3 of docs/PLAN-tenant-documents.md.)

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, "0");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cents = (n) => Math.round(num(n) * 100) / 100;
const isIso = (s) => ISO.test(String(s || ""));
const toUtc = (s) => { const m = String(s).match(ISO); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); };
const addDays = (iso, days) => { const d = toUtc(iso); d.setUTCDate(d.getUTCDate() + Number(days || 0)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
const usd = (n) => "$" + num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Notice that a tenancy is ending ────────────────────────────────────
// Recording it used to mean: status "notice" and a move-out date. Not when
// it was given, nor by whom -- the two facts a dispute turns on.
export const NOTICE_BY_LABEL = { tenant: "the tenant", landlord: "the landlord" };
/** Which document puts this notice in writing. */
export const noticeTemplateFor = (givenBy) => (givenBy === "landlord" ? "notice_to_vacate" : "move_out_acknowledgment");

/**
 * @returns {{ ok: boolean, error?: string, warning?: string, days?: number }}
 * A short notice is recorded, not refused: the notice was given, whatever its
 * length, and the record should say what happened. It is flagged instead.
 */
export function checkNotice({ givenBy, noticeDate, moveOutDate, today, noticeDays = 60, date = (d) => d }) {
  if (givenBy !== "tenant" && givenBy !== "landlord") return { ok: false, error: "Say who gave the notice." };
  if (!isIso(noticeDate)) return { ok: false, error: "Enter the date the notice was given." };
  if (!isIso(moveOutDate)) return { ok: false, error: "Enter the move-out date." };
  if (isIso(today) && noticeDate > today) return { ok: false, error: "The notice date cannot be in the future." };
  if (moveOutDate < noticeDate) return { ok: false, error: "The move-out date cannot be before the notice was given." };
  const days = daysBetween(noticeDate, moveOutDate);
  const need = Math.max(0, Math.floor(num(noticeDays)));
  const warning = days < need
    ? `That is ${days} day${days === 1 ? "" : "s"}' notice; ${need} is required. With notice on ${date(noticeDate)}, ${need} days ends ${date(addDays(noticeDate, need))}.`
    : "";
  return { ok: true, days, warning };
}
/** The move-out date a notice given on `noticeDate` points to. */
export const defaultMoveOutDate = (noticeDate, noticeDays = 60) => (isIso(noticeDate) ? addDays(noticeDate, Math.max(0, Math.floor(num(noticeDays)))) : "");

// ── Late rent notice ───────────────────────────────────────────────────
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "October 2026", for the month a date falls in. */
export function rentPeriodLabel(iso) {
  const m = String(iso || "").match(ISO);
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : "";
}

// ── The deposit after move-out ─────────────────────────────────────────
// The move-out puts the deposit on the tenant's ledger as a credit and the
// deductions on it as charges, so the ledger ends at exactly what is
// refunded (a credit) or still owed (a debit). The statement is that same
// arithmetic, itemised:
//
//   balance before + deductions - deposit released = what the ledger ends at
//
//   held            the deposit on the lease
//   released        what this move-out actually took off "deposits held"
//                   (less than `held` if part was returned earlier)
//   deductions      [{ desc, amount }]
//   balanceBefore   what the tenant owed going in (negative = a credit)
//   waived          the remaining debt was written off
export function depositStatement({ held = 0, released = null, deductions = [], balanceBefore = 0, interest = 0, waived = false }) {
  const h = cents(held), rel = released === null || released === undefined ? h : cents(released);
  const items = (deductions || []).map(d => ({ desc: String(d?.desc || "").trim(), amount: cents(d?.amount) })).filter(d => d.amount > 0);
  const totalDeductions = cents(items.reduce((s, d) => s + d.amount, 0));
  const int = cents(interest), before = cents(balanceBefore);
  const end = cents(before + totalDeductions - rel - int);          // > 0: still owed; < 0: to refund
  const returned = end < 0 ? cents(-end) : 0;
  const owed = end > 0 && !waived ? end : 0;
  // Of the deposit, what went to unpaid rent and charges rather than damage.
  const afterDamage = Math.max(0, cents(rel + int - totalDeductions));
  const appliedToBalance = before > 0 ? Math.min(before, afterDamage) : 0;
  return {
    held: h, released: rel, interest: int, items, totalDeductions, balanceBefore: before,
    appliedToBalance: cents(appliedToBalance), returned, owed, writtenOff: end > 0 && waived ? end : 0,
    // Returned earlier (on the Leases page, or an earlier move-out), so not part of this one.
    releasedEarlier: cents(Math.max(0, h - rel)),
  };
}
/** The itemised list as text, one line each, for the statement. */
export function deductionsText(items, money = usd) {
  const list = (items || []).filter(d => num(d?.amount) > 0);
  if (!list.length) return "Nothing was withheld for damage.";
  return list.map(d => `${d.desc || "Deduction"}: ${money(d.amount)}`).join("\n");
}
/** The last day the statement and deposit may be sent. */
export const depositDueBy = (moveOutDate, days = 45) => (isIso(moveOutDate) ? addDays(moveOutDate, Math.max(0, Math.floor(num(days)))) : "");

/** The values the Security Deposit Statement template is filled with. */
export function depositStatementValues(stmt, { moveOutDate = "", forwardingAddress = "", money = usd } = {}) {
  return {
    move_out_date: moveOutDate,
    forwarding_address: forwardingAddress,
    deposit_held: money(stmt.released),
    deposit_interest: money(stmt.interest),
    deductions_list: deductionsText(stmt.items, money),
    total_deductions: money(stmt.totalDeductions),
    other_owed: money(stmt.appliedToBalance),
    amount_returned: money(stmt.returned),
    balance_owed: money(stmt.owed),
  };
}
