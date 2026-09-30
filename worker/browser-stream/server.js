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
// Browser origins allowed to open a session (see the Origin check below).
const ALLOWED_ORIGINS = new Set((process.env.STREAM_ALLOWED_ORIGINS || "https://housify365.com,https://test.housify365.com")
  .split(",").map(s => s.trim()).filter(Boolean));
// Tokens already used to open a browser here, jti -> expiry ms; swept as they expire.
const SPENT_JTI = new Map();
setInterval(() => { const now = Date.now(); for (const [k, exp] of SPENT_JTI) if (exp < now) SPENT_JTI.delete(k); }, 60 * 1000).unref();
// Browsers open on this box right now.
const LIVE_SESSIONS = new Set();
const MAX_SESSIONS = Math.max(1, Number(process.env.STREAM_MAX_SESSIONS) || 3);
// Residential exit: a SOCKS5 proxy that Sheeba (the home Mac) publishes on
// this box's localhost through a reverse SSH tunnel. Checked per session so a
// sleeping Sheeba never blocks a payment -- it just goes direct.
const net = require("net");
const STREAM_HOME_PROXY = process.env.STREAM_HOME_PROXY || "";
// Providers whose payment session runs on Sheeba (see STREAM_DELEGATE_URL).
const DELEGATE_PROVIDERS = new Set((process.env.STREAM_DELEGATE_PROVIDERS || "washington_gas").split(",").map(s => s.trim()).filter(Boolean));   // e.g. socks5://127.0.0.1:1080
function proxyUp(url) {
  return new Promise(resolve => {
    try {
      const u = new URL(url);
      const sock = net.connect({ host: u.hostname, port: Number(u.port) });
      const t = setTimeout(() => { sock.destroy(); resolve(false); }, 1500);
      sock.on("connect", () => { clearTimeout(t); sock.destroy(); resolve(true); });
      sock.on("error", () => { clearTimeout(t); resolve(false); });
    } catch { resolve(false); }
  });
}

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

// Resolve an incoming provider STRING to its canonical playbook KEY.
//
// The client sends the provider NAME (utilities.provider, free text: "Washington
// Gas", "Wash Gas", "BGE"), but ENTRY, HUMAN_LOGIN, the session filename and
// getBook are all keyed by the playbook key ("washington_gas", "bge"). For
// Pepco/BGE the lowercased name happens to equal the key, so it worked; for
// "Washington Gas" it does not ("washington gas" != "washington_gas"), so the
// stream never left about:blank. Match by key, then by alias.
function resolveProviderKey(raw) {
  const p = String(raw || "").trim().toLowerCase();
  if (!p) return "";
  getBook(p); // force _PLAYBOOKS to load
  if (_PLAYBOOKS && _PLAYBOOKS[p]) return p;
  for (const [key, book] of Object.entries(_PLAYBOOKS || {})) {
    const aliases = (book.aliases || []).map(a => String(a).toLowerCase());
    if (key === p || aliases.some(a => p === a || p.includes(a))) return key;
  }
  return p;
}

