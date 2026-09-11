// Static check on the bank selection bar.
//
// NOT a browser test, deliberately, and worth knowing why: the sandbox
// company has zero bank_account_feed and zero bank_connection rows, so
// the Bank Transactions page renders an empty state and there is nothing
// to select. Seeding a usable feed means a bank_connection with Teller
// fields, which is a bigger fixture than this check is worth. So this
// asserts the controls exist in the source; it does NOT prove they
// render or that a bulk apply posts correctly. That needs a seeded feed.
import fs from "fs";
import path from "path";
const src = fs.readFileSync(path.join(import.meta.dirname, "../src/components/Banking.js"), "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("  \u274c", m)); };

// The bar's six controls.
ok(/Category \/ account/.test(src), "account picker label present");
ok(/Tenant \/ vendor/.test(src), "tenant/vendor picker present");
ok(/Property \/ class/.test(src), "property/class picker present");
ok(/"Re-categorise" : "Categorise"\} \$\{selectedTxns\.size\}/.test(src),
   "the action button names the operation and the count");
ok(/Exclude reason/.test(src), "exclude reason picker present");
ok(/Internal transfer/.test(src) && /already_recorded/.test(src), "reasons beyond duplicate offered");

// Guards that matter.
ok(/disabled=\{!bulkForm\.accountId \|\| !!bulkBusy\}/.test(src),
   "categorise is disabled until an account is chosen");
ok(/bulkApply\(/.test(src), "bulkApply is actually called from the UI");
ok(!/bulkExclude\("duplicate"\)/.test(src), "the hardcoded duplicate reason is gone");

// Class and entity must reach acceptTransaction, which always accepted
// them -- the old bulk path passed empty strings and dropped them.
ok(/acceptTransaction\(txn, accountId, accountName, "", classId \|\| "", entityType \|\| "", entityId \|\| "", entityName \|\| ""\)/.test(src),
   "bulk apply forwards class and entity to acceptTransaction");

// Sequential, not concurrent: each accept posts a journal entry.
ok(!/Promise\.all\(selected/.test(src), "bulk apply does not fire posts concurrently");

// Partial failure has to be reported, not swallowed.
ok(/failed\.length === 0/.test(src) && /still in For Review/.test(src),
   "a partial failure is reported rather than finishing silently");

// The id-type bug: select values are strings, tenants.id is a number.
ok(!/tenants\.find\(t => t\.id === id\)/.test(src),
   "tenant lookup no longer compares a string id with === against a number");

// --- amend posted entries in place ---------------------------------
ok(/async function bulkAmend/.test(src), "bulkAmend exists");
ok(/activeTab === "categorized" \? bulkAmend\(bulkForm\)/.test(src),
   "the Categorised tab calls bulkAmend, not bulkApply");
ok(/activeTab === "for_review" \|\| activeTab === "categorized"/.test(src),
   "selection is enabled on the Categorised tab");

// Only the CATEGORY leg may be rewritten. Touching the bank leg would
// move money between bank accounts instead of recategorising.
ok(/categoryLegs = \(lines \|\| \[\]\)\.filter\(l => l\.account_id !== \(feed && feed\.gl_account_id\)\)/.test(src),
   "the bank leg is excluded by the feed's gl_account_id");
ok(/categoryLegs\.length !== 1/.test(src),
   "a split is skipped rather than half-amended into an unbalanced entry");

// Amounts must never change: this reclassifies a figure, it does not
// restate it. The update sets only account/class/entity fields.
ok(!/\.update\(\{[^}]*debit/.test(src.slice(src.indexOf("async function bulkAmend"), src.indexOf("async function bulkExclude"))),
   "the amend never writes debit or credit");

ok(/checkPeriodLock\(companyId, txn\.posted_date\)/.test(src.slice(src.indexOf("async function bulkAmend"))),
   "a locked period is respected");
ok(/no journal entry/.test(src), "a transaction with no journal entry is skipped, not guessed at");
ok(/Re-categorised bank txn/.test(src) && /gl_account_name \|\| "\?"\} \u2192/.test(src),
   "the audit entry records the OLD category as well as the new one");

console.log(`\n\u2705 Passed: ${pass}\n\u274c Failed: ${fail}`);
process.exit(fail ? 1 : 0);
