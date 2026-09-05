// Every column the client writes must exist in the database.
//
// This is the single most productive bug class in this codebase. Seven
// separate features were found broken by it in one day, all silent:
//
//   utilities "Pay"            -> utilities.paid_at
//   Generate Statement         -> owner_statements.properties
//   "Statement sent"           -> owner_statements.sent_at (it is sent_date)
//   Pay Owner                  -> owner_distributions.owner_name, .status
//   property delete cascade    -> utilities.archived_by, inspections.archived_at/by
//   tenant concurrent-edit     -> tenants.updated_at
//   tenant portal payments     -> payments.tenant_id
//
// PostgREST rejects the whole statement with PGRST204 and never writes.
// The app's try/catch swallows it, so the user gets a toast about
// something unrelated, or silence, and the feature simply never works.
//
// Static analysis: find .from("table") ... .insert/.update({ literal }),
// take the top-level keys, and check them against information_schema.
// Spreads (...form) cannot be resolved statically and are skipped, so
// this is a floor on the problem, not a ceiling.
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}${detail ? "  — " + detail : ""}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

// Top-level keys of the object literal starting at `start` (index of "{").
function topLevelKeys(src, start) {
  const keys = [];
  let depth = 0, i = start, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i], prev = src[i - 1];
    if (inStr) { if (c === inStr && prev !== "\\") inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") { depth--; if (depth === 0) break; }
    else if (depth === 1) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(src.slice(i));
      if (m && /[{,\s]/.test(prev || "{")) { keys.push(m[1]); i += m[0].length - 1; }
    }
  }
  return keys;
}

// Comments are stripped before scanning. Without this the key matcher
// read "created_by is what authorises the membership insert below:" and
// reported a companies.below column. A guard that invents findings is
// worse than no guard.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/./g, " "));
}

function scanFile(file) {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  const writes = [];
  // The gap between .from("table") and the write must contain ONLY
  // chainable calls. Without this the regex happily matched a .from()
  // belonging to a SELECT and then latched onto the next .insert() in
  // the file, which belongs to a different table -- it reported
  // company_members.tenant_name for what is really a
  // doc_exception_requests insert. A guard that cries wolf gets muted,
  // so the association has to be exact.
  const re = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)([\s\S]{0,400}?)\.(insert|update|upsert)\(\s*(\[\s*)?\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const gap = m[2];
    if (/;|\bawait\b|\.from\(|=>|\bconst\b|\blet\b/.test(gap)) continue;
    const table = m[1];
    const braceIdx = src.indexOf("{", m.index + m[0].length - 1);
    if (braceIdx === -1) continue;
    const line = src.slice(0, m.index).split("\n").length;
    writes.push({ table, op: m[3], keys: topLevelKeys(src, braceIdx), file, line });
  }
  return writes;
}

(async () => {
  console.log("==============================================");
  console.log("Written columns exist");
  console.log("==============================================");

  const url = process.env.TEST_SUPABASE_URL, key = process.env.TEST_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log("(skipping: no credentials)");
    console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
    process.exit(0);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const srcDir = path.join(__dirname, "..", "src");
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  })(srcDir);

  const writes = files.flatMap(scanFile);
  const tables = [...new Set(writes.map(w => w.table))];

  // Probe each distinct (table, column) pair once through PostgREST.
  // Selecting an unknown column errors; a known one returns rows or an
  // RLS-empty list. That distinction is exactly what we need, and it
  // works with the anon key without needing a service role.
  const pairs = new Map();
  for (const w of writes) for (const k of w.keys) {
    const id = `${w.table}.${k}`;
    if (!pairs.has(id)) pairs.set(id, { table: w.table, col: k, sites: [] });
    pairs.get(id).sites.push(`${path.relative(srcDir, w.file)}:${w.line} (${w.op})`);
  }

  const problems = [];
  const badTables = new Set();
  for (const { table, col, sites } of pairs.values()) {
    if (badTables.has(table)) continue;
    const r = await sb.from(table).select(col).limit(1);
    if (!r.error) continue;
    const msg = r.error.message || "";
    // An unknown TABLE also errors; note it once and move on rather than
    // reporting every column on it.
    if (/relation .* does not exist|Could not find the table/i.test(msg)) {
      badTables.add(table);
      problems.push(`${table} — table does not exist (${sites[0]})`);
      continue;
    }
    if (/column|Could not find/i.test(msg)) {
      problems.push(`${table}.${col} — ${msg.slice(0, 60)}\n     written at ${sites.slice(0, 3).join(", ")}`);
    }
  }

  assert(`scanned ${writes.length} write sites across ${tables.length} tables`, writes.length > 0);
  assert("every written column exists in the database",
    problems.length === 0,
    problems.length ? problems.slice(0, 25).join("\n   ") : "clean");

  console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
  process.exit(failed ? 1 : 0);
})();
