// What a tenant owes, broken out the way a Maryland failure-to-pay-rent
// filing needs it: past-due RENT for a period, LATE FEES for a period, and
// a total. Pure: no database, no React. (Moved into the app from
// scripts/court-forms/arrears-fifo.js, which stays as the reference the
// first cases were checked against.)
//
// WHY OLDEST-FIRST. A balance says how much is owed, not which months are
// open or how much of it is rent rather than fees. Payments are applied to
// the oldest charge first -- which is how a tenant's money is actually
// credited -- and what is left open IS the claim; the periods fall out of
// which charges are still open.
//
// WHAT IS NEVER CLAIMED. The court's notice says the amounts do "not include
// other charges related to utilities, services, other fees, fines, and
// court costs". A charge that is neither rent nor a late fee still takes
// its turn in the queue (the tenant's money paid it, or did not), but an
// open one is listed as "not claimed" and never reaches the form. So the
// claim can be less than the balance, never more.
//
// WHY VOUCHER TENANCIES ARE SPLIT. On a housing-voucher tenancy the rent
// comes from two sources. A landlord cannot sue the TENANT for the housing
// authority's share. Each month's rent is split by what the authority
// actually paid, two queues are run, and only the tenant's reaches the
// form. When the two do not add back to the ledger the split is reported as
// unreliable and no number is offered: a figure that does not reconcile
// must not reach a court filing.
import { isRentCharge } from "./onboardingRules.js";

export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A housing-authority remittance, as opposed to money from the tenant.
export const isVoucherPayment = (s) => /\bhap\b|hapgc|housing assistance|housing authority|voucher|section ?8|\bhcv\b/i.test(String(s || ""));

export const CHARGE_CATEGORIES = ["rent", "late_fee", "other"];
export const CATEGORY_LABEL = { rent: "Rent", late_fee: "Late fee", other: "Not rent or a late fee" };

/** rent | late_fee | other, from how the charge was posted. */
export function classifyCharge({ reference = "", memo = "", description = "", transactionType = "" } = {}) {
  const text = (String(memo || "") + " " + String(description || "")).toLowerCase();
  if (/^LATEFEE-/.test(String(reference || "")) || String(transactionType || "") === "late_fee" || /late\s*(fee|charge)/.test(text)) return "late_fee";
  if (isRentCharge({ reference, memo, description })) return "rent";
  return "other";
}

