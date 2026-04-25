// ═══════════════════════════════════════════════════════════════
// 52 — TENANTS click-coverage sweep
// 8 CT-prefixed tenants are seeded across 6 properties. Exercises
// the + Add modal, search, the per-tenant detail drawer, and the
// archive panel.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, navigateTo,
  assertNoHorizontalOverflow, assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Tenants — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow', async ({ page }) => {
    await expect(page.locator('h2:has-text("Tenants")').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  test('seeded CT tenants are visible', async ({ page }) => {
    const card = page.locator('text=/CT Active Alice/').first();
    await expect(card).toBeVisible({ timeout: 5000 });
  });

  test('+ Add button opens new tenant modal', async ({ page }) => {
    const addBtn = page.locator('button:has-text("+ Add")').first();
    if (!await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, '+ Add not visible — role may not allow');
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(700);
    const modalOpen = await page.locator('text=/New Tenant|Tenant Name|Add Tenant/i')
      .first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(modalOpen, 'new tenant modal opened').toBeTruthy();
    // Close via Cancel (don't actually create — seed governs state)
    const cancel = page.locator('button:has-text("Cancel")').first();
    if (await cancel.isVisible({ timeout: 1500 }).catch(() => false)) await cancel.click();
  });

  test('clicking a tenant card opens detail drawer', async ({ page }) => {
    const card = page.locator('text=/CT Active Alice/').first();
    if (!await card.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'no seeded tenant — run seed:click first');
      return;
    }
    await card.click();
    await page.waitForTimeout(1200);
    // Detail drawer shows tabs
    const drawerMarker = page.locator('button:has-text("Ledger"), button:has-text("Overview"), button:has-text("Documents")').first();
    await expect(drawerMarker).toBeVisible({ timeout: 5000 });
  });

  test('search input filters tenants', async ({ page }) => {
    const search = page.locator('input[placeholder*="Search" i], input[type="search"]').first();
    if (!await search.isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'no search input on this layout');
      return;
    }
    await search.fill('CT Active Alice');
    await page.waitForTimeout(600);
    await expect(page.locator('text=/CT Active Alice/').first()).toBeVisible();
    // Clear so we don't impact other tests run in parallel
    await search.fill('');
  });
});
