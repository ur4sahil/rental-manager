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

module.exports = { listAccounts, selectAccount, currentAccount };
