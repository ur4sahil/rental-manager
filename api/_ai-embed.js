// Embeddings, for retrieval that survives the reader using different words
// than the document.
//
// Lexical search failed on "when does the lease end?" because the lease
// says "shall terminate". No amount of keyword tuning fixes that class of
// miss -- the words genuinely do not overlap.
//
// nomic-embed-text: 768 dimensions, matching the column doc_chunks has
// carried since it was created, at ~90ms per passage on the box. A whole
// lease is about three seconds.
const AI_BASE = process.env.AI_BASE_URL || "";
const AI_TOKEN = process.env.AI_TOKEN || "";
const EMBED_MODEL = process.env.AI_EMBED_MODEL || "nomic-embed-text";
const EMBED_TIMEOUT_MS = Number(process.env.AI_EMBED_TIMEOUT_MS || 60000);

/**
 * Embed one string. Returns null rather than throwing: retrieval still
 * works lexically without an embedding, so a failure here should degrade
 * the search, not fail the request that triggered it.
 */
async function embed(text) {
  if (!AI_BASE || !text || !String(text).trim()) return null;
  try {
    const res = await fetch(`${AI_BASE.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(AI_TOKEN ? { Authorization: `Bearer ${AI_TOKEN}` } : {}),
      },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text).slice(0, 8000) }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const v = j?.embedding;
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
}

/**
 * Embed many, in small batches.
 *
 * Sequential within a batch on purpose: the box has four cores shared with
 * the language model, and firing thirty requests at once makes every one
 * of them slower without finishing sooner.
 */
async function embedAll(texts, { concurrency = 3 } = {}) {
  const out = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i += concurrency) {
    const slice = texts.slice(i, i + concurrency);
    const done = await Promise.all(slice.map(t => embed(t)));
    done.forEach((v, j) => { out[i + j] = v; });
  }
  return out;
}

/** pgvector wants '[1,2,3]', not a JS array. */
function toVectorLiteral(v) {
  return Array.isArray(v) && v.length ? `[${v.join(",")}]` : null;
}

module.exports = { embed, embedAll, toVectorLiteral, EMBED_MODEL };
