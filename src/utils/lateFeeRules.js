// Late fees: the reference and the one-per-month duplicate rule. No imports,
// and the only I/O goes through a client passed in (lateFeeAlreadyPostedWith),
// so tests load this file in plain node.
//
// Three paths charge late fees: the Late Fees page, the tenant "Late Fee"
// button (both via postTenantLateFee in lateFees.js) and the nightly
// batch_post_late_fees SQL job. They must agree on what "this tenant already
// has a late fee this month" means, or running two of them charges twice.
// The SQL twin of lateFeeAlreadyPostedInMonth is public.late_fee_already_posted
// (supabase/migrations/20260928050000_late_fees_one_rule_tenant_ar.sql).
// Change one, change the other.

export const LATE_FEE_INCOME_CODE = "4010";
export const LATE_FEE_INCOME_NAME = "Late Fee Income";

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const hasId = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const MONTH_RE = /^(\d{4})-(\d{2})$/;

// "YYYY-MM" for a Date (local calendar) or a "YYYY-MM-DD..." string.
export function lateFeeMonth(date) {
  if (typeof date === "string") {
    const m = /^(\d{4})-(\d{2})/.exec(date);
    return m ? m[1] + "-" + m[2] : null;
  }
  if (date instanceof Date && !isNaN(date)) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }
  return null;
}

// The one reference every path writes: LATEFEE-<tenant_id>-YYYYMM.
// null without a tenant id -- "LATEFEE-undefined-..." would be a single
// string the unique index then allows once per company per month.
export function lateFeeReference(tenantId, month) {
  if (!hasId(tenantId) || !MONTH_RE.test(String(month || ""))) return null;
  return "LATEFEE-" + String(tenantId).trim() + "-" + String(month).replace("-", "");
}

// Every reference that means "late fee for this tenant, this month":
// the canonical one, the nightly job's old hyphenated form and the Late
// Fees page's old LATE- form.
export function lateFeeReferences(tenantId, month) {
  const canonical = lateFeeReference(tenantId, month);
  if (!canonical) return [];
  const tid = String(tenantId).trim();
  return [canonical, "LATEFEE-" + tid + "-" + month, "LATE-" + tid + "-" + String(month).replace("-", "")];
}

// First and last day ("YYYY-MM-DD") of a "YYYY-MM" month.
export function lateFeeMonthBounds(month) {
  const m = MONTH_RE.exec(String(month || ""));
  if (!m) return null;
  const last = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { start: month + "-01", end: month + "-" + String(last).padStart(2, "0") };
}

// Is this account the company's late-fee income account? Same test as SQL:
// code 4010 or name "Late Fee Income".
export function isLateFeeIncomeAccount(acct) {
  return !!acct && (String(acct.code || "") === LATE_FEE_INCOME_CODE || String(acct.name || "") === LATE_FEE_INCOME_NAME);
}

// THE RULE. A tenant already has a late fee for `month` if ANY non-voided
// journal entry dated in that month either
//   (a) carries one of lateFeeReferences(tenantId, month), or
//   (b) debits one of the tenant's own AR accounts (tenantArIds) and credits
//       a late-fee income account (incomeIds) -- a hand-entered late fee,
//       which has no reference.
// entries: [{ reference, date, status, lines: [{ account_id, debit, credit }] }]
export function lateFeeAlreadyPostedInMonth({ tenantId, month, entries, tenantArIds, incomeIds }) {
  const bounds = lateFeeMonthBounds(month);
  const refs = lateFeeReferences(tenantId, month);
  if (!bounds || refs.length === 0) return false;
  const ar = new Set((tenantArIds || []).filter(hasId).map(String));
  const inc = new Set((incomeIds || []).filter(hasId).map(String));
  return (entries || []).some(e => {
    if (!e) return false;
    if (String(e.status || "") === "voided") return false;
    const d = String(e.date || "").slice(0, 10);
    if (!(d >= bounds.start && d <= bounds.end)) return false;
    if (refs.includes(String(e.reference || ""))) return true;
    const lines = e.lines || [];
    const debitsAr = lines.some(l => l && ar.has(String(l.account_id)) && num(l.debit) > 0);
    const creditsIncome = lines.some(l => l && inc.has(String(l.account_id)) && num(l.credit) > 0);
    return debitsAr && creditsIncome;
  });
}

// ─── Gathering: run the rule against the database ───────────────────────
// Takes the Supabase client as an argument so this file keeps no imports and
// the test suite can run this exact code against the TEST project. The app
// calls it through lateFeeAlreadyPosted in lateFees.js.
//
// Fails CLOSED: any lookup error reports { already: true, error } so a
// network blip cannot let a second fee through.

