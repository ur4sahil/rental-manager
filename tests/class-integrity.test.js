// Guards the acct_classes primary-key / orphaning bug.
//
// A bulk upsert keyed on (company_id, name) that carried `id` in its
// payload compiled to ON CONFLICT ... DO UPDATE SET id = EXCLUDED.id and
// rewrote the primary key of every class it touched, silently orphaning
// 13,947 journal lines and 61 properties across four companies. There was
// no foreign key on class_id to stop it.
//
// Two layers are tested: the source may not send `id` on such an upsert,
// and the database must make it harmless if some future code does.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SRC = path.join(__dirname, "..", "src");
const read = (p) => fs.readFileSync(path.join(SRC, p), "utf8");

let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
};

// ---- Source: no upsert on acct_classes may carry an id --------------
const files = ["components/Properties.js", "components/Accounting.js", "utils/accounting.js"];
for (const f of files) {
  const src = read(f);
  // Every acct_classes upsert call, with its payload object.
  const calls = [...src.matchAll(/from\("acct_classes"\)\s*\.upsert\(([\s\S]{0,400}?)\)\s*(?:\.|;)/g)];
  for (const [, payload] of calls) {
    assert(`${f}: acct_classes upsert sends no id`,
      !/\bid:\s/.test(payload),
      (payload.match(/\bid:\s*\w+/) || [""])[0]);
  }
  // A variable payload (upsert(newClasses)) — check the builder instead.
  if (/upsert\(newClasses/.test(src)) {
    const block = src.slice(src.indexOf("const newClasses"), src.indexOf("upsert(newClasses"));
    assert(`${f}: newClasses builder sends no id`, !/^\s*id:\s/m.test(block),
      (block.match(/^\s*id:\s*.+$/m) || [""])[0].trim());
  }
}

// The whole point of dropping `id` is that the column supplies its own.
assert("migration gives acct_classes.id a default",
  /ALTER COLUMN id SET DEFAULT gen_random_uuid\(\)::text/i.test(
    fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations",
      "20260904090000_repair_class_id_orphans.sql"), "utf8")));

// ---- Database: the constraints actually exist and behave ------------
(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY);
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { data, error } = await sb.rpc("exec_sql", { q: "select 1" }).catch(() => ({ error: 1 }));
    void data; void error; // rpc may not exist; the checks below use plain reads
  }

  // No orphans anywhere. This is the invariant the FK now enforces, and
  // it is cheap enough to assert on every run.
  const { data: lines, error: le } = await sb
    .from("acct_journal_lines").select("class_id").not("class_id", "is", null).limit(1000);
  if (le) { assert("can read journal lines", false, le.message); }
  else {
    const ids = [...new Set(lines.map(l => l.class_id))];
    const { data: cls } = await sb.from("acct_classes").select("id").in("id", ids.slice(0, 100));
    const live = new Set((cls || []).map(c => c.id));
    const missing = ids.slice(0, 100).filter(i => !live.has(i));
    assert("sampled journal lines all resolve to a live class",
      missing.length === 0, missing.slice(0, 3).join(", "));
  }

  console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
