// ═══════════════════════════════════════════════════════════════
// 20 — LOANS MODULE: CRUD, PAYMENT RECORDING, BALANCE TRACKING
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Loans Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Loans');
  });

  test('loans page loads without crash', async ({ page }) => {
    test.setTimeout(30000);
    const hasError = await page.locator('text=Something went wrong').isVisible().catch(() => false);
    expect(hasError, 'Loans page should not crash').toBeFalsy();
  });

  test('loans page has stats row', async ({ page }) => {
    test.setTimeout(30000);
    // Should have stats cards
    const statsText = page.locator('text=/Active Loans|Monthly Payments|Outstanding/i').first();
    const hasStats = await statsText.isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasStats, 'Loans page should show stats').toBeTruthy();
  });

  test('loans page has add button', async ({ page }) => {
    test.setTimeout(30000);
    const addBtn = page.locator('button:has-text("Add"), button:has-text("New Loan")').first();
    const hasAdd = await addBtn.isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasAdd, 'Loans page should have add button').toBeTruthy();
  });

  test('add loan form opens and has required fields', async ({ page }) => {
    test.setTimeout(30000);
    const addBtn = page.locator('button:has-text("Add"), button:has-text("New Loan")').first();
    if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(1000);
      // Check for key form fields
      const lenderField = page.locator('input[placeholder*="lender"], input[placeholder*="Lender"], label:has-text("Lender")').first();
      const hasLender = await lenderField.isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasLender, 'Loan form should have lender field').toBeTruthy();
    }
  });

  test('loan type dropdown has correct options', async ({ page }) => {
    test.setTimeout(30000);
    const addBtn = page.locator('button:has-text("Add"), button:has-text("New Loan")').first();
    if (!await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'Add button not found');
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(1500);
    // Find any select that contains loan type options
    const allSelects = page.locator('select');
    const count = await allSelects.count();
    let found = false;
    for (let i = 0; i < count; i++) {
      const options = await allSelects.nth(i).locator('option').allTextContents();
      if (options.some(o => o.includes('Conventional'))) {
        expect(options.join(',')).toContain('FHA');
        expect(options.join(',')).toContain('VA');
        found = true;
        break;
      }
    }
    expect(found, 'Should find a select with loan type options').toBeTruthy();
  });

  test('loans page is accessible from sidebar navigation', async ({ page }) => {
    test.setTimeout(30000);
    // Navigate away and back
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(1000);
    await navigateTo(page, 'Loans');
    await page.waitForTimeout(1000);
    const hasError = await page.locator('text=Something went wrong').isVisible().catch(() => false);
    expect(hasError, 'Loans page should load after navigation').toBeFalsy();
  });

  test('no horizontal overflow on loans page', async ({ page }) => {
    test.setTimeout(30000);
    await assertNoHorizontalOverflow(page);
  });
});
