// Ledger reads + postings that keep one expense booked once (audit theme K).
// The rules are in expenseRules.js; this file only gathers the facts they
// need and posts what they decide.
//
// Every function takes an optional `deps` ({ sb, post, resolve }) so the
// live test can drive the exact same code with a service-key client. The
// app uses the defaults.
import { supabase } from "../supabase";
import { autoPostJournalEntry, resolveAccountId, getPropertyClassId } from "./accounting";
import { pmError } from "./errors";
import {
  AP_CODE, REPAIRS_CODE, MORTGAGE_CODE, CASH_CODE,
  workOrderAccrualReference, invoicePaymentReference, loanPaymentReference, recurringReference,
  planWorkOrderAccrual, planInvoicePayment, invoicePaymentLines,
  isMortgageSchedule, scheduleCoversLoan, decideLoanPayment, recurringMonthAlreadyPaid,
  monthBoundsOf, taxesEscrowed,
} from "./expenseRules";

const DEFAULT_DEPS = {
  get sb() { return supabase; },
  post: (args) => autoPostJournalEntry(args),
  resolve: (code, cid) => resolveAccountId(code, cid),
  classOf: (property, cid) => (property ? getPropertyClassId(property, cid) : null),
};
const withDeps = (d) => ({ sb: d?.sb || supabase, post: d?.post || DEFAULT_DEPS.post, resolve: d?.resolve || DEFAULT_DEPS.resolve, classOf: d?.classOf || DEFAULT_DEPS.classOf });

// Live (non-voided) journal entries with these references, lines included.
// Returns null when the read fails -- callers must then post nothing.
async function liveEntries(sb, companyId, refs) {
  const list = (refs || []).filter(Boolean);
  if (list.length === 0) return [];
  const out = [];
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await sb.from("acct_journal_entries")
      .select("id, reference, date, status, property, acct_journal_lines(account_id, debit, credit)")
      .eq("company_id", companyId).in("reference", list.slice(i, i + 100)).neq("status", "voided");
    if (error) return null;
    out.push(...(data || []));
  }
  return out;
}
const sumLines = (entries, accountId, side) => (entries || []).reduce((s, je) =>
  s + (je.acct_journal_lines || []).filter(l => !accountId || l.account_id === accountId)
    .reduce((t, l) => t + (Number(l[side]) || 0), 0), 0);

// What the books already say about a work order's repair cost.
async function workOrderRepairFacts(d, companyId, woId, excludeInvoiceId) {
  const { data: linked, error } = await d.sb.from("vendor_invoices").select("id")
    .eq("company_id", companyId).eq("work_order_id", woId);
  if (error) return null;
  const invIds = (linked || []).map(r => r.id);
  const woRef = workOrderAccrualReference(woId);
  const payRefs = invIds.map(invoicePaymentReference);
  const entries = await liveEntries(d.sb, companyId, [woRef, ...payRefs]);
  if (!entries) return null;
  const apId = await d.resolve(AP_CODE, companyId);
  const repairsId = await d.resolve(REPAIRS_CODE, companyId);
  if (!apId || !repairsId) return null;
  const accrual = entries.filter(e => e.reference === woRef);
  const payments = entries.filter(e => e.reference !== woRef);
  const others = payments.filter(e => e.reference !== invoicePaymentReference(excludeInvoiceId));
  return {
    woAccrued: sumLines(accrual, apId, "credit"),
    appliedByOthers: sumLines(others, apId, "debit"),
    expensedByLinkedPayments: sumLines(payments, repairsId, "debit"),
  };
}

// Work order marked completed. Returns { jeId, accrued, reason }.
export async function postWorkOrderCompletion({ companyId, wo, date }, deps) {
  const d = withDeps(deps);
  const ref = workOrderAccrualReference(wo?.id);
  if (!companyId || !ref) return { jeId: null, accrued: 0, reason: "missing_input" };
  // Any entry with this reference -- voided included -- means the work
  // order was already dealt with. A deliberately voided accrual must not
  // come back just because the status was toggled.
  const { data: existing, error: exErr } = await d.sb.from("acct_journal_entries").select("id")
    .eq("company_id", companyId).eq("reference", ref).limit(1);
  if (exErr) return { jeId: null, accrued: 0, reason: "read_failed" };
  if (existing && existing.length > 0) return { jeId: null, accrued: 0, reason: "already_posted" };
  const facts = await workOrderRepairFacts(d, companyId, wo.id, null);
  if (!facts) return { jeId: null, accrued: 0, reason: "read_failed" };
  const plan = planWorkOrderAccrual({ cost: wo.cost, expensedByLinkedPayments: facts.expensedByLinkedPayments });
  if (plan.accrue <= 0) return { jeId: null, accrued: 0, reason: plan.reason };
  const classId = await d.classOf(wo.property, companyId);
  const jeId = await d.post({
    companyId, date,
    description: `Maintenance: ${wo.issue} — ${wo.property}`,
    reference: ref,
    property: wo.property || "",
    lines: [
      { account_id: REPAIRS_CODE, account_name: "Repairs & Maintenance", debit: plan.accrue, credit: 0, class_id: classId, memo: `${wo.issue} — ${wo.assigned || "unassigned"}` },
      { account_id: AP_CODE, account_name: "Accounts Payable", debit: 0, credit: plan.accrue, class_id: classId, memo: `AP owed for: ${wo.issue}${wo.assigned ? " (" + wo.assigned + ")" : ""}` },
    ],
  });
  return { jeId, accrued: jeId ? plan.accrue : 0, reason: jeId ? plan.reason : "post_failed" };
}

