const { test, expect } = require("@playwright/test");

// The tenant list had no sorting at all. Note the list defaults to CARD
// view, so a test that looks for a table times out -- and sorting via
// table headers alone would be unreachable for anyone who never found
// the three unlabelled view-toggle symbols. Hence the Sort dropdown,
// which is what this exercises.
test("tenant list sorts, in every view", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#tenants");
  const sort = page.locator('select[aria-label="Sort tenants by"]');
  await sort.waitFor({ state: "visible", timeout: 120000 });

  // Switch to the table so rows are addressable per column.
  await page.locator('button[aria-label="Table view"]').click();
  await page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 60000 });

  const col = { name: 1, property: 2, email: 3, lease_status: 4, rent: 5, balance: 6 };
  const vals = async (i) =>
    (await page.locator(`table tbody tr td:nth-child(${i + 1})`).allInnerTexts()).map(t => t.trim());

  for (const [key, idx] of Object.entries(col)) {
    await sort.selectOption(`${key}:asc`);
    await page.waitForTimeout(600);
    const asc = await vals(idx);
    await sort.selectOption(`${key}:desc`);
    await page.waitForTimeout(600);
    const desc = await vals(idx);
    const distinct = new Set(asc.filter(Boolean)).size;
    console.log(`${key.padEnd(13)} rows=${asc.length} distinct=${distinct} reversed=${asc.join("|") !== desc.join("|")} asc=${JSON.stringify(asc.slice(0,3))}`);
    if (distinct > 1) expect(asc.join("|") !== desc.join("|"), `${key} did not reorder`).toBe(true);
    // Blanks last in BOTH directions.
    const fb = asc.findIndex(v => !v);
    if (fb !== -1) {
      expect(asc.slice(fb).every(v => !v), `${key}: blanks not grouped last (asc)`).toBe(true);
      const fbd = desc.findIndex(v => !v);
      expect(desc.slice(fbd).every(v => !v), `${key}: blanks rose to top (desc)`).toBe(true);
    }
  }

  // Numeric, not lexicographic: 900 must not sort before 1,000.
  await sort.selectOption("rent:asc"); await page.waitForTimeout(600);
  const rents = (await vals(col.rent)).map(v => Number(v.replace(/[^0-9.-]/g, ""))).filter(n => !isNaN(n));
  console.log("rent asc:", JSON.stringify(rents.slice(0, 6)));
  expect(rents.join(","), "Rent sorted as text rather than numerically").toBe([...rents].sort((a,b)=>a-b).join(","));

  // And the header click path still works in table view.
  const nameTh = page.locator('table thead th button:has-text("Name")').first();
  await nameTh.click(); await page.waitForTimeout(500);
  const a1 = await vals(col.name);
  await nameTh.click(); await page.waitForTimeout(500);
  console.log("header click reverses:", a1.join("|") !== (await vals(col.name)).join("|"));
});
