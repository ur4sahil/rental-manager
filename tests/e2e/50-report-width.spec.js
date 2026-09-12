const { test, expect } = require("@playwright/test");
test("statement width is constrained, matrix reports are not", async ({ page }) => {
  test.setTimeout(300000);
  await page.setViewportSize({ width: 1800, height: 1000 });
  const widthOf = async (name, settle) => {
    await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
    const l = page.getByText(name, { exact: true }).first();
    await l.waitFor({ state: "visible", timeout: 90000 }); await l.click();
    await page.getByText(settle).first().waitFor({ state: "visible", timeout: 120000 });
    const box = await page.locator("[data-report-content]").first().boundingBox();
    return box ? Math.round(box.width) : null;
  };
  const bs = await widthOf("Balance Sheet", "TOTAL LIABILITIES AND EQUITY");
  const pl = await widthOf("Profit & Loss", "NET INCOME");
  const matrix = await widthOf("P&L by Property", /Total for Income|Income/);
  console.log(`viewport 1800px → Balance Sheet ${bs}px, P&L ${pl}px, P&L by Property ${matrix}px`);
  expect(bs, "balance sheet should not span the whole screen").toBeLessThan(1000);
  expect(pl, "P&L should not span the whole screen").toBeLessThan(1000);
  if (matrix) expect(matrix, "a matrix report should keep the full width").toBeGreaterThan(1000);
});
