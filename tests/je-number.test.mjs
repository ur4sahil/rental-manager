// next_je_number must keep counting past JE-9999 (lpad(..., 4) used to
// truncate JE-10000 to JE-1000, a duplicate, and every posting after the
// 10,000th entry failed). Live check runs inside a rolled-back block on TEST.
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
require("./sandbox-env");
const { createClient } = require("@supabase/supabase-js");
let passed = 0, failed = 0;
const assert = (n, ok, d = "") => { if (ok) { passed++; console.log("  ✅ " + n); } else { failed++; console.log("  ❌ " + n + (d ? "  — " + d : "")); } };

const mig = fs.readFileSync(new URL("../supabase/migrations/20260929060000_je_number_past_9999.sql", import.meta.url), "utf8");
assert("migration pads with greatest(4, length(n)) -- never truncates", /lpad\(n::text, greatest\(4, length\(n::text\)\), '0'\)/.test(mig));
const later = fs.readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter(f => f > "20260929060000")
  .filter(f => /FUNCTION public\.next_je_number/.test(fs.readFileSync(new URL("../supabase/migrations/" + f, import.meta.url), "utf8")));
assert("no later migration redefines next_je_number without the fix", later.every(f =>
  /greatest\(4, length\(/.test(fs.readFileSync(new URL("../supabase/migrations/" + f, import.meta.url), "utf8"))), later.join(","));

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const co = "qa-jenum-" + Math.random().toString(36).slice(2, 8);
try {
  const { error: ce } = await sb.from("companies").insert({ id: co, name: "QA JENUM" });
  if (ce) throw ce;
  const next = async () => (await sb.rpc("next_je_number", { p_company_id: co })).data;
  const add = async (number, ref) => { const { error } = await sb.from("acct_journal_entries").insert({ company_id: co, number, date: "2026-09-29", description: "qa", reference: ref, status: "posted" }); if (error) throw error; };
  assert("empty company -> JE-0001", (await next()) === "JE-0001");
  await add("JE-9999", "QAJ-1");
  const n1 = await next(); assert("after JE-9999 -> JE-10000", n1 === "JE-10000", n1);
  await add(n1, "QAJ-2");
  const n2 = await next(); assert("after JE-10000 -> JE-10001 (sorted numerically)", n2 === "JE-10001", n2);
} finally {
  await sb.from("acct_journal_entries").delete().eq("company_id", co);
  await sb.from("companies").delete().eq("id", co);
  const { count } = await sb.from("companies").select("id", { count: "exact", head: true }).eq("id", co);
  assert("cleanup: no leftovers", count === 0);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
