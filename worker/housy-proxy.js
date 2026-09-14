// Housy's auth gate in front of Ollama.
//
// Ollama has NO authentication. Publishing it through a tunnel would put
// an open inference endpoint on the internet: anyone who found the URL
// could run arbitrary prompts on this box, burn its CPU indefinitely, and
// probe whatever else it can reach. cloudflared cannot check a header, so
// the check lives here and the tunnel points at THIS, never at 11434.
//
// Deliberately tiny: no dependencies, no framework, one job.
const http = require("http");

const TOKEN = process.env.HOUSY_TOKEN || "";
const UPSTREAM = process.env.HOUSY_UPSTREAM || "http://127.0.0.1:11434";
const PORT = Number(process.env.HOUSY_PORT || 11435);

if (!TOKEN || TOKEN.length < 24) {
  console.error("HOUSY_TOKEN missing or too short — refusing to start an unauthenticated gate");
  process.exit(1);
}

// Constant-time compare: a length-dependent early return leaks the token
// a character at a time to anyone willing to measure.
function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

// Only what Housy actually needs. Ollama's API also creates, copies,
// pushes and DELETES models; none of that should be reachable from a
// public URL even with the token.
const ALLOWED = new Set([
  "/api/generate",
  // Retrieval embeds passages and questions. Omitting this returned 404
  // for every embedding, and the caller's deliberate "null on failure,
  // fall back to keyword search" turned that into silence: search simply
  // stayed worse, with nothing anywhere saying why.
  "/api/embeddings",
  "/api/embed",
  "/api/tags",
  "/api/show",
]);

const server = http.createServer((req, res) => {
  const path = (req.url || "").split("?")[0];

  if (path === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }));
  }

  const auth = req.headers["authorization"] || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!safeEqual(given, TOKEN)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  if (!ALLOWED.has(path)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: `path not exposed: ${path}` }));
  }

  const u = new URL(UPSTREAM);
  // Strip by DELETING the key. Assigning `undefined` to a header throws
  // ERR_HTTP_INVALID_HEADER_VALUE in Node -- it does not quietly omit it --
  // which crashed this handler on every authenticated request.
  const fwd = { ...req.headers, host: u.host };
  delete fwd.authorization;
  delete fwd["content-length"];   // recomputed by the pipe; a stale one hangs the request
  const proxied = http.request({
    hostname: u.hostname, port: u.port, path: req.url, method: req.method,
    headers: fwd,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  proxied.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `upstream: ${e.message}` }));
  });
  req.pipe(proxied);
});

// Loopback only. The tunnel reaches it locally; nothing else should.
server.listen(PORT, "127.0.0.1", () =>
  console.log(`housy-proxy on 127.0.0.1:${PORT} -> ${UPSTREAM}`));