// DECRYPT — same scheme as ensure-session.js / api/encrypt.js (PBKDF2-SHA256,
// 100k, AES-256-GCM, 16-byte tag appended). Duplicated on purpose.
// Key file FIRST (verbatim bytes, trailing newline kept); the env var is the
// fallback. Same precedence as worker/portals/credential-select.js.
function _masterKey() {
  let m = "";
  if (process.env.ENCRYPTION_KEY_FILE) { try { m = fs.readFileSync(process.env.ENCRYPTION_KEY_FILE, "utf8"); } catch {} }
  return m || process.env.ENCRYPTION_KEY;
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
    // waitFor, NOT isVisible: locator.isVisible() is an INSTANT check (its
    // timeout is ignored), so it returned false before BGE's JS-rendered Azure
    // B2C form appeared (~2-9s after the authorize redirect) and the flow fell
    // through to autoDrive on a not-yet-rendered login page. waitFor actually
    // waits; if no login field ever appears, the catch returns false and a
    // valid session drives on to the bill.
    // BGE's Azure B2C login can take ~15s to appear after the authorize
    // redirect (2026-09-30: nav 04:13:55 -> login 04:14:10). 12s gave up
    // first and drove on to "select account" on a login page. The captcha /
    // code portals get 45s; the rest keep 12s so a valid session is not slowed.
    // Wait up to 12s for the login form; keep waiting (to 45s) only while the
    // page is on a sign-in URL (authorize / b2c / login), so a valid session
    // is never held up waiting for a form that will not come.
    const onSignInUrl = () => /authorize|b2clogin|onmicrosoft|\/login|signin|sign-in/i.test(page.url());
    let visible = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      if (await userBox.isVisible().catch(() => false)) { visible = true; break; }
      if (Date.now() - t0 > 12000 && !onSignInUrl()) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!visible) return false;
    const creds = await fetchCredentials(book, companyId);
    if (!creds || !creds.username) { log(`[${sessionId}] login: no stored credentials for ${book.provider}`); return false; }
    await userBox.click(); await userBox.fill("").catch(() => {}); await userBox.pressSequentially(creds.username, { delay: 55 });
    const passBox = page.locator(book.loginFields?.pass || 'input[type="password"]').first();
    await passBox.click(); await passBox.fill("").catch(() => {}); await passBox.pressSequentially(creds.password, { delay: 55 });
    log(`[${sessionId}] login: pre-filled ${book.provider}`);
    // Sign in BY ITSELF now that this browser exits through Sheeba's home
    // connection: submit the form, and for BGE fetch the emailed code from
    // Sheeba's Mail through the tunnel (agent/code-service.js). Anything that
    // does not complete falls back to asking the person, as before.
    if (await autoSubmitLogin(page, book, send, sessionId).catch(() => false)) return "signed-in";
    // reCAPTCHA v3 returns "Invalid Captcha" for an automated click (tested on
    // Washington Gas from the data-centre IP), so the person clicks Log In
    // themselves -- their genuine interaction is what passes v3. BGE has no
    // captcha but a mailed/texted verification code (mfa).
    const codeHint = book.mfa ? " and enter the verification code they send you" : "";
    send({ type: "status", message: `Your ${book.provider} login is filled in \u2014 click \u201cLog In\u201d${codeHint}.` });
    return true;
  } catch (e) { log(`[${sessionId}] login fill failed: ${String(e.message).split("\n")[0].slice(0,70)}`); return false; }
}

// Wait until the person has finished signing in: the login form is gone AND
// no verification-code box is showing (a code screen also lacks the login
// form and must not read as "signed in" -- BGE). Polls; never interacts.
async function waitSignedIn(page, book, timeoutMs) {
  const userSig = (book && book.signedOutSignals || []).find(s => s.role === "textbox");
  const userBox = book && book.loginFields && book.loginFields.user
    ? page.locator(book.loginFields.user).first()
    : userSig ? page.getByRole("textbox", { name: userSig.name }).first()
    : page.locator('#signInName, input[type="email"]').first();
  const codeBox = page.locator('#emailVerificationCode, input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="verification" i]').first();
  const passBox = page.locator('input[type="password"]').first();
  const end = Date.now() + timeoutMs;
  let clearFor = 0;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, 2000));
    if (page.isClosed()) return false;
    const onLogin = await userBox.isVisible().catch(() => false) || await passBox.isVisible().catch(() => false);
    const onCode = await codeBox.isVisible().catch(() => false);
    // Two clear polls in a row, so a page mid-redirect is not taken as done.
    clearFor = (!onLogin && !onCode) ? clearFor + 1 : 0;
    if (clearFor >= 2) { await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {}); return true; }
  }
  return false;
}

