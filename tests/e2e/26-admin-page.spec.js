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
    const adminBtn = page.locator('button[title="Admin Settings"]').first();
    await expect(adminBtn).toBeVisible({ timeout: 5000 });
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
    const logoutBtn = page.locator('button[title="Sign Out"]').first();
    await expect(logoutBtn).toBeVisible({ timeout: 5000 });
  });
});
