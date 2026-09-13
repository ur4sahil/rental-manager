// Isolate applySuggestion: seed a transaction and a job, claim it as the
// worker, complete it with a known-good result, and read back what the
// server said it did. The end-to-end run produced perfect model output but
// wrote no suggestion, so the fault is somewhere in this last step.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(process.env.HOME + "/rental-manager/tests/.env", "utf8")
  .split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const sb = createClient(env.TEST_SUPABASE_URL, env.TEST_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const API = "https://test.housify365.com";
const H = { "Content-Type": "application/json", "x-vercel-protection-bypass": process.env.VERCEL_BYPASS_TOKEN };
const WH = { ...H, "x-worker-token": readFileSync("/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/ai-worker-token.txt", "utf8").trim() };
const TAG = `isolate-${Date.now()}`;

const { data: txn } = await sb.from("bank_feed_transaction").insert([{
  company_id: "sandbox-llc", posted_date: "2026-09-01", amount: -284.19, direction: "outflow",
  status: "for_review", bank_description_raw: "HOME DEPOT #2841", bank_description_clean: "HOME DEPOT #2841",
  fingerprint_hash: TAG, raw_payload_json: { _test: TAG },
}]).select().single();
console.log("seeded txn", txn.id, "status", txn.status, "suggestion_status", txn.suggestion_status);

const enq = await (await fetch(`${API}/api/ai?action=enqueue`, { method: "POST", headers: H, body: JSON.stringify({
  companyId: "sandbox-llc", kind: "categorise_txn", subjectTable: "bank_feed_transaction",
  subjectId: String(txn.id), input: { description: "HOME DEPOT #2841", accounts: [{ code: "5300", name: "Repairs & Maintenance", type: "Expense" }] },
}) })).json();
console.log("queued job", enq.job.id);

// Claim it the way the worker does, so the job is in 'running' with a
// known claimed_by -- complete_ai_job matches on that.
const cl = await (await fetch(`${API}/api/ai?action=claim`, { method: "POST", headers: WH,
  body: JSON.stringify({ worker: "isolate-test", kinds: ["categorise_txn"] }) })).json();
console.log("claimed:", cl.job?.id, "(matches?", cl.job?.id === enq.job.id, ")");

const comp = await (await fetch(`${API}/api/ai?action=complete`, { method: "POST", headers: WH,
  body: JSON.stringify({ worker: "isolate-test", jobId: cl.job.id,
    output: { account_code: "5300", memo: "Repairs", confidence: 0.95 },
    model: "gemma4:e2b", durationMs: 1000, confidence: 0.95 }) })).json();
console.log("complete said:", JSON.stringify(comp));

const { data: after } = await sb.from("bank_feed_transaction").select("suggestion_status, raw_payload_json").eq("id", txn.id).single();
console.log("txn after:", after.suggestion_status, JSON.stringify(after.raw_payload_json?._suggestion || null));

await sb.from("ai_jobs").delete().eq("id", enq.job.id);
await sb.from("bank_feed_transaction").delete().eq("id", txn.id);
console.log("cleaned up");
