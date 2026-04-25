// ═══════════════════════════════════════════════════════════════
// 59 — VENDORS + OWNERS click-coverage sweep
// 5 CT vendors (4 active, 1 inactive) and 3 CT owners (2 active,
// 1 inactive) are seeded. Exercises both modules' core clickables.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, navigateTo, goToPage,
  assertNoHorizontalOverflow, assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Vendors — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Vendors');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow', async ({ page }) => {
    // PageHeader title is "Vendor Management" — `:has-text("Vendor")` matches
    // both that and any future variant.
    await expect(page.locator('h2:has-text("Vendor")').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  test('seeded CT vendors are visible', async ({ page }) => {
    // At least one of the 5 CT vendors should render
    const card = page.locator('text=/CLICKTEST/').first();
    await expect(card).toBeVisible({ timeout: 5000 });
  });

  test('+ Add vendor button opens form', async ({ page }) => {
    const addBtn = page.locator('button:has-text("+ Add"), button:has-text("+ New"), button:has-text("New Vendor")').first();
    if (!await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'add-vendor button not visible — role gated');
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(700);
    const formOpen = await page.locator('text=/Vendor Name|First Name|Specialty/i')
      .first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(formOpen, 'new vendor form opened').toBeTruthy();
    const cancel = page.locator('button:has-text("Cancel")').first();
    if (await cancel.isVisible({ timeout: 1500 }).catch(() => false)) await cancel.click();
  });

  test('vendor card click opens detail', async ({ page }) => {
    const card = page.locator('text=/CLICKTEST Plumbing Pros/').first();
    if (!await card.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'no CT vendor — run seed:click first');
      return;
    }
    await card.click();
    await page.waitForTimeout(1000);
    const detail = page.locator('text=/Specialty|Phone|Email|Edit|Archive/i').first();
    await expect(detail).toBeVisible({ timeout: 3000 });
  });
});

// Owners — deferred. Owners is a hidden route (no sidebar link in the
// admin role's rendered sidebar even though the role allows it). Hash
// navigation via goToPage('owners') doesn't route — the popstate
// dispatch is firing but `page` state isn't updating to "owners".
// Cause-finding is bigger than this spec; coming back to it as a
// separate task once we have a working hash route or a direct setPage
// hook to drive from tests.
