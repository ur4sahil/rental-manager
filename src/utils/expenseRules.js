// One real-world expense, one expense line (audit theme K).
//
// Pure rules only -- no imports -- so tests load this file as-is. The async
// code that reads the ledger and posts lives in expensePosting.js; the tax
// cron (api/_tax-bill-reminders-impl.js) mirrors the escrow rule.
//
// REPAIRS. A repair can reach the books from two sides: completing its work
// order (accrues DR Repairs / CR Accounts Payable, reference WO-<wo id>) and
// paying the vendor invoice for it (reference VPAY-<invoice id>). Both used
// to debit Repairs. Now:
//   - paying an invoice LINKED to a work order first uses up whatever that
//     work order accrued and nothing else has used yet: that part is
//     DR Accounts Payable. Only an excess over the accrual is new expense.
//   - completing a work order accrues only the part of its cost that linked
//     invoice payments have not already expensed.
//   - an invoice with no work order books DR Repairs / CR Checking when it is
//     paid (owner decision: vendor bills are booked when paid).
//   - once the work order is completed and EVERY linked invoice is paid, any
//     accrual the invoices did not use is reversed (DR Accounts Payable /
//     CR Repairs, reference WO-ADJ-<wo id>), once.
// Every combination (WO only, invoice only, WO then invoice, invoice then
// WO, several invoices against one WO, under- or over-billing, either side
// voided) therefore expenses the repair exactly once. Voided entries count
// as absent.
//
// MORTGAGE. Owner decision: cash basis, no automatic mortgage entries. The
// wizard no longer creates a recurring mortgage schedule, and the Loans
// page's "Record payment" posts nothing -- it only tracks the loan balance.
// The payment is booked when the bank transaction is categorized or matched.
//
// ESCROWED TAXES. When the lender pays the taxes from escrow there is no tax
// bill for the owner to pay, so none is generated, listed as due or reminded.

export const AP_CODE = "2110";
export const REPAIRS_CODE = "5300";
export const CASH_CODE = "1000";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ─── references ────────────────────────────────────────────────────────────
export function workOrderAccrualReference(woId) {
  const id = String(woId ?? "").trim();
  return id ? "WO-" + id : null;
}
export function workOrderCloseoutReference(woId) {
  const id = String(woId ?? "").trim();
  return id ? "WO-ADJ-" + id : null;
}
export function invoicePaymentReference(invoiceId) {
  const id = String(invoiceId ?? "").trim();
  return id ? "VPAY-" + id : null;
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
//   appliedByOthers  -- AP debits already booked against that accrual by OTHER
//                       linked invoice payments or a close-out reversal
export function planInvoicePayment({ amount, woAccrued = 0, appliedByOthers = 0 }) {
  const amt = round2(amount);
  if (!(amt > 0)) return { ap: 0, expense: 0, cash: 0 };
  const remaining = round2(Math.max(0, round2(woAccrued) - round2(appliedByOthers)));
  const ap = round2(Math.min(amt, remaining));
  const expense = round2(amt - ap);
  return { ap, expense, cash: amt };
}

// Close-out of an under-billed work order. Reverses the accrual the invoices
// did not use -- only when the work order is completed, it has at least one
// linked invoice, and every linked invoice is paid.
//   woAccrued  -- live accrual (AP credit on WO-<id>)
//   applied    -- AP debits already booked against it (linked payments + any
//                 earlier close-out)
export function planWorkOrderCloseout({ woCompleted, invoiceStatuses, woAccrued = 0, applied = 0 }) {
  const statuses = invoiceStatuses || [];
  if (!woCompleted) return { reverse: 0, reason: "work_order_open" };
  if (statuses.length === 0) return { reverse: 0, reason: "no_linked_invoice" };
  if (!statuses.every(s => s === "paid")) return { reverse: 0, reason: "invoices_unpaid" };
  const reverse = round2(Math.max(0, round2(woAccrued) - round2(applied)));
  return reverse > 0 ? { reverse, reason: "reverse_unused_accrual" } : { reverse: 0, reason: "fully_used" };
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
