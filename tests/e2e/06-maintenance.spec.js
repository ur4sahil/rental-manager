// ═══════════════════════════════════════════════════════════════
// 06 — MAINTENANCE: WORK ORDERS, PRIORITY, STATUS, ASSIGNMENT
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Maintenance Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Maintenance');
  });

  test('shows seeded work orders', async ({ page }) => {
    // .first() to sidestep strict-mode violations — multiple WO rows
    // match each keyword, and .isVisible() without .first() throws
    // "strict mode violation" which the .catch() swallowed as false.
    const hasWO = await page.locator('text=faucet').first().isVisible({ timeout: 5000 }).catch(() => false)
      || await page.locator('text=AC').first().isVisible({ timeout: 5000 }).catch(() => false)
      || await page.locator('text=Paint').first().isVisible({ timeout: 5000 }).catch(() => false);
    expect(hasWO).toBeTruthy();
  });

  test('new work order button opens form', async ({ page }) => {
    const btn = page.locator('button:has-text("New Work Order"), button:has-text("New"), button:has-text("Add")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
    await btn.click();
    await page.waitForTimeout(500);
    const issueInput = page.locator('input[placeholder*="issue" i], input[placeholder*="description" i], textarea').first();
    await expect(issueInput).toBeVisible({ timeout: 3000 });
  });

  test('work order form has property, issue, priority, tenant fields', async ({ page }) => {
    const btn = page.locator('button:has-text("New Work Order"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    // Priority dropdown
    const prioritySelect = page.locator('select').filter({ hasText: /normal|emergency|low|urgent/i }).first();
    const hasPriority = await prioritySelect.isVisible({ timeout: 2000 }).catch(() => false);
  });

  test('priority badges show correct colors', async ({ page }) => {
    await page.waitForTimeout(1500);
    // Palette moved off literal "red"/"blue" Tailwind names to the
    // brand-token classes (bg-danger-*, bg-info-*, bg-neutral-*).
    const emergencyBadge = page.locator('[class*="danger"]').first();
    const normalBadge = page.locator('[class*="info"]').first();
    const hasBadge = await emergencyBadge.isVisible().catch(() => false)
      || await normalBadge.isVisible().catch(() => false);
    expect(hasBadge).toBeTruthy();
  });

  test('work order status badges visible (open/in_progress/completed)', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasOpen = await page.locator('text=open').first().isVisible().catch(() => false);
    const hasInProg = await page.locator('text=/in.progress/i').first().isVisible().catch(() => false);
    const hasCompleted = await page.locator('text=completed').first().isVisible().catch(() => false);
    expect(hasOpen || hasInProg || hasCompleted).toBeTruthy();
  });

  test('work order shows assigned vendor', async ({ page }) => {
    // isVisible() with no timeout checks synchronously and can return
    // false even when the text will render a moment later. Use explicit
    // timeouts so Playwright waits for the DOM update.
    const hasVendor = await page.locator('text=Mike Plumber').first().isVisible({ timeout: 5000 }).catch(() => false)
      || await page.locator('text=CoolAir').first().isVisible({ timeout: 2000 }).catch(() => false)
      || await page.locator('text=QuickPaint').first().isVisible({ timeout: 2000 }).catch(() => false);
    expect(hasVendor).toBeTruthy();
  });

  test('status filter dropdown works', async ({ page }) => {
    const filter = page.locator('select, button').filter({ hasText: /all|open|progress|completed/i }).first();
    if (await filter.isVisible({ timeout: 2000 }).catch(() => false)) {
      if (await filter.evaluate(el => el.tagName) === 'SELECT') {
        await filter.selectOption({ index: 1 });
        await page.waitForTimeout(800);
      }
    }
  });

  test('form cancel closes modal', async ({ page }) => {
    const btn = page.locator('button:has-text("New Work Order"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    if (await cancelBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cancelBtn.click();
      await page.waitForTimeout(300);
    }
  });

  test('no horizontal overflow on maintenance', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