const LINE_CAP = 1000;  // PostgREST's page size; a full page fails closed

export async function lateFeeAlreadyPostedWith(client, companyId, tenantId, month) {
  try {
    const bounds = lateFeeMonthBounds(month);
    const refs = lateFeeReferences(tenantId, month);
    if (!client || !companyId || !bounds || refs.length === 0) return { already: true, error: "missing company, tenant or month" };

    const [byRef, arAccts, incAccts] = await Promise.all([
      // (a) any of the three late-fee references, dated in the month
      client.from("acct_journal_entries").select("id, reference, date, status")
        .eq("company_id", companyId).in("reference", refs)
        .gte("date", bounds.start).lte("date", bounds.end).limit(20),
      // the tenant's own AR account(s)
      client.from("acct_accounts").select("id")
        .eq("company_id", companyId).eq("tenant_id", tenantId),
      // the company's late-fee income account(s)
      client.from("acct_accounts").select("id, code, name")
        .eq("company_id", companyId).or(`code.eq.${LATE_FEE_INCOME_CODE},name.eq."${LATE_FEE_INCOME_NAME}"`),
    ]);
    const firstErr = byRef.error || arAccts.error || incAccts.error;
    if (firstErr) return { already: true, error: firstErr.message };

    const tenantArIds = (arAccts.data || []).map(a => a.id);
    const incomeIds = (incAccts.data || []).filter(isLateFeeIncomeAccount).map(a => a.id);
    const entries = (byRef.data || []).map(e => ({ ...e, lines: [] }));

    // (b) entries in the month that debit the tenant's AR, with all their
    // lines so a credit to late-fee income can be seen. This is how a
    // hand-entered late fee (no reference) is recognised.
    if (tenantArIds.length > 0 && incomeIds.length > 0) {
      const { data: arLines, error: arErr } = await client.from("acct_journal_lines")
        .select("journal_entry_id, acct_journal_entries!inner(id, reference, date, status, company_id)")
        .in("account_id", tenantArIds).gt("debit", 0)
        .eq("acct_journal_entries.company_id", companyId)
        .gte("acct_journal_entries.date", bounds.start).lte("acct_journal_entries.date", bounds.end)
        .limit(LINE_CAP);
      if (arErr) return { already: true, error: arErr.message };
      // A full page might be a truncated one: refuse rather than guess.
      if ((arLines || []).length >= LINE_CAP) return { already: true, error: "too many receivable lines this month to check" };
      const heads = new Map();
      for (const l of arLines || []) {
        const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
        if (je && !heads.has(je.id)) heads.set(je.id, je);
      }
      const ids = [...heads.keys()];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const { data: lines, error: lErr } = await client.from("acct_journal_lines")
          .select("journal_entry_id, account_id, debit, credit").in("journal_entry_id", chunk).limit(LINE_CAP);
        if (lErr) return { already: true, error: lErr.message };
        if ((lines || []).length >= LINE_CAP) return { already: true, error: "too many journal lines to check" };
        for (const id of chunk) {
          entries.push({ ...heads.get(id), lines: (lines || []).filter(l => l.journal_entry_id === id) });
        }
      }
    }
    return { already: lateFeeAlreadyPostedInMonth({ tenantId, month, entries, tenantArIds, incomeIds }), error: null };
  } catch (e) {
    return { already: true, error: e?.message || String(e) };
  }
}

// ─── Who is charged, when, and how much ─────────────────────────────────
// The same four answers for every path (Late Fees page, tenant button, and
// the nightly batch_post_late_fees SQL job -- change one, change the others):
//
//   * Fee type:  'flat' or 'fixed' is a dollar amount; 'percent' or
//                'percentage' is a percent of the tenant's monthly rent. Any
//                other word is refused rather than guessed (a "fixed $50" rule
//                used to be charged as 50% of rent).
//   * Amount:    the tenant's own late-fee setting when it is set (> 0),
//                otherwise the company rule.
//   * Who:       a tenant who still lives there (lease_status active or
//                notice, not archived) and owes money (balance > 0).
//   * When:      only once today is past the rent due day PLUS the grace days.
//                Due day = the tenant's active lease payment_due_day, else the
//                rent schedule's day_of_month, else the 1st (clamped to the
//                month's length). Grace = the company rule's grace_days, else 0.
//   * Month/day: the New York calendar day, never UTC.

export const LATE_FEE_TIME_ZONE = "America/New_York";
const LIVE = ["active", "current", "notice"];

