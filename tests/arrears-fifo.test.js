// FIFO arrears for the Maryland DC-CV-115, including voucher ("county")
// tenancies. These are adversarial: the point is to catch a wrong number
// before it reaches a court filing, not to confirm the code runs.

const { fifoArrears } = require("../scripts/court-forms/arrears-fifo");
let passed = 0, failed = 0;
const assert = (name, cond, detail) => {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else { failed++; console.log("  ❌ " + name + (detail ? "\n       " + detail : "")); }
};
const C = (date, amount, label = "Rent") => ({ kind: "charge", date, amount, label });
const P = (date, amount, label = "Zelle from tenant") => ({ kind: "payment", date, amount, label });
const HAP = (date, amount) => ({ kind: "payment", date, amount, label: "Journal Entry #1 HAPGC" });

console.log("\n=== FIFO: payments settle the OLDEST charge first ===");
{
  const a = fifoArrears([C("2026-01-01", 1000), C("2026-02-01", 1000), C("2026-03-01", 1000), P("2026-03-05", 1000)]);
  assert("one payment clears January, not March",
    a.rent.from === "2026-02-01" && a.rent.to === "2026-03-01" && a.rent.amount === 2000,
    `got ${a.rent.amount} over ${a.rent.from}..${a.rent.to} — newest-first would understate how long they are behind`);
}
{
  // a partial payment must leave the oldest month PARTLY open, not skip it
  const a = fifoArrears([C("2026-01-01", 1000), C("2026-02-01", 1000), P("2026-02-05", 400)]);
  assert("a partial payment leaves the oldest month partly open",
    a.rent.amount === 1600 && a.rent.from === "2026-01-01",
    `got ${a.rent.amount} from ${a.rent.from}`);
}
{
  const a = fifoArrears([C("2026-01-01", 1000), P("2026-01-02", 1500)]);
  assert("overpayment leaves nothing due and reports the credit",
    a.total === 0 && a.creditLeft === 500, `total ${a.total}, credit ${a.creditLeft}`);
}

console.log("\n=== rent and late fees are reported separately ===");
{
  const a = fifoArrears([C("2026-01-01", 1000), C("2026-01-06", 100, "Late Fees"),
                         C("2026-02-01", 1000), C("2026-02-06", 100, "Late Fees")]);
  assert("rent and fees split into their own lines and periods",
    a.rent.amount === 2000 && a.lateFees.amount === 200 && a.lateFees.months === 2,
    `rent ${a.rent.amount}, fees ${a.lateFees.amount}`);
  assert("total is rent plus fees", a.total === 2200);
}
{
  // a payment must not skip a fee to reach rent
  const a = fifoArrears([C("2026-01-01", 1000), C("2026-01-06", 100, "Late Fee"), P("2026-02-01", 1050)]);
  assert("a payment consumes the fee too, in date order",
    a.total === 50, `expected 50 left, got ${a.total}`);
}

console.log("\n=== voucher tenancy: only the TENANT's share is claimable ===");
{
  // clean case: HAP pays 900 of 1000 every month, tenant owes 100
  const e = [];
  for (const m of ["01","02","03"]) { e.push(C(`2026-${m}-01`, 1000)); e.push(HAP(`2026-${m}-02`, 900)); }
  e.push(P("2026-01-03", 100));            // tenant pays only January
  const a = fifoArrears(e, { voucher: true, ledgerBalance: 200 });
  assert("claims only the tenant's unpaid portion, not the whole arrears",
    a.rent.amount === 200,
    `got ${a.rent.amount} — claiming the authority's share would demand money this person does not owe`);
  assert("the authority's side is accounted for separately",
    a.voucherSide.owedByAuthority === 0, `authority ${a.voucherSide.owedByAuthority}`);
  assert("and it reconciles to the ledger balance", a.reconciles === true, a.blockedReason || "");
}

console.log("\n=== the gate: an unreliable split must NOT produce form numbers ===");
{
  // Jacinda Proctor's shape: portion changed over time and HAP went to zero
  const e = [];
  for (const m of ["01","02","03","04","05"]) { e.push(C(`2026-${m}-01`, 3289)); e.push(HAP(`2026-${m}-02`, 3127)); e.push(P(`2026-${m}-03`, 162)); }
  for (const m of ["06","07"]) { e.push(C(`2026-${m}-01`, 3289)); e.push(HAP(`2026-${m}-02`, 0)); e.push(P(`2026-${m}-03`, 295)); }
  // This synthetic shape happens to reconcile, which is itself worth knowing:
  // the inference is not always wrong. The gate exists for when it IS.
  const ok = fifoArrears(e, { voucher: true, ledgerBalance: 5988 });
  assert("a split that DOES tie to the ledger is allowed through",
    ok.reconciles === true && !ok.unreliable, ok.blockedReason || `drift ${ok.drift}`);

  // The real failure, in the shape it actually took: the ledger says one
  // thing and the inferred split says another. On Jacinda Proctor the split
  // came to 9,040 against a true balance of 5,978.28.
  const bad = fifoArrears(e, { voucher: true, ledgerBalance: 5978.28 });
  assert("a split that does NOT tie to the ledger is flagged unreliable",
    bad.unreliable === true,
    "a figure that does not tie to the ledger must never reach a filing");
  assert("...and it says what is missing", Array.isArray(bad.needed) && bad.needed.length >= 2);
  assert("...and reports the drift", typeof bad.drift === "number" && Math.abs(bad.drift) > 0.005, `drift ${bad.drift}`);
  assert("...and names the zero-HAP months as ambiguous",
    ok.voucherSide.zeroHapMonths.length === 2, JSON.stringify(ok.voucherSide.zeroHapMonths));
}

console.log("\n=== market-rate tenancies must always reconcile ===");
{
  // ANA PRECIADO's real shape
  const e = [C("2026-05-01", 2000), C("2026-06-01", 2000), C("2026-06-01", 100, "LATE FEES"),
             C("2026-07-01", 2000), C("2026-07-01", 100, "LATE FEES"),
             C("2026-08-01", 2000), C("2026-08-01", 100, "LATE FEES"),
             C("2026-09-01", 2000), C("2026-09-01", 100, "LATE FEES"),
             P("2026-05-04", 1092.02)];
  const a = fifoArrears(e);
  assert("rent and fees add to the total exactly",
    Math.abs(a.total - (a.rent.amount + a.lateFees.amount)) < 0.005,
    `${a.rent.amount} + ${a.lateFees.amount} != ${a.total}`);
  assert("no voucher side is invented for a market tenancy", a.voucherSide === undefined);
}

console.log(`\n${failed ? "❌" : "✅"} Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed ? 1 : 0);
