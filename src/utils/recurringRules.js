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

// Should this month's rent be cut down to the days the lease covers?
//
// Only for a NEW tenancy. A lease that starts mid-month is prorated on the
// way in -- but a lease that starts mid-month can just as well be a RENEWAL
// for someone who already lives there, and the same date test then shaved
// their rent: a tenant billed $2,900 every month, whose renewal began on
// the 3rd, would have been charged 28/30 of it that month. "Already lives
// there" is read off the tenant's own ledger: if it carries a charge dated
// before this month, this is not their first month.
//
// Returns null (charge the full amount) or { amount, days, daysInMonth }.
export function leaseStartProration({ leaseStart, monthStr, amount, hasEarlierCharges }) {
  const start = String(leaseStart || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start.slice(0, 7) !== String(monthStr)) return null;
  if (hasEarlierCharges) return null;
  const [y, m] = String(monthStr).split("-").map(n => parseInt(n, 10));
  const daysInMonth = new Date(y, m, 0).getDate();
  const startDay = parseInt(start.slice(8, 10), 10) || 1;
  const days = Math.max(1, daysInMonth - startDay + 1);
  if (days >= daysInMonth) return null;
  return { amount: Math.round(num(amount) * days / daysInMonth * 100) / 100, days, daysInMonth };
}

