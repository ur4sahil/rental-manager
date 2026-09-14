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
const readline = require("readline");
const { PLAYBOOKS } = require("./playbooks");

const key = (process.argv[2] || "").toLowerCase();
const book = PLAYBOOKS[key];
if (!book) {
  console.error(`usage: node enroll.js <${Object.keys(PLAYBOOKS).join("|")}>`);
  process.exit(1);
}

const OUT_DIR = process.env.HOUSY_SESSION_DIR || path.join(require("os").homedir(), ".housy-sessions");

(async () => {
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { console.error("playwright not found — run this from tests/ where it is installed, or npm i playwright"); process.exit(1); }

  console.log(`\nOpening ${book.provider}: ${book.entry}`);
  console.log("Sign in in the window that opens. Solve any captcha yourself.\n");

  // Headed and slowed slightly: this window is for a person to use.
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(book.entry, { waitUntil: "domcontentloaded" });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(res => rl.question("Press Enter once you are signed in and can see your account… ", () => { rl.close(); res(); }));

  // Verify rather than trust. Saving a session that is still sitting on the
  // login page produces a file that fails every run afterwards, and the
  // failure would look like a portal change rather than a bad capture.
  let stillOut = false;
  for (const sig of book.signedOutSignals) {
    const loc = sig.role === "textbox"
      ? page.getByRole("textbox", { name: sig.name })
      : page.getByRole("button", { name: sig.name });
    if (await loc.count().catch(() => 0)) { stillOut = true; break; }
  }
  if (stillOut) {
    console.error("\nThis still looks like the sign-in page — nothing saved. Sign in fully, then run this again.");
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
