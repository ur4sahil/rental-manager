// What the "Needs attention" list shows and where each line takes you.
//
// WHAT needs attention is decided in one place, the database function
// lease_clock_items (migration 20261003070000), which the daily email job
// reads too. This file is only presentation: the label, the order, and the
// screen that deals with each kind. Pure: no database, no React.

export const CLOCK_KINDS = {
  renewal_due: { label: "Lease ending", icon: "event" },
  unsigned_doc: { label: "Not signed yet", icon: "draw" },
  prospect_not_converted: { label: "Prospect", icon: "person_search" },
  deposit_statement_due: { label: "Deposit statement", icon: "account_balance_wallet" },
  move_out_due: { label: "Move-out", icon: "logout" },
  lease_change_failed: { label: "Lease change", icon: "error_outline" },
  late_notice_due: { label: "Late rent", icon: "schedule" },
  ftpr_deadline: { label: "Failure to pay rent", icon: "gavel" },
};

const SEVERITY_ORDER = { overdue: 0, high: 1, normal: 2 };
export const SEVERITY_LABEL = { overdue: "Overdue", high: "Soon", normal: "Coming up" };

const tenantPage = (item, panel = "detail") => ({ page: "tenants", action: { openTenantId: item.tenant_id, panel } });
const BACK = { page: "dashboard" };

/**
 * The button on a line: { label, page, action } for setPage(page, action),
 * or null when there is nowhere better than the dashboard itself.
 */
export function clockAction(item) {
  if (!item) return null;
  const hasTenant = item.tenant_id !== null && item.tenant_id !== undefined && item.tenant_id !== "";
  switch (item.kind) {
    case "renewal_due":
      return hasTenant ? { label: "Open tenant", ...tenantPage(item) } : { label: "Open leases", page: "leases", action: null };
    case "unsigned_doc":
      if (item.prospect_id) return { label: "Open prospect", page: "prospects", action: { openProspectId: item.prospect_id } };
      if (hasTenant) return { label: "Open tenant", ...tenantPage(item) };
      return { label: "Open documents", page: "doc_builder", action: null };
    case "prospect_not_converted":
      return item.prospect_id ? { label: "Open prospect", page: "prospects", action: { openProspectId: item.prospect_id } } : { label: "Open prospects", page: "prospects", action: null };
    case "deposit_statement_due":
      return hasTenant
        ? { label: "Write the statement", page: "doc_builder", action: { templateKey: "deposit_disposition", tenantId: Number(item.tenant_id), leaseId: item.lease_id || null, returnTo: BACK } }
        : null;
    case "move_out_due":
      return hasTenant ? { label: "Run the move-out", page: "moveout", action: { tenantId: item.tenant_id } } : null;
    case "lease_change_failed":
      return hasTenant ? { label: "Open tenant", ...tenantPage(item) } : { label: "Open leases", page: "leases", action: null };
    case "late_notice_due":
      return hasTenant
        ? { label: "Write the notice", page: "doc_builder", action: { templateKey: "late_fee_notice", tenantId: Number(item.tenant_id), returnTo: BACK } }
        : null;
    case "ftpr_deadline": {
      // The key is "ftpr_deadline:<case id>".
      const caseId = String(item.item_key || "").split(":")[1] || "";
      return caseId ? { label: "Open the case", page: "evictions", action: { openCaseId: caseId } } : { label: "Open cases", page: "evictions", action: null };
    }
    default:
      return null;
  }
}

/** Counts by urgency, for the card's heading. */
export function clockCounts(items) {
  const c = { overdue: 0, high: 0, normal: 0, total: 0 };
  for (const i of items || []) {
    if (!i) continue;
    c.total++;
    if (i.severity === "overdue") c.overdue++; else if (i.severity === "high") c.high++; else c.normal++;
  }
  return c;
}

/** "2 overdue, 3 soon, 1 coming up" -- only the parts that are not zero. */
export function clockSummary(items) {
  const c = clockCounts(items);
  const parts = [];
  if (c.overdue) parts.push(c.overdue + " overdue");
  if (c.high) parts.push(c.high + " soon");
  if (c.normal) parts.push(c.normal + " coming up");
  return parts.join(", ");
}

/** Most urgent first; within a level, the earliest date, undated last. Stable. */
export function sortClockItems(items) {
  return (items || []).filter(Boolean).map((item, at) => ({ item, at })).sort((a, b) => {
    const s = (SEVERITY_ORDER[a.item.severity] ?? 3) - (SEVERITY_ORDER[b.item.severity] ?? 3);
    if (s) return s;
    const da = a.item.due_date || "9999-12-31", db = b.item.due_date || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return a.at - b.at;
  }).map(x => x.item);
}

/**
 * The lines to draw: everything when expanded, otherwise the first `limit`
 * of the chosen kind ("all" = every kind). Returns { shown, hidden }.
 */
export function clockPage(items, { kind = "all", expanded = false, limit = 6 } = {}) {
  const pool = sortClockItems(items).filter(i => kind === "all" || i.kind === kind);
  const shown = expanded ? pool : pool.slice(0, Math.max(0, limit));
  return { shown, hidden: pool.length - shown.length, total: pool.length };
}

/** The kinds present, most lines first, for the filter chips. */
export function clockKindsPresent(items) {
  const n = {};
  for (const i of items || []) if (i && i.kind) n[i.kind] = (n[i.kind] || 0) + 1;
  return Object.keys(n).map(kind => ({ kind, count: n[kind], label: (CLOCK_KINDS[kind] || {}).label || "Other" }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
