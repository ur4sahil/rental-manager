// Owners (properties managed for outside owners): the shared rules.
//
// CommonJS, like paymentRules.js, so the SAME file is used by the browser
// bundle (webpack interops module.exports), by api/stripe.js (the Stripe
// webhook require()s it) and by tests/owners.test.mjs in plain node.
//
// Everything above runOwnerDistributionAccrual is pure. That one function does
// I/O, but only through the Supabase client and the posting functions it is
// handed, so the browser (autoOwnerDistribution) and the webhook run the one
// implementation with their own client and their own journal-entry poster.
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
// The fee accrual posted when rent is received (DR 4000 / CR 4200 / CR 2200).
// Deterministic so a retry of the same receipt collides on the unique
// (company_id, reference) index instead of accruing twice.
function ownerAccrualReference({ ownerId, tenantName, date, cents }) {
  const tenantSlug = String(tenantName || "anon").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32);
  const refDate = String(date || "").replace(/-/g, "");
  return "ODIST-" + ownerId + "-" + tenantSlug + "-" + refDate + "-" + cents;
}

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

// lines: [{ account_id, debit, credit, memo, class_id,
//           acct_journal_entries: { date, reference, description, status, property } }]
// accounts: [{ id, code, name, type }]
// payouts: owner_distributions rows (any kind; only live payouts are used)
function buildOwnerStatement({ lines, accounts, feeRule, payouts, startDate, endDate }) {
  const byId = new Map((accounts || []).map(a => [String(a.id), a]));
  const seen = new Set();
  const income = [], expenses = [];
  let incomeCents = 0, expenseCents = 0, rentCents = 0;
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
      if (isRentIncomeAccount(acct)) rentCents += c;
    } else if (cls === "expense") {
      const c = dr - cr; if (!c) continue;
      expenseCents += c; expenses.push({ date: d, description: desc, amount: -c / 100 });
    }
  }
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  income.sort(byDate); expenses.sort(byDate);
  const rule = feeRule || { pct: 0, isSet: false, source: "none" };
  const feeCents = mgmtFeeCents(rentCents, rule.pct);
  const netCents = incomeCents - expenseCents - feeCents;
  const paid = (payouts || []).filter(isLivePayout).filter(p => {
    const d = String(p.date || "").slice(0, 10);
    return (!startDate || d >= startDate) && (!endDate || d <= endDate);
  });
  const paidCents = paid.reduce((s, p) => s + toCents(p.amount), 0);
  const rentStr = (rentCents / 100).toFixed(2);
  const feeDesc = rule.isSet
    ? rule.pct + "% of rent " + rentStr + " (late fees and other income carry no fee)"
    : (rule.source === "company"
        ? "Fee not set on owner — company default " + rule.pct + "% of rent " + rentStr
        : "Fee not set on owner — 0%");
  const lineItems = [];
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
    rentIncome: rentCents / 100,
    totalExpenses: expenseCents / 100,
    managementFee: feeCents / 100,
    netToOwner: netCents / 100,
    distributionsPaid: paidCents / 100,
    feePct: rule.pct, feeIsSet: rule.isSet,
    lineItems,
  };
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

// ─── RENT RECEIPT -> OWNER FEE ACCRUAL (I/O through the given client) ─────
// Is there a rent charge on the tenant's own AR in `month`? The id-based
// check from accounting.js#checkAccrualExists, runnable with any client. A
// failed read answers TRUE ("could not tell"), as the original does.
// The tenant's rent CHARGED in `month`, in cents: debits of a rent-charge
// family (RECUR-, RENT1-, PRORENT-, ...) on the tenant's own AR accounts,
// voided entries excluded. null when the read fails ("could not tell").
async function tenantRentChargedCentsInMonth(sb, companyId, month, tenantId) {
  const { data: arAccts, error: arErr } = await sb.from("acct_accounts")
    .select("id").eq("company_id", companyId).eq("tenant_id", tenantId);
  if (arErr) return null;
  const arIds = (arAccts || []).map(a => String(a.id));
  if (arIds.length === 0) return 0;
  const { start, end } = monthBounds(month);
  const { data: lines, error: lErr } = await sb.from("acct_journal_lines")
    .select("account_id, debit, acct_journal_entries!inner(reference, date, status)")
    .eq("company_id", companyId).in("account_id", arIds.slice(0, 100)).gt("debit", 0)
    .neq("acct_journal_entries.status", "voided")
    .gte("acct_journal_entries.date", start).lte("acct_journal_entries.date", end)
    .limit(1000);
  if (lErr) return null;
  let cents = 0;
  for (const l of lines || []) {
    if (hasRentChargeInMonth([l], arIds, month)) cents += toCents(l.debit);
  }
  return cents;
}

