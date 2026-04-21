// ═══════════════════════════════════════════════════════════════
// 42 — MANAGER ROLE + APPROVAL ROUTING
// ═══════════════════════════════════════════════════════════════
// Exercises the Admin → Team & Roles UI for the new Manager role:
//   - Role dropdown offers Manager
//   - Approval Manager selector is hidden for admin/tenant and shown
//     for every other role
//   - Role legend cards include the Manager pill
//
// Routing logic (who sees which request) is exhaustively covered by
// tests/manager-approvals.test.js — this spec only sanity-checks that
// routing shows up end-to-end by seeding a property_change_request
// with approver_email = admin's email and checking it renders on the
// Tasks & Approvals page.
const { test, expect } = require('@playwright/test');
const { login, goToPage } = require('./helpers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const SERVICE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const COMPANY_ID = 'sandbox-llc';

function svc() {
  if (!SERVICE_URL || !SERVICE_KEY) return null;
  return createClient(SERVICE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

test.describe('Manager role — Admin form', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'roles');
    await page.waitForTimeout(1500);
  });

  test('Role dropdown lists Manager', async ({ page }) => {
    await page.locator('button:has-text("+ Add User"), button:has-text("Add User")').first().click();
    await page.waitForTimeout(400);
    // Role select is the one that lists CUSTOMIZABLE_ROLES + Admin (no Tenant).
    const roleSelect = page.locator('select').filter({ hasText: /Admin/ }).filter({ hasText: /Office/ }).first();
    const optionText = await roleSelect.locator('option').allTextContents();
    expect(optionText.some(t => /Manager/i.test(t))).toBeTruthy();
  });

  test('Approval Manager selector is hidden for admin, shown for non-admin', async ({ page }) => {
    await page.locator('button:has-text("+ Add User"), button:has-text("Add User")').first().click();
    await page.waitForTimeout(400);
    // Initial role = office_assistant → Approval Manager label is visible.
    const label = page.locator('text=Approval Manager');
    await expect(label.first()).toBeVisible({ timeout: 5000 });
    // Switch to Admin — selector should disappear.
    const roleSelect = page.locator('select').filter({ hasText: /Admin/ }).filter({ hasText: /Office/ }).first();
    await roleSelect.selectOption({ label: 'Admin' });
    await page.waitForTimeout(300);
    const stillVisible = await label.first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(stillVisible).toBeFalsy();
    // Switch to Manager — selector should reappear (managers can be
    // routed to another reviewer above them).
    await roleSelect.selectOption({ label: 'Manager' });
    await page.waitForTimeout(300);
    await expect(label.first()).toBeVisible({ timeout: 3000 });
  });

  test('Manager pill appears in role legend', async ({ page }) => {
    // Role legend renders one card per ROLES entry
    const body = await page.locator('body').innerText();
    expect(body).toMatch(/Manager/);
  });
});

test.describe('Manager role — request routing end-to-end', () => {
  const PROP_ADDRESS = 'TEST Manager Routing — 1 Elm Street';
  const REQUEST_NOTE = 'e2e-manager-route-' + Date.now();

  test('seeded property_change_request with admin approver_email renders on Tasks', async ({ page }) => {
    test.setTimeout(60000);
    const client = svc();
    if (!client) test.skip(true, 'SUPABASE_URL/SUPABASE_SERVICE_KEY missing');

    const adminEmail = process.env.TEST_EMAIL;
    if (!adminEmail) test.skip(true, 'TEST_EMAIL missing — cannot target admin approver');

    // Clean any prior seeded row so the test is idempotent.
    await client.from('property_change_requests')
      .delete()
      .eq('company_id', COMPANY_ID)
      .eq('notes', REQUEST_NOTE);
    const { error } = await client.from('property_change_requests').insert([{
      company_id: COMPANY_ID,
      request_type: 'delete',
      requested_by: 'e2e-seeder@test.local',
      address: PROP_ADDRESS,
      type: 'Single Family',
      property_status: 'vacant',
      notes: REQUEST_NOTE,
      approver_email: adminEmail, // routed to the logged-in admin
      status: 'pending',
    }]);
    if (error) test.skip(true, 'Could not seed change request: ' + error.message);

    try {
      await login(page);
      await goToPage(page, 'tasks');
      await page.waitForTimeout(2500);
      const body = await page.locator('body').innerText();
      // Tasks page lists the address on the pending request card
      expect(body).toContain(PROP_ADDRESS);
    } finally {
      await client.from('property_change_requests')
        .delete()
        .eq('company_id', COMPANY_ID)
        .eq('notes', REQUEST_NOTE);
    }
  });
});
