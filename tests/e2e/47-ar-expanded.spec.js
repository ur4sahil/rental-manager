const { test, expect } = require("@playwright/test");

// Every other Balance Sheet section defaults to expanded; AR was the one
// exception, so a collapsed group read as an empty AR rather than a
// closed one.
test("Accounts Receivable is expanded by default on the Balance Sheet", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const bs = page.getByText("Balance Sheet", { exact: true }).first();
  await bs.waitFor({ state: "visible", timeout: 90000 }); await bs.click();
  await page.getByText("TOTAL LIABILITIES AND EQUITY").first().waitFor({ state: "visible", timeout: 120000 });

  // Expanded means the caret reads expand_more and AR sub-rows are present.
  const header = page.locator('div:has-text("Accounts Receivable")').last();
  const caret = await header.locator('span.material-icons-outlined').first().innerText().catch(() => "");
  const arRows = await page.locator('a:has-text("AR -"), a:has-text("AR —")').count();
  console.log(`AR caret: ${caret}   AR sub-rows visible: ${arRows}`);
  expect(caret.trim(), "AR group is collapsed on first load").toBe("expand_more");
});
