// Owners (properties managed for outside owners): the shared rules.
//
// CommonJS, like paymentRules.js, so the SAME file is used by the browser
// bundle (webpack interops module.exports), by api/stripe.js (the Stripe
// webhook require()s it) and by tests/owners.test.mjs in plain node.
//
// Everything here is pure except tenantRentChargeInMonth and
// syncOwnerAccruals, which do I/O only through the Supabase client they are
// handed. The owner ACCRUAL itself lives in SQL -- owner_accrual_sync
// (supabase/migrations/20260928170000_owner_accrual_rpc.sql): rent-first,
// oldest-first allocation of receipts to rent charges under a per-tenant
// lock, kept in step by triggers on every receipt, charge and void.
//
// Why this exists:
//  * properties.owner_id was never written by the app, so nothing keyed on it
//    (statements, portal RLS, the fee accrual) ever found a property.
//  * Owners.js charged `management_fee_pct || 10` -- a 0% owner paid 10% --
//    while the accrual treated null/0 as 0. Two rules for one number.
//  * Statements read income from the payments table (Stripe/autopay only,
//    capped at 500 rows) and expenses from work_orders.cost -- not the books.
//  * owner_distributions holds both fee ACCRUALS and PAYOUTS, both positive,
//    and "Distributed (YTD)" summed them together.

const { hasRentChargeInMonth, monthBounds } = require("./paymentRules");

// ─── MANAGEMENT FEE: ONE RULE ─────────────────────────────────────────────
// 0 means 0. null / undefined / "" means NOT SET: use the company-level
// default when one is configured (a finite number >= 0), otherwise 0 -- and
// the UI says "Fee not set" so staff notice. There is no company-level
// default setting in the app today (company_settings has none), so callers
// pass nothing and an unset fee is 0%.
function isFeeSet(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string" && v.trim() === "") return false;
  return Number.isFinite(Number(v));
}

function resolveMgmtFeePct(owner, companyDefaultPct) {
  const raw = owner ? owner.management_fee_pct : null;
  if (isFeeSet(raw)) {
    const n = Number(raw);
    return { pct: n < 0 ? 0 : n, isSet: true, source: "owner" };
  }
  if (isFeeSet(companyDefaultPct) && Number(companyDefaultPct) >= 0) {
    return { pct: Number(companyDefaultPct), isSet: false, source: "company" };
  }
  return { pct: 0, isSet: false, source: "none" };
}

function feeLabel(owner, companyDefaultPct) {
  const r = resolveMgmtFeePct(owner, companyDefaultPct);
  if (r.isSet) return r.pct + "% fee";
  if (r.source === "company") return "Fee not set (company default " + r.pct + "%)";
  return "Fee not set (0%)";
}

// The fee form: "" stays "not set" (null); anything else must be a number
// from 0 to 100. Returns { value } or { error }.
function parseFeeInput(v) {
  if (v === null || v === undefined || String(v).trim() === "") return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return { error: "Management fee must be a number from 0 to 100 (or left blank)." };
  return { value: n };
}

const toCents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; };

function mgmtFeeCents(incomeCents, pct) {
  if (!(incomeCents > 0) || !(Number(pct) > 0)) return 0;
  return Math.round(incomeCents * Number(pct) / 100);
}

