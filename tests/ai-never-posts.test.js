// Housy must never post to the books. It suggests; a person confirms.
//
// This is the one invariant in the whole AI feature that cannot be allowed
// to erode. A suggestion is inert -- it pre-fills the Categorise form and
// nothing more -- and the moment any AI path can write a journal entry or
// flip a transaction to posted, every guarantee made to the user about
// review is void. The damage would also be quiet: mis-posted entries look
// exactly like correct ones until someone reconciles.
//
// Source-level, deliberately. A runtime test only proves the paths it
// happens to exercise; this proves no such path exists to exercise.
require("dotenv").config();
require("./sandbox-env");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  cond ? pass++ : fail++;
  // Detail explains a FAILURE. Printed beside a tick it reads as a
  // contradiction of the thing that just passed.
  console.log(`${cond ? "✅" : "❌"} ${name}${!cond && detail ? "  — " + detail : ""}`);
};

const ROOT = path.join(__dirname, "..");
const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");

// Strip comments, so a table named in an explanatory note is not mistaken
// for a write to it. The comments here discuss posting at length.
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ---- the AI routes may not touch the books --------------------------
const aiSrc = code(read("api/ai.js"));

// Tables that ARE the books. A write to any of them from an AI route means
// the model reached the ledger without a human in between.
const LEDGER_TABLES = [
  "acct_journal_entries", "acct_journal_lines", "journal_entries",
  "bank_posting_decision", "bank_posting_decision_line",
  "bank_feed_transaction_link", "payments", "ledger_entries",
];
for (const t of LEDGER_TABLES) {
  // .from("table").insert / .update / .upsert / .delete, in any order of
  // chaining, on one line or several.
  const re = new RegExp(`from\\(["'\`]${t}["'\`]\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\b`);
  assert(`api/ai.js never writes to ${t}`, !re.test(aiSrc));
}

// The RPCs that post. Calling one from here would bypass the same gate.
for (const rpc of ["create_journal_entry", "atomicPostJEAndLedger", "batch_post_rent_charges"]) {
  assert(`api/ai.js never calls ${rpc}`, !new RegExp(`\\b${rpc}\\b`).test(aiSrc));
}

// It may write to bank_feed_transaction -- that is how a suggestion is
// recorded -- but ONLY these two columns. `status` is what marks a
// transaction accepted, excluded or posted.
const txnWrites = [...aiSrc.matchAll(
  /from\(["'`]bank_feed_transaction["'`]\)[\s\S]{0,400}?\.update\(\s*\{([\s\S]*?)\}\s*\)/g)];
assert("api/ai.js does update bank_feed_transaction (the suggestion itself)", txnWrites.length > 0,
  "no update found — did writeSuggestion move?");
for (const [, body] of txnWrites) {
  const keys = [...body.matchAll(/(\w+)\s*:/g)].map(m => m[1]);
  const allowed = new Set(["suggestion_status", "raw_payload_json"]);
  const bad = keys.filter(k => !allowed.has(k));
  assert(`the update writes only suggestion_status and raw_payload_json`, bad.length === 0,
    bad.length ? `also writes ${bad.join(", ")}` : "");
}

// suggestion_status may only ever be set to the AI value. Setting it to
// 'accepted' or the status column to 'posted' would be the bypass.
assert("api/ai.js never sets a transaction status", !/status:\s*["'`](posted|accepted|excluded|matched)["'`]/.test(aiSrc));

// ---- the worker holds no database credentials -----------------------
// It runs on a box in a second Always Free tenancy that can be reclaimed
// with little warning. A service key there would bypass RLS entirely.
const workerPath = path.join(ROOT, "worker", "housy-worker.js");
if (fs.existsSync(workerPath)) {
  const w = code(fs.readFileSync(workerPath, "utf8"));
  assert("the worker has no Supabase client", !/@supabase\/supabase-js|createClient\(/.test(w));
  assert("the worker has no service key", !/SERVICE_ROLE|SERVICE_KEY/.test(w));
} else {
  assert("worker/housy-worker.js is in the repo", false, "deployed code must be version controlled");
}

// ---- auto-accept belongs to rules, never to the AI -------------------
const banking = code(read("src/components/Banking.js"));
// Checking the variable NAME was the wrong test -- the rules list renders
// with `r`, which is a rule but does not say so. What actually matters is
// that no auto_accept read sits anywhere the AI path can reach: the model
// must never be able to trigger an automatic post.
const AI_FNS = ["bulkAskHousy"];
for (const fn of AI_FNS) {
  const i = banking.indexOf(`async function ${fn}`);
  const body = i === -1 ? "" : banking.slice(i, banking.indexOf("async function", i + 20));
  assert(`${fn} never reads auto_accept`, i !== -1 && !/auto_accept/.test(body));
}
// And every read that does exist is inside the rules engine, which runs off
// rows a person wrote.
const autoAcceptCount = (banking.match(/auto_accept/g) || []).length;
assert("auto_accept still exists on rules (guard is meaningful)", autoAcceptCount > 0,
  "none found — has the rules engine moved?");

// The AI's bulk action must not call anything that posts.
const bulkAsk = banking.slice(
  Math.max(0, banking.indexOf("async function bulkAskHousy")),
  banking.indexOf("async function bulkApply"));
assert("bulkAskHousy exists", bulkAsk.length > 0);
for (const posting of ["bulkApply", "addTransaction", "acceptTransaction", "autoPostJournalEntry", "safeLedgerInsert"]) {
  assert(`bulkAskHousy never calls ${posting}`, !new RegExp(`\\b${posting}\\s*\\(`).test(bulkAsk));
}

// ---- the suggestion shape is inert ----------------------------------
// A suggestion pre-fills a form. If it ever carried something that the
// accept path treats as "already decided", it would stop being inert.
const housyApi = code(read("api/ai.js"));
const sugMatch = housyApi.match(/payload\._suggestion\s*=\s*\{([\s\S]*?)\};/);
assert("the suggestion payload is built in one place", !!sugMatch);
if (sugMatch) {
  assert("a suggestion never carries a posted flag or journal entry id",
    !/journal_entry_id|posted|accepted_at|decision_id/.test(sugMatch[1]));
}

console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
process.exit(fail ? 1 : 0);
