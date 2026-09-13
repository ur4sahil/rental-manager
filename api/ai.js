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
const { aiConfigured } = require("./_ai");
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
      const { data, error } = await sb.rpc("complete_ai_job", {
        p_id: jobId, p_worker: String(worker), p_output: output, p_model: model,
        p_duration: durationMs, p_confidence: confidence, p_error: jobError,
      });
      if (error) return res.status(500).json({ error: error.message });
      // false means the job was reclaimed by another worker while this one
      // was still running, so this result is stale and must be discarded.
      return res.status(200).json({ ok: true, recorded: data === true });
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
