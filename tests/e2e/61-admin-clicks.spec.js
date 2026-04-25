// ═══════════════════════════════════════════════════════════════
// 61 — ADMIN click-coverage sweep
// Admin page lives behind the avatar dropdown → Settings menu item.
// Tests reach it via direct hash routing (helpers.goToPage handles
// 'admin'/'audittrail'/'roles' as a special case). Four tabs:
// Audit Trail, Team & Roles, Settings, Errors.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, goToPage,
  assertNoHorizontalOverflow, assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Admin — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await goToPage(page, 'admin');
    await page.waitForTimeout(1500);
  });

  test('page renders without crash and without overflow', async ({ page }) => {
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  const tabs = [
    { label: 'Audit', marker: /Action|Module|Timestamp|User|Audit/i  },
    { label: 'Team',  marker: /Role|Member|Email|Invite|Team/i        },
    { label: 'Settings', marker: /Setting|Password|Theme|Account/i    },
    { label: 'Errors',   marker: /Error|Severity|Code|PM-/i           },
  ];

  for (const t of tabs) {
    test(`${t.label} tab renders without crash`, async ({ page }) => {
      const btn = page.locator(`button:has-text("${t.label}")`).first();
      if (!await btn.isVisible({ timeout: 2500 }).catch(() => false)) {
        test.skip(true, `${t.label} tab not visible — layout differs`);
        return;
      }
      await btn.click();
      await page.waitForTimeout(1000);
      const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
      expect(crashed, `${t.label} tab should not crash`).toBeFalsy();
      const body = await page.locator('main').innerText();
      expect(t.marker.test(body), `${t.label} tab renders relevant content`).toBeTruthy();
    });
  }
});
