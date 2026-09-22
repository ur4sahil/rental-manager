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
      await page.getByRole("link", { name: acctPattern(number) }).first()
        .waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    }
  }

  const link = page.getByRole("link", { name: acctPattern(number) }).first();
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
  // "My Accounts" belongs here. WSSC lists every account on one page under
  // that heading -- no switcher, no chooser link, just a table with a View
  // button per row -- so this returned false, selectAccountAny fell through
  // to the switcher path, and all fourteen accounts were reported as "not in
  // the switcher" while four of them were plainly visible on screen.
  //
  // Found by looking at a screenshot of the page. The heading is the first
  // thing on it.
  const CHOOSER_LABEL = /^\s*(select an account|choose an account|change account|my accounts|all accounts|account list)\s*$/i;

  const heading = page.getByRole("heading", { name: CHOOSER_LABEL }).first();
  if (await heading.count().catch(() => 0)) return true;

  // The label is not always a heading. WSSC renders "My Accounts" as
  // <span class="wsection-title">, so a role-based lookup finds nothing --
  // which is why every one of its fourteen accounts came back "not in the
  // switcher" while four of them were visible in a screenshot of the page.
  //
  // Requiring the label AND a table of account-shaped rows keeps this from
  // matching a navigation item that happens to say "My Accounts": a chooser
  // is a label over a list, and one without the other is a different page.
  const labelled = await page.evaluate((src) => {
    const re = new RegExp(src.source, src.flags);
    const hasLabel = [...document.querySelectorAll("span,div,p,legend,caption,strong,b,a")]
      .some(el => el.childElementCount === 0 && re.test(el.textContent || ""));
    if (!hasLabel) return false;
    const rows = [...document.querySelectorAll("tr,li")]
      .filter(r => /\b\d{6,}\b/.test(r.textContent || "")).length;
    return rows >= 2;
  }, { source: CHOOSER_LABEL.source, flags: CHOOSER_LABEL.flags }).catch(() => false);
  if (labelled) return true;

  // The URL is a useful third signal because BGE names the page outright
  // and WSSC's is wsscaccountmain.faces.
  return /changeaccount|selectaccount|accountlist|accountmain/i.test(page.url());
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

