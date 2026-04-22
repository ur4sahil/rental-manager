// ═══════════════════════════════════════════════════════════════
// 26 — ADMIN PAGE (Audit Trail + Team & Roles)
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, goToPage } = require('./helpers');

test.describe('Admin Page', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('admin button visible in header', async ({ page }) => {
    // Settings is now behind the avatar dropdown — "A Admin expand_more".
    const avatarBtn = page.locator('header button:has-text("expand_more")').first();
    await expect(avatarBtn).toBeVisible({ timeout: 5000 });
    await avatarBtn.click();
    await expect(page.locator('button:has-text("Settings")')).toBeVisible({ timeout: 3000 });
  });

  test('clicking admin button navigates to admin page', async ({ page }) => {
    await goToPage(page, 'admin');
    const heading = page.locator('text=Admin').first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('audit trail tab loads with data', async ({ page }) => {
    await goToPage(page, 'admin');
    const auditTab = page.locator('button:has-text("Audit Trail")').first();
    await expect(auditTab).toBeVisible({ timeout: 5000 });
    await auditTab.click();
    await page.waitForTimeout(2000);
    const hasTable = await page.locator('table').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasTable).toBeTruthy();
  });

  test('team & roles tab loads', async ({ page }) => {
    await goToPage(page, 'roles');
    await page.waitForTimeout(2000);
    const hasContent = await page.locator('text=Team').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Role').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('sign out button visible in header', async ({ page }) => {
    // Logout now lives inside the avatar dropdown.
    const avatarBtn = page.locator('header button:has-text("expand_more")').first();
    await avatarBtn.click();
    await expect(page.locator('button:has-text("Logout")')).toBeVisible({ timeout: 3000 });
  });
});
