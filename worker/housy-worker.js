// Housy's worker. Runs ON the Oracle box, beside Ollama.
//
// WHY THIS EXISTS: a 12-page lease takes Gemma 121 seconds to read
// (measured 2026-09-13), and Cloudflare cuts an origin request off at
// ~100s. So long work cannot be an HTTP request anyone waits on.
// Instead the app queues a row, and this claims it, runs the model
// locally over loopback -- no tunnel, no timeout -- and posts the result
// back. Submit-and-poll, the same shape OpenAI Batch and Vertex LRO use.
//
// DELIBERATELY HAS NO DATABASE CREDENTIALS. It talks to the app's own API
// with a shared worker token and never sees a Supabase service key. That
// key bypasses RLS entirely, and this box is a second Always Free tenancy
// that can be reclaimed with little warning -- it stays an inference
// appliance, nothing more.
//
// No dependencies. Node 20's built-in fetch only.
const API_BASE = (process.env.HOUSY_API_BASE || "").replace(/\/$/, "");
const WORKER_TOKEN = process.env.AI_WORKER_TOKEN || "";
const OLLAMA = process.env.HOUSY_UPSTREAM || "http://127.0.0.1:11434";
const MODEL = process.env.HOUSY_MODEL || "gemma4:e2b";
const WORKER = process.env.HOUSY_WORKER_NAME || `llm-box-${process.pid}`;
// Staging sits behind Vercel SSO, which 302s every request to
// vercel.com/sso-api. This header is the documented way past it for
// automation; unset in production, where there is no protection to pass.
const BYPASS = process.env.VERCEL_BYPASS_TOKEN || "";

const IDLE_MS = Number(process.env.HOUSY_IDLE_MS || 5000);
const ERROR_BACKOFF_MS = Number(process.env.HOUSY_ERROR_BACKOFF_MS || 30000);

if (!API_BASE || !WORKER_TOKEN) {
  console.error("HOUSY_API_BASE and AI_WORKER_TOKEN are both required");
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiHeaders() {
  const h = { "Content-Type": "application/json", "x-worker-token": WORKER_TOKEN };
  if (BYPASS) h["x-vercel-protection-bypass"] = BYPASS;
  return h;
}

async function api(action, body) {
  const res = await fetch(`${API_BASE}/api/ai?action=${action}`, {
    method: "POST", headers: apiHeaders(), body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (res.status === 204) return null;                      // nothing queued
  const text = await res.text();
  if (!res.ok) throw new Error(`${action} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${action} -> unparseable response: ${text.slice(0, 200)}`); }
}

// ---------------------------------------------------------------- model
// Qwen3 emits reasoning even with think:false -- it relocates into content
// rather than disappearing. Strip it, then take the first BALANCED object
// so a brace inside a string does not truncate the parse.
function parseJson(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    } }
  }
  return null;
}

// STREAMS, and that is not a preference -- it is required.
//
// Node's fetch (undici) gives up if response HEADERS do not arrive within
// 300 seconds, and AbortSignal.timeout does NOT override that. With
// stream:false Ollama sends nothing at all until the whole answer is
// finished, so any document slow enough to cross 300s fails with a bare
// "fetch failed" that looks like a network fault. That is exactly what
// killed the 12-page Qwen benchmark run twice -- no OOM, no crash, just
// the client hanging up on a model that was still working.
//
// With stream:true headers arrive immediately and each token resets the
// idle clock, so the only real limit is the abort signal below.
async function ask({ prompt, model = MODEL, numPredict = 2048, numCtx = 16384 }) {
  const started = Date.now();
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, prompt, stream: true, format: "json",
      options: { temperature: 0, num_predict: numPredict, num_ctx: numCtx },
    }),
    signal: AbortSignal.timeout(45 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  // Ollama streams newline-delimited JSON. Accumulate `response`, and also
  // `thinking`: Qwen3 puts its ANSWER there and leaves `response` empty,
  // which scored a correct model 0/10 three times before it was caught.
  let answer = "", thinking = "", tail = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    tail += decoder.decode(chunk, { stream: true });
    const lines = tail.split("\n");
    tail = lines.pop() || "";               // keep the partial line
    for (const line of lines) {
      if (!line.trim()) continue;
      let piece;
      try { piece = JSON.parse(line); } catch { continue; }
      if (piece.response) answer += piece.response;
      if (piece.thinking) thinking += piece.thinking;
      if (piece.error) throw new Error(`ollama: ${piece.error}`);
    }
  }

  const raw = answer.trim() ? answer : thinking;
  return { data: parseJson(raw), raw, model, durationMs: Date.now() - started };
}

