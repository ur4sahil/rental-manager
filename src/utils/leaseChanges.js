// Renewals, rent changes and addenda: reading and writing lease_changes.
// The rules are in leaseChangeRules.js (pure); the database applies a change
// on its day (_apply_lease_change, migration 20261003040000).
import { supabase } from "../supabase";
import { pmError } from "./errors";
import { voidEnvelope } from "./docService";
import { changeFromFields } from "./leaseChangeRules";

const OPEN = ["awaiting_signature", "scheduled"];

/** Changes for a tenant or a lease, newest first. */
export async function loadLeaseChanges(companyId, { tenantId = null, leaseId = null, openOnly = false } = {}) {
  let q = supabase.from("lease_changes").select("*").eq("company_id", companyId).order("created_at", { ascending: false }).limit(100);
  if (leaseId) q = q.eq("lease_id", leaseId);
  else if (tenantId != null) q = q.eq("tenant_id", Number(tenantId));
  if (openOnly) q = q.in("status", OPEN);
  const { data, error } = await q;
  if (error) { pmError("PM-3004", { raw: error, context: "load lease changes", silent: true }); return { ok: false, error: error.message, changes: [] }; }
  return { ok: true, changes: data || [] };
}

/** Is a renewal or rent change already in flight for this lease? (The database allows one of each.) */
export async function openChangeOfKind(companyId, leaseId, kind) {
  const { data, error } = await supabase.from("lease_changes").select("id, kind, status, effective_date, payload, doc_id")
    .eq("company_id", companyId).eq("lease_id", leaseId).eq("kind", kind).in("status", OPEN).limit(1);
  if (error) return { error: error.message };
  return { change: (data || [])[0] || null };
}

/**
 * Record a change. `status` is "awaiting_signature" when a document has gone
 * out to be signed, "scheduled" when it is already agreed (a notice issued,
 * or a renewal signed on paper).
 */
export async function createLeaseChange({ companyId, leaseId, tenantId, kind, effectiveDate, payload = {}, status, docId = null, noticeDate = null, note = null, userEmail = "" }) {
  const row = {
    company_id: companyId, lease_id: leaseId, tenant_id: tenantId != null ? Number(tenantId) : null, kind,
    effective_date: effectiveDate, payload, status, doc_id: docId, notice_date: noticeDate, note, created_by: userEmail || "",
  };
  const { data, error } = await supabase.from("lease_changes").insert([row]).select("*").maybeSingle();
  if (error || !data) {
    const dup = error?.code === "23505" || /idx_lease_changes_one_open|duplicate/i.test(error?.message || "");
    if (!dup) pmError("PM-3004", { raw: error, context: "create lease change", silent: true });
    return { ok: false, duplicate: dup, error: dup ? "There is already one waiting to take effect for this lease. Cancel it first." : (error?.message || "The change could not be saved.") };
  }
  return { ok: true, change: data };
}

/** What a finished document says the change is (see changeFromFields), ready to store. */
export function changeRowFromDocument(change, fieldValues) {
  return changeFromFields(change, fieldValues);
}

/**
 * Withdraw a change that has not taken effect. If its document is still out
 * for signature the request is cancelled first -- that cancels the change
 * through the database trigger, so the two can never disagree.
 */
export async function cancelLeaseChange(companyId, change, { userEmail = "", reason = "Cancelled by staff", doc = null } = {}) {
  if (!OPEN.includes(change.status)) return { ok: false, error: "This has already " + (change.status === "applied" ? "taken effect." : "been cancelled.") };
  if (change.doc_id && (doc ? doc.envelope_status === "out_for_signature" : change.status === "awaiting_signature")) {
    const v = await voidEnvelope(companyId, change.doc_id, reason);
    if (!v.ok) return { ok: false, error: "The signature request could not be cancelled: " + v.error };
  }
  const { error } = await supabase.from("lease_changes")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: userEmail || "", cancel_reason: reason, updated_at: new Date().toISOString() })
    .eq("company_id", companyId).eq("id", change.id).in("status", OPEN);
  if (error) { pmError("PM-3004", { raw: error, context: "cancel lease change", silent: true }); return { ok: false, error: error.message }; }
  return { ok: true };
}

/**
 * Apply everything whose day has come. Run when staff open a company, BEFORE
 * the month's rent is posted, so a change dated the 1st bills at its amount.
 * @returns {Promise<{ ok: boolean, applied: number, results: Array }>}
 */
export async function applyDueLeaseChanges(companyId) {
  const { data, error } = await supabase.rpc("apply_due_lease_changes", { p_company_id: companyId });
  if (error) { pmError("PM-3004", { raw: error, context: "apply due lease changes", silent: true }); return { ok: false, applied: 0, results: [] }; }
  const results = data?.results || [];
  return { ok: true, applied: results.filter(r => r.applied).length, results };
}
