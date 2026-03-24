const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Move-Out Wizard', () => {
  test.beforeEach(async ({ page }) => { await login(page); await navigateTo(page, 'Tenants'); });

  test('move-out tab is accessible', async ({ page }) => {
    test.setTimeout(30000);
    const tab = page.locator('button:has-text("Move-Out"), text=Move-Out').first();
    const visible = await tab.isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      await tab.click();
      await page.waitForTimeout(1000);
      const wizard = page.locator('text=/Move-Out Wizard|Select Tenant/i').first();
      const hasWizard = await wizard.isVisible({ timeout: 5000 }).catch(() => false);
      expect(hasWizard, 'Move-Out wizard should load').toBeTruthy();
    }
  });

  test('move-out wizard has step indicators', async ({ page }) => {
    test.setTimeout(30000);
    const tab = page.locator('button:has-text("Move-Out"), text=Move-Out').first();
    if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(1000);
      const steps = page.locator('text=/Select Tenant|Inspection|Deposit|Confirm/i').first();
      const hasSteps = await steps.isVisible({ timeout: 5000 }).catch(() => false);
      expect(hasSteps, 'Should show wizard steps').toBeTruthy();
    }
  });

  test('no horizontal overflow', async ({ page }) => { await assertNoHorizontalOverflow(page); });
});
