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

  // Expanded means the caret reads expand_more AND the sub-rows are really
  // there. The first version of this test only asserted the caret and
  // logged the row count through a selector that matched nothing
  // ('a:has-text("AR -")' -- the Balance Sheet labels these rows with the
  // TENANT name, not the account name), so it printed "AR sub-rows
  // visible: 0" on every run and passed anyway. Collapsing the group and
  // watching the count fall proves both the default state and the toggle.
  const header = page.locator('div:has-text("Accounts Receivable")').last();
  const caret = header.locator('span.material-icons-outlined').first();
  expect((await caret.innerText()).trim(), "AR group is collapsed on first load").toBe("expand_more");

  const drillRows = page.locator('a[aria-label^="Open ledger for"]');
  const expanded = await drillRows.count();
  await header.click();
  await expect(caret).toHaveText(/chevron_right|expand_less/, { timeout: 10000 });
  const collapsed = await drillRows.count();
  console.log(`drillable rows: ${expanded} expanded -> ${collapsed} collapsed`);
  expect(expanded, "no drillable rows on the Balance Sheet at all").toBeGreaterThan(0);
  expect(collapsed, "collapsing AR removed no rows, so it was not expanded").toBeLessThan(expanded);
});
