#!/usr/bin/env node
/**
 * FIFO arrears allocation for the Maryland DC-CV-115 (Failure to Pay Rent),
 * with correct treatment of voucher ("county") tenancies.
 *
 * WHY FIFO. The form asks for past-due RENT over a period, LATE FEES over a
 * period, and a total. A single balance figure cannot answer that: it says
 * how much is owed, not which months are open or how much is rent rather
 * than fees. Payments are therefore applied oldest-charge-first -- which is
 * also how a tenant's money is actually credited -- and what remains
 * unallocated IS the claim, with the periods falling out of which charges
 * are still open. Newest-first would understate how long the tenant has
 * been behind while overstating the recent period.
 *
 * WHY VOUCHER TENANCIES ARE SPLIT. On a Section 8 / HAP tenancy the rent is
 * paid from two sources: the housing authority pays its share and the tenant
 * pays theirs. A landlord cannot sue the TENANT for the authority's share --
 * so a DC-CV-115 that claims the whole arrears on a voucher tenancy claims
 * money that person does not owe. The rent charge is split per month and two
 * independent FIFO queues are run; only the tenant's queue reaches the form.
 *
 * WHERE THE SPLIT COMES FROM. The monthly voucher share is taken from the
 * HAP payment actually received for that month, not from a configured
 * "tenant portion" field. Checked against Joyce Epps: the workbook says
 * voucher 3,813 / tenant 206, while the ledger shows HAP 3,578 and the
 * tenant paying 406. The ledger is what happened; the workbook is stale, and
 * a court filing should rest on the former. When a month has no HAP payment
 * the last known HAP amount is carried forward, so a month the authority has
 * not yet paid does not silently become the tenant's debt.
 */
const money = n => Math.round(Number(n) * 100) / 100;
const isFee = s => /late|fee/i.test(String(s));

// A HAP/voucher remittance, as opposed to money from the tenant. These are
// bulk authority payments -- "HAPGC", "HAP CONTRACT", housing assistance.
const isVoucherPayment = s => /\bhap\b|hapgc|housing assistance|voucher|section ?8|hcv\b/i.test(String(s));

function monthKey(d) { return String(d).slice(0, 7); }

/**
 * entries: [{ kind: "charge"|"payment", date: "YYYY-MM-DD", amount, label }]
 * opts.voucher: true to split the rent charges between authority and tenant
 */
