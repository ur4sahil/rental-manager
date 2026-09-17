// No query may quietly stop at 1000 rows.
//
// Supabase caps every PostgREST response at 1000 rows. PostgREST's own default
// is unlimited -- the cap is Supabase's, protecting a public HTTP endpoint from
// one request pulling a whole table. The cap is reasonable. What is not is how
// it is delivered: the SERVER says 206 Partial Content with
// "content-range: 0-999/16747", and supabase-js discards both. The caller gets
// { data: [1000 rows], error: null } and no way to tell.
//
// It produced four wrong numbers in a single day:
//
//   * a ledger's opening balance summed 1000 of 1516 lines -- 45,291.34
//     instead of 40,921.73;
//   * the balance sheet, sharing that query, disagreed with the ledger by
//     4,369.61 and nothing said which was right;
//   * a reconciliation verified 1000 of 2412 lines, flagged those 1000, and
//     recorded cleared_count 2412 -- asserting a closed period over a ledger
//     with 1412 lines still open;
//   * a .limit(5000) on a bank card reported a reconciled account as broken.
//
// src/supabase.js now turns a real truncation into a PM_TRUNCATED error, which
// is the runtime backstop. This file is the build-time one: the two failures
// that guard cannot catch are a .limit(n) large enough to LOOK like "get
// everything" while still being capped, and a fetch that would have been fine
// yesterday on a table that has since grown past 1000 rows.
//
// The table list is measured, not guessed. As of 2026-09-16, production holds:
//   acct_journal_lines 17,447 · acct_journal_entries 8,144
//   audit_trail 6,926 · ledger_entries 4,602
//   bank_feed_transaction 2,675 · error_log 1,617
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

const SRC = path.join(__dirname, "..", "src");
const API = path.join(__dirname, "..", "api");

// Tables that already exceed the cap, or will. A query against one of these
// without paging is a bug waiting for the table to grow into it.
const UNCAPPED_TABLES = [
  "acct_journal_lines", "acct_journal_entries", "bank_feed_transaction",
  "ledger_entries", "audit_trail", "error_log", "documents", "payments",
  "notification_queue", "ai_jobs",
];

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (f.endsWith(".js") && !f.endsWith(".test.js")) out.push(p);
  }
  return out;
}
const files = [...walk(SRC), ...(fs.existsSync(API) ? walk(API) : [])];

console.log("\n=== ROW CAP ===\n");

// ---- 1. a .limit() above the cap is a lie ---------------------------------
// .limit(5000) reads as "give me up to five thousand" and returns one
// thousand, silently. Whoever wrote it believed the cap did not apply.
const overLimit = [];
for (const file of files) {
  // Strip comments first. Two of the three original hits were prose ABOUT
  // the cap -- "// .limit(20000) is a client-side hint and does NOT raise..."
  // -- so the rule was flagging the very comments that explain it.
  const src = fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  for (const m of src.matchAll(/\.limit\(\s*(\d+)\s*\)/g)) {
    if (Number(m[1]) > 1000) {
      const line = src.slice(0, m.index).split("\n").length;
      overLimit.push(`${path.relative(path.join(__dirname, ".."), file)}:${line} — .limit(${m[1]})`);
    }
  }
}
assert(
  "no query asks for more than 1000 rows in one request",
  overLimit.length === 0,
  overLimit.join("\n   ") + "\n   Above 1000 the server silently returns 1000. Page it (fetchAllPaged) instead."
);

