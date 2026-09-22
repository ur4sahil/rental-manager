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
const { PLAYBOOKS, NOTHING_DUE, CREDIT_BALANCE } = require("./playbooks");

const key = (process.argv[2] || "").toLowerCase();
// --account pins WHICH of the accounts behind this login to read. Without
// it the portal shows whichever was selected last, and a reading gets
// attributed to a property nobody chose.
const acctIdx = process.argv.indexOf("--account");
const wantAccount = acctIdx > -1 ? process.argv[acctIdx + 1] : null;
// --list-accounts enumerates the portal's own account list (number + address)
// so the sweep can read EVERY account, not only the ones whose number Housy
// already stored.
const listMode = process.argv.includes("--list-accounts");
const book = PLAYBOOKS[key];
if (!book) { console.error(`usage: fetch-bill.js <${Object.keys(PLAYBOOKS).join("|")}>`); process.exit(1); }

const SESSION_DIR = process.env.HOUSY_SESSION_DIR || path.join(require("os").homedir(), ".housy-sessions");
const SESSION = path.join(SESSION_DIR, `${key}.json`);
const SHOTS = process.env.HOUSY_SHOT_DIR || "/tmp/housy-shots";

const money = /\$\s?([\d,]+\.\d{2})/;
const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7,
                 august:8, september:9, october:10, november:11, december:12 };

// Three formats, because all three appear in the wild on these two sites:
// WSSC writes "Due Date: 10-05-2026" with dashes, and Washington Gas writes
// "due on September 23, 2026" in words. A numeric-only pattern read the
// amount and silently returned no date -- and a bill with no due date is
// the one that gets paid late.

// ---- when the selectors find nothing, look at the page ------------------
// SMECO signs in cleanly and lands on an overview its playbook matches
// nothing on, so the regex path returns null on a page a person can read at
// a glance. That is the one case worth a model: we are already signed in,
// we already have the screenshot, and the alternative is reporting
// "not_found" for a bill that is plainly on screen.
//
// Deliberately narrow. This runs ONLY after every selector has failed, it
// never overrides a figure the playbook found, and what it returns is
// marked as read-from-image all the way to the record so nobody downstream
// mistakes a model's reading for the page's own words.
//
// Streamed, because Ollama holds the response headers until the first token
// and undici abandons a request whose headers take over 300s -- a vision
// call on a CPU box crosses that comfortably.
async function readWithVision(shotPath) {
  const AI = (process.env.AI_BASE_URL || "").replace(/\/$/, "");
  const MODEL = process.env.HOUSY_VISION_MODEL || "qwen2.5vl:7b";
  if (!AI) return null;
  const img = fs.readFileSync(shotPath).toString("base64");
  const res = await fetch(`${AI}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.AI_TOKEN ? { Authorization: `Bearer ${process.env.AI_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      model: MODEL, stream: true, format: "json", images: [img],
      options: { num_predict: 160, temperature: 0 },
      prompt:
        "This is a screenshot of a signed-in utility account page. Report ONLY what is " +
        "printed on it. Answer as JSON " +
        '{"amount_due": number|null, "due_date": "YYYY-MM-DD"|null, "in_credit": boolean}. ' +
        "amount_due is what the customer owes. If the page shows a credit or a negative " +
        "balance, set in_credit true and give amount_due as that figure without a minus " +
        "sign. If no amount is shown anywhere, answer null -- do not infer one.",
    }),
    signal: AbortSignal.timeout(20 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`vision: HTTP ${res.status}`);
  let out = "", tail = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    tail += dec.decode(chunk, { stream: true });
    const lines = tail.split("\n"); tail = lines.pop() || "";
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out += JSON.parse(l).response || ""; } catch { /* keep-alive line */ }
    }
  }
  let j;
  try { j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)); } catch { return null; }
  const n = Number(j.amount_due);
  if (!Number.isFinite(n)) return null;
  // A model that reads $513.99 as $51399 must not reach the books. Anything
  // outside what a utility bill plausibly is gets refused, not rounded.
  if (Math.abs(n) > 50000) return null;
  return { amount: j.in_credit ? -Math.abs(n) : n, due: j.due_date || null, model: MODEL };
}

