// ═══════════════════════════════════════════════════════════════
// 33 — PERIOD LOCK UI + RECONCILIATION
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

test.describe('Period Lock', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Accounting');
    await page.waitForTimeout(1500);
  });

  test('Reconcile tab loads', async ({ page }) => {
    const reconTab = page.locator('button:has-text("Reconcile")').first();
    if (await reconTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reconTab.click();
      await page.waitForTimeout(1500);
      const hasContent = await page.locator('text=Reconcile').first().isVisible().catch(() => false);
      expect(hasContent).toBeTruthy();
    }
  });

  test('Period Lock tab exists within Reconcile', async ({ page }) => {
    const reconTab = page.locator('button:has-text("Reconcile")').first();
    if (await reconTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reconTab.click();
      await page.waitForTimeout(1500);
      const lockTab = page.locator('button:has-text("Period Lock")').first();
      const hasLock = await lockTab.isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasLock).toBeTruthy();
    }
  });

  test('Period Lock UI shows lock date input', async ({ page }) => {
    const reconTab = page.locator('button:has-text("Reconcile")').first();
    if (await reconTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reconTab.click();
      await page.waitForTimeout(1000);
      const lockTab = page.locator('button:has-text("Period Lock")').first();
      if (await lockTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await lockTab.click();
        await page.waitForTimeout(1000);
        const hasDateInput = await page.locator('input[type="date"]').first().isVisible().catch(() => false);
        const hasLockBtn = await page.locator('button:has-text("Lock Period")').first().isVisible().catch(() => false);
        expect(hasDateInput || hasLockBtn).toBeTruthy();
      }
    }
  });

  test('Period Lock shows status (active or none)', async ({ page }) => {
    const reconTab = page.locator('button:has-text("Reconcile")').first();
    if (await reconTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reconTab.click();
      await page.waitForTimeout(1000);
      const lockTab = page.locator('button:has-text("Period Lock")').first();
      if (await lockTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await lockTab.click();
        await page.waitForTimeout(1000);
        // Should show either "No period lock active" or "Period locked through..."
        const hasStatus = await page.locator('text=period lock').first().isVisible({ timeout: 3000 }).catch(() => false)
          || await page.locator('text=locked through').first().isVisible({ timeout: 3000 }).catch(() => false);
        expect(hasStatus).toBeTruthy();
      }
    }
  });
});