// ---------------------------------------------------------------- jobs
// One handler per kind, written out deliberately rather than driven by a
// generic template. A generic writer would happily push whatever the
// model invented into whatever field matched its name.
const SCHEMAS = {
  extract_license:
    `{"license_number":string|null,"jurisdiction":string|null,` +
    `"issue_date":"YYYY-MM-DD"|null,"expiry_date":"YYYY-MM-DD"|null,` +
    `"fee_amount":number|null,` +
    `"license_type":"rental_license"|"rental_registration"|"lead_paint"|null,` +
    `"property_address":string|null,"owner_name":string|null,"confidence":number}`,

  abstract_lease:
    `{"tenant_name":string|null,"landlord_name":string|null,` +
    `"property_address":string|null,"lease_start":"YYYY-MM-DD"|null,` +
    `"lease_end":"YYYY-MM-DD"|null,"monthly_rent":number|null,` +
    `"security_deposit":number|null,"late_fee":number|null,` +
    `"rent_due_day":number|null,"guarantor_name":string|null,"confidence":number}`,

  // account_code, not a name and not an id: a code is short, stable and
  // verifiable against the chart of accounts, so an invented one is
  // caught rather than written. Asking for a uuid would invite the model
  // to hallucinate something that looks exactly like a real one.
  // No class_name. Asked for the property, the model answered "Bank
  // Charges" and "Rental Income" -- account names -- for every
  // transaction, having ignored the property list entirely. The server
  // matches the property against the transaction text instead, which is a
  // string search and therefore exact.
  categorise_txn:
    `{"account_code":string|null,"memo":string|null,"confidence":number}`,
};

const INSTRUCTIONS = {
  extract_license:
    `You read a rental licence or registration certificate and return its fields.\n` +
    `Copy values EXACTLY as printed. Dates must be ISO (YYYY-MM-DD) whatever\n` +
    `format the document uses. jurisdiction is the issuing authority.\n` +
    // Gemma took the zip from the OWNER's address on a real Prince George's
    // licence and reported confidence 1.0. Say which address is wanted.
    `property_address is the address of the LICENSED PROPERTY, not the owner's\n` +
    `mailing address and not the issuing office's address.`,

  abstract_lease:
    `You read a residential lease and return its key terms.\n` +
    `Copy values EXACTLY as printed. Dates must be ISO (YYYY-MM-DD).\n` +
    `property_address is the address of the RENTED DWELLING, not the landlord's\n` +
    `office and not the managing agent's office.\n` +
    `Amounts are numbers with no currency symbol or comma.\n` +
    `tenant_name is the FIRST tenant named.`,

  categorise_txn:
    `You code a single bank transaction to a general-ledger account.\n` +
    `Choose account_code from the CHART OF ACCOUNTS below. Use the code\n` +
    `EXACTLY as listed. If nothing fits well, return null rather than\n` +
    `forcing a poor match -- a wrong account is worse than a blank one,\n` +
    `because it lands in the books and someone has to find it later.\n` +
    `memo is a SHORT human description, under 60 characters.\n` +
    `Money IN is usually income; money OUT is usually an expense.\n` +
    `\n` +
    `Worked examples:\n` +
    `  "LOWES #1122 PURCHASE", money OUT -> the repairs and maintenance account\n` +
    `  "ZELLE FROM TENANT JULY RENT", money IN -> the rental income account\n` +
    `  "PEPCO ELECTRIC AUTOPAY", money OUT -> the utilities account\n` +
    `  "TRANSFER TO SAVINGS 1234", money OUT -> null, because moving money\n` +
    `     between your own accounts is neither income nor expense`,
};

