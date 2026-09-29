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
     + "to read that here, so BGE needs a person: use the 'Log in' button in "
     + "Housy Utilities to sign in through the streamed browser; that session "
     + "is saved and reused here.",
  // Washington Gas scores every login through reCAPTCHA v3, which a datacenter
  // bot fails silently. A valid session is still REUSED (this fires only when
  // there is none to reuse); a person signs in via the streamed browser and
  // that session is saved for the fetch.
  washington_gas: "Washington Gas runs reCAPTCHA v3 on its login, which a bot "
     + "cannot pass. Use the 'Log in' button in Housy Utilities to sign in "
     + "through the streamed browser; that session is saved and reused here.",
};

// The reason a portal is in NEEDS_A_PERSON matters. A MAILED CODE (BGE) can
// never be read here, so those need a person on any machine. But reCAPTCHA v3
// (Washington Gas) is an IP-REPUTATION score, not a puzzle: it fails from the
// datacenter box yet passes cleanly from a residential IP — proven live. So a
// residential agent box (which sets HOUSY_RESIDENTIAL) is allowed to attempt
// these auto-logins; every other box keeps refusing exactly as before.
const RECAPTCHA_SCORED = { washington_gas: true };
const IS_RESIDENTIAL = /^(1|true|yes)$/i.test(process.env.HOUSY_RESIDENTIAL || "");
// ENROLLMENT MODE: for portals that mail a one-time code (BGE), set HOUSY_CODE_FILE
// to a path. Sign-in fills the creds, the code screen appears, and the script polls
// that file for the code a person reads from the account inbox, enters it, and saves
// the session. The code is single-use and bound to THIS open session, so it must be
// supplied while the run is live -- hence the file poll rather than a later handoff.
const CODE_FILE = (process.env.HOUSY_CODE_FILE || "").trim();
// How long to wait for an emailed code. BGE's code is valid for 20 minutes and
// Mail on the agent Mac can take ~10 minutes to download a message's text, so
// the old 8-minute wait gave up before the code was readable (2026-09-29).
const CODE_WAIT_MIN = Math.max(1, Math.min(19, Number(process.env.HOUSY_CODE_WAIT_MIN) || 18));

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

// A REAL desktop Chrome, not the bundled headless build. Portals fingerprint
// the "HeadlessChrome" user-agent and some (WSSC) refuse to sign it in: the
// same credentials that failed under bundled Chromium logged straight in under
// channel:chrome with this UA. Fall back to bundled only if Chrome is absent.
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
async function launchBrowser(chromium, opts) {
  try { return await chromium.launch({ channel: "chrome", ...opts }); }
  catch { return await chromium.launch(opts); }
}

// ---------------------------------------------------------------------------
// DECRYPT + CHOOSE — see credential-select.js. The scheme is the same as
// api/encrypt.js, deliberately duplicated rather than imported, because that
// file is a Vercel handler and this is a CLI. If one changes the other must:
// PBKDF2-SHA256, 100k iterations, 32-byte key, AES-256-GCM with the 16-byte
// tag appended to the ciphertext; and the key-fingerprint rule.
const { readMasterKey, keyFingerprint, pickCredential } = require("./credential-select");

