// Split documents into retrievable passages.
//
// Why retrieval at all: prompt prefill on the LLM box runs at 20-30
// tok/s and gets slower as the context grows, so handing it a whole
// lease costs about 9.5 minutes before it writes a word. Sending the
// four or five passages that actually answer the question costs seconds.
// No hardware change alters that arithmetic.
import DOMPurify from "dompurify";

// Generated documents and templates are HTML. Strip it to text WITHOUT
// regex: `<p>a</p><p>b</p>` naively becomes "ab", gluing the last word of
// one paragraph to the first of the next and producing passages that read
// as nonsense. Block-level elements have to become breaks.
const BLOCK = /^(P|DIV|BR|LI|TR|H1|H2|H3|H4|H5|H6|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|PRE|TABLE|TBODY|THEAD|UL|OL|HR)$/;

export function htmlToText(html) {
  if (!html) return "";
  const s = String(html);
  // No DOM (tests, SSR): fall back to a tag strip that at least inserts
  // breaks for block tags, rather than silently gluing words together.
  if (typeof document === "undefined" || !document.createElement) {
    return s
      // Drop script/style/head CONTENT, not just their tags. Stripping
      // tags alone leaves the body text behind, so "alert(1)" became a
      // searchable passage and would be handed to the model as if it
      // were part of the lease.
      .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|hr)\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n").map(l => l.trim()).join("\n")
      .trim();
  }
  // Sanitise before parsing. This text is stored and later placed into a
  // prompt; a document body is user-supplied, so it gets the same
  // treatment as anything else rendered from the database.
  const el = document.createElement("div");
  el.innerHTML = DOMPurify.sanitize(s, { USE_PROFILES: { html: true } });
  const walk = (node) => {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue.replace(/\s+/g, " ");
      else if (child.nodeType === 1) {
        const block = BLOCK.test(child.tagName);
        if (block) out += "\n";
        out += walk(child);
        if (block) out += "\n";
      }
    }
    return out;
  };
  return walk(el).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n")
    .split("\n").map(l => l.trim()).join("\n").trim();
}

// Target size in CHARACTERS, not tokens. A token count needs the model's
// tokeniser, which is not available in the browser; ~4 chars per token is
// close enough to keep a passage inside a sane prompt budget, and the
// retrieval limit is what actually bounds the prompt.
export const CHUNK_CHARS = 1200;
export const CHUNK_OVERLAP = 150;

// Split on paragraph boundaries, never mid-sentence where avoidable. A
// lease clause cut in half retrieves as two passages that each look
// incomplete, and the model then answers from half a sentence.
export function chunkText(text, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  const clean = String(text || "").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const paras = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };

  for (const para of paras) {
    // A single paragraph longer than the target (one long clause) still
    // has to be divided; do it on sentence ends.
    if (para.length > size) {
      flush();
      // Sentence split first, then hard-split anything still over the
      // target. Text with no sentence punctuation at all -- a clause
      // block, a table flattened to one line -- came back as a single
      // "sentence" and produced one enormous chunk, which is exactly the
      // oversized prompt this module exists to avoid.
      const sentences = (para.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [para])
        .flatMap(sent => {
          if (sent.length <= size) return [sent];
          const parts = [];
          for (let i = 0; i < sent.length; i += size) parts.push(sent.slice(i, i + size));
          return parts;
        });
      let buf = "";
      for (const sent of sentences) {
        if (buf.length + sent.length > size && buf) {
          chunks.push(buf.trim());
          // Carry the tail forward so a fact spanning the cut is still
          // findable from either side.
          buf = overlap > 0 ? buf.slice(-overlap) : "";
        }
        buf += sent;
      }
      if (buf.trim()) chunks.push(buf.trim());
      continue;
    }
    if (cur.length + para.length + 2 > size && cur) flush();
    cur += (cur ? "\n\n" : "") + para;
  }
  flush();
  return chunks.filter(c => c.length > 0);
}

// Everything a caller needs to upsert. source_table is constrained by the
// database, so a typo fails loudly rather than storing unsearchable rows.
export const CHUNK_SOURCES = ["doc_generated", "doc_templates", "lease_templates"];

export function buildChunkRows({ companyId, sourceTable, sourceId, sourceName, html, text }) {
  if (!companyId) throw new Error("buildChunkRows: companyId is required");
  if (!CHUNK_SOURCES.includes(sourceTable)) throw new Error(`buildChunkRows: unknown sourceTable ${sourceTable}`);
  if (!sourceId) throw new Error("buildChunkRows: sourceId is required");
  const body = text != null ? String(text) : htmlToText(html);
  return chunkText(body).map((content, i) => ({
    company_id: companyId,
    source_table: sourceTable,
    source_id: String(sourceId),
    source_name: sourceName || null,
    chunk_index: i,
    content,
  }));
}
