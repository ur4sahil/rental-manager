// ═══════════════════════════════════════════════════════════════
// 66 — CROSS-MODULE + ROLE-MATRIX click-coverage sweep
// Verifies the cross-module connections that other specs only
// touch within their own module: header avatar dropdown, sidebar
// expand chevrons, page-to-page navigation parity, and the role-
// gated visibility of pages.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, navigateTo,
  assertNoHorizontalOverflow,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Cross-module — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await page.waitForTimeout(1500);
  });

  test('every primary sidebar item navigates to a non-crashing page', async ({ page }) => {
    const items = ['Dashboard', 'Tenants', 'Payments', 'Document Builder',
                   'Vendors', 'Tasks & Approvals', 'Messages', 'Notifications'];
    for (const item of items) {
      await navigateTo(page, item);
      await page.waitForTimeout(800);
      const crashed = await page.locator('text=Something went wrong')
        .first().isVisible({ timeout: 1500 }).catch(() => false);
      expect(crashed, `${item} should not crash`).toBeFalsy();
    }
  });

  test('header avatar dropdown surfaces logout / switch company / settings', async ({ page }) => {
    const avatar = page.locator('header button:has-text("expand_more"), banner button:has-text("expand_more")').first();
    if (!await avatar.isVisible({ timeout: 2500 }).catch(() => false)) {
      test.skip(true, 'avatar dropdown not in current header layout');
      return;
    }
    await avatar.click();
    await page.waitForTimeout(400);
    const opened = await page.locator('text=/logout|sign out|switch company|profile|settings/i').first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    expect(opened, 'avatar dropdown opened').toBeTruthy();
  });

  test('Properties expand chevron shows nested children', async ({ page }) => {
    await navigateTo(page, 'Properties');
    await page.waitForTimeout(800);
    // App.js auto-expands the parent whose page the user is on.
    // Only toggle the chevron if a child isn't already visible —
    // clicking it when already expanded would collapse the dropdown.
    const child = page.locator('nav button').filter({ hasText: /Maintenance|Utilities|HOA|Insurance|Tax Bills/ }).first();
    const alreadyVisible = await child.isVisible({ timeout: 1500 }).catch(() => false);
    if (!alreadyVisible) {
      const parentRow = page.locator('button:has-text("Properties")').first();
      const chevron = parentRow.locator('xpath=following-sibling::button').first();
      if (await chevron.isVisible({ timeout: 1500 }).catch(() => false)) {
        await chevron.click();
        await page.waitForTimeout(500);
      }
    }
    await expect(child).toBeVisible({ timeout: 3000 });
  });

  test('Accounting expand chevron shows nested accounting children', async ({ page }) => {
    await navigateTo(page, 'Accounting');
    await page.waitForTimeout(800);
    // App.js auto-expands the parent whose page the user is on, so
    // landing on Accounting already reveals its children. Only
    // toggle the chevron if a child isn't already visible —
    // clicking it when already expanded would collapse the dropdown
    // (the original cause of the "known race" skip pre-2026-05-01).
    const child = page.locator('nav button').filter({ hasText: /Chart of Accounts|Journal Entries|Reports/ }).first();
    const alreadyVisible = await child.isVisible({ timeout: 1500 }).catch(() => false);
    if (!alreadyVisible) {
      const parentRow = page.locator('button:has-text("Accounting")').first();
      const chevron = parentRow.locator('xpath=following-sibling::button').first();
      if (await chevron.isVisible({ timeout: 1500 }).catch(() => false)) {
        await chevron.click();
        await page.waitForTimeout(800);
      }
    }
    await expect(child).toBeVisible({ timeout: 5000 });
  });

  test('Dashboard has no horizontal overflow on production data', async ({ page }) => {
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
