const { test, expect } = require("@playwright/test");

// Property labels must be the SAME everywhere and must identify the unit.
//
// Ten report columns rendered the stored address raw -- the full
// "353 Gatewater Ct, B, Glen Burnie, MD 21061" -- while the ledger showed
// "353 Gatewater Ct B". Same property, a different label per report. And
// the old truncation, address.split(",")[0], dropped the unit entirely,
// so two units in one building read identically.
test("rent roll shows short, unique property labels", async ({ page }) => {
  test.setTimeout(300000);
  // Sahil LLC has the real multi-unit addresses.
  await page.goto("/?company=f56be35c-c80d-4f47-8624-cbb317f85461&n=" + Date.now() + "#acct_reports");
  const rr = page.getByText("Rent Roll", { exact: true }).first();
  await rr.waitFor({ state: "visible", timeout: 150000 });
  await rr.click();
  await page.locator("table tbody tr").first().waitFor({ timeout: 180000 });

  const labels = await page.locator("table tbody tr td:first-child").allInnerTexts();
  const clean = labels.map(l => l.trim()).filter(Boolean);
  console.log(`rent roll rows: ${clean.length}`);
  clean.slice(0, 12).forEach(l => console.log(`   ${l}`));

  expect(clean.length, "no rent roll rows").toBeGreaterThan(0);

  // No label may still carry the city/state/zip tail -- that is the raw
  // address leaking through.
  const raw = clean.filter(l => /,\s*[A-Z]{2}\s*\d{5}/.test(l));
  expect(raw, `these labels are still the raw stored address: ${raw.slice(0,3).join(" / ")}`).toHaveLength(0);

  // And no two different properties may share a label.
  const dupes = Object.entries(clean.reduce((m, l) => { m[l] = (m[l] || 0) + 1; return m; }, {}))
    .filter(([, n]) => n > 1);
  console.log(`duplicate labels: ${dupes.length ? dupes.map(([l, n]) => `${l} x${n}`).join(", ") : "none"}`);
  expect(dupes, "two properties share the same label").toHaveLength(0);
});
