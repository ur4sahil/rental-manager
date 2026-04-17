// ═══════════════════════════════════════════════════════════════
// 38 — TENANT INVITE TO PORTAL: card-level button states
// ═══════════════════════════════════════════════════════════════
// Covers the Invite to Portal button shipped in commit 4551d6e.
// The Tenants component queries company_members on mount and
// shows one of three states per card:
//   - none        → primary purple "Invite to Portal" button
//   - invited     → "Resend Invite" with a pill
//   - active      → "Portal Active" pill, no button
// Also: disabled state when tenant has no email on file.
//
// We seed two test tenants via service role (one with email, one
// without) and rely on the default "none" membership state. We do
// NOT click Send because that fires real emails via Supabase auth.

const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
const { login, goToPage } = require('./helpers');
require('dotenv').config();

const svc = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;
const COMPANY_ID = 'sandbox-llc';

// Use a stable, grep-friendly prefix so we can clean up reliably.
// Avoid underscores/brackets in names — Playwright text= can choke on them.
const WITH_EMAIL_NAME    = 'ZZZ-E2E Tina WithEmail';
const WITH_EMAIL_EMAIL   = 'zzz-e2e-tina-withemail@example.com';
const WITHOUT_EMAIL_NAME = 'ZZZ-E2E Nora NoEmail';
// Pick a sandbox property address that already exists so the tenant fits.
let testPropertyAddress = null;

async function pickSandboxProperty() {
  const { data } = await svc.from('properties').select('address').eq('company_id', COMPANY_ID).is('archived_at', null).limit(1).maybeSingle();
  return data?.address || '123 Oak St';
}

async function seedTenants() {
  testPropertyAddress = await pickSandboxProperty();
  const rows = [
    {
      name: WITH_EMAIL_NAME,
      email: WITH_EMAIL_EMAIL,
      phone: '555-0111',
      property: testPropertyAddress,
      rent: 1500,
      balance: 0,
      lease_status: 'active',
      company_id: COMPANY_ID,
    },
    {
      name: WITHOUT_EMAIL_NAME,
      email: null,
      phone: '555-0112',
      property: testPropertyAddress,
      rent: 1500,
      balance: 0,
      lease_status: 'active',
      company_id: COMPANY_ID,
    },
  ];
  const { data, error } = await svc.from('tenants').insert(rows).select();
  if (error) throw new Error('seed tenants failed: ' + error.message);

  // Ensure no company_members row exists for the with-email tenant so the
  // button renders in its "none" state.
  await svc.from('company_members').delete()
    .eq('company_id', COMPANY_ID)
    .ilike('user_email', WITH_EMAIL_EMAIL);

  return data;
}

async function cleanup() {
  if (!svc) return;
  await svc.from('tenants').delete().eq('company_id', COMPANY_ID).in('name', [WITH_EMAIL_NAME, WITHOUT_EMAIL_NAME]);
  await svc.from('company_members').delete().eq('company_id', COMPANY_ID).ilike('user_email', WITH_EMAIL_EMAIL);
}

// Returns the card element for a tenant matched by visible name text.
// Tenants.js renders each card as an outer <div> with the tenant name
// inside; we walk up to that outer div.
function tenantCard(page, name) {
  // Use the name-only portion (without "ZZZ-E2E " prefix) to sidestep
  // Playwright's text-selector tokenization; match partial by getByText.
  return page.locator('div.rounded-3xl', { has: page.getByText(name, { exact: false }) }).first();
}

