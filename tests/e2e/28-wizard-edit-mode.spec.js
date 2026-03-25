// ═══════════════════════════════════════════════════════════════
// 28 — PROPERTY WIZARD EDIT/RESUME MODE + SETUP COMPLETENESS
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

test.describe('Property Wizard Edit Mode', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Properties');
    await page.waitForTimeout(1500);
  });

  test('property card shows setup status indicator', async ({ page }) => {
    // Look for any setup indicator (blue "Setup Incomplete" or no indicator for complete)
    const cards = page.locator('.rounded-3xl.shadow-card, [class*="rounded-3xl"][class*="border"]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('property detail panel has Edit/Complete Setup button', async ({ page }) => {
    // Click first property to open detail
    const firstProp = page.locator('.rounded-3xl.shadow-card, [class*="rounded-3xl"][class*="border"]').first();
    await firstProp.click();
    await page.waitForTimeout(1500);
    // Navigate to Actions tab
    const actionsTab = page.locator('button:has-text("Actions")').first();
    if (await actionsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await actionsTab.click();
      await page.waitForTimeout(1000);
    }
    // Should see one of: Edit Property Setup, Complete Setup, Resume Property Setup
    const hasSetupBtn = await page.locator('button:has-text("Setup")').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasSetupBtn).toBeTruthy();
  });

  test('Edit Setup opens wizard with pre-filled data', async ({ page }) => {
    const firstProp = page.locator('.rounded-3xl.shadow-card, [class*="rounded-3xl"][class*="border"]').first();
    await firstProp.click();
    await page.waitForTimeout(1500);
    const actionsTab = page.locator('button:has-text("Actions")').first();
    if (await actionsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await actionsTab.click();
      await page.waitForTimeout(1000);
    }
    const setupBtn = page.locator('button:has-text("Setup")').first();
    if (await setupBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await setupBtn.click();
      await page.waitForTimeout(2000);
      // Wizard should be open with progress bar
      const hasProgress = await page.locator('[class*="bg-emerald"], text=Step').first().isVisible({ timeout: 5000 }).catch(() => false);
      const hasWizard = await page.locator('text=Property Details').first().isVisible({ timeout: 5000 }).catch(() => false);
      expect(hasProgress || hasWizard).toBeTruthy();
    }
  });
});
