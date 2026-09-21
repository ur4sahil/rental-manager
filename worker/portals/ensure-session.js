#!/usr/bin/env node
// Make sure a portal session is live — signing in by itself if it is not.
//
//   node worker/portals/ensure-session.js washington_gas
//   node worker/portals/ensure-session.js wssc --headed
//
// WHY THIS EXISTS
//
// enroll.js opens a browser and waits for a PERSON to sign in. That is the
// right design for the first enrollment and the wrong one for every run
// after it: Washington Gas sessions die within hours, so anything that
// depends on a saved session needs a human in front of a browser before it
// can do anything. The nightly sweep inherits the same problem and simply
// reads nothing once the session lapses.
//
// This signs in on its own, with the account holder's own credentials, typed
// into the site's own form. That is the standard playbooks.js already sets
// out and the reason it was able to correct itself: "the line that matters is
// not 'is a captcha present' but 'does an honest sign-in work'". WSSC signs
// in with three captcha elements on the page, because reCAPTCHA v3 is an
// invisible score rather than a challenge.
//
// WHAT THIS IS NOT
//
// No stealth plugin, no fingerprint spoofing, no IP rotation, no attempt to
// solve, replay or bypass a challenge. If a portal puts a real challenge in
// the way, or wants a code sent to a phone, this stops and says so. BGE is
// exactly that case: it mails a verification code, so it will not sign IN on
// its own -- but it will still REUSE a session a person created with
// enroll.js, so a BGE payment works once that manual sign-in exists.
//
// THE KEY
//
// Credentials are stored encrypted and only ENCRYPTION_KEY opens them. It is
// read from the environment and never written anywhere by this script. On a
// machine that does not have it, this stops and says which portal needs a
// manual enroll instead -- it does not fall back to something weaker.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const { PLAYBOOKS } = require("./playbooks");

// Portals that cannot be signed into without a person, and why. Listed by
// name so the failure is a clear message rather than a browser sitting on a
// code-entry screen until it times out.
const NEEDS_A_PERSON = {
  bge: "BGE sends a verification code to the account holder. There is no way "
     + "to read that here, so BGE needs `enroll.js bge` and a person.",
};

const SESSION_DIR = process.env.HOUSY_SESSION_DIR
  || path.join(require("os").homedir(), ".housy-sessions");

function die(msg, code = 1) { console.error(msg); process.exit(code); }

function loadPlaywright() {
  for (const base of [__filename,
                      path.join(__dirname, "..", "..", "tests", "package.json"),
                      path.join(__dirname, "..", "..", "package.json")]) {
    try {
      const { chromium } = createRequire(base)("playwright");
      if (chromium) return chromium;
    } catch { /* keep looking */ }
  }
  die("playwright not installed — run: cd tests && npm i playwright");
}

// ---------------------------------------------------------------------------
// DECRYPT — the same scheme as api/encrypt.js, deliberately duplicated rather
// than imported, because that file is a Vercel handler and this is a CLI.
// If one changes the other must: PBKDF2-SHA256, 100k iterations, 32-byte key,
// AES-256-GCM with the 16-byte tag appended to the ciphertext.
function deriveKey(master, saltHex) {
  return crypto.pbkdf2Sync(master, Buffer.from(saltHex, "hex"), 100000, 32, "sha256");
}