function fifoArrears(entries, opts = {}) {
  const rank = l => (isFee(l) ? 1 : 0);
  const charges = entries.filter(e => e.kind === "charge")
    .sort((a, b) => a.date.localeCompare(b.date) || rank(a.label) - rank(b.label));
  const payments = entries.filter(e => e.kind === "payment")
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!opts.voucher) {
    const q = charges.map(c => ({ ...c, open: money(c.amount) }));
    let credit = payments.reduce((s, p) => money(s + Number(p.amount)), 0);
    for (const c of q) { if (credit <= 0) break; const a = Math.min(credit, c.open); c.open = money(c.open - a); credit = money(credit - a); }
    return summarise(q, credit, { voucher: false });
  }

  // ---- voucher tenancy -------------------------------------------------
  // What the authority paid, by month. This is the observed voucher share.
  const hapByMonth = new Map();
  for (const p of payments) {
    if (!isVoucherPayment(p.label)) continue;
    const k = monthKey(p.date);
    hapByMonth.set(k, money((hapByMonth.get(k) || 0) + Number(p.amount)));
  }
  // carry the last known amount forward for months the authority has not paid
  const monthsSeen = [...hapByMonth.keys()].sort();
  const zeroHapMonths = [...hapByMonth.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const hapFor = (k) => {
    if (hapByMonth.has(k)) return hapByMonth.get(k);
    const prior = monthsSeen.filter(m => m < k);
    return prior.length ? hapByMonth.get(prior[prior.length - 1]) : 0;
  };

  // split each RENT charge; fees are the tenant's in full
  const tenantQ = [], voucherQ = [];
  for (const c of charges) {
    if (isFee(c.label)) { tenantQ.push({ ...c, open: money(c.amount), share: "tenant" }); continue; }
    const expectHap = Math.min(hapFor(monthKey(c.date)), Number(c.amount));
    const tenantShare = money(Number(c.amount) - expectHap);
    if (expectHap > 0) voucherQ.push({ ...c, amount: expectHap, open: expectHap, share: "voucher" });
    if (tenantShare > 0) tenantQ.push({ ...c, amount: tenantShare, open: tenantShare, share: "tenant" });
  }

  // two independent queues, each settled only by its own source of money
  const run = (queue, pays) => {
    let credit = pays.reduce((s, p) => money(s + Number(p.amount)), 0);
    for (const c of queue) { if (credit <= 0) break; const a = Math.min(credit, c.open); c.open = money(c.open - a); credit = money(credit - a); }
    return credit;
  };
  const tenantCredit  = run(tenantQ,  payments.filter(p => !isVoucherPayment(p.label)));
  const voucherCredit = run(voucherQ, payments.filter(p =>  isVoucherPayment(p.label)));

  const out = summarise(tenantQ, tenantCredit, { voucher: true });

  const vOpen = voucherQ.filter(c => c.open > 0.004);
  out.voucherSide = {
    owedByAuthority: money(vOpen.reduce((s, c) => s + c.open, 0)),
    months: vOpen.length,
    from: vOpen.length ? vOpen[0].date : null,
    to: vOpen.length ? vOpen[vOpen.length - 1].date : null,
    unappliedCredit: voucherCredit,
    monthlyShareObserved: monthsSeen.length ? hapByMonth.get(monthsSeen[monthsSeen.length - 1]) : 0,
    // months the authority remitted 0 -- ambiguous, and a common cause of a
    // split that will not reconcile
    zeroHapMonths,
  };
  // RECONCILIATION GATE.
  //
  // The split of each month's rent between authority and tenant is INFERRED
  // from what the authority actually remitted. That inference can be wrong,
  // and when it is, the two queues do not add back to the real arrears. On
  // Jacinda Proctor it produced a tenant claim of $0 and an authority share
  // of $9,040 against a true balance of $5,978.28 -- $3,062 out -- because
  // her own payments (totalling $20,535) far exceeded the portion inferred
  // for her, so the tenant queue over-settled while the authority queue
  // under-settled. Three $0.00 HAPGC entries made it worse: they are
  // ambiguous between "the authority paid nothing this month" and "the
  // contract ended and full rent is now the tenant's", which are opposite
  // conclusions about what this person owes.
  //
  // A number that does not reconcile must not reach a court filing. So the
  // split is reported as UNRELIABLE and the caller is told what is missing,
  // rather than handed a figure that merely looks right.
  const splitTotal = money(out.total + out.voucherSide.owedByAuthority);
  const expected = money(opts.ledgerBalance != null ? opts.ledgerBalance : splitTotal);
  const drift = money(splitTotal - expected);
  out.reconciles = Math.abs(drift) < 0.01;
  out.drift = drift;
  if (!out.reconciles) {
    out.unreliable = true;
    out.blockedReason =
      `Voucher split does not reconcile: tenant ${out.total.toFixed(2)} + authority ` +
      `${out.voucherSide.owedByAuthority.toFixed(2)} = ${splitTotal.toFixed(2)}, but the ledger ` +
      `balance is ${expected.toFixed(2)} (out by ${drift.toFixed(2)}). The tenant's portion per ` +
      `period is not recorded, so it cannot be apportioned from the ledger alone.`;
    out.needed = [
      "the tenant's monthly portion, with the date each change took effect",
      "whether a $0.00 HAP entry means the authority skipped that month, or the contract ended",
    ];
  }

  return out;
}

function summarise(queue, credit, meta) {
  const unpaid = queue.filter(c => c.open > 0.004);
  const rentUnpaid = unpaid.filter(c => !isFee(c.label));
  const feeUnpaid = unpaid.filter(c => isFee(c.label));
  const span = l => l.length ? { from: l[0].date, to: l[l.length - 1].date, months: l.length } : { from: null, to: null, months: 0 };
  return {
    voucherTenancy: !!meta.voucher,
    rent: { amount: money(rentUnpaid.reduce((s, c) => s + c.open, 0)), ...span(rentUnpaid) },
    lateFees: { amount: money(feeUnpaid.reduce((s, c) => s + c.open, 0)), ...span(feeUnpaid) },
    total: money(unpaid.reduce((s, c) => s + c.open, 0)),
    creditLeft: credit,
    unpaidDetail: unpaid.map(c => ({ date: c.date, label: c.label, share: c.share || "tenant", charged: c.amount, stillOpen: c.open })),
  };
}

module.exports = { fifoArrears, isVoucherPayment, money };
