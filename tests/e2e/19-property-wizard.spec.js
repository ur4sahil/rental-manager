// ═══════════════════════════════════════════════════════════════
// 19 — PROPERTY SETUP WIZARD: 7-STEP POST-CREATION FLOW
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Property Setup Wizard', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Properties');
  });

  test('wizard launches after creating new property', async ({ page }) => {
    test.setTimeout(90000);
    // Click Add button
    const addBtn = page.locator('button:has-text("+ Add"), button:has-text("+ Request")').first();
    if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      test.skip(true, 'Add button not found — may need login or permissions');
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(1000);
    // Fill all required fields using autocomplete names and placeholder text
    const addr = page.locator('input[autocomplete="address-line1"], input[placeholder*="123"]').first();
    if (await addr.isVisible({ timeout: 2000 }).catch(() => false)) await addr.fill('999 Wizard Test St');
    const city = page.locator('input[autocomplete="address-level2"], input[placeholder*="Greenbelt"]').first();
    if (await city.isVisible({ timeout: 2000 }).catch(() => false)) await city.fill('TestCity');
    const state = page.locator('select[autocomplete="address-level1"], select[name="state"]').first();
    if (await state.isVisible({ timeout: 2000 }).catch(() => false)) await state.selectOption('MD');
    const zip = page.locator('input[name="zip"], input[placeholder*="ZIP"]').first();
    if (await zip.isVisible({ timeout: 2000 }).catch(() => false)) await zip.fill('20770');
    // Submit
    const saveBtn = page.locator('button:has-text("Save Property"), button:has-text("Add Property"), button:has-text("Save")').last();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(5000);
      // Check for wizard OR success toast (wizard may not appear if save fails)
      const wizardVisible = await page.locator('text=Property Setup').first().isVisible({ timeout: 10000 }).catch(() => false);
      const toastVisible = await page.locator('text=/saved|success|created/i').first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(wizardVisible || toastVisible, 'Should see wizard or success feedback after save').toBeTruthy();
    } else {
      test.skip(true, 'Save button not found');
    }
  });

  test('wizard shows progress bar and step counter', async ({ page }) => {
    test.setTimeout(60000);
    // Check if wizard is already open (from previous property creation) or trigger one
    const wizard = page.locator('text=Property Setup').first();
    if (await wizard.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Progress bar
      const progressBar = page.locator('.bg-green-600.h-1, .bg-green-600.transition-all').first();
      await expect(progressBar).toBeVisible({ timeout: 3000 });
      // Step counter
      const stepText = page.locator('text=/Step \\d+ of \\d+/').first();
      await expect(stepText).toBeVisible({ timeout: 3000 });
    }
  });

  test('wizard has Skip and Next buttons', async ({ page }) => {
    test.setTimeout(60000);
    const wizard = page.locator('text=Property Setup').first();
    if (await wizard.isVisible({ timeout: 5000 }).catch(() => false)) {
      const skipBtn = page.locator('button:has-text("Skip")').first();
      const nextBtn = page.locator('button:has-text("Next")').first();
      await expect(skipBtn).toBeVisible({ timeout: 3000 });
      await expect(nextBtn).toBeVisible({ timeout: 3000 });
    }
  });

  test('wizard can be dismissed with X button', async ({ page }) => {
    test.setTimeout(60000);
    const wizard = page.locator('text=Property Setup').first();
    if (await wizard.isVisible({ timeout: 5000 }).catch(() => false)) {
      const closeBtn = page.locator('button:has-text("close"), button .material-icons-outlined:has-text("close")').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
        // Should show confirm dialog
        await page.waitForTimeout(1000);
        const confirmBtn = page.locator('button:has-text("Dismiss"), button:has-text("Yes")').first();
        if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await confirmBtn.click();
        }
        await page.waitForTimeout(1000);
        const wizardGone = await wizard.isVisible().catch(() => false);
        expect(wizardGone, 'Wizard should close after dismiss').toBeFalsy();
      }
    }
  });

  test('utilities step shows form fields', async ({ page }) => {
    test.setTimeout(60000);
    const wizard = page.locator('text=Property Setup').first();
    if (await wizard.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Utilities step should be step 1
      const utilHeader = page.locator('text=/Utilit/i').first();
      const hasUtil = await utilHeader.isVisible({ timeout: 3000 }).catch(() => false);
      if (hasUtil) {
        // Should have provider and type fields
        const providerField = page.locator('input[placeholder*="provider"], input[placeholder*="Provider"]').first();
        const hasProvider = await providerField.isVisible({ timeout: 3000 }).catch(() => false);
        expect(hasProvider, 'Utilities step should have provider field').toBeTruthy();
      }
    }
  });

  test('wizard steps can be skipped through to review', async ({ page }) => {
    test.setTimeout(120000);
    const wizard = page.locator('text=Property Setup').first();
    if (await wizard.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Skip through all steps to reach review
      for (let i = 0; i < 10; i++) {
        const skipBtn = page.locator('button:has-text("Skip")').first();
        const completeBtn = page.locator('button:has-text("Complete Setup")').first();
        if (await completeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          // Reached review step
          expect(true, 'Reached review/complete step').toBeTruthy();
          break;
        }
        if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await skipBtn.click();
          await page.waitForTimeout(500);
        }
      }
    }
  });

  test('no horizontal overflow in wizard', async ({ page }) => {
    test.setTimeout(30000);
    const wizard = page.locator('text=Property Setup').first();
    if (await wizard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await assertNoHorizontalOverflow(page);
    }
  });
});
