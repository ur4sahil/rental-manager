import { supabase } from "../supabase";
import { safeNum, formatLocalDate, shortId, pgrestQuote } from "./helpers";
import { pmError } from "./errors";
import { logAudit } from "./audit";
import {
  autoPostJournalEntry, resolveAccountId, getOrCreateTenantAR, getPropertyClassId,
} from "./accounting";

// Archiving a tenant, in ONE place.
//
// This procedure used to live inside Tenants.js's deleteTenant, reachable
// only by an admin clicking delete on the Tenants page. A non-admin clicking
// the same button files a property_change_request instead, for an admin to
// approve -- and the approval handler in Properties.js had no branch for it.
// `delete_tenant` appeared exactly once in the whole repository: at the
// insert. Nothing read it. So a staff request was filed, approved, and
// audit-logged as approved while the tenant stayed exactly where it was.
//
// The bug was not that the approval branch was missing. It was that the work
// lived in a component, where the only way to reuse it was to write it again
// -- and a second implementation of "archive a tenant" would have drifted
// from this one immediately. Everything below is load-bearing and was learned
// the hard way: the multi-unit slot handling (blanket-clearing every tenant
// slot once wiped siblings A, C, D and E when B was archived), the
// tenant_id-scoped lease termination (an .or() on name OR property once
// terminated every active lease at a multi-unit address), and the write-off's
// per-tenant AR sub-account (crediting the bare 1100 parent left the debt
// showing on the tenant's ledger after the books had written it off).
//
// So there is one copy, both paths call it, and neither can drift.
//
// The caller owns the guards and confirmations -- balance checks, unreturned
// deposits, "are you sure" -- because those differ by who is asking. The
// caller also owns its own UI refresh. This owns the data.
export async function archiveTenant({
  companyId, tenantId, name, archivedBy, userRole, onToast,
}) {
  if (!companyId || !tenantId) {
    return { ok: false, error: new Error("archiveTenant needs a company and a tenant id") };
  }
  const toast = typeof onToast === "function" ? onToast : () => {};
  // Get tenant's property before archiving for cascade updates
  const { data: tenantDetail } = await supabase.from("tenants").select("property, balance").eq("id", tenantId).eq("company_id", companyId).maybeSingle();
  const tenantProperty = tenantDetail?.property;
  // Soft-delete: archive instead of permanent deletion
  const { error: archiveErr } = await supabase.from("tenants").update({
  archived_at: new Date().toISOString(),
  archived_by: archivedBy,
  lease_status: "past"
  }).eq("id", tenantId).eq("company_id", companyId);
  if (archiveErr) { pmError("PM-3003", { raw: archiveErr, context: "archive tenant" }); return { ok: false, error: archiveErr }; }
  // Update property when tenant archived. At a multi-unit address we must
  // NOT blanket-clear every tenant slot — that used to wipe siblings A, C,
  // D, E when B was archived. Only mark the property vacant (and clear
  // lease/rent fields) when this was the sole remaining tenant. Otherwise
  // clear just the slot this tenant occupied.
  if (tenantProperty) {
  const { data: otherTenants } = await supabase.from("tenants").select("id").eq("company_id", companyId).eq("property", tenantProperty).neq("id", tenantId).is("archived_at", null);
  const hasOthers = (otherTenants || []).length > 0;
  if (!hasOthers) {
  const { error: propErr } = await supabase.from("properties").update({ status: "vacant", tenant: "", tenant_2: "", tenant_2_email: "", tenant_2_phone: "", tenant_3: "", tenant_3_email: "", tenant_3_phone: "", tenant_4: "", tenant_4_email: "", tenant_4_phone: "", tenant_5: "", tenant_5_email: "", tenant_5_phone: "", lease_end: null, lease_start: "", rent: null, security_deposit: null }).eq("company_id", companyId).eq("address", tenantProperty);
  if (propErr) pmError("PM-2002", { raw: propErr, context: "update property to vacant", silent: true });
  } else {
  // Find which slot this tenant occupies and clear only that one.
  const { data: propRow } = await supabase.from("properties").select("tenant, tenant_2, tenant_3, tenant_4, tenant_5").eq("company_id", companyId).eq("address", tenantProperty).maybeSingle();
  if (propRow) {
  const slotUpdate = {};
  if (propRow.tenant === name) slotUpdate.tenant = "";
  else if (propRow.tenant_2 === name) Object.assign(slotUpdate, { tenant_2: "", tenant_2_email: "", tenant_2_phone: "" });
  else if (propRow.tenant_3 === name) Object.assign(slotUpdate, { tenant_3: "", tenant_3_email: "", tenant_3_phone: "" });
  else if (propRow.tenant_4 === name) Object.assign(slotUpdate, { tenant_4: "", tenant_4_email: "", tenant_4_phone: "" });
  else if (propRow.tenant_5 === name) Object.assign(slotUpdate, { tenant_5: "", tenant_5_email: "", tenant_5_phone: "" });
  if (Object.keys(slotUpdate).length > 0) {
  const { error: propErr } = await supabase.from("properties").update(slotUpdate).eq("company_id", companyId).eq("address", tenantProperty);
  if (propErr) pmError("PM-2002", { raw: propErr, context: "clear tenant slot on archive", silent: true });
  }
  }
  }
  }
  // Terminate active leases for THIS tenant only. Scoping by tenant_id is
  // authoritative; fall back to (tenant_name AND property) when the lease
  // row predates tenant_id backfill. Previous .or() scoped by name OR
  // property, which terminated every other active lease at a multi-unit
  // address when one tenant was archived.
  let leaseTermQ = supabase.from("leases").update({ status: "terminated", archived_at: new Date().toISOString() }).eq("company_id", companyId).eq("status", "active");
  leaseTermQ = tenantId ? leaseTermQ.or(`tenant_id.eq.${tenantId},and(tenant_name.eq.${pgrestQuote(name)},property.eq.${pgrestQuote(tenantProperty || "")})`) : leaseTermQ.eq("tenant_name", name).eq("property", tenantProperty || "");
  const { error: leaseErr } = await leaseTermQ;
  if (leaseErr) pmError("PM-3004", { raw: leaseErr, context: "terminate leases on archive", silent: true });
  // Archive autopay schedules for this tenant
  await supabase.from("autopay_schedules").update({ enabled: false }).eq("company_id", companyId).eq("tenant", name).eq("property", tenantProperty);
  // NOTE: this block is currently UNREACHABLE. The guard at the top of
  // deleteTenant returns early whenever balance > 0 ("Cannot delete
  // tenant ... with an outstanding balance"), which is the same condition
  // this block requires. A negative balance fails the > 0 test and zero
  // has nothing to write off, so no value can reach here. Verified by
  // seeding a tenant at $250 and archiving: the guard fires, no journal
  // entry is written.
  //
  // Left in place, and corrected, so that if the guard is ever relaxed to
  // let an admin archive a debtor, the accounting beneath it is right:
  // the credit relieves the tenant's OWN AR sub-account and the manual
  // balance update is skipped when the DB trigger will recompute.
  // Removing the guard without this would post to the bare 1100 parent.
  const tenantBal = safeNum(tenantDetail?.balance);
  if (tenantBal > 0 && tenantId) {
  const classId = tenantProperty ? await getPropertyClassId(tenantProperty, companyId) : null;
  // Same rule as addLedgerEntry: the receivable leg has to relieve the
  // tenant's OWN AR sub-account (1100-NNN), not the bare 1100 parent.
  // ledger_entries only surfaces journal lines whose account carries a
  // tenant_id, so a write-off credited to the company-wide parent was real
  // in the GL but never appeared on that tenant's ledger — the ledger went
  // on showing a debt the books had already written off.
  const woArId = await getOrCreateTenantAR(companyId, name, tenantId) || await resolveAccountId("1100", companyId);
  let woArName = "Accounts Receivable", woArIsPerTenant = false;
  if (woArId) {
  const { data: woAcct } = await supabase.from("acct_accounts").select("name, tenant_id").eq("company_id", companyId).eq("id", woArId).maybeSingle();
  if (woAcct?.name) woArName = woAcct.name;
  woArIsPerTenant = !!woAcct?.tenant_id && String(woAcct.tenant_id) === String(tenantId);
  }
  if (!woArId) {
  // No receivable account resolvable at all. Post nothing rather than a
  // null account_id, and leave tenants.balance alone so the debt stays
  // visible. The tenant is already archived by this point, so the rest of
  // the cleanup below still has to run — don't bail out of the function.
  toast("Could not resolve the Accounts Receivable account — the outstanding balance for \"" + name + "\" was not written off.", "error");
  } else {
  const woffJeId = await autoPostJournalEntry({ companyId, date: formatLocalDate(new Date()), description: "AR write-off — tenant deleted — " + name, reference: "WOFF-" + shortId(), property: tenantProperty || "",
  lines: [
  { account_id: "5500", account_name: "Bad Debt Expense", debit: tenantBal, credit: 0, class_id: classId, memo: "Write-off at deletion — " + name },
  { account_id: woArId, account_name: woArName, debit: 0, credit: tenantBal, class_id: classId, memo: "AR write-off — " + name },
  ]
  });
  // Zero out tenant balance — but ONLY when the credit leg missed the
  // per-tenant sub-account. When it lands there, inserting the line fires
  // sync_tenant_balance_lines → recompute_tenant_balance(), which rebuilds
  // tenants.balance as SUM(debit)-SUM(credit) over that tenant's accounts
  // and has therefore ALREADY taken it to 0. Applying -tenantBal on top
  // would leave a phantom credit of the same size on an archived tenant.
  // This is the identical gate addLedgerEntry uses for its balanceUpdate.
  // Also gated on the JE actually posting: if it failed there is nothing
  // to offset, and zeroing anyway would hide a live receivable.
  if (woffJeId && !woArIsPerTenant) {
  const { error: _balErr } = await supabase.rpc("update_tenant_balance", { p_tenant_id: tenantId, p_amount_change: -tenantBal });
  if (_balErr) pmError("PM-6002", { raw: _balErr, context: "balance zero-out on archive", silent: true });
  }
  }
  }
  // Deactivate tenant AR sub-accounts
  await supabase.from("acct_accounts").update({ is_active: false }).eq("company_id", companyId).eq("tenant_id", tenantId);
  logAudit("delete", "tenants", `Deleted tenant: ${name} (property→vacant, lease terminated, autopay disabled)`, tenantId, archivedBy, userRole, companyId);
  return { ok: true, property: tenantProperty || null };
}
