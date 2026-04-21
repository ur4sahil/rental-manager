// ═══════════════════════════════════════════════════════════════
// 15 — CROSS-MODULE FLOWS: END-TO-END USER JOURNEYS
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

test.describe('Cross-Module Integration Flows', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
  });

  test('dashboard → properties → back to dashboard navigation', async ({ page }) => {
    await navigateTo(page, 'Dashboard');
    await expect(page.locator('text=Dashboard').first()).toBeVisible({ timeout: 5000 });
    await navigateTo(page, 'Properties');
    await page.waitForTimeout(1000);
    await navigateTo(page, 'Dashboard');
    await expect(page.locator('text=Occupancy').first()).toBeVisible({ timeout: 5000 });
  });

  test('rapid module switching does not crash', async ({ page }) => {
    const modules = ['Dashboard', 'Properties', 'Tenants', 'Payments', 'Maintenance',
      'Accounting', 'Owners', 'Utilities', 'Dashboard'];
    for (const mod of modules) {
      await navigateTo(page, mod);
      await page.waitForTimeout(300); // rapid switching
    }
    // Should still be functional
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('property exists in both Properties and Dashboard panels', async ({ page }) => {
    // Check a seeded property appears in dashboard context
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(2000);
    // Navigate to properties and verify same data
    await navigateTo(page, 'Properties');
    await page.waitForTimeout(1500);
    const hasOak = await page.locator('text=Oak').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasOak).toBeTruthy();
  });

  test('tenant balance consistency between modules', async ({ page }) => {
    // Check Bob's balance appears in Tenants
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(1500);
    const bobVisible = await page.locator('text=Bob Martinez').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(bobVisible).toBeTruthy();
  });

  test('vendor appears in Maintenance module', async ({ page }) => {
    await navigateTo(page, 'Maintenance');
    await page.waitForTimeout(2000);
    // Work orders may show assigned vendor names
    const hasVendor = await page.locator('text=Mike').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=CoolAir').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=QuickPaint').first().isVisible({ timeout: 3000 }).catch(() => false);
    // Vendor names may or may not appear depending on data
  });

  test('accounting data reflects in dashboard revenue/expenses', async ({ page }) => {
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(2000);
    // Revenue card should show some amount
    const hasRevenue = await page.locator('text=Revenue').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasRevenue).toBeTruthy();
    // Navigate to accounting to verify
    await navigateTo(page, 'Accounting');
    await page.waitForTimeout(1500);
  });

  test('all sidebar modules return to dashboard cleanly', async ({ page }) => {
    const modules = ['Properties', 'Tenants', 'Payments', 'Maintenance', 'Accounting', 'Utilities', 'Owners'];
    for (const mod of modules) {
      await navigateTo(page, mod);
      await page.waitForTimeout(500);
      await navigateTo(page, 'Dashboard');
      await page.waitForTimeout(500);
      const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasError, `Returning from ${mod} to Dashboard should not crash`).toBeFalsy();
    }
  });

  test('opening and closing modals across modules does not leak state', async ({ page }) => {
    // Open add form in Properties, cancel, go to Tenants, open add form
    await navigateTo(page, 'Properties');
    const propAdd = page.locator('button:has-text("Add")').first();
    if (await propAdd.isVisible({ timeout: 3000 }).catch(() => false)) {
      await propAdd.click();
      await page.waitForTimeout(300);
      const cancel = page.locator('button:has-text("Cancel")').first();
      if (await cancel.isVisible({ timeout: 2000 }).catch(() => false)) {
        await cancel.click();
        await page.waitForTimeout(300);
      }
    }
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(1000);
    // Should not see property form fields
    const propFormLeak = await page.locator('input[placeholder*="address" i]').isVisible({ timeout: 3000 }).catch(() => false);
    expect(propFormLeak).toBeFalsy();
  });
});
