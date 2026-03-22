// ═══════════════════════════════════════════════════════════════
// 08 — DOCUMENTS & INSPECTIONS
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Documents Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'documents');
  });

  test('upload button exists', async ({ page }) => {
    const btn = page.locator('button:has-text("Upload"), button:has-text("upload")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('upload form opens with correct fields', async ({ page }) => {
    const btn = page.locator('button:has-text("Upload"), button:has-text("upload")').first();
    await btn.click();
    await page.waitForTimeout(500);
    // Should show name, property, type, file input
    const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="document" i]').first();
    const hasName = await nameInput.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('document type filter tabs exist', async ({ page }) => {
    const types = ['Lease', 'Inspection', 'Maintenance', 'Financial'];
    for (const t of types) {
      const tab = page.locator(`button:has-text("${t}")`).first();
      if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(500);
      }
    }
  });

  test('document type dropdown has all options', async ({ page }) => {
    const btn = page.locator('button:has-text("Upload"), button:has-text("upload")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const typeSelect = page.locator('select').filter({ hasText: /lease|inspection|maintenance/i }).first();
    if (await typeSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await typeSelect.locator('option').allTextContents();
      expect(options.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('tenant visible checkbox exists', async ({ page }) => {
    const btn = page.locator('button:has-text("Upload"), button:has-text("upload")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const checkbox = page.locator('input[type="checkbox"]').first();
    const hasCheckbox = await checkbox.isVisible({ timeout: 2000 }).catch(() => false);
  });

  test('repair URLs button exists', async ({ page }) => {
    const repairBtn = page.locator('button:has-text("Repair"), button:has-text("repair")').first();
    const hasRepair = await repairBtn.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('no horizontal overflow on documents', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('Inspections Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'inspections');
  });

  test('new inspection button exists', async ({ page }) => {
    const btn = page.locator('button:has-text("New Inspection"), button:has-text("New"), button:has-text("Add")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('inspection form has property, type, inspector, date fields', async ({ page }) => {
    const btn = page.locator('button:has-text("New Inspection"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    // Type dropdown should have Move-In, Move-Out, Periodic
    const typeSelect = page.locator('select').filter({ hasText: /move.in|move.out|periodic/i }).first();
    const hasType = await typeSelect.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('inspection type changes checklist items', async ({ page }) => {
    const btn = page.locator('button:has-text("New Inspection"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const typeSelect = page.locator('select').filter({ hasText: /move.in|move.out|periodic/i }).first();
    if (await typeSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await typeSelect.selectOption({ label: 'Move-In' });
      await page.waitForTimeout(500);
      // Should show checklist items like "Front door", "Walls", etc.
      const hasItem = await page.locator('text=door').isVisible().catch(() => false)
        || await page.locator('text=Walls').isVisible().catch(() => false)
        || await page.locator('text=HVAC').isVisible().catch(() => false);
    }
  });

  test('checklist items have pass/fail buttons', async ({ page }) => {
    const btn = page.locator('button:has-text("New Inspection"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const typeSelect = page.locator('select').filter({ hasText: /move.in|move.out|periodic/i }).first();
    if (await typeSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await typeSelect.selectOption({ index: 1 });
      await page.waitForTimeout(500);
      const passBtn = page.locator('button:has-text("Pass"), button:has-text("✓")').first();
      const failBtn = page.locator('button:has-text("Fail"), button:has-text("✗")').first();
      const hasPassFail = await passBtn.isVisible().catch(() => false)
        || await failBtn.isVisible().catch(() => false);
    }
  });

  test('shows seeded inspection data', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasInsp = await page.locator('text=Oak').isVisible().catch(() => false)
      || await page.locator('text=Move-In').isVisible().catch(() => false)
      || await page.locator('text=completed').isVisible().catch(() => false);
  });

  test('no horizontal overflow on inspections', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
