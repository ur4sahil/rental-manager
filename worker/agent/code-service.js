#!/usr/bin/env node
// BGE sign-in code service, for the streamed PAYMENT browser.
//
// The payment browser runs on the Oracle box; BGE emails a one-time code at
// every sign-in, and only this Mac (Sheeba) can read that mailbox. This tiny
// server answers "what is the newest BGE code received since <time>?" by
// reading local Mail the same way the daily sweep does (portals/mail-code.js).
//
// Reachable ONLY on 127.0.0.1 here. The Oracle box reaches it through the
// reverse SSH tunnel Sheeba already keeps open (com.housy.home-proxy: a SOCKS
// proxy whose exit is this Mac, so its "127.0.0.1" is this machine), and every
// request must carry HOUSY_CODE_SERVICE_TOKEN. It returns a code or null --
// nothing else from the mailbox ever leaves this machine.
const http = require("http");
const path = require("path");
const { readCodeFromMail } = require(path.join(__dirname, "..", "portals", "mail-code"));

const PORT = Number(process.env.HOUSY_CODE_SERVICE_PORT || 8765);
const TOKEN = process.env.HOUSY_CODE_SERVICE_TOKEN || "";
if (!TOKEN) { console.error("HOUSY_CODE_SERVICE_TOKEN is not set -- refusing to start"); process.exit(1); }

http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const reply = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method !== "GET" || u.pathname !== "/bge-code") return reply(404, { error: "not found" });
  if (req.headers["x-code-token"] !== TOKEN) return reply(403, { error: "forbidden" });
  // Only codes received after `since` (the moment the payment browser asked
  // BGE to send one, minus a little clock slack) -- never an older code.
  const since = Number(u.searchParams.get("since")) || (Date.now() - 10 * 60 * 1000);
  let code = null;
  try { code = readCodeFromMail(since - 30 * 1000); } catch (e) { return reply(500, { error: String(e.message || e) }); }
  console.log(new Date().toISOString(), "code request", code ? "-> found" : "-> none yet");
  reply(200, { code });
}).listen(PORT, "127.0.0.1", () => console.log(`bge code service on 127.0.0.1:${PORT}`));
