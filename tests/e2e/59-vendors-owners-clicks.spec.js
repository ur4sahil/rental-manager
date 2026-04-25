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

test.describe('Owners — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    // Owners is a hidden route (no sidebar link). goToPage routes via
    // hash — App.js's popstate listener picks it up and sets page.
    // This works AS LONG AS the test user's company_members.custom_pages
    // is null/includes 'owners'; the seed clears that column to ensure
    // admin role's full page list applies.
    await goToPage(page, 'owners');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow', async ({ page }) => {
    await expect(page.locator('h2:has-text("Owner")').first()).toBeVisible({ timeout: 5000 });
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  test('seeded CT owners are visible', async ({ page }) => {
    const card = page.locator('text=/CLICKTEST Alpha Holdings|CLICKTEST Beta Investments/').first();
    await expect(card).toBeVisible({ timeout: 5000 });
  });

  test('+ Add owner button opens form', async ({ page }) => {
    const addBtn = page.locator('button:has-text("+ Add"), button:has-text("+ New"), button:has-text("New Owner")').first();
    if (!await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'add-owner button not visible — role may not allow');
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(700);
    const formOpen = await page.locator('text=/Owner Name|First Name|Management Fee/i')
      .first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(formOpen, 'new owner form opened').toBeTruthy();
    const cancel = page.locator('button:has-text("Cancel")').first();
    if (await cancel.isVisible({ timeout: 1500 }).catch(() => false)) await cancel.click();
  });

  test('owner tab strip (overview/statements/distributions) renders', async ({ page }) => {
    const tab = page.locator('button:has-text("Statements"), button:has-text("Distributions")').first();
    if (!await tab.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'no statements/distributions tab in current layout');
      return;
    }
    await tab.click();
    await page.waitForTimeout(800);
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
  });
});
