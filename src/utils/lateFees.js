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

// Pick the tenant's own AR account from the Asset accounts linked to them
// (acct_accounts.tenant_id = tenant), the way the nightly job does
// (_late_fee_tenant_ar step 1): active before inactive, then lowest code,
// then id. `rows` must already be in (code NULLS LAST, id) order.
export function pickLinkedTenantAR(rows, tenantId) {
  const mine = (rows || []).filter(a => a && a.tenant_id !== null && a.tenant_id !== undefined
    && String(a.tenant_id) === String(tenantId) && (a.type === undefined || a.type === "Asset"));
  const active = mine.filter(a => a.is_active !== false);
  return active[0] || mine[0] || null;
}

// The tenant's own AR account, or null.
//   1. An Asset account already linked to this tenant -- read directly, the
//      same choice the nightly job makes, so a tenant with two linked
//      accounts (an old inactive one and the current one) or a returning
//      tenant is charged on the same account by every path.
//   2. Otherwise getOrCreateTenantAR (adopts a legacy 'AR - <name>' account
//      or creates 1100-NNN).
// Whatever comes back must be linked to THIS tenant. getOrCreateTenantAR can
// return the shared 1100 parent (no tenant_id) or an account linked to a
// different tenant; both are refused (null) rather than posted to.
// { lookupOnly: true } skips step 2 (never creates anything).
export async function resolveTenantLateFeeAR(companyId, tenant, { lookupOnly = false } = {}) {
  if (!companyId || !tenant?.id) return null;
  const { data: linked, error: linkErr } = await supabase.from("acct_accounts")
    .select("id, name, tenant_id, is_active, code, type")
    .eq("company_id", companyId).eq("tenant_id", tenant.id).eq("type", "Asset")
    .order("code", { ascending: true, nullsFirst: false }).order("id", { ascending: true }).limit(20);
  if (!linkErr) {
    const own = pickLinkedTenantAR(linked, tenant.id);
    if (own) return own;
  }
  if (lookupOnly) return null;
  const id = await getOrCreateTenantAR(companyId, tenant.name, tenant.id);
  if (!id) return null;
  const { data, error } = await supabase.from("acct_accounts").select("id, name, tenant_id, is_active, code, type")
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

  // Lost a race? Two clicks, two tabs, or the button and the Late Fees page
  // at once all pass the check above together; the loser then fails later
  // -- creating the AR account (the other writer just made it) or on the
  // unique reference index. If the fee is on the books by then, that is
  // "already charged this month", not a receivable or journal failure.
  const settledByRace = async () => {
    const again = await lateFeeAlreadyPosted(companyId, tenant.id, month);
    return !again.error && again.already;
  };

  // Account creation is where concurrent first-ever fees collide (both pick
  // the same next 1100-NNN code), so a miss is looked up again a few times,
  // a little apart, re-checking for the winner's fee each time. The first
  // two retries only LOOK for the account the winner created; only the last
  // may try to create one again (the collision may have been with another
  // tenant's new account, so nobody won), so retries add at most one more
  // creation attempt -- the same as the user clicking again.
  let ar = await resolveTenantLateFeeAR(companyId, tenant);
  for (let attempt = 1; !ar && attempt <= 3; attempt++) {
    if (await settledByRace()) return { status: "duplicate", reference };
    await new Promise(r => setTimeout(r, 250 * attempt));
    ar = await resolveTenantLateFeeAR(companyId, tenant, { lookupOnly: attempt < 3 });
  }
  if (!ar) {
    if (await settledByRace()) return { status: "duplicate", reference };
    return { status: "no-ar" };
  }
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
  if (!result.jeId) {
    if (await settledByRace()) return { status: "duplicate", reference };
    return { status: "error", error: result.error || "journal entry failed" };
  }
  return { status: "posted", jeId: result.jeId, reference };
}
