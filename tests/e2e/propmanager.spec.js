const { test, expect } = require('@playwright/test');

// ─── Login Helper ───
// The deployed landing page has "Sign In" button (top-right) or "Get Started" links.
// Clicking "Sign In" or "Property Manager > Get Started" should lead to the login form.
async function login(page) {
  await page.goto('/', { timeout: 30000 });

  // Try "Sign In" button first, then "Get Started" as fallback
  const signIn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await signIn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await signIn.click();
  } else {
    // Fallback: click "Get Started" under Property Manager
    await page.click('text=Get Started');
  }

  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.fill('input[type="email"]', process.env.TEST_EMAIL);
  await page.fill('input[type="password"]', process.env.TEST_PASSWORD);

  // Try "Sign In" submit button
  const submitBtn = page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")').first();
  await submitBtn.click();

  // Wait for sidebar nav to appear (indicates successful login)
  await page.waitForSelector('nav', { timeout: 15000 });
}

// ─── Navigate to a sidebar module by label text ───
async function navigateTo(page, label) {
  await page.click(`button:has-text("${label}")`);
  await page.waitForTimeout(1500);
}

// ═══════════════════════════════════════════════════
// 1 — LANDING PAGE (no login needed)
// ═══════════════════════════════════════════════════
test('Landing page renders correctly', async ({ page }) => {
  await page.goto('/', { timeout: 30000 });
  await expect(page.locator('text=PropManager').first()).toBeVisible();
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
  // Logout
  await page.click('button:has-text("Logout")');
  await page.waitForTimeout(1000);
  // Should be back on landing
  await expect(page.locator('text=PropManager').first()).toBeVisible();
});

// ═══════════════════════════════════════════════════
// 3 — ALL SIDEBAR MODULES LOAD (single test, single login)
// ═══════════════════════════════════════════════════
test('All sidebar modules load without crashing', async ({ page }) => {
  test.setTimeout(120000);
  await login(page);

  const modules = [
    'Dashboard', 'Properties', 'Tenants', 'Payments',
    'Maintenance', 'Utilities', 'Accounting', 'Documents',
    'Inspections', 'Autopay', 'Late Fees', 'Audit Trail',
    'Leases', 'Vendors', 'Owners', 'Notifications', 'Team & Roles',
  ];
  for (const mod of modules) {
    await page.click(`button:has-text("${mod}")`);
    await page.waitForTimeout(800);
    const hasError = await page.locator('text=Something went wrong').isVisible().catch(() => false);
    expect(hasError, `Module "${mod}" should not crash`).toBeFalsy();
  }
});

// ═══════════════════════════════════════════════════
// 4 — DASHBOARD
// ═══════════════════════════════════════════════════
test('Dashboard shows KPI cards', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Dashboard');
  const cards = page.locator('.rounded-xl');
  const count = await cards.count();
  expect(count).toBeGreaterThan(3);
});

// ═══════════════════════════════════════════════════
// 5 — PROPERTIES
// ═══════════════════════════════════════════════════
test('Properties page: loads, shows data, add form opens', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Properties');

  await expect(page.locator('button:has-text("Add Property")').first()).toBeVisible();

  const hasProperty = await page.locator('text=Oak Street').isVisible().catch(() => false)
    || await page.locator('text=Maple Ave').isVisible().catch(() => false)
    || await page.locator('text=Pine Road').isVisible().catch(() => false);
  expect(hasProperty).toBeTruthy();

  await page.click('button:has-text("Add Property")');
  await page.waitForTimeout(500);
  const addressInput = page.locator('input[placeholder*="Address"], input[placeholder*="address"]').first();
  await expect(addressInput).toBeVisible({ timeout: 3000 });
});

// ═══════════════════════════════════════════════════
// 6 — TENANTS
// ═══════════════════════════════════════════════════
test('Tenants page: loads, shows seeded data, add form opens', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Tenants');

  await expect(page.locator('button:has-text("Add Tenant")').first()).toBeVisible();
  await expect(page.locator('text=Alice Johnson').first()).toBeVisible({ timeout: 5000 });

  await page.click('button:has-text("Add Tenant")');
  await page.waitForTimeout(500);
  const nameInput = page.locator('input[placeholder*="Name"], input[placeholder*="name"]').first();
  await expect(nameInput).toBeVisible({ timeout: 3000 });
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
  const hasWO = await page.locator('text=Leaking faucet').isVisible().catch(() => false)
    || await page.locator('text=AC not cooling').isVisible().catch(() => false);
  expect(hasWO).toBeTruthy();
});

// ═══════════════════════════════════════════════════
// 9 — ACCOUNTING
// ═══════════════════════════════════════════════════
test('Accounting: tabs visible, COA shows accounts', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Accounting');

  const tabs = ['Overview', 'Chart of Accounts', 'Journal Entries', 'Bank Import', 'Reconcile', 'Class Tracking', 'Reports'];
  for (const tab of tabs) {
    await expect(page.locator(`text=${tab}`).first()).toBeVisible({ timeout: 3000 });
  }

  await page.click('text=Chart of Accounts');
  await page.waitForTimeout(1000);
  const hasCOA = await page.locator('text=Checking Account').isVisible().catch(() => false)
    || await page.locator('text=Rental Income').isVisible().catch(() => false)
    || await page.locator('text=1000').isVisible().catch(() => false);
  expect(hasCOA).toBeTruthy();
});

// ═══════════════════════════════════════════════════
// 10 — LEASES
// ═══════════════════════════════════════════════════
test('Leases page loads with heading', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Leases');
  await expect(page.locator('text=Lease Management').first()).toBeVisible({ timeout: 5000 });
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
