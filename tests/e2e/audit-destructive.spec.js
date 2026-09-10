// Destructive actions, audited against throwaway rows.
//
//   cd tests && APP_URL=http://localhost:3000 npx playwright test \
//     e2e/audit-destructive.spec.js --project=chromium-desktop --no-deps
//
// Every previous audit RECORDED these and never pressed them, because
// firing Delete or Archive at live rows wrecks the data mid-run. So this
// creates its own row, acts on it, and asserts the row actually changed
// state in the database -- not merely that the click threw nothing.
//
// Three things each action must do:
//   1. ask first (a destructive click with no confirmation is a finding)
//   2. actually do it (the row's state changes)
//   3. leave the rest alone (neighbouring rows untouched)
const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
require('../sandbox-env');

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(15 * 60 * 1000);

const CID = 'e2e-sandbox';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const findings = [];

async function login(page) {
  await page.goto('/', { timeout: 40000 });
  const si = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await si.isVisible({ timeout: 6000 }).catch(() => false)) await si.click();
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.fill('input[type="email"]', process.env.TEST_EMAIL);
  await page.fill('input[type="password"]', process.env.TEST_PASSWORD);
  await page.locator('button:has-text("Sign In")').last().click();
  await expect(page.locator('h2:has-text("Your Companies")').first()).toBeVisible({ timeout: 40000 });
  await page.locator('.font-semibold.truncate:has-text("E2E Sandbox")').first().click({ force: true });
  await expect(page.locator('h2:visible:has-text("Dashboard")').first()).toBeVisible({ timeout: 60000 });
}

// A destructive audit that damages real rows is worse than no audit. So
// take a baseline first and compare, rather than counting totals -- the
// first version of this guard flagged 8 tenants the IMPORT had archived
// hours earlier, correctly, as "not a tenant".
const baseline = {};
test.beforeAll(async () => {
  for (const table of ['vendors', 'tenants']) {
    const { data } = await sb.from(table).select('id')
      .eq('company_id', CID).not('archived_at', 'is', null);
    baseline[table] = new Set((data || []).map(r => String(r.id)));
  }
});

test.afterAll(async () => {
  for (const table of ['vendors', 'tenants']) {
    const { data } = await sb.from(table).select('id, name')
      .eq('company_id', CID).not('archived_at', 'is', null);
    const newlyArchived = (data || []).filter(r =>
      !baseline[table].has(String(r.id)) && !String(r.name || '').startsWith('ZZ-AUDIT'));
    if (newlyArchived.length) {
      findings.push(`SAFETY: this run archived ${newlyArchived.length} ${table} row(s) outside its own fixture: ` +
        newlyArchived.map(r => r.name).join(', ') + ' — restore them');
    }
  }
  // Remove anything this spec created, whatever happened.
  await sb.from('tenants').delete().eq('company_id', CID).like('name', 'ZZ-AUDIT%');
  await sb.from('vendors').delete().eq('company_id', CID).like('name', 'ZZ-AUDIT%');
  if (findings.length) {
    console.log('\n   FINDINGS:');
    findings.forEach(f => console.log(`     ${f}`));
  } else {
    console.log('\n   no findings — each action asked first and did what it said');
  }
});