const isoDate = (s) => {
  const txt = String(s);
  const words = txt.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (words && MONTHS[words[1].toLowerCase()]) {
    return `${words[3]}-${String(MONTHS[words[1].toLowerCase()]).padStart(2, "0")}-${String(words[2]).padStart(2, "0")}`;
  }
  const m = txt.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
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
  const browser = await (async () => {
  // A REAL browser, not headless chromium.
  //
  // Fairfax Water returned Cloudflare's "Sorry, you have been blocked" to
  // headless chromium and loads perfectly in system Chrome, from the same
  // machine and the same IP, seconds apart. Dominion rendered page chrome
  // and nothing else headless. Both were recorded here as blocked portals;
  // neither was.
  //
  // This is NOT a disguise. It launches the Chrome actually installed on
  // this machine -- a different client, not headless chromium pretending to
  // be one. No fingerprint patching, no stealth plugin, no proxy. headless
  // "new" mode is still used when Chrome is absent, because a sweep on a
  // server with no desktop browser must still run.
  try { return await chromium.launch({ channel: "chrome", headless: true }); }
  catch { return await chromium.launch({ headless: true }); }
})();
  const ctx = await browser.newContext({
    storageState: JSON.parse(fs.readFileSync(SESSION, "utf8")),
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    acceptDownloads: true,   // the portal's own statement PDF arrives as a download
  });
  const page = await ctx.newPage();

  try {
    // A signed-in run starts at the signed-in landing page, never at the
    // sign-in entry -- see signedInEntry in playbooks.js.
    const startUrl = book.signedInEntry || book.entry;
    record("open", startUrl);
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000);
    record("landed", page.url());

    fs.mkdirSync(SHOTS, { recursive: true });
    const shot = path.join(SHOTS, `${key}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    record("screenshot", shot);

    // Signed out? Check FIRST, before touching anything. An expired session
    // that gets clicked around is how automation ends up typing into the
    // wrong form.
    // A URL check first: it cannot be fooled by a redesign renaming a
    // button, and Pepco's expiry bounces us to www.pepco.com, where none of
    // the anchored name regexes match. Without this the expired session was
    // reported as fourteen wrong accounts.
    if (book.signedOutUrl && book.signedOutUrl.test(page.url())) {
      record("signed out", `landed on ${page.url()}`);
      finish("needs_signin", { error: "the saved session has expired — run enroll.js again", screenshot: shot });
    }
    for (const sig of book.signedOutSignals) {
      // Ask for the role the playbook actually declared. This used to send
      // everything that was not a textbox to getByRole("button"), so the
      // { role: "link" } signal that six of the eight playbooks carry could
      // never match anything. BGE's logged-out homepage has two "Sign In"
      // LINKS and no such button, so an expired session read as "still
      // valid" -- and every account then failed as `wrong_account`, which
      // sends you looking at account numbers when the truth is you are
      // signed out. Sweep summarised it as needsSignin: 0.
      const loc = page.getByRole(sig.role || "button", { name: sig.name });
      if (await loc.count().catch(() => 0)) {
        record("signed out", `saw ${sig.role} matching ${sig.name}`);
        finish("needs_signin", { error: "the saved session has expired — run enroll.js again", screenshot: shot });
      }
    }
    record("session", "still valid");

    if (listMode) {
      const { listAccountsAny, listChooserAccounts } = require("./accounts");
      let res = await listAccountsAny(page).catch(e => ({ ok: false, reason: String(e.message) }));
      // Once an account is active, Exelon (Pepco/BGE) shows the chooser only
      // behind a "Change Account" control -- click it, then the rows appear.
      if (!res.ok || !(res.accounts || []).length) {
        record("list", "no accounts on landing — revealing the account chooser");
        for (const nm of [/^change account$/i, /change account/i, /switch account/i, /view all accounts/i, /select an account/i, /^change$/i]) {
          const btn = page.getByRole("button", { name: nm }).or(page.getByRole("link", { name: nm })).first();
          if (await btn.count().catch(() => 0)) {
            await btn.click({ timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(3500);
            break;
          }
        }
        res = await listChooserAccounts(page).catch(e => ({ ok: false, reason: String(e.message) }));
      }
      // Paginate a NUMBERED pager (Pepco spreads ~80 accounts over pages 1..8;
      // "Next Page" isn't clickable, the page-number links are). Click each
      // number in turn -- the pager reveals the next as you go -- and
      // accumulate unique accounts.
      const all = [...(res.accounts || [])];
      const nums = (await page.getByRole("link", { name: /^\s*\d+\s*$/ }).allInnerTexts().catch(() => []))
        .map(t => parseInt(t, 10)).filter(n => n >= 1 && n <= 99);
      const maxPage = nums.length ? Math.max(...nums) : 1;
      for (let pg = 2; pg <= maxPage; pg++) {
        const lnk = page.getByRole("link", { name: new RegExp(`^\\s*${pg}\\s*$`) }).first();
        if (!(await lnk.count().catch(() => 0))) continue;   // not in the window yet
        await lnk.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2800);
        const more = await listChooserAccounts(page).catch(() => ({ accounts: [] }));
        for (const a of (more.accounts || [])) if (!all.some(x => x.number === a.number)) all.push(a);
      }
      record("list", `${all.length} accounts across ${maxPage} page(s)`);
      finish(all.length ? "ok" : "error", { accounts: all, error: all.length ? null : (res.reason || "no accounts") });
    }

    // Switch to the requested account and CONFIRM it took. A click that
    // silently failed would leave the previous property loaded and its
    // balance reported under this one's name.
    if (wantAccount) {
      // ...Any: dispatches on the shape the portal actually uses. Washington
      // Gas has an inline switcher; BGE has a chooser PAGE and no bill at
      // all until one is picked.
      const { selectAccountAny: selectAccount, currentAccount } = require("./accounts");
      const sel = await selectAccount(page, wantAccount, { inline: !!book.inlineChooser });
      if (!sel.ok) finish("wrong_account", { error: sel.reason, wanted: wantAccount });
      const on = await currentAccount(page);
      if (on && on !== wantAccount) finish("wrong_account", { error: `page shows ${on}`, wanted: wantAccount });
      record("account", `${on || wantAccount} confirmed`);
    }

    // The accessibility tree is what a playbook reasons over, and what
    // gets handed to the model when a locator stops matching. Small
    // enough to read: these pages were 1.7-5KB when probed.
    // On an inline chooser the account's own row IS the container. Reading
    // the whole page there means reading every expanded account's balance and
    // taking the first, which is another property's money under this one's
    // name -- the exact failure the comment below was written about.
    const scope = (book.inlineChooser && wantAccount)
      ? require("./accounts").accountRow(page, wantAccount)
      : page.locator("body");
    if (book.inlineChooser && wantAccount) record("scope", `row for ${wantAccount}`);

    const tree = await scope.ariaSnapshot({ timeout: 15000 }).catch(() => "");
    record("page tree", `${tree.length} chars`);

    const bodyText = (await scope.innerText().catch(() => "")).replace(/\s+/g, " ");

    // THE AMOUNT MUST COME FROM THE BALANCE'S OWN CONTAINER.
    //
    // Falling back to the first money-shaped string on the page read
    // $50.32 off a "YOUR BILLING AT A GLANCE" widget when the balance was
    // $27.66 -- an overpayment of $22.66 had anything acted on it. A page
    // full of dollar figures is the normal case, not the exception:
    // this one showed the current bill, the previous bill and the same
    // month last year, all beside the balance.
    // A CREDIT IS CHECKED FIRST, and it short-circuits.
    //
    // SMECO's overview reads "No payment due  -$4.15": the utility owes
    // money, not the other way round. Running the amount candidates over
    // that page and taking the first dollar figure records a $4.15 BILL --
    // a credit inverted into a debt on a screen nobody would think to
    // doubt, and one that would then be paid.
    //
    // So: if the page says nothing is due, the answer is zero (or the
    // credit), and the bill patterns never run.
    let amount = null, amountVia = null, credit = null;
    if (NOTHING_DUE.some(re => re.test(bodyText))) {
      const cm = bodyText.match(CREDIT_BALANCE);
      if (cm && cm[1]) {
        credit = Number(cm[1].replace(/[^0-9.]/g, ""));
        amount = -credit;               // signed: negative IS the credit
        amountVia = `credit balance "${cm[0].slice(0, 44)}"`;
      } else {
        amount = 0;
        amountVia = "page says nothing is due";
      }
      record("amount", `${amount} (${amountVia})`);
    }

    for (const cand of (amount != null ? [] : book.amount)) {
      if (cand.labelled) {
        const m = bodyText.match(cand.labelled);
        if (m && m[1]) { amount = Number(m[1].replace(/,/g, "")); amountVia = `labelled "${m[0].slice(0, 36)}"`; break; }
        continue;
      }
      if (cand.role) {
        const el = page.getByRole(cand.role, { name: cand.name }).first();
        if (!(await el.count().catch(() => 0))) continue;
        // The heading itself rarely holds the number; its parent does.
        for (const scope of [el, el.locator("xpath=.."), el.locator("xpath=../..")]) {
          const t = (await scope.innerText().catch(() => "")).replace(/\s+/g, " ");
          const m = t.match(money);
          if (m) { amount = Number(m[1].replace(/,/g, "")); amountVia = `${cand.role} "${t.slice(0, 40)}"`; break; }
        }
        if (amount != null) break;
      }
    }
    // No page-wide fallback. If the balance cannot be found where the
    // balance lives, that is not_found -- a number taken from somewhere
    // else on the page is worse than no number at all.
    if (amount != null && !credit && amountVia && !amountVia.startsWith("credit")) record("amount", `${amount} (${amountVia})`);

    // Which property this reading belongs to, when the portal identifies
    // by address rather than by account number.
    let readProperty = null;
    if (book.identifyBy === "address" && book.addressNear) {
      const m = bodyText.match(book.addressNear);
      if (m) { readProperty = m[1].replace(/\s+/g, " ").trim(); record("property", readProperty); }
    }

    let due = null;
    // Prefer the balance's own container: "Your next payment of $27.66 is
    // due on September 23, 2026" sits right beside the amount, where a
    // page-wide search would instead find a statement date from a history
    // table.
    // Only when the amount was found via a ROLE element is there an element to
    // look beside. A `labelled` match (WSSC's "Balance: $…") is a regex over
    // the body text, not an element -- getByRole(undefined) there matches
    // nothing and each innerText() below burns its 30s default timeout (~60s a
    // bill) before the page-wide search below finds the date anyway.
    if (amountVia && book.amount[0].role) {
      const el = page.getByRole(book.amount[0].role, { name: book.amount[0].name }).first();
      for (const scope of [el.locator("xpath=.."), el.locator("xpath=../..")]) {
        const t = (await scope.innerText({ timeout: 4000 }).catch(() => "")).replace(/\s+/g, " ");
        for (const cand of book.dueDate) {
          const m = t.match(cand.text);
          if (m) { due = isoDate(m[0]); if (due) { record("due date", `${due} (beside the balance)`); break; } }
        }
        if (due) break;
      }
    }
    if (!due) {
      for (const cand of book.dueDate) {
        const m = bodyText.match(cand.text);
        if (m) { due = isoDate(m[0]); if (due) { record("due date", due); break; } }
      }
    }

    // The due date may live one page deeper. Followed only when the landing
    // page did not have it, so the usual path stays a single load.
    if (!due && book.dueDateFollow) {
      const link = page.getByRole(book.dueDateFollow.role, { name: book.dueDateFollow.name }).first();
      if (await link.count().catch(() => 0)) {
        record("following", `${book.dueDateFollow.role} matching ${book.dueDateFollow.name}`);
        await link.click().catch(() => {});
        await page.waitForTimeout(7000);
        const deeper = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
        for (const cand of book.dueDate) {
          const m = deeper.match(cand.text);
          if (m) { due = isoDate(m[0]); if (due) { record("due date", `${due} (one page deeper)`); break; } }
        }
        if (!due) record("due date", "not on the bill page either");
      }
    }

    // Finding nothing is a real answer, not a failure to report. A bill
    // that is not yet issued looks exactly like a page that changed, and
    // guessing between them is how a wrong amount reaches the books.
    let readByVision = false;
    if (amount == null) {
      record("selectors", "found no amount — asking the vision model to read the page");
      const seen = await readWithVision(shot).catch(e => { record("vision", "failed: " + e.message); return null; });
      if (seen) {
        amount = seen.amount;
        if (!due && seen.due) due = seen.due;
        readByVision = true;
        record("vision", `${seen.model} read ${amount}${seen.due ? " due " + seen.due : ""}`);
      }
    }
    if (amount == null) {
      finish("not_found", { error: "signed in, but no amount found — the bill may not be issued yet, or the page changed", screenshot: shot, treeChars: tree.length });
    }
    // A figure a model read off a picture is not the same evidence as one
    // the page labelled, so it travels with that fact attached rather than
    // arriving indistinguishable from the rest.
    if (readByVision && amount < 0 && credit == null) credit = Math.abs(amount);
    // amount_due is SIGNED. A credit is negative, which is what makes it
    // impossible to mistake for a bill downstream: pay-runner refuses any
    // amount <= 0, so a credit can never be "paid", and the in-credit
    // report is simply amount < 0.
    //
    // credit_balance is reported separately as a positive figure, because
    // "you are owed $4.15" is what a person needs to read when deciding
    // whether to ask for a refund cheque -- and "-4.15" is not that.
    // Keep the statement. The number is read off a screen that is then
    // thrown away, so a disputed charge has nothing behind it and
    // utility_bills.pdf_storage_path has sat unused since it was designed.
    //
    // Best effort on purpose: a bill that was read correctly must not be
    // reported as a failure because the page would not render to PDF. The
    // figure is the job; the document is evidence for later.
    let pdfPath = null;
    // THE REAL STATEMENT, when the portal has one. WSSC's "View Bill" link
    // inside the account's own row opens that account's bill page, whose
    // "Download Bill" link downloads the official PDF. Scoped to the row on
    // purpose: the page-level "View Bill" downloads the DEFAULT account's bill,
    // which would file 8168 Inverness's statement under everyone else.
    if (book.statementDownload && wantAccount) {
      try {
        const row = require("./accounts").accountRow(page, wantAccount);
        const vb = row.getByRole("link", { name: book.statementDownload.viewBillLink }).first();
        if (await vb.count().catch(() => 0)) {
          await vb.click({ timeout: 8000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(2000);
          const real = shot.replace(/\.png$/, "") + "-statement.pdf";
          const [dl] = await Promise.all([
            page.waitForEvent("download", { timeout: 25000 }),
            page.getByRole("link", { name: book.statementDownload.downloadLink }).first().click({ timeout: 8000 }),
          ]);
          await dl.saveAs(real);
          if (fs.existsSync(real) && fs.readFileSync(real).slice(0, 5).toString() === "%PDF-") {
            pdfPath = real;
            record("statement", `official PDF (${dl.suggestedFilename()})`);
          }
        }
      } catch (e) {
        record("statement", "official download failed: " + String(e.message).split("\n")[0].slice(0, 60));
      }
    }
    // Fallback: a page snapshot. Best effort -- a bill read correctly must not
    // be reported as a failure because the document could not be captured.
    if (!pdfPath) {
      try {
        pdfPath = shot.replace(/\.png$/, "") + ".pdf";
        await page.pdf({ path: pdfPath, format: "Letter", printBackground: true });
        record("statement", "page snapshot (no official PDF)");
      } catch (e) {
        pdfPath = null;
        record("statement", "could not render: " + String(e.message).split("\n")[0].slice(0, 60));
      }
    }

    finish("ok", {
      account: wantAccount, property: readProperty,
      amount_due: amount, due_date: due,
      credit_balance: credit,
      nothing_due: amount === 0 || credit != null,
      read_by: readByVision ? "vision" : "selectors",
      screenshot: shot, statement_pdf: pdfPath, url: page.url(),
    });
  } catch (e) {
    record("error", String(e.message).split("\n")[0]);
    finish("error", { error: String(e.message).slice(0, 200) });
  } finally {
    await browser.close().catch(() => {});
  }
})();
