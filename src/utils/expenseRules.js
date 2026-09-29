// One real-world expense, one expense line (audit theme K).
//
// Pure rules only -- no imports -- so tests load this file as-is. The async
// code that reads the ledger and posts lives with its callers
// (Maintenance.js, Loans.js, accounting.js, the tax-bill cron).
//
// REPAIRS. A repair can reach the books from two sides: completing its work
// order (accrues DR Repairs / CR Accounts Payable, reference WO-<wo id>) and
// paying the vendor invoice for it (reference VPAY-<invoice id>). Both used
// to debit Repairs. Now:
//   - paying an invoice LINKED to a work order first uses up whatever that
//     work order accrued and no earlier linked payment has used: that part
//     is DR Accounts Payable. Only an excess over the accrual is new expense.
//   - completing a work order accrues only the part of its cost that linked
//     invoice payments have not already expensed.
//   - an invoice with no work order books DR Repairs / CR Checking, as before.
// Every combination (WO only, invoice only, WO then invoice, invoice then
// WO, several invoices against one WO, either side voided) therefore expenses
// the repair exactly once. Voided entries count as absent.
//
// MORTGAGE. The property wizard's monthly recurring entry
// (RECUR-<schedule id8>-YYYY-MM, DR Mortgage/Loan Payment / CR Checking) and
// the Loans page's "Record payment" (LOAN-<loan id>-YYYY-MM...) both booked
// the same monthly payment. Rule: a loan's payment is booked ONCE per
// calendar month. Whichever path gets there first books it; the other one
// recognises the month as booked and posts nothing.
//
// ESCROWED TAXES. When the lender pays the taxes from escrow there is no tax
// bill for the owner to pay, so none is generated, listed as due or reminded.

export const AP_CODE = "2110";
export const REPAIRS_CODE = "5300";
export const CASH_CODE = "1000";
export const MORTGAGE_CODE = "5600";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

// ─── references ────────────────────────────────────────────────────────────
export function workOrderAccrualReference(woId) {
  const id = String(woId ?? "").trim();
  return id ? "WO-" + id : null;
}
export function invoicePaymentReference(invoiceId) {
  const id = String(invoiceId ?? "").trim();
  return id ? "VPAY-" + id : null;
}
export function loanPaymentReference(loanId, month) {
  const id = String(loanId ?? "").trim();
  if (!id || !MONTH_RE.test(String(month || ""))) return null;
  return "LOAN-" + id + "-" + month;
}
// The recurring engine's reference for a schedule + month (mirrors
// autoPostRecurringEntries and paymentRules.recurReference).
export function recurringReference(scheduleId, month) {
  if (!scheduleId || !MONTH_RE.test(String(month || ""))) return null;
  return "RECUR-" + String(scheduleId).slice(0, 8) + "-" + month;
}

export function monthOf(dateStr) {
  const m = /^(\d{4}-\d{2})/.exec(String(dateStr || ""));
  return m && MONTH_RE.test(m[1]) ? m[1] : null;
}
export function monthBoundsOf(month) {
  const m = MONTH_RE.exec(String(month || ""));
  if (!m) return null;
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { start: month + "-01", end: month + "-" + String(last).padStart(2, "0") };
}

// ─── repairs ───────────────────────────────────────────────────────────────
// How much a work order should accrue at completion.
//   cost                      -- the work order's cost
//   expensedByLinkedPayments  -- Repairs debits already booked by payments
//                                of invoices linked to this work order
export function planWorkOrderAccrual({ cost, expensedByLinkedPayments = 0 }) {
  const c = round2(cost);
  if (!(c > 0)) return { accrue: 0, reason: "no_cost" };
  const accrue = round2(Math.max(0, c - round2(expensedByLinkedPayments)));
  if (accrue <= 0) return { accrue: 0, reason: "already_expensed_by_invoice" };
  return { accrue, reason: accrue < c ? "partly_expensed_by_invoice" : "accrue" };
}

