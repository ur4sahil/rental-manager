// Selecting WHICH account, on portals that hold many behind one login.
//
// Washington Gas shows ten properties behind a single sign-in, with one
// marked Default. Every reading and every payment applies to whichever is
// currently selected -- which means a run that does not choose explicitly
// is reporting a number for a property it did not pick, and a payment
// would go to whichever account happened to be loaded.
//
// Accounts are selected by ACCOUNT NUMBER, never by position or address:
// a number is unique and stable, positions reorder, and addresses repeat
// across units of the same building.
//
// Every selection is VERIFIED afterwards. A click that silently failed
// would leave the previous account loaded, and the run would then read --
// or pay -- the wrong property while believing it had switched.

const ACCT_RE = /(\d{9,12})/;

/** Open the account switcher and list what it offers. Read-only. */
async function listAccounts(page) {
  const switcher = page.getByRole("button", { name: ACCT_RE }).first();
  if (!(await switcher.count().catch(() => 0))) return { ok: false, reason: "no account switcher on this page", accounts: [] };

  const expanded = await switcher.getAttribute("aria-expanded").catch(() => null);
  if (expanded !== "true") {
    await switcher.click();
    // Wait for the list to APPEAR, not for a fixed interval. Blind sleeps
    // are both slower than they need to be and unreliable when the page is
    // slower than the guess.
    await page.getByRole("link", { name: ACCT_RE }).first()
      .waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  }

  const links = page.getByRole("link", { name: ACCT_RE });
  const n = await links.count().catch(() => 0);
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const label = (await links.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const num = (label.match(ACCT_RE) || [])[1];
    if (!num || accounts.some(a => a.number === num)) continue;
    accounts.push({
      number: num,
      label,
      // Everything between the "My Business"/"My Home" prefix and the
      // number is the property, which is how a reading gets attributed.
      address: label.replace(/^My\s+(Business|Home)\s*/i, "").replace(ACCT_RE, "").replace(/[-–]\s*$/, "").replace(/\s*Default\s*$/i, "").trim(),
      isDefault: /default/i.test(label),
    });
  }
  return { ok: accounts.length > 0, accounts, reason: accounts.length ? null : "switcher opened but listed no accounts" };
}

/**
 * Switch to one account and CONFIRM it took.
 *
 * The confirmation is the point. Clicking and assuming is how a payment
 * reaches the wrong property.
 */
async function selectAccount(page, number) {
  const current = await currentAccount(page);
  if (current === number) return { ok: true, already: true };

  const switcher = page.getByRole("button", { name: ACCT_RE }).first();
  if (await switcher.count().catch(() => 0)) {
    const expanded = await switcher.getAttribute("aria-expanded").catch(() => null);
    if (expanded !== "true") {
      await switcher.click();
      await page.getByRole("link", { name: new RegExp(number) }).first()
        .waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    }
  }

  const link = page.getByRole("link", { name: new RegExp(number) }).first();
  if (!(await link.count().catch(() => 0))) return { ok: false, reason: `account ${number} is not in the switcher` };

  await link.click();
  // Wait for the switcher's own label to change to the account we asked
  // for, which is the only reliable signal the switch completed. A fixed
  // 8-second sleep was both the slowest part of a ten-account cycle and
  // still capable of reading the previous account on a slow load.
  await page.waitForFunction(
    (want) => {
      const btns = Array.from(document.querySelectorAll('button,[role="button"]'));
      return btns.some(b => (b.innerText || "").includes(want));
    },
    number,
    { timeout: 20000 },
  ).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const now = await currentAccount(page);
  if (now !== number) {
    return { ok: false, reason: `switch did not take — still on ${now || "unknown"}, wanted ${number}` };
  }
  return { ok: true, already: false };
}

/** Which account is loaded right now, per the switcher's own label. */
async function currentAccount(page) {
  const switcher = page.getByRole("button", { name: ACCT_RE }).first();
  if (!(await switcher.count().catch(() => 0))) return null;
  const label = (await switcher.innerText().catch(() => "")).replace(/\s+/g, " ");
  return (label.match(ACCT_RE) || [])[1] || null;
}

