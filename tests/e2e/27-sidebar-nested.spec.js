// ═══════════════════════════════════════════════════════════════
// 27 — NESTED SIDEBAR NAVIGATION + PAGE PERSISTENCE
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, goToPage, navigateTo } = require('./helpers');

test.describe('Nested Sidebar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Properties has expand/collapse chevron', async ({ page }) => {
    const chevron = page.locator('button:has(span:has-text("expand_more"))').first();
    await expect(chevron).toBeVisible({ timeout: 5000 });
  });

  test('clicking chevron reveals nested items', async ({ page }) => {
    const chevron = page.locator('button:has(span:has-text("expand_more"))').first();
    await chevron.click();
    await page.waitForTimeout(500);
    // Should see nested items like Maintenance, Utilities, etc.
    const maintenance = page.locator('nav button:has-text("Maintenance")').first();
    const utilities = page.locator('nav button:has-text("Utilities")').first();
    const hasMaint = await maintenance.isVisible({ timeout: 2000 }).catch(() => false);
    const hasUtil = await utilities.isVisible({ timeout: 2000 }).catch(() => false);
    expect(hasMaint || hasUtil).toBeTruthy();
  });

  test('nested items navigate to correct pages', async ({ page }) => {
    await goToPage(page, 'maintenance');
    await page.waitForTimeout(1500);
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
    // Should see maintenance content
    const hasContent = await page.locator('text=Work Order').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Maintenance').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('all nested modules load without crash', async ({ page }) => {
    test.setTimeout(60000);
    const nestedPages = ['maintenance', 'utilities', 'hoa', 'loans', 'insurance', 'inspections'];
    for (const pg of nestedPages) {
      await goToPage(page, pg);
      await page.waitForTimeout(1000);
      const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasError, `${pg} should not crash`).toBeFalsy();
    }
  });
});

test.describe('Page Persistence on Refresh', () => {
  test('page survives browser refresh', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Accounting');
    await page.waitForTimeout(1500);
    const onAccounting = await page.locator('text=Accounting').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(onAccounting).toBeTruthy();
    // Confirm the company was persisted to localStorage during login —
    // that's the signal App.js uses to restore the user's company on
    // refresh (see autoSelectCompany second-chance branch).
    const lastCompanyId = await page.evaluate(() => localStorage.getItem('lastCompanyId'));
    expect(lastCompanyId, 'lastCompanyId should have been saved on company select').toBeTruthy();
    // Refresh
    await page.reload({ waitUntil: 'networkidle' });
    // Auto-select + Accounting render needs a moment.
    await page.waitForTimeout(4000);
    // We shouldn't have been bounced to the Company Selector.
    const onSelector = await page.locator('heading:has-text("Your Companies"), h2:has-text("Your Companies")').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(onSelector, 'should NOT be on the Company Selector after reload').toBeFalsy();
    // Sidebar should be back.
    const stillOnApp = await page.locator('nav').first().isVisible({ timeout: 10000 }).catch(() => false);
    expect(stillOnApp).toBeTruthy();
  });
});
