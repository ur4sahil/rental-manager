#!/usr/bin/env node
// Prove whether a portal's playbook actually works, by signing in.
//
//   PORTAL_USER=... PORTAL_PASS=... node worker/portals/verify-login.js <portal> [entryUrl]
//
// This is the tool that turns `verified: false` into `verified: true`. It
// signs in with the account holder's own credentials, reports what it could
// read, and lists the accounts if the portal presents a chooser.
//
// AN HONEST SIGN-IN, and the distinction matters:
//   * the real credentials, typed into the site's own form, once, at human
//     speed, and nothing else
//   * NO stealth plugin, NO fingerprint spoofing, NO IP rotation, NO
//     attempt to solve or bypass a challenge
// If a portal refuses automation the correct output is "it refuses" -- that
// is a finding, not a problem to route around. Fairfax Water's Cloudflare
// interstitial is where that line sits today.
//
// ONE attempt per run. Repeated failed logins lock utility accounts, which
// is a real problem for a real person rather than a test that went red.
//
// MFA: a code is single-use and bound to the browser session that requested
// it, so it cannot be handed over after a run has ended -- an earlier
// attempt proved that by trying. This PAUSES with the browser still open
// and watches /tmp/portal-code.txt, so the code can be dropped in while the
// session is still alive. Run it in the background and write the file.
//
// Written because three portals I had recorded as "blocked by a bot
// control" -- SMECO, Novec, Dominion -- turned out to be URLs I had guessed
// and never checked. A guessed URL and a blocked portal look identical
// until something signs in.
import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node resolves node_modules from the SCRIPT's directory upward, not the
// working directory, so a script in worker/portals cannot see
// tests/node_modules however it is invoked. Same lookup enroll.js and
// fetch-bill.js use.
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
let chromium = null;
for (const base of [fileURLToPath(import.meta.url),
                    path.join(__dirname_, "..", "..", "tests", "package.json"),
                    path.join(__dirname_, "..", "..", "package.json")]) {
  try { ({ chromium } = createRequire(base)("playwright")); if (chromium) break; } catch {}
}
if (!chromium) { console.error("playwright not installed — run: cd tests && npm i playwright"); process.exit(1); }

// Screenshots of each step, which is how a refusal gets diagnosed after the
// fact. This was hardcoded to one laptop's scratchpad directory, so the tool
// crashed with EACCES on the VPS -- the only machine it actually needs to
// run on. Same env var the rest of the worker uses.
// Same directory enroll.js writes and fetch-bill.js reads, so a session
// earned here is one fetch-bill can use.
const SESSION_DIR = process.env.HOUSY_SESSION_DIR || path.join(__dirname_, "..", "..", ".housy-sessions");
const SHOT = process.env.HOUSY_SHOT_DIR || path.join(__dirname_, "..", "..", ".housy-shots");
const CODE_FILE = "/tmp/portal-code.txt";
const PORTAL = process.argv[2];
const ENTRY_OVERRIDE = process.argv[3] || null;
const USER = process.env.PORTAL_USER, PASS = process.env.PORTAL_PASS;
if (!USER || !PASS) { console.error("PORTAL_USER and PORTAL_PASS are required"); process.exit(1); }

const { PLAYBOOKS } = await import("./playbooks.js").then(m => m.default || m);
const book = PLAYBOOKS[PORTAL];
if (!book) { console.error(`unknown portal "${PORTAL}"`); process.exit(1); }
const ENTRY = ENTRY_OVERRIDE || book.entry;  // override lets a candidate URL be tried without editing the playbook

mkdirSync(SHOT, { recursive: true });
if (existsSync(CODE_FILE)) unlinkSync(CODE_FILE);

// Headed system Chrome by default. Fairfax Water blocks headless chromium
// outright and loads fine in real Chrome from the same machine seconds
// later; Dominion renders nothing headless. HEADLESS=1 forces the old
// behaviour when there is no desktop browser.
const HEADLESS = process.env.HEADLESS === "1";
let b = null;
try { b = await chromium.launch({ channel: "chrome", headless: HEADLESS }); }
catch { b = await chromium.launch({ headless: HEADLESS }); }
const ctx = await b.newContext({
  viewport: { width: 1360, height: 950 }, locale: "en-US", timezoneId: "America/New_York",
});
const page = await ctx.newPage();

const pwd = () => page.locator('input[type="password"]:visible').first();
const onLogin = async () => (await pwd().count().catch(() => 0)) > 0;
const bodyText = async () => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
const settle = async () => {
  await page.waitForLoadState("networkidle", { timeout: 40000 }).catch(() => {});
  let last = "";
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(3000);
    const now = page.url();
    if (now === last) break;
    last = now;
  }
};

