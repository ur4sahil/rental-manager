// AI actions. One dispatcher, like api/daily-reminders.js.
//
//   POST /api/ai?action=ingest    { companyId, sourceTable, sourceId, sourceName, text }
//   POST /api/ai?action=extract-license
//                                 { companyId, sourceTable, sourceId, sourceName, text }
//   POST /api/ai?action=search    { companyId, query, limit, sourceId }
//
// Nothing here writes to a business table. `extract-license` produces an
// ai_jobs row with status 'proposed'; applying it is a separate, human
// action. A confidently wrong licence number on a property you are
// renting out is a filing problem, not a UI bug.
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { aiConfigured } = require("./_ai");
const { ingestChunks } = require("./_ai-chunk");
const { extractLicense } = require("./_ai-extract");

function admin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const action = String(req.query?.action || "");
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { companyId } = body;
  if (!companyId) return res.status(400).json({ error: "companyId is required" });

  const sb = admin();
  if (!sb) return res.status(500).json({ error: "server is not configured for database access" });

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
