#!/usr/bin/env node
// Browser-stream service — a real Chrome running here on the VPS, streamed
// into PropManager (web + mobile WebView) so a PERSON can enter a card on a
// utility's own page from inside the app.
//
// WHY THIS EXISTS, AND WHAT IT REFUSES TO BE
//
// Utilities take a fresh card every time and forbid their pages from loading
// in anyone else's iframe. So the only way to let a person pay from the app,
// without the app ever holding a card, is to run the browser HERE and stream
// the picture to them: the card they type travels server → utility over HTTPS
// and is never stored, never written to the database, never seen by the app.
//
// This is NOT a bot that types a card. It logs in and drives to the card page
// (that part is automation), then hands the wheel to the person for the card
// itself, watches for the confirmation page, and captures the receipt. The
// card-entry step is always a human's.
//
// TRANSPORT
//
// Chrome DevTools screencast (Page.startScreencast) emits JPEG frames; we
// relay them over a WebSocket and dispatch the client's mouse/key/text back
// through Input.dispatch*. Lighter than VNC/WebRTC and renders on a plain
// <canvas> — the same client works in a browser tab and in a mobile WebView.
//
//   node worker/browser-stream/server.js            (listens on :3010)
//   PORT=3010 STREAM_TOKEN=... node …/server.js
//
// Front it with the Cloudflare tunnel, exactly like flipradar-api. One session
// per socket; the process is deliberately simple and stateless between them.
"use strict";
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { createRequire } = require("module");

// Playwright lives with the tests, same as the pay worker resolves it.
let chromium = null;
for (const base of [__filename, path.join(__dirname, "..", "..", "tests", "package.json")]) {
  try { ({ chromium } = createRequire(base)("playwright")); if (chromium) break; } catch {}
}
const { WebSocketServer } = require("ws");
if (!chromium) { console.error("playwright not found (looked in tests/)"); process.exit(1); }

