// Paying LESS than the amount due.
//
// The recipe selected "Amount Due" and aborted on any mismatch, so a partial
// payment was impossible. Supporting one means writing to a money field, and
// the failure modes are asymmetric: underpaying is a nuisance, overpaying or
// silently paying the full amount is money gone.
//
// These assert the rules written down before the code was:
//   R1 never pay more than approved  — type, then READ BACK
//   R2 never fall back to "Amount Due" if the custom control is missing
//   R3 a partial must not mark the bill paid
//   R4 the total may never exceed the bill  — enforced in SQL
//   R5 'unknown' still blocks everything after it
//   R6 the app refuses an amount above the bill up front
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const payBill = read("worker/portals/pay-bill.js");
const util    = read("src/components/Utilities.js");
const ai      = read("api/ai.js");
const { PLAYBOOKS } = require("../worker/portals/playbooks.js");

console.log("\n=== PARTIAL PAYMENTS ===\n");

// ---- R2: the one that must never happen ------------------------------
assert("R2 a missing custom-amount control ABORTS, never falls back",
  /if \(!picked\) \{[\s\S]{0,400}done\("blocked"/.test(payBill)
  && /refusing to submit, because the form is still set to the full amount due/.test(payBill),
  "falling back to Amount Due pays the WHOLE bill when a partial was approved");

assert("R2 the abort reports what it tried, so the label can be corrected",
  /tried: otherNames\.map\(String\)/.test(payBill));

// ---- R1: type, then read back ----------------------------------------
assert("R1 the typed amount is read back out of the field",
  /const after = \(await target\.inputValue\(\)/.test(payBill)
  && /Math\.abs\(typed - wantAmount\) > 0\.005/.test(payBill),
  "typing is not the same as having typed: a masked field can hold something else");

assert("R1 one place decides what is being submitted",
  /const submitting = Number\(String\(filled\.value\)/.test(payBill)
  && /the form holds \$\$\{submitting\} but/.test(payBill),
  "two sources for 'the amount' is how one of them goes stale");

// This guard read `shown`, removed by the rework -- a ReferenceError inside a
// try, swallowed, reported as a generic failure. A guard that crashes is a
// guard that does not run.
assert("R1 the vision cross-check compares against the submitted amount",
  /the field says \$\$\{submitting\.toFixed\(2\)\}/.test(payBill)
  && !/shown\.toFixed/.test(payBill),
  "it referenced a variable that no longer exists");

// ---- never pay more than the portal says is owed ---------------------
assert("paying more than the portal says is due aborts",
  /if \(wantAmount > due \+ 0\.005\)/.test(payBill)
  && /is MORE than the \$\$\{due\.toFixed\(2\)\} the portal says is due/.test(payBill));

assert("full vs partial is decided by the PORTAL's figure, not a flag",
  /const isPartial = wantAmount < due - 0\.005;/.test(payBill),
  "the page is the authority on what is owed");

// ---- the candidates are honestly labelled ----------------------------
const other = PLAYBOOKS.washington_gas.pay.otherAmountRadio;
assert("the other-amount candidates exist and are regexes",
  Array.isArray(other) && other.length > 0 && other.every(r => r instanceof RegExp));
assert("they are marked as unverified against the live form",
  /NOT verified against the live form/.test(read("worker/portals/playbooks.js")),
  "every other locator in that file was confirmed on a signed-in page; these were not");

// ---- R6 + R3: the app and the recorder -------------------------------
assert("R6 the app refuses an amount above the bill",
  /if \(amount > due \+ 0\.005\)/.test(util)
  && /That is more than the \$\{formatCurrency\(due\)\} owed/.test(util));

assert("R6 the app counts what is ALREADY committed before approving more",
  /\.in\("status", \["submitting", "paid", "unknown", "partial"\]\)/.test(util)
  && /would overpay it/.test(util));

assert("the confirmation says what will still be outstanding",
  /will still be outstanding afterwards, and the bill stays open/.test(util),
  "a part payment that reads like a full one is the whole risk");

assert("R3 a part payment sets 'partial', not 'paid'",
  /status: covered \? "paid" : "partial"/.test(ai)
  && /const covered = billTotal > 0 \? totalPaid >= billTotal - 0\.005 : true/.test(ai));

assert("R3 amount_paid accumulates rather than overwrites",
  /const already = Number\(bill\.amount_paid\) \|\| 0;/.test(ai)
  && /const totalPaid = Math\.round\(\(already \+ amt\) \* 100\) \/ 100;/.test(ai),
  "overwriting loses the first instalment");

assert("R3 a part-paid bill still accepts its next instalment",
  /'partial' is deliberately NOT here/.test(ai),
  "treating it as already-settled strands the remainder");

assert("the response reports what is left to pay",
  /remaining: billTotal > 0/.test(ai));

// ---- repeat partials must be distinguishable from a double-click -----
assert("the idempotency key includes what was already committed",
  /:after\$\{prior\.toFixed\(2\)\}/.test(util),
  "keyed on amount alone, a second $10 collides with the first and is refused");

// ---- the status vocabulary ------------------------------------------
assert("a part-paid bill shows as part paid, not settled",
  /partial:\s*\{ label: "Part paid"/.test(util));

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
