const { test, expect } = require("@playwright/test");

// "Refresh doesnt work at all!" -- F5, on #acct_reports.
//
// Which report is open, and its period and as-of date, live in
// AcctReports' component state and appear NOWHERE in the URL. The hash is
// only "#acct_reports", the page. So F5 can only ever bring you back to
// the report CATALOGUE: the Balance Sheet you were reading, the period you
// set and the date you set are gone. In an accounting app, where you
// refresh precisely to see fresh numbers on the statement in front of
// you, that reads as refresh being broken.
//
// (Same root cause as the ledger drill-down landing on the catalogue when
// AcctReports was unmounted -- report selection is not addressable.)
test("F5 keeps the open report, its period and its as-of date", async ({ page }) => {
  test.setTimeout(300000);
  // storageState from auth.setup already has a session; login() here
  // re-ran the whole landing->form flow and timed out on its own
  // waitForSelector while already signed in.
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");

  const bs = page.getByText("Balance Sheet", { exact: true }).first();
  await bs.waitFor({ state: "visible", timeout: 120000 });
  await bs.click();
  await page.getByText("TOTAL LIABILITIES AND EQUITY").first().waitFor({ timeout: 150000 });

  const before = await page.evaluate(() => ({ url: location.href }));
  console.log(`before F5: ${before.url.replace(/\?[^#]*/, "?…")}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(12000);

  const after = await page.evaluate(() => ({
    url: location.href,
    onCatalogue: /Run financial and property reports/.test(document.body.innerText),
    onBalanceSheet: /TOTAL LIABILITIES AND EQUITY/.test(document.body.innerText),
  }));
  console.log(`after  F5: ${after.url.replace(/\?[^#]*/, "?…")}`);
  console.log(`           back on the catalogue: ${after.onCatalogue}   still on the Balance Sheet: ${after.onBalanceSheet}`);

  expect(after.url, "the report is not named in the URL, so a reload has nothing to restore").toContain("report=");
  expect(after.onBalanceSheet, "F5 lost the report that was open").toBeTruthy();
  expect(after.onCatalogue, "F5 fell back to the catalogue").toBeFalsy();
});

test("the as-of date survives F5, and Back returns to the catalogue", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const bs = page.getByText("Balance Sheet", { exact: true }).first();
  await bs.waitFor({ state: "visible", timeout: 120000 });
  await bs.click();
  await page.getByText("TOTAL LIABILITIES AND EQUITY").first().waitFor({ timeout: 150000 });

  // Set an as-of date that is NOT the default, so restoring it proves
  // something. Changing a date must not push a history entry -- fiddling
  // with it used to be impossible to undo because the catalogue got
  // buried; now it replaces.
  const asOf = page.locator('input[type="date"]').last();
  await asOf.fill("2026-06-30");
  await page.waitForTimeout(2500);
  const url = await page.evaluate(() => location.href);
  console.log(`url carries the date: ${/asOf=2026-06-30/.test(url)}`);
  expect(url).toContain("asOf=2026-06-30");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(12000);
  const after = await page.evaluate(() => ({
    onBalanceSheet: /TOTAL LIABILITIES AND EQUITY/.test(document.body.innerText),
    dates: [...document.querySelectorAll('input[type="date"]')].map(i => i.value),
    url: location.href,
  }));
  console.log(`after F5: balance sheet=${after.onBalanceSheet} dates=${after.dates.join(",")}`);
  expect(after.onBalanceSheet, "F5 lost the report").toBeTruthy();
  expect(after.dates, "F5 lost the as-of date").toContain("2026-06-30");

  // The in-app "Back to Reports" control returns to the catalogue and
  // clears the param, so a subsequent F5 lands on the catalogue too.
  //
  // NOT asserted: that the browser Back button does this. On a reload
  // App.js's boot path calls setPage(), which PUSHES a history entry for
  // the page, so after an F5 the stack holds the report entry twice and
  // one Back returns to the report rather than the catalogue. Changing
  // that boot push is a wider change than this fix, and the in-app
  // control is the affordance the page actually offers.
  await page.getByText("Back to Reports").first().click();
  await page.waitForTimeout(4000);
  const back = await page.evaluate(() => ({
    onCatalogue: /Run financial and property reports/.test(document.body.innerText),
    url: location.href,
  }));
  console.log(`after "Back to Reports": catalogue=${back.onCatalogue}  report= in url: ${/report=/.test(back.url)}`);
  expect(back.onCatalogue, "Back to Reports did not return to the catalogue").toBeTruthy();
  expect(back.url, "the report param was left behind, so F5 would reopen it").not.toContain("report=");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10000);
  const afterBackF5 = await page.evaluate(() =>
    /Run financial and property reports/.test(document.body.innerText));
  console.log(`F5 from the catalogue stays on the catalogue: ${afterBackF5}`);
  expect(afterBackF5).toBeTruthy();
});