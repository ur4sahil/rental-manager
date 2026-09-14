#!/usr/bin/env node
// Sign in ONCE, by hand, and save the session.
//
//   node worker/portals/enroll.js wssc
//   node worker/portals/enroll.js washington_gas
//
// Opens a REAL browser window on your machine. You log in yourself --
// including any captcha, which is exactly the step that cannot and should
// not be automated. When you are signed in, press Enter here and the
// session is written to a file.
//
// Nothing is typed for you and no password is read by this script. It
// watches for you to arrive somewhere that is no longer the login page.
const path = require("path");
const fs = require("fs");
const { PLAYBOOKS } = require("./playbooks");

const key = (process.argv[2] || "").toLowerCase();
const book = PLAYBOOKS[key];
if (!book) {
  console.error(`usage: node enroll.js <${Object.keys(PLAYBOOKS).join("|")}>`);
  process.exit(1);
}

const OUT_DIR = process.env.HOUSY_SESSION_DIR || path.join(require("os").homedir(), ".housy-sessions");

(async () => {
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

  console.log(`\nOpening ${book.provider}: ${book.entry}`);
  console.log("Sign in in the window that opens. It saves itself when you are done.\n");

  // Headed and slowed slightly: this window is for a person to use.
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(book.entry, { waitUntil: "domcontentloaded" });

  // Watch for you to finish, rather than asking you to press Enter.
  //
  // Pressing Enter means someone has to be at the terminal as well as the
  // browser. Polling for the sign-in fields to disappear means the browser
  // is the only thing you touch -- sign in, and this notices and saves
  // itself.
  const DEADLINE = Date.now() + 8 * 60 * 1000;
  let signedIn = false;
  process.stdout.write("  waiting for you to sign in");
  while (Date.now() < DEADLINE) {
    await page.waitForTimeout(2500);
    process.stdout.write(".");
    let onLogin = false;
    for (const sig of book.signedOutSignals) {
      const loc = sig.role === "textbox"
        ? page.getByRole("textbox", { name: sig.name })
        : page.getByRole("button", { name: sig.name });
      if (await loc.count().catch(() => 0)) { onLogin = true; break; }
    }
    // Two clean polls in a row, not one: a page mid-navigation briefly has
    // no login fields, and saving then captures a session that is not
    // signed in yet.
    if (!onLogin) {
      await page.waitForTimeout(2500);
      let stillClear = true;
      for (const sig of book.signedOutSignals) {
        const loc = sig.role === "textbox"
          ? page.getByRole("textbox", { name: sig.name })
          : page.getByRole("button", { name: sig.name });
        if (await loc.count().catch(() => 0)) { stillClear = false; break; }
      }
      if (stillClear) { signedIn = true; break; }
    }
  }
  console.log("");

  if (!signedIn) {
    console.error("\nTimed out still on the sign-in page — nothing saved. Run it again when you have a moment.");
    await browser.close();
    process.exit(2);
  }

  const state = await ctx.storageState();
  fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(OUT_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });

  const cookies = state.cookies?.length || 0;
  console.log(`\nSaved ${cookies} cookies to ${file}`);
  console.log(`Landed on: ${page.url()}`);
  console.log(`\nThat session is a bearer token for this account — it is 0600 and must not be copied around.`);
  console.log(`When it expires, a run will say "needs signin" and you rerun this.\n`);
  await browser.close();
})();
