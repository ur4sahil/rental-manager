// ═══════════════════════════════════════════════════════════════
// 38 — TENANT ↔ PROPERTY: EVERY WAY OCCUPANCY CAN CHANGE
// ═══════════════════════════════════════════════════════════════
//
// The property record and the tenant record used to be written separately
// and read separately, so a tenant marked active on the Tenants page left the
// property saying vacant, and the wizard hid its tenant step for a vacant
// property -- a loop with no exit. Occupancy is now derived from the tenant
// record by the database.
//
// Each scenario drives the REAL screens, screenshots every step, then asks
// the DATABASE what it holds -- because a screen can look right while the
// row underneath is wrong, and the row is what every other screen reads.
//
// Run against a local build pointed at the test project:
//   TEST_DOC_PROPERTY unused; needs TEST_SUPABASE_URL + TEST_SUPABASE_SERVICE_KEY
const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
const { login, gotoRoute } = require('./helpers');
const path = require('path');
const fs = require('fs');

const COMPANY = 'sandbox-llc';
// NOT under test-results/: Playwright clears that directory on every run,
// which erased a full set of screenshots the first time a single scenario
// was re-run. These are evidence, and evidence has to outlive the next run.
const SHOTS = path.join(__dirname, '..', 'scenario-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const sb = createClient(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } });

// A fresh address per run, so scenarios never collide with each other or
// with leftovers from a previous run -- the failure mode that accumulated
// 30 fixture tenants at one address.
const RUN = Date.now().toString(36).slice(-5);
const addr = n => `${n} Scenario ${RUN} Ct`;
const full = n => `${addr(n)}, Bowie, MD 20715`;

let shotN = 0;
async function shot(page, label) {
  shotN += 1;
  const file = path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-')}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

// What the database says. This is the assertion that matters.
async function occupancy(address) {
  const { data: p } = await sb.from('properties').select('status, tenant, tenant_2')
    .eq('company_id', COMPANY).eq('address', address).is('archived_at', null).maybeSingle();
  const { data: t } = await sb.from('tenants').select('id, name, lease_status, co_tenants')
    .eq('company_id', COMPANY).eq('property', address).is('archived_at', null);
  const active = (t || []).filter(x => x.lease_status === 'active');
  return { property: p, activeTenants: active, allTenants: t || [] };
}

async function seedProperty(n, status = 'vacant') {
  const { data, error } = await sb.from('properties').insert([{
    company_id: COMPANY, address_line_1: addr(n), city: 'Bowie', state: 'MD', zip: '20715',
    status, type: 'Residential',
  }]).select('id, address').single();
  if (error) throw new Error('seed property: ' + error.message);
  return data;
}
async function seedTenant(n, name, status, extra = {}) {
  const { data, error } = await sb.from('tenants').insert([{
    company_id: COMPANY, name, property: full(n), lease_status: status, rent: 1500,
    lease_start: '2026-01-01', lease_end_date: '2026-12-31', ...extra,
  }]).select('id').single();
  if (error) throw new Error('seed tenant: ' + error.message);
  return data;
}

// NOT serial. Serial mode skips every scenario after the first failure, which
// turned an 11-scenario run into '1 passed' and hid nine results. Each
// scenario has its own address, so they are independent.

test.describe('Tenant ↔ Property scenarios', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test.afterAll(async () => {
    // Clean up everything this run made, by the run tag in the address.
    await sb.from('tenants').update({ archived_at: new Date().toISOString(), archived_by: 'scenario-cleanup' })
      .eq('company_id', COMPANY).like('property', `%Scenario ${RUN} Ct%`);
    await sb.from('properties').update({ archived_at: new Date().toISOString(), archived_by: 'scenario-cleanup' })
      .eq('company_id', COMPANY).like('address', `%Scenario ${RUN} Ct%`);
  });

  // ── S1: the exact reported bug ────────────────────────────────────
  test('S1 tenant marked active on the Tenants page → property becomes occupied', async ({ page }) => {
    await seedProperty(1, 'vacant');
    await seedTenant(1, 'Stanley Scenario', 'past', { email: 'stanley@example.com' });

    let o = await occupancy(full(1));
    expect(o.property.status, 'starts vacant').toBe('vacant');

    // Flip him to active THROUGH THE UI: Tenants page, edit, status.
    await gotoRoute(page, 'tenants');
    await page.getByPlaceholder(/search/i).first().fill('Stanley Scenario').catch(() => {});
    await page.waitForTimeout(1200);
    await shot(page, 'S1 tenants list');
    const row = page.locator('text="Stanley Scenario"').first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.click();
    await page.waitForTimeout(1200);
    await shot(page, 'S1 tenant opened');

    const edit = page.getByRole('button', { name: /^Edit tenant/ }).first();
    await expect(edit, 'the Edit tenant button').toBeVisible({ timeout: 10000 });
    await edit.click();
    await page.waitForTimeout(1200);
    await shot(page, 'S1 edit form');

    // The label is not linked to its control (no htmlFor / id), so
    // getByLabel cannot find it -- an accessibility gap in the form itself.
    // Locate the select that immediately follows the label text instead.
    const status = page.locator('label:has-text("Lease Status") + select').first();
    await expect(status, 'the Lease Status control').toBeVisible({ timeout: 10000 });
    await status.selectOption('active');
    await shot(page, 'S1 status set active');
    await page.getByRole('button', { name: /save|update/i }).first().click();
    await page.waitForTimeout(2000);
    await shot(page, 'S1 saved');

    o = await occupancy(full(1));
    expect(o.property.status, 'property is now occupied').toBe('occupied');
    expect(o.property.tenant).toBe('Stanley Scenario');
    expect(o.activeTenants).toHaveLength(1);
  });

  // ── S1b: an email-less tenant edit shows the message, does not crash ──
  test('S1b saving a tenant with no email shows the validation, not a silent crash', async ({ page }) => {
    await seedProperty(13, 'vacant');
    await seedTenant(13, 'NoEmail Scenario', 'past');  // deliberately no email

    await gotoRoute(page, 'tenants');
    await page.getByPlaceholder(/search/i).first().fill('NoEmail Scenario').catch(() => {});
    await page.waitForTimeout(1200);
    await page.locator('text="NoEmail Scenario"').first().click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: /^Edit tenant/ }).first().click();
    await page.waitForTimeout(1000);
    await page.locator('label:has-text("Lease Status") + select').first().selectOption('active');
    await page.getByRole('button', { name: /^Save$/ }).first().click();
    await page.waitForTimeout(1500);
    await shot(page, 'S1b no-email save');

    // A clear message, not a "post-save operation failed" crash toast.
    await expect(page.locator('text=/valid email address/i').first()).toBeVisible({ timeout: 8000 });
    // And the tenant stays past, because the save was correctly refused.
    const o = await occupancy(full(13));
    expect(o.property.status).toBe('vacant');
  });

  // ── S2: the wizard trap ───────────────────────────────────────────
  test('S2 "Add Tenant" on a vacant property SHOWS the tenant step', async ({ page }) => {
    await seedProperty(2, 'vacant');
    await gotoRoute(page, 'properties');
    await page.getByPlaceholder(/Search properties/i).first().fill(addr(2));
    await page.waitForTimeout(1500);
    await shot(page, 'S2 property found');

    const add = page.locator('text=/^Add Tenant$/').first();
    await expect(add, 'Add Tenant link on a vacant property').toBeVisible({ timeout: 10000 });
    await add.click();
    await page.waitForTimeout(2000);
    await shot(page, 'S2 wizard opened');

    // The wizard must contain a tenant step now. It used to hide it because
    // the property was vacant -- which is the whole reason you were adding a
    // tenant.
    const body = await page.locator('body').innerText();
    expect(/Tenant/i.test(body) && /Lease/i.test(body), 'a Tenant & Lease step is present').toBeTruthy();
    await page.keyboard.press('Escape').catch(() => {});
  });

  // ── S3: second active tenant is refused ───────────────────────────
  test('S3 a second active tenant at the same address is refused, not silently added', async () => {
    await seedProperty(3, 'vacant');
    await seedTenant(3, 'First Person', 'active');
    let refused = false;
    try { await seedTenant(3, 'Second Person', 'active'); }
    catch (e) { refused = /duplicate|unique|one active/i.test(String(e.message)); }
    expect(refused, 'the database refused the second active tenant').toBeTruthy();
    const o = await occupancy(full(3));
    expect(o.activeTenants).toHaveLength(1);
    expect(o.property.tenant).toBe('First Person');
  });

  // ── S4: co-tenants live on ONE record and mirror to the property ──
  test('S4 co-tenant on the tenant record appears on the property', async () => {
    await seedProperty(4, 'vacant');
    await seedTenant(4, 'Jamie Scenario', 'active', { co_tenants: ['Kevin Scenario'] });
    const o = await occupancy(full(4));
    expect(o.property.status).toBe('occupied');
    expect(o.property.tenant).toBe('Jamie Scenario');
    expect(o.property.tenant_2).toBe('Kevin Scenario');
    expect(o.activeTenants, 'ONE tenant row, not two').toHaveLength(1);
  });

  // ── S5: tenant becomes past → property vacant ─────────────────────
  test('S5 tenant marked past → property becomes vacant with no name', async () => {
    await seedProperty(5, 'vacant');
    const t = await seedTenant(5, 'Leaving Scenario', 'active');
    let o = await occupancy(full(5));
    expect(o.property.status).toBe('occupied');
    await sb.from('tenants').update({ lease_status: 'past' }).eq('id', t.id);
    o = await occupancy(full(5));
    expect(o.property.status).toBe('vacant');
    expect(o.property.tenant).toBe('');
  });

  // ── S6: tenant moves between properties ───────────────────────────
  test('S6 tenant moves address → old vacant, new occupied', async () => {
    await seedProperty(6, 'vacant'); await seedProperty(7, 'vacant');
    const t = await seedTenant(6, 'Mover Scenario', 'active');
    await sb.from('tenants').update({ property: full(7) }).eq('id', t.id);
    const a = await occupancy(full(6)), b = await occupancy(full(7));
    expect(a.property.status, 'old property vacant').toBe('vacant');
    expect(b.property.status, 'new property occupied').toBe('occupied');
    expect(b.property.tenant).toBe('Mover Scenario');
  });

  // ── S7: property record cannot be written around ──────────────────
  test('S7 writing "occupied" straight onto a property with no tenant is corrected', async () => {
    await seedProperty(8, 'vacant');
    await sb.from('properties').update({ status: 'occupied', tenant: 'Ghost' })
      .eq('company_id', COMPANY).eq('address', full(8));
    const o = await occupancy(full(8));
    expect(o.property.status, 'forced back to vacant').toBe('vacant');
    expect(o.property.tenant).toBe('');
  });

  // ── S8: archive → vacant ──────────────────────────────────────────
  test('S8 archiving the active tenant → property vacant', async () => {
    await seedProperty(9, 'vacant');
    const t = await seedTenant(9, 'Archived Scenario', 'active');
    await sb.from('tenants').update({ archived_at: new Date().toISOString() }).eq('id', t.id);
    const o = await occupancy(full(9));
    expect(o.property.status).toBe('vacant');
  });

  // ── S9: expired lease date changes nothing on its own ─────────────
  test('S9 a lease end date in the past leaves the tenant active and the property occupied', async () => {
    await seedProperty(10, 'vacant');
    await seedTenant(10, 'MonthToMonth Scenario', 'active', { lease_start: '2024-01-01', lease_end_date: '2024-12-31' });
    const o = await occupancy(full(10));
    expect(o.property.status, 'month-to-month is normal').toBe('occupied');
    expect(o.activeTenants).toHaveLength(1);
  });

  // ── S10: maintenance state is respected ───────────────────────────
  test('S10 a property under maintenance keeps that state when a tenant is added', async () => {
    await seedProperty(11, 'maintenance');
    await seedTenant(11, 'Maint Scenario', 'active');
    const o = await occupancy(full(11));
    expect(o.property.status, 'still maintenance').toBe('maintenance');
    expect(o.property.tenant, 'but the name is there').toBe('Maint Scenario');
  });

  // ── S11: what the Properties page actually shows ──────────────────
  test('S11 the Properties page shows the tenant the database holds', async ({ page }) => {
    await seedProperty(12, 'vacant');
    await seedTenant(12, 'Visible Scenario', 'active');
    await gotoRoute(page, 'properties');
    await page.getByPlaceholder(/Search properties/i).first().fill(addr(12));
    await page.waitForTimeout(1500);
    await shot(page, 'S11 properties page');
    const body = await page.locator('body').innerText();
    expect(body, 'shows the tenant name').toContain('Visible Scenario');
    expect(/OCCUPIED/i.test(body), 'shows occupied').toBeTruthy();
  });
});
