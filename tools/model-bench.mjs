// Compare models on the jobs PropManager would actually give them.
//
//   node tools/model-bench.mjs                 # local Gemma only
//   OPENROUTER_API_KEY=sk-... node tools/model-bench.mjs
//
// Why this exists: Gemma 4 5.1B on the VPS answers a transaction
// classification in ~1.5-2s on 4 CPU cores with no GPU, and got 3 of 4
// right in a quick hand test. Before building on it, worth knowing
// whether a Qwen of similar size does better -- and hosted testing
// avoids pulling 5-8GB onto the VPS to find out.
//
// The test set uses INVENTED names in the real formats. Nothing here is
// a real tenant, because these prompts leave the building.
import fs from "fs";

const LOCAL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OR_KEY = process.env.OPENROUTER_API_KEY || "";

// Candidates. Local first, then hosted if a key is present.
const MODELS = [
  { id: "gemma4:e2b", where: "local", label: "Gemma 4 5.1B  (local, 7.2 GB)" },
  { id: "qwen3:14b",  where: "local", label: "Qwen3 14B     (local, 9.3 GB)" },
  ...(OR_KEY ? [
    // IDs and prices read from OpenRouter's own /models list, so none of
    // these 404. Ordered smallest-first: the point of comparison is a
    // model that could plausibly replace a 5.1B on 4 CPU cores, not
    // whether an 80B is smarter (it is).
    { id: "qwen/qwen3-8b",                     where: "openrouter", label: "Qwen3 8B          ($0.117/M)" },
    { id: "qwen/qwen3.5-9b",                   where: "openrouter", label: "Qwen3.5 9B        ($0.100/M)" },
    { id: "qwen/qwen3.5-flash-02-23",          where: "openrouter", label: "Qwen3.5 Flash     ($0.065/M)" },
    { id: "qwen/qwen3-30b-a3b-instruct-2507",  where: "openrouter", label: "Qwen3 30B A3B     ($0.048/M)" },
    { id: "qwen/qwen3.5-27b",                  where: "openrouter", label: "Qwen3.5 27B       ($0.195/M)" },
    { id: "qwen/qwen3-next-80b-a3b-instruct",  where: "openrouter", label: "Qwen3-Next 80B    ($0.090/M)" },
  ] : []),
];

// ---- the jobs ------------------------------------------------------
const CATEGORIES = ["Rent", "Repairs", "Utilities", "Insurance", "Mortgage", "HOA", "Property Tax", "Other"];
const TXNS = [
  ["ZELLE FROM D HARGROVE 1600.00",            "Rent"],
  ["BGE ENERGY BILL AUTOPAY 214.03",           "Utilities"],
  ["WELLS FARGO HOME MTG 1850.00",             "Mortgage"],
  ["STATE FARM INS PMT 142.00",                "Insurance"],
  ["HOME DEPOT #4521 PURCHASE 89.42",          "Repairs"],
  ["WSSC WATER 78.10",                         "Utilities"],
  ["PG COUNTY TREASURY RE TAX 1204.55",        "Property Tax"],
  ["WINDMILL SQUARE CONDO ASSN DUES 278.00",   "HOA"],
  ["CHECK 1042 J RIVERA PLUMBING 465.00",      "Repairs"],
  ["DEPOSIT - SECTION 8 HAP PAYMENT 1418.00",  "Rent"],
  ["AMAZON MKTPL*RT4Y8 34.99",                 "Other"],
  ["NEWREZ SHELLPOINT MTG 2210.14",            "Mortgage"],
];

const CLASSIFY = (t) =>
  `Classify this bank transaction for a rental property business.\n` +
  `Answer with EXACTLY ONE of these words and nothing else:\n${CATEGORIES.join(", ")}\n\n` +
  `Transaction: ${t}\nCategory:`;

// A second job: does it stay inside the facts it was given?
const GROUNDING = {
  prompt: `You are drafting a late-rent notice. Use ONLY these facts. If a fact is missing, write [MISSING] rather than inventing it.\n\n` +
    `Tenant: D Hargrove\nProperty: 12 Old Mill Rd, Reston VA\nRent: $1,600/month\nAmount overdue: $3,200\nLast payment: 2026-07-01\nGrace period: 5 days\n\n` +
    `Write two sentences stating what is owed and by when. Do not invent a date, a law, or a fee.`,
  // Anything here means it invented something.
  forbidden: [/\$(?!1,?600|3,?200)\d/, /statute|§|code section|court/i, /late fee of/i],
};

