const { test, expect } = require("@playwright/test");
test("Show zero balances reveals empty accounts", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const pl = page.getByText("Profit & Loss", { exact: true }).first();
  await pl.waitFor({ state: "visible", timeout: 90000 }); await pl.click();
  await page.getByText("NET INCOME").first().waitFor({ state: "visible", timeout: 120000 });

  const toggle = page.locator('label:has-text("Show zero balances") input[type="checkbox"]').first();
  await toggle.waitFor({ state: "visible", timeout: 30000 });

  const rowCount = async () => (await page.locator("body").innerText()).split("\n").filter(l => /\$\d/.test(l)).length;
  const before = await rowCount();
  await toggle.check();
  await page.waitForTimeout(2500);
  const after = await rowCount();
  console.log(`P&L money lines: ${before} → ${after} with zeros shown`);
  expect(after, "showing zero balances revealed nothing").toBeGreaterThan(before);

  // And it must not change the totals.
  const body = await page.locator("body").innerText();
  const ni = /NET INCOME\s*\$?([\d,().-]+)/.exec(body);
  console.log("NET INCOME with zeros shown:", ni && ni[1]);
  await toggle.uncheck();
  await page.waitForTimeout(2000);
  const ni2 = /NET INCOME\s*\$?([\d,().-]+)/.exec(await page.locator("body").innerText());
  console.log("NET INCOME with zeros hidden:", ni2 && ni2[1]);
  expect(ni && ni[1], "the toggle changed the totals — it must only change which rows show").toBe(ni2 && ni2[1]);
});
