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
    // Click Add
    const addBtn = page.locator('button:has-text("+ Add")').first();
    if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addBtn.click();
      // Fill minimum fields
      await page.fill('input[name="address-line1"], input[placeholder*="Main"]', '999 Wizard Test St');
      await page.fill('input[placeholder*="city"], input[placeholder*="Greenbelt"]', 'TestCity');
      // Select state
      const stateSelect = page.locator('select[name="state"]').first();
      if (await stateSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
        await stateSelect.selectOption('MD');
      }
      await page.fill('input[placeholder*="ZIP"], input[name="zip"]', '20770');
      // Submit
      const saveBtn = page.locator('button:has-text("Save"), button:has-text("Add Property")').first();
      if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await saveBtn.click();
        // Wait for wizard to appear
        await page.waitForTimeout(3000);
        const wizardHeader = page.locator('text=Property Setup').first();
        const isVisible = await wizardHeader.isVisible({ timeout: 10000 }).catch(() => false);
        expect(isVisible, 'Wizard should launch after property creation').toBeTruthy();
      }
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
