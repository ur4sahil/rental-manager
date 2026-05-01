// ═══════════════════════════════════════════════════════════════
// 44 — ACCOUNTING SIDEBAR CHILDREN
// Verifies the parent-Accounting + 8 children pattern matches
// Properties (added 2026-04-24, commit 12e6d75).
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

test.describe('Accounting sidebar children', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('expanding Accounting reveals 8 child sub-pages', async ({ page }) => {
    // App.js auto-expands the parent whose page the user is on, so
    // landing on Accounting already reveals its children. Only
    // click the chevron if the first child isn't already visible —
    // clicking when already expanded toggles it CLOSED, which used
    // to break this test pre-2026-05-01.
    await navigateTo(page, 'Accounting');
    const firstChild = page.locator('button:has-text("Opening Balances")').first();
    const alreadyExpanded = await firstChild.isVisible({ timeout: 1500 }).catch(() => false);
    if (!alreadyExpanded) {
      const parentRow = page.locator('button:has-text("Accounting")').first();
      const chevron = parentRow.locator('xpath=following-sibling::button').first();
      if (await chevron.isVisible({ timeout: 1500 }).catch(() => false)) {
        await chevron.click();
        await page.waitForTimeout(400);
      }
    }

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
      const child = page.locator(`button:has-text("${c}")`).first();
      await expect(child, `child "${c}" visible in sidebar after expand`).toBeVisible({ timeout: 5000 });
    }
  });

  test('clicking a child loads the corresponding sub-page', async ({ page }) => {
    test.setTimeout(120000);
    const children = ['Journal Entries', 'Reports', 'Reconcile', 'Chart of Accounts'];
    for (const c of children) {
      await navigateTo(page, c);
      await page.waitForTimeout(500);
      const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1000 }).catch(() => false);
      expect(crashed, `child "${c}" should not crash`).toBeFalsy();
    }
  });

  test('uses brand-purple accent (not green) on active state', async ({ page }) => {
    await navigateTo(page, 'Accounting');
    // After landing on Accounting, the active tab indicator should
    // use brand- (purple) colors, not the legacy positive- (green)
    // theme. Semantic green for income amounts is OK — we only check
    // the active-tab/sidebar-link styling.
    const greenTabActive = page.locator('button.bg-positive-50.text-positive-700');
    const count = await greenTabActive.count();
    expect(count, 'No green accent tabs left (theme should be brand-purple)').toBe(0);
  });
});
