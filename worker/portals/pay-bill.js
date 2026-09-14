#!/usr/bin/env node
// Pay one utility bill that a person has already approved.
//
//   node worker/portals/pay-bill.js washington_gas 210005444463 27.66
//   node worker/portals/pay-bill.js washington_gas 210005444463 27.66 --live
//
// DRY RUN BY DEFAULT. Without --live it walks the whole flow, fills the
// form, checks every precondition and STOPS at the final button, reporting
// exactly what it would have submitted. Nothing moves.
//
// This is the only code in Housy that moves money, and it is irreversible.
// Every guard exists because of a specific way this goes wrong:
//
//   WRONG ACCOUNT. These portals hold 55 properties behind one login and
//   show whichever was selected last. The account number on the page is
//   asserted against the one being paid BEFORE anything is filled, and
//   re-asserted after navigating. A payment to the wrong property is wrong
//   even though the money left correctly.
//
//   WRONG AMOUNT. The page pre-fills a figure and it is NOT trusted: it is
//   compared against what a person approved, and a mismatch aborts. On this
//   very portal a summary widget showed $50.32 while the balance was
//   $27.66 -- that is not hypothetical, it is what happened.
//
//   SILENT EXTRAS. Washington Gas offers a charity donation and a round-up,
//   either of which increases the total. Both are explicitly unchecked,
//   never assumed off, then re-read to confirm they cleared.
//
//   UNCERTAINTY. If submit is clicked and no confirmation can be read, the
//   outcome is UNKNOWN, not failed. Retrying an unknown is how one payment
//   becomes two, so it is terminal and a person checks the portal.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const AI = process.env.AI_BASE_URL || "https://housy.housify365.com";
const AI_TOKEN = process.env.AI_TOKEN || "";
const VIS_MODEL = process.env.HOUSY_VISION_MODEL || "qwen2.5vl:7b";

const PORTALS = {
  washington_gas: {
    entry: "https://my.washingtongas.com/portal/",
    payNav: /^Make Payment$/i,
    amountRadio: /^Amount Due/i,
    // Anything that increases what leaves the account.
    extras: [/Washington Area Fuel Fund/i, /round up/i],
    // Multi-step: NEXT leads to a review page before the real commit.
    advance: /^(Next|Continue)$/i,
    commit: /^(Submit|Confirm|Make Payment|Pay Now)$/i,
  },
};

function log(...a) { console.log(" ", ...a); }
function done(outcome, extra = {}) {
  console.log("\n" + JSON.stringify({ outcome, ...extra }, null, 2));
  process.exit(outcome === "ok" || outcome === "dry_run" ? 0 : 3);
}

