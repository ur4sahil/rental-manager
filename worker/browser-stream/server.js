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

// AUTO-DRIVE to the card-entry page. These are the clicks that carry no secret:
// select the account, open Pay, choose the amount (full or the person's number)
// and the method (card/ACH) they already picked in Housy, and advance to where
// the card is typed. It STOPS there -- the card and the final submit are always
// the person's. Best-effort and non-fatal: if any step's selector has changed,
// it stops and the person drives the rest by hand in the same live stream.
async function autoDrive(page, provider, claims, send, sessionId) {
  if (provider !== "wssc" || !claims || !claims.account) return;
  let accounts = null;
  for (const p of [path.join(__dirname, "portals", "accounts"), path.join(__dirname, "..", "portals", "accounts")]) {
    try { accounts = require(p); if (accounts) break; } catch {}
  }
  if (!accounts) { log(`[${sessionId}] auto-drive: accounts module not found`); return; }
  const step = async (label, fn) => {
    try { await fn(); log(`[${sessionId}] auto-drive: ${label}`); return true; }
    catch (e) { log(`[${sessionId}] auto-drive stop at "${label}": ${String(e.message).split("\n")[0].slice(0, 70)}`); return false; }
  };
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
  if (!await step("open account payment", async () => {
    // Click the account row's own "Pay" link directly. The generic account
    // selector clicks "View" first, which times out ~8s per candidate on WSSC's
    // actionability checks (~40s total); the row's Pay link goes straight to
    // the payment page in ~1s, and the row already shows its balance so no
    // "expand" step is needed.
    const pay = accounts.accountRow(page, claims.account).getByRole("link", { name: /^pay$/i }).first();
    await pay.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await pay.click({ timeout: 8000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
  })) return;
  if (!await step("Make a Payment", async () => {
    await page.getByRole("link", { name: /make a payment/i }).first().click({ timeout: 8000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
  })) return;
  // These are PrimeFaces radios: the real <input> is visually hidden, so we
  // click the associated <label for=...>, which fires PrimeFaces' own handler.
  // "Last Statement Balance" (DUE_AMOUNT) is checked by default; the METHOD
  // radios are NOT, and an unselected method is what made "Next" bounce.
  await step("set amount", async () => {
    // "Last Statement Balance" (DUE_AMOUNT) is checked by default; only touch
    // the radios for a custom amount. Each PrimeFaces radio/field change fires
    // an AJAX re-render, so settle between steps or the next click races it.
    if (!claims.full && claims.amount != null) {
      await page.locator('label[for="PaymentAmountRadioGroup:1"]').click({ timeout: 5000 }); // Other Amount
      await page.waitForTimeout(1200);
      await page.locator('input[type="text"]:visible, input[type="number"]:visible').first()
        .fill(String(claims.amount), { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  });
  await step("set method", async () => {
    // Method is NOT selected by default -- an unset method is what makes "Next"
    // bounce with a validation error. Click and VERIFY it took (the amount
    // re-render above can eat the first click), retrying a couple of times.
    const id = claims.method === "ach" ? "PaymentMethodRadioGroup:1" : "PaymentMethodRadioGroup:0";
    for (let i = 0; i < 3; i++) {
      await page.locator(`label[for="${id}"]`).click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(700);
      if (await page.locator(`input[id="${id}"]`).isChecked().catch(() => false)) break;
    }
  });
  // STOP HERE, deliberately. This page discloses the processor's fees and (for
  // card over $750) splits the charge into several transactions, then asks the
  // person to tick "I agree to pay the amount stated above." Agreeing to a fee
  // and a total is the person's decision, not automation's -- so we leave the
  // amount and method chosen, and hand over at the agreement.
  log(`[${sessionId}] auto-drive finished at ${page.url()} (amount + method set; awaiting agreement)`);
  send({ type: "status", message: "Review the total and fees, tick “I agree”, click Next, then enter your card." });
}

const server = http.createServer((req, res) => {
  // A bare health check for the tunnel/monitor; everything real is WS.
  if (req.url.startsWith("/health")) { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(426); res.end("websocket only");
});
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });

// Freshen the portal's signed-in session before a pay session opens. WSSC's
// session lasts ~an hour -- far shorter than the gap between the daily cron's
// refreshes -- so by the time someone pays, the stored session is usually
// expired and the stream would land on the portal login page. ensure-session
// reuses a live session or logs in (creds fetched over the worker API,
// decrypted with the on-box encryption key). It needs those env vars, so this
// is a safe no-op when they are absent.
const CAN_LOGIN = !!(process.env.ENCRYPTION_KEY_FILE || process.env.ENCRYPTION_KEY)
  && !!process.env.HOUSY_API_BASE && !!process.env.AI_WORKER_TOKEN;
function freshenSession(provider) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, "portals", "ensure-session.js");
    if (!fs.existsSync(script)) return resolve({ ok: false, reason: "no ensure-session" });
    const cp = require("child_process").spawn(process.execPath, [script, provider], { cwd: __dirname, env: process.env });
    let out = "";
    cp.stdout.on("data", (d) => { out += d; });
    cp.stderr.on("data", () => {});
    const t = setTimeout(() => { try { cp.kill("SIGKILL"); } catch {} resolve({ ok: false, reason: "timeout" }); }, 120000);
    cp.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0, code }); });
  });
}

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

  // Make sure the signed-in session is live before opening the browser, so the
  // stream never lands the person on the portal's login page.
  if (CAN_LOGIN && ENTRY[provider]) {
    send({ type: "status", message: `Signing in to ${provider.toUpperCase()}…` });
    const r = await freshenSession(provider);
    log(`[${sessionId}] freshen ${provider}: ${r.ok ? "ok" : "failed(" + (r.reason || r.code) + ")"}`);
  }

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
    // Kill smooth scrolling on every page. When the auto-drive scrolls to an
    // account far down a long list, an animated scroll streams as a long crawl
    // that reads as "it keeps scrolling"; instant jumps stream as a single step.
    await context.addInitScript(() => {
      const apply = () => { try {
        const s = document.createElement("style");
        s.textContent = "html,body,*{scroll-behavior:auto !important}";
        (document.head || document.documentElement).appendChild(s);
      } catch {} };
      if (document.head || document.documentElement) apply();
      document.addEventListener("DOMContentLoaded", apply);
    });
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

      // Persist it: upload the receipt PDF and mark the bill paid/partial. The
      // approved payment row was created when the token was minted, so record-
      // utility-payment can match the amount. Best-effort -- the payment already
      // succeeded at the provider; a failure here only means it did not auto-file.
      if (CAN_LOGIN && claims && claims.paymentId && claims.billId && claims.companyId) {
        try {
          const pdfBuf = fs.readFileSync(pdf);
          const API = String(process.env.HOUSY_API_BASE || "").replace(/\/$/, "");
          const headers = { "Content-Type": "application/json", "x-worker-token": process.env.AI_WORKER_TOKEN };
          if (process.env.VERCEL_BYPASS_TOKEN) headers["x-vercel-protection-bypass"] = process.env.VERCEL_BYPASS_TOKEN;
          const rr = await fetch(API + "/api/ai?action=record-utility-payment", {
            method: "POST", headers,
            body: JSON.stringify({
              companyId: claims.companyId, paymentId: claims.paymentId, billId: claims.billId,
              amount: claims.amount, confirmation: conf ? conf[1] : null,
              receiptBase64: pdfBuf.toString("base64"),
              receiptFilename: (provider || "utility") + "-" + (claims.account || "receipt"),
            }),
          });
          const jj = await rr.json().catch(() => ({}));
          log(`[${sessionId}] record payment -> HTTP ${rr.status} ${jj.bill_status || jj.error || ""}`);
        } catch (e) { log(`[${sessionId}] record payment failed: ${String(e.message).slice(0, 90)}`); }
      }
    };
    // A screenshot on each PAGE LOAD — for us to watch the flow and debug.
    // Deliberately on navigation only, never on a timer: a page has just
    // loaded and the card fields are blank, so this can't capture a typed card
    // number. (The card-entry page is caught here empty; nothing polls it.)
    let navSeq = 0;
    page.on("framenavigated", async (fr) => {
      if (fr !== page.mainFrame()) return;
      navSeq++;
      const shot = path.join(SHOTS, `${provider || "s"}-${sessionId}-nav${String(navSeq).padStart(2, "0")}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      log(`[${sessionId}] nav#${navSeq} ${page.url()} -> ${path.basename(shot)}`);
      tryCapture("nav").catch(() => {});
    });

    const landing = startUrl || ENTRY[provider] || "about:blank";
    await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    // Drive to the amount/card page BEFORE the live view starts, so the person
    // sees the final page appear instead of watching the browser scroll a long
    // account list. Best-effort: wherever it lands is where streaming begins.
    send({ type: "status", message: "Opening your bill…" });
    await autoDrive(page, provider, claims, send, sessionId).catch(() => {});
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