// Vendor invoice paid. Returns { jeId, already, plan, reason }.
export async function postVendorInvoicePayment({ companyId, inv, date }, deps) {
  const d = withDeps(deps);
  const ref = invoicePaymentReference(inv?.id);
  if (!companyId || !ref) return { jeId: null, reason: "missing_input" };
  const prior = await liveEntries(d.sb, companyId, [ref]);
  if (!prior) return { jeId: null, reason: "read_failed" };
  if (prior.length > 0) return { jeId: prior[0].id, already: true, reason: "already_posted" };
  let facts = { woAccrued: 0, appliedByOthers: 0 };
  if (inv.work_order_id) {
    facts = await workOrderRepairFacts(d, companyId, inv.work_order_id, inv.id);
    if (!facts) return { jeId: null, reason: "read_failed" };
  }
  const plan = planInvoicePayment({ amount: inv.amount, woAccrued: facts.woAccrued, appliedByOthers: facts.appliedByOthers });
  if (!(plan.cash > 0)) return { jeId: null, reason: "no_amount" };
  const classId = await d.classOf(inv.property, companyId);
  const jeId = await d.post({
    companyId, date,
    description: "Vendor payment — " + inv.vendor_name + " — " + (inv.description || inv.invoice_number || ""),
    reference: ref,
    property: inv.property || "",
    lines: invoicePaymentLines(plan, { classId, vendorName: inv.vendor_name, description: inv.description }),
  });
  return { jeId, plan, reason: jeId ? "posted" : "post_failed" };
}

// ─── mortgage ──────────────────────────────────────────────────────────────
// The recurring schedule (if any) that books this loan's monthly payment.
async function coveringSchedule(d, companyId, loan) {
  const [{ data: scheds, error: sErr }, { data: loans, error: lErr }] = await Promise.all([
    d.sb.from("recurring_journal_entries").select("id, description, amount, tenant_id, property, status")
      .eq("company_id", companyId).eq("property", loan.property).eq("status", "active").is("archived_at", null),
    d.sb.from("property_loans").select("id, status").eq("company_id", companyId).eq("property", loan.property).is("archived_at", null),
  ]);
  if (sErr || lErr) return { error: true };
  const activeLoanCount = (loans || []).filter(l => (l.status || "active") === "active").length;
  const sched = (scheds || []).filter(isMortgageSchedule)
    .find(s => scheduleCoversLoan({ scheduleAmount: s.amount, loanAmount: loan.monthly_payment, activeLoanCount }));
  return { schedule: sched || null, activeLoanCount };
}

