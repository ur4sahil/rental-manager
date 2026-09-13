// End-to-end test of transaction coding: seed realistic transactions,
// queue them through the app's API, let the worker on the box code them,
// and check that a SUGGESTION lands on each one.
//
// Deliberately includes cases the model should get WRONG-ish or refuse:
// an ambiguous transfer and a transaction with no sensible account. A
// suite that only feeds it obvious repairs invoices proves nothing about
// what it does when it is unsure.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(process.env.HOME + "/rental-manager/tests/.env", "utf8")
    .split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));

const sb = createClient(env.TEST_SUPABASE_URL, env.TEST_SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const API = "https://test.housify365.com";
const BYPASS = process.env.VERCEL_BYPASS_TOKEN || "";
const COMPANY = "sandbox-llc";
const TAG = `txntest-${Date.now()}`;

const headers = () => {
  const h = { "Content-Type": "application/json" };
  if (BYPASS) h["x-vercel-protection-bypass"] = BYPASS;
  return h;
};

const CASES = [
  { desc: "HOME DEPOT #2841 HYATTSVILLE MD", payee: "HOME DEPOT", amount: 284.19,
    direction: "outflow", expect: "an expense account, most likely repairs/maintenance" },
  { desc: "ACH DEPOSIT RENT PAYMENT WHITFIELD M", payee: "M WHITFIELD", amount: 2450.00,
    direction: "inflow", expect: "rental income" },
  { desc: "WSSC WATER BILL PAYMENT AUTOPAY", payee: "WSSC", amount: 118.44,
    direction: "outflow", expect: "utilities" },
  { desc: "MONTHLY SERVICE CHARGE", payee: "", amount: 15.00,
    direction: "outflow", expect: "a bank fee / expense account" },
  // Genuinely ambiguous: it should be allowed to decline rather than guess.
  { desc: "TRANSFER TO XXXXXX4471", payee: "", amount: 5000.00,
    direction: "outflow", expect: "ideally null — a transfer is not an expense" },
];

const { data: accounts } = await sb.from("acct_accounts")
  .select("code, name, type").eq("company_id", COMPANY).limit(200);
const { data: classes } = await sb.from("acct_classes")
  .select("name").eq("company_id", COMPANY).limit(200);
console.log(`chart of accounts: ${accounts.length} · classes: ${classes.length}\n`);

// Seed the transactions.
const seeded = [];
for (const c of CASES) {
  const { data, error } = await sb.from("bank_feed_transaction").insert([{
    company_id: COMPANY, posted_date: "2026-09-01",
    amount: c.direction === "inflow" ? c.amount : -c.amount,
    direction: c.direction, status: "for_review",
    bank_description_raw: c.desc, bank_description_clean: c.desc,
    payee_raw: c.payee, payee_normalized: c.payee,
    fingerprint_hash: `${TAG}-${c.desc.slice(0, 12)}-${c.amount}`,
    raw_payload_json: { _test: TAG },
  }]).select().single();
  if (error) { console.error("seed failed:", error.message); process.exit(1); }
  seeded.push({ ...c, id: data.id });
}
console.log(`seeded ${seeded.length} transactions\n`);

// Queue them.
const jobs = [];
for (const t of seeded) {
  const res = await fetch(`${API}/api/ai?action=enqueue`, {
    method: "POST", headers: headers(),
    body: JSON.stringify({
      companyId: COMPANY, kind: "categorise_txn",
      subjectTable: "bank_feed_transaction", subjectId: String(t.id), priority: 5,
      input: {
        date: "2026-09-01", direction: t.direction, amount: t.amount,
        description: t.desc, payee: t.payee,
        accounts: accounts.map(a => ({ code: a.code, name: a.name, type: a.type })),
        
      },
    }),
  });
  const b = await res.json();
  if (!res.ok) { console.error("enqueue failed:", b); process.exit(1); }
  jobs.push({ ...t, jobId: b.job.id });
}
console.log(`queued ${jobs.length} jobs, waiting for the worker...\n`);

const t0 = Date.now();
let done = 0;
for (let i = 0; i < 240 && done < jobs.length; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const { data: rows } = await sb.from("ai_jobs").select("id, status")
    .in("id", jobs.map(j => j.jobId));
  done = (rows || []).filter(r => !["queued", "running"].includes(r.status)).length;
  process.stdout.write(`\r  ${Math.round((Date.now() - t0) / 1000)}s — ${done}/${jobs.length} coded   `);
}
console.log("\n");

const { data: finished } = await sb.from("ai_jobs").select("*").in("id", jobs.map(j => j.jobId));
const { data: txns } = await sb.from("bank_feed_transaction").select("id, suggestion_status, raw_payload_json")
  .in("id", seeded.map(s => s.id));

for (const j of jobs) {
  const job = finished.find(f => f.id === j.jobId);
  const txn = txns.find(t => t.id === j.id);
  const sug = txn?.raw_payload_json?._suggestion;
  console.log(`${j.desc.slice(0, 42).padEnd(44)}`);
  console.log(`  expected:   ${j.expect}`);
  console.log(`  model said: code=${job?.output?.account_code ?? "null"} class=${job?.output?.class_name ?? "null"} conf=${job?.output?.confidence ?? "?"} memo="${job?.output?.memo ?? ""}"`);
  console.log(`  suggestion: ${sug ? `${sug.accountName} (status ${txn.suggestion_status})` : `none — ${txn?.suggestion_status ?? "unset"}`}`);
  if (job?.error) console.log(`  ERROR: ${job.error}`);
  console.log(`  ${job?.duration_ms ?? "?"}ms\n`);
}

// Clean up both tables.
await sb.from("ai_jobs").delete().in("id", jobs.map(j => j.jobId));
await sb.from("bank_feed_transaction").delete().in("id", seeded.map(s => s.id));
console.log("cleaned up");
