// Turn a document's text into retrievable chunks.
//
// This is the half of the retrieval store that was never built: the
// table, the index and search_doc_chunks() all existed, and nothing ever
// WROTE to them, so retrieval had nothing to retrieve.
//
// Chunking on paragraphs with a size cap, not a fixed window: a lease
// clause is the unit someone asks about ("what does it say about late
// fees"), and slicing every 1000 characters cuts clauses in half so that
// neither half ranks for the question.

const MAX_CHARS = 1200;   // roughly 300 tokens — small enough that six
                          // chunks still fit comfortably in a prompt
const MIN_CHARS = 40;     // a stray line is noise in the ranking

/**
 * Split text into chunks on paragraph boundaries, never exceeding
 * MAX_CHARS. A paragraph longer than the cap is split on sentence ends,
 * and only then on the cap itself.
 */
function chunkText(text) {
  const clean = String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!clean) return [];
  const out = [];
  let buf = "";

  const flush = () => { if (buf.trim().length >= MIN_CHARS) out.push(buf.trim()); buf = ""; };

  for (const para of clean.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length > MAX_CHARS) {
      flush();
      // Sentence-split an oversized paragraph rather than hard-cutting it
      // mid-clause.
      let s = "";
      for (const sentence of p.split(/(?<=[.;:!?])\s+/)) {
        if ((s + " " + sentence).trim().length > MAX_CHARS) {
          if (s.trim().length >= MIN_CHARS) out.push(s.trim());
          s = sentence;
          // A single sentence longer than the cap: hard-cut, as there is
          // nothing better to break on.
          while (s.length > MAX_CHARS) { out.push(s.slice(0, MAX_CHARS)); s = s.slice(MAX_CHARS); }
        } else {
          s = (s ? s + " " : "") + sentence;
        }
      }
      if (s.trim().length >= MIN_CHARS) out.push(s.trim());
      continue;
    }
    if ((buf + "\n\n" + p).length > MAX_CHARS) flush();
    buf = buf ? buf + "\n\n" + p : p;
  }
  flush();
  return out;
}

/**
 * Replace a source's chunks with a fresh set.
 *
 * Delete-then-insert rather than upsert: re-ingesting a CHANGED document
 * usually produces a different NUMBER of chunks, so upserting on
 * (source_id, chunk_index) would leave the tail of the previous version
 * behind and silently mix two documents in one search result.
 */
async function ingestChunks(supabase, { companyId, sourceTable, sourceId, sourceName, text }) {
  const chunks = chunkText(text);
  if (!chunks.length) return { ok: true, chunks: 0 };

  const { error: delErr } = await supabase.from("doc_chunks").delete()
    .eq("company_id", companyId).eq("source_table", sourceTable).eq("source_id", String(sourceId));
  if (delErr) return { ok: false, error: `clearing old chunks: ${delErr.message}` };

  const rows = chunks.map((content, i) => ({
    company_id: companyId, source_table: sourceTable, source_id: String(sourceId),
    source_name: sourceName || null, chunk_index: i, content,
  }));
  // Batched: a long lease can be hundreds of chunks, and one oversized
  // insert is how a request body limit turns into a silent partial ingest.
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("doc_chunks").insert(rows.slice(i, i + 200));
    if (error) return { ok: false, error: `inserting chunks: ${error.message}`, chunks: i };
  }
  return { ok: true, chunks: rows.length };
}

module.exports = { chunkText, ingestChunks };
