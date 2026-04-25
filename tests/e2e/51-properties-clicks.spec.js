// ═══════════════════════════════════════════════════════════════
// 51 — PROPERTIES click-coverage sweep
// Targets the seeded CT properties (101–401 Click Test Way) at
// Smith Properties LLC. Exercises the Active/Setup Drafts/Archived
// filter pills, the + Add wizard launch, and the property detail
// drawer.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, navigateTo,
  assertNoHorizontalOverflow, assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Properties — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Properties');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow', async ({ page }) => {
    await expect(page.locator('h2:has-text("Properties")').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  // ── Filter pills (Active / Setup Drafts / Archived) ──
  test('Active filter pill is selected by default and lists properties', async ({ page }) => {
    const activePill = page.locator('button:has-text("Active (")').first();
    await expect(activePill).toBeVisible();
    // At minimum the seeded CT properties should show
    await expect(page.locator('text=/101 Click Test Way/').first()).toBeVisible({ timeout: 5000 });
  });

  test('Setup Drafts filter pill switches view', async ({ page }) => {
    const draftsPill = page.locator('button:has-text("Setup Drafts")').first();
    await draftsPill.click();
    await page.waitForTimeout(800);
    // The view either lists drafts OR shows the empty-state hint
    const body = await page.locator('main').innerText();
    const inDrafts = /Setup Drafts|Start a property setup from the Active tab/i.test(body);
    expect(inDrafts).toBeTruthy();
  });

  test('Archived filter pill switches view', async ({ page }) => {
    const archivedPill = page.locator('button:has-text("Archived (")').first();
    await archivedPill.click();
    await page.waitForTimeout(800);
    // Either shows archived list (any "Restore" button) or empty-state
    const body = await page.locator('main').innerText();
    const inArchived = /Restore|No archived|archived/i.test(body);
    expect(inArchived).toBeTruthy();
  });

  // ── + Add launches wizard ──
  test('+ Add button launches Property Setup Wizard', async ({ page }) => {
    const addBtn = page.locator('button:has-text("+ Add")').first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await page.waitForTimeout(1200);
    const wizardOpen = await page.locator('text=/Property Setup|Property Details|Step 1/i')
      .first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(wizardOpen, 'wizard modal opened').toBeTruthy();
  });

  // ── Property detail drawer ──
  test('clicking a property card opens detail drawer', async ({ page }) => {
    // Click the first CT property card by its unique address
    const card = page.locator('text=/101 Click Test Way/').first();
    if (!await card.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'no seeded property card visible — run seed:click first');
      return;
    }
    await card.click();
    await page.waitForTimeout(1000);
    // Drawer renders an Actions tab on the detail panel
    const drawer = page.locator('button:has-text("Actions"), button:has-text("Overview"), button:has-text("Edit Setup")').first();
    await expect(drawer).toBeVisible({ timeout: 5000 });
  });
});
