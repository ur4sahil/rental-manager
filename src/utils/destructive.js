// Destructive actions that only the management tier (admin, pm, manager)
// may carry out, and the request path for everyone else.
//
// The database enforces the tier (trg_mgmt_gate on UPDATE, the
// *_management_delete policies on DELETE, _assert_management_or_approved in
// the RPCs). Other staff file a property_change_requests row; a manager
// approves it from the Properties page, where approveRequest runs the SAME
// helper the direct button runs, so the two paths cannot drift.
import { supabase } from "../supabase";
import { emailFilterValue } from "./helpers";
import { logAudit } from "./audit";
import { deactivateTenantRecurring } from "./accounting";

// One label per request type, used by the approval queue and the badges.
export const REQUEST_LABELS = {
  add: "New Property",
  edit: "Edit Property",
  delete: "Delete Property",
  delete_tenant: "Archive Tenant",
  terminate_lease: "Terminate Lease",
  archive_owner: "Archive Owner",
  delete_autopay: "Delete Autopay",
  disable_autopay: "Pause Autopay",
  move_out: "Move-Out",
};

// File a request for a manager to approve. Routes to the requester's
// manager_email when one is assigned (null = any admin reviews). The partial
// unique indexes make a second identical pending request impossible; that
// surfaces here as `duplicate` so the caller can say so instead of erroring.
export async function fileApprovalRequest({ companyId, requestType, targetId = null, tenantId = null, propertyId = null, address = "", tenant = "", notes = "", userEmail }) {
  const { data: { user } } = await supabase.auth.getUser();
  const email = (userEmail || user?.email || "").toLowerCase();
  const { data: me } = await supabase.from("app_users")
    .select("manager_email").eq("company_id", companyId)
    .ilike("email", emailFilterValue(email)).maybeSingle();
  const { error } = await supabase.from("property_change_requests").insert([{
    company_id: companyId, request_type: requestType,
    target_id: targetId == null ? null : String(targetId),
    tenant_id: tenantId, property_id: propertyId,
    address, tenant, notes, requested_by: email,
    approver_email: me?.manager_email || null,
  }]);
  if (error && error.code === "23505") return { ok: false, duplicate: true };
  if (error) return { ok: false, error };
  return { ok: true };
}

// Is there an approved, not-yet-used request of this type for this target,
// filed by the current user? The RPCs consume it when the action runs.
export async function hasApprovedRequest({ companyId, requestType, targetId, userEmail }) {
  const { data: { user } } = await supabase.auth.getUser();
  const email = (userEmail || user?.email || "").toLowerCase();
  const { data } = await supabase.from("property_change_requests").select("id")
    .eq("company_id", companyId).eq("request_type", requestType).eq("target_id", String(targetId))
    .eq("status", "approved").is("executed_at", null)
    .ilike("requested_by", emailFilterValue(email)).limit(1);
  return !!(data && data.length);
}

// Terminate a lease and everything that hangs off it. Returns { ok, step }
// where `step` names the write that failed.
export async function terminateLeaseCascade({ companyId, lease, userProfile, userRole }) {
  const { error: termErr } = await supabase.from("leases").update({ status: "terminated" }).eq("company_id", companyId).eq("id", lease.id);
  if (termErr) return { ok: false, step: "terminating lease", error: termErr };
  if (lease.tenant_id) {
    const { error: e1 } = await supabase.from("tenants").update({ lease_status: "past" }).eq("company_id", companyId).eq("id", lease.tenant_id);
    if (e1) return { ok: false, step: "updating tenants", error: e1 };
    // Stop the rent schedule, or it bills the departed tenant every month.
    const recStop = await deactivateTenantRecurring(companyId, lease.tenant_id);
    // The Stripe charger reads `enabled`, not `active`. Scoped by tenant_id.
    const { error: e2 } = await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant_id", lease.tenant_id);
    if (e2) return { ok: false, step: "updating autopay_schedules", error: e2 };
    // lease_end is a DATE: clear with null, never "".
    const { error: e3 } = await supabase.from("properties").update({ status: "vacant", tenant: "", lease_end: null }).eq("company_id", companyId).eq("address", lease.property);
    if (e3) return { ok: false, step: "updating properties", error: e3 };
    if (!recStop.ok) return { ok: true, warning: "Lease terminated, but the recurring rent entry could not be stopped — please deactivate it in Accounting." };
  } else {
    // No tenant_id on this (legacy) lease: autopay can only be found by name,
    // so scope by name AND property to spare a same-name tenant elsewhere.
    const { error: e4 } = await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant", lease.tenant_name).eq("property", lease.property);
    if (e4) return { ok: false, step: "updating autopay_schedules", error: e4 };
  }
  logAudit("update", "leases", "Terminated lease: " + lease.tenant_name, lease.id, userProfile?.email, userRole, companyId);
  return { ok: true };
}

export async function archiveOwnerRow({ companyId, owner, userProfile, userRole }) {
  const { error } = await supabase.from("owners").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", owner.id).eq("company_id", companyId);
  if (error) return { ok: false, error };
  logAudit("delete", "owners", "Archived owner: " + owner.name, owner.id, userProfile?.email, userRole, companyId);
  return { ok: true };
}

export async function archiveAutopay({ companyId, id, tenant, userProfile, userRole }) {
  const { error } = await supabase.from("autopay_schedules").update({ archived_at: new Date().toISOString(), archived_by: userProfile?.email }).eq("id", id).eq("company_id", companyId);
  if (error) return { ok: false, error };
  logAudit("delete", "autopay", `Autopay archived: ${tenant}`, id, userProfile?.email, userRole, companyId);
  return { ok: true };
}

export async function setAutopayEnabled({ companyId, id, tenant, enabled, userProfile, userRole }) {
  const { error } = await supabase.from("autopay_schedules").update({ enabled }).eq("company_id", companyId).eq("id", id);
  if (error) return { ok: false, error };
  logAudit("update", "autopay", `Autopay ${enabled ? "enabled" : "disabled"}: ${tenant}`, id, userProfile?.email, userRole, companyId);
  return { ok: true };
}