const PORT = Number(process.env.PORT) || 3010;
// Per-session tokens. The app mints a short-lived HMAC token (api/stream-session)
// carrying the provider/account/amount and an expiry; we verify the signature
// and expiry here with the shared STREAM_JWT_SECRET. No DB round-trip. A static
// STREAM_TOKEN is honoured too, but only for local dev when no secret is set.
const JWT_SECRET = process.env.STREAM_JWT_SECRET || "";
const TOKEN = process.env.STREAM_TOKEN || "";
function verifyToken(tok) {
  if (JWT_SECRET) {
    const [body, sig] = String(tok || "").split(".");
    if (!body || !sig) return null;
    const expect = crypto.createHmac("sha256", JWT_SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
    if (p.exp && Date.now() > p.exp) return null;
    return p; // { provider, account, amount, companyId, uid, exp, jti }
  }
  // Dev fallback: static shared token, no claims.
  return TOKEN && tok === TOKEN ? {} : null;
}
const SESSION_DIR = process.env.HOUSY_SESSION_DIR
  || path.join(require("os").homedir(), ".housy-sessions");
const SHOTS = "/tmp/housy-shots";
fs.mkdirSync(SHOTS, { recursive: true });

// The one thing every provider agrees on: a confirmation page says so in
// words. Per-provider overrides can be added, but this catches the common case.
const CONFIRM = /thank you|payment (has been )?(received|posted|submitted|scheduled|successful)|confirmation\s*(number|#|code)|successfully (paid|submitted)/i;

// Where a FRESH (no stored session) stream should land — the provider's own
// sign-in page, so the person lands ready to log in. A client may still pass an
// explicit ?url= to override.
const ENTRY = {
  wssc: "https://my.wsscwater.com/",
  pepco: "https://secure.pepco.com/",
  bge: "https://secure.bge.com/",
  washington_gas: "https://my.washingtongas.com/portal/",
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

const server = http.createServer((req, res) => {
  // A bare health check for the tunnel/monitor; everything real is WS.
  if (req.url.startsWith("/health")) { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(426); res.end("websocket only");
});
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://x");
  // Auth: a valid per-session token is REQUIRED whenever a secret is set.
  // Wide-open running is possible only in bare local dev (no secret, no token).
  const claims = verifyToken(url.searchParams.get("token"));
  if ((JWT_SECRET || TOKEN) && !claims) { ws.close(4001, "unauthorized"); return; }
  // Provider/amount come from the SIGNED token when present, so the client
  // can't widen its own grant by editing a query string.
  const provider = (claims?.provider || url.searchParams.get("provider") || "").toLowerCase();
  const startUrl = url.searchParams.get("url") || null;
  const sessionId = crypto.randomBytes(4).toString("hex");
  const send = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };
  log(`[${sessionId}] connect provider=${provider || "-"}`);

  // A signed-in storageState is used WHEN ONE EXISTS (the pay worker's
  // ensure-session leaves it on disk). When it does not — WSSC and any portal
  // whose login has a captcha the bot can't pass — start FRESH: the person
  // signs in inside the stream (solving the captcha) and pays in the same
  // session. Either way the card is a human's, and the receipt is captured here.
  let storageState;
  try {
    storageState = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, `${provider}.json`), "utf8"));
    log(`[${sessionId}] using signed-in session for ${provider}`);
  } catch {
    storageState = undefined;
    log(`[${sessionId}] no stored session for ${provider} — fresh sign-in in the stream`);
  }

  let browser, context, page, cdp;
  const closeAll = async () => {
    try { await cdp?.send("Page.stopScreencast").catch(() => {}); } catch {}
    try { await browser?.close(); } catch {}
  };

  try {
    browser = await (async () => {
      try { return await chromium.launch({ channel: "chrome", headless: true }); }
      catch { return await chromium.launch({ headless: true }); }
    })();
    context = await browser.newContext({ storageState, viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);

    // Frames out. everyNthFrame:1 + modest quality keeps it fluid without
    // flooding a phone's connection; the ack is required or Chrome throttles.
    cdp.on("Page.screencastFrame", async ({ data, sessionId: sid }) => {
      send({ type: "frame", data });
      try { await cdp.send("Page.screencastFrameAck", { sessionId: sid }); } catch {}
    });
    // Confirmation watcher. Cheap: read the body text on each navigation and
    // whenever the client nudges us (a submit usually triggers one). When it
    // matches, capture the receipt ONCE and tell the client it's done.
    let captured = false;
    const tryCapture = async (reason) => {
      if (captured) return;
      const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
      if (!CONFIRM.test(body)) return;
      captured = true;
      const stamp = `${provider || "session"}-${sessionId}-${Date.now()}`;
      const png = path.join(SHOTS, stamp + ".png");
      const pdf = path.join(SHOTS, stamp + ".pdf");
      try { await page.screenshot({ path: png, fullPage: true }); } catch {}
      try { await page.pdf({ path: pdf, format: "Letter", printBackground: true }); } catch {}
      const conf = body.match(/confirmation\s*(?:number|#|code)?\s*:?\s*([A-Z0-9-]{5,})/i);
      log(`[${sessionId}] confirmation captured (${reason}) conf=${conf ? conf[1] : "?"}`);
      send({ type: "paid", confirmation: conf ? conf[1] : null, receipt: path.basename(pdf), screenshot: path.basename(png) });
    };
    page.on("framenavigated", (fr) => { if (fr === page.mainFrame()) tryCapture("nav").catch(() => {}); });

    const landing = startUrl || ENTRY[provider] || "about:blank";
    await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
    send({ type: "ready", sessionId });

    // Input in. Coordinates arrive already in page space (the client scales
    // the canvas). Text uses insertText so IME/paste behave; single keys use
    // dispatchKeyEvent so Tab/Enter/Backspace work in card fields.
    ws.on("message", async (raw) => {
      let ev; try { ev = JSON.parse(raw); } catch { return; }
      try {
        if (ev.type === "mousemove") await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ev.x, y: ev.y });
        else if (ev.type === "mousedown") await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: ev.x, y: ev.y, button: "left", clickCount: ev.clickCount || 1 });
        else if (ev.type === "mouseup") { await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ev.x, y: ev.y, button: "left", clickCount: ev.clickCount || 1 }); tryCapture("click").catch(() => {}); }
        else if (ev.type === "wheel") await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx || 0, deltaY: ev.dy || 0 });
        else if (ev.type === "text") await cdp.send("Input.insertText", { text: ev.text });
        else if (ev.type === "key") await cdp.send("Input.dispatchKeyEvent", { type: ev.down ? "keyDown" : "keyUp", key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.keyCode, text: ev.down ? ev.text : undefined });
        else if (ev.type === "check") tryCapture("client-check").catch(() => {});
      } catch (e) { /* a single dropped event must not kill the session */ }
    });
  } catch (e) {
    send({ type: "fatal", message: String(e && e.message || e).slice(0, 200) });
    await closeAll();
    ws.close(1011, "server error");
    return;
  }

  // Bound the session: card pages should be minutes, not hours. Idle-agnostic
  // hard cap so an abandoned tab can't hold a browser open forever.
  const hardStop = setTimeout(() => { send({ type: "expired" }); ws.close(4000, "session time limit"); }, 15 * 60 * 1000);
  ws.on("close", async () => { clearTimeout(hardStop); await closeAll(); log(`[${sessionId}] closed`); });
});

server.listen(PORT, () => log(`browser-stream listening on :${PORT}  (auth: ${TOKEN ? "token" : "OPEN — dev only"})`));