// "YYYY-MM-DD" in New York for a Date (default: now). null for anything that
// is not a valid Date (Intl would throw a RangeError); callers treat null as
// "cannot tell what day it is" and charge nothing.
export function lateFeeBusinessDate(now = new Date()) {
  if (!(now instanceof Date) || isNaN(now.getTime())) return null;
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: LATE_FEE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t) => (p.find(x => x.type === t) || {}).value;
  const out = g("year") + "-" + g("month") + "-" + g("day");
  return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
}

// 'flat' | 'percent' | null (unknown word -> null, never guessed).
export function normalizeLateFeeType(t) {
  const s = String(t || "").trim().toLowerCase();
  if (s === "flat" || s === "fixed") return "flat";
  if (s === "percent" || s === "percentage" || s === "pct" || s === "%") return "percent";
  return null;
}

// { type, amount, graceDays, source } or { error }.
// tenant: { late_fee_amount, late_fee_type }; rule: { fee_type, fee_amount, grace_days } | null;
// settings: company_settings { late_fee_amount, late_fee_type, late_fee_grace_days } | null.
// The tenant's own setting first, then an active rule, then the company's
// Settings. A rule is what the AUTOMATIC job charges from; Sahil
// (2026-10-02) wants no automatic late fees, only the button on a tenant's
// ledger -- so with no rule the button falls back to Settings (5% of rent).
export function resolveLateFeeTerms({ tenant, rule, settings = null }) {
  const graceDays = Math.max(0, Math.floor(num(rule?.grace_days ?? settings?.late_fee_grace_days ?? 5)));
  if (num(tenant?.late_fee_amount) > 0) {
    const type = normalizeLateFeeType(tenant.late_fee_type || "flat");
    if (!type) return { error: `unknown late fee type "${tenant.late_fee_type}" on the tenant` };
    return { type, amount: num(tenant.late_fee_amount), graceDays, source: "tenant" };
  }
  if (rule && num(rule.fee_amount) > 0) {
    const type = normalizeLateFeeType(rule.fee_type);
    if (!type) return { error: `unknown late fee type "${rule.fee_type}" on the late fee rule` };
    return { type, amount: num(rule.fee_amount), graceDays, source: "rule" };
  }
  if (settings && num(settings.late_fee_amount) > 0) {
    const type = normalizeLateFeeType(settings.late_fee_type || "percent");
    if (!type) return { error: `unknown late fee type "${settings.late_fee_type}" in Settings` };
    return { type, amount: num(settings.late_fee_amount), graceDays, source: "settings" };
  }
  return { error: "no late fee is set for this tenant, no late fee rule is active, and Settings has no late fee" };
}

// The rent a percent fee is taken on. A voucher tenant pays only their own
// portion; the housing authority's share is not theirs to be late with.
export function lateFeeBase(tenant) {
  if (!tenant) return 0;
  if (tenant.is_voucher && num(tenant.tenant_portion) > 0) return num(tenant.tenant_portion);
  return num(tenant.rent);
}
export const lateFeeBaseLabel = (tenant) => (tenant?.is_voucher && num(tenant?.tenant_portion) > 0 ? "the tenant's portion" : "rent");

// Exact decimal arithmetic for the fee, so the app charges the same cent as
// the nightly job. SQL numeric is exact; a float product is not (rent 685 at
// 5.1% is 3493.4999999999995 in floating point, so Math.round gave $34.93
// while SQL gave $34.94). Each number is taken at its shortest decimal
// spelling (what PostgREST sent), turned into a BigInt with a scale,
// multiplied exactly, and rounded half away from zero like Postgres round().
// (BigInt() calls rather than 10n literals / **: Babel rewrites ** to
// Math.pow for older targets, which throws on a BigInt.)
/* global BigInt */
const BIG0 = BigInt(0), BIG1 = BigInt(1), BIG2 = BigInt(2), BIG10 = BigInt(10);
function pow10(k) { let p = BIG1; for (let i = 0; i < k; i++) p = p * BIG10; return p; }
function decimalOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  if (!m) return null;
  const frac = m[3] || "";
  let digits = BigInt(m[2] + frac);
  let scale = frac.length - Number(m[4] || 0);
  if (scale < 0) { digits = digits * pow10(-scale); scale = 0; }
  return { int: m[1] ? -digits : digits, scale };
}
// round(int / 10^scale, places), returned as an integer count of 10^-places.
function roundToPlaces({ int, scale }, places) {
  if (scale <= places) return int * pow10(places - scale);
  const div = pow10(scale - places);
  const neg = int < BIG0;
  const a = neg ? -int : int;
  let q = a / div;
  if ((a % div) * BIG2 >= div) q = q + BIG1;
  return neg ? -q : q;
}