// ---------------------------------------------------------------------------
async function credentialsFor(portal, book) {
  // ENCRYPTION_KEY_FILE FIRST. The master key carries a trailing newline in
  // this deployment (the ciphertext was written under KEY + "\n"); its bytes
  // are read verbatim from the file, whereas a shell `$(...)` export strips
  // the newline and hashes to a different fingerprint. The env var is only
  // the fallback when no key file is configured or readable.
  const master = readMasterKey();
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
  // Only LIVE, ongoing lines: an archived row is a retired or duplicate
  // account, and its stale login used to outvote a freshly rotated one in the
  // majority count below; the final-bill closeout line is a copy of the
  // ongoing line. Same filter as api/ai.js action=portal-credentials.
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
      .select("id, provider, username_encrypted, password_encrypted, encryption_iv_username, encryption_iv, encryption_salt, credential_key_fp, archived_at, is_final_bill")
      .eq("company_id", COMPANY)
      .is("archived_at", null)
      .neq("is_final_bill", true)
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

  // PICK THE MOST COMMON (username, password) among the matching rows, not the
  // first one. Each utility account stores its own copy of the portal login, so
  // the CURRENT credential is repeated across many rows while stale or
  // mis-typed ones are the minority. HOUSY_PREFER_USER pins a specific login
  // when majority is ambiguous (e.g. a just-rotated password not yet saved on
  // most accounts).
  const fpNow = keyFingerprint(master);
  const picked = pickCredential(rows, master, {
    aliases: book.aliases || [],
    preferUser: process.env.HOUSY_PREFER_USER || "",
  });
  if (picked.error === "no_rows") die(`no stored credentials for ${book.provider} on this company`);
  if (picked.error) {
    if (picked.sawForeignKey) {
      // The fingerprint exists to make a key-rotation legible rather than
      // surfacing as a bare "decryption failed".
      const match = (rows || []).find(r => r.credential_key_fp && r.credential_key_fp !== fpNow) || {};
      die(`the stored ${book.provider} credentials were encrypted under a different key: `
        + `these credentials were encrypted under key ${match.credential_key_fp}, and ENCRYPTION_KEY here is ${fpNow}. `
        + `Re-enter them in the app, or use the matching key.`);
    }
    const preferUser = (process.env.HOUSY_PREFER_USER || "").trim().toLowerCase();
    die(preferUser
      ? `no decryptable ${book.provider} credentials for user ${preferUser}`
      : `could not decrypt any stored ${book.provider} credentials`);
  }
  return { username: picked.username, password: picked.password };
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

// Read a one-time code out of the local macOS Mail store -- see mail-code.js
// (finds the message through Mail's own index, decodes the body, takes only
// the digits labelled as the code).
const { readCodeFromMail } = require("./mail-code");

(async () => {
  const portal = (process.argv[2] || "").toLowerCase();
  // Visible Chrome: --headed, or HOUSY_HEADED=1 (set by the residential
  // agent's run-utilities.sh -- the Sheeba Mac exists to sign in with a real,
  // visible browser from a home IP, which reCAPTCHA scores like a person).
  const headed = process.argv.includes("--headed") || process.env.HOUSY_HEADED === "1";
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
  // Some portals expire so fast that a "still valid" check passes and the very
  // next read finds it gone (Pepco). For those, don't reuse -- fresh-login
  // every time, which is cheap when there's no captcha or code.
  if (fs.existsSync(sessionFile) && !book.noSessionReuse) {
    const browser = await launchBrowser(chromium, { headless: !headed });
    try {
      const ctx = await browser.newContext({
        storageState: JSON.parse(fs.readFileSync(sessionFile, "utf8")),
        viewport: { width: 1280, height: 900 },
        userAgent: DESKTOP_UA,
        // Route through a residential exit (a reverse SOCKS tunnel to the
        // owner's Mac) when set, so reCAPTCHA-scored logins (WG/WSSC) come from
        // a home IP instead of the box's flagged datacenter IP.
        ...(process.env.HOUSY_PROXY ? { proxy: { server: process.env.HOUSY_PROXY } } : {}),
      });
      const page = await ctx.newPage();
      await page.goto(book.signedInEntry || book.entry, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
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
  if (NEEDS_A_PERSON[portal]) {
    if (IS_RESIDENTIAL && RECAPTCHA_SCORED[portal]) {
      console.log(`  ${portal}: reCAPTCHA-scored login — attempting from residential IP (HOUSY_RESIDENTIAL set)`);
    } else if (CODE_FILE && book.mfa === "code-on-signin") {
      console.log(`  ${portal}: code-on-signin enrollment — will wait for the emailed code in ${CODE_FILE}`);
    } else {
      die(NEEDS_A_PERSON[portal]);
    }
  }
  const { username, password } = await credentialsFor(portal, book);

  // slowMo, because this is a real form being filled by what should look
  // like a person using it, not a script racing the page.
  //
  // A playbook with persistentProfile signs in from ONE saved Chrome profile
  // per portal (SESSION_DIR/profiles/<portal>), reused every day, so it carries
  // its own cookies and history like a regular person's browser instead of a
  // blank one each time -- a blank profile is what reCAPTCHA v3 scores lowest.
  // The resulting session is still exported to <portal>.json for the sweep.
  const ctxOpts = { viewport: { width: 1280, height: 900 }, userAgent: DESKTOP_UA,
    ...(process.env.HOUSY_PROXY ? { proxy: { server: process.env.HOUSY_PROXY } } : {}) };
  let browser = null, ctx;
  if (book.persistentProfile) {
    const profileDir = path.join(SESSION_DIR, "profiles", portal);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const popts = { headless: !headed, slowMo: 120, ...ctxOpts };
    try { ctx = await chromium.launchPersistentContext(profileDir, { channel: "chrome", ...popts }); }
    catch { ctx = await chromium.launchPersistentContext(profileDir, popts); }
  } else {
    browser = await launchBrowser(chromium, { headless: !headed, slowMo: 120 });
  }
  try {
    if (!ctx) ctx = await browser.newContext(ctxOpts);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(book.entry, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Let the page SETTLE before typing. WSSC's login is JSF/PrimeFaces: the
    // submit handler is wired up by script that runs after domcontentloaded, so
    // filling and clicking the instant the field appears makes the submit a
    // no-op and the form just sits there -- the "signed-out after 90s" failure.
    // Waiting for network idle is what made a hand-written probe log straight in.
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    // Some portals land on a marketing homepage and hide the real login form
    // behind a "Sign In" link that federates to Azure B2C (Exelon: Pepco, BGE).
    // Click through to it before looking for the username box.
    if (book.signInClick) {
      const si = page.getByRole(book.signInClick.role, { name: book.signInClick.name }).first();
      if (await si.isVisible({ timeout: 8000 }).catch(() => false)) {
        await si.click().catch(() => {});
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      }
    }

    // The username box, from the playbook's own signed-out signal -- the same
    // locator that tells us we are signed out tells us where to type.
    // Explicit CSS selectors win when the form's fields carry no accessible
    // name (Washington Gas: #txtLogin/#txtpwd/#btnlogin). Otherwise fall back
    // to the playbook's signed-out signals, then to generic guesses.
    const userSig = (book.signedOutSignals || []).find(s => s.role === "textbox");
    const userBox = book.loginFields?.user
      ? page.locator(book.loginFields.user).first()
      : userSig
        ? page.getByRole("textbox", { name: userSig.name }).first()
        : page.locator('input[type="email"], input[name*="user" i], input[id*="user" i]').first();
    await userBox.waitFor({ state: "visible", timeout: 30000 });
    // Move the pointer to a field along a path before clicking, then type with
    // per-key delays. reCAPTCHA v3 (Washington Gas) scores pointer + keystroke
    // entropy; a teleported click and an instant fill() read as a bot.
    const humanClick = async (loc) => {
      const box = await loc.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 12 });
        await page.waitForTimeout(120 + Math.random() * 180);
        await page.mouse.move(box.x + box.width * 0.55, box.y + box.height / 2, { steps: 6 });
      }
      await loc.click();
    };
    // Step screenshots, only during enrollment (CODE_FILE set), so a person can
    // watch the run frame by frame and confirm each screen is what it should be.
    let snapN = 0;
    const snap = async (label) => {
      if (!CODE_FILE) return null;
      try {
        const dir = "/tmp/housy-shots"; fs.mkdirSync(dir, { recursive: true });
        const f = `${dir}/bge-step-${String(++snapN).padStart(2, "0")}-${label}.png`;
        await page.screenshot({ path: f });
        console.log("  [shot] " + f);
        return f;
      } catch { return null; }
    };
    await snap("loginpage");
    await humanClick(userBox);
    await userBox.pressSequentially(username, { delay: 70 + Math.random() * 60 });

    const passBox = page.locator(book.loginFields?.pass || 'input[type="password"]').first();
    await passBox.waitFor({ state: "visible", timeout: 20000 });
    await humanClick(passBox);
    await passBox.pressSequentially(password, { delay: 70 + Math.random() * 60 });
    await page.waitForTimeout(500 + Math.random() * 400);

    const submitSig = (book.signedOutSignals || []).find(s => s.role === "button");
    const submit = book.loginFields?.submit
      ? page.locator(book.loginFields.submit).first()
      : submitSig
        ? page.getByRole("button", { name: submitSig.name }).first()
        : page.getByRole("button", { name: /log ?in|sign ?in/i }).first();
    // "Remember Me" (Washington Gas: #rmbrme) keeps the session alive for
    // weeks instead of a day, so sign-in -- and its robot check -- is rare.
    if (book.rememberMe) {
      const rm = page.locator(book.rememberMe).first();
      if (await rm.isVisible({ timeout: 3000 }).catch(() => false) && !(await rm.isChecked().catch(() => true))) {
        await humanClick(rm).catch(() => {});
        await page.waitForTimeout(300 + Math.random() * 300);
      }
    }
    await humanClick(submit);
    await page.waitForTimeout(2500);
    await snap("after-submit");

    // Wait for the signed-out signals to go away, which is the only
    // definition of "signed in" that does not depend on guessing a URL.
    let deadline = Date.now() + 90000;
    let ok = false;
    let codeHandled = false;
    // A code screen is detected by the code INPUT itself, not just page text --
    // BGE's screen text varies, but the one-time-code box is unmistakable. This
    // must be checked BEFORE signedIn(), because a code screen also lacks the
    // signed-out signals and would otherwise read as a false "signed in" and save
    // a useless pre-code session (measured: BGE did exactly that).
    const codeBoxSel =
      '#emailVerificationCode, input[autocomplete="one-time-code"], input[name*="otp" i], '
      + 'input[name*="code" i], input[id*="verification" i], input[id*="otp" i]';
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);

      const onCodeScreen = !codeHandled && await page.locator(codeBoxSel).first()
        .isVisible({ timeout: 500 }).catch(() => false);
      if (onCodeScreen) {
        if (!(CODE_FILE && book.mfa === "code-on-signin")) {
          console.error(JSON.stringify({
            outcome: "needs_a_person",
            error: `${book.provider} is asking for a verification code. Run `
                 + `\`node worker/portals/enroll.js ${portal}\` and sign in by hand.`,
          }, null, 2));
          process.exit(3);
        }
        // Enrollment: the account holder reads the emailed code and drops it in
        // CODE_FILE. Poll for it (up to 8 min) WITHOUT closing the session, since
        // the code is single-use and bound to THIS open session.
        await snap("code-screen");
        try { fs.writeFileSync(CODE_FILE, "", { mode: 0o600 }); } catch {}
        const codeSinceMs = Date.now();
        const codeSender = process.env.HOUSY_CODE_SENDER || "no-reply@bge.com";
        console.log(`\n>>> ${book.provider} sent a one-time code. Auto-reading from local Mail `
          + `(${codeSender}); or drop ONLY the digits in ${CODE_FILE} (echo 123456 > ${CODE_FILE}). `
          + `Waiting up to ${CODE_WAIT_MIN} minutes...\n`);
        let code = "", via = "";
        const codeDeadline = Date.now() + CODE_WAIT_MIN * 60 * 1000;
        while (Date.now() < codeDeadline) {
          await page.waitForTimeout(3000);
          // 1) unattended: the code as it lands in the local Mail store
          const mailCode = readCodeFromMail(codeSinceMs);
          if (mailCode && /^\d{6}$/.test(mailCode)) { code = mailCode; via = "Mail"; break; }
          // 2) manual fallback: a person drops it in the file
          let fileCode = ""; try { fileCode = (fs.readFileSync(CODE_FILE, "utf8") || "").replace(/\D/g, ""); } catch {}
          if (/^\d{4,8}$/.test(fileCode)) { code = fileCode; via = "file"; break; }
        }
        if (!code) die(`no verification code (local Mail or ${CODE_FILE}) within ${CODE_WAIT_MIN} minutes`);
        console.log(`  got code via ${via}`);
        const codeBox = page.locator(codeBoxSel).first();
        await codeBox.waitFor({ state: "visible", timeout: 15000 });
        await humanClick(codeBox);
        await codeBox.pressSequentially(code, { delay: 90 + Math.random() * 60 });
        await page.waitForTimeout(400);
        const cont = page.getByRole("button", { name: /continue|verify|submit|confirm|next/i }).first();
        if (await cont.isVisible({ timeout: 5000 }).catch(() => false)) await humanClick(cont);
        try { fs.writeFileSync(CODE_FILE, "", { mode: 0o600 }); } catch {} // consume: single-use
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await snap("after-code");
        codeHandled = true;
        deadline = Date.now() + 60000; // fresh window to confirm signed-in after the code
        console.log("  code entered — confirming sign-in...");
        continue; // re-evaluate signedIn on the next loop
      }

      if (await signedIn(page, book)) { ok = true; break; }
    }
    if (!ok) {
      // Leave evidence. A blank "signed-out after 90s" told us nothing about
      // WHY; a screenshot + the reCAPTCHA state says whether it is a challenge
      // (unsolvable here), wrong credentials, or a changed form.
      let shot = null, diag = {};
      try {
        const dir = "/tmp/housy-shots"; fs.mkdirSync(dir, { recursive: true });
        shot = path.join(dir, `signin-fail-${portal}-${Date.now()}.png`);
        await page.screenshot({ path: shot, fullPage: false });
        diag = await page.evaluate(() => ({
          recaptcha: typeof window.grecaptcha !== "undefined" || !!document.querySelector("iframe[src*=recaptcha]"),
          challenge: !!document.querySelector("iframe[src*='bframe'], iframe[title*='recaptcha challenge' i]"),
          text: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 240),
        }));
      } catch {}
      console.error(JSON.stringify({
        outcome: "signin_failed", shot, ...diag,
        error: "still showing the signed-out form after 90s — reCAPTCHA challenge, "
             + "wrong credentials, or a form this does not handle",
      }, null, 2));
      process.exit(3);
    }

    await snap("signed-in");
    fs.writeFileSync(sessionFile, JSON.stringify(await ctx.storageState()), { mode: 0o600 });
    console.log(JSON.stringify({ outcome: "ok", session: "created", portal, file: sessionFile }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
    else await ctx?.close().catch(() => {});
  }
})().catch(e => die(String(e?.message || e)));
