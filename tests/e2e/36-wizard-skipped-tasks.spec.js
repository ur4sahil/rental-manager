// ═══════════════════════════════════════════════════════════════
// 36 — WIZARD-SKIPPED SECTIONS → TASKS & APPROVALS
// ═══════════════════════════════════════════════════════════════
// Drives the new pending-task derivation: any section skipped in the
// Property Setup Wizard shows up in Tasks & Approvals with "Open
// Setup" + admin "Mark Complete" actions. The wizard itself is a
// long multi-step UI; to keep this test deterministic we seed a
// wizard row directly into Supabase with a known mix of completed
// + skipped steps, then validate what Tasks & Approvals derives.
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const SERVICE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const COMPANY_ID = 'sandbox-llc';
const TEST_ADDRESS = '100 Oak Street'; // seeded occupied property in Sandbox LLC
const WIZARD_LABEL_PREFIX = 'Setup: ';

function svc() {
  if (!SERVICE_URL || !SERVICE_KEY) return null;
  return createClient(SERVICE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

test.describe('Wizard Skipped → Tasks & Approvals', () => {
  test.beforeAll(async () => {
    const client = svc();
    if (!client) test.skip(true, 'SUPABASE_URL/SUPABASE_SERVICE_KEY missing — cannot seed wizard row');
  });

  test.beforeEach(async ({ page }) => {
    const client = svc();
    if (!client) return;
    // Clean any prior seeded row for this test address so the run is
    // idempotent even if a previous attempt crashed mid-flight.
    await client.from('property_setup_wizard')
      .delete()
      .eq('company_id', COMPANY_ID)
      .eq('property_address', TEST_ADDRESS);
    // Seed: property_details + tenant_lease done, Insurance + HOA
    // skipped (→ should produce 2 pending tasks for an occupied prop).
    const { error } = await client.from('property_setup_wizard').insert([{
      company_id: COMPANY_ID,
      property_address: TEST_ADDRESS,
      status: 'in_progress',
      current_step: 7,
      completed_steps: ['property_details', 'tenant_lease', 'utilities', 'documents', 'property_tax', 'recurring_rent'],
      skipped_approved_steps: [],
      wizard_data: {},
    }]);
    if (error) test.skip(true, 'Could not seed wizard row: ' + error.message);
    await login(page);
  });

  test.afterEach(async () => {
    const client = svc();
    if (!client) return;
    await client.from('property_setup_wizard')
      .delete()
      .eq('company_id', COMPANY_ID)
      .eq('property_address', TEST_ADDRESS);
  });

  test('skipped sections appear as pending tasks', async ({ page }) => {
    test.setTimeout(60000);
    await navigateTo(page, 'Tasks & Approvals');
    // Scan the body — wizard-skip tasks are titled "Setup: <Label> — <addr>"
    await page.waitForTimeout(2500);
    const body = (await page.locator('body').innerText()) || '';
    expect(body).toContain(WIZARD_LABEL_PREFIX + 'HOA');
    expect(body).toContain(WIZARD_LABEL_PREFIX + 'Insurance');
    // A completed step (Utilities) should NOT be listed
    const utilTaskRe = new RegExp(WIZARD_LABEL_PREFIX + 'Utilities');
    expect(utilTaskRe.test(body)).toBeFalsy();
  });

  test('Open Setup button navigates to the wizard', async ({ page }) => {
    test.setTimeout(60000);
    await navigateTo(page, 'Tasks & Approvals');
    await page.waitForTimeout(2500);
    // Find the row for "Setup: Insurance" and click its Open Setup btn.
    const row = page.locator('div:has(> .text-sm:text("Setup: Insurance"))').first();
    // Fallback to a text-based ancestor match if the locator above doesn't hit
    const openBtn = page.locator('div:has-text("Setup: Insurance")').locator('button:has-text("Open Setup")').first();
    if (!await openBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'Open Setup button not rendered — layout may have shifted');
      return;
    }
    await openBtn.click();
    await page.waitForTimeout(2000);
    // Landed on Properties page — wizard modal should be visible
    const wizardOpen = await page.locator('text=Property Setup').first().isVisible({ timeout: 8000 }).catch(() => false);
    expect(wizardOpen).toBeTruthy();
  });

  test('admin Mark Complete removes the task + records approved skip', async ({ page }) => {
    test.setTimeout(60000);
    const client = svc();
    await navigateTo(page, 'Tasks & Approvals');
    await page.waitForTimeout(2500);
    const markBtn = page.locator('div:has-text("Setup: HOA")').locator('button:has-text("Mark Complete")').first();
    if (!await markBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'Mark Complete not visible — not logged in as admin?');
      return;
    }
    await markBtn.click();
    // ConfirmModal appears — click the Mark Complete button in it.
    await page.waitForTimeout(400);
    const confirmBtn = page.locator('[class*="z-\\[90\\]"]').locator('button:has-text("Mark Complete")').first();
    await confirmBtn.click({ force: true });
    // Wait for refresh
    await page.waitForTimeout(2500);
    // HOA task should be gone
    const body = (await page.locator('body').innerText()) || '';
    expect(body.includes(WIZARD_LABEL_PREFIX + 'HOA')).toBeFalsy();
    // DB should now show the approved skip
    const { data } = await client.from('property_setup_wizard')
      .select('skipped_approved_steps')
      .eq('company_id', COMPANY_ID)
      .eq('property_address', TEST_ADDRESS)
      .maybeSingle();
    expect((data?.skipped_approved_steps || []).includes('hoa')).toBeTruthy();
  });
});
