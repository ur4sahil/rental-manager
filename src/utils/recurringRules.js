// Recurring rent: who may be billed, and where. PURE -- no imports, no I/O --
// so tests can load this file in plain node and hold the rules directly.
// autoPostRecurringEntries (accounting.js) is the only caller that posts.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Lease statuses of a tenant who still lives there and still owes rent.
// 'notice' is a tenant who has given notice but not yet left.
export const BILLABLE_LEASE_STATUSES = ["active", "notice"];

// May this tenant row be billed rent? Archived rows, rows with any other
// lease status, and a missing row (the tenant was deleted) may not.
export function isTenantBillable(tenant) {
  if (!tenant) return false;
  if (tenant.archived_at) return false;
  return BILLABLE_LEASE_STATUSES.includes(String(tenant.lease_status || "").trim().toLowerCase());
}

export const hasTenantId = (entry) => !!entry && entry.tenant_id !== null && entry.tenant_id !== undefined && entry.tenant_id !== "";

// Why a schedule must post nothing this run, or null to proceed. Schedules
// without a tenant_id (mortgage, HOA, any non-rent recurring) are never
// gated on a tenant.
export function recurringTenantSkipReason(entry, tenant) {
  if (!hasTenantId(entry)) return null;
  if (!tenant) return "tenant-missing";
  if (tenant.archived_at) return "tenant-archived";
  if (!isTenantBillable(tenant)) return "tenant-not-active";
  return null;
}

// From the tenant's AR accounts (acct_accounts rows with tenant_id), pick
// the one rent should debit. Only accounts whose tenant_id IS this tenant
// qualify. Preference: the schedule's stored account when it is this
// tenant's and active; else the tenant's active account with the lowest
// code; else (nothing active) the stored one if it is the tenant's; else
// the lowest code. Returns null when the tenant has no account at all.
export function pickTenantArAccount(accounts, tenantId, storedDebitId) {
  if (tenantId === null || tenantId === undefined || tenantId === "") return null;
  const mine = (accounts || []).filter(a => a && a.id && a.tenant_id !== null && a.tenant_id !== undefined
    && String(a.tenant_id) === String(tenantId));
  if (mine.length === 0) return null;
  const byCode = (a, b) => String(a.code || "").localeCompare(String(b.code || "")) || String(a.id).localeCompare(String(b.id));
  const stored = storedDebitId ? mine.find(a => a.id === storedDebitId) : null;
  if (stored && stored.is_active !== false) return stored;
  const active = mine.filter(a => a.is_active !== false).sort(byCode);
  if (active.length > 0) return active[0];
  if (stored) return stored;
  return [...mine].sort(byCode)[0];
}

// First and last day ("YYYY-MM-DD") of a "YYYY-MM" month.
export function monthBounds(monthStr) {
  const [y, m] = String(monthStr).split("-").map(n => parseInt(n, 10));
  const last = new Date(y, m, 0).getDate();
  return { start: monthStr + "-01", end: monthStr + "-" + String(last).padStart(2, "0") };
}

// Has some OTHER recurring entry already billed this AR account in this
// month? `lines` are journal lines on the account with their entry embedded
// (acct_journal_entries: { reference, date, status }). Voided entries,
// non-RECUR references and zero debits do not count.
export function arAlreadyBilledInMonth(lines, arAccountId, monthStr) {
  if (!arAccountId) return false;
  const { start, end } = monthBounds(monthStr);
  return (lines || []).some(l => {
    const je = l && (Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries);
    if (!je) return false;
    if (l.account_id && l.account_id !== arAccountId) return false;
    if (!(num(l.debit) > 0)) return false;
    if (String(je.status || "") === "voided") return false;
    if (!String(je.reference || "").startsWith("RECUR-")) return false;
    const d = String(je.date || "").slice(0, 10);
    return d >= start && d <= end;
  });
}
