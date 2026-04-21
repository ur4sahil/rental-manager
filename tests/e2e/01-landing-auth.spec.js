// ═══════════════════════════════════════════════════════════════
// 01 — LANDING PAGE, AUTH FLOW, SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, assertNoHorizontalOverflow, collectConsoleErrors, waitForToast } = require('./helpers');

test.describe('Landing Page', () => {
  test('renders hero section with all elements', async ({ page }) => {
    await page.goto('/');
    // Logo / brand
    await expect(page.locator('text=PropManager').first()).toBeVisible({ timeout: 10000 });
    // Hero headline
    await expect(page.locator('text=Property Management').first()).toBeVisible();
    // Sign In button in header
    await expect(page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first()).toBeVisible();
  });

  test('shows all 3 role signup options', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Property Manager').first()).toBeVisible();
    await expect(page.locator('text=Property Owner').first()).toBeVisible();
    await expect(page.locator('text=Tenant').first()).toBeVisible();
  });

  test('shows all 6 feature cards', async ({ page }) => {
    await page.goto('/');
    const features = ['Property Management', 'Tenant Management', 'Rent Collection',
      'Maintenance', 'Utility', 'Accounting'];
    for (const f of features) {
      await expect(page.locator(`text=${f}`).first()).toBeVisible();
    }
  });

  test('footer shows copyright', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Sigma Housing').first()).toBeVisible();
  });

  test('no horizontal overflow on landing', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    await assertNoHorizontalOverflow(page);
  });

  test('no console errors on landing', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/');
    await page.waitForTimeout(2000);
    expect(errors.length, `Console errors: ${errors.join('; ')}`).toBe(0);
  });
});

test.describe('Authentication', () => {
  test('Sign In button navigates to login form', async ({ page }) => {
    await page.goto('/');
    await page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first().click();
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('login form shows validation on empty submit', async ({ page }) => {
    await page.goto('/');
    await page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first().click();
    await page.waitForSelector('input[type="email"]', { timeout: 5000 });
    // Click submit without filling fields
    const submitBtn = page.locator('button[type="submit"], button:has-text("Sign In")').last();
    await submitBtn.click();
    await page.waitForTimeout(500);
    // Should stay on login (not navigate to app)
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('login with invalid credentials shows error', async ({ page }) => {
    await page.goto('/');
    await page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first().click();
    await page.waitForSelector('input[type="email"]', { timeout: 5000 });
    await page.fill('input[type="email"]', 'nobody@fake.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    const submitBtn = page.locator('button[type="submit"], button:has-text("Sign In")').last();
    await submitBtn.click();
    // Should show an error message (inline error text or toast notification)
    await page.waitForTimeout(2000);
    const errorVisible = await page.locator('text=Invalid').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('[class*="red"], [class*="danger"]').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await waitForToast(page, { type: 'error', timeout: 2000 });
    expect(errorVisible).toBeTruthy();
  });

  test('successful login reaches dashboard', async ({ page }) => {
    await login(page);
    // Should see Dashboard button in sidebar (proves we're in the app)
    await expect(page.locator('button:has-text("Dashboard")').first()).toBeVisible({ timeout: 5000 });
  });

  test('logout returns to landing page', async ({ page }) => {
    await login(page);
    // Logout lives inside the avatar dropdown — open it first.
    const avatar = page.locator('header button:has(.rounded-full)').first();
    await avatar.click();
    await page.waitForTimeout(500);
    await page.locator('button:has-text("Logout")').first().click();
    await page.waitForTimeout(3000);
    await expect(page.locator('text=PropManager').first()).toBeVisible({ timeout: 10000 });
  });

  test('PM signup form shows correct fields', async ({ page }) => {
    await page.goto('/');
    // Click "Get Started" under Property Manager
    const pmLink = page.locator('text=Get Started').first();
    if (await pmLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await pmLink.click();
      await page.waitForTimeout(1000);
      // Should have email and password fields at minimum
      await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('input[type="password"]')).toBeVisible();
    }
  });

  test('Tenant signup form shows invite code field', async ({ page }) => {
    await page.goto('/');
    // Click tenant signup button ("Enter Invite Code →" or "Tenant")
    const tenantBtn = page.locator('button:has-text("Tenant"), button:has-text("Enter Invite Code")').first();
    if (await tenantBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tenantBtn.click();
      await page.waitForTimeout(1000);
      // Should show email/password + invite code input
      await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
      // Look for invite code label
      await expect(page.locator('label:has-text("Invite Code")')).toBeVisible({ timeout: 3000 });
      // Should have at least 3 inputs total (name, email, password) + invite code
      const inputs = page.locator('input');
      const count = await inputs.count();
      expect(count).toBeGreaterThanOrEqual(4);
    }
  });

  test('back to sign in link works from signup', async ({ page }) => {
    await page.goto('/');
    const pmBtn = page.locator('button:has-text("Property Manager")').first();
    if (await pmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await pmBtn.click();
      await page.waitForTimeout(500);
      const backLink = page.locator('text=Sign In').last();
      if (await backLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        await backLink.click();
        await page.waitForTimeout(500);
        // Should be on login form
        await expect(page.locator('input[type="email"]')).toBeVisible();
      }
    }
  });
});