// A blip must not lose the whole run. The first attempt died on call 4
// of 13 when the SSH tunnel dropped, with no timeout and no retry.
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
  return { text: "", ms: 0, error: String(last?.message || last).slice(0, 90) };
}

async function callLocal(model, prompt, maxTok) {
  return withRetry(() => callLocalOnce(model, prompt, maxTok));
}

async function callLocalOnce(model, prompt, maxTok) {
  const r = await fetch(`${LOCAL}/api/chat`, {
    signal: AbortSignal.timeout(180000),
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, think: false, stream: false,
      messages: [{ role: "user", content: prompt }],
      options: { temperature: 0, num_predict: maxTok } }),
  });
  const d = await r.json();
  return { text: (d.message?.content || "").trim(), ms: Math.round((d.total_duration || 0) / 1e6) };
}

async function callOpenRouter(model, prompt, maxTok) {
  const t0 = Date.now();
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OR_KEY}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTok,
      messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return { text: "", ms: Date.now() - t0, error: `${r.status} ${(await r.text()).slice(0, 120)}` };
  const d = await r.json();
  return { text: (d.choices?.[0]?.message?.content || "").trim(), ms: Date.now() - t0 };
}

const call = (m, prompt, maxTok) =>
  m.where === "local" ? callLocal(m.id, prompt, maxTok) : callOpenRouter(m.id, prompt, maxTok);

const results = [];
for (const m of MODELS) {
  process.stdout.write(`\n${m.label}\n`);
  let right = 0, total = 0, ms = 0, failed = 0;
  const wrong = [];
  for (const [txn, expected] of TXNS) {
    const out = await call(m, CLASSIFY(txn), 12);
    if (out.error) { failed++; process.stdout.write(`  ! ${out.error}\n`); break; }
    total++; ms += out.ms;
    // Take the first category word it mentions.
    const said = CATEGORIES.find(c => new RegExp(`\\b${c.replace(/ /g, "\\s*")}\\b`, "i").test(out.text)) || out.text.slice(0, 18);
    if (said.toLowerCase() === expected.toLowerCase()) right++;
    else wrong.push(`${txn.slice(0, 28)} → ${said} (want ${expected})`);
    process.stdout.write(said.toLowerCase() === expected.toLowerCase() ? "." : "x");
  }
  process.stdout.write("\n");
  if (failed) { results.push({ ...m, unavailable: true }); continue; }

  const g = await call(m, GROUNDING.prompt, 220);
  const invented = GROUNDING.forbidden.filter(re => re.test(g.text)).length;

  results.push({ ...m, right, total, avgMs: Math.round(ms / Math.max(total, 1)), wrong, invented, draft: g.text });
  console.log(`  classify: ${right}/${total}   avg ${Math.round(ms / Math.max(total, 1))} ms`);
  wrong.forEach(w => console.log(`     miss: ${w}`));
  console.log(`  grounding: ${invented === 0 ? "stayed within the facts" : invented + " invented detail(s)"}`);
}

console.log("\n==================== SUMMARY ====================");
console.log("model".padEnd(34) + "correct".padEnd(10) + "avg ms".padEnd(10) + "invented");
for (const r of results) {
  if (r.unavailable) { console.log(r.label.padEnd(34) + "unavailable"); continue; }
  console.log(r.label.padEnd(34) + `${r.right}/${r.total}`.padEnd(10) + String(r.avgMs).padEnd(10) + String(r.invented));
}
fs.writeFileSync("/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/model-bench.json", JSON.stringify(results, null, 2));
console.log("\nfull output incl. drafts: scratchpad/model-bench.json");
if (!OR_KEY) console.log("\nNo OPENROUTER_API_KEY — only your local Gemma was tested.\nGet a key at openrouter.ai/keys, then:  OPENROUTER_API_KEY=sk-... node tools/model-bench.mjs");
