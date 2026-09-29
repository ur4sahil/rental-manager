// One real-world expense, one expense line (audit theme K).
//
// Pure rules only -- no imports -- so tests load this file as-is. The tax
// cron (api/_tax-bill-reminders-impl.js) mirrors the escrow rule.
//
// REPAIRS (posted by the RPCs in migration 20260928151000, which serialise on
// the work order so concurrent requests cannot double-post):
//   - completing a work order accrues DR Repairs / CR Accounts Payable once,
//     reference WO-<wo id>, minus anything linked invoice payments already
//     expensed;
//   - paying an invoice LINKED to a work order first clears whatever the
//     accrual has left (DR Accounts Payable); only an excess is new expense.
//     Reference VPAY-<invoice id>;
//   - an invoice with no work order books DR Repairs / CR Checking when paid
//     (owner decision: vendor bills are booked when paid);
//   - once the work order is completed and every linked, non-archived invoice
//     is paid, the unused accrual is reversed once (DR Accounts Payable /
//     CR Repairs, reference WO-ADJ-<wo id>). NOTE: it fires as soon as every
//     invoice entered SO FAR is paid -- an invoice entered later is booked as
//     new expense, so the total is right, but P&L is understated in between;
//   - voided entries count as absent everywhere, so a voided accrual or
//     close-out is posted again on the next completion / payment.
//
// MORTGAGE. Owner decision: cash basis, no automatic mortgage entries. The
// wizard creates no recurring mortgage schedule and the Loans page's "Record
// payment" posts nothing -- it only tracks the balance. The payment is booked
// when its bank transaction is categorized or matched in Banking.
//
// ESCROWED TAXES. When the lender pays the taxes from escrow there is no tax
// bill for the owner to pay, so none is generated, listed as due or reminded.
// escrow_covers is free-form, so it is read CONSERVATIVELY: anything unclear
// or negated counts as NOT escrowed -- a bill that shows up is safer than a
// tax payment nobody makes.

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

// ─── escrowed taxes ────────────────────────────────────────────────────────
// "Property_Taxes" / "property-tax" / " TAXES " -> "property taxes" etc.
// MIRRORED in api/_tax-bill-reminders-impl.js; both are held to
// tests/fixtures/escrow-covers.json.
const norm = (v) => String(v ?? "").toLowerCase().replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim();
const TAX_TOKENS = new Set(["tax", "taxes", "property tax", "property taxes", "real estate tax", "real estate taxes", "re tax", "re taxes",
  "county tax", "county taxes", "city tax", "city taxes", "school tax", "school taxes",
  "piti", "t&i", "t & i", "t and i", "taxes and insurance", "taxes & insurance", "tax and insurance", "tax & insurance"]);
const isTaxToken = (v) => TAX_TOKENS.has(norm(v));
const TRUTHY = new Set(["true", "yes", "y", "1", "included", "x"]);
const isTruthy = (v) => v === true || v === 1 || TRUTHY.has(norm(v));
// Any hint that taxes are NOT (or no longer, or not certainly) in escrow.
const NEGATION = /\b(no|not|none|without|exclud\w*|except|n a|false|owner pays?|paid by owner|owner paid|self pay\w*|waiv\w*|cancel\w*|remov\w*|separate\w*|borrower|by me|myself|previous\w*|formerly|former|used to|no longer|ended|stopped|dropped|ask|unknown|unsure|tbd|maybe)\b|\?/;
// Names taxes: "tax"/"taxes" as a word, or PITI / T&I.
const NAMES_TAXES = /\btax(es)?\b|\bpiti\b|(^|[^a-z])t\s*(&|and)\s*i([^a-z]|$)/;

// Free text: escrowed only when it names taxes and carries no negation or
// doubt, and "X only" does not exclude them ("Insurance only" -> no).
function textCoversTaxes(text) {
  const t = norm(text);
  if (!t || NEGATION.test(t)) return false;
  if (!NAMES_TAXES.test(t)) return false;
  const only = t.match(/^(.*?)\bonly\b/);
  if (only && !NAMES_TAXES.test(only[1])) return false;
  return true;
}

// escrow_covers arrives as an object ({ taxes: true }, the wizard), an array
// (["taxes"], the column default shape) or free text (the Loans page input).
export function escrowCoversTaxes(covers) {
  if (covers == null || covers === false) return false;
  if (typeof covers === "string") return textCoversTaxes(covers);
  if (Array.isArray(covers)) return covers.some(c => isTaxToken(c));
  if (typeof covers === "object") return Object.entries(covers).some(([k, v]) => isTaxToken(k) && isTruthy(v));
  return false;
}

// Taxes are escrowed when the tax record says the lender pays them, or an
// active loan on the property includes escrow that covers taxes. (Portfolio
// loans record escrow_included but not WHAT it covers, so they never count.)
export function taxesEscrowed({ taxRecord, loans }) {
  if (taxRecord && taxRecord.escrow_paid_by_lender === true) return true;
  return (loans || []).some(l => l && !l.archived_at && l.status !== "paid_off" && l.escrow_included === true && escrowCoversTaxes(l.escrow_covers));
}
