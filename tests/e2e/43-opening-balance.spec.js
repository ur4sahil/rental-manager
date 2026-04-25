// ═══════════════════════════════════════════════════════════════
// 43 — OPENING BALANCE setup tab
// ═══════════════════════════════════════════════════════════════
// Drives the new Accounting → SETUP → Opening Balances flow:
// navigate to the tab, confirm the setup banner renders when
// appropriate, smoke-test the form, and assert posted-state detects
// a prior opening JE. Full post requires seeded accounts +
// confirmed dialogs, which live in data-layer coverage
// (tests/opening-balance.test.js) — this spec just validates the
// tab renders and wires up.
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

// Updated 2026-04-24 — Opening Balances is a sidebar child page now
// (commit 12e6d75), not an in-page tab under a SETUP section header.
test.describe('Opening Balance tab', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Opening Balances child appears in Accounting sidebar', async ({ page }) => {
    await navigateTo(page, 'Accounting');
    const child = page.locator('button:has-text("Opening Balances")').first();
    await expect(child).toBeVisible({ timeout: 5000 });
  });

  test('page shows entry grid or posted state', async ({ page }) => {
    await navigateTo(page, 'Opening Balances');
    await page.waitForTimeout(1500);
    const body = await page.locator('body').innerText();
    const hasEntryGrid = /Opening date|Assets|Plug to 3000/.test(body);
    const hasPostedState = /Opening balance posted|Reverse opening balance/.test(body);
    expect(hasEntryGrid || hasPostedState).toBeTruthy();
  });

  test('plug indicator updates as user types a balance', async ({ page }) => {
    await navigateTo(page, 'Opening Balances');
    await page.waitForTimeout(1500);
    const body = await page.locator('body').innerText();
    // Skip if the company already has a posted opening JE — covered
    // in data-layer tests separately.
    if (/Opening balance posted/.test(body)) {
      test.skip(true, 'opening balance already posted for this company');
      return;
    }
    const firstBalanceInput = page.locator('input[inputmode="decimal"]').first();
    if (!await firstBalanceInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'no eligible accounts rendered');
      return;
    }
    await firstBalanceInput.fill('5000');
    await page.waitForTimeout(400);
    const after = await page.locator('body').innerText();
    // Plug line shows either "Balanced ✓" (if balance happens to
    // hit zero against existing) or "Plug to 3000 Opening Balance
    // Equity: ...". Either confirms the live calc is wired.
    expect(/Balanced|Plug to 3000/.test(after)).toBeTruthy();
  });
});
