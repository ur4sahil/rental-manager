const { test, expect } = require("@playwright/test");

// Drilling into a ledger is a navigation, not a dialog.
//
// It used to be a fixed-inset modal over a dimmed backdrop. Sahil:
// "everywhere throughout the app, the clicks open a popup. they should
// open a separate page on the same tab". So: no backdrop, the report it
// was opened from is replaced rather than left sitting underneath, and
// browser Back returns to that report instead of leaving the app.
test("a ledger drill-down is a page, and Back returns to the report", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const bs = page.getByText("Balance Sheet", { exact: true }).first();
  await bs.waitFor({ state: "visible", timeout: 90000 }); await bs.click();
  const totalRow = page.getByText("TOTAL LIABILITIES AND EQUITY").first();
  await totalRow.waitFor({ state: "visible", timeout: 120000 });

  const link = page.locator('a[aria-label^="Open ledger for"]').first();
  const name = (await link.innerText()).trim();
  await link.click();

  // The ledger is open...
  const back = page.getByRole("button", { name: "Back to the report" });
  await back.waitFor({ state: "visible", timeout: 60000 });

  // ...as a page: no modal backdrop, and the report is NOT still behind it.
  const backdrops = await page.locator('div.fixed.inset-0').filter({ hasNot: page.locator("nav") }).count();
  const reportStillThere = await totalRow.isVisible().catch(() => false);
  console.log(`drilled "${name}"  fixed-inset backdrops: ${backdrops}  report still rendered: ${reportStillThere}`);
  expect(reportStillThere, "the report is still rendered under the ledger — that is the modal layout").toBe(false);

  // Browser Back returns to the report rather than leaving the app.
  await page.goBack();
  await totalRow.waitFor({ state: "visible", timeout: 60000 });
  await expect(back).toHaveCount(0);
  console.log("browser Back returned to the Balance Sheet");

  // And the in-page Back button does the same thing.
  await page.locator('a[aria-label^="Open ledger for"]').first().click();
  await back.waitFor({ state: "visible", timeout: 60000 });
  await back.click();
  await totalRow.waitFor({ state: "visible", timeout: 60000 });
  console.log("the Back button returned to the Balance Sheet");
});
