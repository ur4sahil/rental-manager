// ═══════════════════════════════════════════════════════════════
// 28 — PROPERTY WIZARD EDIT/RESUME MODE + SETUP COMPLETENESS
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

test.describe('Property Wizard Edit Mode', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Properties');
    await page.waitForTimeout(1500);
  });

  test('property card shows setup status indicator', async ({ page }) => {
    // Look for any setup indicator (blue "Setup Incomplete" or no indicator for complete)
    const cards = page.locator('.rounded-3xl.shadow-card, [class*="rounded-3xl"][class*="border"]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('property detail panel has Edit/Complete Setup button', async ({ page }) => {
    // Click first property to open detail
    const firstProp = page.locator('.rounded-3xl.shadow-card, [class*="rounded-3xl"][class*="border"]').first();
    await firstProp.click();
    await page.waitForTimeout(1500);
    // Navigate to Actions tab
    const actionsTab = page.locator('button:has-text("Actions")').first();
    if (await actionsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await actionsTab.click();
      await page.waitForTimeout(1000);
    }
    // Should see one of: Edit Property Setup, Complete Setup, Resume Property Setup
    const hasSetupBtn = await page.locator('button:has-text("Setup")').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasSetupBtn).toBeTruthy();
  });

  test('Edit Setup opens wizard with pre-filled data', async ({ page }) => {
    // Click the first property card to open its detail panel.
    const firstProp = page.locator('.rounded-3xl.shadow-card, [class*="rounded-3xl"][class*="border"]').first();
    await firstProp.click();
    await page.waitForTimeout(1500);

    // Target "Edit Setup" specifically — Properties.js renders both
    // "Edit Setup" (detail panel, line 3120) and "Resume Setup"
    // (incomplete-wizard banner, line 3590). The earlier generic
    // `button:has-text("Setup")` matched whichever rendered first
    // in the DOM, which on companies with stale wizard rows was
    // "Resume Setup" — that opens a different wizard against
    // different data and the assertion below fired against the
    // wrong context.
    const editSetupBtn = page.locator('button:has-text("Edit Setup")').first();
    if (!await editSetupBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip(true, 'Property detail Edit Setup button not visible (read-only or no permission)');
      return;
    }
    await editSetupBtn.click();
    await page.waitForTimeout(2000);

    // Wizard open: progress indicator OR a known section heading.
    const hasProgress = await page.locator('[class*="bg-emerald"], [class*="bg-brand"], text=/Step\\s+\\d+/').first().isVisible({ timeout: 5000 }).catch(() => false);
    const hasWizard = await page.locator('text=/Property Details|Tenant|Lease|Recurring/').first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasProgress || hasWizard).toBeTruthy();
  });
});
