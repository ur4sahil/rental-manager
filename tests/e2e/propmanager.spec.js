const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage } = require('./helpers');

// ═══════════════════════════════════════════════════
// 1 — LANDING PAGE (no login needed)
// ═══════════════════════════════════════════════════
test('Landing page renders correctly', async ({ page }) => {
  await page.goto('/', { timeout: 30000 });
  await expect(page.locator('text=Housify').first()).toBeVisible();
  // Could be "Sign In" or "Login" depending on deploy
  const hasAuth = await page.locator('text=Sign In').first().isVisible().catch(() => false)
    || await page.locator('text=Login').first().isVisible().catch(() => false);
  expect(hasAuth).toBeTruthy();
});

// ═══════════════════════════════════════════════════
// 2 — LOGIN + LOGOUT
// ═══════════════════════════════════════════════════
test('Login and Logout work', async ({ page }) => {
  await login(page);
  await expect(page.locator('nav')).toBeVisible();
  // Logout now lives inside the header avatar dropdown.
  const avatarBtn = page.locator('header button:has-text("expand_more")').first();
  await avatarBtn.click();
  await page.locator('button:has-text("Logout")').first().click();
  await page.waitForTimeout(1500);
  // Should be back on landing
  await expect(page.locator('text=Housify').first()).toBeVisible();
});

// ═══════════════════════════════════════════════════
// 3 — ALL SIDEBAR MODULES LOAD (single test, single login)
// ═══════════════════════════════════════════════════
test('All sidebar modules load without crashing', async ({ page }) => {
  test.setTimeout(120000);
  await login(page);

  // Test all sidebar-visible modules (click each and verify no crash)
  const sidebarModules = [
    'Dashboard', 'Properties', 'Tenants', 'Payments',
    'Accounting', 'Document Builder', 'Vendors', 'Owners', 'Notifications',
  ];
  for (const mod of sidebarModules) {
    const btn = page.locator(`button:has-text("${mod}")`).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(800);
      const hasError = await page.locator('text=Something went wrong').isVisible().catch(() => false);
      expect(hasError, `Module "${mod}" should not crash`).toBeFalsy();
    }
  }
  // Test hidden modules via goToPage helper
  const hiddenModules = ['leases', 'inspections', 'admin', 'maintenance', 'utilities', 'hoa', 'loans', 'insurance'];
  for (const mod of hiddenModules) {
    const success = await goToPage(page, mod);
    if (success) {
      await page.waitForTimeout(800);
      const hasError = await page.locator('text=Something went wrong').isVisible().catch(() => false);
      expect(hasError, `Module "${mod}" should not crash`).toBeFalsy();
    }
  }
});

// ═══════════════════════════════════════════════════
// 4 — DASHBOARD
// ═══════════════════════════════════════════════════
test('Dashboard shows KPI cards', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Dashboard');
  // Card radius evolved from rounded-xl to rounded-2xl/3xl in the UI
  // refresh; match any rounded utility class so the count stays honest
  // as the design system moves.
  const cards = page.locator('[class*="rounded-xl"], [class*="rounded-2xl"], [class*="rounded-3xl"]');
  const count = await cards.count();
  expect(count).toBeGreaterThan(3);
});

// ═══════════════════════════════════════════════════
// 5 — PROPERTIES
// ═══════════════════════════════════════════════════
test('Properties page: loads, shows data, add form opens', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Properties');

  // Add button is now "+ Add" (opens the Property Setup Wizard).
  const addBtn = page.locator('button:has-text("+ Add")').first();
  await expect(addBtn).toBeVisible();

  const hasProperty = await page.locator('text=Oak Street').isVisible().catch(() => false)
    || await page.locator('text=Maple Ave').isVisible().catch(() => false)
    || await page.locator('text=Pine Road').isVisible().catch(() => false);
  expect(hasProperty).toBeTruthy();

  await addBtn.click();
  await page.waitForTimeout(800);
  // Wizard opens — step 1 header reads "Property Setup" (or similar).
  const wizardOpen = await page.locator('text=/Property Setup|Property Details|Step 1/i').first().isVisible({ timeout: 3000 }).catch(() => false);
  expect(wizardOpen).toBeTruthy();
});

