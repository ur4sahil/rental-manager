const { test, expect } = require("@playwright/test");

// Two bugs, both invisible to a test that only checks the page opens:
//
//  1. The Reports viewer gated EVERY report on the browser-side journal
//     ledger, including four that read no journal lines at all. Worse,
//     the accounting cache-hit path never set the "lines have arrived"
//     flag, so any re-navigation inside the 5-minute TTL sat behind
//     "Loading the ledger for this report..." forever with the data
//     already in memory. It read as an intermittent slow load.
//  2. Seeding the default chart of accounts de-duplicated on name while
//     the unique constraint is (company_id, code), producing a burst of
//     swallowed HTTP 409s on every login.
test("Rent Roll renders on both cold and cached loads, with no 409 storm", async ({ page }) => {
  test.setTimeout(300000);
  const conflicts = [];
  page.on("response", r => { if (r.status() === 409) conflicts.push(r.url().split("?")[0]); });

  await page.goto("/?company=sandbox-llc");
  await page.locator('button:visible:has-text("Dashboard")').first().waitFor({ state: "visible", timeout: 90000 });

  for (const pass of [1, 2]) {
    await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
    const link = page.getByText("Rent Roll", { exact: true }).first();
    await link.waitFor({ state: "visible", timeout: 90000 });
    await link.click();
    const t0 = Date.now();
    // Pass 2 is the cache hit — the path that used to hang.
    await page.getByText("Total Units").first().waitFor({ state: "visible", timeout: 120000 });
    const secs = (Date.now() - t0) / 1000;
    const body = await page.locator("body").innerText();
    console.log(`pass ${pass} (${pass === 2 ? "cache hit" : "cold"}): rendered in ${secs.toFixed(1)}s`);
    expect(body, "report is still behind the ledger spinner").not.toMatch(/Loading the ledger for this report/);
    expect(secs, "this report reads no journal lines and should not wait on them").toBeLessThan(60);
  }

  // Not all VACANT: at least one unit resolves to a named tenant. This is
  // what broke when getRentRoll matched lease_status against one spelling.
  const rows = await page.locator("table tbody tr").allInnerTexts();
  const named = rows.filter(r => r.trim() && !/VACANT/.test(r));
  console.log(`rows: ${rows.length}, with a named tenant: ${named.length}, 409s: ${conflicts.length}`);
  expect(named.length, "every unit shows VACANT — no tenant resolved").toBeGreaterThan(0);
  expect(conflicts.length, "409 storm on acct_accounts is back").toBe(0);
});
