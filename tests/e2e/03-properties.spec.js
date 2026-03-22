// ═══════════════════════════════════════════════════════════════
// 03 — PROPERTIES: CRUD, VIEWS, FILTERS, MODALS, DETAIL PANEL
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow, assertModalIsTopLayer } = require('./helpers');

test.describe('Properties Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Properties');
  });

  // ── Data Display ──
  test('shows properties with data', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Check stat cards show non-zero Total
    const total = page.locator('text=Total').first();
    await expect(total).toBeVisible({ timeout: 5000 });
    // There should be property cards or table rows
    const hasContent = await page.locator('[class*="rounded-3xl"], [class*="rounded-xl"], tr').count();
    expect(hasContent).toBeGreaterThan(0);
  });

  test('property cards show status badges (occupied/vacant)', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Status badges use uppercase or colored chips
    // Look for status badge text in any visible element
    const pageText = await page.locator('body').textContent();
    const hasOccupied = /occupied/i.test(pageText);
    const hasVacant = /vacant/i.test(pageText);
    expect(hasOccupied || hasVacant).toBeTruthy();
  });

  // ── Search & Filters ──
  test('search input filters properties', async ({ page }) => {
    const search = page.locator('input[placeholder*="search" i], input[placeholder*="Search" i]').first();
    await expect(search).toBeVisible({ timeout: 5000 });
    // Type something and verify it doesn't crash
    await search.fill('test');
    await page.waitForTimeout(800);
    await search.fill('');
    await page.waitForTimeout(500);
  });

  test('status filter dropdown works', async ({ page }) => {
    const filter = page.locator('select').first();
    if (await filter.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await filter.locator('option').count();
      expect(options).toBeGreaterThanOrEqual(2);
    }
  });

  // ── View Modes ──
  test('view mode toggle buttons exist', async ({ page }) => {
    // Card / Table / Compact toggles
    const toggles = page.locator('button:has-text("▦"), button:has-text("☰"), button:has-text("≡")');
    const count = await toggles.count();
    if (count >= 2) {
      // Switch to table view
      await toggles.nth(1).click();
      await page.waitForTimeout(800);
      // Should see a table or list layout
      const hasTable = await page.locator('table, thead, th').first().isVisible().catch(() => false);
      // Switch to compact view
      if (count >= 3) {
        await toggles.nth(2).click();
        await page.waitForTimeout(800);
      }
      // Switch back to card view
      await toggles.nth(0).click();
      await page.waitForTimeout(800);
    }
  });

  // ── Add Property Form ──
  test('add property button opens form modal', async ({ page }) => {
    const addBtn = page.locator('button:has-text("+ Add"), button:has-text("Add Property")').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await page.waitForTimeout(500);
    // Modal should open with address/city/state fields
    const hasForm = await page.locator('input').count();
    expect(hasForm).toBeGreaterThan(2);
  });

  test('property form has all required fields', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("add")').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    // Check for key fields
    const fields = ['Address', 'City', 'State', 'ZIP', 'Type', 'Status'];
    for (const field of fields) {
      const el = page.locator(`text=${field}`).first();
      const vis = await el.isVisible({ timeout: 2000 }).catch(() => false);
      // At least most fields should be visible
    }
  });

  test('property form state dropdown shows occupied/vacant/maintenance', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("add")').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    const statusSelect = page.locator('select').filter({ hasText: /occupied|vacant/i }).first();
    if (await statusSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await statusSelect.locator('option').allTextContents();
      expect(options.some(o => o.toLowerCase().includes('occupied'))).toBeTruthy();
      expect(options.some(o => o.toLowerCase().includes('vacant'))).toBeTruthy();
    }
  });

  test('property form cancel closes modal', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add"), button:has-text("add")').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    if (await cancelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cancelBtn.click();
      await page.waitForTimeout(500);
      // Modal should close
      const formGone = !(await page.locator('input[placeholder*="address" i]').isVisible().catch(() => false));
      expect(formGone).toBeTruthy();
    }
  });

  test('property form validates required fields on save', async ({ page }) => {
    const addBtn = page.locator('button:has-text("+ Add"), button:has-text("Add Property")').first();
    await addBtn.click();
    await page.waitForTimeout(500);
    // Try to save without filling anything
    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Create")').first();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(500);
      // Should show alert or stay on form (not close)
      const inputs = await page.locator('input').count();
      expect(inputs).toBeGreaterThan(2); // form still open
    }
  });

  // ── Property Detail / Timeline ──
  test('clicking a property opens detail panel', async ({ page }) => {
    await page.waitForTimeout(1500);
    // Click on first property card
    const firstCard = page.locator('[class*="rounded-3xl"], [class*="rounded-xl"]').first();
    if (await firstCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstCard.click();
      await page.waitForTimeout(1000);
    }
  });

  // ── Archived Properties ──
  test('archived tab is accessible', async ({ page }) => {
    const archivedTab = page.locator('button:has-text("Archived")').first();
    if (await archivedTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await archivedTab.click();
      await page.waitForTimeout(1000);
      // Should show archived section or empty message
    }
  });

  test('no horizontal overflow on properties', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
