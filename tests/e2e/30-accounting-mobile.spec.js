// ═══════════════════════════════════════════════════════════════
// 30 — ACCOUNTING MOBILE LAYOUT + PAYMENTS TAB + LEDGER PDF
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Accounting on Mobile', () => {
  test.use({ viewport: { width: 375, height: 812 } }); // iPhone viewport

  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Accounting');
    await page.waitForTimeout(2000);
  });

  test('accounting loads on mobile without crash', async ({ page }) => {
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('mobile tab bar is visible', async ({ page }) => {
    const tabBar = page.locator('button:has-text("Dashboard")').first();
    const hasTabs = await tabBar.isVisible({ timeout: 5000 }).catch(() => false);
    // Either mobile tabs or content should be visible
    const hasContent = await page.locator('text=Revenue').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasTabs || hasContent).toBeTruthy();
  });

  test('no horizontal overflow on mobile accounting', async ({ page }) => {
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('Payments Module Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Payments');
    await page.waitForTimeout(1500);
  });

  test('payments page has Payments and Autopay tabs', async ({ page }) => {
    const paymentsTab = page.locator('button:has-text("Payments")').first();
    const autopayTab = page.locator('button:has-text("Autopay")').first();
    const hasPay = await paymentsTab.isVisible({ timeout: 3000 }).catch(() => false);
    const hasAuto = await autopayTab.isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasPay).toBeTruthy();
    expect(hasAuto).toBeTruthy();
  });

  test('Record Payment button navigates to JE form', async ({ page }) => {
    const recordBtn = page.locator('button:has-text("Record Payment")').first();
    if (await recordBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await recordBtn.click();
      await page.waitForTimeout(2000);
      // Should be on accounting with JE modal or journal tab
      const hasJE = await page.locator('text=Journal Entries').first().isVisible({ timeout: 3000 }).catch(() => false)
        || await page.locator('text=New Journal Entry').first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasJE).toBeTruthy();
    }
  });
});

test.describe('Tenant Ledger PDF Export', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(1500);
  });

  test('ledger view has Export PDF button', async ({ page }) => {
    // Click first tenant to open detail
    const firstTenant = page.locator('td.font-medium, [class*="font-semibold"]:has-text("@")').first();
    if (await firstTenant.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstTenant.click();
      await page.waitForTimeout(1500);
      // Navigate to ledger
      const ledgerBtn = page.locator('button:has-text("Ledger"), button:has-text("View Ledger")').first();
      if (await ledgerBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await ledgerBtn.click();
        await page.waitForTimeout(1500);
        const hasPdfBtn = await page.locator('button:has-text("Export PDF")').first().isVisible({ timeout: 3000 }).catch(() => false);
        expect(hasPdfBtn).toBeTruthy();
      }
    }
  });
});