// ---- 2. big tables must be paged, bounded, or aggregated ------------------
// A select on a table over the cap has to say how it handles the cap: a
// deliberate .limit() that stays under it, a .range(), .single()/.maybeSingle(),
// a head/count, or fetchAllPaged. Anything else is an unbounded read whose
// correctness depends on the table staying small, which is not a property any
// growing table has.
const unbounded = [];
for (const file of files) {
  const rel = path.relative(path.join(__dirname, ".."), file);
  if (rel.endsWith("src/supabase.js")) continue;          // the guard itself
  const src = fs.readFileSync(file, "utf8");
  for (const table of UNCAPPED_TABLES) {
    const re = new RegExp(`from\\("${table}"\\)([\\s\\S]{0,900}?)(?=\\n\\s*(?:if|const|let|return|await|\\}|//))`, "g");
    for (const m of src.matchAll(re)) {
      const chain = m[1];
      if (!/\.select\(/.test(chain)) continue;             // insert/update/delete
      // The chain stops at the first line starting with if/const/let/await,
      // which is exactly where a BUILDER-pattern query goes: `let q = from(...)`,
      // then conditional filters, then `await q.limit(200)` several lines
      // later. Payments.js was reported for nine days over a .limit(200) the
      // window could not reach. So when the query is assigned to a variable,
      // follow that variable forward too.
      const lookback = src.slice(Math.max(0, m.index - 160), m.index);
      const assignments = [...lookback.matchAll(/(?:const|let)\s+(\w+)\s*=/g)];
      const assigned = assignments.length ? assignments[assignments.length - 1][1] : null;
      const after = assigned
        ? src.slice(m.index, m.index + 1800).split(new RegExp(`\\b${assigned}\\b`)).slice(1).join(" ")
        : "";
      const bounded = /\.limit\(|\.range\(|\.single\(|\.maybeSingle\(|head:\s*true|count:\s*["']exact["']/.test(chain + " " + after)
        // A chunked .in() is bounded BY the chunk. .slice(i, i + n) in the
        // filter is the idiom, and it is bounded twice over: .in() is a URL
        // parameter, so the chunk is what keeps the request legal at all.
        || /\.in\([^)]*\.slice\(/.test(chain)
        // A query keyed to ONE parent row cannot return a thousand: a journal
        // entry has two lines, not two thousand, and one tenant does not have
        // a thousand payments -- that is a payment a month for eighty years.
        // Measured before being written down: payments holds 91 rows across
        // every company on the instance.
        || /\.eq\("journal_entry_id"|\.eq\("id"|\.eq\("tenant_id"|\.eq\("utility_account_id"/.test(chain);
      // Inside a paging wrapper. The window reaches BACKWARD only -- a helper
      // named after the query is on the lines above it, not below.
      const before = src.slice(Math.max(0, m.index - 600), m.index);
      const paged = /fetchAllPaged|rpcAllPaged|paginate[A-Za-z]*\(/.test(before)
        // A chunk loop whose slice happens on an earlier line. This is the
        // common shape -- `for (const batch of chunk(ids, N))` or
        // `const c = ids.slice(i, i + 100)` and then `.in(col, c)` -- and
        // missing it reported ALL THREE of plaid-sync-transactions' dedup
        // queries and both of the QuickBooks importer's as unbounded, when
        // every one is chunked. Five of twenty-three were this.
        || /\.slice\(\s*\w+\s*,\s*\w+\s*\+|chunk\w*\(|for \(let \w+ = 0; \w+ < [\w.]+\.length; \w+ \+= \d+\)/.test(before)
        // An explicit range-paging loop. plaid-sync walks `from` in a while
        // loop with .range(); the .range() is in the chain so it is already
        // bounded, but a build() helper above can put it out of reach.
        || /while \(true\)|for \(let from = 0/.test(before);
      if (!bounded && !paged) {
        const line = src.slice(0, m.index).split("\n").length;
        unbounded.push(`${rel}:${line} — ${table}`);
      }
    }
  }
}
// ENFORCED, as of 2026-09-17. It is zero, and a new one fails the build.
//
// This rule finds 29 genuine unbounded selects across Banking, Accounting and
// the reports. Every one is a real hazard, and none is urgent: the runtime
// guard in src/supabase.js already turns any of them into a loud
// PM_TRUNCATED the moment it actually truncates. Failing the build on all 29
// today would block the fixes that are urgent, and a red suite nobody can
// turn green teaches people to ignore red suites.
//
// The list is printed on every run so it cannot be forgotten, and the count
// is the thing that must not grow.
//
// 2026-09-17: 23 -> 8. Eleven of the twenty-three were never unbounded --
// the rule could not see a chunk loop whose .slice() happened on an earlier
// line, so all three of plaid-sync-transactions' dedup queries and both of
// the QuickBooks importer's were reported as hazards when every one is
// chunked. It also counted per-tenant queries, and one tenant does not have
// a thousand payments; the whole payments table holds 91 rows.
//
// The four that were real got fixed rather than reclassified:
//   * Lifecycle.js summed a tenant's AR lines unpaged to show their balance
//   * api/stripe.js did the same and WROTE the result to tenants.balance,
//     which the dashboard reads directly as Balance Due
//   * company.js and accounting.js passed unchunked id lists to .in(), which
//     is a URL parameter -- past ~100 the request is invalid, not merely short
//
// And Admin.js was truncating live: 1,431 error_log rows in the last seven
// days, read unpaged, so every figure on the error dashboard was short. It
// counts now instead of fetching.
//
// Second pass, 8 -> 5. Banking and the QuickBooks importer chunk through a
// helper called chunked(), which the rule did not know about. Fixing that
// took two goes: `chunked?\(` reads as "chunke" plus an optional "d" and
// stopped matching plain chunk(, so the importer's three came straight back.
// The rule catching its own regression is the only reason that was noticed.
//
// One more real one came out of this pass, and it was the worst of the lot.
// Properties.js voids every journal entry for a property when the property is
// deleted, and read them unpaged. The busiest property in production carries
// 1,304 entries -- measured -- so deleting it would have voided a thousand
// and left 304 live on a property the app reports as gone, silently.
//
// Third pass, 5 -> 0. I argued for leaving the last five because they sit
// on small tables today -- 91 payments, zero STRIPE- entries, 44 documents
// on the busiest property. Sahil asked why. The honest answer is that it is
// the SAME argument that left the property-delete path unpaged, and that one
// turned out to be reading 1,304 rows through a 1,000-row hole. "Small
// today" is not a property of the code, it is a property of this month's
// data.
//
// So: Dashboard's payments and the rent-accrual check are paged; the
// property document panel and the tenant document checklist carry explicit
// limits, which makes the bound a decision rather than Supabase's invisible
// one. And the rule learned the builder pattern -- a query assigned to a
// variable, filtered over several lines, then awaited with .limit() well
// outside the window it was reading. Payments.js had a .limit(200) the whole
// time and was reported anyway.
//
// The baseline is 0 and the check now FAILS rather than reports. A list of
// known-acceptable hazards is a list people learn to skim.
const UNBOUNDED_BASELINE = 0;    // 38 -> 23 -> 8 -> 5 -> 0. It stays there.
console.log(`\nℹ ${unbounded.length} unbounded selects on >1000-row tables (baseline ${UNBOUNDED_BASELINE}):`);
unbounded.slice(0, 8).forEach(u => console.log("   " + u));
if (unbounded.length > 8) console.log(`   …and ${unbounded.length - 8} more`);
console.log("   The runtime guard catches these when they truncate; page them when touched.\n");
assert(
  "no NEW unbounded select on a >1000-row table",
  unbounded.length <= UNBOUNDED_BASELINE,
  unbounded.slice(0, 12).join("\n   ")
    + (unbounded.length > 12 ? `\n   …and ${unbounded.length - 12} more` : "")
    + "\n   Use fetchAllPaged, or .limit()/.range()/.single() to say the bound is deliberate."
);

// ---- 3. the runtime guard must stay in place -----------------------------
// Belt and braces: this file cannot see a query built at runtime, and the
// guard cannot see a .limit(5000) that never truncates in testing. Each
// covers the other's blind spot, so neither may quietly disappear.
const supa = fs.readFileSync(path.join(SRC, "supabase.js"), "utf8");
assert("the client still detects truncation at runtime",
  /PM_TRUNCATED/.test(supa) && /MAX_ROWS/.test(supa),
  "src/supabase.js is the only thing that catches a truncation this file cannot see");

assert("the guard hooks select(), where the thenable actually is",
  /qb\.select = function/.test(supa),
  "PostgrestQueryBuilder from .from() has no then; patching it does nothing at all");

assert("explicit paging is exempt from the guard",
  /p\.has\('limit'\) \|\| p\.has\('offset'\)/.test(supa),
  "fetchAllPaged issues .range(0,999); guarding it would break the helper that satisfies the guard");

assert("a rejecting count never masks the original result",
  /catch \(_e\) \{ total = null \}/.test(supa) || /catch \(_e\)/.test(supa),
  "a guard that throws on its own failure is worse than the bug it guards");

// ---- the guard must not blank a working page ----------------------------
// The first version refused the Bank Transactions fetch and the screen went
// empty. Two mistakes, one after the other:
//
//   1. the paging exemption gated only the count RE-FETCH, while a count the
//      caller had already requested was read unconditionally -- so a query
//      that paged AND asked for { count: "exact" } (which is how you page
//      properly, since you need the total to know when to stop) was refused
//      on its own first page: range(0,999) over 1,060 rows;
//   2. I then "fixed" it by looking for a Range header, on the assumption
//      that .range() sends one. It does not -- supabase-js compiles .range()
//      into ?offset=&limit= in the URL, which the original check already saw.
//
// A guard that empties a page is worse than the truncation it guards against,
// so the deliberate-paging path is asserted, not remembered.
assert("a deliberate page is exempt before any count is read",
  /if \(deliberate\) return result/.test(supa)
    && supa.indexOf('if (deliberate) return result') < supa.indexOf('typeof result.count === \'number\''),
  "the exemption must come BEFORE the count check, or a paged query with count:exact is refused");

assert("the exemption is passed in from the caller",
  /assertNotTruncated\(result, table, boundary \? rerun : null, asked\)/.test(supa),
  "computing `asked` and not passing it is how the first version failed");


console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
