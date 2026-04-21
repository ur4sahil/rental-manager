const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Insurance Tracker', () => {
  test.beforeEach(async ({ page }) => { await login(page); await navigateTo(page, 'Insurance'); });

  test('insurance page loads without crash', async ({ page }) => {
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('insurance page has stats row', async ({ page }) => {
    const stats = page.locator('text=/Active Policies|Total Premium|Expiring/i').first();
    const hasStats = await stats.isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasStats, 'Should show insurance stats').toBeTruthy();
  });

  test('insurance page has add button', async ({ page }) => {
    const btn = page.locator('button:has-text("Add"), button:has-text("New Policy")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('no horizontal overflow', async ({ page }) => { await assertNoHorizontalOverflow(page); });
});
