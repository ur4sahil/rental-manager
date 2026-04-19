// ═══════════════════════════════════════════════════════════════
// 40 — PROPERTY TAX BILLS: /tax-bills page, filters, Mark Paid
// ═══════════════════════════════════════════════════════════════
// Seeds a property (so we have a jurisdiction bucket) and a pair
// of bills via the service-role client, drives the UI through the
// Tax Bills page, then cleans up. Covers:
//  - Tax Bills nav item appears under Properties expand
//  - Page header + filter pills render with correct counts
//  - Bill row shows installment label, due date, expected amount,
//    and a days-left / overdue / paid chip
//  - Mark paid flow hides the bill from the "open" filter and
//    surfaces it under the "paid" filter
//  - Filter pill toggles narrow the list as expected

const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
const { login, navigateTo } = require('./helpers');
require('dotenv').config();

const svc = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const COMPANY_ID = 'sandbox-llc';

const ADDR_LINE_1 = 'ZZZ-E2E-TXB 8181 Tax Bill Test Way';
const ADDR_CITY = 'Fairfax';
const ADDR_STATE = 'VA';
const ADDR_ZIP = '22030';

async function goToTaxBills(page) {
  // Tax Bills is nested under Properties — expand that group first.
  const chevron = page.locator('button:has(span:has-text("expand_more"))').first();
  if (await chevron.isVisible({ timeout: 2000 }).catch(() => false)) {
    await chevron.click();
    await page.waitForTimeout(400);
  }
  await navigateTo(page, 'Tax Bills');
}

async function seed() {
  // Scrub any leftovers from a previous aborted run (unique index on address
  // would otherwise trip the insert below).
  const { data: stale } = await svc.from('properties')
    .select('id')
    .eq('company_id', COMPANY_ID)
    .like('address_line_1', 'ZZZ-E2E-TXB%');
  if (stale && stale.length) {
    const ids = stale.map(r => r.id);
    await svc.from('property_tax_bills').delete().eq('company_id', COMPANY_ID).in('property_id', ids);
    await svc.from('properties').delete().in('id', ids);
  }

  const { data: prop, error: pErr } = await svc.from('properties').insert([{
    address_line_1: ADDR_LINE_1,
    city: ADDR_CITY,
    state: ADDR_STATE,
    zip: ADDR_ZIP,
    county: 'Fairfax County',
    type: 'Single Family',
    status: 'vacant',
    rent: 2000,
    company_id: COMPANY_ID,
  }]).select().single();
  if (pErr) throw new Error('seed property failed: ' + pErr.message);

  const today = new Date();
  const dueSoon = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10);
  const dueLater = new Date(today.getTime() + 120 * 86400000).toISOString().slice(0, 10);

  const { data: bills, error: bErr } = await svc.from('property_tax_bills').insert([
    {
      company_id: COMPANY_ID,
      property: prop.address,
      property_id: prop.id,
      tax_year: today.getFullYear(),
      installment_label: '1st half (VA)',
      due_date: dueSoon,
      expected_amount: 2600,
      status: 'pending',
      auto_generated: true,
    },
    {
      company_id: COMPANY_ID,
      property: prop.address,
      property_id: prop.id,
      tax_year: today.getFullYear(),
      installment_label: '2nd half (VA)',
      due_date: dueLater,
      expected_amount: 2600,
      status: 'pending',
      auto_generated: true,
    },
  ]).select();
  if (bErr) throw new Error('seed bills failed: ' + bErr.message);
  return { propId: prop.id, propAddress: prop.address, bills };
}

async function cleanup(propId) {
  if (!propId || !svc) return;
  await svc.from('property_tax_bills').delete().eq('company_id', COMPANY_ID).eq('property_id', propId);
  await svc.from('properties').delete().eq('id', propId);
}

test.describe('Property Tax Bills', () => {
  let propId = null;

  test.beforeAll(async () => {
    if (!svc) test.skip(true, 'SUPABASE_URL/SUPABASE_SERVICE_KEY missing in tests/.env');
    const seeded = await seed();
    propId = seeded.propId;
  });

  test.afterAll(async () => { await cleanup(propId); });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Tax Bills page renders with header, pills, and seeded bill row', async ({ page }) => {
    await goToTaxBills(page);
    await page.waitForTimeout(1500);

    // Page header
    await expect(page.locator('text=Property Tax Bills').first()).toBeVisible({ timeout: 5000 });

    // Regenerate button
    await expect(page.locator('button:has-text("Regenerate")').first()).toBeVisible();

    // Filter pills
    await expect(page.locator('text=/Open · [0-9]+/').first()).toBeVisible();
    await expect(page.locator('text=/Overdue · [0-9]+/').first()).toBeVisible();
    await expect(page.locator('text=/This month · [0-9]+/').first()).toBeVisible();
    await expect(page.locator('text=/Next 30d · [0-9]+/').first()).toBeVisible();
    await expect(page.locator('text=/Paid · [0-9]+/').first()).toBeVisible();

    // Seeded rows — installment label visible
    await expect(page.locator('text=1st half (VA)').first()).toBeVisible();
    await expect(page.locator('text=2nd half (VA)').first()).toBeVisible();

    // Jurisdiction banner on the property group
    await expect(page.locator('text=/Fairfax County, VA/').first()).toBeVisible();
  });

  test('Days-left chip renders on the near-due bill', async ({ page }) => {
    await goToTaxBills(page);
    await page.waitForTimeout(1500);
    // The 14-day-out seed should show a "Nd left" chip
    await expect(page.locator('text=/[0-9]+d left/').first()).toBeVisible({ timeout: 5000 });
  });

  test('Filter pills toggle and narrow the list', async ({ page }) => {
    await goToTaxBills(page);
    await page.waitForTimeout(1500);

    // Paid filter → seeded bills are pending, so both should disappear
    await page.locator('text=/Paid · [0-9]+/').first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('text=1st half (VA)')).toHaveCount(0);

    // All filter → both come back
    await page.locator('text=/^All$/').first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('text=1st half (VA)').first()).toBeVisible();
    await expect(page.locator('text=2nd half (VA)').first()).toBeVisible();

    // Open filter → both still visible (pending)
    await page.locator('text=/Open · [0-9]+/').first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('text=1st half (VA)').first()).toBeVisible();
  });

  test('Mark paid flow moves the bill out of Open and into Paid', async ({ page }) => {
    await goToTaxBills(page);
    await page.waitForTimeout(1500);

    // Open filter is the default — click Mark paid on the 1st-half row
    const firstRow = page.locator('tr', { has: page.locator('text=1st half (VA)') }).first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.locator('button:has-text("Mark paid")').first().click();

    // Mark Paid modal
    await expect(page.locator('text=Mark bill paid').first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=/Paid date/').first()).toBeVisible();

    // Submit (date + amount pre-filled)
    await page.locator('[role="dialog"], .fixed').locator('button:has-text("Mark paid")').last().click();
    await page.waitForTimeout(1200);

    // Under Open filter (default): 1st half should no longer be visible,
    // but 2nd half still is
    const openFirstHalfCount = await page.locator('tr', { has: page.locator('text=1st half (VA)') }).count();
    expect(openFirstHalfCount).toBe(0);
    await expect(page.locator('text=2nd half (VA)').first()).toBeVisible();

    // Switch to Paid filter — 1st half reappears with Paid chip
    await page.locator('text=/Paid · [0-9]+/').first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('text=1st half (VA)').first()).toBeVisible();
    await expect(page.locator('text=/^Paid$/').first()).toBeVisible();
  });
});
