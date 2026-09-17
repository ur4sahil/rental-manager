// The Utilities module, after the teardown of 2026-09-17.
//
// It was two half-built modules stacked on each other. "Manual Bills" read
// the flat `utilities` table -- one amount per ACCOUNT, overwritten by every
// sweep -- while "Automation" was built against utility_accounts /
// utility_bills, which were properly designed and completely empty because
// nothing ever populated them.
//
// These assertions guard the things that were actually broken, not the
// things that are easy to check.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

const SRC = path.join(__dirname, "..", "src");
const util = fs.readFileSync(path.join(SRC, "components", "Utilities.js"), "utf8");

console.log("\n=== UTILITIES · BILLS ===\n");

// ---- 1. the journal reference must be per BILL ---------------------------
// This is the defect that mattered most, because it lost money silently.
// The old code posted `UTIL-${u.id}` -- the ACCOUNT id -- against a unique
// index on (company_id, reference). So the first payment on an account
// posted and every payment after it was rejected. Production held ZERO
// journal entries beginning UTIL- while an account sat marked paid.
assert("the journal reference is built from the bill, not the account",
  /reference: `UTIL-\$\{bill\.bill_id\}`/.test(util),
  "UTIL-<account id> collides on the second payment — (company_id, reference) is unique");

assert("nothing references a utility by its account id any more",
  !/UTIL-\$\{u\.id\}/.test(util) && !/"UTIL-" \+ u\.id/.test(util),
  "the old per-account reference is back");

// ---- 2. the paying account is chosen, not assumed ------------------------
// Every utility payment was hardcoded to credit 1000 Checking, whatever
// actually paid it.
assert("the payment credits the account the user picked",
  /account_id: payForm\.bank_account_id/.test(util),
  "a hardcoded 1000 credits Checking for a bill paid on a card");

assert("there is a way to pick it",
  /loadBankAccounts/.test(util) && /bankAccounts\.map/.test(util),
  "choosing is only real if the list is offered");

// ---- 3. a tenant's bill becomes the tenant's debt ------------------------
// utilities.responsibility has always held 'tenant' or 'owner' and nothing
// ever acted on it, so a bill the tenant owed was booked as owner expense
// and the tenant was never charged.
assert("a tenant-responsible bill can be charged back",
  /getOrCreateTenantAR\(companyId, tenant\.name, tenant\.id\)/.test(util),
  "the receivable must be the tenant's own AR sub-account, not the 1100 parent");

assert("recharge defaults ON for a tenant-responsible bill",
  /recharge: u\.responsibility === "tenant"/.test(util),
  "defaulting it off quietly turns every tenant's bill into an owner expense");

assert("it refuses to guess which tenant",
  /ts\.length > 1/.test(util) && /active tenants at/.test(util),
  "two tenants at one address and the wrong one gets the debt");

// ---- 4. the page reads bills ---------------------------------------------
assert("the list is built from utility_bills",
  /from\("utility_bills"\)/.test(util),
  "reading `utilities` gives one amount per account and no history");

assert("a bill's own status drives the row, not the account's",
  /BILL_STATUS\[u\.status\]/.test(util),
  "'Paid or Ignore' was everything one status column on an account could say");

assert("history is per account and ordered by statement",
  /function historyFor\(accountId\)/.test(util) && /statement_period/.test(util),
  "sorting history by read time makes a late re-read of an old statement look current");

// ---- 5. what actually left the bank -------------------------------------
assert("the amount paid is recorded separately from the amount billed",
  /amount_paid: amt/.test(util),
  "a part payment recorded as the billed figure is how the books and the statement diverge");

assert("the amount is editable at payment time",
  /setPayForm\(f => \(\{ \.\.\.f, amount: e\.target\.value \}\)\)/.test(util),
  "if it cannot be changed, amount_paid can never differ from amount");

// ---- 6. failure must not look like success -------------------------------
// The money and the journal entry are real even when the bill row fails to
// update. Reporting that as a plain error, with the JE already posted, is
// the honest outcome.
assert("a failed status write says the entry posted anyway",
  /journal entry posted but the bill could not be marked paid/.test(util),
  "letting it look unpaid invites a second payment");

assert("a failed journal entry abandons the whole thing",
  /The payment was not recorded — the journal entry could not post/.test(util),
  "marking a bill paid with no entry behind it is a silent hole in the books");

// ---- 7. the old broken path is gone, not merely unused -------------------
assert("approvePay has been removed",
  !/async function approvePay/.test(util),
  "two ways to pay a bill, one of which cannot post twice, is worse than one");

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