// Rent already accrued for this owner + tenant in `month` (the DR Rental
// Income on earlier live ODIST- entries), in cents. null on a failed read.
async function rentAccruedCentsInMonth(sb, companyId, ownerId, tenantName, month) {
  const prefix = ownerAccrualReference({ ownerId, tenantName, date: month.replace("-", "") + "01", cents: 0 })
    .replace(/01-0$/, "");  // ODIST-<owner>-<slug>-<yyyymm>
  const pattern = prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const { data, error } = await sb.from("acct_journal_entries")
    .select("id, reference, acct_journal_lines(debit)")
    .eq("company_id", companyId).like("reference", pattern).neq("status", "voided").limit(1000);
  if (error) return null;
  let cents = 0;
  for (const je of data || []) {
    if (!String(je.reference || "").startsWith(prefix)) continue;
    for (const l of je.acct_journal_lines || []) cents += toCents(l.debit);
  }
  return cents;
}

// RENT-FIRST: a receipt is applied to the tenant's rent for the month before
// anything else. The fee-bearing, reclassified part of a receipt is
//   min(receipt, rent charged this month - rent already accrued this month)
// and the rest (late fees, other charges, prepayment) accrues NOTHING here:
// it stays in its own income account and reaches the owner through the
// statement, which passes non-rent income through with no fee.
function rentPortionCents(paymentCents, chargedCents, accruedCents) {
  const open = Math.max(0, (chargedCents || 0) - (accruedCents || 0));
  return Math.max(0, Math.min(paymentCents, open));
}

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

