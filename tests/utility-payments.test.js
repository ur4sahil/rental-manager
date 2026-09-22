// The utility payment path, end to end.
//
// The machinery existed but nothing joined it up: the app's button wrote to
// automation_jobs, which nothing reads, while pay-runner.js reads
// utility_payments, which the app never wrote. And the button posted a
// journal entry -- DR 5400, CR 1000 Checking, dated today, full billed
// amount -- so the books recorded a payment out of an account nobody chose,
// for money that never moved.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}
const read = f => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const utilities = read("src/components/Utilities.js");
const helpers   = read("src/utils/helpers.js");
const ai        = read("api/ai.js");
const runner    = read("worker/portals/pay-runner.js");
const payBill   = read("worker/portals/pay-bill.js");
const { payablePortals, PLAYBOOKS } = require("../worker/portals/playbooks.js");

console.log("\n=== UTILITY PAYMENTS, END TO END ===\n");

// ---- 1. the button no longer fakes a payment --------------------------
assert("the Pay button posts NO journal entry",
  !/autoPostJournalEntry\(\{[^}]*Utility payment/s.test(utilities)
  && !/account_name: "Utilities Expense"/.test(utilities),
  "the old handler booked DR 5400 / CR 1000 for money that never moved");

assert("nothing queues into automation_jobs for payment any more",
  !/job_type: "pay_bill"/.test(utilities),
  "pay_bill jobs were written to a table nothing has ever read");

assert("the button writes an APPROVED utility_payments row",
  /from\("utility_payments"\)\s*\.insert/.test(utilities)
  && /status: "approved"/.test(utilities)
  && /approved_by: userProfile\?\.email/.test(utilities),
  "claim_utility_payment refuses a payment with nobody named against it");

assert("the button carries bill_id, so the payment can settle its own bill",
  /bill_id: bill\.bill_id \|\| bill\.id/.test(utilities));

assert("releasing a payment asks first, and names the amount",
  /await showConfirm\(\{[\s\S]{0,400}variant: "danger"/.test(utilities)
  && /confirmText: `Pay \$\{formatCurrency\(amount\)\}`|confirmText: `Pay \${formatCurrency\(amount\)}`/.test(utilities),
  "an irreversible payment should not be one stray click");

// ---- 2. payability has ONE source of truth ---------------------------
// helpers.js carries a copy because the browser bundle must not reach into
// worker/. This test is what keeps the copy honest.
const uiPortals = [...helpers.matchAll(/portal: "([a-z_]+)"/g)].map(m => m[1]).sort();
const workerPortals = payablePortals().map(p => p.portal).sort();
assert("the app's payable list matches the worker's playbooks exactly",
  JSON.stringify(uiPortals) === JSON.stringify(workerPortals),
  `app: ${JSON.stringify(uiPortals)}\n   worker: ${JSON.stringify(workerPortals)}`);

for (const p of payablePortals()) {
  const uiAliases = helpers.slice(helpers.indexOf(`portal: "${p.portal}"`));
  assert(`${p.portal}: the app knows every alias the worker knows`,
    p.aliases.every(a => uiAliases.includes(`"${a}"`)),
    "production says 'Washington Gas', 'Wash Gas' and 'WGL' for one company");
}

assert("pay-bill.js takes its recipes from playbooks.js, not its own copy",
  /require\("\.\/playbooks"\)/.test(payBill) && !/^const PORTALS = \{\s*$/m.test(payBill),
  "a second list drifts, and it drifts into a button that cannot pay");

assert("a portal with a read recipe but no pay recipe is NOT payable",
  Object.keys(PLAYBOOKS).length > payablePortals().length,
  "BGE, Pepco and WSSC can be read but not paid — they must not offer a Pay button");

// Assert the GUARD CHAIN, not whatever element happens to follow it. This
// previously required `... && <Btn`, so wrapping both the full and part-pay
// controls in a fragment broke the test while the behaviour was unchanged.
const payControls = utilities.slice(
  utilities.indexOf('["pending_review", "partial"].includes(bill.status)'),
  utilities.indexOf('Pay part') + 200);
assert("the pay controls sit behind status, responsibility AND payability",
  /\["pending_review", "partial"\]\.includes\(bill\.status\)/.test(payControls)
  && /bill\.responsibility !== "tenant"/.test(payControls)
  && /payablePortalFor\(bill\.provider_display \|\| bill\.provider\)/.test(payControls),
  "any one of the three missing offers a payment that cannot or should not happen");
assert("BOTH the full and part-pay controls are behind that same guard",
  /Pay this bill<\/Btn>/.test(payControls) && /Pay part<\/TextLink>/.test(payControls),
  "a part-pay link outside the guard is a way to pay a tenant's bill");

// ---- 3. money only reaches the books once it is CONFIRMED ------------
assert("only a confirmed payment touches the bill",
  /if \(status === "paid"\) \{\s*await recordPayment/.test(runner),
  "'unknown' must leave the bill alone — marking it paid on a guess double-pays next month");

assert("an unknown outcome is reported, not retried",
  /UNKNOWN[\s\S]{0,120}will not be retried/.test(runner));

assert("record-utility-payment posts no journal entry",
  !/autoPostJournalEntry|acct_journal/.test(
    ai.slice(ai.indexOf('action === "record-utility-payment"'),
             ai.indexOf('action === "sweep-targets"'))),
  "the debit arrives through the bank feed; booking it here too shows it twice");

const rec = ai.slice(ai.indexOf('action === "record-utility-payment"'),
                     ai.indexOf('action === "sweep-targets"'));
assert("the approved amount, not the worker's claim, is the authority",
  /Math\.abs\(Number\(pay\.approved_amount\) - amt\) > 0\.005/.test(rec),
  "otherwise a bug could settle a bill for a figure nobody approved");
assert("a payment cannot settle a bill it does not belong to",
  /String\(pay\.bill_id\) !== String\(billId\)/.test(rec));
assert("re-recording an already-paid bill changes nothing",
  /\["paid", "settled"\]\.includes\(bill\.status\)/.test(rec),
  "a worker retrying after a dropped response must not file a second receipt");

// ---- 3b. THE TENANT'S BILL IS NOT OURS TO PAY ------------------------
// Three layers, because the app is one of four ways a row could reach
// utility_payments and the only unbypassable place is the database.
assert("the Pay button is hidden on a tenant-responsibility bill",
  /bill\.responsibility !== "tenant"[\s\S]{0,120}payablePortalFor/.test(utilities),
  "layer 1: it should not be offered");

assert("the handler refuses a tenant bill even if reached another way",
  /if \(bill\.responsibility === "tenant"\) \{/.test(utilities)
  && /not ours to pay/.test(utilities),
  "layer 2: no cancelled row for something never legitimate to ask for");

assert("the worker refuses before the browser opens",
  /if \(responsibility === "tenant"\) \{/.test(runner)
  && /status: "cancelled"/.test(runner),
  "layer 3");

assert("the worker falls back to the ACCOUNT when the bill does not say",
  /if \(!responsibility && bill\?\.utility_account_id\)/.test(runner),
  "responsibility can be set on either row");

assert("the sweep does not even read a tenant's utility",
  /responsibility\.not\.in\.\(tenant,condo_fee\)/.test(ai),
  "logging into a portal for a statement we cannot act on is work with no outcome");

// ---- 4. the statement and the receipt are FILED, not just uploaded ---
assert("attach-bill-document files the statement as a document",
  /fileUtilityDocument\(sb, \{[\s\S]{0,200}type: "Utility Bill"/.test(ai),
  "setting pdf_storage_path alone left the PDFs invisible outside one column");

assert("the receipt is filed as a document too",
  /type: "Utility Receipt"/.test(ai));

assert("filed documents store the STORAGE PATH in both file_name and url",
  /file_name: path,\s*\n\s*url: path,/.test(ai),
  'getSignedUrl reads (file_name || url) — a bare filename breaks every View link');

assert("Utility Bill and Utility Receipt are real document types",
  /value: "Utility Bill"/.test(helpers) && /value: "Utility Receipt"/.test(helpers),
  "DOC_TYPES drives the Documents filter — a type not listed is a folder nobody can open");

assert("statements are not tenant-visible by default",
  /tenant_visible: false/.test(ai),
  "a statement carries the owner's account number and usage history");

assert("pay-bill.js captures a receipt PDF before parsing anything",
  /await page\.pdf\(\{ path: receipt/.test(payBill)
  && payBill.indexOf("await page.pdf({ path: receipt") < payBill.indexOf("const conf = body.match"),
  "a parse failure must not cost the receipt");

assert("filing a document never fails the call that saved the file",
  /Never throws[\s\S]{0,400}async function fileUtilityDocument/.test(ai),
  "the file is already saved; losing the upload over its index row is worse");

// ---- 5. the queue the button feeds ----------------------------------
assert("the runner can drain the approved queue",
  /--queue/.test(runner) && /\.eq\("status", "approved"\)/.test(runner));
assert("the queue is dry-run unless --live is passed",
  /drainQueue\(process\.argv\.includes\("--live"\)\)/.test(runner));
assert("payments run one at a time",
  /One at a time, on purpose/.test(runner),
  "a shared browser session is what gets confused about which account is selected");
assert("a bill with no account number is refused, not guessed at",
  /no account number/.test(runner),
  "the portal is asserted against the account number before anything is filled");

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
