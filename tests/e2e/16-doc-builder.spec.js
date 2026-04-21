// ===================================================================
// 16 — DOCUMENT BUILDER: Templates, Creation Modes, Preview, Export
// ===================================================================
const { test, expect } = require('@playwright/test');
const { login, goToPage, assertNoHorizontalOverflow, waitForToast } = require('./helpers');

test.describe('Document Builder', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'doc_builder');
  });

  // ── Module Load ──
  test('loads without crashing', async ({ page }) => {
    await expect(page.locator('text=Document Builder').first()).toBeVisible({ timeout: 10000 });
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('shows 3 tabs: Create, Templates, History', async ({ page }) => {
    await expect(page.locator('button:has-text("Create")').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button:has-text("Templates")').first()).toBeVisible();
    await expect(page.locator('button:has-text("History")').first()).toBeVisible();
  });

  // ── Create Tab ──
  test('shows blank and prefill mode options', async ({ page }) => {
    await page.waitForTimeout(1500);
    await expect(page.locator('text=Blank Mode').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Prefill from Property').first()).toBeVisible();
  });

  test('blank mode shows template selection after clicking', async ({ page }) => {
    await page.waitForTimeout(1500);
    const blankBtn = page.locator('text=Blank Mode').first();
    await blankBtn.click();
    await page.waitForTimeout(1000);
    // Should show template cards
    await expect(page.locator('text=Choose a Template').first()).toBeVisible({ timeout: 5000 });
  });

  test('prefill mode shows property dropdown', async ({ page }) => {
    await page.waitForTimeout(1500);
    const prefillBtn = page.locator('text=Prefill from Property').first();
    await prefillBtn.click();
    await page.waitForTimeout(500);
    // Should show property selector
    await expect(page.locator('text=Select Property').first()).toBeVisible({ timeout: 3000 });
  });

  // ── Templates Tab ──
  test('templates tab shows template cards', async ({ page }) => {
    await page.locator('button:has-text("Templates")').first().click();
    await page.waitForTimeout(2000);
    // Should have at least 1 template (system templates auto-clone)
    const templateCards = page.locator('[class*="rounded-3xl"]');
    const count = await templateCards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('templates have Edit and Use buttons', async ({ page }) => {
    await page.locator('button:has-text("Templates")').first().click();
    await page.waitForTimeout(2000);
    const hasEdit = await page.locator('button:has-text("Edit")').first().isVisible({ timeout: 3000 }).catch(() => false);
    const hasUse = await page.locator('button:has-text("Use")').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasEdit || hasUse).toBeTruthy();
  });

  test('new template button opens editor', async ({ page }) => {
    await page.locator('button:has-text("Templates")').first().click();
    await page.waitForTimeout(1500);
    const newBtn = page.locator('button:has-text("New Template")').first();
    if (await newBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await newBtn.click();
      await page.waitForTimeout(500);
      // Should show template editor form
      await expect(page.locator('text=Template Details').first()).toBeVisible({ timeout: 3000 });
      await expect(page.locator('text=Form Fields').first()).toBeVisible();
      await expect(page.locator('text=Document Body').first()).toBeVisible();
    }
  });

  // ── History Tab ──
  test('history tab loads without error', async ({ page }) => {
    await page.locator('button:has-text("History")').first().click();
    await page.waitForTimeout(1500);
    // Should show either documents or empty state
    const hasContent = await page.locator('[class*="rounded-2xl"]').count();
    const hasEmpty = await page.locator('text=No documents').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasContent > 0 || hasEmpty).toBeTruthy();
  });

  // ── Template Starter Check ──
  test('system templates are available after first load', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Click blank mode to trigger template display
    const blankBtn = page.locator('text=Blank Mode').first();
    await blankBtn.click();
    await page.waitForTimeout(1500);
    // Check for known starter templates
    const templates = ['Notice to Pay', 'Notice to Vacate', 'Lease Renewal', 'General Letter'];
    let found = 0;
    for (const t of templates) {
      const vis = await page.locator(`text=${t}`).first().isVisible({ timeout: 3000 }).catch(() => false);
      if (vis) found++;
    }
    expect(found).toBeGreaterThanOrEqual(2); // At least 2 starter templates visible
  });

  // ── Responsive ──
  test('no horizontal overflow', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });

  // ── TipTap editor + Signature Workflow (shipped in commits e5a94f4 + 454069f) ──
  test('template editor uses TipTap (not raw textarea) and exposes Signature Workflow', async ({ page }) => {
    await page.locator('button:has-text("Templates")').first().click();
    await page.waitForTimeout(1500);
    const newBtn = page.locator('button:has-text("New Template")').first();
    if (!(await newBtn.isVisible({ timeout: 3000 }).catch(() => false))) test.skip(true, 'New Template button not available');
    await newBtn.click();
    await page.waitForTimeout(800);

    // TipTap surfaces a contenteditable ProseMirror div; the old UI had a plain <textarea>
    // whose monospace class and rows=30 were the giveaway. Assert both.
    await expect(page.locator('.ProseMirror').first()).toBeVisible({ timeout: 5000 });
    const legacyTextareaCount = await page.locator('textarea[rows="30"]').count();
    expect(legacyTextareaCount).toBe(0);

    // Toolbar button exists — Bold is the first button in the toolbar
    await expect(page.locator('button[title="Bold"]').first()).toBeVisible();

    // Signature Workflow section with the 3 mode pills
    await expect(page.locator('text=Signature Workflow').first()).toBeVisible();
    await expect(page.locator('text=No signing').first()).toBeVisible();
    await expect(page.locator('text=Parallel').first()).toBeVisible();
    await expect(page.locator('text=Sequential').first()).toBeVisible();

    // Picking Parallel reveals "Signer Roles" + an "Add signer" button
    await page.locator('text=Parallel').first().click();
    await expect(page.locator('text=/Signer Roles|SIGNER ROLES/i').first()).toBeVisible({ timeout: 2000 });
    await expect(page.locator('button:has-text("Add signer")').first()).toBeVisible();
  });
});
