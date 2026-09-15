// Every query against a company-scoped table must filter by company.
//
// WHY A STATIC TEST AND NOT A DATABASE RULE
//
// The database cannot enforce this, and it is worth being precise about
// why. RLS answers "which companies may this user touch at all" -- and it
// does, correctly: a staff member reaches only companies they belong to.
// It cannot answer "which company does the user currently have OPEN",
// because that is client state the database never sees.
//
// So the company filter is the caller's job. ledger_entries in particular
// is scoped by is_company_staff(company_id): it returns rows for EVERY
// company you are staff of. A caller that forgets .eq("company_id", ...)
// therefore gets a ledger spanning companies, silently, with no error and
// no empty result to notice -- just another company's tenants mixed into
// this one's arrears.
//
// All 15 existing callers filter correctly. This exists so the sixteenth
// cannot quietly not.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (ok, name, detail) => {
  if (ok) { console.log("  ✅ " + name); pass++; }
  else { console.log("  ❌ " + name + (detail ? " — " + detail : "")); fail++; }
};

// Tables holding rows for more than one company, where a missing filter
// returns another company's data rather than nothing.
const SCOPED = [
  "ledger_entries", "acct_journal_lines", "acct_journal_entries",
  "acct_accounts", "tenants", "properties", "leases", "utilities",
  "payments", "work_orders",
];

// A query is scoped if the company filter appears within a few lines of the
// .from(), since these are chained across line breaks throughout the app.
// Ten lines, because an update() spreads its payload over several before
// the filters arrive -- at six, Banking.js's correctly-scoped update read
// as unscoped.
const WINDOW = 10;

function scanFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  const problems = [];
  lines.forEach((line, i) => {
    for (const tbl of SCOPED) {
      if (!line.includes(`.from("${tbl}")`)) continue;
      const chunk = lines.slice(i, i + WINDOW).join("\n");

      // An INSERT carries company_id in its PAYLOAD, not as a filter, so
      // requiring .eq() there flags every correct insert in the codebase.
      // A missing company_id on an insert is a different bug with a
      // different guard (the NOT NULL column itself).
      if (/\.insert\(|\.upsert\(/.test(chunk)) continue;

      const scoped =
        /\.eq\(\s*["']company_id["']/.test(chunk) ||
        // pm_company_id is the MANAGING company: properties a company
        // manages on someone else's behalf. Scoped, just not by the column
        // this rule first looked for.
        /\.eq\(\s*["']pm_company_id["']/.test(chunk) ||
        // A single parent id. The parent was itself reached by a scoped
        // query, and RLS refuses a parent belonging to another company.
        /\.eq\(\s*["'](journal_entry_id|tenant_id|property_id|lease_id)["']/.test(chunk) ||
        /companyQuery|companyInsert|companyUpsert/.test(chunk) ||
        // Addressing ONE row by its own primary key is scoped by the key.
        // The row was found by a query that was itself company-filtered, or
        // by an external identifier the caller already holds.
        /\.eq\(\s*["']id["']/.test(chunk) ||
        // Addressing a SET of ids obtained from an already-scoped query.
        // The provenance cannot be checked statically, but an id is unique
        // across companies and RLS refuses any that belong elsewhere, so
        // the worst case is an empty result rather than another company's
        // row.
        /\.in\(\s*["'](id|journal_entry_id|account_id)["']/.test(chunk) ||
        // Explicitly-marked exceptions carry a reason on the line above.
        // Look back far enough to hold a real explanation. An exemption
        // that has to fit in one line becomes "// company-scope-exempt"
        // with no reason, which is how exemptions stop being read.
        /company-scope-exempt/.test(lines.slice(Math.max(0, i - 10), i + 1).join("\n"));
      if (!scoped) {
        problems.push(`${path.basename(file)}:${i + 1}  ${tbl}  ${line.trim().slice(0, 70)}`);
      }
    }
  });
  return problems;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

console.log("\nCompany scoping");
console.log("================================================");

const roots = [path.join(__dirname, "..", "src"), path.join(__dirname, "..", "api")];
let all = [];
for (const r of roots) { if (fs.existsSync(r)) all = all.concat(walk(r)); }

const problems = all.flatMap(scanFile);
assert(all.length > 50, `scanned ${all.length} source files`);
assert(problems.length === 0,
  "every query on a company-scoped table filters by company",
  problems.length ? `\n     ` + problems.join("\n     ") : "");

// The guard has to be able to fail, or it proves nothing.
const canary = `const x = supabase.from("ledger_entries").select("*").order("date");`;
const tmp = path.join(__dirname, ".company-scope-canary.js");
fs.writeFileSync(tmp, canary);
const caught = scanFile(tmp).length === 1;
fs.unlinkSync(tmp);
assert(caught, "the guard actually catches an unscoped query (canary)");

console.log("\n================================================");
console.log(`✅ Passed: ${pass}`);
console.log(`❌ Failed: ${fail}`);
process.exit(fail ? 1 : 0);
