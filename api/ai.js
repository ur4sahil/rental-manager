// AI actions. One dispatcher, like api/daily-reminders.js.
//
// Browser-facing (company-scoped, normal auth):
//   POST /api/ai?action=ingest    { companyId, sourceTable, sourceId, sourceName, text }
//   POST /api/ai?action=extract-license
//                                 { companyId, sourceTable, sourceId, sourceName, text }
//   POST /api/ai?action=search    { companyId, query, limit, sourceId }
//   POST /api/ai?action=enqueue   { companyId, kind, subjectTable, subjectId, input, priority }
//   POST /api/ai?action=job-status{ companyId, jobId }
//   POST /api/ai?action=jobs      { companyId, status, limit }
//   POST /api/ai?action=ask       { companyId, question, sourceId, limit }  (synchronous)
//
// Worker-facing (x-worker-token, NOT company-scoped):
//   POST /api/ai?action=claim     { worker, kinds }
//   POST /api/ai?action=complete  { worker, jobId, output, model, durationMs, confidence, error }
//
// Nothing here writes to a business table. A finished job lands as
// status 'proposed'; applying it is a separate, human action. A
// confidently wrong licence number on a property you are renting out is
// a filing problem, not a UI bug.
//
// WHY A QUEUE AT ALL: a 12-page lease is 121 seconds of prefill on the
// box, and Cloudflare kills an origin request at ~100s. Long work cannot
// be a request someone waits on, so it becomes a row a worker claims --
// the same submit-and-poll shape OpenAI Batch and Vertex LRO use.
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { aiConfigured, askJson } = require("./_ai");
const { ingestChunks } = require("./_ai-chunk");
const { extractLicense } = require("./_ai-extract");

// Actions the WORKER calls. These carry no companyId -- the worker serves
// every company -- and are authenticated by a shared secret instead.
const WORKER_ACTIONS = new Set(["claim", "complete"]);

