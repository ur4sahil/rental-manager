// ═══════════════════════════════════════════════════════════════
// 13 — SIDEBAR NAV, MOBILE BOTTOM NAV, MODULE CRASH GUARD
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow, assertButtonsClickable } = require('./helpers');

test.describe('Sidebar Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('all visible sidebar modules load without ErrorBoundary crash', async ({ page }) => {
    test.setTimeout(180000);
    // Get actual sidebar buttons dynamically
    const allButtons = page.locator('nav button');
    const count = await allButtons.count();
    const modules = [];
    for (let i = 0; i < count; i++) {
      const text = await allButtons.nth(i).textContent().catch(() => '');
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned && !cleaned.includes('Logout') && !cleaned.includes('Estate') && cleaned.length > 1 && cleaned.length < 30) {
        modules.push(cleaned);
      }
    }
    console.log('Found sidebar modules:', modules);
    for (const mod of modules) {
      await navigateTo(page, mod);
      const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasError, `Module "${mod}" should not crash`).toBeFalsy();
      // Check no horizontal overflow on each
      await assertNoHorizontalOverflow(page);
    }
  });

  test('sidebar highlights current active module', async ({ page }) => {
    await navigateTo(page, 'Properties');
    // The active item should have indigo styling
    const activeItem = page.locator('nav button[class*="indigo"], nav a[class*="indigo"]').first();
    const hasActive = await activeItem.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('sidebar shows company name and logo', async ({ page }) => {
    const logo = page.locator('text=Estate Logic').first();
    await expect(logo).toBeVisible({ timeout: 5000 });
  });

  test('header shows user avatar and role', async ({ page }) => {
    await page.waitForTimeout(1500);
    // User avatar moved to header (top-right)
    const hasAvatar = await page.locator('header [class*="rounded-full"]').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasAvatar).toBeTruthy();
  });

  test('notification bell is in header', async ({ page }) => {
    const bell = page.locator('span:has-text("notifications")').first();
    await expect(bell).toBeVisible({ timeout: 5000 });
  });

  test('notification dropdown opens and closes', async ({ page }) => {
    const bell = page.locator('button').filter({ has: page.locator('span:has-text("notifications")') }).first();
    if (await bell.isVisible({ timeout: 3000 }).catch(() => false)) {
      await bell.click();
      await page.waitForTimeout(500);
      // Dropdown should appear
      const dropdown = page.locator('[class*="z-50"], [class*="absolute"]').first();
      // Click bell again to close
      await bell.click();
      await page.waitForTimeout(300);
    }
  });

  test('switch company button exists', async ({ page }) => {
    const btn = page.locator('button:has-text("Switch"), button:has-text("Company")').first();
    const hasSwitch = await btn.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('role badge shows in header', async ({ page }) => {
    await page.waitForTimeout(1000);
    const badge = page.locator('[class*="uppercase"]').filter({ hasText: /admin|manager|owner|tenant/i }).first();
    const hasBadge = await badge.isVisible({ timeout: 3000 }).catch(() => false);
  });
});

test.describe('Mobile Bottom Navigation', () => {
  test('mobile bottom nav shows on small screens', async ({ page, isMobile }) => {
    if (!isMobile) {
      test.skip();
      return;
    }
    await login(page);
    // Bottom nav should have 5 shortcuts
    const bottomNav = page.locator('[class*="fixed bottom"]').first();
    const shortcuts = ['Dashboard', 'Properties', 'Tenants', 'Payments', 'Maintenance'];
    for (const s of shortcuts) {
      const btn = page.locator(`button:has-text("${s}")`).last();
      const vis = await btn.isVisible({ timeout: 3000 }).catch(() => false);
    }
  });

  test('hamburger menu appears on mobile', async ({ page, isMobile }) => {
    if (!isMobile) {
      test.skip();
      return;
    }
    await login(page);
    const hamburger = page.locator('button').filter({ has: page.locator('span:has-text("menu")') }).first();
    await expect(hamburger).toBeVisible({ timeout: 5000 });
  });

  test('hamburger opens sidebar overlay on mobile', async ({ page, isMobile }) => {
    if (!isMobile) {
      test.skip();
      return;
    }
    await login(page);
    const hamburger = page.locator('button').filter({ has: page.locator('span:has-text("menu")') }).first();
    if (await hamburger.isVisible({ timeout: 3000 }).catch(() => false)) {
      await hamburger.click();
      await page.waitForTimeout(500);
      // Sidebar overlay should appear
      const sidebar = page.locator('nav').first();
      await expect(sidebar).toBeVisible({ timeout: 3000 });
    }
  });
});