// Given a posted rent receipt, accrue the owner's share: DR Rental Income /
// CR Management Fee Income (fee) / CR Owner Distributions Payable (net), and
// record an owner_distributions row of kind 'accrual'. Never throws.
//
// deps:
//   postJournalEntry({ companyId, date, description, reference, property, lines })
//       -> truthy JE id, or null / { error } on failure. Lines carry BARE
//          account codes ("4000", "4200", "2200"); the poster resolves them.
//   resolveClassId(propertyAddress) -> class id or null
//   rentChargeExists(month) -> boolean (defaults to tenantRentChargeInMonth)
//   companyDefaultFeePct -> optional (see resolveMgmtFeePct)
// Returns { posted, skipped, error, reference, ownerNet, mgmtFee }.
async function runOwnerDistributionAccrual(sb, args, deps) {
  const { companyId, propertyAddress, amount, date, tenantName, tenantId } = args || {};
  const d = deps || {};
  try {
    if (!companyId || !propertyAddress || !date) return { skipped: "missing input" };
    const paymentCents = toCents(amount);
    if (!(paymentCents > 0)) return { skipped: "no amount" };
    const { data: prop, error: pErr } = await sb.from("properties")
      .select("id, owner_id").eq("company_id", companyId).eq("address", propertyAddress).is("archived_at", null).maybeSingle();
    if (pErr) return { error: "property lookup failed: " + pErr.message };
    if (!prop || !prop.owner_id) return { skipped: "no owner" };
    const { data: owner, error: oErr } = await sb.from("owners")
      .select("id, name, management_fee_pct").eq("company_id", companyId).eq("id", prop.owner_id).maybeSingle();
    if (oErr) return { error: "owner lookup failed: " + oErr.message };
    if (!owner) return { skipped: "owner not found" };
    const month = String(date).slice(0, 7);
    const reference = ownerAccrualReference({ ownerId: owner.id, tenantName, date, cents: paymentCents });
    // Already accrued (a retried webhook, a second click): nothing to do.
    const { data: live, error: liveErr } = await sb.from("acct_journal_entries").select("id")
      .eq("company_id", companyId).eq("reference", reference).neq("status", "voided").limit(1);
    if (liveErr) return { error: "reference check failed: " + liveErr.message };
    if (live && live.length) return { skipped: "already accrued", reference };
    // Only RENT is reclassified and carries the fee (fee base = rent only).
    // Rent-first: the part of this receipt that pays rent charged this month
    // and not yet accrued. With a tenant id that is measured from the
    // tenant's own AR; a failed read falls back to the whole receipt (the
    // old behaviour). Without a tenant id (legacy callers) the receipt is
    // treated as rent when a rent charge exists this month.
    let rentC;
    if (tenantId !== null && tenantId !== undefined && tenantId !== "") {
      const charged = d.rentChargedCents ? await d.rentChargedCents(month) : await tenantRentChargedCentsInMonth(sb, companyId, month, tenantId);
      if (charged === 0) return { skipped: "no rent charge this month" };
      const accrued = await rentAccruedCentsInMonth(sb, companyId, owner.id, tenantName, month);
      rentC = charged === null || accrued === null ? paymentCents : rentPortionCents(paymentCents, charged, accrued);
    } else {
      const hasCharge = d.rentChargeExists ? await d.rentChargeExists(month) : false;
      if (!hasCharge) return { skipped: "no rent charge this month" };
      rentC = paymentCents;
    }
    if (!(rentC > 0)) return { skipped: "no unaccrued rent this month (receipt pays other charges)", reference };
    const rule = resolveMgmtFeePct(owner, d.companyDefaultFeePct);
    const feeC = mgmtFeeCents(rentC, rule.pct);
    const netC = rentC - feeC;
    const classId = d.resolveClassId ? await d.resolveClassId(propertyAddress) : null;
    const gross = (paymentCents / 100).toFixed(2), rentPart = (rentC / 100).toFixed(2), fee = (feeC / 100).toFixed(2), net = (netC / 100).toFixed(2);
    const passThrough = ((paymentCents - rentC) / 100).toFixed(2);
    const { data: distRow, error: distErr } = await sb.from("owner_distributions").insert([{
      company_id: companyId, owner_id: owner.id, kind: "accrual",
      amount: netC / 100, date, reference, method: "accrual",
      notes: "Rent from " + (tenantName || "tenant") + " at " + propertyAddress + " — receipt " + gross + " · rent " + rentPart + " · mgmt fee " + rule.pct + "% of rent" + (rule.isSet ? "" : " (not set)") + " (" + fee + ") · net " + net + (rentC < paymentCents ? " · " + passThrough + " non-rent, no fee (on the statement)" : ""),
    }]).select("id").maybeSingle();
    if (distErr) return { error: "owner_distributions insert failed: " + distErr.message };
    const lines = [{ account_id: "4000", account_name: "Rental Income", debit: rentC / 100, credit: 0, class_id: classId, memo: "Reclassify to owner dist — " + (tenantName || "tenant") }];
    if (feeC > 0) lines.push({ account_id: "4200", account_name: "Management Fee Income", debit: 0, credit: feeC / 100, class_id: classId, memo: "Mgmt fee " + rule.pct + "% — " + owner.name });
    if (netC > 0) lines.push({ account_id: "2200", account_name: "Owner Distributions Payable", debit: 0, credit: netC / 100, class_id: classId, memo: "Net to " + owner.name });
    const posted = await d.postJournalEntry({
      companyId, date, reference, property: propertyAddress, lines,
      description: "Owner distribution accrual — " + owner.name + " — " + (tenantName || "tenant"),
    });
    const jeId = posted && typeof posted === "object" ? posted.id : posted;
    if (!jeId) {
      if (distRow && distRow.id) await sb.from("owner_distributions").delete().eq("id", distRow.id).eq("company_id", companyId);
      return { error: "journal entry not posted" + (posted && posted.error ? ": " + posted.error : "") + " — accrual row rolled back", reference };
    }
    return { posted: true, reference, jeId, rentPortion: rentC / 100, ownerNet: netC / 100, mgmtFee: feeC / 100, feePct: rule.pct };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

module.exports = {
  isFeeSet, resolveMgmtFeePct, feeLabel, parseFeeInput, mgmtFeeCents, toCents,
  ownerAccrualReference, payoutReference, DISTRIBUTION_KINDS,
  distributionKindFromReference, distributionKind, isLivePayout, sumPayouts,
  INCOME_TYPES, EXPENSE_TYPES, OWNER_MACHINERY_PREFIXES, MGMT_FEE_INCOME_CODE,
  accountClass, isRentIncomeAccount, buildOwnerStatement, rentPortionCents,
  normOwnerName, findOwnerByName, propertyOwnerName,
  tenantRentChargeInMonth, tenantRentChargedCentsInMonth, rentAccruedCentsInMonth, runOwnerDistributionAccrual,
};
