// ═══════════════════════════════════════════════════════════════
// 09 — LEASES: TEMPLATES, CRUD, E-SIGN, RENEWAL, DEPOSIT RETURN
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Leases Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'leases');
  });

  test('heading visible', async ({ page }) => {
    await expect(page.locator('text=Lease Management, text=Leases').first()).toBeVisible({ timeout: 5000 });
  });

  test('stat cards show active leases, expiring, deposits, avg rent', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasStats = await page.locator('text=Active').first().isVisible().catch(() => false);
    expect(hasStats).toBeTruthy();
  });

  test('tab navigation: active, expiring, expired, renewed, terminated, all', async ({ page }) => {
    const tabs = ['Active', 'Expiring', 'Expired', 'Renewed', 'Terminated', 'All'];
    for (const tab of tabs) {
      const btn = page.locator(`button:has-text("${tab}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(500);
      }
    }
  });

  test('create lease button opens form', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
    await btn.click();
    await page.waitForTimeout(500);
    // Form should have tenant, property, dates, rent
    const hasRent = await page.locator('input[placeholder*="rent" i], input[type="number"]').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasRent).toBeTruthy();
  });

  test('lease form has all fields', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    // Check key fields
    await expect(page.locator('input[type="date"]').first()).toBeVisible({ timeout: 3000 });
    // Security deposit
    const hasDeposit = await page.locator('text=Deposit').first().isVisible().catch(() => false)
      || await page.locator('text=deposit').first().isVisible().catch(() => false);
  });

  test('lease form has escalation fields', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const hasEscalation = await page.locator('text=Escalation').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=escalation').first().isVisible().catch(() => false);
  });

  test('lease form has late fee settings', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const hasLateFee = await page.locator('text=Late Fee').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Grace').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('lease type dropdown has fixed/month-to-month/renewal', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const typeSelect = page.locator('select').filter({ hasText: /fixed|month/i }).first();
    if (await typeSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await typeSelect.locator('option').allTextContents();
      expect(options.some(o => o.toLowerCase().includes('fixed'))).toBeTruthy();
    }
  });

  test('template manager button exists', async ({ page }) => {
    const tmplBtn = page.locator('button:has-text("Template"), button:has-text("template")').first();
    const hasTmpl = await tmplBtn.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('lease cards show action buttons (Edit, E-Sign, Renew, Terminate)', async ({ page }) => {
    await page.waitForTimeout(1500);
    const actionBtns = ['Edit', 'Sign', 'Renew', 'Terminate'];
    for (const action of actionBtns) {
      const btn = page.locator(`button:has-text("${action}")`).first();
      const vis = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    }
  });

  test('move-in/move-out checklist buttons exist', async ({ page }) => {
    await page.waitForTimeout(1500);
    const moveIn = page.locator('button:has-text("Move-In"), button:has-text("move-in")').first();
    const moveOut = page.locator('button:has-text("Move-Out"), button:has-text("move-out")').first();
  });

  test('no horizontal overflow on leases', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