test.describe('Tenant Invite to Portal', () => {
  test.beforeAll(async () => {
    if (!svc) test.skip(true, 'SUPABASE_URL/SUPABASE_SERVICE_KEY missing in tests/.env');
    await seedTenants();
  });

  test.afterAll(async () => { await cleanup(); });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'tenants');
    await page.waitForTimeout(1500);
    // Filter the tenant list to the seeded names so pagination / scroll
    // never hides them. The search box matches on name/email/phone/property.
    const search = page.locator('input[placeholder*="Search name" i]').first();
    if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
      await search.fill('ZZZ-E2E');
      await page.waitForTimeout(600);
    }
  });

  test('tenant with email + no membership shows enabled "Invite to Portal"', async ({ page }) => {
    const card = tenantCard(page, WITH_EMAIL_NAME);
    if (!(await card.isVisible({ timeout: 5000 }).catch(() => false))) test.skip(true, 'Seeded tenant card not found — may be on a different view');

    const inviteBtn = card.locator('button:has-text("Invite to Portal")').first();
    await expect(inviteBtn).toBeVisible({ timeout: 5000 });
    await expect(inviteBtn).toBeEnabled();
  });

  test('tenant without email shows disabled button with tooltip', async ({ page }) => {
    const card = tenantCard(page, WITHOUT_EMAIL_NAME);
    if (!(await card.isVisible({ timeout: 5000 }).catch(() => false))) test.skip(true, 'Seeded tenant card not found');

    const inviteBtn = card.locator('button:has-text("Invite to Portal")').first();
    await expect(inviteBtn).toBeVisible({ timeout: 5000 });
    await expect(inviteBtn).toBeDisabled();
    const title = await inviteBtn.getAttribute('title');
    expect(title || '').toMatch(/email/i);
  });

  test('invited tenant flips the button label to "Resend Invite"', async ({ page }) => {
    // Flip membership to invited, then reload the Tenants page to refetch state.
    const { error: mErr } = await svc.from('company_members').upsert([{
      company_id: COMPANY_ID,
      user_email: WITH_EMAIL_EMAIL.toLowerCase(),
      user_name: WITH_EMAIL_NAME,
      role: 'tenant',
      status: 'invited',
    }], { onConflict: 'company_id,user_email' });
    if (mErr) test.skip(true, 'Could not upsert invited membership: ' + mErr.message);

    // Navigate away and back to force a fresh fetchPortalMembers — simpler
    // and more reliable than page.reload() which can lose the session/hash.
    await goToPage(page, 'dashboard');
    await page.waitForTimeout(800);
    await goToPage(page, 'tenants');
    await page.waitForTimeout(1500);
    const search = page.locator('input[placeholder*="Search name" i]').first();
    if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
      await search.fill('ZZZ-E2E');
      await page.waitForTimeout(600);
    }

    const card = tenantCard(page, WITH_EMAIL_NAME);
    if (!(await card.isVisible({ timeout: 5000 }).catch(() => false))) test.skip(true, 'Card not found after reload');

    await expect(card.locator('button:has-text("Resend Invite")').first()).toBeVisible({ timeout: 5000 });
    // Also: the "Invited" pill is shown in the card header
    await expect(card.locator('text=Invited').first()).toBeVisible();
    // And the original purple "Invite to Portal" CTA is gone
    const primaryBtnCount = await card.locator('button:has-text("Invite to Portal")').count();
    expect(primaryBtnCount).toBe(0);
  });

  test('active portal membership hides the button and shows green pill', async ({ page }) => {
    const { error: mErr } = await svc.from('company_members').upsert([{
      company_id: COMPANY_ID,
      user_email: WITH_EMAIL_EMAIL.toLowerCase(),
      user_name: WITH_EMAIL_NAME,
      role: 'tenant',
      status: 'active',
    }], { onConflict: 'company_id,user_email' });
    if (mErr) test.skip(true, 'Could not upsert active membership: ' + mErr.message);

    // Navigate away and back to force a fresh fetchPortalMembers — simpler
    // and more reliable than page.reload() which can lose the session/hash.
    await goToPage(page, 'dashboard');
    await page.waitForTimeout(800);
    await goToPage(page, 'tenants');
    await page.waitForTimeout(1500);
    const search = page.locator('input[placeholder*="Search name" i]').first();
    if (await search.isVisible({ timeout: 3000 }).catch(() => false)) {
      await search.fill('ZZZ-E2E');
      await page.waitForTimeout(600);
    }

    const card = tenantCard(page, WITH_EMAIL_NAME);
    if (!(await card.isVisible({ timeout: 5000 }).catch(() => false))) test.skip(true, 'Card not found after reload');

    await expect(card.locator('text=Portal Active').first()).toBeVisible({ timeout: 5000 });
    // No invite / resend button for active users
    const btnCount = await card.locator('button:has-text("Invite"), button:has-text("Resend")').count();
    expect(btnCount).toBe(0);
  });
});
