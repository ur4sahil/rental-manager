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

// The pay recipes live in playbooks.js beside the read recipes, so "can this
// provider be paid" has one answer. This file used to carry its own copy of
// the Washington Gas recipe; a second list is a list that drifts, and the way
// it drifts here is the app offering a Pay button for a portal that cannot
// carry the payment out.
const { PLAYBOOKS } = require("./playbooks");
const PORTALS = Object.fromEntries(
  Object.entries(PLAYBOOKS)
    .filter(([, b]) => b && b.pay)
    .map(([portal, b]) => [portal, { entry: b.entry, ...b.pay }])
);

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

  const { selectAccountAny: selectAccount, currentAccount } = require("./accounts");
  const shots = "/tmp/housy-shots";
  fs.mkdirSync(shots, { recursive: true });

  console.log(`\n${live ? "LIVE PAYMENT" : "DRY RUN (nothing will be submitted)"}`);
  console.log(`account ${wantAccount} · $${wantAmount.toFixed(2)}\n`);

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
    storageState: JSON.parse(fs.readFileSync(sessionFile, "utf8")),
    viewport: { width: 1280, height: 1000 },
  });
  const page = await ctx.newPage();

  try {
    // Signed-in runs start at the signed-in landing page. See signedInEntry.
    await page.goto(book.signedInEntry || book.entry, { waitUntil: "domcontentloaded", timeout: 45000 });
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
    //
    // Two cases, and the page itself tells us which: select "Amount Due",
    // read what it pre-fills, and compare with what a person approved.
    //
    //   approved == pre-fill   a FULL payment. Nothing is typed; the figure
    //                          the portal chose is the figure approved.
    //   approved <  pre-fill   a PARTIAL payment. Select the other-amount
    //                          option, type the approved figure, and read it
    //                          back.
    //   approved >  pre-fill   ABORT. Paying more than the portal says is
    //                          owed is never what anybody meant, and it is
    //                          not this program's job to decide otherwise.
    const amountRadio = page.getByRole("radio", { name: book.amountRadio }).first();
    if (await amountRadio.count().catch(() => 0)) {
      await amountRadio.check({ timeout: 8000 }).catch(() => {});
      log(`selected "${book.amountRadio}"`);
    }

    // The money-shaped field on the form.
    const findAmountBox = async () => {
      const boxes = page.locator('input[type="text"], input[type="number"]');
      const n = await boxes.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const v = (await boxes.nth(i).inputValue().catch(() => "")) || "";
        if (/^\$?\s?[\d,]+\.\d{2}$/.test(v.trim())) return { idx: i, value: v.trim() };
      }
      return null;
    };

    let filled = await findAmountBox();
    if (!filled) done("changed", { error: "no amount field found on the payment form" });

    const due = Number(filled.value.replace(/[^0-9.]/g, ""));
    log(`portal says $${due.toFixed(2)} is due`);

    if (wantAmount > due + 0.005) {
      done("amount_mismatch", {
        error: `approved $${wantAmount.toFixed(2)} is MORE than the $${due.toFixed(2)} the portal says is due`,
        formAmount: due, approvedAmount: wantAmount,
      });
    }

    const isPartial = wantAmount < due - 0.005;
    if (isPartial) {
      log(`PARTIAL payment: $${wantAmount.toFixed(2)} of $${due.toFixed(2)}`);

      // NEVER FALL BACK TO "AMOUNT DUE".
      //
      // If the other-amount control cannot be found, stop. A fallback here
      // would pay the WHOLE bill when a partial was approved -- the worst
      // outcome available, and the one that would happen quietly.
      const otherNames = book.pay?.otherAmountRadio || [];
      let picked = null;
      for (const name of otherNames) {
        const r = page.getByRole("radio", { name }).first();
        if (await r.count().catch(() => 0)) {
          await r.check({ timeout: 8000 }).catch(() => {});
          picked = String(name);
          break;
        }
      }
      if (!picked) {
        done("blocked", {
          error: "a partial payment was approved but no other-amount option could be found — "
               + "refusing to submit, because the form is still set to the full amount due",
          approvedAmount: wantAmount, formAmount: due,
          tried: otherNames.map(String),
        });
      }
      log(`selected "${picked}"`);

      // Re-find the box: choosing the other-amount option usually swaps in a
      // different, empty input.
      const box = page.locator('input[type="text"], input[type="number"]').nth(filled.idx);
      const target = (await box.count().catch(() => 0)) ? box
        : page.locator('input[type="text"], input[type="number"]').first();
      await target.fill("").catch(() => {});
      await target.fill(wantAmount.toFixed(2)).catch(() => {});
      await page.waitForTimeout(400);

      // READ IT BACK. Typing is not the same as having typed: a masked or
      // formatted field can hold something other than what was sent to it.
      const after = (await target.inputValue().catch(() => "")) || "";
      const typed = Number(after.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(typed) || Math.abs(typed - wantAmount) > 0.005) {
        done("amount_mismatch", {
          error: `typed $${wantAmount.toFixed(2)} but the field reads "${after}"`,
          formAmount: typed, approvedAmount: wantAmount,
        });
      }
      log(`field reads back $${typed.toFixed(2)} — matches the approved amount`);
      filled = { idx: filled.idx, value: after.trim() };
    } else {
      log(`amount matches the approved $${wantAmount.toFixed(2)} in full`);
    }

    // What the form holds, whichever path got us here. One place, so every
    // check below compares against the same number.
    const submitting = Number(String(filled.value).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(submitting) || Math.abs(submitting - wantAmount) > 0.005) {
      done("amount_mismatch", {
        error: `the form holds $${submitting} but $${wantAmount.toFixed(2)} was approved`,
        formAmount: submitting, approvedAmount: wantAmount,
      });
    }

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
          // `submitting` is what the field holds NOW: the portal's own figure
          // for a full payment, the typed figure for a partial. This read
          // `shown`, a variable the partial-amount rework removed -- so this
          // guard would have thrown a ReferenceError instead of reporting a
          // mismatch. It sits inside a try, so the throw would have been
          // swallowed and reported as a generic error. A guard that crashes
          // is a guard that does not run.
          error: `the field says $${submitting.toFixed(2)} but the page VISIBLY shows $${visAmt.toFixed(2)}`,
          formAmount: submitting, visibleAmount: visAmt, approvedAmount: wantAmount,
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
        account: on, amount: wantAmount, formAmount: submitting,
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

    // THE RECEIPT. The confirmation page as a PDF, which is what gets filed
    // against the property. A screenshot is evidence for us; a PDF is the
    // document a person can open from the property's file months later, and
    // it is the only proof of payment that exists outside the provider's own
    // site. Captured before anything is parsed, because a parse failure must
    // not cost the receipt.
    let receipt = null;
    try {
      receipt = after.replace(/\.png$/, "") + ".pdf";
      await page.pdf({ path: receipt, format: "Letter", printBackground: true });
      log(`receipt captured: ${path.basename(receipt)}`);
    } catch (e) {
      receipt = null;
      log("receipt PDF could not be captured — the payment still stands");
    }

    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    const conf = body.match(/confirmation\s*(?:number|#|code)?\s*:?\s*([A-Z0-9-]{5,})/i);
    const looksPaid = /thank you|payment (has been )?(received|submitted|scheduled|posted)|successfully/i.test(body);

    if (conf || looksPaid) {
      done("ok", { account: wantAccount, amount: wantAmount, confirmation: conf ? conf[1] : null, screenshot: after, receipt });
    }
    done("unknown", {
      account: wantAccount, amount: wantAmount, screenshot: after, receipt,
      error: "submitted but no confirmation could be read — CHECK THE PORTAL before any retry",
    });
  } catch (e) {
    done("error", { error: String(e.message).slice(0, 200) });
  } finally {
    await browser.close().catch(() => {});
  }
})();