// ─────────────────────────────────────────────────────────────────────
// SHAPE B: a chooser PAGE, not an inline switcher.
//
// Washington Gas puts its accounts behind a button on every page. BGE does
// not: after sign-in it lands on ChangeAccount.aspx headed "Select an
// Account To View", and there IS no bill until one is picked. Everything
// above returns "no account switcher on this page" there, which reads like
// a single-account login and is why BGE returned no figures.
//
// The rules are the same as shape A and matter for the same reason:
// selection is by ACCOUNT NUMBER, never by position, and the switch is
// VERIFIED afterwards rather than assumed.
//
// UNVERIFIED against the live page. BGE's sign-in and MFA were both proven
// on 2026-09-14, but the run ended at the chooser, so the locators below
// are written from the heading and the shape these pages share. The first
// signed-in run either confirms them or shows which one missed.

/** Are we sitting on a chooser page that must be answered first? */
async function onChooserPage(page) {
  const heading = page.getByRole("heading", { name: /select an account|choose an account|change account/i }).first();
  if (await heading.count().catch(() => 0)) return true;
  // The heading is the reliable signal; the URL is a useful second one
  // because BGE names the page outright.
  return /changeaccount|selectaccount|accountlist/i.test(page.url());
}

/**
 * The accounts offered on a chooser page.
 *
 * Looks at links, buttons and table rows, because a chooser is rendered as
 * all three across portals and picking one shape in advance is how these
 * break on a redesign.
 */
async function listChooserAccounts(page) {
  const seen = [];
  const scopes = [
    page.getByRole("link", { name: ACCT_RE }),
    page.getByRole("button", { name: ACCT_RE }),
    page.getByRole("row", { name: ACCT_RE }),
    page.getByRole("radio"),
  ];
  for (const loc of scopes) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const label = (await el.innerText().catch(() => "")).replace(/\s+/g, " ").trim()
        || (await el.getAttribute("aria-label").catch(() => "")) || "";
      const num = (label.match(ACCT_RE) || [])[1];
      if (!num || seen.some(a => a.number === num)) continue;
      seen.push({
        number: num,
        label: label.slice(0, 120),
        address: label.replace(ACCT_RE, "").replace(/\s{2,}/g, " ").trim().slice(0, 90),
        isDefault: /default/i.test(label),
      });
    }
  }
  return { ok: seen.length > 0, accounts: seen,
           reason: seen.length ? null : "chooser page listed no account numbers" };
}

/**
 * Pick one account on a chooser page and confirm we left the chooser.
 *
 * "Left the chooser" is the confirmation available here: unlike shape A
 * there is no switcher label to re-read, and asserting on a bill figure
 * would conflate "the switch worked" with "the bill loaded". If the
 * chooser is still on screen, the click did not take.
 */
async function selectChooserAccount(page, number) {
  const target = page.getByRole("link", { name: new RegExp(number) }).first();
  const alt = page.getByRole("button", { name: new RegExp(number) }).first();
  const row = page.getByRole("row", { name: new RegExp(number) }).first();

  let clicked = false;
  for (const loc of [target, alt, row]) {
    if (!(await loc.count().catch(() => 0))) continue;
    // A row is not itself clickable on every portal; its first link is.
    const inner = loc.getByRole("link").first();
    const el = (await inner.count().catch(() => 0)) ? inner : loc;
    await el.click({ timeout: 15000 }).catch(() => {});
    clicked = true;
    break;
  }
  if (!clicked) return { ok: false, reason: `account ${number} is not on the chooser page` };

  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  if (await onChooserPage(page)) {
    return { ok: false, reason: `clicked ${number} but the chooser is still showing — the switch did not take` };
  }
  return { ok: true, already: false, via: "chooser page" };
}

// ─────────────────────────────────────────────────────────────────────
// Dispatch. Callers say "select this account" and do not need to know
// which shape the portal uses -- which is the point, because a portal can
// change shape in a redesign and the caller should not have to.

async function listAccountsAny(page) {
  if (await onChooserPage(page)) return listChooserAccounts(page);
  return listAccounts(page);
}

async function selectAccountAny(page, number) {
  if (await onChooserPage(page)) return selectChooserAccount(page, number);
  return selectAccount(page, number);
}

module.exports = {
  listAccounts, selectAccount, currentAccount,
  onChooserPage, listChooserAccounts, selectChooserAccount,
  listAccountsAny, selectAccountAny,
};
