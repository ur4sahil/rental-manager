// Housy — the single path to the model. Everything AI goes through here.
//
// Server-side only, and deliberately so: the model endpoint is on the
// Oracle VPS behind a Cloudflare tunnel, and its URL is not something to
// ship in a browser bundle where any visitor can point it at their own
// prompts.
//
// Ollama's /api/generate, not a chat API: these are extraction and
// drafting jobs with one instruction and one document, not conversations.
//
// SPEED IS THE DESIGN CONSTRAINT, not an afterthought. Measured on the
// dedicated box (idle, 2026-09-13): prefill 57-79 tok/s, so a 12-page
// lease is 7,146 prompt tokens and 121 seconds -- 30/30 correct, but
// PAST CLOUDFLARE'S ~100s ORIGIN TIMEOUT. That is why long work is
// queued through ai_jobs and claimed by a worker ON the box, rather
// than awaited over HTTP. Streaming does not rescue it: prefill
// finishes before the first token, so nothing flows during the slow
// part. Short calls may still go straight through this function.
const AI_BASE = process.env.AI_BASE_URL || "";
const AI_MODEL = process.env.AI_MODEL || "gemma4:e2b";
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 10 * 60 * 1000);
const AI_TOKEN = process.env.AI_TOKEN || "";

/** Is the model reachable at all? Callers use this to fail loudly. */
function aiConfigured() {
  return Boolean(AI_BASE);
}

/**
 * Ask the model for JSON matching a shape.
 *
 * Ollama's format:"json" constrains decoding to valid JSON, which removes
 * the single most common failure of a local model in a pipeline: prose
 * wrapped around the answer, or a markdown fence, which then fails to
 * parse and looks like the model "refused".
 *
 * Returns { ok, data, raw, model, durationMs, error }. It NEVER throws
 * for a model-side problem -- a caller writing an ai_jobs row needs the
 * failure recorded, not an exception that loses the context.
 */
async function askJson({ system, prompt, schemaHint, model = AI_MODEL, temperature = 0 }) {
  if (!AI_BASE) {
    return { ok: false, error: "AI_BASE_URL is not set — no model endpoint configured", model };
  }
  const started = Date.now();
  const full = [
    system,
    schemaHint ? `Reply with JSON in exactly this shape:\n${schemaHint}` : null,
    // Said explicitly because a small local model will otherwise invent a
    // plausible value rather than admit the document does not contain one,
    // and a confidently wrong licence number is worse than a blank.
    "If the text does not contain a value, use null. Never guess.",
    prompt,
  ].filter(Boolean).join("\n\n");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(`${AI_BASE.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The gate in front of Ollama rejects anything without this.
        ...(AI_TOKEN ? { Authorization: `Bearer ${AI_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        model, prompt: full, stream: false, format: "json",
        // temperature 0: extraction must be reproducible. The same
        // document must give the same answer twice, or a human reviewing
        // a proposal is reviewing a coin toss.
        options: { temperature },
      }),
      signal: ctl.signal,
    });
    const durationMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, error: `model HTTP ${res.status}`, model, durationMs };
    }
    const body = await res.json();
    const raw = body?.response ?? "";
    try {
      return { ok: true, data: JSON.parse(raw), raw, model, durationMs };
    } catch (e) {
      // format:"json" makes this rare but not impossible -- a truncated
      // response is still invalid JSON. Keep the raw text: it is the only
      // way to tell "the model said something useless" from "the model
      // said something good and we mangled it".
      return { ok: false, error: `model did not return JSON: ${String(e.message).slice(0, 120)}`, raw, model, durationMs };
    }
  } catch (e) {
    const durationMs = Date.now() - started;
    const aborted = e.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `model timed out after ${Math.round(AI_TIMEOUT_MS / 1000)}s` : String(e.message).slice(0, 200),
      model, durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { aiConfigured, askJson };