// Ask Sheeba's code service (through the tunnel) for a BGE code received after
// sinceMs. null until one arrives.
function fetchBgeCode(sinceMs) {
  return new Promise(resolve => {
    const url = process.env.HOUSY_CODE_SERVICE_URL, tok = process.env.HOUSY_CODE_SERVICE_TOKEN, proxy = STREAM_HOME_PROXY;
    if (!url || !tok || !proxy) return resolve(null);
    const { execFile } = require("child_process");
    execFile("curl", ["-s", "-m", "60", "--socks5-hostname", proxy.replace(/^socks5h?:\/\//, ""),
      "-H", `x-code-token: ${tok}`, `${url}/bge-code?since=${sinceMs}`], { timeout: 65000 }, (err, out) => {
      if (err) return resolve(null);
      try { const c = JSON.parse(out).code; resolve(/^\d{6}$/.test(c || "") ? c : null); } catch { resolve(null); }
    });
  });
}

// Submit the filled login; for BGE, enter the emailed code. Returns true once
// the login form (and any code box) is gone -- i.e. signed in -- else false.
async function autoSubmitLogin(page, book, send, sessionId) {
  const submitSig = (book.signedOutSignals || []).find(s => s.role === "button");
  const submit = book.loginFields?.submit ? page.locator(book.loginFields.submit).first()
    : submitSig ? page.getByRole("button", { name: submitSig.name }).first()
    : page.getByRole("button", { name: /log ?in|sign ?in|continue/i }).first();
  send({ type: "status", message: `Signing in to ${book.provider}\u2026` });
  const sentAt = Date.now();
  await submit.click({ timeout: 8000 });
  log(`[${sessionId}] login: submitted ${book.provider} automatically`);
  const codeBox = page.locator('#emailVerificationCode, input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i], input[id*="verification" i]').first();
  const userBox = book.loginFields?.user ? page.locator(book.loginFields.user).first() : page.locator('input[type="password"]').first();
  let codeDone = false;
  const end = Date.now() + 4 * 60 * 1000;
  let clear = 0;
  while (Date.now() < end) {
    await new Promise(r => setTimeout(r, 2500));
    if (!codeDone && await codeBox.isVisible().catch(() => false)) {
      send({ type: "status", message: `${book.provider} sent a sign-in code \u2014 reading it from the inbox\u2026` });
      const code = await (async () => { for (let i = 0; i < 24 && Date.now() < end; i++) { const c = await fetchBgeCode(sentAt - 30000); if (c) return c; await new Promise(r => setTimeout(r, 4000)); } return null; })();
      if (!code) { log(`[${sessionId}] login: no ${book.provider} code arrived`); return false; }
      await codeBox.click().catch(() => {}); await codeBox.fill("").catch(() => {}); await codeBox.pressSequentially(code, { delay: 80 });
      const cont = page.getByRole("button", { name: /continue|verify|submit|confirm|next/i }).first();
      if (await cont.isVisible().catch(() => false)) await cont.click({ timeout: 8000 }).catch(() => {}); else await codeBox.press("Enter").catch(() => {});
      codeDone = true;
      log(`[${sessionId}] login: entered ${book.provider} code from Sheeba's Mail`);
      continue;
    }
    const onLogin = await userBox.isVisible().catch(() => false);
    const onCode = await codeBox.isVisible().catch(() => false);
    clear = (!onLogin && !onCode) ? clear + 1 : 0;
    if (clear >= 2) { log(`[${sessionId}] login: ${book.provider} signed in automatically`); return true; }
    // Still on the login form after 25s (e.g. reCAPTCHA refused the click): hand back.
    if (onLogin && !book.mfa && Date.now() - sentAt > 25000) { log(`[${sessionId}] login: automatic ${book.provider} sign-in not accepted -- asking the person`); return false; }
  }
  return false;
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
    catch (e) { log(`[${sessionId}] auto-drive stop at "${label}": ${String(e.message).split("\n").filter(l => l.trim()).slice(0, 8).join(" | ").slice(0, 600)}`); return false; }
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
      // Only the DEFAULT account's row shows its buttons; every other row is
      // collapsed until its "View" is clicked (2026-09-30: Pay timed out on a
      // collapsed row). Expand first when Pay is not there.
      const payIn = (row) => row.getByRole("link", { name: /^pay$/i }).or(row.getByRole("button", { name: /^pay$/i })).first();
      let row = accounts.accountRow(page, claims.account);
      let pay = payIn(row);
      if (!(await pay.isVisible().catch(() => false))) {
        const view = row.getByRole("link", { name: /^view$/i }).or(row.getByRole("button", { name: /^view$/i })).first();
        await view.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
        await view.click({ timeout: 8000 });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1500);
        row = accounts.accountRow(page, claims.account); pay = payIn(row);
      }
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
      // Log the form's inputs (never their values) so a portal whose amount
      // box we can't find shows what it does have.
      const fields = await page.evaluate(() => [...document.querySelectorAll("input, select")]
        .filter(el => el.type !== "hidden" && el.offsetParent !== null)
        .map(el => {
          const lab = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("aria-label") || el.placeholder || "";
          return `${el.tagName.toLowerCase()}[${el.type}] #${el.id} name=${el.name} dis=${el.disabled} "${lab.trim().slice(0, 50)}"`;
        }).slice(0, 40)).catch(() => []);
      log(`[${sessionId}] pay form fields: ${JSON.stringify(fields)}`);
      if (pay.otherAmountSelector && await page.locator(pay.otherAmountSelector).count().catch(() => 0)) {
        // Styled radios hide the real input under a drawn circle; click its
        // label like a person, and confirm the choice took.
        const radio = page.locator(pay.otherAmountSelector).first();
        const id = await radio.getAttribute("id").catch(() => null);
        const label = id ? page.locator(`label[for="${id}"]`).first() : null;
        if (label && await label.count().catch(() => 0)) await label.click({ timeout: 4000 });
        else await radio.check({ timeout: 4000, force: true });
        if (!(await radio.isChecked().catch(() => false))) await radio.check({ timeout: 4000, force: true });
        if (!(await radio.isChecked().catch(() => false))) throw new Error("Other Amount did not select");
      } else {
        for (const re of (pay.otherAmountRadio || [])) {
          const r = page.getByText(re).first();
          if (await r.count().catch(() => 0)) { await r.click({ timeout: 4000 }).catch(() => {}); break; }
        }
      }
      await page.waitForTimeout(800);
      // The box LABELLED "Payment Amount" -- not "the first visible text box",
      // which on BGE was another field (2026-09-30: $5 asked, $403.67 left).
      // Type it like a person: BGE's box is currency-formatted and ignores a
      // programmatic fill. Then read it back.
      const amt = Number(claims.amount).toFixed(2);
      let box = pay.amountBoxSelector ? page.locator(pay.amountBoxSelector).first() : page.getByLabel(/payment amount|amount to pay|other amount/i).first();
      if (!(await box.count().catch(() => 0))) box = page.getByLabel(/payment amount|amount to pay|other amount/i).first();
      if (!(await box.count().catch(() => 0))) box = page.locator('input[inputmode="decimal"]:visible, input[type="number"]:visible, input[type="text"]:visible').first();
      await box.click({ clickCount: 3, timeout: 5000 });
      await page.keyboard.press("ControlOrMeta+A").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
      await box.pressSequentially(amt, { delay: 60 });
      await box.press("Tab").catch(() => {});
      await page.waitForTimeout(600);
      const v = (await box.inputValue().catch(() => "")).replace(/[^0-9.]/g, "");
      if (Number(v) !== Number(amt)) throw new Error(`amount box reads "${v}", wanted ${amt}`);
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
  // A page on another site could open this socket from a victim's browser
  // (browsers always send Origin). Only the app's origins may; non-browser
  // clients (the delegating Oracle server, test tools) send no Origin.
  const origin = String(req.headers.origin || "");
  if (origin && !ALLOWED_ORIGINS.has(origin)) { log(`origin refused: ${origin}`); ws.close(4003, "origin not allowed"); return; }
  // Provider comes from the SIGNED token whenever a secret is configured --
  // never from the query string, which would let the client pick which
  // portal's saved sign-in and stored credentials get loaded. The bare
  // query-string form survives only for secret-less local dev.
  const provider = resolveProviderKey(JWT_SECRET ? (claims?.provider || "") : (claims?.provider || url.searchParams.get("provider") || ""));
  if (JWT_SECRET && !provider) { ws.close(4001, "token names no provider"); return; }
  // This box serves ONE company's portals. A token minted for another company
  // must not open its sessions here.
  if (process.env.HOUSY_COMPANY_ID && claims?.companyId && claims.companyId !== process.env.HOUSY_COMPANY_ID) {
    log(`company refused: ${claims.companyId}`); ws.close(4003, "wrong company"); return;
  }
  // The landing page is always the portal's own entry. A client-chosen URL
  // used to be honoured here: a real Chromium holding the portal's cookies,
  // steerable to any address (2026-09-30 audit).
  const startUrl = null;
  const sessionId = crypto.randomBytes(4).toString("hex");
  const send = (obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };
  log(`[${sessionId}] connect provider=${provider || "-"}`);

  // Washington Gas runs on SHEEBA's own payment browser (a real, visible
  // Chrome on the home connection): reCAPTCHA v3 refuses this box's headless
  // Chrome ("Invalid Captcha") even through the home proxy. STREAM_DELEGATE_URL
  // is Sheeba's server, reached through its reverse tunnel. The client's
  // websocket is piped to it unchanged (same signed token, verified again
  // there). Sheeba unreachable -> handled here as before.
  const delegate = DELEGATE_PROVIDERS.has(provider) && process.env.STREAM_DELEGATE_URL;
  if (delegate && await proxyUp(delegate.replace(/^ws/, "http"))) {
    log(`[${sessionId}] delegating ${provider} to Sheeba`);
    const up = new (require("ws"))(delegate.replace(/\/$/, "") + req.url);
    const pending = [];
    up.on("open", () => { for (const m of pending.splice(0)) up.send(m); });
    ws.on("message", (m, isBinary) => { const d = isBinary ? m : m.toString(); if (up.readyState === 1) up.send(d); else pending.push(d); });
    up.on("message", (m, isBinary) => { try { ws.send(isBinary ? m : m.toString()); } catch {} });
    const done = (why) => { log(`[${sessionId}] closed (delegated: ${why})`); try { ws.close(); } catch {} try { up.close(); } catch {} };
    ws.on("close", () => done("client"));
    up.on("close", () => done("sheeba"));
    up.on("error", (e) => { send({ type: "status", message: "Couldn't reach the home computer for this payment \u2014 please try again." }); done("error " + e.message); });
    return;
  }

  // One browser per token, a few browsers per box. The token's jti was minted
  // but never checked, so a captured token opened unlimited parallel
  // sessions until it expired; and nothing capped how many Chromiums a box
  // would launch. (Marked here, after delegation, so a Washington Gas token
  // is spent on Sheeba where the browser actually runs, not on both boxes.)
  const jti = claims?.jti ? String(claims.jti) : null;
  if (jti) {
    if (SPENT_JTI.has(jti)) { log(`[${sessionId}] token already used`); ws.close(4001, "token already used"); return; }
    SPENT_JTI.set(jti, Number(claims.exp) || Date.now() + 15 * 60 * 1000);
  }
  if (LIVE_SESSIONS.size >= MAX_SESSIONS) {
    log(`[${sessionId}] refused: ${LIVE_SESSIONS.size} sessions already open`);
    send({ type: "status", message: "The payment browser is busy right now — please try again in a few minutes." });
    ws.close(4029, "busy"); return;
  }
  LIVE_SESSIONS.add(sessionId);
  ws.once("close", () => LIVE_SESSIONS.delete(sessionId));

  // Make sure the signed-in session is live before opening the browser, so the
  // stream never lands the person on the portal's login page.
  // Skip the headless freshen when the person explicitly opened "Log in"
  // (enroll): they intend to sign in by hand in the stream, so attempting a
  // headless login first just wastes ~90s and burns a reCAPTCHA-scored attempt
  // (which is exactly what fails for WSSC/WG from the box's datacenter IP).
  if (CAN_LOGIN && ENTRY[provider] && !HUMAN_LOGIN[provider] && !claims?.enroll) {
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
    // Go out through Sheeba's home connection when its tunnel is up, so
    // portals that score logins by IP (Washington Gas's reCAPTCHA) see a
    // residential address, not this data-centre box. Tunnel down -> direct.
    const viaHome = STREAM_HOME_PROXY && await proxyUp(STREAM_HOME_PROXY);
    const proxyOpt = viaHome ? { proxy: { server: STREAM_HOME_PROXY } } : {};
    log(`[${sessionId}] network: ${viaHome ? "via home connection (Sheeba)" : "direct (Oracle box)"}`);
    browser = await (async () => {
      // STREAM_HEADED=1 (Sheeba): a real, visible Chrome -- what reCAPTCHA v3
      // (Washington Gas) accepts. The Oracle box stays headless.
      const headless = process.env.STREAM_HEADED !== "1";
      try { return await chromium.launch({ channel: "chrome", headless, ...proxyOpt }); }
      catch { return await chromium.launch({ headless, ...proxyOpt }); }
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
      // The amount ACTUALLY charged, read off the confirmation page -- the
      // receipt's truth, which can differ from the approved figure (a portal
      // minimum, a fee, or an amount changed on the portal). Best-effort parse
      // near a payment/total label, plus any labelled convenience fee.
      // Labels tried IN ORDER, most specific first. One alternation with a
      // bare "paid" in it matched the first figure after any "paid" on the
      // page -- Pepco's receipt reads "Payment Amount $5.13 · $0.13
      // Convenience Fee Included" and the payment was recorded as $0.13.
      const AMT_LABELS = [
        /payment amount\s*:?\s*\$\s*([\d,]+\.\d{2})/i,
        /amount paid\s*:?\s*\$\s*([\d,]+\.\d{2})/i,
        /total (?:amount )?(?:paid|charged)\s*:?\s*\$\s*([\d,]+\.\d{2})/i,
        /you (?:paid|are paying)\s*:?\s*\$\s*([\d,]+\.\d{2})/i,
      ];
      let amtM = null;
      for (const re of AMT_LABELS) { amtM = body.match(re); if (amtM) break; }
      const observedAmount = amtM ? Number(amtM[1].replace(/,/g, "")) : null;
      const feeM = body.match(/\$\s*([\d,]+\.\d{2})\s*(?:convenience|service|processing)\s*fee|(?:convenience|service|processing)\s*fee[^$]{0,24}\$\s*([\d,]+\.\d{2})/i);
      const observedFee = feeM ? Number((feeM[1] || feeM[2]).replace(/,/g, "")) : null;
      log(`[${sessionId}] confirmation captured (${reason}) conf=${conf ? conf[1] : "?"} observed=${observedAmount ?? "?"} fee=${observedFee ?? "-"}`);
      send({ type: "paid", confirmation: conf ? conf[1] : null, amount: observedAmount, receipt: path.basename(pdf), screenshot: path.basename(png) });

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
              amount: claims.amount, observedAmount, observedFee, confirmation: conf ? conf[1] : null,
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
      if (filled !== "signed-in") send({ type: "status", message: pay ? "Click “Log In” — once you're signed in, it takes you straight to the payment page." : "Once you're signed in, close this window and it's connected." });
      // The person clicks Log In (their real click is what passes reCAPTCHA v3)
      // and types any emailed code; then carry on BY ITSELF to the payment
      // page instead of leaving them to find the bill. Runs in the background
      // so the stream starts immediately.
      if (pay) {
        (async () => {
          const ok = await waitSignedIn(page, getBook(provider), 5 * 60 * 1000);
          if (!ok) { log(`[${sessionId}] auto-drive: not signed in within 5 min -- left for the person`); return; }
          log(`[${sessionId}] signed in by the person -- continuing to the payment page`);
          send({ type: "status", message: "Signed in — taking you to the payment page…" });
          await autoDrive(page, provider, claims, send, sessionId).catch(() => {});
        })().catch(() => {});
      }
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

server.listen(PORT, process.env.STREAM_BIND || undefined, () => log(`browser-stream listening on :${PORT}  (auth: ${JWT_SECRET ? "signed tokens" : TOKEN ? "static token" : "OPEN — dev only"}, max ${MAX_SESSIONS} sessions)`));
