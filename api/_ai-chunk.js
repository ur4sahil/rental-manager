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
const { embedAll, toVectorLiteral } = require("./_ai-embed");

function chunkText(text) {
  const clean = String(text || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!clean) return [];
  const out = [];
  let buf = "";

  const flush = () => { if (buf.trim().length >= MIN_CHARS) out.push(buf.trim()); buf = ""; };

  // Split on NUMBERED CLAUSE headings before paragraphs.
  //
  // A lease is a list of numbered clauses, and each one is about exactly
  // one thing. Paragraph splitting alone put the title, the parties, the
  // premises, the notice address AND the term into a single 1,114-char
  // chunk -- one embedding asked to represent five topics, which then
  // scored poorly for every one of them. "When does the lease end?" could
  // not find the clause holding the dates because that clause was a fifth
  // of a chunk about something else.
  //
  // The pattern is deliberately strict: a number, a dot, a space, then a
  // CAPITALISED word. "3. TERM." splits; "$2,450.00 per month" and
  // "Section 19 below" do not.
  const byClause = clean.split(/\n(?=\s*\d{1,2}\.\s+[A-Z][A-Z ]{2,})/);
  const paragraphs = byClause.flatMap(block => block.split(/\n\s*\n/));

  for (const para of paragraphs) {
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
    // A new numbered clause always starts a new chunk, however short the
    // last one was. Packing paragraphs up to the cap is what buried the
    // TERM clause: it was merged with the title, the parties, the premises
    // and the notice address into one 1,114-character chunk, and a single
    // embedding cannot represent five subjects at once. Better a short
    // chunk that is about one thing than a full one about five.
    const startsClause = /^\s*\d{1,2}\.\s+[A-Z][A-Z ]{2,}/.test(p);
    if (startsClause || (buf + "\n\n" + p).length > MAX_CHARS) flush();
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

  // Embed as we ingest, so retrieval can match meaning and not only
  // words. Null on failure -- search falls back to lexical, which is worse
  // but not broken, and a document that failed to embed is still findable.
  const vectors = await embedAll(chunks);
  const rows = chunks.map((content, i) => ({
    company_id: companyId, source_table: sourceTable, source_id: String(sourceId),
    source_name: sourceName || null, chunk_index: i, content,
    embedding: toVectorLiteral(vectors[i]),
  }));
  // Batched: a long lease can be hundreds of chunks, and one oversized
  // insert is how a request body limit turns into a silent partial ingest.
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("doc_chunks").insert(rows.slice(i, i + 200));
    if (error) return { ok: false, error: `inserting chunks: ${error.message}`, chunks: i };
  }
  return { ok: true, chunks: rows.length, embedded: vectors.filter(Boolean).length };
}

module.exports = { chunkText, ingestChunks };
