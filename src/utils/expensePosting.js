// Repair postings and escrow lookups that keep one expense booked once
// (audit theme K). The rules are documented in expenseRules.js.
//
// The repair postings are Postgres RPCs (migration 20260928151000): each one
// takes an advisory lock on the work order (and the invoice), reads the live
// ledger, decides and posts in ONE transaction. Doing that read-decide-post
// in the browser let two concurrent requests both decide "nothing booked
// yet" and double-expense the repair.
//
// Every function takes an optional `deps` ({ sb }) so the live test can drive
// the same code with a service-key client. The app uses the default client.
import { supabase } from "../supabase";
import { taxesEscrowed } from "./expenseRules";

const client = (deps) => deps?.sb || supabase;

async function rpc(deps, fn, args) {
  const { data, error } = await client(deps).rpc(fn, args);
  if (error) return { reason: "rpc_failed", error };
  return data || { reason: "rpc_failed" };
}

// Work order completed (status button or edit form): accrue DR Repairs /
// CR Accounts Payable once (WO-<id>), minus anything linked invoice payments
// already expensed; then close out if every linked invoice is paid.
// Returns { reason, accrued, je_id, closeout }.
export async function postWorkOrderCompletion({ companyId, wo, date }, deps) {
  if (!companyId || !wo?.id) return { reason: "missing_input", accrued: 0 };
  return rpc(deps, "repair_complete_work_order", { p_company_id: companyId, p_wo_id: Number(wo.id), p_date: date });
}

// Vendor invoice paid: posts VPAY-<id> (clearing the linked work order's
// unused accrual first), marks the invoice paid, counts it in the vendor's
// totals once, then closes out the work order.
// Returns { reason, je_id, ap, expense, marked_paid, closeout }.
export async function postVendorInvoicePayment({ companyId, inv, date }, deps) {
  if (!companyId || !inv?.id) return { reason: "missing_input" };
  const r = await rpc(deps, "repair_pay_invoice", { p_company_id: companyId, p_invoice_id: inv.id, p_date: date });
  return { ...r, jeId: r.je_id || null, already: r.reason === "already_posted" };
}

// Reverse a completed work order's unused accrual once every linked invoice
// is paid (WO-ADJ-<id>). Returns { reason, reversed, je_id }.
export async function closeOutWorkOrder({ companyId, woId, date }, deps) {
  if (!companyId || !woId) return { reason: "missing_input", reversed: 0 };
  return rpc(deps, "repair_close_out_work_order", { p_company_id: companyId, p_wo_id: Number(woId), p_date: date });
}

// ─── escrowed taxes ────────────────────────────────────────────────────────
// Is this property's tax paid from mortgage escrow? Answers null when the
// read fails so a caller can decide; generation treats null as "don't know,
// don't generate".
export async function propertyTaxesEscrowed({ companyId, propertyAddress }, deps) {
  const sb = client(deps);
  const [{ data: taxRows, error: tErr }, { data: loans, error: lErr }] = await Promise.all([
    sb.from("property_taxes").select("escrow_paid_by_lender").eq("company_id", companyId).eq("property", propertyAddress).is("archived_at", null),
    sb.from("property_loans").select("escrow_included, escrow_covers, status, archived_at").eq("company_id", companyId).eq("property", propertyAddress).is("archived_at", null),
  ]);
  if (tErr || lErr) return null;
  return (taxRows || []).some(t => taxesEscrowed({ taxRecord: t, loans: [] })) || taxesEscrowed({ taxRecord: null, loans });
}

// Set of property addresses (for a company) whose taxes are escrowed.
export async function escrowedTaxProperties(companyId, deps) {
  const sb = client(deps);
  const [{ data: taxRows, error: tErr }, { data: loans, error: lErr }] = await Promise.all([
    sb.from("property_taxes").select("property, escrow_paid_by_lender").eq("company_id", companyId).is("archived_at", null),
    sb.from("property_loans").select("property, escrow_included, escrow_covers, status, archived_at").eq("company_id", companyId).is("archived_at", null),
  ]);
  if (tErr || lErr) return null;
  const out = new Set();
  for (const t of taxRows || []) if (t.escrow_paid_by_lender) out.add(t.property);
  for (const l of loans || []) if (taxesEscrowed({ taxRecord: null, loans: [l] })) out.add(l.property);
  return out;
}
