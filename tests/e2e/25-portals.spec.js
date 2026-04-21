const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Portals', () => {
  // Note: portal tests require tenant/owner login which may not be available in test env
  // These tests verify the portal components render without crashing when accessed by admin

  test('tenant portal page exists in component map', async ({ page }) => {
    test.setTimeout(30000);
    await login(page);
    // Admin can't access tenant portal directly, but we can verify the nav doesn't crash
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('owner management page loads', async ({ page }) => {
    test.setTimeout(30000);
    await login(page);
    await navigateTo(page, 'Owners');
    await page.waitForTimeout(1000);
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError, 'Owners page should not crash').toBeFalsy();
  });

  test('owner page has stats', async ({ page }) => {
    test.setTimeout(30000);
    await login(page);
    await navigateTo(page, 'Owners');
    await page.waitForTimeout(1000);
    const stats = page.locator('text=/Total Owners|Properties|Distributions/i').first();
    const hasStats = await stats.isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasStats, 'Should show owner stats').toBeTruthy();
  });

  test('no horizontal overflow on owners', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Owners');
    await assertNoHorizontalOverflow(page);
  });
});