// A second pair of eyes on the rendered page, from the model that measured
// 4/4 on this exact form where the text-only model managed 1/4 and missed
// the charity checkbox entirely.
async function visionCheck(pngPath) {
  if (!fs.existsSync(pngPath)) return null;
  try {
    const res = await fetch(`${AI.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(AI_TOKEN ? { Authorization: `Bearer ${AI_TOKEN}` } : {}) },
      body: JSON.stringify({
        model: VIS_MODEL, stream: true, format: "json",
        images: [fs.readFileSync(pngPath).toString("base64")],
        // ONE question. The compound version -- four fields including a
        // vaguely named "anything_ticked_that_adds_money" -- read the WAFF
        // donation as ticked when the DOM said otherwise, and blocked a
        // correct payment. Asked on its own, the same model on the same
        // image answers correctly.
        prompt: "Look at this payment form. Reply as JSON " +
          '{"amount_filled":string|null,"account_shown":string|null}. ' +
          "amount_filled is the amount in the payment box. account_shown is the account this payment is for.",
        options: { temperature: 0, num_predict: 250 },
      }),
      // Streamed: undici abandons a request whose headers take over 300s,
      // and a vision call on CPU can cross that.
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
    let a = "", th = "", tail = "";
    const dec = new TextDecoder();
    for await (const c of res.body) {
      tail += dec.decode(c, { stream: true });
      const parts = tail.split("\n"); tail = parts.pop() || "";
      for (const l of parts) {
        if (!l.trim()) continue;
        let p; try { p = JSON.parse(l); } catch { continue; }
        if (p.response) a += p.response;
        if (p.thinking) th += p.thinking;
      }
    }
    const raw = a.trim() ? a : th;
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch (e) {
    // Say WHY. A bare `return null` here printed "vision check unavailable"
    // while the model was demonstrably loaded and running at 100% CPU --
    // the same swallowed-error pattern that hid the blocked embeddings
    // endpoint for an hour earlier today.
    // Node's fetch reports every transport problem as the same useless
    // "fetch failed"; the actual reason lives in e.cause. Printing only
    // the message has now cost time three separate times today.
    const why = e.cause ? `${e.cause.code || ""} ${e.cause.message || ""}`.trim() : "";
    console.log(`  vision check failed: ${String(e.message).split("\n")[0].slice(0, 70)}${why ? ` (${why.slice(0, 90)})` : ""}`);
    return null;
  }
}

(async () => {
  const [key, wantAccount, wantAmountRaw] = process.argv.slice(2);
  const live = process.argv.includes("--live");
  const wantAmount = Number(wantAmountRaw);
  const book = PORTALS[key];
  if (!book || !wantAccount || !Number.isFinite(wantAmount) || wantAmount <= 0) {
    console.error(`usage: pay-bill.js <${Object.keys(PORTALS).join("|")}> <account-number> <amount> [--live]`);
    process.exit(1);
  }

  let chromium = null;
  for (const base of [__filename, path.join(__dirname, "..", "..", "tests", "package.json")]) {
    try { ({ chromium } = createRequire(base)("playwright")); if (chromium) break; } catch {}
  }
  if (!chromium) { console.error("playwright not installed"); process.exit(1); }

  const sessionFile = path.join(
    process.env.HOUSY_SESSION_DIR || path.join(require("os").homedir(), ".housy-sessions"),
    `${key}.json`);
  if (!fs.existsSync(sessionFile)) done("needs_signin", { error: "no session" });

  const { selectAccount, currentAccount } = require("./accounts");
  const shots = "/tmp/housy-shots";
  fs.mkdirSync(shots, { recursive: true });

  console.log(`\n${live ? "LIVE PAYMENT" : "DRY RUN (nothing will be submitted)"}`);
  console.log(`account ${wantAccount} · $${wantAmount.toFixed(2)}\n`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    storageState: JSON.parse(fs.readFileSync(sessionFile, "utf8")),
    viewport: { width: 1280, height: 1000 },
  });
  const page = await ctx.newPage();

  try {
    await page.goto(book.entry, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});

    if (await page.getByRole("textbox", { name: /UserName|User ID/i }).count().catch(() => 0)) {
      done("needs_signin", { error: "the session has expired" });
    }

    // ---- 1. THE RIGHT ACCOUNT, before anything else -------------------
    const sel = await selectAccount(page, wantAccount);
    if (!sel.ok) done("wrong_account", { error: sel.reason });
    const on = await currentAccount(page);
    if (on !== wantAccount) done("wrong_account", { error: `page shows ${on}, wanted ${wantAccount}` });
    log(`account confirmed: ${on}`);

    // ---- 2. to the payment form ---------------------------------------
    const nav = page.getByRole("link", { name: book.payNav }).first();
    if (!(await nav.count().catch(() => 0))) done("changed", { error: `no "${book.payNav}" link` });
    await nav.click();
    await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
    log(`payment form: ${page.url()}`);

    // Navigating can reset the selection. Re-assert rather than assume.
    const stillOn = await currentAccount(page);
    if (stillOn && stillOn !== wantAccount) {
      done("wrong_account", { error: `account changed to ${stillOn} on the payment page` });
    }
    log(`account still ${stillOn || "(not shown)"} on the payment page`);

    // ---- 3. untick anything that adds money ---------------------------
    const ticked = [];
    for (const pat of book.extras) {
      const boxes = page.getByRole("checkbox", { name: pat });
      const n = await boxes.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const box = boxes.nth(i);
        if (await box.isChecked().catch(() => false)) {
          await box.uncheck({ timeout: 8000 }).catch(() => {});
          const still = await box.isChecked().catch(() => false);
          ticked.push({ label: String(pat), cleared: !still });
        }
      }
    }
    if (ticked.length) log(`extras found and cleared: ${JSON.stringify(ticked)}`);
    else log("no donation or round-up was ticked");
    if (ticked.some(t => !t.cleared)) {
      done("blocked", { error: "could not clear an option that adds money", ticked });
    }

    // ---- 4. the amount, SET then READ BACK ----------------------------
    const amountRadio = page.getByRole("radio", { name: book.amountRadio }).first();
    if (await amountRadio.count().catch(() => 0)) {
      await amountRadio.check({ timeout: 8000 }).catch(() => {});
      log(`selected "${book.amountRadio}"`);
    }
    const boxes = page.locator('input[type="text"], input[type="number"]');
    let filled = null;
    const boxCount = await boxes.count().catch(() => 0);
    for (let i = 0; i < boxCount; i++) {
      const v = (await boxes.nth(i).inputValue().catch(() => "")) || "";
      if (/^\$?\s?[\d,]+\.\d{2}$/.test(v.trim())) { filled = { idx: i, value: v.trim() }; break; }
    }
    if (!filled) done("changed", { error: "no amount field found on the payment form" });

    const shown = Number(filled.value.replace(/[^0-9.]/g, ""));
    log(`form pre-filled with $${shown.toFixed(2)}`);
    if (Math.abs(shown - wantAmount) > 0.005) {
      done("amount_mismatch", {
        error: `the form shows $${shown.toFixed(2)} but $${wantAmount.toFixed(2)} was approved`,
        formAmount: shown, approvedAmount: wantAmount,
      });
    }
    log(`amount matches the approved $${wantAmount.toFixed(2)}`);

    // ---- 5. the second pair of eyes -----------------------------------
    const shot = path.join(shots, `${key}-pay-${wantAccount}-${Date.now()}.png`);
    // Viewport, not fullPage: the form fields are above the fold, and a
    // full-page capture of a long marketing footer is several times the
    // image tokens for no extra information.
    await page.screenshot({ path: shot });
    const vis = await visionCheck(shot);
    if (vis) {
      log(`vision reads: amount=${vis.amount_filled} account=${vis.account_shown}`);

      // Vision cross-checks what a PERSON would read off the screen. It is
      // not asked about checkbox state: that is a machine-readable fact and
      // the DOM already answered it above, correctly, where the model did
      // not.
      const visAmt = vis.amount_filled ? Number(String(vis.amount_filled).replace(/[^0-9.]/g, "")) : null;
      if (visAmt != null && Number.isFinite(visAmt) && Math.abs(visAmt - wantAmount) > 0.005) {
        done("amount_mismatch", {
          error: `the field says $${shown.toFixed(2)} but the page VISIBLY shows $${visAmt.toFixed(2)}`,
          formAmount: shown, visibleAmount: visAmt, approvedAmount: wantAmount,
          screenshot: shot, vision: vis,
        });
      }
      if (vis.account_shown && !String(vis.account_shown).includes(String(wantAccount).slice(0, 8))) {
        done("wrong_account", {
          error: `the page visibly shows "${vis.account_shown}", not account ${wantAccount}`,
          screenshot: shot, vision: vis,
        });
      }
      log("vision agrees on the amount and the account");
    } else {
      log("vision check unavailable — continuing on the structural checks alone");
    }

    // ---- 6. stop here unless told otherwise ---------------------------
    if (!live) {
      const advance = page.getByRole("button", { name: book.advance }).first();
      const commit = page.getByRole("button", { name: book.commit }).first();
      done("dry_run", {
        account: on, amount: wantAmount, formAmount: shown,
        extrasCleared: ticked, screenshot: shot, vision: vis,
        nextButton: (await advance.count().catch(() => 0)) ? String(book.advance) : null,
        commitButton: (await commit.count().catch(() => 0)) ? String(book.commit) : null,
        note: "nothing was submitted — rerun with --live to pay",
      });
    }

    // ---- 7. submit ----------------------------------------------------
    // From here a payment may have happened. Everything below treats that
    // as true even when it cannot be confirmed.
    const advance = page.getByRole("button", { name: book.advance }).first();
    if (await advance.count().catch(() => 0)) {
      log(`advancing past "${book.advance}"`);
      await advance.click();
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
      await page.screenshot({ path: shot.replace(".png", "-review.png") });
    }

    const commit = page.getByRole("button", { name: book.commit }).first();
    if (!(await commit.count().catch(() => 0))) {
      done("blocked", { error: "reached the end without a commit button — nothing submitted", screenshot: shot });
    }

    log(`SUBMITTING $${wantAmount.toFixed(2)} for ${wantAccount}`);
    await commit.click();
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
    const after = path.join(shots, `${key}-paid-${wantAccount}-${Date.now()}.png`);
    await page.screenshot({ path: after, fullPage: true });

    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    const conf = body.match(/confirmation\s*(?:number|#|code)?\s*:?\s*([A-Z0-9-]{5,})/i);
    const looksPaid = /thank you|payment (has been )?(received|submitted|scheduled|posted)|successfully/i.test(body);

    if (conf || looksPaid) {
      done("ok", { account: wantAccount, amount: wantAmount, confirmation: conf ? conf[1] : null, screenshot: after });
    }
    done("unknown", {
      account: wantAccount, amount: wantAmount, screenshot: after,
      error: "submitted but no confirmation could be read — CHECK THE PORTAL before any retry",
    });
  } catch (e) {
    done("error", { error: String(e.message).slice(0, 200) });
  } finally {
    await browser.close().catch(() => {});
  }
})();
