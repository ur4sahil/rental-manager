const { test, expect } = require("@playwright/test");

// A ledger opened from a TOTAL spans many accounts. It used to build one
// flat list with a single running balance across all of them, which adds
// cash to receivables to income -- so the balance column meant nothing
// and the rows read as jumbled. It has to render as a stack of ledgers,
// each with its own subtotal, like the QuickBooks exports.
//
// Also asserts the column count, because the header used to key on
// ids.length while the colSpans keyed on how many accounts actually had
// entries -- a 9-column header over 8-column rows.
test("combined ledger is grouped per account with its own totals", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/?company=sandbox-llc");
  await page.locator('button:visible:has-text("Dashboard")').first().waitFor({ state: "visible", timeout: 90000 });
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#acct_reports");
  const bs = page.getByText("Balance Sheet", { exact: true }).first();
  await bs.waitFor({ state: "visible", timeout: 90000 }); await bs.click();
  await page.getByText("TOTAL LIABILITIES AND EQUITY").first().waitFor({ state: "visible", timeout: 120000 });

  // Amount must be clickable too, not just the label.
  const amtLink = page.locator('a:has-text("$")').first();
  console.log("an amount is a link:", await amtLink.count() > 0);

  await page.locator('a:text-is("TOTAL ASSETS")').first().click();
  await page.waitForTimeout(6000);

  const body = await page.locator("body").innerText();
  const perAcct = (body.match(/Total for /g) || []).length;
  const tbodies = await page.locator("table tbody").count();
  const rows = await page.locator("table tbody tr").count();
  console.log(`tbodies (one per account): ${tbodies}`);
  console.log(`per-account subtotal rows ("Total for ..."): ${perAcct}`);
  console.log(`total rows: ${rows}`);
  // Read the LAST tbody's text, not the page body -- the modal header
  // also says "N accounts", which made this match the wrong thing.
  const lastBody = await page.locator("table tbody").last().innerText();
  console.log("grand total tbody:", JSON.stringify(lastBody.replace(/\n+/g, " | ").slice(0, 120)));
  const grand = /(\d+) accounts/.exec(lastBody);
  console.log("accounts named in grand total:", grand ? grand[1] : "MISSING");
  // Per-account subtotal labels, from inside the table only.
  const acctSubtotals = (await page.locator("table tbody tr").allInnerTexts()).filter(t => /^Total for /.test(t.trim()));
  console.log("per-account subtotal rows in table:", acctSubtotals.length);
  acctSubtotals.slice(0,3).forEach(t => console.log("   " + t.replace(/\s+/g," ").slice(0,80)));
  // Header must not claim a column the rows do not render.
  const ths = await page.locator("table thead th").count();
  const firstRowTds = await page.locator("table tbody tr").nth(1).locator("td").count();
  console.log(`header cols=${ths}  a data row's cols=${firstRowTds}`);

  expect(perAcct, "no per-account subtotals — still one flat list").toBeGreaterThan(0);
  expect(grand, "no grand total row").toBeTruthy();

  expect(acctSubtotals.length, "no per-account subtotals — still one flat list").toBeGreaterThan(0);
  expect(Number(grand && grand[1]), "grand total should name the accounts that have entries")
    .toBe(acctSubtotals.length);
  expect(ths, "header column count must match the data rows").toBe(firstRowTds);
  // A combined closing balance would sum unlike accounts; it must be
  // dashed out rather than shown as an authoritative figure.
  expect(lastBody).toContain("—");
});
