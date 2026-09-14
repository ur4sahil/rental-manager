#!/usr/bin/env node
// Fetch the current bill from a utility portal using a session a person
// already established.
//
//   node worker/portals/fetch-bill.js wssc
//
// NEVER LOGS IN. If the page shows a sign-in form, the session has expired
// and this reports needs_signin and stops. That is deliberate: WSSC and
// Washington Gas both run reCAPTCHA, and a script that tried to push past
// it would be both unreliable and a breach of their terms.
//
// Reports what it found. Writes nothing to the books -- a fetched amount
// is a proposal, and a person confirms it.
const fs = require("fs");
const path = require("path");
const { PLAYBOOKS } = require("./playbooks");

const key = (process.argv[2] || "").toLowerCase();
const book = PLAYBOOKS[key];
if (!book) { console.error(`usage: fetch-bill.js <${Object.keys(PLAYBOOKS).join("|")}>`); process.exit(1); }

const SESSION_DIR = process.env.HOUSY_SESSION_DIR || path.join(require("os").homedir(), ".housy-sessions");
const SESSION = path.join(SESSION_DIR, `${key}.json`);
const SHOTS = process.env.HOUSY_SHOT_DIR || "/tmp/housy-shots";

const money = /\$\s?([\d,]+\.\d{2})/;
const isoDate = (s) => {
  // WSSC writes "Due Date: 10-05-2026" with dashes; Washington Gas uses
  // slashes. Matching only slashes found the amount and silently lost the
  // date -- and a bill with no due date is the one you pay late.
  const m = String(s).match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const yr = y.length === 2 ? `20${y}` : y;
  return `${yr}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

(async () => {
  const steps = [];
  const record = (what, detail) => { steps.push({ at: new Date().toISOString(), what, detail }); console.log(`  ${what}${detail ? ": " + detail : ""}`); };
  const finish = (outcome, extra = {}) => {
    console.log("\n" + JSON.stringify({ provider: book.provider, outcome, ...extra, steps: steps.length }, null, 2));
    process.exit(outcome === "ok" ? 0 : 3);
  };

  if (!fs.existsSync(SESSION)) {
    console.error(`no saved session at ${SESSION}`);
    finish("needs_signin", { error: "no session — run enroll.js first" });
  }

  // Node resolves node_modules from the SCRIPT's directory upward, not the
  // working directory -- so running this from tests/ does NOT make
  // tests/node_modules visible to a script living in worker/portals.
  // Look where playwright actually is.
  const { createRequire } = require("module");
  const path = require("path");
  let chromium = null;
  for (const base of [__filename,
                      path.join(__dirname, "..", "..", "tests", "package.json"),
                      path.join(__dirname, "..", "..", "package.json")]) {
    try { ({ chromium } = createRequire(base)("playwright")); if (chromium) break; } catch {}
  }
  if (!chromium) {
    console.error("playwright not installed — run: cd tests && npm i playwright");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    storageState: JSON.parse(fs.readFileSync(SESSION, "utf8")),
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  try {
    record("open", book.entry);
    await page.goto(book.entry, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000);
    record("landed", page.url());

    fs.mkdirSync(SHOTS, { recursive: true });
    const shot = path.join(SHOTS, `${key}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    record("screenshot", shot);

    // Signed out? Check FIRST, before touching anything. An expired session
    // that gets clicked around is how automation ends up typing into the
    // wrong form.
    for (const sig of book.signedOutSignals) {
      const loc = sig.role === "textbox"
        ? page.getByRole("textbox", { name: sig.name })
        : page.getByRole("button", { name: sig.name });
      if (await loc.count().catch(() => 0)) {
        record("signed out", `saw ${sig.role} matching ${sig.name}`);
        finish("needs_signin", { error: "the saved session has expired — run enroll.js again", screenshot: shot });
      }
    }
    record("session", "still valid");

    // The accessibility tree is what a playbook reasons over, and what
    // gets handed to the model when a locator stops matching. Small
    // enough to read: these pages were 1.7-5KB when probed.
    const tree = await page.locator("body").ariaSnapshot({ timeout: 15000 }).catch(() => "");
    record("page tree", `${tree.length} chars`);

    const bodyText = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");

    let amount = null;
    for (const cand of book.amount) {
      if (cand.role) {
        const el = page.getByRole(cand.role, { name: cand.name }).first();
        if (await el.count().catch(() => 0)) {
          const t = await el.innerText().catch(() => "");
          const m = t.match(money) || bodyText.match(money);
          if (m) { amount = Number(m[1].replace(/,/g, "")); record("amount", `${amount} (via ${cand.role})`); break; }
        }
      } else if (cand.text) {
        const m = bodyText.match(cand.text);
        if (m) { const mm = m[0].match(money); if (mm) { amount = Number(mm[1].replace(/,/g, "")); record("amount", `${amount} (via text)`); break; } }
      }
    }

    let due = null;
    for (const cand of book.dueDate) {
      const m = bodyText.match(cand.text);
      if (m) { due = isoDate(m[0]); if (due) { record("due date", due); break; } }
    }

    // Finding nothing is a real answer, not a failure to report. A bill
    // that is not yet issued looks exactly like a page that changed, and
    // guessing between them is how a wrong amount reaches the books.
    if (amount == null) {
      finish("not_found", { error: "signed in, but no amount found — the bill may not be issued yet, or the page changed", screenshot: shot, treeChars: tree.length });
    }
    finish("ok", { amount_due: amount, due_date: due, screenshot: shot, url: page.url() });
  } catch (e) {
    record("error", String(e.message).split("\n")[0]);
    finish("error", { error: String(e.message).slice(0, 200) });
  } finally {
    await browser.close().catch(() => {});
  }
})();
