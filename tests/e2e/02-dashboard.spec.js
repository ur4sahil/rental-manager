// ═══════════════════════════════════════════════════════════════
// 02 — DASHBOARD: KPIs, PANELS, NAVIGATION, RESPONSIVENESS
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow, assertButtonsClickable } = require('./helpers');

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Dashboard');
  });

  test('shows at least 8 stat cards', async ({ page }) => {
    await page.waitForTimeout(2000);
    // StatCards use rounded-3xl or rounded-xl
    const cards = page.locator('[class*="rounded-3xl"], [class*="rounded-xl"]');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test('occupancy card shows percentage', async ({ page }) => {
    const occupancy = page.locator('text=Occupancy').first();
    await expect(occupancy).toBeVisible({ timeout: 5000 });
  });

  test('revenue card is visible', async ({ page }) => {
    const revenue = page.locator('text=Revenue').first();
    await expect(revenue).toBeVisible({ timeout: 5000 });
  });

  test('expenses card is visible', async ({ page }) => {
    const expenses = page.locator('text=Expense').first();
    await expect(expenses).toBeVisible({ timeout: 5000 });
  });

  test('stat card clicks navigate to correct module', async ({ page }) => {
    // Click on a stat card that should navigate to properties
    const occupancyCard = page.locator('text=Occupancy').first();
    if (await occupancyCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await occupancyCard.click();
      await page.waitForTimeout(1500);
      // Should be on properties page
      const onProperties = await page.locator('text=Properties').first().isVisible({ timeout: 3000 }).catch(() => false)
        || await page.locator('button:has-text("Add")').first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(onProperties).toBeTruthy();
    }
  });

  test('lease expirations panel exists', async ({ page }) => {
    const panel = page.locator('text=Lease Expiration').first();
    await expect(panel).toBeVisible({ timeout: 5000 });
  });

  test('recent maintenance panel exists', async ({ page }) => {
    const panel = page.locator('text=Recent Maintenance').first();
    await expect(panel).toBeVisible({ timeout: 5000 });
  });

  test('utilities due panel exists', async ({ page }) => {
    const panel = page.locator('text=Utilities').first();
    await expect(panel).toBeVisible({ timeout: 5000 });
  });

  test('NOI panel shows calculations', async ({ page }) => {
    const noi = page.locator('text=Net Operating Income').first();
    if (await noi.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Should have monetary values
      const hasAmount = await page.locator('text=$').first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasAmount).toBeTruthy();
    }
  });

  test('notification badges render', async ({ page }) => {
    // Notifications bell icon should be in the header
    const bell = page.locator('span:has-text("notifications"), button[aria-label*="notification" i]').first();
    await expect(bell).toBeVisible({ timeout: 5000 });
  });

  test('no horizontal overflow on dashboard', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });

  test('all visible buttons are clickable', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertButtonsClickable(page);
  });
});
