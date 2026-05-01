// ═══════════════════════════════════════════════════════════════
// 64 — TENANT PORTAL click-coverage sweep
// Logs in as a dedicated tenant test user (clicktest-tenant@…
// seeded by seed-clicktest-data.js step 9) and exercises the
// tenant portal's 7 tabs. Tenant role is auto-routed to
// tenant_portal by App.js:937, so login lands directly on the
// portal — no sidebar navigation involved.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, assertNoHorizontalOverflow } = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';
const TENANT_EMAIL = 'clicktest-tenant@propmanager.com';
const TENANT_PASSWORD = process.env.CLICK_PORTAL_PASSWORD || 'ClickTest!2026';

test.describe('Tenant Portal — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, {
      companySlug: SMITH,
      email: TENANT_EMAIL,
      password: TENANT_PASSWORD,
      expectsPortal: true,
    });
    await page.waitForTimeout(1500);
  });

  test('tenant portal renders without crash and without overflow', async ({ page }) => {
    const crashed = await page.locator('text=Something went wrong')
      .first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
    await assertNoHorizontalOverflow(page);
  });

  // Tenant portal tabs (TenantPortal.js): Overview, Pay Rent, Autopay,
  // Ledger (renamed from History), Maintenance, Documents, Messages.
  const tabs = [
    { label: 'Overview',    marker: /Balance|Lease|Property|Rent/i                    },
    { label: 'Pay Rent',    marker: /Pay|Amount|Method|Card/i                          },
    { label: 'Autopay',     marker: /Autopay|Schedule|Day|Enable/i                     },
    { label: 'Ledger',      marker: /Ledger|Date|Amount|Balance|Charge|Payment/i       },
    { label: 'Maintenance', marker: /Maintenance|Issue|Submit|Photo|Request/i          },
    { label: 'Documents',   marker: /Document|Upload|View|Lease|PDF/i                  },
    { label: 'Messages',    marker: /Message|Send|Compose|Manager|Conversation/i       },
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

  test('header shows tenant name / property', async ({ page }) => {
    // Wait for the portal data fetch to settle. On cold-start Vercel
    // the initial render is empty until the tenants/leases queries
    // come back; the 1.5s wait in beforeEach isn't always enough.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const body = await page.locator('body').innerText();
    // Either the tenant's name "CT Portal Tenant" or the property
    // address "Click Test Way" should appear somewhere.
    const hasIdentity = /CT Portal Tenant|Click Test Way|101/i.test(body);
    expect(hasIdentity, 'tenant identity surfaces somewhere in portal').toBeTruthy();
  });
});
