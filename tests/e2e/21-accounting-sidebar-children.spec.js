// ═══════════════════════════════════════════════════════════════
// 21 — ACCOUNTING SIDEBAR CHILDREN
// Verifies the parent-Accounting + 8 children pattern matches
// Properties (added 2026-04-24).
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

test.describe('Accounting sidebar children', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('expanding Accounting reveals 8 child sub-pages', async ({ page }) => {
    // Find the Accounting parent in the sidebar
    const accountingBtn = page.getByRole('button', { name: /^Accounting/ }).first();
    await accountingBtn.scrollIntoViewIfNeeded().catch(() => {});

    // Trigger the chevron to expand (same pattern as Properties)
    await accountingBtn.click();

    // Children should now be reachable
    const expectedChildren = [
      'Opening Balances',
      'Chart of Accounts',
      'Journal Entries',
      'Recurring Entries',
      'Bank Transactions',
      'Reconcile',
      'Class Tracking',
      'Reports',
    ];
    for (const c of expectedChildren) {
      const child = page.locator('nav').getByRole('button', { name: c }).first();
      await expect(child, `child "${c}" visible in sidebar after expand`).toBeVisible({ timeout: 5000 });
    }
  });

  test('clicking a child loads the corresponding sub-page', async ({ page }) => {
    test.setTimeout(120000);
    await navigateTo(page, 'Accounting');
    // Expand if collapsed
    await page.getByRole('button', { name: /^Accounting/ }).first().click().catch(() => {});

    const children = ['Journal Entries', 'Reports', 'Reconcile', 'Chart of Accounts'];
    for (const c of children) {
      await page.locator('nav').getByRole('button', { name: c }).first().click();
      await page.waitForTimeout(500);
      const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1000 }).catch(() => false);
      expect(crashed, `child "${c}" should not crash`).toBeFalsy();
    }
  });

  test('uses brand-purple accent (not green) on active state', async ({ page }) => {
    await navigateTo(page, 'Accounting');
    // After landing on Accounting, the dashboard tab should use brand- colors.
    // Check no green positive- accent leaked into the active tab indicator.
    // We assert by finding any element with bg-positive-50 (green) used as a
    // primary tab/active indicator. Semantic green for income amounts is OK.
    const greenTabActive = page.locator('button.bg-positive-50.text-positive-700');
    const count = await greenTabActive.count();
    expect(count, 'No green accent tabs left (theme should be brand-purple)').toBe(0);
  });
});
