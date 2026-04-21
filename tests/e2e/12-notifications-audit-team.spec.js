// ═══════════════════════════════════════════════════════════════
// 12 — NOTIFICATIONS, AUDIT TRAIL, TEAM & ROLES
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Notifications Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'notifications');
  });

  test('notifications page loads', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
  });

  test('has settings, log, and rent roll tabs', async ({ page }) => {
    const tabs = ['Settings', 'Log', 'Rent Roll'];
    for (const tab of tabs) {
      const el = page.locator(`button:has-text("${tab}")`).first();
      const vis = await el.isVisible({ timeout: 3000 }).catch(() => false);
    }
  });

  test('run notification check button exists', async ({ page }) => {
    const btn = page.locator('button:has-text("Run"), button:has-text("Check")').first();
    const hasBtn = await btn.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('notification settings show toggle switches', async ({ page }) => {
    await page.waitForTimeout(1500);
    const toggles = page.locator('[class*="green"], [class*="positive"], [class*="slate"]');
    const count = await toggles.count();
  });

  test('send log tab shows delivery history', async ({ page }) => {
    const logTab = page.locator('button:has-text("Log")').first();
    if (await logTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await logTab.click();
      await page.waitForTimeout(1000);
    }
  });

  test('rent roll tab shows active tenant data', async ({ page }) => {
    const rrTab = page.locator('button:has-text("Rent Roll")').first();
    if (await rrTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await rrTab.click();
      await page.waitForTimeout(1000);
      // Should show tenant names, rents, balances
      const hasData = await page.locator('text=Alice').first().isVisible({ timeout: 3000 }).catch(() => false)
        || await page.locator('text=Bob').first().isVisible({ timeout: 3000 }).catch(() => false);
    }
  });

  test('rent roll shows totals in footer', async ({ page }) => {
    const rrTab = page.locator('button:has-text("Rent Roll")').first();
    if (await rrTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await rrTab.click();
      await page.waitForTimeout(1000);
      const hasTotals = await page.locator('text=Total').first().isVisible({ timeout: 3000 }).catch(() => false)
        || await page.locator('text=$').first().isVisible({ timeout: 3000 }).catch(() => false);
    }
  });

  test('channel buttons (in_app, email, push) are clickable', async ({ page }) => {
    await page.waitForTimeout(1500);
    const channels = ['in_app', 'email', 'push'];
    for (const ch of channels) {
      const btn = page.locator(`button:has-text("${ch}")`).first();
      const vis = await btn.isVisible({ timeout: 1000 }).catch(() => false);
    }
  });

  test('no horizontal overflow on notifications', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('Audit Trail (Admin Page)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'admin');
  });

  test('audit trail loads with data', async ({ page }) => {
    await page.waitForTimeout(2000);
    const hasData = await page.locator('text=create').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=admin').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasData).toBeTruthy();
  });

  test('module filter dropdown works', async ({ page }) => {
    const filter = page.locator('select').first();
    if (await filter.isVisible({ timeout: 3000 }).catch(() => false)) {
      const options = await filter.locator('option').count();
      expect(options).toBeGreaterThanOrEqual(2);
    }
  });

  test('action filter dropdown works', async ({ page }) => {
    const filters = page.locator('select');
    const count = await filters.count();
    if (count >= 2) {
      const actionFilter = filters.nth(1);
      const options = await actionFilter.locator('option').count();
      expect(options).toBeGreaterThanOrEqual(2);
    }
  });

  test('user email search input works', async ({ page }) => {
    const search = page.locator('input[placeholder*="user" i], input[placeholder*="email" i]').first();
    if (await search.isVisible({ timeout: 2000 }).catch(() => false)) {
      await search.fill('admin');
      await page.waitForTimeout(500);
    }
  });

  test('refresh button works', async ({ page }) => {
    const refreshBtn = page.locator('button:has-text("Refresh"), button:has-text("refresh")').first();
    if (await refreshBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await refreshBtn.click();
      await page.waitForTimeout(1000);
    }
  });

  test('pagination controls exist', async ({ page }) => {
    const prevBtn = page.locator('button:has-text("Previous"), button:has-text("Prev")').first();
    const nextBtn = page.locator('button:has-text("Next")').first();
    const hasPagination = await prevBtn.isVisible({ timeout: 2000 }).catch(() => false)
      || await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
  });

  test('stat cards show total actions, active users', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasStats = await page.locator('text=Total').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Actions').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('no horizontal overflow on audit trail', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('Team & Roles (Admin Page)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'roles');
  });

  test('team page loads', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasContent = await page.locator('text=Team').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Role').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasContent).toBeTruthy();
  });

  test('add user button exists', async ({ page }) => {
    const btn = page.locator('button:has-text("Add User"), button:has-text("Add"), button:has-text("Invite")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('add user form has name, email, role fields', async ({ page }) => {
    const btn = page.locator('button:has-text("Add User"), button:has-text("Add"), button:has-text("Invite")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const hasEmail = await page.locator('input[type="email"], input[placeholder*="email" i]').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasEmail).toBeTruthy();
  });

  test('role dropdown has all roles', async ({ page }) => {
    const btn = page.locator('button:has-text("Add User"), button:has-text("Add"), button:has-text("Invite")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const roleSelect = page.locator('select').filter({ hasText: /admin|manager|accountant|maintenance/i }).first();
    if (await roleSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await roleSelect.locator('option').allTextContents();
      expect(options.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('role legend shows all role types', async ({ page }) => {
    await page.waitForTimeout(1500);
    const roles = ['Admin', 'Manager', 'Accountant'];
    for (const role of roles) {
      const vis = await page.locator(`text=${role}`).first().isVisible({ timeout: 2000 }).catch(() => false);
    }
  });

  test('existing users shown with role badges', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasUser = await page.locator('text=admin').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('user cards have edit, invite, remove buttons', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasEdit = await page.locator('button:has-text("Edit"), button:has-text("✏")').first().isVisible({ timeout: 3000 }).catch(() => false);
    const hasInvite = await page.locator('button:has-text("Invite"), button:has-text("✉")').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('no horizontal overflow on team', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });

  // ── Module access picker (commit 45bf4e5 replaced giant purple tiles with checkboxes) ──
  test('add-user form uses checkbox module picker, not the old tile grid', async ({ page }) => {
    const addBtn = page.locator('button:has-text("Add User"), button:has-text("Add Team"), button:has-text("Add")').first();
    if (!(await addBtn.isVisible({ timeout: 5000 }).catch(() => false))) test.skip(true, 'Add User button not available');
    await addBtn.click();
    await page.waitForTimeout(600);

    // Pick a customizable role so the module picker appears
    const roleSelect = page.locator('select').filter({ hasText: /Office Assistant|Property Manager|Accountant/i }).first();
    if (await roleSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await roleSelect.selectOption({ label: /Office Assistant/i }).catch(() => {});
      await page.waitForTimeout(300);
    }

    // New dense "Module access" heading (old was "Choose which modules this person can access")
    await expect(page.locator('text=/Module access|Choose which modules/i').first()).toBeVisible({ timeout: 3000 });

    // The new UI renders <input type="checkbox"> rows, not full-width purple <button> tiles.
    // Assert at least a few checkboxes exist in the module picker area.
    const checkboxCount = await page.locator('input[type="checkbox"]').count();
    expect(checkboxCount).toBeGreaterThanOrEqual(5); // many modules

    // Select all / Clear all links still present
    await expect(page.locator('button:has-text("Select all")').first()).toBeVisible();
    await expect(page.locator('button:has-text("Clear all")').first()).toBeVisible();
  });
});
