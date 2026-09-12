const { test, expect } = require("@playwright/test");

// The last four tables Phase 1 migrated were the awkward ones, and each
// carries a dependency that a column-by-column migration cannot see.

test("P&L by Property keeps the DOM shape its print paginator reads", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const r = page.getByText("P&L by Property", { exact: true }).first();
  await r.waitFor({ state: "visible", timeout: 90000 }); await r.click();
  const table = page.locator("table").first();
  await table.waitFor({ state: "visible", timeout: 120000 });

  // exportPDF() splits this report across pages by READING the rendered
  // table: one thead tr, then tbody rows it classifies by whether the row
  // is a single td with a colspan (a section heading) or one td per column
  // (an account or a subtotal). Migrating to DataTable moved the rows into
  // several tbody elements and turned the subtotals into footer rows, so
  // these are the invariants that code depends on.
  const theadRows = await table.locator("thead tr").count();
  const headerCells = await table.locator("thead tr > th").count();
  const bodyRows = await table.locator("tbody tr").count();
  const sectionRows = await table.locator("tbody tr").filter({ has: page.locator("td[colspan]") }).count();
  console.log(`thead rows=${theadRows} header cells=${headerCells} body rows=${bodyRows} rows with a colspan td=${sectionRows}`);

  expect(theadRows, "the paginator reads exactly one header row").toBe(1);
  expect(headerCells, "label + at least one property + TOTAL").toBeGreaterThanOrEqual(3);
  expect(bodyRows, "no body rows at all").toBeGreaterThan(0);

  // A section heading must be the ONLY cell in its row, or the paginator
  // slices it like a data row and the heading lands under a property.
  const headings = table.locator("tbody tr").filter({ has: page.locator("td[colspan]") });
  for (let i = 0; i < await headings.count(); i++) {
    const tds = await headings.nth(i).locator("td").count();
    const span = await headings.nth(i).locator("td[colspan]").first().getAttribute("colspan");
    // Either a full-width heading (one cell), or a subtotal whose label
    // cell merely spans one column -- never something in between.
    if (tds === 1) expect(Number(span), "a full-width heading must span every column").toBeGreaterThan(1);
    else expect(Number(span), "a subtotal's label cell must not span columns").toBe(1);
  }

  // The TOTAL column is pinned, or it is off-screen on a wide report and
  // the report reads as having no totals.
  const lastHeader = table.locator("thead tr > th").last();
  expect(await lastHeader.innerText()).toContain("TOTAL");
  expect(await lastHeader.evaluate(el => getComputedStyle(el).position),
    "the TOTAL header is not pinned").toBe("sticky");
  const firstHeader = table.locator("thead tr > th").first();
  expect(await firstHeader.evaluate(el => getComputedStyle(el).position),
    "the label column is not pinned").toBe("sticky");
});

test("AR Aging Detail still groups charges under each tenant with a subtotal", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const r = page.getByText("A/R Aging Detail", { exact: true }).first();
  if (!(await r.isVisible({ timeout: 20000 }).catch(() => false))) {
    const alt = page.getByText("AR Aging Detail", { exact: true }).first();
    await alt.waitFor({ state: "visible", timeout: 60000 }); await alt.click();
  } else await r.click();

  const table = page.locator("table").first();
  await table.waitFor({ state: "visible", timeout: 120000 });
  const empty = await page.getByText("No open AR balances").isVisible().catch(() => false);
  if (empty) { console.log("fixture has no open AR — nothing to group"); return; }

  // The tenant name and that tenant's total shared ONE row before the
  // migration; a group footer would have added a row per tenant.
  const groupRows = table.locator("tbody tr").filter({ has: page.locator("td[colspan]") });
  const n = await groupRows.count();
  console.log(`group/subtotal rows: ${n}`);
  expect(n, "no tenant grouping at all").toBeGreaterThan(0);
  await expect(page.getByText("TOTAL OUTSTANDING")).toBeVisible();
});

test("a bank transaction row still opens its panel, and the keyboard cursor is visible", async ({ page }) => {
  test.setTimeout(240000);
  // Bank transactions live in the OTHER fixture company -- sandbox-llc has
  // none, so pointing this at sandbox made the test return early and pass
  // having checked nothing, which is the failure mode it exists to catch.
  await page.goto("/?company=dce4974d-afa9-4e65-afdf-1189b815195d&n=" + Date.now() + "#acct_bankimport");

  // Widen the fetch window first. It defaults to 90 days and this
  // fixture's newest transaction is ~140 days old, so every tab read
  // "(0)" and the first version of this test waited two minutes for a row
  // that was filtered out rather than missing.
  const range = page.locator('select[title="Fetch window"]');
  await range.waitFor({ state: "visible", timeout: 120000 });
  await range.selectOption("all");

  // Land on a tab that actually has rows. Widening the window triggers a
  // refetch, so the counts must be POLLED -- reading them straight after
  // selectOption saw the stale "(0)" labels and concluded the fixture was
  // empty.
  const tabs = page.locator('button').filter({ hasText: /(For Review|Recognized|Categorized|Excluded)\s*\(\d+\)/ });
  await expect.poll(async () => {
    const labels = await tabs.allInnerTexts();
    return Math.max(0, ...labels.map(l => Number((l.match(/\((\d+)\)/) || [])[1] || 0)));
  }, { timeout: 60000, message: "no bank transaction tab ever reported any rows" }).toBeGreaterThan(0);

  const labels = await tabs.allInnerTexts();
  const pick = labels.findIndex(l => Number((l.match(/\((\d+)\)/) || [])[1] || 0) > 0);
  console.log(`opening tab: ${labels[pick].replace(/\s+/g, " ").trim()}`);
  await tabs.nth(pick).click();

  const rows = page.locator("tr[data-txn-id]");
  await rows.first().waitFor({ state: "visible", timeout: 120000 });
  const n = await rows.count();
  console.log(`transaction rows: ${n}`);
  expect(n, "no transaction rows at all").toBeGreaterThan(0);

  // Clicking a row moved the keyboard cursor AND toggled the detail panel.
  // Both were on the hand-rolled <tr>; the migration dropped both, so the
  // row became inert and the cursor invisible.
  const first = rows.first();
  const beforeRows = await page.locator("table tbody tr").count();
  await first.click();
  await expect(first, "aria-selected did not follow the click").toHaveAttribute("aria-selected", "true");
  const cls = await first.evaluate(el => el.className);
  expect(cls, "the keyboard cursor ring is not on the selected row").toContain("ring-2");

  // The panel is a full-width row beneath, so the tbody grows.
  await expect.poll(async () => page.locator("table tbody tr").count(), { timeout: 15000 })
    .toBeGreaterThan(beforeRows);
  console.log(`row class: ${cls.slice(0, 100)}`);
  console.log(`tbody rows ${beforeRows} -> ${await page.locator("table tbody tr").count()} after the click`);

  // Clicking again closes it.
  await first.click();
  await expect.poll(async () => page.locator("table tbody tr").count(), { timeout: 15000 })
    .toBe(beforeRows);
  console.log("clicking again collapsed the panel");
});