async function runJob(job) {
  const kind = job.kind;
  const schema = SCHEMAS[kind];
  const instruction = INSTRUCTIONS[kind];
  if (!schema) throw new Error(`no handler for kind "${kind}"`);

  let body;
  if (kind === "categorise_txn") {
    const t = job.input || {};
    const accounts = Array.isArray(t.accounts) ? t.accounts : [];
    if (!accounts.length) throw new Error("no chart of accounts supplied — cannot code a transaction against nothing");
    body = [
      "CHART OF ACCOUNTS:",
      accounts.map(a => `  ${a.code}  ${a.name}${a.type ? ` (${a.type})` : ""}`).join("\n"),
      "TRANSACTION:",
      `  date: ${t.date || "unknown"}`,
      `  direction: ${t.direction === "inflow" ? "money IN" : "money OUT"}`,
      `  amount: ${t.amount}`,
      `  description: ${t.description || ""}`,
      t.payee ? `  payee: ${t.payee}` : null,
    ].filter(Boolean).join("\n");
  } else {
    const text = String(job.input?.text || "");
    if (!text.trim()) throw new Error("job input has no text");
    body = `Document:\n"""\n${text}\n"""`;
  }

  const prompt = [
    instruction,
    `Reply with JSON in exactly this shape:\n${schema}`,
    // A small local model will otherwise invent a plausible value rather
    // than admit the source lacks one. A confidently wrong licence
    // number is worse than a blank.
    "If the source does not state a value, use null. Never guess.",
    body,
  ].join("\n\n");

  const r = await ask({ prompt, numPredict: kind === "categorise_txn" ? 256 : 2048 });
  if (!r.data) throw new Error(`model returned no parseable JSON (${r.raw ? r.raw.slice(0, 160) : "empty"})`);

  // The model's own confidence is advisory only -- it is not calibrated,
  // and on the real Prince George's licence it said 1.0 while getting the
  // zip wrong. Recorded, never used to gate anything.
  const confidence = typeof r.data.confidence === "number" ? r.data.confidence : null;
  return { output: r.data, model: r.model, durationMs: r.durationMs, confidence };
}

// ---------------------------------------------------------------- loop
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { stopping = true; console.log(`${sig} — finishing current job then exiting`); });
}

(async () => {
  console.log(`housy-worker "${WORKER}" -> ${API_BASE}, model ${MODEL}`);
  while (!stopping) {
    let job = null;
    try {
      const r = await api("claim", { worker: WORKER, kinds: Object.keys(SCHEMAS) });
      job = r?.job || null;
    } catch (e) {
      console.error(`claim failed: ${e.message}`);
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }

    if (!job) { await sleep(IDLE_MS); continue; }

    console.log(`claimed ${job.id} (${job.kind}, attempt ${job.attempts})`);
    try {
      const out = await runJob(job);
      const done = await api("complete", { worker: WORKER, jobId: job.id, ...out });
      console.log(`  done in ${out.durationMs}ms${done?.recorded === false ? " (DISCARDED — reclaimed by another worker)" : ""}`);
    } catch (e) {
      console.error(`  failed: ${e.message}`);
      try {
        await api("complete", {
          worker: WORKER, jobId: job.id, error: String(e.message).slice(0, 500),
        });
      } catch (e2) {
        // Leave it claimed; claim_ai_job reclaims it once it goes stale.
        console.error(`  could not record the failure either: ${e2.message}`);
      }
    }
  }
  console.log("stopped");
})();
