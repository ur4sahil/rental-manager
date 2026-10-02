#!/usr/bin/env node
// Serve /api/* locally from the same handler files Vercel runs, against the
// TEST database. `npm start` proxies /api to this (package.json "proxy"), so
// a feature that needs a server route can be exercised end to end on a
// laptop instead of only after a deploy.
//
//   node scripts/dev-api.js            (port 3011)
//
// Reads TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_KEY from tests/.env and
// refuses to start against production. Document emails are never sent from
// here: DOC_EMAIL_TRANSPORT=log records each one in doc_email_log instead.
const http = require("http");
const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", "tests", ".env");
const env = Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").filter(l => /^[A-Z_]+=/.test(l))
  .map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
const url = env.TEST_SUPABASE_URL || "";
if (!url.includes("vpeewlplgxthckpidhxo") || url.includes("hoymytpyaudjvsgiiibn")) {
  console.error("dev-api: TEST_SUPABASE_URL is not the test project. Refusing to start."); process.exit(1);
}
Object.assign(process.env, {
  SUPABASE_URL: url, REACT_APP_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: env.TEST_SUPABASE_SERVICE_KEY,
  APP_URL: process.env.APP_URL || "http://localhost:3010",
  DOC_EMAIL_TRANSPORT: "log",
  DOC_EMAIL_ALLOWLIST: process.env.DOC_EMAIL_ALLOWLIST || "dev@example.com",
});
delete process.env.VERCEL_ENV;

const PORT = Number(process.env.DEV_API_PORT || 3011);
http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const name = u.pathname.replace(/^\/api\//, "").replace(/\/+$/, "");
  const file = path.join(__dirname, "..", "api", name + ".js");
  if (!/^[a-z0-9-]+$/.test(name) || !fs.existsSync(file)) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no such route" })); return; }
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = raw;
    if ((req.headers["content-type"] || "").includes("application/json")) { try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; } }
    req.body = body;
    req.query = Object.fromEntries(u.searchParams.entries());
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { if (!res.headersSent) res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); return res; };
    try {
      delete require.cache[require.resolve(file)];   // pick up edits without a restart
      await require(file)(req, res);
    } catch (e) {
      console.error("dev-api:", name, e);
      if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e && e.message) })); }
    }
  });
}).listen(PORT, () => console.log("dev-api: /api on http://localhost:" + PORT + " -> TEST database, emails logged not sent"));
