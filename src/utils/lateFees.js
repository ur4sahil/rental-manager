// Late fees: the one posting routine behind the Late Fees page and the tenant
// "Late Fee" button. The nightly job (batch_post_late_fees, SQL) follows the
// same rules -- see lateFeeRules.js for the rule and its SQL twin.
//
// Every fee:
//   * is refused if the tenant already has one this month (any path, any
//     reference, or a hand-entered DR tenant AR / CR late-fee income entry);
//   * carries reference LATEFEE-<tenant_id>-YYYYMM, so the unique reference
//     index is the last word if two paths race;
//   * debits the tenant's OWN AR account, never the shared 1100. The
//     sync_tenant_balance_lines trigger then recomputes tenants.balance from
//     the GL, so no balanceUpdate is ever passed -- that would count it twice.
import { supabase } from "../supabase";
import { atomicPostJEAndLedger, getOrCreateTenantAR, resolveAccountId } from "./accounting";
import { lateFeeMonth, lateFeeReference, lateFeeAlreadyPostedWith, LATE_FEE_INCOME_CODE, LATE_FEE_INCOME_NAME } from "./lateFeeRules";

export { lateFeeMonth, lateFeeReference };

// { already, error }. Fails closed -- see lateFeeRules.js.
export function lateFeeAlreadyPosted(companyId, tenantId, month) {
  return lateFeeAlreadyPostedWith(supabase, companyId, tenantId, month);
}

// The tenant's own AR account. getOrCreateTenantAR falls back to the shared
// 1100 parent when it cannot find or create one; that is not the tenant's
// account, so it is refused here (null) rather than posted to.
export async function resolveTenantLateFeeAR(companyId, tenant) {
  if (!companyId || !tenant?.id) return null;
  const id = await getOrCreateTenantAR(companyId, tenant.name, tenant.id);
  if (!id) return null;
  const { data, error } = await supabase.from("acct_accounts").select("id, name, tenant_id")
    .eq("company_id", companyId).eq("id", id).maybeSingle();
  if (error || !data || data.tenant_id === null || data.tenant_id === undefined) return null;
  if (String(data.tenant_id) !== String(tenant.id)) return null;
  return data;
}

// Plain-words reason for a postTenantLateFee result that did not post.
export function lateFeeFailureReason(res) {
  switch (res?.status) {
    case "duplicate": return "a late fee is already on the books for this month";
    case "no-ar": return "this tenant's receivable account could not be found or created";
    case "no-income": return "the Late Fee Income account (4010) could not be found";
    case "no-tenant": return "no tenant record to charge";
    case "check-failed": return "the check for an existing late fee failed" + (res.error ? " (" + res.error + ")" : "");
    default: return res?.error || "the journal entry failed";
  }
}

// Post one late fee. Returns { status, jeId?, reference?, error? } where
// status is "posted", "duplicate", "check-failed", "no-tenant", "no-ar",
// "no-income" or "error". Callers own the messaging.
export async function postTenantLateFee({ companyId, tenant, amount, date, classId = null, description, arMemo, incomeMemo, ledgerDescription }) {
  if (!tenant?.id) return { status: "no-tenant" };
  const month = lateFeeMonth(date);
  const reference = lateFeeReference(tenant.id, month);
  if (!reference) return { status: "no-tenant" };

  const dup = await lateFeeAlreadyPosted(companyId, tenant.id, month);
  if (dup.error) return { status: "check-failed", error: dup.error };
  if (dup.already) return { status: "duplicate", reference };

  const ar = await resolveTenantLateFeeAR(companyId, tenant);
  if (!ar) return { status: "no-ar" };
  const incomeId = await resolveAccountId(LATE_FEE_INCOME_CODE, companyId);
  if (!incomeId) return { status: "no-income" };

  const result = await atomicPostJEAndLedger({ companyId,
    date,
    description,
    reference,
    property: tenant.property,
    lines: [
      { account_id: ar.id, account_name: ar.name || "Accounts Receivable", debit: amount, credit: 0, class_id: classId, memo: arMemo || "Late fee: " + tenant.name },
      { account_id: incomeId, account_name: LATE_FEE_INCOME_NAME, debit: 0, credit: amount, class_id: classId, memo: incomeMemo || "" },
    ],
    ledgerEntry: { tenant: tenant.name, tenant_id: tenant.id, property: tenant.property, date, description: ledgerDescription || description, amount, type: "late_fee", balance: 0 },
    // No balanceUpdate: the AR leg is the tenant's own account, so the
    // balance-sync trigger recomputes tenants.balance from the GL.
    balanceUpdate: null,
  });
  if (!result.jeId) return { status: "error", error: result.error || "journal entry failed" };
  return { status: "posted", jeId: result.jeId, reference };
}
