const { test, expect } = require("@playwright/test");

// A cmd/ctrl-click on a report figure opens a fresh tab at
// ?company=...&ledger=<ids>#acct_coa. Two things went wrong there, and
// both looked like the ledger itself being broken:
//
//  1. ledgerHref() built its URL as "?ledger=..." — a query string that
//     REPLACES the existing one — so ?company= was dropped and the new tab
//     fell through to the company selector. Sahil: "sometimes company
//     switcher".
//  2. The boot effect opens the ledger as soon as the ACCOUNTS load, but
//     every figure in it comes from the journal LINES, which arrive ~19
//     pages later. Until they did, the modal showed DR $0.00 / CR $0.00
//     over an empty table — "cmd click on ledger balances or totals, shows
//     total of AR =0".
//
// So: land in the company, and never show a $0.00 total the data cannot
// yet justify.
test("a deep-linked ledger keeps its company and never shows an unjustified $0.00", async ({ page }) => {
  test.setTimeout(240000);

  // Find a real account id with activity by opening a ledger in-app first.
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const bs = page.getByText("Balance Sheet", { exact: true }).first();
  await bs.waitFor({ state: "visible", timeout: 90000 }); await bs.click();
  await page.getByText("TOTAL LIABILITIES AND EQUITY").first().waitFor({ state: "visible", timeout: 120000 });

  // Pick a row that actually has money in it. The first attempt took
  // .first(), which is "Checking Account" -- genuinely $0.00 in this
  // fixture -- so the empty ledger it produced was correct and the test
  // was accusing the app of the bug it was written to catch.
  const rows = page.locator('div:has(> a[aria-label^="Open ledger for"])');
  const n = await rows.count();
  let href = null, picked = null;
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const txt = (await row.innerText().catch(() => "")).replace(/\s+/g, " ");
    if (!txt || /\$0\.00/.test(txt) || !/\$[\d,]+\.\d\d/.test(txt)) continue;
    href = await row.locator('a[aria-label^="Open ledger for"]').first().getAttribute("href");
    picked = txt.slice(0, 60);
    break;
  }
  console.log(`picked row: ${picked}`);
  console.log("drill href:", href);
  expect(href, "no Balance Sheet row with a non-zero amount to drill into").toBeTruthy();
  // Regression guard for (1): the company must survive into the new tab.
  expect(href, "deep link dropped ?company=").toContain("company=");
  expect(href).toContain("ledger=");

  // Now boot a FRESH page straight at that URL, the way a new tab does.
  await page.goto(href.replace("?", "?n=" + Date.now() + "&"));

  // (1) we are in the app, not at the company selector.
  await expect(page.getByText("Select a company", { exact: false }))
    .toHaveCount(0, { timeout: 30000 });

  // The ledger modal opens on the accounts, before the lines are in.
  // Key off the summary bar, not the Export CSV button: that button is
  // hidden when the ledger has no rows, which is the very state under test.
  await page.locator('text=/^DR: /').first()
    .waitFor({ state: "visible", timeout: 120000 });

  // (2) At no point may DR read $0.00 while the loading notice is absent
  // and the table claims there is simply nothing there. Poll across the
  // whole load rather than sampling once, since the bad state was
  // transient and that is exactly what Sahil saw.
  const deadline = Date.now() + 90000;
  let sawLoading = false, settled = null;
  while (Date.now() < deadline) {
    const loading = await page.getByText("Loading the ledger", { exact: false }).count();
    if (loading > 0) { sawLoading = true; await page.waitForTimeout(250); continue; }
    const dr = await page.locator('text=/^DR: /').first().innerText().catch(() => "");
    if (dr) { settled = dr; break; }
    await page.waitForTimeout(250);
  }
  console.log(`saw loading notice: ${sawLoading}   settled DR: ${settled}`);
  expect(settled, "DR total never rendered").toBeTruthy();
  // The account came off the Balance Sheet with a non-zero balance, so a
  // settled $0.00 here means the lines were never attached.
  expect(settled, "settled ledger still totals $0.00").not.toBe("DR: $0.00");
  // (2) again, from the table's side: a row drilled from a non-zero figure
  // must not settle on "No transactions found".
  await expect(page.getByText("No transactions found for this period"))
    .toHaveCount(0, { timeout: 15000 });
});
