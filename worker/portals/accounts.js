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

/**
 * Bring an account into the DOM before trying to click it.
 *
 * Pepco's chooser is a DataTable: 10 rows per page across 8 pages, ~75
 * accounts. Only the visible 10 exist in the DOM, so 13 of 14 wanted
 * accounts reported "not on the chooser page" -- which reads as "this
 * account does not exist" when the truth is "it is on page 4".
 *
 * Use the controls the page already offers, in the order that costs least:
 * type into its own search box, else ask it to show every row. Both are
 * things a person does at the same screen.
 */
async function revealAccount(page, number) {
  // 1. A search box filters server- or client-side and is the cheapest.
  const search = page.getByRole("textbox", { name: /account\s*(number|#)?\s*search|search/i })
    .or(page.locator('input[type="search"], input[placeholder*="search" i]')).first();
  if (await search.count().catch(() => 0)) {
    await search.fill(String(number)).catch(() => {});
    await search.press("Enter").catch(() => {});
    await page.waitForTimeout(1200);
    if (await page.getByRole("row", { name: new RegExp(number) }).first().count().catch(() => 0)) {
      return "search box";
    }
  }
  // 2. "Show N entries" -- take the largest option the page offers.
  const lengthSel = page.locator('select[name*="length" i], select[aria-label*="entries" i]').first();
  if (await lengthSel.count().catch(() => 0)) {
    const opts = await lengthSel.locator("option").allTextContents().catch(() => []);
    const biggest = opts.map(t => parseInt(t, 10)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (biggest) {
      await lengthSel.selectOption(String(biggest)).catch(() => {});
      await page.waitForTimeout(1200);
      if (await page.getByRole("row", { name: new RegExp(number) }).first().count().catch(() => 0)) {
        return `showing ${biggest} rows`;
      }
    }
  }
  return null;
}

/**
 * The clickable thing inside a chooser row.
 *
 * Pepco's rows contain no <a> at all: "View", "Unlink" and "Hide" are
 * <span class="ng-scope"> carrying an Angular ng-click. The old code asked
 * for the first link, found none, and fell back to clicking the <tr> --
 * which has no handler, so the click landed on nothing and the chooser
 * simply stayed put. That was reported as "the switch did not take",
 * pointing at the account rather than at the row markup.
 */
function rowTarget(row) {
  return [
    row.getByRole("link").first(),
    row.getByRole("button", { name: /view|select|open|go/i }).first(),
    row.locator("[ng-click], [data-ng-click], [onclick]").first(),
    row.getByText(/^\s*view\s*$/i).first(),
    row,
  ];
}

async function selectChooserAccount(page, number) {
  const find = () => ({
    link: page.getByRole("link", { name: new RegExp(number) }).first(),
    button: page.getByRole("button", { name: new RegExp(number) }).first(),
    row: page.getByRole("row", { name: new RegExp(number) }).first(),
  });

  let { link, button, row } = find();
  let via = "chooser page";
  const present = async () =>
    (await link.count().catch(() => 0)) || (await button.count().catch(() => 0)) || (await row.count().catch(() => 0));

  // Not in the DOM is not the same as not existing. Ask the page to show it
  // before concluding anything about the account.
  if (!(await present())) {
    const how = await revealAccount(page, number);
    if (how) { ({ link, button, row } = find()); via = `chooser page via ${how}`; }
  }
  if (!(await present())) {
    return { ok: false, reason: `account ${number} is not on the chooser page, and neither its search box nor its row-count control brought it into view` };
  }

  let clicked = false;
  const outer = (await link.count().catch(() => 0)) ? link
    : (await button.count().catch(() => 0)) ? button : row;
  for (const el of rowTarget(outer)) {
    if (!(await el.count().catch(() => 0))) continue;
    await el.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    // Stop at the first click that actually moved us off the chooser.
    if (!(await onChooserPage(page))) { clicked = true; break; }
    clicked = true;
  }
  if (!clicked) return { ok: false, reason: `account ${number} is on the chooser page but nothing in its row responded to a click` };

  await page.waitForLoadState("networkidle", { timeout: 25000 }).catch(() => {});
  if (await onChooserPage(page)) {
    return { ok: false, reason: `clicked ${number} but the chooser is still showing — the switch did not take` };
  }
  return { ok: true, already: false, via };
}

// ─────────────────────────────────────────────────────────────────────
// Dispatch. Callers say "select this account" and do not need to know
// which shape the portal uses -- which is the point, because a portal can
// change shape in a redesign and the caller should not have to.

async function listAccountsAny(page) {
  if (await onChooserPage(page)) return listChooserAccounts(page);
  return listAccounts(page);
}

/**
 * Select an account, from wherever we happen to be standing.
 *
 * Pepco has TWO ways to change account and they do not offer the same
 * accounts. The chooser page lists all ~75; the switcher dropdown on the
 * dashboard lists a handful. The first account of a sweep is picked from the
 * chooser, which lands us on the dashboard -- and every account after it was
 * then looked for in the switcher, where most of them are not. Ten accounts
 * reported "not in the switcher", which sounds like a data problem and is
 * really a "you are standing in the wrong room" problem.
 *
 * So: try where we are, and if the account is not there, walk back to the
 * chooser and ask again. Portals that have only one mechanism are unaffected
 * -- there is no chooser to walk back to, and the first answer stands.
 */
async function selectAccountAny(page, number) {
  if (await onChooserPage(page)) return selectChooserAccount(page, number);

  const first = await selectAccount(page, number);
  if (first.ok) return first;

  if (!(await backToChooser(page))) return first;
  const second = await selectChooserAccount(page, number);
  // Keep the reason from the place that actually looked, so a failure still
  // names the room it searched.
  return second.ok ? { ...second, via: (second.via || "chooser page") + " (after the switcher did not have it)" } : second;
}

/**
 * Get back to the chooser. Every portal that has one offers a way there --
 * a "Change Account" control, or the page itself at a known address.
 */
async function backToChooser(page) {
  const link = page.getByRole("link", { name: /change account|switch account|select an account|my accounts|all accounts/i })
    .or(page.getByRole("button", { name: /change account|switch account|select an account/i })).first();
  if (await link.count().catch(() => 0)) {
    await link.click({ timeout: 10000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    if (await onChooserPage(page)) return true;
  }
  // Fall back to the address the portal uses for it, derived from where we
  // already are so this carries no hardcoded hostname.
  try {
    const u = new URL(page.url());
    for (const path of ["/Pages/ChangeAccount.aspx", "/pages/changeaccount.aspx"]) {
      await page.goto(u.origin + path, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      if (await onChooserPage(page)) return true;
    }
  } catch (_e) { /* a URL we cannot parse is not worth failing over */ }
  return false;
}

module.exports = {
  listAccounts, selectAccount, currentAccount,
  onChooserPage, listChooserAccounts, selectChooserAccount,
  listAccountsAny, selectAccountAny, backToChooser,
};
