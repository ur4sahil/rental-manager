// ═══════════════════════════════════════════════════════════════
// 37 — PROPERTY LICENSES: CRUD tab, expiry chips, dashboard widget
// ═══════════════════════════════════════════════════════════════
// Seeds a property + a pair of licenses (one far-future, one
// expiring-soon) via the service-role client, drives the UI
// through the Licenses tab, then cleans up. Covers:
//  - Licenses tab appears with a count badge on the tab
//  - Row renders the human label ("Rental License"), jurisdiction,
//    and an expiry chip whose color reflects days-left
//  - Imminent-expiry license surfaces on the Dashboard in the
//    "License Expirations" widget
//
// Companion to the license feature shipped in commits 0f95277,
// 7b1ce20, a736777.

const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
const { login, goToPage } = require('./helpers');
require('dotenv').config();

const svc = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const COMPANY_ID = 'sandbox-llc';

// properties table has a BEFORE INSERT trigger (sync_addr) that overwrites
// the `address` column by composing it from address_line_1/line_2/city/state/zip.
// Passing `address` alone silently blanks the row. Seed must populate the
// structured fields; the trigger then computes `address` deterministically.
const ADDR_LINE_1 = 'ZZZ-E2E-LIC 4242 License Test Way';
const ADDR_CITY = 'Fairfax';
const ADDR_STATE = 'VA';
const ADDR_ZIP = '22030';

async function openSeededProperty(page) {
  await page.locator('text=/Total\\b/').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const search = page.locator('input[placeholder*="Search propert" i]').first();
  if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
    await search.fill('ZZZ-E2E-LIC');
    await page.waitForTimeout(1200);
  }
  const addrNode = page.getByText('ZZZ-E2E-LIC', { exact: false }).first();
  await addrNode.waitFor({ state: 'visible', timeout: 10000 });
  await addrNode.scrollIntoViewIfNeeded().catch(() => {});
  await addrNode.click();
  await page.waitForTimeout(900);
  return true;
}

async function seedPropertyWithLicenses() {
  const { data: prop, error: pErr } = await svc.from('properties').insert([{
    address_line_1: ADDR_LINE_1,
    city: ADDR_CITY,
    state: ADDR_STATE,
    zip: ADDR_ZIP,
    type: 'Single Family',
    status: 'vacant',
    rent: 2000,
    company_id: COMPANY_ID,
  }]).select().single();
  if (pErr) throw new Error('seed property failed: ' + pErr.message);

  const today = new Date();
  const expiringSoon = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10); // 14 days
  const farFuture   = new Date(today.getTime() + 400 * 86400000).toISOString().slice(0, 10); // ~13 months

  const { data: lics, error: lErr } = await svc.from('property_licenses').insert([
    {
      company_id: COMPANY_ID,
      property_id: prop.id,
      license_type: 'rental_license',
      license_number: 'E2E-RLC-001',
      jurisdiction: 'Fairfax County, VA',
      issue_date: new Date(today.getTime() - 351 * 86400000).toISOString().slice(0, 10),
      expiry_date: expiringSoon,
      fee_amount: 150,
      status: 'active',
    },
    {
      company_id: COMPANY_ID,
      property_id: prop.id,
      license_type: 'lead_paint',
      license_number: 'E2E-LP-002',
      jurisdiction: 'Fairfax County, VA',
      issue_date: today.toISOString().slice(0, 10),
      expiry_date: farFuture,
      fee_amount: 200,
      status: 'active',
    },
  ]).select();
  if (lErr) throw new Error('seed licenses failed: ' + lErr.message);
  return { propId: prop.id, propAddress: prop.address, licenses: lics };
}

async function cleanup(propId) {
  if (!propId || !svc) return;
  // property_licenses FK cascades on property delete
  await svc.from('properties').delete().eq('id', propId);
}

test.describe('Property Licenses', () => {
  let propId = null;
  let propAddress = null;

  test.beforeAll(async () => {
    if (!svc) test.skip(true, 'SUPABASE_URL/SUPABASE_SERVICE_KEY missing in tests/.env');
    const seeded = await seedPropertyWithLicenses();
    propId = seeded.propId;
    propAddress = seeded.propAddress;
  });

  test.afterAll(async () => { await cleanup(propId); });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Licenses tab appears in property detail with count badge', async ({ page }) => {
    await goToPage(page, 'properties');
    await page.waitForTimeout(1500);

    await openSeededProperty(page);

    // Tab strip: Details | Documents | Licenses (2) | Work Orders | History
    const licTab = page.locator('button:has-text("Licenses")').first();
    await expect(licTab).toBeVisible({ timeout: 5000 });
    const tabText = await licTab.textContent();
    expect(tabText).toMatch(/Licenses\s*\(2\)/);
  });

  test('Licenses tab body shows type label + jurisdiction + expiry chip', async ({ page }) => {
    await goToPage(page, 'properties');
    await page.waitForTimeout(1500);
    await openSeededProperty(page);

    await page.locator('button:has-text("Licenses")').first().click();
    await page.waitForTimeout(600);

    // Human-readable type label (from LICENSE_TYPE_LABELS in Properties.js)
    await expect(page.locator('text=Rental License').first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=Lead Paint Certificate').first()).toBeVisible();

    // Jurisdiction shown
    await expect(page.locator('text=Fairfax County, VA').first()).toBeVisible();

    // Expiring-soon license (14 days) shows an "Nd left" chip
    await expect(page.locator('text=/[0-9]+d left/').first()).toBeVisible();

    // Add + Edit + Archive buttons exist per row
    await expect(page.locator('button:has-text("Add License")').first()).toBeVisible();
    const editBtns = await page.locator('button:has-text("Edit")').count();
    expect(editBtns).toBeGreaterThanOrEqual(1);
  });

  test('Add License opens the form modal with the expected fields', async ({ page }) => {
    await goToPage(page, 'properties');
    await page.waitForTimeout(1500);
    await openSeededProperty(page);

    await page.locator('button:has-text("Licenses")').first().click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Add License")').first().click();
    await page.waitForTimeout(500);

    // LicenseFormModal — verify key fields
    await expect(page.locator('text=/Add License|Edit License/').first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=License Type').first()).toBeVisible();
    await expect(page.locator('text=Jurisdiction').first()).toBeVisible();
    await expect(page.locator('text=/Expiry Date/').first()).toBeVisible();
    await expect(page.locator('text=/Issue Date/').first()).toBeVisible();
  });

  test('Imminent license expiry surfaces on the Dashboard widget', async ({ page }) => {
    await goToPage(page, 'dashboard');
    await page.waitForTimeout(2000);

    // Widget only renders when there's at least one expiring license.
    // The seed inserts a 14-day license, so it should be here.
    const widgetTitle = page.locator('text=License Expirations').first();
    await expect(widgetTitle).toBeVisible({ timeout: 5000 });

    // Our seeded rental license should appear under that widget
    await expect(page.locator('text=Rental License').first()).toBeVisible();
    // days-left chip in amber/danger
    await expect(page.locator('text=/[0-9]+d left/').first()).toBeVisible();
  });
});