try {
  console.log(`\n${book.provider} — entry ${ENTRY}`);
  await page.goto(ENTRY, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  await pwd().waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
  console.log("landed:", page.url());

  if (!(await onLogin())) {
    for (const loc of [
      page.getByRole("link", { name: /^\s*sign\s?in\s*$/i }),
      page.getByRole("button", { name: /^\s*sign\s?in\s*$/i }),
      page.getByRole("link", { name: /^\s*log\s?in\s*$/i }),
      page.getByRole("link", { name: /my ?account/i }),
    ]) {
      if (await onLogin()) break;
      const el = loc.first();
      if (!(await el.count().catch(() => 0))) continue;
      const label = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      console.log(`no password field yet — following "${label}"`);
      await el.click({ timeout: 10000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
      await pwd().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
      console.log("landed:", page.url());
    }
  }

  const captcha = await page.locator('iframe[title*="recaptcha" i], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [class*="captcha" i]:visible').count().catch(() => 0);
  console.log("login form present:", await onLogin(), "| captcha elements:", captcha);

  if (!(await onLogin())) {
    console.log("visible controls:", (await page.locator("button:visible, a:visible").allInnerTexts().catch(() => []))
      .map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 16).join(" | "));
    await page.screenshot({ path: `${SHOT}/${PORTAL}-noform.png`, fullPage: true });
    await b.close(); process.exit(3);
  }

  const uBox = page.locator(
    'input[type="email"]:visible, input[type="text"][name*="user" i]:visible, ' +
    'input[type="text"][id*="user" i]:visible, input[type="text"][name*="email" i]:visible, ' +
    'input[type="text"][id*="email" i]:visible, input[placeholder*="user" i]:visible, ' +
    'input[placeholder*="email" i]:visible, input[type="text"]:visible'
  ).first();
  await uBox.type(USER, { delay: 70 });
  await pwd().type(PASS, { delay: 70 });
  console.log("\nsubmitting once...");
  const submit = page.getByRole("button", { name: /^(log\s?in|sign\s?in|submit|continue)$/i }).first();
  if (await submit.count().catch(() => 0)) await submit.click(); else await pwd().press("Enter");
  await settle();
  console.log("landed:", page.url());

  let body = await bodyText();
  const wantsCode = /enter\s+code|verification\s+code|security\s+code|one[- ]time|we sent you a code|passcode/i.test(body)
    || (await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="code" i]').count().catch(() => 0)) > 0;
  if (wantsCode) {
    console.log("\n*** THIS PORTAL WANTS A VERIFICATION CODE ***");
    console.log(`*** waiting up to 6 minutes for a code in ${CODE_FILE} ***`);
    let code = null;
    for (let i = 0; i < 120; i++) {
      if (existsSync(CODE_FILE)) {
        const t = readFileSync(CODE_FILE, "utf8").trim();
        if (/^\d{4,8}$/.test(t)) { code = t; break; }
      }
      await page.waitForTimeout(3000);
    }
    if (!code) { console.log("no code arrived — stopping without retrying"); await b.close(); process.exit(4); }
    console.log(`code received (${code.length} digits) — entering it`);
    const cb = page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="code" i], input[type="tel"]:visible, input[type="text"]:visible').first();
    await cb.type(code, { delay: 90 });
    const go = page.getByRole("button", { name: /^(verify|continue|submit|confirm|next)$/i }).first();
    if (await go.count().catch(() => 0)) await go.click(); else await cb.press("Enter");
    await settle();
    console.log("landed:", page.url());
    body = await bodyText();
    try { unlinkSync(CODE_FILE); } catch {}
  }

  const signedIn = !(await onLogin());
  console.log("SIGNED IN:", signedIn ? "YES" : "no");
  // Keep the session. This used to prove a login and then throw it away, so
  // a verification code read out by the account holder bought one run and
  // nothing else -- the next fetch would ask them for another. A code is
  // expensive precisely because a person has to be there; spending one and
  // keeping nothing is the waste worth fixing.
  if (signedIn) {
    try {
      mkdirSync(SESSION_DIR, { recursive: true });
      const file = path.join(SESSION_DIR, `${PORTAL}.json`);
      writeFileSync(file, JSON.stringify(await ctx.storageState()), { mode: 0o600 });
      console.log("session saved:", file);
    } catch (e) { console.log("could not save session:", e.message); }
  }
  if (!signedIn) {
    const m = body.match(/(invalid|incorrect|locked|disabled|suspended|too many|temporarily|unable to|does not match|not a robot|captcha|try again)[^.!]{0,120}/i);
    console.log("  page says:", m ? m[0].slice(0, 140) : "(no error message found)");
  } else {
    const { onChooserPage, listChooserAccounts } = await import("./accounts.js").then(m => m.default || m);
    if (await onChooserPage(page)) {
      const l = await listChooserAccounts(page);
      console.log("ON A CHOOSER PAGE — accounts offered:", l.accounts.length);
      for (const a of l.accounts.slice(0, 12)) console.log(`   ${a.number}  ${a.address.slice(0, 60)}${a.isDefault ? "  [default]" : ""}`);
      if (!l.ok) console.log("   reason:", l.reason);
    }
    let amount = null, via = null;
    for (const c of book.amount) {
      if (!c.labelled) continue;
      const mm = body.match(c.labelled);
      if (mm && mm[1]) { amount = mm[1]; via = String(c.labelled).slice(0, 50); break; }
    }
    console.log("amount:", amount ? `$${amount} (via ${via})` : "NOT FOUND");
    let due = null;
    for (const c of book.dueDate) { const mm = body.match(c.text); if (mm) { due = mm[1] || mm[0]; break; } }
    console.log("due date:", due || "NOT FOUND");
    console.log("headings:", (await page.getByRole("heading").allInnerTexts().catch(() => []))
      .map(t => t.trim()).filter(Boolean).slice(0, 10).join(" | "));
  }
  await page.screenshot({ path: `${SHOT}/${PORTAL}-result.png`, fullPage: true });
  console.log(`screenshot: ${SHOT}/${PORTAL}-result.png`);
} catch (e) {
  console.log("error:", String(e.message).split("\n")[0].slice(0, 160));
  await page.screenshot({ path: `${SHOT}/${PORTAL}-error.png`, fullPage: true }).catch(() => {});
} finally { await b.close(); }
