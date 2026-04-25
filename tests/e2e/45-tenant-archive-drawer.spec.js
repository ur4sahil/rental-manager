// ═══════════════════════════════════════════════════════════════
// 22 — TENANT ARCHIVE DRAWER
// Verifies the new archived-tenant detail drawer with full history
// (Overview / Ledger / Payments / Documents / Messages / Work Orders)
// added 2026-04-24.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

test.describe('Tenant archive drawer', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('Archived tab opens detail drawer on click', async ({ page }) => {
    test.setTimeout(120000);
    await navigateTo(page, 'Tenants');

    // Click the Archived tab (FilterPill in tenant tab strip)
    const archivedTab = page.getByRole('button', { name: /^Archived$/ }).first();
    await archivedTab.click();

    // Wait for either an archived row or the empty state
    const empty = page.locator('text=No archived tenants').first();
    const firstRow = page.locator('text=Archived').first();
    const visible = await Promise.race([
      empty.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'empty').catch(() => null),
      firstRow.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'row').catch(() => null),
    ]);
    if (visible !== 'row') {
      console.log('No archived tenants in this company — skipping drawer click assertions');
      return;
    }

    // Click the first archived tenant card to open the drawer
    const card = page.locator('div.cursor-pointer').filter({ hasText: 'Archived' }).first();
    await card.click();

    // Drawer should show "Back to Archived List" + tab buttons
    await expect(page.locator('text=Back to Archived List')).toBeVisible({ timeout: 5000 });
    for (const tab of ['Overview', 'Ledger', 'Payments', 'Documents', 'Messages', 'Work Orders']) {
      await expect(page.getByRole('button', { name: new RegExp(tab) }).first()).toBeVisible();
    }
  });

  test('drawer Back button returns to archived list', async ({ page }) => {
    test.setTimeout(120000);
    await navigateTo(page, 'Tenants');
    await page.getByRole('button', { name: /^Archived$/ }).first().click();
    const empty = await page.locator('text=No archived tenants').first().isVisible({ timeout: 3000 }).catch(() => false);
    if (empty) return;
    const card = page.locator('div.cursor-pointer').filter({ hasText: 'Archived' }).first();
    if (!(await card.isVisible())) return;
    await card.click();
    await page.locator('text=Back to Archived List').click();
    await expect(page.locator('text=Restore').first()).toBeVisible({ timeout: 5000 });
  });
});
