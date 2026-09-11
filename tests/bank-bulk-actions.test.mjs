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
ok(/Categorise \$\{selectedTxns\.size\}|Categorise \$/.test(src), "categorise button present");
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

console.log(`\n\u2705 Passed: ${pass}\n\u274c Failed: ${fail}`);
process.exit(fail ? 1 : 0);
