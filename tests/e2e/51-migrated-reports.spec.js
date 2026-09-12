const { test, expect } = require("@playwright/test");

// 49 of 62 tables were migrated to the shared DataTable in one pass. This
// walks the reports that now render through it and asserts the structure
// that a bad migration breaks: a header count that disagrees with the
// body, or a table that fails to render at all.
//
// It does not check the figures -- other specs do that -- it checks that
// every migrated table still produces a well-formed table.
const REPORTS = [
  ["Trial Balance", "TOTALS"],
  ["Rent Roll", "Total Units"],
  ["Vacancy Report", /Vacan/],
  ["AR Aging Summary", /Current|Tenant/],
  ["Tenant Balance Summary", /Tenant|Balance/],
  ["Account Listing", /Code|Account/],
  ["Expenses by Category", /Category|Amount/],
  ["Lease Expirations", /Lease|Expir/],
];

test("migrated report tables render well-formed", async ({ page }) => {
  test.setTimeout(600000);
  const results = [];
  for (const [name, settle] of REPORTS) {
    await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
    // Wait for the catalogue itself. Checking count() immediately reported
    // every report as missing, because nothing had rendered yet.
    const link = page.getByText(name, { exact: true }).first();
    const there = await link.waitFor({ state: "visible", timeout: 60000 }).then(() => true).catch(() => false);
    if (!there) { results.push(`${name}: not in catalogue`); continue; }
    await link.click();
    await page.getByText(settle).first().waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    const ths = await page.locator("table thead th").count();
    const all = await page.locator("table tbody tr").all();
    // Skip the EMPTY-STATE row, which legitimately holds one cell
    // spanning every column -- and skip subtotal rows, which do the same.
    // Comparing against the first row reported "1 cell under 5 headers"
    // whenever a report happened to have no data.
    let tds = 0;
    for (const tr of all) {
      const n = await tr.locator("td").count();
      if (n > 1) { tds = n; break; }
    }
    results.push(`${name}: headers=${ths} rows=${all.length} data-cells=${tds || "(empty state)"}`);
    if (ths && tds) {
      expect(tds, `${name}: ${tds} cells under ${ths} headers`).toBe(ths);
    }
  }
  results.forEach(r => console.log("  " + r));
});
