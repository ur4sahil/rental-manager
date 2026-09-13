const { test, expect } = require("@playwright/test");

// Report params belong to the Reports page and must not follow you.
//
// Putting the open report in the URL made reports refreshable and
// shareable, but pushState("#" + page) uses a fragment-only URL, which
// PRESERVES the query string by design. So ?report=bs&asOf=… rode along
// to every other page: "/?report=bs&asOf=2026-05-01#acct_qbimport".
// Sahil: "all pages showing report date in url".
test("report params do not follow you to another page", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const bs = page.getByText("Balance Sheet", { exact: true }).first();
  await bs.waitFor({ state: "visible", timeout: 120000 });
  await bs.click();
  await page.waitForTimeout(5000);

  const onReport = await page.evaluate(() => location.href);
  console.log("on the report :", onReport.replace(/^https?:\/\/[^/]+/, ""));
  expect(onReport, "the report is not in the URL").toContain("report=");

  await page.locator('nav button:has-text("Dashboard")').first().click();
  await page.waitForTimeout(4000);
  const onDashboard = await page.evaluate(() => location.href);
  console.log("on dashboard  :", onDashboard.replace(/^https?:\/\/[^/]+/, ""));
  expect(onDashboard).toContain("#dashboard");
  for (const p of ["report=", "asOf=", "period=", "from=", "to="]) {
    expect(onDashboard, `"${p}" followed you off the Reports page`).not.toContain(p);
  }
});

// A URL pasted or reloaded with leftover params must clean itself up:
// boot resolves the page from the hash without going through setPage.
test("stale report params are swept on load", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/?company=sandbox-llc&report=bs&asOf=2026-05-01&n=" + Date.now() + "#acct_qbimport");
  await page.waitForTimeout(10000);
  const after = await page.evaluate(() => ({
    url: location.href,
    heading: (document.querySelector("h2,h3")?.textContent || "").trim().slice(0, 40),
  }));
  console.log(`loaded  : ${after.url.replace(/^https?:\/\/[^/]+/, "")}\n          showing "${after.heading}"`);
  expect(after.url, "stale report params survived the load").not.toContain("report=");
  expect(after.url).not.toContain("asOf=");
  // and it is still the page the hash asked for, not the dashboard
  expect(after.url).toContain("#acct_qbimport");
  expect(after.heading.toLowerCase()).toContain("quickbooks");
});
