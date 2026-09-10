const { test, expect } = require("@playwright/test");

// Open the Balance Sheet and WAIT FOR IT TO RENDER. A fixed sleep here
// reported every total as "plain text" simply because the report had not
// painted yet -- absence of a link and absence of the report look
// identical to a locator count.
let nonce = 0;
async function openBalanceSheet(page) {
  await page.goto("/?company=sandbox-llc&n=" + (++nonce) + "#acct_reports");
  const bs = page.getByText("Balance Sheet", { exact: true }).first();
  await bs.waitFor({ state: "visible", timeout: 90000 });
  await bs.click();
  await page.getByText("TOTAL LIABILITIES AND EQUITY").first()
    .waitFor({ state: "visible", timeout: 90000 });
}

test("report totals open all-encompassing ledgers", async ({ page, context }) => {
  await page.goto("/?company=sandbox-llc");
  await page.locator('button:visible:has-text("Dashboard"), h2:visible:has-text("Dashboard")')
    .first().waitFor({ state: "visible", timeout: 90000 });

  await openBalanceSheet(page);

  const labels = ["Total for Bank Accounts", "Total for AR", "TOTAL ASSETS",
                  "Total Liabilities", "Total Equity", "TOTAL LIABILITIES AND EQUITY"];
  const notLinks = [];
  for (const label of labels) {
    const present = await page.getByText(label, { exact: true }).count();
    const isLink = await page.locator(`a:text-is("${label}")`).count();
    console.log(`${isLink ? "LINK      " : present ? "PLAIN TEXT" : "absent    "}  ${label}`);
    if (present && !isLink) notLinks.push(label);
  }
  expect(notLinks, "these totals are still not clickable").toEqual([]);

  const totalAssets = page.locator('a:text-is("TOTAL ASSETS")').first();
  const href = await totalAssets.getAttribute("href");
  const ids = decodeURIComponent(href.match(/ledger=([^&#]*)/)[1]).split(",");
  console.log(`TOTAL ASSETS spans ${ids.length} accounts, title="${decodeURIComponent(/ledgerTitle=([^&#]*)/.exec(href)[1])}"`);
  expect(ids.length).toBeGreaterThan(1);

  // cmd-click FIRST, while no modal is open. Doing it after the plain
  // click meant reloading a report that can take over a minute to
  // settle, so the test failed on that reload rather than on anything
  // it was meant to measure.
  const popupP = context.waitForEvent("page", { timeout: 20000 }).catch(() => null);
  await page.locator('a:text-is("Total Liabilities")').first().click({ modifiers: ["Meta"] });
  const popup = await popupP;
  expect(popup, "cmd-click must open a new tab").toBeTruthy();
  // A brand-new tab reads as about:blank until it navigates.
  await popup.waitForURL(/ledger=/, { timeout: 20000 });
  console.log("cmd-click -> new tab:", popup.url().slice(0, 100));

  // ...and must NOT also open the modal in the original tab. That double
  // fire is the actual reported bug: the row under the link carries its
  // own onClick, so the event bubbled and the popup covered the new tab.
  await page.waitForTimeout(3000);
  const leaked = await page.locator('[role="dialog"], .fixed.inset-0').count();
  console.log("modal also opened in original tab?", leaked > 0 ? "YES (bug)" : "no");
  expect(leaked, "cmd-click must not also open the modal").toBe(0);
  await popup.close();

  // Plain click -> the combined ledger, with rows.
  await totalAssets.click();
  await page.waitForTimeout(6000);
  const rows = await page.locator("table tbody tr").count();
  console.log("plain click -> ledger rows:", rows);
  expect(rows).toBeGreaterThan(0);
});

// The P&L and the P&L-by-property carry their own totals. They were wired
// separately from the Balance Sheet, so they need their own assertion --
// "the balance sheet works" says nothing about them.
async function openReport(page, name, settleText) {
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const link = page.getByText(name, { exact: true }).first();
  await link.waitFor({ state: "visible", timeout: 90000 });
  await link.click();
  await page.getByText(settleText).first().waitFor({ state: "visible", timeout: 90000 });
}

test("P&L totals open all-encompassing ledgers", async ({ page }) => {
  await openReport(page, "Profit & Loss", "NET INCOME");
  // A total with NOTHING beneath it stays deliberately inert -- linking a
  // $0.00 total whose group holds no accounts would open an empty ledger,
  // which is worse than plain text. So the rule under test is: every total
  // that actually sums something is a link.
  const notLinks = [];
  for (const label of ["Total Income", "Gross Profit", "Total Expenses", "NET INCOME"]) {
    const el = page.getByText(label, { exact: true }).first();
    const present = await page.getByText(label, { exact: true }).count();
    if (!present) { console.log(`absent      ${label}`); continue; }
    const rowText = await el.evaluate(n => n.parentElement.textContent);
    const empty = /\$0\.00\s*$/.test(rowText);
    const isLink = await page.locator(`a:text-is("${label}")`).count();
    console.log(`${isLink ? "LINK      " : "PLAIN TEXT"}  ${label.padEnd(14)} ${rowText.replace(label, "")}${empty && !isLink ? "  (nothing to open — ok)" : ""}`);
    if (!isLink && !empty) notLinks.push(label);
  }
  expect(notLinks, "totals that sum something must be clickable").toEqual([]);

  // NET INCOME must span BOTH sides -- income and expenses -- or it is not
  // an all-encompassing ledger.
  // NET INCOME must cover the UNION of the income and expense groups.
  // Asserting a raw count instead encodes this sandbox's shape (one
  // revenue account, no expenses) rather than the behaviour.
  const idsOf = async label => {
    const n = await page.locator(`a:text-is("${label}")`).count();
    if (!n) return [];
    const h = await page.locator(`a:text-is("${label}")`).first().getAttribute("href");
    return decodeURIComponent(h.match(/ledger=([^&#]*)/)[1]).split(",").filter(Boolean);
  };
  const ni = page.locator('a:text-is("NET INCOME")').first();
  const niIds = await idsOf("NET INCOME");
  const union = [...new Set([...(await idsOf("Total Income")), ...(await idsOf("Total Expenses"))])];
  console.log(`NET INCOME spans ${niIds.length}; income+expenses union is ${union.length}`);
  expect([...niIds].sort()).toEqual(union.sort());
  expect(niIds.length).toBeGreaterThan(0);

  await ni.click();
  await page.waitForTimeout(6000);
  const rows = await page.locator("table tbody tr").count();
  console.log("NET INCOME ledger rows:", rows);
  expect(rows).toBeGreaterThan(0);
});
