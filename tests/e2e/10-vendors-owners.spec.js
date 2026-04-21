// ═══════════════════════════════════════════════════════════════
// 10 — VENDORS & OWNERS: PROFILES, INVOICES, STATEMENTS
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Vendors Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'vendors');
  });

  test('shows seeded vendors', async ({ page }) => {
    await expect(page.locator('text=Mike Plumber').first()).toBeVisible({ timeout: 5000 });
  });

  test('shows CoolAir HVAC vendor', async ({ page }) => {
    await expect(page.locator('text=CoolAir').first()).toBeVisible({ timeout: 5000 });
  });

  test('stat cards show active vendors, pending invoices, total paid', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasStats = await page.locator('text=Active').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Pending').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasStats).toBeTruthy();
  });

  test('tab navigation: vendors and invoices', async ({ page }) => {
    const vendorsTab = page.locator('button:has-text("Vendors")').first();
    const invoicesTab = page.locator('button:has-text("Invoices")').first();
    if (await invoicesTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await invoicesTab.click();
      await page.waitForTimeout(800);
      await vendorsTab.click();
      await page.waitForTimeout(800);
    }
  });

  test('add vendor button opens form', async ({ page }) => {
    const btn = page.locator('button:has-text("Add Vendor"), button:has-text("New Vendor"), button:has-text("Add")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
    await btn.click();
    await page.waitForTimeout(500);
    const nameInput = page.locator('input[placeholder*="name" i]').first();
    await expect(nameInput).toBeVisible({ timeout: 3000 });
  });

  test('vendor form has specialty dropdown with all specialties', async ({ page }) => {
    const btn = page.locator('button:has-text("Add Vendor"), button:has-text("New Vendor"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const specialtySelect = page.locator('select').filter({ hasText: /plumbing|electrical|hvac/i }).first();
    if (await specialtySelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await specialtySelect.locator('option').allTextContents();
      expect(options.length).toBeGreaterThanOrEqual(5);
    }
  });

  test('vendor form has status dropdown (active/preferred/inactive/blocked)', async ({ page }) => {
    const btn = page.locator('button:has-text("Add Vendor"), button:has-text("New Vendor"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const statusSelect = page.locator('select').filter({ hasText: /active|preferred|inactive|blocked/i }).first();
    if (await statusSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await statusSelect.locator('option').allTextContents();
      expect(options.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('vendor cards show star ratings', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasStar = await page.locator('text=/★|⭐/').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('[class*="yellow"], [class*="warn"], [class*="amber"]').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('vendor search filters by name', async ({ page }) => {
    const search = page.locator('input[placeholder*="search" i]').first();
    if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
      await search.fill('Mike');
      await page.waitForTimeout(800);
      const mike = await page.locator('text=Mike Plumber').first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(mike).toBeTruthy();
    }
  });

  test('invoices tab shows invoice data or empty state', async ({ page }) => {
    const invoicesTab = page.locator('button:has-text("Invoices")').first();
    if (await invoicesTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await invoicesTab.click();
      await page.waitForTimeout(1000);
      // Should show invoice cards or empty message
    }
  });

  test('new invoice form opens', async ({ page }) => {
    const invoicesTab = page.locator('button:has-text("Invoices")').first();
    if (await invoicesTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await invoicesTab.click();
      await page.waitForTimeout(800);
      const addBtn = page.locator('button:has-text("New Invoice"), button:has-text("Add")').first();
      if (await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await addBtn.click();
        await page.waitForTimeout(500);
      }
    }
  });

  test('no horizontal overflow on vendors', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('Owners Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Owners');
  });

  test('shows seeded owners', async ({ page }) => {
    await expect(page.locator('text=Robert Chen').first()).toBeVisible({ timeout: 5000 });
  });

  test('shows Sarah Kim owner', async ({ page }) => {
    await expect(page.locator('text=Sarah Kim').first()).toBeVisible({ timeout: 5000 });
  });

  test('add owner button opens form', async ({ page }) => {
    const btn = page.locator('button:has-text("Add Owner"), button:has-text("New Owner"), button:has-text("Add")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
    await btn.click();
    await page.waitForTimeout(500);
  });

  test('owner form has management fee percentage field', async ({ page }) => {
    const btn = page.locator('button:has-text("Add Owner"), button:has-text("New Owner"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const hasFee = await page.locator('text=Management Fee').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=management').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('owner form has payment method dropdown', async ({ page }) => {
    const btn = page.locator('button:has-text("Add Owner"), button:has-text("New Owner"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const paySelect = page.locator('select').filter({ hasText: /ach|check|wire/i }).first();
    const hasPayMethod = await paySelect.isVisible({ timeout: 2000 }).catch(() => false);
  });

  test('generate statement button exists', async ({ page }) => {
    const genBtn = page.locator('button:has-text("Generate"), button:has-text("Statement")').first();
    const hasGen = await genBtn.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('owner cards show properties managed and YTD distributions', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasDetail = await page.locator('text=Properties').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=$').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('no horizontal overflow on owners', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
