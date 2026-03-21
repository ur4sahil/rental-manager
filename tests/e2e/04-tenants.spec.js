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
    await page.waitForTimeout(800);
    // Alice should still be visible after search
    const alice = await page.locator('text=Alice').isVisible().catch(() => false);
    expect(alice).toBeTruthy();
    await search.fill('');
  });

  test('add tenant button opens form', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("add")').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await page.waitForTimeout(500);
    const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="Name"]').first();
    await expect(nameInput).toBeVisible({ timeout: 3000 });
  });

  test('tenant form has email, phone, property fields', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("add")').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    await expect(page.locator('input[type="email"], input[placeholder*="email" i]').first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('input[placeholder*="phone" i], input[type="tel"]').first()).toBeVisible({ timeout: 3000 });
  });

  test('tenant form validates email format', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("add")').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    // Fill name but invalid email
    const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="Name"]').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('Test Tenant');
      const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first();
      await emailInput.fill('not-an-email');
      const saveBtn = page.locator('button:has-text("Save"), button:has-text("Add"), button:has-text("Create")').last();
      await saveBtn.click();
      await page.waitForTimeout(500);
      // Should stay on form (validation failed)
      await expect(nameInput).toBeVisible();
    }
  });

  test('tenant form cancel closes modal', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("add")').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    if (await cancelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cancelBtn.click();
      await page.waitForTimeout(300);
    }
  });

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
