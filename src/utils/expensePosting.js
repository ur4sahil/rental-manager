// Ledger reads + postings that keep one expense booked once (audit theme K).
// The rules are in expenseRules.js; this file only gathers the facts they
// need and posts what they decide.
//
// Every function takes an optional `deps` ({ sb, post, resolve }) so the
// live test can drive the exact same code with a service-key client. The
// app uses the defaults.
import { supabase } from "../supabase";
import { autoPostJournalEntry, resolveAccountId, getPropertyClassId } from "./accounting";
import {
  AP_CODE, REPAIRS_CODE,
  workOrderAccrualReference, workOrderCloseoutReference, invoicePaymentReference,
  planWorkOrderAccrual, planInvoicePayment, planWorkOrderCloseout, invoicePaymentLines,
  taxesEscrowed,
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
//   woAccrued                -- AP credit on the live WO-<id> accrual
//   appliedByOthers          -- AP debits against it: linked payments other
//                               than excludeInvoiceId, plus any close-out
//   expensedByLinkedPayments -- Repairs debits booked by linked payments
//   invoiceStatuses          -- status of every linked invoice
async function workOrderRepairFacts(d, companyId, woId, excludeInvoiceId) {
  const { data: linked, error } = await d.sb.from("vendor_invoices").select("id, status")
    .eq("company_id", companyId).eq("work_order_id", woId);
  if (error) return null;
  const woRef = workOrderAccrualReference(woId);
  const adjRef = workOrderCloseoutReference(woId);
  const payRefs = (linked || []).map(r => invoicePaymentReference(r.id));
  const entries = await liveEntries(d.sb, companyId, [woRef, adjRef, ...payRefs]);
  if (!entries) return null;
  const apId = await d.resolve(AP_CODE, companyId);
  const repairsId = await d.resolve(REPAIRS_CODE, companyId);
  if (!apId || !repairsId) return null;
  const accrual = entries.filter(e => e.reference === woRef);
  const payments = entries.filter(e => e.reference !== woRef && e.reference !== adjRef);
  const others = entries.filter(e => e.reference !== woRef && e.reference !== invoicePaymentReference(excludeInvoiceId));
  return {
    woAccrued: sumLines(accrual, apId, "credit"),
    appliedByOthers: sumLines(others, apId, "debit"),
    expensedByLinkedPayments: sumLines(payments, repairsId, "debit"),
    invoiceStatuses: (linked || []).map(r => r.status),
  };
}

// Work order marked completed -- from the status button or the edit form.
// Accrues the cost (once), then closes out any unused accrual if every linked
// invoice is already paid. Returns { jeId, accrued, reason, closeout }.
export async function postWorkOrderCompletion({ companyId, wo, date }, deps) {
  const res = await accrueWorkOrder({ companyId, wo, date }, deps);
  const closeout = (res.reason === "read_failed" || res.reason === "post_failed" || res.reason === "missing_input")
    ? null : await closeOutWorkOrder({ companyId, woId: wo.id, date }, deps);
  return { ...res, closeout };
}

async function accrueWorkOrder({ companyId, wo, date }, deps) {
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

// Close-out of an under-billed work order: once it is completed and every
// linked invoice is paid, reverse the accrual the invoices did not use
// (DR Accounts Payable / CR Repairs, reference WO-ADJ-<wo id>). Safe to call
// after any completion or payment -- it does nothing until the conditions
// hold, and never posts twice (an existing WO-ADJ entry, voided included,
// means it was already dealt with). Returns { jeId, reversed, reason }.
export async function closeOutWorkOrder({ companyId, woId, date }, deps) {
  const d = withDeps(deps);
  const ref = workOrderCloseoutReference(woId);
  if (!companyId || !ref) return { jeId: null, reversed: 0, reason: "missing_input" };
  const [{ data: woRows, error: wErr }, { data: existing, error: exErr }] = await Promise.all([
    d.sb.from("work_orders").select("id, status, property, issue").eq("company_id", companyId).eq("id", woId).limit(1),
    d.sb.from("acct_journal_entries").select("id").eq("company_id", companyId).eq("reference", ref).limit(1),
  ]);
  if (wErr || exErr) return { jeId: null, reversed: 0, reason: "read_failed" };
  if (existing && existing.length > 0) return { jeId: null, reversed: 0, reason: "already_posted" };
  const wo = (woRows || [])[0];
  if (!wo) return { jeId: null, reversed: 0, reason: "no_work_order" };
  const facts = await workOrderRepairFacts(d, companyId, woId, null);
  if (!facts) return { jeId: null, reversed: 0, reason: "read_failed" };
  const plan = planWorkOrderCloseout({ woCompleted: wo.status === "completed", invoiceStatuses: facts.invoiceStatuses, woAccrued: facts.woAccrued, applied: facts.appliedByOthers });
  if (!(plan.reverse > 0)) return { jeId: null, reversed: 0, reason: plan.reason };
  const classId = await d.classOf(wo.property, companyId);
  const memo = `Unused accrual reversed — work order #${wo.id}: ${wo.issue || ""}`;
  const jeId = await d.post({
    companyId, date,
    description: `Work order #${wo.id} closed under budget — ${wo.property || ""}`,
    reference: ref,
    property: wo.property || "",
    lines: [
      { account_id: AP_CODE, account_name: "Accounts Payable", debit: plan.reverse, credit: 0, class_id: classId, memo },
      { account_id: REPAIRS_CODE, account_name: "Repairs & Maintenance", debit: 0, credit: plan.reverse, class_id: classId, memo },
    ],
  });
  return { jeId, reversed: jeId ? plan.reverse : 0, reason: jeId ? plan.reason : "post_failed" };
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
