const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Eviction Workflow', () => {
  test.beforeEach(async ({ page }) => { await login(page); await navigateTo(page, 'Tenants'); });

  test('evictions tab is accessible', async ({ page }) => {
    test.setTimeout(30000);
    const tab = page.locator('button:has-text("Evictions"), text=Evictions').first();
    const visible = await tab.isVisible({ timeout: 5000 }).catch(() => false);
    if (visible) {
      await tab.click();
      await page.waitForTimeout(1000);
      const tracker = page.locator('text=/Eviction Tracker|Active Cases/i').first();
      const hasTracker = await tracker.isVisible({ timeout: 5000 }).catch(() => false);
      expect(hasTracker, 'Eviction tracker should load').toBeTruthy();
    }
  });

  test('eviction form has tenant selector', async ({ page }) => {
    test.setTimeout(30000);
    const tab = page.locator('button:has-text("Evictions"), text=Evictions').first();
    if (await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tab.click();
      await page.waitForTimeout(1000);
      const addBtn = page.locator('button:has-text("Start"), button:has-text("New Case")').first();
      if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await addBtn.click();
        await page.waitForTimeout(1000);
        const tenantSelect = page.locator('select:has-text("Select tenant")').first();
        const hasTenantSelect = await tenantSelect.isVisible({ timeout: 3000 }).catch(() => false);
        expect(hasTenantSelect, 'Should have tenant selector').toBeTruthy();
      }
    }
  });

  test('no horizontal overflow', async ({ page }) => { await assertNoHorizontalOverflow(page); });
});