// Dollar fee for the terms, rounded to cents. null when a percent fee has no rent to apply to.
// SQL twin (batch_post_late_fees, 20260928080000): flat = round(amount, 2);
// percent = round(round(rent * pct) / 100, 2). Change one, change the other.
export function computeLateFeeAmount(terms, rent) {
  if (!terms || terms.error) return null;
  const amt = decimalOf(terms.amount);
  if (terms.type === "flat") return amt ? Number(roundToPlaces(amt, 2)) / 100 : 0;
  const base = num(rent);
  if (base <= 0) return null;
  const r = decimalOf(base);
  if (!r || !amt) return 0;
  // rent * pct / 100 dollars = round(rent * pct) cents: one exact product.
  return Number(roundToPlaces({ int: r.int * amt.int, scale: r.scale + amt.scale }, 0)) / 100;
}

// Rent due date ("YYYY-MM-DD") in the month of `today` for a due day, clamped
// to the month's length (due day 31 -> Feb 28/29). null when `today` is not a
// real calendar date ("2026-13-01", "2026-02-31", "2026-9-28") -- callers
// then charge nothing.
export function lateFeeDueDate(today, dueDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(today || ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  const last = new Date(y, mo, 0).getDate();
  if (day < 1 || day > last) return null;
  const d = Math.min(Math.max(1, Math.floor(num(dueDay)) || 1), last);
  return m[1] + "-" + m[2] + "-" + String(d).padStart(2, "0");
}

// { ok, reason, daysLate }. today is a "YYYY-MM-DD" New York date.
export function lateFeeEligibility({ tenant, today, dueDay, graceDays }) {
  if (!tenant) return { ok: false, reason: "no tenant record", daysLate: 0 };
  if (tenant.archived_at) return { ok: false, reason: "the tenant is archived", daysLate: 0 };
  // Exact, case-sensitive -- the same as the SQL job's lease_status IN
  // ('active','current','notice') and the Late Fees page's .in(...) filter.
  // "Active" is charged by none of the three.
  if (!LIVE.includes(String(tenant.lease_status ?? ""))) return { ok: false, reason: "the tenant is not active or on notice", daysLate: 0 };
  if (!(num(tenant.balance) > 0)) return { ok: false, reason: "the tenant owes nothing", daysLate: 0 };
  const due = lateFeeDueDate(today, dueDay);
  if (!due) return { ok: false, reason: "invalid date", daysLate: 0 };
  const daysLate = Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(due + "T00:00:00Z")) / 86400000);
  const grace = Math.max(0, Math.floor(num(graceDays)));
  if (daysLate <= grace) return { ok: false, reason: daysLate <= 0 ? "rent is not due yet this month" : `still within the ${grace}-day grace period`, daysLate };
  return { ok: true, reason: null, daysLate };
}

// Rent due day for a tenant: active lease payment_due_day, else rent
// schedule day_of_month, else 1. leases/schedules are rows for this tenant,
// and the FIRST usable row wins, so callers must fetch them in the job's
// order (LATE_FEE_LEASE_ORDER / LATE_FEE_SCHEDULE_ORDER below).
export function lateFeeDueDay({ leases, schedules }) {
  const l = (leases || []).find(x => num(x?.payment_due_day) > 0);
  if (l) return Math.floor(num(l.payment_due_day));
  const s = (schedules || []).find(x => num(x?.day_of_month) > 0);
  if (s) return Math.floor(num(s.day_of_month));
  return 1;
}

// The job's ORDER BYs, as PostgREST .order(column, options) pairs:
//   leases                    ORDER BY start_date DESC NULLS LAST, id
//   recurring_journal_entries ORDER BY created_at, id
//   late_fee_rules            ORDER BY created_at, id
// Without them two active leases (or two schedules, or two rules created in
// the same instant) come back in whatever order Postgres likes, and the app
// could pick a different due day or fee than the nightly job.
export const LATE_FEE_LEASE_ORDER = [["start_date", { ascending: false, nullsFirst: false }], ["id", { ascending: true }]];
export const LATE_FEE_SCHEDULE_ORDER = [["created_at", { ascending: true }], ["id", { ascending: true }]];
export const LATE_FEE_RULE_ORDER = [["created_at", { ascending: true }], ["id", { ascending: true }]];
export function lateFeeOrdered(query, order) {
  return order.reduce((q, [col, opts]) => q.order(col, opts), query);
}
