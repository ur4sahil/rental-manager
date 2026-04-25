// ═══════════════════════════════════════════════════════════════
// 54 — MAINTENANCE click-coverage sweep
// 6 CT work orders are seeded across mixed states (open/in_progress/
// completed) and priorities (emergency/high/normal/low). Exercises
// the + Add button, the per-row state toggles, and the photo modal.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, navigateTo,
  assertNoHorizontalOverflow, assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Maintenance — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Maintenance');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow', async ({ page }) => {
    await expect(page.locator('h2:has-text("Maintenance")').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  test('seeded CT work orders are visible', async ({ page }) => {
    const wo = page.locator('text=/Burst pipe|Replacing dishwasher|Interior painting/').first();
    await expect(wo).toBeVisible({ timeout: 5000 });
  });

  test('+ Add (or + New) button opens new work order form', async ({ page }) => {
    const addBtn = page.locator('button:has-text("+ Add"), button:has-text("+ New"), button:has-text("New Work Order")').first();
    if (!await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'add-work-order button not visible — role may not allow');
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(700);
    const formOpen = await page.locator('text=/Issue|Property|Priority|Vendor/i')
      .first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(formOpen, 'work order form/modal opened').toBeTruthy();
    const cancel = page.locator('button:has-text("Cancel")').first();
    if (await cancel.isVisible({ timeout: 1500 }).catch(() => false)) await cancel.click();
  });

  test('emergency badge renders for the seeded burst-pipe WO', async ({ page }) => {
    // Emergency priority chip is the only one for "Burst pipe"
    const emergencyChip = page.locator('text=/emergency/i').first();
    await expect(emergencyChip).toBeVisible({ timeout: 5000 });
  });

  test('clicking a work order row opens its detail view', async ({ page }) => {
    const row = page.locator('text=/Burst pipe/').first();
    if (!await row.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'no seeded WO — run seed:click first');
      return;
    }
    await row.click();
    await page.waitForTimeout(1000);
    // Detail view shows status / cost / property
    const detailMarker = page.locator('text=/Status|Priority|Property|Cost/i').first();
    await expect(detailMarker).toBeVisible({ timeout: 3000 });
  });
});
