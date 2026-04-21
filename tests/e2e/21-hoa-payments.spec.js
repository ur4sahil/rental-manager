const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('HOA Payments', () => {
  test.beforeEach(async ({ page }) => { await login(page); await navigateTo(page, 'HOA'); });

  test('HOA page loads without crash', async ({ page }) => {
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('HOA page has add button', async ({ page }) => {
    const btn = page.locator('button:has-text("Add"), button:has-text("New HOA")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('HOA form opens with required fields', async ({ page }) => {
    const btn = page.locator('button:has-text("Add"), button:has-text("New HOA")').first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(1000);
      const nameField = page.locator('input[placeholder*="HOA"], label:has-text("HOA"), input[placeholder*="name"]').first();
      const hasField = await nameField.isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasField, 'HOA form should have name field').toBeTruthy();
    }
  });

  test('no horizontal overflow', async ({ page }) => { await assertNoHorizontalOverflow(page); });
});