// How a vendor-invoice payment splits between clearing the work order's
// payable and new expense.
//   amount           -- the invoice amount being paid
//   woAccrued        -- the linked work order's live accrual (0 if none/voided)
//   appliedByOthers  -- AP debits already booked by OTHER linked invoice payments
export function planInvoicePayment({ amount, woAccrued = 0, appliedByOthers = 0 }) {
  const amt = round2(amount);
  if (!(amt > 0)) return { ap: 0, expense: 0, cash: 0 };
  const remaining = round2(Math.max(0, round2(woAccrued) - round2(appliedByOthers)));
  const ap = round2(Math.min(amt, remaining));
  const expense = round2(amt - ap);
  return { ap, expense, cash: amt };
}

// Journal lines for a planned invoice payment. Account codes are bare and are
// resolved by autoPostJournalEntry.
export function invoicePaymentLines(plan, { classId = null, vendorName = "", description = "" } = {}) {
  const lines = [];
  const v = vendorName || "vendor";
  if (plan.ap > 0) lines.push({ account_id: AP_CODE, account_name: "Accounts Payable", debit: plan.ap, credit: 0, class_id: classId, memo: "Clears work-order payable — " + v });
  if (plan.expense > 0) lines.push({ account_id: REPAIRS_CODE, account_name: "Repairs & Maintenance", debit: plan.expense, credit: 0, class_id: classId, memo: v + (description ? ": " + description : "") });
  if (plan.cash > 0) lines.push({ account_id: CASH_CODE, account_name: "Checking Account", debit: 0, credit: plan.cash, class_id: classId, memo: "Payment to " + v });
  return lines;
}

// ─── mortgage ──────────────────────────────────────────────────────────────
export function isMortgageSchedule(entry) {
  return !!entry && !entry.tenant_id && /^Mortgage\/Loan/i.test(String(entry.description || ""));
}

// Does this recurring schedule book THIS loan's payment? The wizard keys the
// schedule by property, not by loan, and sets its amount to the loan's
// monthly payment. On a property with one active loan the schedule is that
// loan's; with several, only the loan whose payment matches.
export function scheduleCoversLoan({ scheduleAmount, loanAmount, activeLoanCount }) {
  if (Number(activeLoanCount) <= 1) return true;
  return Math.abs(round2(scheduleAmount) - round2(loanAmount)) < 0.005;
}

// What "Record payment" should do for `month`.
//   alreadyRecorded -- the loan's last_payment_month === month, or a live
//                      LOAN-<id>-<month>... entry exists
//   recurringBooked -- the covering schedule's RECUR entry for month is live
export function decideLoanPayment({ alreadyRecorded, recurringBooked }) {
  if (alreadyRecorded) return "already_recorded";
  if (recurringBooked) return "settle_recurring"; // reduce balance, post nothing
  return "post";
}

// Should the recurring engine skip a mortgage schedule's month because
// Record payment already booked it? `loanPayments` are the live LOAN- entries
// on the schedule's property dated in that month, each { amount }.
export function recurringMonthAlreadyPaid({ scheduleAmount, activeLoanCount, loanPayments }) {
  return (loanPayments || []).some(p => scheduleCoversLoan({ scheduleAmount, loanAmount: p.amount, activeLoanCount }));
}

// ─── escrowed taxes ────────────────────────────────────────────────────────
// escrow_covers is stored in three shapes: an object ({ taxes: true, ... },
// the wizard), an array (["taxes", ...], the column default shape) or free
// text ("Taxes, Insurance", the Loans page input).
export function escrowCoversTaxes(covers) {
  if (!covers) return false;
  if (typeof covers === "string") return /\btax(es)?\b/i.test(covers);
  if (Array.isArray(covers)) return covers.some(c => /^tax(es)?$/i.test(String(c).trim()));
  if (typeof covers === "object") return covers.taxes === true || covers.taxes === "true";
  return false;
}

// Taxes are escrowed when the tax record says the lender pays them, or an
// active loan on the property includes escrow that covers taxes.
export function taxesEscrowed({ taxRecord, loans }) {
  if (taxRecord && taxRecord.escrow_paid_by_lender) return true;
  return (loans || []).some(l => l && !l.archived_at && l.status !== "paid_off" && l.escrow_included && escrowCoversTaxes(l.escrow_covers));
}
