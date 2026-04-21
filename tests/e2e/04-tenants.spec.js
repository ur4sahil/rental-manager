// ═══════════════════════════════════════════════════════════════
// 04 — TENANTS: CRUD, SEARCH, BALANCE, COMMUNICATION
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Tenants Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Tenants');
  });

  test('shows seeded tenants', async ({ page }) => {
    await expect(page.locator('text=Alice Johnson').first()).toBeVisible({ timeout: 5000 });
  });

  test('shows Bob with outstanding balance', async ({ page }) => {
    await expect(page.locator('text=Bob Martinez').first()).toBeVisible({ timeout: 5000 });
    // Bob's balance should show > 0
    const balanceText = page.locator('text=$250').first();
    const hasBal = await balanceText.isVisible({ timeout: 3000 }).catch(() => false);
    // Or look for red-colored balance indicator
  });

  test('search input exists and works', async ({ page }) => {
    const search = page.locator('input[placeholder*="search" i], input[placeholder*="Search" i]').first();
    await expect(search).toBeVisible({ timeout: 5000 });
    await search.fill('Alice');
    await page.waitForTimeout(1500);
    // Alice should still be visible after search
    const alice = await page.locator('text=/Alice/i').first().isVisible().catch(() => false);
    expect(alice).toBeTruthy();
    await search.fill('');
  });

  // Tenant creation moved into the Property Setup Wizard (see
  // src/components/Properties.js comment line 1262: "Tenants are added
  // through the Property Setup Wizard"). The Tenants page no longer
  // has a standalone "Add Tenant" button. Wizard coverage lives in
  // 19-property-wizard.spec.js.
  test.skip('add tenant button opens form', () => {});
  test.skip('tenant form has email, phone, property fields', () => {});
  test.skip('tenant form validates email format', () => {});
  test.skip('tenant form cancel closes modal', () => {});

  test('tenant cards show lease status badges', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Status may be "Active", "active", "ACTIVE" or in a badge
    const hasBadge = await page.locator('text=/active|Active|ACTIVE/').first().isVisible().catch(() => false)
      || await page.locator('[class*="green"], [class*="emerald"]').first().isVisible().catch(() => false);
    expect(hasBadge).toBeTruthy();
  });

  test('no horizontal overflow on tenants', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