const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const pad = (n) => String(n).padStart(2, "0");
export const monthStart = (iso) => (isIso(iso) ? iso.slice(0, 8) + "01" : "");
export function monthEnd(iso) {
  if (!isIso(iso)) return "";
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/**
 * Journal lines on the tenant's receivable account(s) -> queue entries.
 * lines: [{ id, date, debit, credit, memo, description, reference, transactionType, createdAt }]
 * overrides: { [lineId]: "rent" | "late_fee" | "other" } -- a person's correction.
 */
export function entriesFromLines(lines, overrides = {}) {
  const out = [];
  for (const l of lines || []) {
    if (!l || !isIso(String(l.date || "").slice(0, 10))) continue;
    const date = String(l.date).slice(0, 10);
    const label = String(l.description || l.memo || "").trim();
    const debit = money(l.debit), credit = money(l.credit);
    if (debit > 0) {
      const auto = classifyCharge(l);
      const chosen = overrides && CHARGE_CATEGORIES.includes(overrides[l.id]) ? overrides[l.id] : auto;
      out.push({ id: l.id, kind: "charge", date, amount: debit, label, category: chosen, autoCategory: auto, createdAt: l.createdAt || "" });
    }
    if (credit > 0) out.push({ id: l.id, kind: "payment", date, amount: credit, label, voucher: isVoucherPayment(label + " " + String(l.memo || "")), createdAt: l.createdAt || "" });
  }
  return out;
}

const RANK = { rent: 0, other: 1, late_fee: 2 };
const byAge = (a, b) => a.date.localeCompare(b.date) || (RANK[a.category] ?? 1) - (RANK[b.category] ?? 1) || String(a.createdAt).localeCompare(String(b.createdAt));

function settle(queue, pays) {
  let credit = (pays || []).reduce((s, p) => money(s + Number(p.amount)), 0);
  for (const c of queue) {
    if (credit <= 0) break;
    const a = Math.min(credit, c.open);
    c.open = money(c.open - a); credit = money(credit - a);
  }
  return credit;
}

function summarise(queue, creditLeft, voucherTenancy) {
  const open = queue.filter(c => c.open > 0.004);
  const pick = (cat) => open.filter(c => c.category === cat);
  const span = (list) => {
    if (!list.length) return { amount: 0, from: "", to: "", months: 0 };
    const months = new Set(list.map(c => c.date.slice(0, 7)));
    return { amount: money(list.reduce((s, c) => s + c.open, 0)), from: monthStart(list[0].date), to: monthEnd(list[list.length - 1].date), months: months.size };
  };
  const rent = span(pick("rent")), lateFees = span(pick("late_fee")), other = pick("other");
  return {
    voucherTenancy,
    rent, lateFees,
    notClaimed: { amount: money(other.reduce((s, c) => s + c.open, 0)), count: other.length },
    total: money(rent.amount + lateFees.amount),
    creditLeft,
    open: open.map(c => ({ id: c.id, date: c.date, label: c.label, category: c.category, autoCategory: c.autoCategory || c.category, share: c.share || "tenant", charged: c.amount, stillOpen: c.open })),
  };
}

/**
 * entries: from entriesFromLines. opts.voucher: split rent between the
 * housing authority and the tenant.
 * Returns { rent, lateFees, notClaimed, total, balance, open, creditLeft,
 *           voucherTenancy, reconciles, unreliable?, blockedReason?, voucherSide? }
 */
export function fifoArrears(entries, opts = {}) {
  const charges = (entries || []).filter(e => e && e.kind === "charge" && money(e.amount) > 0).map(e => ({ ...e, amount: money(e.amount), category: CHARGE_CATEGORIES.includes(e.category) ? e.category : "other" })).sort(byAge);
  const payments = (entries || []).filter(e => e && e.kind === "payment" && money(e.amount) > 0).sort((a, b) => a.date.localeCompare(b.date));
  const balance = money(charges.reduce((s, c) => s + c.amount, 0) - payments.reduce((s, p) => s + money(p.amount), 0));

  if (!opts.voucher) {
    const q = charges.map(c => ({ ...c, open: c.amount }));
    const left = settle(q, payments);
    return { ...summarise(q, left, false), balance, reconciles: true };
  }

  // ── voucher tenancy ──────────────────────────────────────────────────
  // What the authority paid, by month: the observed voucher share. A month
  // it has not paid yet carries the last known amount forward, so that
  // month does not silently become the tenant's debt.
  const hapByMonth = new Map();
  for (const p of payments) {
    if (!p.voucher) continue;
    const k = p.date.slice(0, 7);
    hapByMonth.set(k, money((hapByMonth.get(k) || 0) + Number(p.amount)));
  }
  const monthsSeen = [...hapByMonth.keys()].sort();
  const hapFor = (k) => {
    if (hapByMonth.has(k)) return hapByMonth.get(k);
    const prior = monthsSeen.filter(m => m < k);
    return prior.length ? hapByMonth.get(prior[prior.length - 1]) : 0;
  };

  const tenantQ = [], voucherQ = [];
  for (const c of charges) {
    if (c.category !== "rent") { tenantQ.push({ ...c, open: c.amount, share: "tenant" }); continue; }
    const authority = money(Math.min(hapFor(c.date.slice(0, 7)), c.amount));
    const tenantShare = money(c.amount - authority);
    if (authority > 0) voucherQ.push({ ...c, amount: authority, open: authority, share: "voucher" });
    if (tenantShare > 0) tenantQ.push({ ...c, amount: tenantShare, open: tenantShare, share: "tenant" });
  }
  // Two queues, each settled only by its own source of money.
  const tenantLeft = settle(tenantQ, payments.filter(p => !p.voucher));
  const voucherLeft = settle(voucherQ, payments.filter(p => p.voucher));

  const out = { ...summarise(tenantQ, tenantLeft, true), balance };
  const vOpen = voucherQ.filter(c => c.open > 0.004);
  out.voucherSide = {
    owedByAuthority: money(vOpen.reduce((s, c) => s + c.open, 0)),
    months: new Set(vOpen.map(c => c.date.slice(0, 7))).size,
    from: vOpen.length ? monthStart(vOpen[0].date) : "", to: vOpen.length ? monthEnd(vOpen[vOpen.length - 1].date) : "",
    unappliedCredit: voucherLeft,
    monthlyShareObserved: monthsSeen.length ? hapByMonth.get(monthsSeen[monthsSeen.length - 1]) : 0,
  };

  // RECONCILIATION GATE. The split of each month's rent is INFERRED from
  // what the authority remitted. When that inference is wrong, one queue
  // ends with money left over while the other still has charges open, and
  // the two no longer add back to the real balance. (On one real tenancy it
  // produced a tenant claim of $0 against a true balance near $6,000.)
  const tenantOpenAll = money(out.total + out.notClaimed.amount);
  const splitTotal = money(tenantOpenAll + out.voucherSide.owedByAuthority);
  const expected = opts.ledgerBalance !== undefined && opts.ledgerBalance !== null ? money(opts.ledgerBalance) : balance;
  out.drift = money(splitTotal - Math.max(expected, 0));
  out.reconciles = Math.abs(out.drift) < 0.01;
  if (!out.reconciles && splitTotal > 0) {
    out.unreliable = true;
    out.blockedReason = "The split between the tenant and the housing authority does not add up: tenant "
      + tenantOpenAll.toFixed(2) + " + authority " + out.voucherSide.owedByAuthority.toFixed(2) + " = " + splitTotal.toFixed(2)
      + ", but the ledger balance is " + expected.toFixed(2) + ". The tenant's own share for each month is not recorded, so it cannot be worked out from the ledger alone.";
    out.needed = ["the tenant's monthly share of the rent, with the date each change took effect", "whether a month with no housing-authority payment was skipped, or the contract ended"];
  } else out.reconciles = true;
  return out;
}

/**
 * Late fees that look higher than the cap. Maryland: 5% of the rent due for
 * the period [LAW]. Returns the open late-fee charges over the cap.
 */
export function lateFeesOverCap(open, monthlyRent, capPct = 5) {
  const cap = money((Number(monthlyRent) || 0) * capPct / 100);
  if (!(cap > 0)) return [];
  return (open || []).filter(c => c.category === "late_fee" && money(c.charged) > cap + 0.005).map(c => ({ ...c, cap }));
}

/** A person's own figures, when the ledger cannot give them (a voucher split that does not reconcile). */
export function manualClaim({ rent = 0, rentFrom = "", rentTo = "", lateFees = 0, feesFrom = "", feesTo = "" } = {}) {
  const r = money(rent), f = money(lateFees);
  const errors = [];
  if (r < 0 || f < 0) errors.push("Amounts cannot be negative.");
  if (r > 0 && (!isIso(rentFrom) || !isIso(rentTo))) errors.push("Enter the period the unpaid rent covers.");
  if (r > 0 && isIso(rentFrom) && isIso(rentTo) && rentTo < rentFrom) errors.push("The rent period ends before it starts.");
  if (f > 0 && (!isIso(feesFrom) || !isIso(feesTo))) errors.push("Enter the period the late fees cover.");
  if (f > 0 && isIso(feesFrom) && isIso(feesTo) && feesTo < feesFrom) errors.push("The late-fee period ends before it starts.");
  if (r + f <= 0) errors.push("Nothing is claimed.");
  return {
    ok: errors.length === 0, errors,
    claim: { rent: { amount: r, from: r > 0 ? rentFrom : "", to: r > 0 ? rentTo : "", months: 0 }, lateFees: { amount: f, from: f > 0 ? feesFrom : "", to: f > 0 ? feesTo : "", months: 0 }, notClaimed: { amount: 0, count: 0 }, total: money(r + f), open: [], manual: true, reconciles: true },
  };
}
