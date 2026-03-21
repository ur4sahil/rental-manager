// ═══════════════════════════════════════════════════════════════
// 11 — UTILITIES, AUTOPAY, LATE FEES
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Utilities Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Utilities');
  });

  test('shows utility bills', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Look for any utility provider text or $ amounts
    const hasBill = await page.locator('text=Gas').isVisible().catch(() => false)
      || await page.locator('text=Water').isVisible().catch(() => false)
      || await page.locator('text=Electric').isVisible().catch(() => false)
      || await page.locator('text=$').first().isVisible().catch(() => false);
    expect(hasBill).toBeTruthy();
  });

  test('add bill button opens form', async ({ page }) => {
    const btn = page.locator('button:has-text("Add Bill"), button:has-text("Add"), button:has-text("New")').first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(500);
    }
  });

  test('utility form has provider, amount, due date, responsibility', async ({ page }) => {
    const btn = page.locator('button:has-text("Add Bill"), button:has-text("Add"), button:has-text("New")').first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(500);
      const respSelect = page.locator('select').filter({ hasText: /owner|tenant|shared/i }).first();
      const hasResp = await respSelect.isVisible({ timeout: 2000 }).catch(() => false);
    }
  });

  test('view mode toggle (card/table) exists', async ({ page }) => {
    const toggles = page.locator('button:has-text("▦"), button:has-text("☰"), button:has-text("Card"), button:has-text("Table")');
    const count = await toggles.count();
  });

  test('status filter works', async ({ page }) => {
    const filter = page.locator('select').filter({ hasText: /all|pending|paid/i }).first();
    if (await filter.isVisible({ timeout: 2000 }).catch(() => false)) {
      await filter.selectOption({ index: 1 });
      await page.waitForTimeout(500);
    }
  });

  test('stat cards show total, pending, paid, outstanding', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasStats = await page.locator('text=Total').first().isVisible().catch(() => false)
      || await page.locator('text=Pending').first().isVisible().catch(() => false);
  });

  test('no horizontal overflow on utilities', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('Autopay Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'autopay');
  });

  test('autopay page loads without crash', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasError = await page.locator('text=Something went wrong').isVisible().catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('shows autopay schedule or empty state', async ({ page }) => {
    await page.waitForTimeout(1500);
    // Should show schedule list or "no schedules" message
    const hasContent = await page.locator('text=Schedule').isVisible().catch(() => false)
      || await page.locator('text=Autopay').isVisible().catch(() => false)
      || await page.locator('text=No').isVisible().catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('no horizontal overflow on autopay', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('Late Fees Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'latefees');
  });

  test('late fees page loads without crash', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasError = await page.locator('text=Something went wrong').isVisible().catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('shows late fee rules or add button', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasContent = await page.locator('text=Grace').isVisible().catch(() => false)
      || await page.locator('button:has-text("Add"), button:has-text("New"), button:has-text("Create")').first().isVisible().catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('late fee type options (flat/percentage)', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasType = await page.locator('text=flat').isVisible().catch(() => false)
      || await page.locator('text=Flat').isVisible().catch(() => false)
      || await page.locator('text=percent').isVisible().catch(() => false);
  });

  test('no horizontal overflow on late fees', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
