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
  // SMECO has no billing portal of its own -- sign-in is hosted on Opower.
  smeco: "https://dss-smcc.opower.com",
};

// Portals whose login a headless bot cannot pass: Washington Gas scores every
// login through reCAPTCHA v3 (a datacenter IP fails silently), and BGE mails a
// one-time code. For these, DON'T burn 90s on a headless freshen -- reuse a
// saved session if one is on disk, else the person signs in inside the stream
// (real Chrome + real interaction pass v3), and we save that session on close.
const HUMAN_LOGIN = { washington_gas: true, bge: true };

// PLAYBOOKS: loaded once, for login-field selectors + provider aliases.
let _PLAYBOOKS = null;
function getBook(provider) {
  if (!_PLAYBOOKS) {
    for (const base of [path.join(__dirname, "portals"), path.join(__dirname, "..", "portals")]) {
      try { ({ PLAYBOOKS: _PLAYBOOKS } = require(path.join(base, "playbooks"))); if (_PLAYBOOKS) break; } catch {}
    }
  }
  return (_PLAYBOOKS && _PLAYBOOKS[provider]) || null;
}

// DECRYPT — same scheme as ensure-session.js / api/encrypt.js (PBKDF2-SHA256,
// 100k, AES-256-GCM, 16-byte tag appended). Duplicated on purpose.
function _masterKey() {
  let m = process.env.ENCRYPTION_KEY;
  if (!m && process.env.ENCRYPTION_KEY_FILE) { try { m = fs.readFileSync(process.env.ENCRYPTION_KEY_FILE, "utf8"); } catch {} }
  return m;
}
function _decrypt(master, b64, ivHex, saltHex) {
  if (!b64 || !ivHex || !saltHex) return "";
  const key = crypto.pbkdf2Sync(master, Buffer.from(saltHex, "hex"), 100000, 32, "sha256");
  const combined = Buffer.from(b64, "base64"); const TAG = 16;
  if (combined.length < TAG) return "";
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  d.setAuthTag(combined.slice(combined.length - TAG));
  return Buffer.concat([d.update(combined.slice(0, combined.length - TAG)), d.final()]).toString("utf8");
}
// Fetch + decrypt a portal login. The box holds the encryption key but no
// service key, so it asks the app for the ciphertext over the worker API.
async function fetchCredentials(book, companyId) {
  const master = _masterKey(); if (!master || !book) return null;
  const API = String(process.env.HOUSY_API_BASE || "").replace(/\/$/, "");
  const TOKEN = process.env.AI_WORKER_TOKEN || "";
  const COMPANY = companyId || process.env.HOUSY_COMPANY_ID;
  if (!API || !TOKEN || !COMPANY) return null;
  const headers = { "Content-Type": "application/json", "x-worker-token": TOKEN };
  if (process.env.VERCEL_BYPASS_TOKEN) headers["x-vercel-protection-bypass"] = process.env.VERCEL_BYPASS_TOKEN;
  let rows = [];
  try {
    const r = await fetch(`${API}/api/ai?action=portal-credentials`, {
      method: "POST", headers, body: JSON.stringify({ companyId: COMPANY, provider: book.provider }),
    });
    if (!r.ok) return null;
    rows = (await r.json().catch(() => ({}))).credentials || [];
  } catch { return null; }
  const aliases = (book.aliases || []).map(a => a.toLowerCase());
  const m = rows.find(r => { const p = String(r.provider || "").trim().toLowerCase(); return aliases.some(a => p === a || p.includes(a)); });
  if (!m) return null;
  try {
    return {
      username: _decrypt(master, m.username_encrypted, m.encryption_iv_username, m.encryption_salt),
      password: _decrypt(master, m.password_encrypted, m.encryption_iv, m.encryption_salt),
    };
  } catch { return null; }
}
// Enroll helper: fill the login form so the person only has to click Log in
// (their real click is what passes reCAPTCHA v3). Returns true if it filled.
async function autoFillLogin(page, book, companyId, send, sessionId) {
  if (!book) return false;
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    // Find the username field: the book's explicit selector, else its signed-out
    // textbox signal, else a generic email / Azure-B2C (#signInName) guess. This
    // mirrors ensure-session.js so the streamed browser can fill the same B2C
    // form the sweep does. BGE/Pepco carry no loginFields (only signedOutSignals)
    // and used to fall straight through here unfilled -- which, once a saved
    // session expired, left the person on a blank login page.
    const userSig = (book.signedOutSignals || []).find(s => s.role === "textbox");
    const userBox = book.loginFields?.user
      ? page.locator(book.loginFields.user).first()
      : userSig
        ? page.getByRole("textbox", { name: userSig.name }).first()
        : page.locator('#signInName, input[type="email"], input[name*="user" i], input[id*="user" i]').first();
    if (!await userBox.isVisible({ timeout: 6000 }).catch(() => false)) return false;
    const creds = await fetchCredentials(book, companyId);
    if (!creds || !creds.username) { log(`[${sessionId}] login: no stored credentials for ${book.provider}`); return false; }
    await userBox.click(); await userBox.pressSequentially(creds.username, { delay: 55 });
    const passBox = page.locator(book.loginFields?.pass || 'input[type="password"]').first();
    await passBox.click(); await passBox.pressSequentially(creds.password, { delay: 55 });
    log(`[${sessionId}] login: pre-filled ${book.provider}`);
    // reCAPTCHA v3 returns "Invalid Captcha" for an automated click (tested on
    // Washington Gas), so the person clicks Log In themselves -- their genuine
    // interaction is what passes v3. BGE has no captcha but a mailed/texted
    // verification code (mfa), which also needs the person, so we stop here too.
    const codeHint = book.mfa ? " and enter the verification code they send you" : "";
    send({ type: "status", message: `Your ${book.provider} login is filled in \u2014 click \u201cLog In\u201d${codeHint}.` });
    return true;
  } catch (e) { log(`[${sessionId}] login fill failed: ${String(e.message).split("\n")[0].slice(0,70)}`); return false; }
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// AUTO-DRIVE to the card-entry page. These are the clicks that carry no secret:
// select the account, open Pay, choose the amount (full or the person's number)
// and the method (card/ACH) they already picked in Housy, and advance to where
// the card is typed. It STOPS there -- the card and the final submit are always
// the person's. Best-effort and non-fatal: if any step's selector has changed,
// it stops and the person drives the rest by hand in the same live stream.
async function autoDrive(page, provider, claims, send, sessionId) {
  if (!claims || !claims.account) return;
  // Load the shared account + playbook modules from wherever they sit relative
  // to this file (repo layout vs. deployed layout).
  let accounts = null, PLAYBOOKS = null;
  for (const base of [path.join(__dirname, "portals"), path.join(__dirname, "..", "portals")]) {
    try { if (!accounts) accounts = require(path.join(base, "accounts")); } catch {}
    try { if (!PLAYBOOKS) ({ PLAYBOOKS } = require(path.join(base, "playbooks"))); } catch {}
    if (accounts && PLAYBOOKS) break;
  }
  if (!accounts) { log(`[${sessionId}] auto-drive: accounts module not found`); return; }
  const step = async (label, fn) => {
    try { await fn(); log(`[${sessionId}] auto-drive: ${label}`); return true; }
    catch (e) { log(`[${sessionId}] auto-drive stop at "${label}": ${String(e.message).split("\n")[0].slice(0, 70)}`); return false; }
  };
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);

  // ───────────────────────── WSSC ─────────────────────────
  // Hand-tuned and proven end to end. WSSC is PrimeFaces, not the Exelon/Opower
  // shape the generic path below assumes, so it keeps its own steps.
  if (provider === "wssc") {
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
    // card over $750) splits the charge, then asks the person to tick "I agree".
    log(`[${sessionId}] auto-drive finished at ${page.url()} (amount + method set; awaiting agreement)`);
    send({ type: "status", message: "Review the total and fees, tick \u201cI agree\u201d, click Next, then enter your card." });
    return;
  }

  // ──────────────────── Generic (Exelon/Opower + others) ────────────────────
  // Best-effort, and deliberately conservative: it selects the account and opens
  // the payment page, and for a PARTIAL payment tries to set the amount -- then
  // STOPS. It never clicks the recipe's `commit`, and it does not blind-advance
  // past the payment page, because these selectors are candidates (confirmed
  // only in read runs) and the card-entry location differs per portal. The
  // stream is interactive, so wherever the drive stops, the person finishes by
  // hand. As each provider is proven live, its steps get extended past here.
  const book = PLAYBOOKS && PLAYBOOKS[provider];
  const pay = book && book.pay;
  if (!pay) {
    log(`[${sessionId}] auto-drive: no pay recipe for ${provider || "(none)"} -- leaving on the landing page`);
    send({ type: "status", message: "Signed in. Navigate to the bill and enter your card to pay." });
    return;
  }

  // Land on the signed-in chooser first. A plain entry can redirect to a
  // marketing page (Pepco/BGE), where the account switcher isn't present.
  if (book.signedInEntry) {
    await step("open account chooser", async () => {
      await page.goto(book.signedInEntry, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);
    });
  }
  if (!await step("select account", async () => {
    const sel = await accounts.selectAccountAny(page, claims.account);
    if (!sel || !sel.ok) throw new Error((sel && sel.reason) || "account not selected");
    await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1000);
  })) { send({ type: "status", message: "Couldn't select the account automatically \u2014 pick it and continue." }); return; }

  if (!await step("Make a Payment", async () => {
    // A button (Pepco's billing-summary "Pay Bill") wins over the same-named
    // nav link, which goes to a marketing page.
    const btn = page.getByRole("button", { name: pay.payNav }).first();
    const nav = (await btn.count().catch(() => 0)) ? btn : page.getByRole("link", { name: pay.payNav }).first();
    await nav.click({ timeout: 8000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
  })) { send({ type: "status", message: "Couldn't open the payment page automatically \u2014 continue from here." }); return; }

  // Provider-specific hop from the pay landing to the card form (Pepco/BGE show
  // a "Pay Online" card before the processor page).
  if (pay.payOnline) {
    await step("Pay Online", async () => {
      const byRole = page.getByRole("link", { name: pay.payOnline }).first();
      if (await byRole.count().catch(() => 0)) await byRole.click({ timeout: 8000 });
      else await page.getByText(pay.payOnline).first().click({ timeout: 8000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2500);
    });
  }

  if (!claims.full && claims.amount != null) {
    await step("set other amount", async () => {
      for (const re of (pay.otherAmountRadio || [])) {
        const r = page.getByText(re).first();
        if (await r.count().catch(() => 0)) { await r.click({ timeout: 4000 }).catch(() => {}); break; }
      }
      await page.waitForTimeout(800);
      await page.locator('input[type="text"]:visible, input[type="number"]:visible').first()
        .fill(String(claims.amount), { timeout: 5000 }).catch(() => {});
    });
  }

  log(`[${sessionId}] auto-drive finished at ${page.url()} (on the payment page)`);
  send({ type: "status", message: "On the payment page \u2014 choose your amount, enter your card, and submit." });
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
  if (CAN_LOGIN && ENTRY[provider] && !HUMAN_LOGIN[provider]) {
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
    // Enroll, OR a PAY on a captcha/code portal that has no session yet: sign
    // in FIRST. Driving a pay flow on a page that isn't signed in is what left
    // the person staring at a blank canvas -- there's nothing to pay until they
    // log in. Auto-fill the login and tell them so.
    // Try a login fill whenever the provider needs a human login (or we're
    // enrolling). autoFillLogin only fills when a login field is actually on
    // screen, so this ALSO catches an EXPIRED saved session that has bounced us
    // to the login page: the old code trusted the session file, ran autoDrive on
    // the login page, and left the person stuck (BGE's cookies lapse in hours).
    // If no login field is present the session is still good, so drive to the bill.
    const pay = !claims?.enroll;
    const filled = (claims?.enroll || HUMAN_LOGIN[provider])
      ? await autoFillLogin(page, getBook(provider), claims.companyId, send, sessionId).catch(() => false)
      : false;
    if (filled) {
      send({ type: "status", message: pay ? "Once you're signed in, open your bill and pay it here." : "Once you're signed in, close this window and it's connected." });
    } else if (pay) {
      await autoDrive(page, provider, claims, send, sessionId).catch(() => {});
    } else {
      send({ type: "status", message: `Sign in to ${(provider || "the portal").toUpperCase()} — once you're in, close this window and it's connected.` });
    }
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
  // Persist a human sign-in for the daily fetch to reuse. Guarded: never
  // overwrite a good session with a signed-out one (a visible password field
  // means they never got past login).
  const saveSession = async () => {
    if (!CAN_LOGIN || !provider || !context) return;
    try {
      const stillOnLogin = await page.locator('input[type="password"]:visible').count().catch(() => 1);
      if (stillOnLogin > 0) { log(`[${sessionId}] not saving ${provider} — still on a login page`); return; }
      const state = await context.storageState();
      if (!state.cookies || !state.cookies.length) return;
      fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(SESSION_DIR, `${provider}.json`), JSON.stringify(state), { mode: 0o600 });
      log(`[${sessionId}] saved ${provider} session (${state.cookies.length} cookies)`);
    } catch (e) { log(`[${sessionId}] save ${provider} session failed: ${String(e.message).split("\n")[0].slice(0, 80)}`); }
  };
  ws.on("close", async () => { clearTimeout(hardStop); await saveSession(); await closeAll(); log(`[${sessionId}] closed`); });
});

server.listen(PORT, () => log(`browser-stream listening on :${PORT}  (auth: ${TOKEN ? "token" : "OPEN — dev only"})`));
