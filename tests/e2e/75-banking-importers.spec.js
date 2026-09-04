// Banking and the two bulk importers.
//
// These are the highest-risk screens in the app: the bank review queue
// writes journal entries, and both importers can create or rename records
// in bulk. Every test here is deliberately read-only or ends in Cancel --
// nothing in this file commits an import or posts an entry. The books
// must read exactly the same after this spec as before it.
const { test, expect } = require('@playwright/test');
const { gotoRoute, watchForFailures } = require('./helpers');

test.describe('Bank transactions', () => {
  test('review queue renders with its tabs and counts', async ({ page }) => {
    const problems = watchForFailures(page);
    await gotoRoute(page, 'acct_bankimport');

    await expect(page.locator('h3:has-text("Bank Transactions")')).toBeVisible({ timeout: 60000 });

    // The four queue tabs carry counts in their labels; at minimum they
    // must all be present and clickable.
    for (const tab of ['For Review', 'Categorized', 'Excluded', 'Rules']) {
      await expect(page.locator(`button:has-text("${tab}")`).first()).toBeVisible();
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('switching tabs actually changes what is listed', async ({ page }) => {
    await gotoRoute(page, 'acct_bankimport');
    await page.locator('button:has-text("Categorized")').first().click();
    await page.waitForTimeout(2500);
    const categorizedHeader = await page.locator('main thead').innerText().catch(() => '');
    await page.locator('button:has-text("Excluded")').first().click();
    await page.waitForTimeout(2500);
    const excludedHeader = await page.locator('main thead').innerText().catch(() => '');

    // Categorized shows a CATEGORY column, Excluded shows REASON. If the
    // tab did nothing, these would be identical.
    expect(categorizedHeader).not.toEqual(excludedHeader);
  });

  test('the Shortcuts affordance opens the help sheet', async ({ page }) => {
    await gotoRoute(page, 'acct_bankimport');
    const hint = page.locator('button[title="Keyboard shortcuts"]').first();
    await expect(hint).toBeVisible({ timeout: 30000 });
    await hint.click();
    const sheet = page.locator('[role="dialog"][aria-label="Keyboard shortcuts"]');
    await expect(sheet).toBeVisible();
    // It must describe the review queue keys, not just exist.
    await expect(sheet).toContainText(/Bank Transactions/i);
    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
  });
});

test.describe('Reconcile', () => {
  test('renders without errors', async ({ page }) => {
    const problems = watchForFailures(page);
    await gotoRoute(page, 'acct_reconcile');
    const body = await page.locator('body').innerText();
    expect(body.length).toBeGreaterThan(50);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

test.describe('QuickBooks import', () => {
  test('opens on the file step and does not start an import by itself', async ({ page }) => {
    const problems = watchForFailures(page);
    await gotoRoute(page, 'acct_qbimport');
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/QuickBooks/i);
    // A wizard that begins importing on page load would be catastrophic;
    // assert we are parked on an input step.
    expect(body).not.toMatch(/Importing…|Posting journal entries/i);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

test.describe('Property import', () => {
  test('shows the download step with the real property count', async ({ page }) => {
    const problems = watchForFailures(page);
    await gotoRoute(page, 'property_import');

    await expect(page.locator('h3:has-text("Import properties from Excel")')).toBeVisible({ timeout: 60000 });
    // The copy states how many properties the template will contain. It
    // must reflect real data, not a hardcoded number or zero.
    const body = await page.locator('main').innerText();
    const m = body.match(/(\d+)\s+existing properties/);
    expect(m, 'the download step should state how many properties exist').not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(0);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('the step bar starts at Download and nothing is committed', async ({ page }) => {
    await gotoRoute(page, 'property_import');
    const body = await page.locator('main').innerText();
    for (const step of ['Download', 'Upload', 'Review', 'Done']) {
      expect(body).toContain(step);
    }
    expect(body).not.toMatch(/Import complete/i);
  });

  test('downloading the template produces a real workbook', async ({ page }) => {
    await gotoRoute(page, 'property_import');
    const btn = page.locator('button:has-text("Download template")');
    await expect(btn).toBeVisible({ timeout: 60000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120000 }),
      btn.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const stream = await download.createReadStream();
    let bytes = 0;
    for await (const chunk of stream) bytes += chunk.length;
    // A real multi-sheet workbook with 41 properties and 73 tenants is
    // several kilobytes; an empty or failed one is not.
    expect(bytes, 'downloaded workbook looks empty').toBeGreaterThan(5000);
  });
});