// An account number as the app stored it is not necessarily how the portal
// prints it, and it is not necessarily clean.
//
// One Pepco row in production held "55035823818," -- a trailing comma from
// whatever import created it. The account is real and Active on the portal,
// but the comma meant the search box filtered to nothing and
// new RegExp("55035823818,") could never match the rendered row. The sweep
// reported "not on the chooser page", which reads as a wrong account number
// and sent me looking at the portal instead of at the one bad character.
//
// So: digits only for typing into a search box, and a pattern that tolerates
// separators BETWEEN digits for matching what the page renders -- some
// portals print 5503-5823818. Building the regex from digits also means a
// stray "(" in stored data can no longer throw on RegExp construction.
function acctDigits(n) { return String(n ?? "").replace(/\D/g, ""); }
function acctPattern(n) {
  const d = acctDigits(n);
  return d ? new RegExp(d.split("").join("[^0-9]*")) : new RegExp("(?!)");
}

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
  // The grid renders through Angular after the page settles. Waiting for a
  // row to exist beats waiting a guessed number of milliseconds: a probe at
  // 7s saw an empty table where the same probe at 8s saw ten rows, so a fixed
  // delay turns into "this account is not on the chooser" at random.
  await page.waitForFunction(
    () => document.querySelectorAll("table tbody tr").length > 0,
    { timeout: 30000 },
  ).catch(() => {});

  // 0. Hidden accounts. Pepco's chooser has a "Show Hidden Accounts"
  // checkbox, unticked by default, and an account someone once clicked
  // "Hide" on is absent from the table entirely until it is ticked. Three of
  // this login's accounts sat behind it, and the sweep reported them as
  // "not on the chooser page" -- which read as "this account number is
  // wrong" and sent me looking at the app's data instead of at the portal.
  //
  // Found by looking at a screenshot of the page, after three rounds of
  // DOM probing had concluded the accounts did not exist. The checkbox is
  // plainly visible in the shot. Tick it first: it costs one click and it
  // changes what "not on the chooser" means.
  const showHidden = page.getByRole("checkbox", { name: /show\s+hidden/i })
    .or(page.locator('input[type="checkbox"][ng-model*="hidden" i], input[type="checkbox"][id*="hidden" i]')).first();
  if (await showHidden.count().catch(() => 0)) {
    if (!(await showHidden.isChecked().catch(() => true))) {
      await showHidden.check({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1800);
    }
  }

  // 1. A search box filters server- or client-side and is the cheapest.
  const search = page.getByRole("textbox", { name: /account\s*(number|#)?\s*search|search/i })
    .or(page.locator('input[type="search"], input[placeholder*="search" i]')).first();
  if (await search.count().catch(() => 0)) {
    // fill() is enough: it dispatches an input event and DataTables filters on
    // it -- verified live, ten rows down to one. Enter is harmless but does
    // nothing here, so nothing depends on it.
    await search.fill(acctDigits(number)).catch(() => {});
    await page.waitForTimeout(1500);
    if (await page.getByRole("row", { name: acctPattern(number) }).first().count().catch(() => 0)) {
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
      if (await page.getByRole("row", { name: acctPattern(number) }).first().count().catch(() => 0)) {
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
// Handlers that OPEN an account. Matched by handler name, which is the only
// thing on Pepco's markup that reliably identifies the control.
const OPEN_HANDLERS = ["viewPHIAccount", "viewAccount", "selectAccount", "switchAccount"];

// Handlers that must never be clicked by a sweep. unlinkAccount REMOVES the
// account from the login; updateHiddenFlag hides it from the chooser;
// setDefaultAccount changes which account the portal opens on. All three sit
// in the same row as View, and the previous version's blind
// `[ng-click].first()` resolved to unlinkAccount -- it is first in DOM order.
// It survived only because Pepco renders it ng-hide, so the click timed out
// and was swallowed. A portal redesign that made it visible would have had
// the sweep quietly unlinking accounts one per run.
const DESTRUCTIVE_HANDLERS = ["unlink", "remove", "delete", "updateHiddenFlag", "setDefault"];

function rowTarget(row) {
  const byHandler = OPEN_HANDLERS.map(h => row.locator(`[ng-click*="${h}"], [data-ng-click*="${h}"]`).first());
  // Any other ng-click, minus anything destructive. :not() on the attribute
  // keeps the exclusion in the selector rather than in a filter that a later
  // edit could drop.
  const notDestructive = DESTRUCTIVE_HANDLERS
    .map(h => `:not([ng-click*="${h}"]):not([data-ng-click*="${h}"])`).join("");
  return [
    // Handler name first. Pepco's "View" is a <button ng-click="viewPHIAccount">
    // that getByRole("button") cannot see at all -- measured: count 0 for
    // both /^view$/ and /view/, while the ng-click selector finds it, reports
    // it visible, and clicking it lands on /accounts/dashboard. Angular's
    // markup keeps it out of the accessibility tree, so every role-based
    // attempt below is dead code on this portal.
    ...byHandler,
    row.getByRole("link").first(),
    row.getByRole("button", { name: /view|select|open|go/i }).first(),
    row.locator(`[ng-click]${notDestructive}, [data-ng-click]${notDestructive}, [onclick]`).first(),
    row.getByText(/^\s*view\s*$/i).first(),
    row,
  ];
}

async function selectChooserAccount(page, number, opts = {}) {
  const find = () => ({
    link: page.getByRole("link", { name: acctPattern(number) }).first(),
    button: page.getByRole("button", { name: acctPattern(number) }).first(),
    row: page.getByRole("row", { name: acctPattern(number) }).first(),
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
    await el.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
    // Stop at the first click that TOOK. For a page chooser that means we left
    // the chooser; for an inline one it means THIS row now shows a balance.
    // Without the inline break the loop clicked every control in the row, each
    // waiting out its click timeout -- ~40s of dead time on WSSC.
    if (opts.inline) {
      const t = await accountRow(page, number).innerText().catch(() => "");
      if (/$s?-?[d,]+.d{2}/.test(t)) { clicked = true; break; }
    } else if (!(await onChooserPage(page))) { clicked = true; break; }
    clicked = true;
  }
  if (!clicked) return { ok: false, reason: `account ${number} is on the chooser page but nothing in its row responded to a click` };

  // Inline chooser confirms readiness by polling the row for a balance below,
  // so a long networkidle wait here is dead time -- WSSC's JSF page never reaches
  // idle. Skip it for inline; a shorter settle is plenty for page choosers.
  if (!opts.inline) await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  // An INLINE chooser is supposed to still be showing. WSSC expands the
  // account inside its own row rather than navigating, so "are we still on
  // the chooser" is the wrong question there -- it is always yes, and asking
  // it reported a successful click as "the switch did not take".
  //
  // The right question is whether THIS account's row now carries a figure.
  if (opts.inline) {
    const row = accountRow(page, number);
    for (let i = 0; i < 12; i++) {
      const t = await row.innerText().catch(() => "");
      if (/\$\s?-?[\d,]+\.\d{2}/.test(t)) return { ok: true, via: "inline chooser row" };
      await page.waitForTimeout(700);
    }
    return { ok: false, reason: `expanded ${number} but its row never showed a balance` };
  }

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
async function selectAccountAny(page, number, opts = {}) {
  if (await onChooserPage(page)) return selectChooserAccount(page, number, opts);

  const first = await selectAccount(page, number);
  if (first.ok) return first;

  if (!(await backToChooser(page))) return first;
  const second = await selectChooserAccount(page, number, opts);
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
  // Deliberately NO guessed URL.
  //
  // This used to try /Pages/ChangeAccount.aspx when the link was not found.
  // On Pepco a wrong guess redirects to www.pepco.com -- the public marketing
  // site -- and the signed-out-by-URL rule then correctly reports "session
  // expired". So a bad guess did not merely fail: it navigated us off the
  // application and produced a confident diagnosis of a problem that did not
  // exist, mid-sweep, abandoning every account after it.
  //
  // If the portal offers no way back that we can see, say so. Not finding the
  // door is a smaller error than walking out of the building.
  return false;
}

/**
 * The chooser row for one account, so a caller can scope extraction to it.
 *
 * WSSC needs this. Its chooser does not navigate: clicking "View" expands
 * the account IN PLACE, so after selecting there are two balances on the
 * page -- the previously expanded account's and this one's. A page-wide
 * scan takes the first, which is a different property's money recorded
 * against this one. fetch-bill already refuses to read a figure that is not
 * in the balance's own container; on this portal that container is the row.
 */
function accountRow(page, number) {
  return page.getByRole("row", { name: acctPattern(number) }).first();
}

module.exports = {
  accountRow,
  listAccounts, selectAccount, currentAccount,
  onChooserPage, listChooserAccounts, selectChooserAccount,
  listAccountsAny, selectAccountAny, backToChooser,
};