// ═══════════════════════════════════════════════════
// 6 — TENANTS
// ═══════════════════════════════════════════════════
test('Tenants page: loads, shows seeded data', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Tenants');

  // Tenants are now added through the Property Setup Wizard — no
  // standalone "Add Tenant" button. The Tenants page surfaces the
  // list plus per-tenant actions (View Ledger, Move-Out, Evictions).
  await expect(page.locator('heading:has-text("Tenants"), h2:has-text("Tenants")').first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator('text=Alice Johnson').first()).toBeVisible({ timeout: 5000 });
});

// ═══════════════════════════════════════════════════
// 7 — PAYMENTS
// ═══════════════════════════════════════════════════
test('Payments page: loads with table and Record button', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Payments');
  await expect(page.locator('button:has-text("Record Payment")').first()).toBeVisible();
  await expect(page.locator('table').first()).toBeVisible({ timeout: 5000 });
});

// ═══════════════════════════════════════════════════
// 8 — MAINTENANCE
// ═══════════════════════════════════════════════════
test('Maintenance page: loads with seeded work orders', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Maintenance');
  await expect(page.locator('button:has-text("New Work Order")').first()).toBeVisible();
  // .first() avoids Playwright's strict-mode bail when the same WO
  // string appears in multiple cards/rows.
  const hasWO = await page.locator('text=Leaking faucet').first().isVisible().catch(() => false)
    || await page.locator('text=AC not cooling').first().isVisible().catch(() => false);
  expect(hasWO).toBeTruthy();
});

// ═══════════════════════════════════════════════════
// 9 — ACCOUNTING
// ═══════════════════════════════════════════════════
test('Accounting: tabs visible, COA shows accounts', async ({ page }) => {
  await login(page);

  // 2026-04-24 — Accounting in-page tabs were retired in favor of
  // global-sidebar children (commit 12e6d75). navigateTo() expands
  // the parent and routes to the child page.
  await navigateTo(page, 'Accounting');
  const children = ['Chart of Accounts', 'Journal Entries', 'Recurring Entries', 'Bank Transactions', 'Reconcile', 'Class Tracking', 'Reports'];
  for (const c of children) {
    await expect(page.locator(`button:has-text("${c}")`).first()).toBeVisible({ timeout: 3000 });
  }

  await navigateTo(page, 'Chart of Accounts');
  const hasCOA = await page.locator('text=Checking Account').first().isVisible().catch(() => false)
    || await page.locator('text=Rental Income').first().isVisible().catch(() => false)
    || await page.locator('text=1000').first().isVisible().catch(() => false);
  expect(hasCOA).toBeTruthy();
});

// ═══════════════════════════════════════════════════
// 10 — LEASES
// ═══════════════════════════════════════════════════
test('Leases page loads with heading', async ({ page }) => {
  await login(page);
  // Leases is a hidden route — no sidebar button — navigate via hash.
  await goToPage(page, 'leases');
  await expect(page.locator('text=/Lease Management|Leases/').first()).toBeVisible({ timeout: 5000 });
});

// ═══════════════════════════════════════════════════
// 11 — VENDORS
// ═══════════════════════════════════════════════════
test('Vendors page shows seeded data', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Vendors');
  await expect(page.locator('text=Mike Plumber').first()).toBeVisible({ timeout: 5000 });
});

// ═══════════════════════════════════════════════════
// 12 — OWNERS
// ═══════════════════════════════════════════════════
test('Owners page shows seeded data', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Owners');
  await expect(page.locator('text=Robert Chen').first()).toBeVisible({ timeout: 5000 });
});
