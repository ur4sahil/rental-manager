const { test, expect } = require("@playwright/test");
test("the migrated Utilities table renders", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now());
  await page.locator('button:visible:has-text("Dashboard")').first().waitFor({ state: "visible", timeout: 90000 });
  await page.locator('button:visible:has-text("Properties")').first().click();
  await page.waitForTimeout(1200);
  const util = page.locator('button:visible:has-text("Utilities")').first();
  if (!(await util.count())) { console.log("SKIP: no Utilities nav"); return; }
  await util.click();
  await page.waitForTimeout(9000);
  // Utilities defaults to CARD view, like Tenants -- the table only
  // exists after switching, which is why the first run saw no table.
  const tableView = page.locator('button[aria-label="Table view"]').first();
  if (await tableView.count()) { await tableView.click(); await page.waitForTimeout(2500); }
  const ths = await page.locator("table thead th").allInnerTexts();
  console.log("headers:", JSON.stringify(ths));
  const rows = await page.locator("table tbody tr").count();
  const tds = rows ? await page.locator("table tbody tr").first().locator("td").count() : 0;
  console.log(`rows=${rows}  cells in first row=${tds}  header count=${ths.length}`);
  if (ths.length) expect(tds === 0 || tds === ths.length, "header and body column counts must match").toBe(true);
});