test('archiving a tenant asks first, then archives only that tenant', async ({ page }) => {
  const name = 'ZZ-AUDIT Archive Me';
  const { data: made, error } = await sb.from('tenants').insert([{
    company_id: CID, name, property: 'ZZ-AUDIT nowhere', lease_status: 'current', balance: 0,
  }]).select().single();
  if (error) { findings.push('tenant Archive: could not create a fixture — ' + error.message); return; }

  const { count: othersBefore } = await sb.from('tenants')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', CID).is('archived_at', null);

  await login(page);
  await page.locator('button:has-text("Tenants")').first().click();
  await page.waitForTimeout(5000);
  await page.locator('input[placeholder*="Search name" i]').first().fill('ZZ-AUDIT');
  await page.waitForTimeout(2500);

  // The control is "Archive Tenant" inside the tenant panel's Actions
  // tab -- NOT on the row. Matching "Archive" loosely hit the "Archived"
  // filter tab instead, which produced three fake findings: no
  // confirmation, nothing archived, nothing left the list.
  await page.locator('[class*="cursor-pointer"]').first().click({ force: true });
  await page.waitForTimeout(2500);
  const actionsTab = page.locator('button:has-text("Actions")').first();
  if (await actionsTab.isVisible({ timeout: 5000 }).catch(() => false)) await actionsTab.click();
  await page.waitForTimeout(1200);
  const archive = page.locator('button:has-text("Archive Tenant")').first();
  if (!(await archive.isVisible({ timeout: 6000 }).catch(() => false))) {
    findings.push('tenant Archive: no "Archive Tenant" action in the tenant panel');
    return;
  }
  await archive.click();
  await page.waitForTimeout(900);

  // 1. It must ask.
  const asked = await page.locator('text=/are you sure|confirm|cannot be undone|archive this/i').first()
    .isVisible().catch(() => false);
  if (!asked) findings.push('tenant Archive: archived without asking for confirmation');

  const yes = page.locator('button:has-text("Archive Tenant"), button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Delete")').last();
  if (await yes.isVisible({ timeout: 2000 }).catch(() => false)) await yes.click();
  await page.waitForTimeout(3500);

  // 2. It must actually archive.
  const { data: after } = await sb.from('tenants').select('archived_at').eq('id', made.id).maybeSingle();
  if (!after?.archived_at) findings.push('tenant Archive: confirmed, but the row is still not archived');

  // 3. It must not touch anything else.
  const { count: othersAfter } = await sb.from('tenants')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', CID).is('archived_at', null);
  if (othersBefore - othersAfter !== 1) {
    findings.push(`tenant Archive: expected exactly 1 tenant to leave the active list, ${othersBefore - othersAfter} did`);
  }
  expect(findings.filter(f => f.startsWith('tenant Archive'))).toEqual([]);
});

test('deleting a vendor asks first, then removes only that vendor', async ({ page }) => {
  const name = 'ZZ-AUDIT Vendor';
  const { data: made, error } = await sb.from('vendors').insert([{ company_id: CID, name }]).select().single();
  if (error) { findings.push('vendor Delete: could not create a fixture — ' + error.message); return; }
  const { count: before } = await sb.from('vendors').select('id', { count: 'exact', head: true }).eq('company_id', CID);

  await login(page);
  await page.locator('button:has-text("Vendors")').first().click();
  await page.waitForTimeout(5000);

  // Scope the Delete to the row holding OUR vendor. Taking .first()
  // clicked whatever sat at the top of the list and confirmed it -- that
  // archived five real sandbox vendors across repeated runs before I
  // noticed. A destructive audit must only ever touch its own fixture.
  const row = page.locator(`tr:has-text("${name}"), div:has-text("${name}")`)
    .filter({ has: page.locator('button:has-text("Delete")') }).last();
  if (!(await row.isVisible({ timeout: 8000 }).catch(() => false))) {
    findings.push('vendor Delete: the vendor just created is not visible with a Delete control');
    return;
  }
  const del = row.locator('button:has-text("Delete")').first();
  if (!(await del.isVisible({ timeout: 4000 }).catch(() => false))) {
    findings.push('vendor Delete: no delete control on that vendor row');
    return;
  }
  await del.click();
  await page.waitForTimeout(900);
  const asked = await page.locator('text=/are you sure|confirm|cannot be undone|delete this/i').first()
    .isVisible().catch(() => false);
  if (!asked) findings.push('vendor Delete: deleted without asking for confirmation');
  const yes = page.locator('button:has-text("Delete"), button:has-text("Confirm"), button:has-text("Yes")').last();
  if (await yes.isVisible({ timeout: 2000 }).catch(() => false)) await yes.click();
  await page.waitForTimeout(3500);

  const { data: still } = await sb.from('vendors').select('id, archived_at').eq('id', made.id).maybeSingle();
  const goneOrArchived = !still || !!still.archived_at;
  if (!goneOrArchived) findings.push('vendor Delete: confirmed, but the vendor is still there and not archived');
  const { count: after } = await sb.from('vendors').select('id', { count: 'exact', head: true }).eq('company_id', CID);
  if (still && before - after > 1) findings.push(`vendor Delete: removed ${before - after} vendors, expected at most 1`);
  expect(findings.filter(f => f.startsWith('vendor Delete'))).toEqual([]);
});
