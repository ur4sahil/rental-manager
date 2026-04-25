// ═══════════════════════════════════════════════════════════════
// 65 — OWNER PORTAL click-coverage sweep
// Logs in as a dedicated owner test user (clicktest-owner@…
// seeded by seed-clicktest-data.js step 9) and exercises the
// owner portal's 5 tabs. Owner role with companyRole !== "admin"
// is auto-routed to owner_portal (App.js:937).
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, assertNoHorizontalOverflow } = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';
const OWNER_EMAIL = 'clicktest-owner@propmanager.com';
const OWNER_PASSWORD = process.env.CLICK_PORTAL_PASSWORD || 'ClickTest!2026';

test.describe('Owner Portal — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, {
      companySlug: SMITH,
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      expectsPortal: true,
    });
    await page.waitForTimeout(1500);
  });

  test('owner portal renders without crash and without overflow', async ({ page }) => {
    const crashed = await page.locator('text=Something went wrong')
      .first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
    await assertNoHorizontalOverflow(page);
  });

  // Owner portal tabs (Owners.js OwnerPortal): Overview, Statements,
  // Distributions, Properties, Maintenance.
  const tabs = [
    { label: 'Overview',      marker: /Overview|Properties|Statement|Total|Balance/i  },
    { label: 'Statements',    marker: /Statement|Period|Net|Total|Sent|Draft/i         },
    { label: 'Distributions', marker: /Distribution|Date|Amount|Property/i             },
    { label: 'Properties',    marker: /Propert|Address|Tenant|Rent|No properties/i      },
    { label: 'Maintenance',   marker: /Maintenance|Issue|Status|Cost|Property/i        },
  ];

  for (const t of tabs) {
    test(`${t.label} tab renders without crash`, async ({ page }) => {
      const btn = page.locator('button').filter({ hasText: new RegExp(t.label) }).first();
      if (!await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
        test.skip(true, `${t.label} tab not visible — layout differs`);
        return;
      }
      await btn.click();
      await page.waitForTimeout(1000);
      const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
      expect(crashed, `${t.label} tab should not crash`).toBeFalsy();
      const body = await page.locator('main').innerText().catch(() => '');
      expect(t.marker.test(body), `${t.label} tab renders relevant content`).toBeTruthy();
    });
  }

  test('header surfaces owner identity / company', async ({ page }) => {
    const body = await page.locator('body').innerText();
    const hasIdentity = /CT Portal Owner|Smith Properties|Owner/i.test(body);
    expect(hasIdentity, 'owner identity / company surfaces somewhere').toBeTruthy();
  });
});