// ── What needs a look on the Recurring rent page ───────────────────────
// Rent that silently is not being charged does not announce itself: the
// tenant simply has no entry that month. Three Sigma tenants went a month
// unbilled that way, a fourth was charged another tenant's rent, and a
// fifth had a schedule that would not start for two months. Each of those
// is a rule here, so the page can say so at the top instead of leaving it
// to be noticed on a ledger.
//
//   schedules   recurring_journal_entries rows (not archived)
//   tenants     tenant rows (id, name, property, rent, lease_status,
//               archived_at, lease_start, move_in)
//   chargedThisMonth  Set of tenant ids (as strings) whose ledger already
//               carries a rent charge dated in the current month
//   today       "YYYY-MM-DD"
//
// Returns [{ kind, tenantId, scheduleId, name, text }], worst first.
const ymOf = (d) => String(d || "").slice(0, 7);
const monthAfter = (ym) => {
  const [y, m] = String(ym).split("-").map(n => parseInt(n, 10));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (ym) => MONTH_NAMES[(parseInt(String(ym).slice(5, 7), 10) || 1) - 1];
const money = (n) => "$" + num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isActiveSchedule = (s) => !!s && s.status === "active" && !s.archived_at;

// The months an active schedule will pass over before its next posting:
// from the month after its last posting (or this month, if it has never
// posted) up to the month before `next_post_date`.
export function skippedMonths(schedule, today) {
  if (!isActiveSchedule(schedule) || !schedule.next_post_date) return [];
  const nextYm = ymOf(schedule.next_post_date);
  let ym = schedule.last_posted_date ? monthAfter(ymOf(schedule.last_posted_date)) : ymOf(today);
  if (ym < ymOf(today)) ym = ymOf(today);   // the past is not this check's business
  const out = [];
  while (ym < nextYm && out.length < 24) { out.push(ym); ym = monthAfter(ym); }
  return out;
}

export function recurringAttention({ schedules = [], tenants = [], chargedThisMonth = new Set(), today }) {
  const out = [];
  const thisYm = ymOf(today);
  const day = parseInt(String(today || "").slice(8, 10), 10) || 1;
  const byTenant = {};
  for (const s of schedules) {
    if (hasTenantId(s) && isActiveSchedule(s)) (byTenant[String(s.tenant_id)] = byTenant[String(s.tenant_id)] || []).push(s);
  }
  const tenantById = Object.fromEntries(tenants.map(t => [String(t.id), t]));
  const charged = (id) => chargedThisMonth.has(String(id));
  // Not living there yet: a lease that starts after this month owes nothing this month.
  const startsLater = (t) => { const s = String(t.lease_start || t.move_in || "").slice(0, 7); return !!s && s > thisYm; };

  for (const t of tenants) {
    if (!isTenantBillable(t)) continue;
    const mine = byTenant[String(t.id)] || [];
    if (mine.length === 0) {
      // A schedule that exists but is switched off is a different message
      // (and a different fix: resume it, do not make a second one).
      const off = schedules.find(s => hasTenantId(s) && String(s.tenant_id) === String(t.id) && !s.archived_at && s.status !== "active");
      if (off) {
        out.push({ kind: "paused", tenantId: t.id, scheduleId: off.id, name: t.name,
          text: `the rent schedule is paused, so nothing is charged` + (charged(t.id) || startsLater(t) ? "" : `; ${monthName(thisYm)} has not been charged`) });
        continue;
      }
      out.push({ kind: "not_billed", tenantId: t.id, scheduleId: null, name: t.name,
        text: `lives there${num(t.rent) > 0 ? ", rent on record " + money(t.rent) : ""}, no schedule` + (charged(t.id) || startsLater(t) ? "" : `; ${monthName(thisYm)} has not been charged`) });
      continue;
    }
    for (const s of mine) {
      if (num(t.rent) > 0 && Math.abs(num(s.amount) - num(t.rent)) > 0.005) {
        out.push({ kind: "amount_differs", tenantId: t.id, scheduleId: s.id, name: t.name, tenantRent: num(t.rent),
          text: `schedule charges ${money(s.amount)}, the tenant record says ${money(t.rent)}` });
      }
      // Months the schedule will pass over. This month only counts if the
      // ledger shows no rent for it (it may have been entered by hand) and
      // the tenant was already living there.
      const skipped = skippedMonths(s, today).filter(ym => ym !== thisYm || (!charged(t.id) && !startsLater(t)));
      if (skipped.length) {
        out.push({ kind: "skips_months", tenantId: t.id, scheduleId: s.id, name: t.name, months: skipped,
          text: `next posting is ${s.next_post_date}, so ${skipped.map(monthName).join(" and ")} ${skipped.length === 1 ? "is" : "are"} not charged` });
      }
    }
    // A schedule that exists but is not running.
    if (!charged(t.id) && !startsLater(t) && mine.every(s => skippedMonths(s, today).indexOf(thisYm) === -1)
        && mine.every(s => (parseInt(s.day_of_month, 10) || 1) <= day) && mine.every(s => ymOf(s.last_posted_date) < thisYm)) {
      out.push({ kind: "not_charged", tenantId: t.id, scheduleId: mine[0].id, name: t.name,
        text: `${monthName(thisYm)} rent has not posted yet. Press "Post what is due".` });
    }
  }
  for (const s of schedules) {
    if (!hasTenantId(s) || !isActiveSchedule(s)) continue;
    const t = tenantById[String(s.tenant_id)];
    if (!isTenantBillable(t)) {
      out.push({ kind: "will_not_post", tenantId: s.tenant_id, scheduleId: s.id, name: s.tenant_name || (t && t.name) || "Unknown tenant",
        text: !t ? "the tenant record no longer exists, so this never posts" : t.archived_at ? "the tenant is archived, so this never posts" : `the tenant is marked "${t.lease_status || "no status"}", so this never posts` });
    }
  }
  const rank = { not_billed: 0, paused: 1, amount_differs: 2, skips_months: 3, not_charged: 4, will_not_post: 5 };
  return out.sort((a, b) => (rank[a.kind] - rank[b.kind]) || String(a.name).localeCompare(String(b.name)));
}

export const ATTENTION_LABEL = {
  not_billed: "Not being billed",
  paused: "Paused",
  amount_differs: "Amount looks wrong",
  skips_months: "Months will be skipped",
  not_charged: "Not charged yet",
  will_not_post: "Will never post",
};