// ─── REFERENCES + KINDS ───────────────────────────────────────────────────
// A payout to the owner (DR 2200 / CR Checking). The user's "Reference #"
// (a check number, an ACH trace) used to BE the journal reference, so typing
// "1001" collided with any other entry referenced "1001" and the payout was
// refused. Now: a DIST- reference built from owner, date and amount, plus a
// slug of the user's text so two different checks for the same amount on the
// same day stay distinct. The user's text itself is kept as a memo.
function payoutReference({ ownerId, date, cents, userRef }) {
  const o = String(ownerId || "").replace(/-/g, "").slice(0, 8);
  const d = String(date || "").replace(/-/g, "");
  const slug = String(userRef || "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 16);
  return "DIST-" + o + "-" + d + "-" + cents + (slug ? "-" + slug : "");
}

const DISTRIBUTION_KINDS = ["accrual", "payout"];

// Same rule the migration used to backfill old rows (and the insert trigger
// uses when a writer sends no kind): ODIST- is the fee accrual, everything
// else was written by "Pay Owner".
function distributionKindFromReference(ref) {
  return String(ref || "").startsWith("ODIST-") ? "accrual" : "payout";
}

function distributionKind(d) {
  if (d && DISTRIBUTION_KINDS.includes(d.kind)) return d.kind;
  return distributionKindFromReference(d && d.reference);
}

function isLivePayout(d) {
  return !!d && distributionKind(d) === "payout" && !d.voided_at;
}

// Payouts only, voided excluded; `year` ("2026") limits to that calendar year.
function sumPayouts(dists, { year, start, end } = {}) {
  let cents = 0;
  for (const d of dists || []) {
    if (!isLivePayout(d)) continue;
    const dt = String(d.date || "").slice(0, 10);
    if (year && dt.slice(0, 4) !== String(year)) continue;
    if (start && dt < start) continue;
    if (end && dt > end) continue;
    cents += toCents(d.amount);
  }
  return cents / 100;
}

// ─── STATEMENT FROM THE GENERAL LEDGER ────────────────────────────────────
const INCOME_TYPES = ["revenue", "income", "other income"];
const EXPENSE_TYPES = ["expense", "cost of goods sold", "other expense"];
// Entries that are the owner-distribution machinery itself: the fee accrual
// (ODIST-) and payouts (DIST-). They move money between the manager and the
// owner; they are not the property's income or expenses.
const OWNER_MACHINERY_PREFIXES = ["ODIST-", "DIST-"];
// Management fee income is the MANAGER's revenue; the statement computes the
// fee from the rule, so a 4200 line is never the owner's income.
const MGMT_FEE_INCOME_CODE = "4200";

// FEE BASE = RENT ONLY (owner decision 2026-09-28). The management fee is
// charged on rental income only; late fees and other income pass through to
// the owner with no fee. "Rent" = the Rental Income account: code 4000 (or a
// 4000-xx sub-account), or an income account named "Rental Income" /
// "Rent Income" (QuickBooks-imported books sometimes use other codes).
function isRentIncomeAccount(acct) {
  if (!acct) return false;
  const code = String(acct.code || "").trim();
  if (code === "4000" || /^4000[-.]/.test(code)) return true;
  return /\brent(al)?\s+income\b/i.test(String(acct.name || ""));
}

function accountClass(acct) {
  const t = String((acct && acct.type) || "").trim().toLowerCase();
  if (INCOME_TYPES.includes(t)) return "income";
  if (EXPENSE_TYPES.includes(t)) return "expense";
  return null;
}

// OWNER STATEMENT -- "billed, but show collected" (owner decision 1,
// 2026-09-29).
//  * Income and expenses come from the general ledger for the properties the
//    owner owned at the time (the loader applies property_owner_history).
//  * Rent is shown three ways: BILLED (rent-income credits in the period),
//    COLLECTED (rent the owner accrued in the period -- the ODIST accruals
//    dated in the period), UNPAID (billed this period and not yet collected).
//  * The management fee and the Net Distribution to Owner are computed on
//    COLLECTED rent only: they are the sums of the owner's accruals in the
//    period, so they equal what was booked to 4200 / 2200 for the period.
//  * Late fees and other income appear as billed income; they are not part
//    of the distribution (nothing books them to 2200). Expenses are listed;
//    "net after expenses" is shown for information only.
//
// lines:    GL lines [{ id, journal_entry_id, account_id, debit, credit, memo,
//             acct_journal_entries: { date, reference, description, status } }]
// accounts: [{ id, code, name, type }]
// accruals: the owner's live accrual rows [{ amount, rent_amount, date,
//             charge_je_id, voided_at, kind }] (any date)
// payouts:  owner_distributions rows (only live payouts in period are used)
function buildOwnerStatement({ lines, accounts, feeRule, accruals, payouts, startDate, endDate }) {
  const byId = new Map((accounts || []).map(a => [String(a.id), a]));
  const seen = new Set();
  const income = [], expenses = [];
  let incomeCents = 0, expenseCents = 0, rentCents = 0;
  const rentChargeJes = new Set();
  for (const l of lines || []) {
    if (!l) continue;
    const je = Array.isArray(l.acct_journal_entries) ? l.acct_journal_entries[0] : l.acct_journal_entries;
    if (!je || String(je.status || "") !== "posted") continue;
    const d = String(je.date || "").slice(0, 10);
    if ((startDate && d < startDate) || (endDate && d > endDate)) continue;
    const ref = String(je.reference || "");
    if (OWNER_MACHINERY_PREFIXES.some(p => ref.startsWith(p))) continue;
    // A line fetched twice (class match AND property-text fallback) counts once.
    if (l.id !== undefined && l.id !== null) { if (seen.has(String(l.id))) continue; seen.add(String(l.id)); }
    const acct = byId.get(String(l.account_id));
    if (!acct || String(acct.code || "") === MGMT_FEE_INCOME_CODE) continue;
    const cls = accountClass(acct);
    const dr = toCents(l.debit), cr = toCents(l.credit);
    const desc = (acct.name || "Account") + " — " + (je.description || l.memo || ref || "");
    if (cls === "income") {
      const c = cr - dr; if (!c) continue;
      incomeCents += c; income.push({ date: d, description: desc, amount: c / 100 });
      if (isRentIncomeAccount(acct)) { rentCents += c; if (l.journal_entry_id) rentChargeJes.add(String(l.journal_entry_id)); }
    } else if (cls === "expense") {
      const c = dr - cr; if (!c) continue;
      expenseCents += c; expenses.push({ date: d, description: desc, amount: -c / 100 });
    }
  }
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  income.sort(byDate); expenses.sort(byDate);
  const rule = feeRule || { pct: 0, isSet: false, source: "none" };
  // Collected = the owner's accruals dated in the period (== 4200 / 2200).
  const live = (accruals || []).filter(a => a && !a.voided_at && (a.kind === undefined || a.kind === "accrual"));
  let collectedCents = 0, feeCents = 0, netCents = 0, collectedForPeriodCharges = 0;
  for (const a of live) {
    const d = String(a.date || "").slice(0, 10);
    const rent = toCents(a.rent_amount), net = toCents(a.amount);
    if ((!startDate || d >= startDate) && (!endDate || d <= endDate)) {
      collectedCents += rent; netCents += net; feeCents += rent - net;
    }
    if (a.charge_je_id && rentChargeJes.has(String(a.charge_je_id))) collectedForPeriodCharges += rent;
  }
  const unpaidCents = Math.max(0, rentCents - collectedForPeriodCharges);
  const paid = (payouts || []).filter(isLivePayout).filter(p => {
    const d = String(p.date || "").slice(0, 10);
    return (!startDate || d >= startDate) && (!endDate || d <= endDate);
  });
  const paidCents = paid.reduce((s, p) => s + toCents(p.amount), 0);
  const money = (c) => (c / 100).toFixed(2);
  const feeDesc = rule.isSet
    ? rule.pct + "% of collected rent " + money(collectedCents) + " (late fees and other income carry no fee)"
    : (rule.source === "company"
        ? "Fee not set on owner — company default " + rule.pct + "% of collected rent " + money(collectedCents)
        : "Fee not set on owner — 0%");
  const lineItems = [];
  lineItems.push({ category: "Rent Summary", items: [
    { key: "billed", date: endDate, description: "Rent billed", amount: rentCents / 100 },
    { key: "collected", date: endDate, description: "Rent collected", amount: collectedCents / 100 },
    { key: "unpaid", date: endDate, description: "Rent unpaid (billed this period, not yet collected)", amount: unpaidCents / 100 },
  ] });
  if (income.length) lineItems.push({ category: "Income", items: income });
  if (expenses.length) lineItems.push({ category: "Expenses", items: expenses });
  lineItems.push({ category: "Management Fee", items: [{ date: endDate, description: feeDesc, amount: -feeCents / 100 }] });
  if (paid.length) {
    lineItems.push({ category: "Distributions Paid", items: paid
      .map(p => ({ date: String(p.date || "").slice(0, 10), description: "Payout " + (p.method || "") + (p.notes ? " — " + p.notes : ""), amount: -toCents(p.amount) / 100 }))
      .sort(byDate) });
  }
  return {
    totalIncome: incomeCents / 100,
    rentIncome: rentCents / 100,            // rent billed
    rentBilled: rentCents / 100,
    rentCollected: collectedCents / 100,
    rentUnpaid: unpaidCents / 100,
    otherIncome: (incomeCents - rentCents) / 100,
    totalExpenses: expenseCents / 100,
    managementFee: feeCents / 100,          // on collected rent (= 4200)
    netToOwner: netCents / 100,             // collected rent - fee (= 2200)
    netAfterExpenses: (netCents - expenseCents) / 100,
    distributionsPaid: paidCents / 100,
    feePct: rule.pct, feeIsSet: rule.isSet,
    lineItems,
  };
}

// Pull the rent summary back out of a stored statement's line items (print,
// Excel, portal). Older statements have none: null.
function statementRentSummary(cats) {
  const c = (cats || []).find(x => x && x.category === "Rent Summary");
  if (!c || !Array.isArray(c.items)) return null;
  const get = (k) => { const it = c.items.find(i => i && i.key === k); return it ? Number(it.amount) || 0 : 0; };
  return { billed: get("billed"), collected: get("collected"), unpaid: get("unpaid") };
}

// ─── OWNER PICKER: resolve a typed / imported owner name ──────────────────
function normOwnerName(s) { return String(s || "").trim().replace(/\s+/g, " ").toLowerCase(); }

// Active owners only; ambiguous names (two owners called the same) resolve to
// null so a caller never guesses between them.
function findOwnerByName(owners, name) {
  const n = normOwnerName(name);
  if (!n) return null;
  const hits = (owners || []).filter(o => !o.archived_at && normOwnerName(o.name) === n);
  return hits.length === 1 ? hits[0] : null;
}

// What a property's owner reads as: the linked owner record's name, falling
// back to the legacy free-text owner_name only when nothing is linked.
function propertyOwnerName(property, ownersById) {
  if (!property) return "";
  const id = property.owner_id;
  if (id && ownersById) {
    const o = typeof ownersById.get === "function" ? ownersById.get(String(id)) : ownersById[String(id)];
    if (o && o.name) return o.name;
  }
  return property.owner_name || "";
}

// ─── RENT RECEIPT -> OWNER ACCRUAL (SQL) ──────────────────────────────────
// Is there a rent charge on the tenant's own AR in `month`? Used by
// accounting.js#checkAccrualExists. A failed read answers TRUE ("could not
// tell").
async function tenantRentChargeInMonth(sb, companyId, month, tenantId) {
  const { data: arAccts, error: arErr } = await sb.from("acct_accounts")
    .select("id").eq("company_id", companyId).eq("tenant_id", tenantId);
  if (arErr) return true;
  const arIds = (arAccts || []).map(a => a.id);
  if (arIds.length === 0) return false;
  const { start, end } = monthBounds(month);
  const { data: lines, error: lErr } = await sb.from("acct_journal_lines")
    .select("account_id, debit, acct_journal_entries!inner(reference, date, status)")
    .eq("company_id", companyId).in("account_id", arIds.slice(0, 100)).gt("debit", 0)
    .neq("acct_journal_entries.status", "voided")
    .gte("acct_journal_entries.date", start).lte("acct_journal_entries.date", end)
    .limit(1000);
  if (lErr) return true;
  return hasRentChargeInMonth(lines, arIds, month);
}

// Bring a tenant's owner accruals up to date: the SQL function
// owner_accrual_sync allocates every receipt to the tenant's rent charges,
// oldest first, in one transaction under a per-tenant lock, and posts / voids
// the ODIST- entries to match. Idempotent -- safe to call after any receipt;
// triggers also run it on every receipt, charge and void. Never throws.
async function syncOwnerAccruals(sb, companyId, tenantId) {
  if (!companyId || tenantId === null || tenantId === undefined || tenantId === "") return { skipped: "missing tenant" };
  const tid = Number(tenantId);
  if (!Number.isInteger(tid)) return { skipped: "missing tenant" };
  try {
    const { data, error } = await sb.rpc("owner_accrual_sync", { p_company_id: companyId, p_tenant_id: tid });
    if (error) return { error: error.message };
    return data || {};
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

module.exports = {
  isFeeSet, resolveMgmtFeePct, feeLabel, parseFeeInput, mgmtFeeCents, toCents,
  payoutReference, DISTRIBUTION_KINDS,
  distributionKindFromReference, distributionKind, isLivePayout, sumPayouts,
  INCOME_TYPES, EXPENSE_TYPES, OWNER_MACHINERY_PREFIXES, MGMT_FEE_INCOME_CODE,
  accountClass, isRentIncomeAccount, buildOwnerStatement, statementRentSummary,
  normOwnerName, findOwnerByName, propertyOwnerName,
  tenantRentChargeInMonth, syncOwnerAccruals,
};