function admin() {
  // BOTH names, because the two environments are not configured alike:
  // production sets only REACT_APP_SUPABASE_URL (as 19 other routes here
  // read), staging sets both. Reading only SUPABASE_URL made every route
  // in this file return 500 in production while working perfectly on
  // staging -- a difference no test catches, because the tests run
  // against staging's environment.
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Constant-time compare. A length-dependent early return leaks the token
// one character at a time to anyone willing to measure response times.
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

function workerAuthorised(req) {
  const expected = process.env.AI_WORKER_TOKEN || "";
  // Refuse rather than default-open: an unset secret must not mean
  // "anyone may drain the queue".
  if (!expected || expected.length < 24) return false;
  return safeEqual(req.headers["x-worker-token"], expected);
}


// suggestion_status defaults to the STRING "none", not NULL. Every check
// of "does this already have a suggestion?" has to go through here, or a
// truthiness test quietly answers yes for everything.
function hasSuggestion(status) {
  return Boolean(status) && status !== "none";
}

// Write a suggestion onto a transaction. One writer for both paths --
// history and model -- so the guards (already decided, already suggested)
// cannot drift apart between them.
async function writeSuggestion(sb, companyId, txnId, sug) {
  const { data: txn } = await sb.from("bank_feed_transaction")
    .select("id, raw_payload_json, status, suggestion_status").eq("id", txnId)
    .eq("company_id", companyId).maybeSingle();
  if (!txn) return { written: false, reason: "the transaction no longer exists" };
  if (txn.status !== "for_review") return { written: false, reason: `transaction is ${txn.status}` };
  if (hasSuggestion(txn.suggestion_status) && txn.suggestion_status !== "suggested_ai") {
    return { written: false, reason: `a rule already suggested (${txn.suggestion_status})` };
  }

  const payload = { ...(txn.raw_payload_json || {}) };
  payload._suggestion = { type: "assign", classId: null, ...sug };

  const { error } = await sb.from("bank_feed_transaction").update({
    suggestion_status: "suggested_ai", raw_payload_json: payload,
  }).eq("id", txn.id).eq("company_id", companyId);
  return error ? { written: false, reason: error.message } : { written: true };
}

// Turn a categorise_txn result into a suggestion on the bank transaction.
//
// The model returns an account CODE, never an id. Codes are short, stable
// and checkable against the chart of accounts, so an invented one is
// caught here instead of being written to the books. An id would have
// invited a hallucination that looks exactly like a real uuid.
async function applySuggestion(sb, job, output) {
  const code = output.account_code == null ? "" : String(output.account_code).trim();
  if (!code) return { written: false, reason: "model declined to pick an account" };

  const { data: accounts } = await sb.from("acct_accounts")
    .select("id, code, name").eq("company_id", job.company_id);
  const account = (accounts || []).find(a => String(a.code).trim() === code);
  // An unknown code is the model inventing one. Refuse it rather than
  // guessing at what it meant.
  if (!account) return { written: false, reason: `no account with code "${code}"` };

  // The property is matched DETERMINISTICALLY against the transaction text,
  // not asked of the model.
  //
  // Asked, the model answered "Bank Charges" and "Rental Income" -- account
  // names, not properties -- for every transaction, having ignored the
  // property list entirely. A bank description either contains a property's
  // name or it does not, and a string search answers that exactly. This is
  // the same rule as not asking it to parse a date: if something is
  // decidable, decide it.
  let classId = null;
  const haystack = `${job.input?.description || ""} ${job.input?.payee || ""}`.toLowerCase();
  if (haystack.trim()) {
    const { data: classes } = await sb.from("acct_classes")
      .select("id, name").eq("company_id", job.company_id);
    // Longest name first, so "100 Oak Street, Unit A" wins over
    // "100 Oak Street" when both appear.
    const sorted = (classes || [])
      .filter(c => c.name && String(c.name).trim().length >= 6)
      .sort((a, b) => String(b.name).length - String(a.name).length);
    const hit = sorted.find(c => haystack.includes(String(c.name).trim().toLowerCase()));
    classId = hit ? hit.id : null;
  }

  const { data: txn } = await sb.from("bank_feed_transaction")
    .select("id, raw_payload_json, status, suggestion_status").eq("id", job.subject_id)
    .eq("company_id", job.company_id).maybeSingle();
  if (!txn) return { written: false, reason: "the transaction no longer exists" };
  // Do not overwrite a decision a human already made.
  if (txn.status !== "for_review") return { written: false, reason: `transaction is ${txn.status}` };
  // Nor a rule's answer. A rule is exact and was written deliberately; by
  // the time this returns, one may have been applied. Checked here as well
  // as in the client because the client is not the only possible caller.
  //
  // "none" is a STRING in this column, not NULL -- that is the default. A
  // plain truthiness check treats it as "already suggested" and silently
  // blocks every write, which is exactly what it did.
  if (hasSuggestion(txn.suggestion_status) && txn.suggestion_status !== "suggested_ai") {
    return { written: false, reason: `a rule already suggested (${txn.suggestion_status})` };
  }

  const payload = { ...(txn.raw_payload_json || {}) };
  payload._suggestion = {
    type: "assign",
    accountId: account.id,
    accountName: account.name,
    classId,
    memo: output.memo ? String(output.memo).slice(0, 120) : "",
    source: "housy",
    confidence: typeof output.confidence === "number" ? output.confidence : null,
  };

  const { error } = await sb.from("bank_feed_transaction").update({
    suggestion_status: "suggested_ai",
    raw_payload_json: payload,
  }).eq("id", txn.id).eq("company_id", job.company_id);
  if (error) return { written: false, reason: error.message };
  return { written: true, account: account.code, classId };
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const action = String(req.query?.action || "");
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  const sb = admin();
  if (!sb) return res.status(500).json({ error: "server is not configured for database access" });

  const isWorker = WORKER_ACTIONS.has(action);
  if (isWorker) {
    if (!workerAuthorised(req)) return res.status(401).json({ error: "unauthorized" });
  } else if (!body.companyId) {
    return res.status(400).json({ error: "companyId is required" });
  }
  const { companyId } = body;

  try {
    if (action === "ingest") {
      const { sourceTable, sourceId, sourceName, text } = body;
      if (!sourceTable || !sourceId) return res.status(400).json({ error: "sourceTable and sourceId are required" });
      const r = await ingestChunks(sb, { companyId, sourceTable, sourceId, sourceName, text });
      return res.status(r.ok ? 200 : 500).json(r);
    }

    if (action === "search") {
      const { query, limit = 6, sourceId = null } = body;
      if (!query) return res.status(400).json({ error: "query is required" });
      const { data, error } = await sb.rpc("search_doc_chunks", {
        p_company_id: companyId, p_query: query, p_limit: limit, p_source_id: sourceId,
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, chunks: data || [] });
    }

    // ---- queue a job for the worker ------------------------------------
    // Returns immediately with the row. Nothing runs the model here; that
    // is the whole point.
    if (action === "enqueue") {
      const { kind, subjectTable = null, subjectId = null, input = {}, priority = 0 } = body;
      if (!kind) return res.status(400).json({ error: "kind is required" });

      // Ingest the text for retrieval at the same time. A document Housy
      // has read should be answerable questions about, and doing it here
      // means the chunk store fills as a side effect of normal use rather
      // than needing its own pass over everything.
      //
      // Failure is not fatal: the extraction is the job the user asked
      // for, and retrieval is a bonus on top of it.
      if (input && input.text && subjectTable && subjectId) {
        await ingestChunks(sb, {
          companyId, sourceTable: subjectTable, sourceId: subjectId,
          sourceName: input.source_name, text: input.text,
        }).catch(() => {});
      }
      const { data: job, error } = await sb.from("ai_jobs").insert([{
        company_id: companyId,
        kind,
        status: "queued",
        subject_table: subjectTable,
        subject_id: subjectId === null ? null : String(subjectId),
        input,
        priority,
        created_by: body.userEmail || null,
      }]).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(202).json({ ok: true, job });
    }

    // ---- poll one job --------------------------------------------------
    // Company-scoped: a job id alone must not let one company read
    // another's work.
    if (action === "job-status") {
      const { jobId } = body;
      if (!jobId) return res.status(400).json({ error: "jobId is required" });
      const { data, error } = await sb.from("ai_jobs")
        .select("*").eq("id", jobId).eq("company_id", companyId).maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: "no such job for this company" });
      return res.status(200).json({ ok: true, job: data });
    }

    // ---- list the review queue -----------------------------------------
    if (action === "jobs") {
      const { status = null, limit = 50 } = body;
      let q = sb.from("ai_jobs").select("*").eq("company_id", companyId)
        .order("created_at", { ascending: false }).limit(Math.min(Number(limit) || 50, 200));
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, jobs: data || [] });
    }

    // ---- code transactions: history first, model only if it is silent ---
    //
    // MEASURED on 16,548 real journal lines (leave-one-out, so out of
    // sample): 83% of transactions have a precedent, and the most-common
    // account for that precedent is right 93.4% of the time.
    //
    // So history is not a hint to feed the model -- it IS the answer for
    // most transactions, it is instant, and it can say why: "Gas, because
    // all 28 previous Washington Gas payments went there." The model is
    // for the ~17% with no precedent at all, which is the only part where
    // a guess beats nothing.
    if (action === "code-transactions") {
      const { transactions = [], accounts = [], minSupport = 3, minAgreement = 0.7 } = body;
      if (!Array.isArray(transactions) || !transactions.length) {
        return res.status(400).json({ error: "transactions is required" });
      }

      let fromHistory = 0, queued = 0, skipped = 0;
      const failures = [];

      for (const t of transactions) {
        const text = `${t.description || ""} ${t.payee || ""}`.trim();
        if (!text) { skipped++; continue; }

        const { data: hits } = await sb.rpc("suggest_account_from_history", {
          p_company_id: companyId, p_text: text, p_min_support: 1,
        });
        const top = (hits || [])[0];

        // Confident enough only when the precedent is both REPEATED and
        // consistent. One prior line that happened to go somewhere is not
        // a pattern, and a 50/50 split is not an answer.
        const confident = top
          && Number(top.support) >= minSupport
          && Number(top.agreement) >= minAgreement;

        if (confident) {
          const r = await writeSuggestion(sb, companyId, t.id, {
            accountId: top.account_id, accountName: top.account_name,
            memo: (t.description || "").slice(0, 120),
            source: "history",
            support: Number(top.support),
            agreement: Number(top.agreement),
            method: top.method,
          });
          r.written ? fromHistory++ : failures.push({ id: t.id, reason: r.reason });
          continue;
        }

        // No usable precedent. This is where the model earns its keep.
        if (!accounts.length) { skipped++; continue; }
        const { error: insErr } = await sb.from("ai_jobs").insert([{
          company_id: companyId, kind: "categorise_txn", status: "queued",
          subject_table: "bank_feed_transaction", subject_id: String(t.id),
          priority: 5, created_by: body.userEmail || null,
          input: { date: t.date, direction: t.direction, amount: t.amount,
                   description: t.description, payee: t.payee, accounts },
        }]);
        insErr ? failures.push({ id: t.id, reason: insErr.message }) : queued++;
      }

      return res.status(200).json({ ok: true, fromHistory, queued, skipped, failures });
    }

    // ---- ask a question of the documents --------------------------------
    // SYNCHRONOUS, unlike everything else here, and deliberately.
    // Retrieval sends a handful of passages rather than a whole document,
    // so the prompt is small and the answer comes back in seconds -- well
    // inside the ~100s an HTTP request survives. Queueing it would mean a
    // spinner and a poll for something that is effectively instant.
    if (action === "ask") {
      if (!aiConfigured()) return res.status(503).json({ error: "no model endpoint configured (AI_BASE_URL)" });
      const { question, sourceId = null, limit = 6 } = body;
      if (!question || !String(question).trim()) return res.status(400).json({ error: "question is required" });

      const { data: chunks, error: sErr } = await sb.rpc("search_doc_chunks", {
        p_company_id: companyId, p_query: String(question), p_limit: Math.min(Number(limit) || 6, 10),
        p_source_id: sourceId,
      });
      if (sErr) return res.status(500).json({ error: sErr.message });
      // No passage means no grounded answer is possible. Say so rather
      // than letting the model answer from nothing, which is exactly how
      // it invents a clause that was never in the lease.
      if (!chunks || !chunks.length) {
        return res.status(200).json({ ok: true, answer: null, chunks: [],
          reason: "nothing in the documents matched that question" });
      }

      const passages = chunks.map((c, i) =>
        `[${i + 1}] from ${c.source_name || c.source_table}:\n${c.content}`).join("\n\n");

      const r = await askJson({
        system:
          "Answer the question using ONLY the passages below. They are excerpts from " +
          "the user's own property documents.\n" +
          // The failure that matters here is a confident answer drawn from
          // general knowledge of leases rather than from THIS lease.
          "If the passages do not contain the answer, say so in `answer` and set " +
          "`found` to false. Do not answer from general knowledge about leases.\n" +
          "`quote` must be copied VERBATIM from a passage -- it is what the reader " +
          "checks you against. `passage` is which numbered passage you used.",
        schemaHint: '{"answer":string,"found":boolean,"quote":string|null,"passage":number|null}',
        prompt: `Passages:\n${passages}\n\nQuestion: ${question}`,
      });
      if (!r.ok) return res.status(502).json({ error: r.error || "the model did not answer" });

      return res.status(200).json({
        ok: true,
        answer: r.data?.answer || null,
        found: r.data?.found !== false,
        quote: r.data?.quote || null,
        passage: r.data?.passage ?? null,
        chunks: chunks.map(c => ({ source_name: c.source_name, source_table: c.source_table,
                                   source_id: c.source_id, content: c.content, rank: c.rank })),
        model: r.model, durationMs: r.durationMs,
      });
    }

    // ---- worker claims one job -----------------------------------------
    if (action === "claim") {
      const { worker, kinds = null } = body;
      if (!worker) return res.status(400).json({ error: "worker is required" });
      const { data, error } = await sb.rpc("claim_ai_job", {
        p_worker: String(worker),
        p_kinds: Array.isArray(kinds) && kinds.length ? kinds : null,
      });
      if (error) return res.status(500).json({ error: error.message });
      const job = Array.isArray(data) ? data[0] : data;
      // 204 means "nothing to do" -- an ordinary, frequent answer, not an
      // error the worker should log or back off hard on.
      if (!job) return res.status(204).end();
      return res.status(200).json({ ok: true, job });
    }

    // ---- worker reports a result ---------------------------------------
    if (action === "complete") {
      const { worker, jobId, output = null, model = null, durationMs = null,
              confidence = null, error: jobError = null } = body;
      if (!worker || !jobId) return res.status(400).json({ error: "worker and jobId are required" });

      // Read the job BEFORE completing it: complete_ai_job clears the claim,
      // and a categorise_txn result needs the job's company and subject to
      // know which transaction it belongs to.
      const { data: job } = await sb.from("ai_jobs")
        .select("id, kind, company_id, subject_table, subject_id").eq("id", jobId).maybeSingle();

      const { data, error } = await sb.rpc("complete_ai_job", {
        p_id: jobId, p_worker: String(worker), p_output: output, p_model: model,
        p_duration: durationMs, p_confidence: confidence, p_error: jobError,
      });
      if (error) return res.status(500).json({ error: error.message });
      // false means the job was reclaimed by another worker while this one
      // was still running, so this result is stale and must be discarded.
      if (data !== true) return res.status(200).json({ ok: true, recorded: false });

      // A coded transaction becomes a SUGGESTION on the transaction itself,
      // in the same shape the rules engine already writes, rather than a
      // second thing to approve in Housy's queue.
      //
      // Why: the Banking screen already has a reviewed accept path that
      // builds the posting decision, the lines and the journal entry.
      // Duplicating that here would be a second, less-tested route into
      // the books. A suggestion is inert -- it only pre-fills a form -- so
      // the human gate stays exactly where it already is.
      if (job && job.kind === "categorise_txn" && !jobError && output) {
        const applied = await applySuggestion(sb, job, output);
        return res.status(200).json({ ok: true, recorded: true, suggestion: applied });
      }
      return res.status(200).json({ ok: true, recorded: true });
    }

    if (action === "extract-license") {
      if (!aiConfigured()) {
        return res.status(503).json({ error: "no model endpoint configured (AI_BASE_URL)" });
      }
      const { sourceTable = "documents", sourceId, sourceName, text } = body;
      if (!sourceId) return res.status(400).json({ error: "sourceId is required" });

      // Ingest first, so the document is searchable whether or not the
      // extraction succeeds -- retrieval has value on its own.
      await ingestChunks(sb, { companyId, sourceTable, sourceId, sourceName, text });

      const r = await extractLicense({ text, sourceName });

      // The job row is written on BOTH paths. A failed extraction that
      // leaves no trace is one nobody can debug, and "the AI did nothing"
      // is the least useful bug report there is.
      const row = {
        company_id: companyId,
        kind: "extract_license",
        status: r.ok ? "proposed" : "failed",
        subject_table: sourceTable,
        subject_id: String(sourceId),
        input: { source_name: sourceName || null, chars: String(text || "").length },
        output: r.ok ? r.output : null,
        model: r.model || null,
        duration_ms: r.durationMs || null,
        confidence: r.ok ? r.confidence : null,
        error: r.ok ? null : (r.error || "unknown").slice(0, 500),
        created_by: body.userEmail || null,
      };
      const { data: job, error: insErr } = await sb.from("ai_jobs").insert([row]).select().single();
      if (insErr) return res.status(500).json({ error: `recording the job: ${insErr.message}` });
      return res.status(r.ok ? 200 : 502).json({ ok: r.ok, job, error: r.ok ? undefined : r.error });
    }

    return res.status(400).json({ error: `unknown action "${action}"` });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
};
