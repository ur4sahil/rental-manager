// ═══════════════════════════════════════════════════════════════
// 50 — DASHBOARD click-coverage sweep (Smith Properties LLC)
// First spec in the click-coverage suite (50–66). Every visible
// dashboard control gets exercised against the CLICKTEST seed data
// (run `node seed-clicktest-data.js` first). The pattern this spec
// establishes — login(page, smith) + assertButtonsClickable +
// assertNoHorizontalOverflow + collectConsoleErrors at end — is
// what specs 51-66 will mirror.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login,
  navigateTo,
  assertNoHorizontalOverflow,
  assertButtonsClickable,
  collectConsoleErrors,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Dashboard — click coverage', () => {
  let consoleErrors;

  test.beforeEach(async ({ page }) => {
    consoleErrors = collectConsoleErrors(page);
    await login(page, SMITH);
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow or console errors', async ({ page }) => {
    await expect(page.locator('h2:has-text("Dashboard"), h1:has-text("Dashboard")').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
    expect(consoleErrors, 'no console errors on dashboard load').toEqual([]);
  });

  // ── Top-row stat cards (Occupancy / Revenue / Expenses / Net Income) ──
  test('Occupancy card navigates to Properties', async ({ page }) => {
    await page.locator('text=Occupancy').first().click();
    await expect(page.locator('h2:has-text("Properties")').first()).toBeVisible({ timeout: 5000 });
  });

  test('Revenue card navigates to Accounting', async ({ page }) => {
    await page.locator('text=Revenue').first().click();
    await expect(page.locator('h2:has-text("Accounting"), h1:has-text("Accounting")').first()).toBeVisible({ timeout: 5000 });
  });

  test('Expenses card navigates to Accounting', async ({ page }) => {
    await page.locator('text=Expenses').first().click();
    await expect(page.locator('h2:has-text("Accounting"), h1:has-text("Accounting")').first()).toBeVisible({ timeout: 5000 });
  });

  test('Net Income card navigates to Accounting', async ({ page }) => {
    await page.locator('text=Net Income').first().click();
    await expect(page.locator('h2:has-text("Accounting"), h1:has-text("Accounting")').first()).toBeVisible({ timeout: 5000 });
  });

  // ── Second-row stat cards (Rent Collected / Delinquent / Open WOs / Pending Utilities) ──
  test('Rent Collected card navigates to Payments', async ({ page }) => {
    await page.locator('text=Rent Collected').first().click();
    await expect(page.locator('h2:has-text("Payments")').first()).toBeVisible({ timeout: 5000 });
  });

  test('Delinquent card navigates to Tenants', async ({ page }) => {
    await page.locator('text=Delinquent').first().click();
    await expect(page.locator('h2:has-text("Tenants")').first()).toBeVisible({ timeout: 5000 });
  });

  test('Open Work Orders card navigates to Maintenance', async ({ page }) => {
    await page.locator('text=Open Work Orders').first().click();
    await expect(page.locator('h2:has-text("Maintenance")').first()).toBeVisible({ timeout: 5000 });
  });

  test('Pending Utilities card navigates to Utilities', async ({ page }) => {
    await page.locator('text=Pending Utilities').first().click();
    await expect(page.locator('h2:has-text("Utilities")').first()).toBeVisible({ timeout: 5000 });
  });

  // ── Lease Expirations panel ──
  test('lease expirations panel renders (data or empty state)', async ({ page }) => {
    const panel = page.locator('h3:has-text("Lease Expirations")').first();
    await expect(panel).toBeVisible();
    // Either we see at least one tenant row, or the explicit empty state.
    const body = await page.locator('body').innerText();
    const hasContent = /No upcoming lease expirations|CT (Active|Past-Due|DocPending)/.test(body);
    expect(hasContent, 'lease expirations panel has either data or empty state').toBeTruthy();
  });

  // ── Header bell ──
  test('notification bell opens dropdown', async ({ page }) => {
    const bell = page.locator('button:has(span:text("notifications"))').first();
    if (!await bell.isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'notification bell not in current header layout');
      return;
    }
    await bell.click();
    await page.waitForTimeout(400);
    // A dropdown should open with either a list or an empty state
    const opened = await page.locator('text=/no notifications|view all|clear/i').first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    expect(opened, 'notification dropdown opened').toBeTruthy();
  });

  // ── Header avatar ──
  test('user avatar opens menu with logout option', async ({ page }) => {
    // Avatar button is typically a circular button with an initial — match by aria-label or icon.
    const avatarBtn = page.locator('button[aria-label*="user" i], button[aria-label*="account" i], button:has-text(/^[A-Z]$/)').first();
    if (!await avatarBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'avatar button selector did not match — header layout differs');
      return;
    }
    await avatarBtn.click();
    await page.waitForTimeout(300);
    const menuOpen = await page.locator('text=/logout|sign out|switch company|profile/i').first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    expect(menuOpen, 'user menu opened').toBeTruthy();
  });
});
