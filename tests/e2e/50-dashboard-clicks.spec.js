// ═══════════════════════════════════════════════════════════════
// 50 — DASHBOARD click-coverage sweep (Smith Properties LLC)
// First spec in the click-coverage suite (50–66). Every visible
// dashboard control gets exercised against the CLICKTEST seed data
// (run `node seed-clicktest-data.js` first).
//
// Pattern this spec establishes for 51-66:
//   • login(page, SMITH) routes via ?company=<UUID> auto-select
//   • assertNoHorizontalOverflow + assertButtonsClickable per page
//   • each navigation test uses a page-UNIQUE marker (a button or
//     stat-card label that only that page renders), not the sidebar
//     active-state — the sidebar buttons share text with the cards.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login,
  navigateTo,
  assertNoHorizontalOverflow,
  assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

// Click a stat card by its label and verify a UNIQUE marker for the
// destination page renders. The label-based locator naturally targets
// the card (the only element on Dashboard with that exact text), and
// `.first()` is safe because labels are distinct.
async function clickStatCardAndVerify(page, cardLabel, destinationMarker) {
  // Use exact text match scoped to main content to skip the sidebar.
  await page.locator('main').getByText(cardLabel, { exact: true }).first().click();
  await expect(destinationMarker).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(1500);
  });

  // ── Smoke ──
  test('renders all 8 stat cards and is overflow-free', async ({ page }) => {
    for (const label of [
      'Occupancy', 'Revenue (Acctg)', 'Expenses (Acctg)', 'Net Income',
      'Rent Collected', 'Delinquent', 'Open Work Orders', 'Pending Utilities',
    ]) {
      await expect(page.locator('main').getByText(label, { exact: true }).first(),
        `${label} card visible`).toBeVisible({ timeout: 5000 });
    }
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  // ── Top-row stat cards (Occupancy / Revenue / Expenses / Net Income) ──
  // Each row uses a unique destination marker:
  //   Properties: heading "Properties" h2 (PageHeader convention)
  //   Accounting: "New Journal Entry" CTA — only this page renders it
  test('Occupancy card → Properties', async ({ page }) => {
    await clickStatCardAndVerify(page, 'Occupancy',
      page.locator('h2:has-text("Properties"), h1:has-text("Properties")').first());
  });

  test('Revenue card → Accounting', async ({ page }) => {
    await clickStatCardAndVerify(page, 'Revenue (Acctg)',
      page.locator('button:has-text("New Journal Entry")').first());
  });

  test('Expenses card → Accounting', async ({ page }) => {
    await clickStatCardAndVerify(page, 'Expenses (Acctg)',
      page.locator('button:has-text("New Journal Entry")').first());
  });

  test('Net Income card → Accounting', async ({ page }) => {
    await clickStatCardAndVerify(page, 'Net Income',
      page.locator('button:has-text("New Journal Entry")').first());
  });

  // ── Second-row stat cards ──
  test('Rent Collected card → Payments', async ({ page }) => {
    await clickStatCardAndVerify(page, 'Rent Collected',
      page.locator('h2:has-text("Payments")').first());
  });

  test('Delinquent card → Tenants', async ({ page }) => {
    await clickStatCardAndVerify(page, 'Delinquent',
      page.locator('h2:has-text("Tenants")').first());
  });

  test('Open Work Orders card → Maintenance', async ({ page }) => {
    await clickStatCardAndVerify(page, 'Open Work Orders',
      page.locator('h2:has-text("Maintenance")').first());
  });

  test('Pending Utilities card → Utilities', async ({ page }) => {
    await clickStatCardAndVerify(page, 'Pending Utilities',
      page.locator('h2:has-text("Utilities")').first());
  });

  // ── Lease Expirations panel ──
  test('lease expirations panel renders (data or empty state)', async ({ page }) => {
    await expect(page.locator('h3:has-text("Lease Expirations")').first()).toBeVisible();
    const body = await page.locator('body').innerText();
    const hasContent = /No upcoming lease expirations|days/i.test(body);
    expect(hasContent, 'lease expirations panel has either data or empty state').toBeTruthy();
  });

  // ── Header bell ──
  // Sidebar also has a "notifications_active Notifications" item — the
  // header bell is the standalone "notifications" button in the banner.
  test('notification bell opens dropdown', async ({ page }) => {
    const bell = page.locator('header button[aria-label*="notification" i], header button:has-text("notifications")').first();
    if (!await bell.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Fallback: any banner button whose only visible content is the
      // material-icons "notifications" glyph.
      const fallback = page.locator('banner button, [role="banner"] button').filter({ hasText: /^notifications$/ }).first();
      if (!await fallback.isVisible({ timeout: 1500 }).catch(() => false)) {
        test.skip(true, 'header bell not in current layout');
        return;
      }
      await fallback.click();
    } else {
      await bell.click();
    }
    await page.waitForTimeout(500);
    // Some payload must surface — list, empty state, or a "Mark all" / "View all" CTA
    const opened = await page.locator('text=/no notifications|mark all|view all|clear|recent/i').first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    expect(opened, 'notification dropdown surfaces some content').toBeTruthy();
  });

  // ── Header user menu ──
  test('user menu opens with logout option', async ({ page }) => {
    // Avatar button shows "<initial> <name> expand_more" per the live DOM.
    const avatar = page.locator('header button:has-text("expand_more"), banner button:has-text("expand_more")').first();
    if (!await avatar.isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'avatar/expand button not in current layout');
      return;
    }
    await avatar.click();
    await page.waitForTimeout(300);
    const menuOpen = await page.locator('text=/logout|sign out|switch company|profile/i').first()
      .isVisible({ timeout: 2000 }).catch(() => false);
    expect(menuOpen, 'user menu surfaces logout/profile/switch').toBeTruthy();
  });
});