function decryptValue(master, b64, ivHex, saltHex) {
  if (!b64 || !ivHex || !saltHex) return "";
  const key = deriveKey(master, saltHex);
  const iv = Buffer.from(ivHex, "hex");
  const combined = Buffer.from(b64, "base64");
  const TAG = 16;
  if (combined.length < TAG) throw new Error("ciphertext too short");
  const ct = combined.slice(0, combined.length - TAG);
  const tag = combined.slice(combined.length - TAG);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
async function credentialsFor(portal, book) {
  // The master key can carry a trailing newline (it does in this deployment:
  // the ciphertext was written under KEY + "\n"). A shell `$(...)` strips
  // trailing newlines and would silently change the fingerprint, so prefer
  // ENCRYPTION_KEY_FILE, whose bytes are read verbatim.
  let master = process.env.ENCRYPTION_KEY;
  if (!master && process.env.ENCRYPTION_KEY_FILE) {
    try { master = fs.readFileSync(process.env.ENCRYPTION_KEY_FILE, "utf8"); } catch {}
  }
  if (!master) {
    die(`ENCRYPTION_KEY is not set, so the stored credentials cannot be opened.\n`
      + `Either export it (or ENCRYPTION_KEY_FILE) for this run, or sign in once by hand:\n`
      + `  node worker/portals/enroll.js ${portal}`);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  const COMPANY = process.env.HOUSY_COMPANY_ID;
  if (!COMPANY) die("HOUSY_COMPANY_ID is required");

  // TWO WAYS TO GET THE CIPHERTEXT, ONE WAY TO OPEN IT.
  //
  // Where a Supabase service key is present (a dev box), read the encrypted
  // credentials straight from the table. On the browser appliance, which
  // deliberately holds NO service key, ask the app for the ciphertext over a
  // worker-token call instead -- the app returns the encrypted blobs, never
  // plaintext, and only ENCRYPTION_KEY here can open them. Either path yields
  // the same rows; decryption below is identical.
  //
  // Any row for this provider will do: one portal login covers every account
  // on it. Matched through the playbook's aliases because the stored provider
  // names are inconsistent -- "Washington Gas", "Wash Gas" and "WGL" are all
  // the same company.
  let rows;
  if (SUPABASE_URL && SUPABASE_KEY) {
    const { createClient } = createRequire(path.join(__dirname, "..", "..", "package.json"))("@supabase/supabase-js");
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
    const { data, error } = await sb.from("utilities")
      .select("id, provider, username_encrypted, password_encrypted, encryption_iv_username, encryption_iv, encryption_salt, credential_key_fp")
      .eq("company_id", COMPANY)
      .not("username_encrypted", "is", null)
      .not("password_encrypted", "is", null);
    if (error) die(`could not read credentials: ${error.message}`);
    rows = data;
  } else {
    const API = (process.env.HOUSY_API_BASE || "").replace(/\/$/, "");
    const TOKEN = process.env.AI_WORKER_TOKEN || "";
    if (!API || !TOKEN) {
      die("no way to read the stored credentials: set a Supabase service key, "
        + "or HOUSY_API_BASE + AI_WORKER_TOKEN so they can be fetched over the worker API");
    }
    const headers = { "Content-Type": "application/json", "x-worker-token": TOKEN };
    if (process.env.VERCEL_BYPASS_TOKEN) headers["x-vercel-protection-bypass"] = process.env.VERCEL_BYPASS_TOKEN;
    let resp;
    try {
      resp = await fetch(`${API}/api/ai?action=portal-credentials`, {
        method: "POST", headers, body: JSON.stringify({ companyId: COMPANY, provider: book.provider }),
      });
    } catch (e) { die(`could not reach the credentials API: ${String(e.message || e)}`); }
    if (!resp.ok) die(`could not read credentials via API: HTTP ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 150)}`);
    const j = await resp.json().catch(() => ({}));
    rows = j.credentials || [];
  }

  const aliases = (book.aliases || []).map(a => a.toLowerCase());
  const match = (rows || []).find(r => {
    const p = String(r.provider || "").trim().toLowerCase();
    return aliases.some(a => p === a || p.includes(a));
  });
  if (!match) die(`no stored credentials for ${book.provider} on this company`);

  const fpNow = crypto.createHash("sha256").update(master).digest("hex").slice(0, 12);
  if (match.credential_key_fp && match.credential_key_fp !== fpNow) {
    // Say which, rather than "decryption failed". The key was rotated once
    // with nothing migrating the ciphertext and every credential silently
    // stopped opening; the fingerprint exists to make that legible.
    die(`these credentials were encrypted under key ${match.credential_key_fp}, `
      + `but ENCRYPTION_KEY here is ${fpNow}. Re-enter them in the app, or use the matching key.`);
  }

  let username, password;
  try {
    username = decryptValue(master, match.username_encrypted, match.encryption_iv_username, match.encryption_salt);
    password = decryptValue(master, match.password_encrypted, match.encryption_iv, match.encryption_salt);
  } catch (e) {
    die(`could not decrypt the stored credentials: ${String(e.message || e)}`);
  }
  if (!username || !password) die("the stored credentials decrypted to an empty value");
  return { username, password };
}

// Is this session signed in? Asks the page, using the playbook's own
// signed-out signals rather than guessing from the URL.
async function signedIn(page, book) {
  for (const sig of (book.signedOutSignals || [])) {
    const loc = sig.role
      ? page.getByRole(sig.role, { name: sig.name }).first()
      : page.locator(String(sig)).first();
    if (await loc.isVisible({ timeout: 2500 }).catch(() => false)) return false;
  }
  return true;
}

(async () => {
  const portal = (process.argv[2] || "").toLowerCase();
  const headed = process.argv.includes("--headed");
  const book = PLAYBOOKS[portal];
  if (!book) die(`usage: ensure-session.js <${Object.keys(PLAYBOOKS).join("|")}> [--headed]`);

  // NEEDS_A_PERSON is enforced at the sign-in step below, NOT here: a
  // portal like BGE can still reuse a session a person already created; it
  // just cannot sign in unattended. Refusing at the top would throw away a
  // perfectly good manual session.

  const chromium = loadPlaywright();
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(SESSION_DIR, `${portal}.json`);

  // ---- 1. is the session we have still good? -------------------------
  if (fs.existsSync(sessionFile)) {
    const browser = await chromium.launch({ headless: !headed });
    try {
      const ctx = await browser.newContext({
        storageState: JSON.parse(fs.readFileSync(sessionFile, "utf8")),
        viewport: { width: 1280, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto(book.entry, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      if (await signedIn(page, book)) {
        console.log(JSON.stringify({ outcome: "ok", session: "reused", portal }, null, 2));
        await browser.close().catch(() => {});
        return;
      }
      console.log("  stored session is signed out — signing in again");
    } finally { await browser.close().catch(() => {}); }
  } else {
    console.log("  no stored session — signing in");
  }

  // ---- 2. sign in, honestly ------------------------------------------
  //
  // Reached only when there was no live session to reuse. A portal that mails
  // a code cannot be signed into here, so it stops with a clear instruction
  // rather than parking a browser on a code screen.
  if (NEEDS_A_PERSON[portal]) die(NEEDS_A_PERSON[portal]);
  const { username, password } = await credentialsFor(portal, book);

  // slowMo, because this is a real form being filled by what should look
  // like a person using it, not a script racing the page.
  const browser = await chromium.launch({ headless: !headed, slowMo: 120 });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(book.entry, { waitUntil: "domcontentloaded", timeout: 60000 });

    // The username box, from the playbook's own signed-out signal -- the same
    // locator that tells us we are signed out tells us where to type.
    const userSig = (book.signedOutSignals || []).find(s => s.role === "textbox");
    const userBox = userSig
      ? page.getByRole("textbox", { name: userSig.name }).first()
      : page.locator('input[type="email"], input[name*="user" i], input[id*="user" i]').first();
    await userBox.waitFor({ state: "visible", timeout: 30000 });
    await userBox.fill(username);

    const passBox = page.locator('input[type="password"]').first();
    await passBox.waitFor({ state: "visible", timeout: 20000 });
    await passBox.fill(password);

    const submitSig = (book.signedOutSignals || []).find(s => s.role === "button");
    const submit = submitSig
      ? page.getByRole("button", { name: submitSig.name }).first()
      : page.getByRole("button", { name: /log ?in|sign ?in/i }).first();
    await submit.click();

    // Wait for the signed-out signals to go away, which is the only
    // definition of "signed in" that does not depend on guessing a URL.
    const deadline = Date.now() + 90000;
    let ok = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      if (await signedIn(page, book)) { ok = true; break; }

      // A code-entry screen means this portal wants a person. Stop rather
      // than sitting here until the deadline.
      const codeScreen = page.locator(
        'text=/verification code|enter the code|one[- ]time (code|passcode)|authenticator/i'
      ).first();
      if (await codeScreen.isVisible({ timeout: 500 }).catch(() => false)) {
        console.error(JSON.stringify({
          outcome: "needs_a_person",
          error: `${book.provider} is asking for a verification code. Run `
               + `\`node worker/portals/enroll.js ${portal}\` and sign in by hand.`,
        }, null, 2));
        process.exit(3);
      }
    }
    if (!ok) {
      console.error(JSON.stringify({
        outcome: "signin_failed",
        error: "still showing the signed-out form after 90s — the credentials may be wrong, "
             + "or the portal is presenting something this does not handle",
      }, null, 2));
      process.exit(3);
    }

    fs.writeFileSync(sessionFile, JSON.stringify(await ctx.storageState()), { mode: 0o600 });
    console.log(JSON.stringify({ outcome: "ok", session: "created", portal, file: sessionFile }, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch(e => die(String(e?.message || e)));