// "Record payment" on the Loans page for `month` ("YYYY-MM").
// Returns { action, jeId, reason } where action is one of
//   already_recorded | settle_recurring | post | failed
export async function recordLoanPayment({ companyId, loan, date, month }, deps) {
  const d = withDeps(deps);
  const ref = loanPaymentReference(loan?.id, month);
  const bounds = monthBoundsOf(month);
  if (!companyId || !ref || !bounds) return { action: "failed", reason: "missing_input" };
  // Earlier LOAN- references were date-qualified (LOAN-<id>-YYYY-MM-DD), so
  // match the month prefix rather than the exact reference.
  const { data: prior, error: pErr } = await d.sb.from("acct_journal_entries").select("id")
    .eq("company_id", companyId).like("reference", ref + "%").neq("status", "voided").limit(1);
  if (pErr) return { action: "failed", reason: "read_failed" };
  const cover = await coveringSchedule(d, companyId, loan);
  if (cover.error) return { action: "failed", reason: "read_failed" };
  let recurringBooked = false;
  if (cover.schedule) {
    const live = await liveEntries(d.sb, companyId, [recurringReference(cover.schedule.id, month)]);
    if (!live) return { action: "failed", reason: "read_failed" };
    recurringBooked = live.length > 0;
  }
  const action = decideLoanPayment({ alreadyRecorded: loan.last_payment_month === month || (prior || []).length > 0, recurringBooked });
  if (action !== "post") return { action, jeId: null, reason: action };
  const amt = Number(loan.monthly_payment) || 0;
  const classId = await d.classOf(loan.property, companyId);
  const jeId = await d.post({
    companyId, date,
    description: `Loan payment: ${loan.lender_name} — ${loan.property}`,
    reference: ref,
    property: loan.property,
    lines: [
      { account_id: MORTGAGE_CODE, account_name: "Mortgage/Loan Payment", debit: amt, credit: 0, class_id: classId, memo: `Loan: ${loan.lender_name}` },
      { account_id: CASH_CODE, account_name: "Checking Account", debit: 0, credit: amt, class_id: classId, memo: `Loan: ${loan.lender_name}` },
    ],
  });
  return jeId ? { action: "post", jeId, reason: "posted" } : { action: "failed", jeId: null, reason: "post_failed" };
}

// Recurring engine: has "Record payment" already booked this mortgage
// schedule's month? Answers TRUE when it cannot tell (fail closed: skipping
// a month is recoverable, a second expense is what we are preventing).
export async function mortgageMonthAlreadyPaid({ companyId, entry, month }, deps) {
  const d = withDeps(deps);
  if (!isMortgageSchedule(entry) || !entry.property) return false;
  const bounds = monthBoundsOf(month);
  if (!bounds) return true;
  const [{ data: pays, error: pErr }, { data: loans, error: lErr }] = await Promise.all([
    d.sb.from("acct_journal_entries").select("id, reference, acct_journal_lines(debit)")
      .eq("company_id", companyId).eq("property", entry.property).like("reference", "LOAN-%")
      .neq("status", "voided").gte("date", bounds.start).lte("date", bounds.end).limit(50),
    d.sb.from("property_loans").select("id, status").eq("company_id", companyId).eq("property", entry.property).is("archived_at", null),
  ]);
  if (pErr || lErr) {
    pmError("PM-4008", { raw: pErr || lErr, context: "mortgage month check for schedule " + entry.id, silent: true });
    return true;
  }
  const activeLoanCount = (loans || []).filter(l => (l.status || "active") === "active").length;
  const loanPayments = (pays || []).map(je => ({ amount: (je.acct_journal_lines || []).reduce((s, l) => s + (Number(l.debit) || 0), 0) }));
  return recurringMonthAlreadyPaid({ scheduleAmount: entry.amount, activeLoanCount, loanPayments });
}

// ─── escrowed taxes ────────────────────────────────────────────────────────
// Is this property's tax paid from mortgage escrow? Answers null when the
// read fails so a caller can decide; generation treats null as "don't know,
// don't generate".
export async function propertyTaxesEscrowed({ companyId, propertyAddress }, deps) {
  const d = withDeps(deps);
  const [{ data: taxRows, error: tErr }, { data: loans, error: lErr }] = await Promise.all([
    d.sb.from("property_taxes").select("escrow_paid_by_lender").eq("company_id", companyId).eq("property", propertyAddress).is("archived_at", null),
    d.sb.from("property_loans").select("escrow_included, escrow_covers, status, archived_at").eq("company_id", companyId).eq("property", propertyAddress).is("archived_at", null),
  ]);
  if (tErr || lErr) return null;
  return (taxRows || []).some(t => taxesEscrowed({ taxRecord: t, loans: [] })) || taxesEscrowed({ taxRecord: null, loans });
}

// Set of property addresses (for a company) whose taxes are escrowed.
export async function escrowedTaxProperties(companyId, deps) {
  const d = withDeps(deps);
  const [{ data: taxRows, error: tErr }, { data: loans, error: lErr }] = await Promise.all([
    d.sb.from("property_taxes").select("property, escrow_paid_by_lender").eq("company_id", companyId).is("archived_at", null),
    d.sb.from("property_loans").select("property, escrow_included, escrow_covers, status, archived_at").eq("company_id", companyId).is("archived_at", null),
  ]);
  if (tErr || lErr) return null;
  const out = new Set();
  for (const t of taxRows || []) if (t.escrow_paid_by_lender) out.add(t.property);
  for (const l of loans || []) if (taxesEscrowed({ taxRecord: null, loans: [l] })) out.add(l.property);
  return out;
}
