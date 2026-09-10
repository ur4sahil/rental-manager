// Deep functional audit: every visible button on every route is clicked,
// and the app must visibly respond.
//
//   cd tests && APP_URL=http://localhost:3000 npx playwright test \
//     e2e/audit-dead-clicks.spec.js --project=chromium-desktop --no-deps
//
// This exists because two previous "functional audits" asserted only
// that nothing threw. Renew Lease threw nothing -- it set a piece of
// state that no visible panel was rendering, so the click did nothing at
// all and the audit passed it. So did Edit Tenant opening underneath a
// fixed panel, and Move-Out navigating away to fail elsewhere.
//
// The rule here: capture the page, click, capture again. If nothing
// changed -- no text, no dialog, no navigation, no new element -- that is
// a DEAD CLICK and a finding.
//
// Destructive labels are listed but not pressed; they need their own
// fixtures rather than being fired at live rows.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(30 * 60 * 1000);

const COMPANY = 'E2E Sandbox';
const OUT = '/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/audit-findings.json';

// Pressing these would destroy or send things. Recorded as unaudited.
const DESTRUCTIVE = /delete|remove|archive|deactivate|void|reverse|discard|log ?out|sign ?out|send|invite|email|post all|apply late fee|permanent|reset|cancel subscription|unassign|evict/i;
// These legitimately leave the page, so a "no change" verdict is meaningless.
const NAVIGATES = /^(dashboard|properties|tenants|payments|accounting|owners|messages|vendors|maintenance|inspections|utilities|hoa|loans|insurance|tax bills|notifications|document builder|tasks)/i;

const ROUTES = [
  ['dashboard', 'Dashboard'], ['properties', 'Properties'], ['tenants', 'Tenants'],
  ['payments', 'Payments'], ['maintenance', 'Maintenance'], ['utilities', 'Utilities'],
  ['hoa', 'HOA Payments'], ['loans', 'Loans'], ['insurance', 'Insurance'],
  ['tax_bills', 'Tax Bills'], ['owners', 'Owners'], ['vendors', 'Vendors'],
  ['inspections', 'Inspections'], ['messages', 'Messages'],
  ['documents', 'Documents'], ['doc_builder', 'Document Builder'],
  ['accounting', 'Accounting'], ['notifications', 'Notifications'],
];

async function signature(page) {
  return await page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    return JSON.stringify({
      len: t.length,
      head: t.slice(0, 400),
      hash: t.length + ':' + t.slice(-200),
      hash2: location.hash,
      els: document.querySelectorAll('*').length,
      inputs: document.querySelectorAll('input,select,textarea').length,
      fixed: document.querySelectorAll('.fixed, [role="dialog"]').length,
    });
  });
}

test('every button on every page does something', async ({ page }) => {
  const findings = [];
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e.message)));

  await page.goto('/', { timeout: 40000 });
  const si = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await si.isVisible({ timeout: 6000 }).catch(() => false)) await si.click();
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.fill('input[type="email"]', process.env.TEST_EMAIL);
  await page.fill('input[type="password"]', process.env.TEST_PASSWORD);
  await page.locator('button:has-text("Sign In")').last().click();
  await expect(page.locator('h2:has-text("Your Companies")').first()).toBeVisible({ timeout: 40000 });
  await page.locator(`.font-semibold.truncate:has-text("${COMPANY}")`).first().click({ force: true });
  await expect(page.locator('h2:visible:has-text("Dashboard")').first()).toBeVisible({ timeout: 60000 });

  let clicked = 0, skipped = 0;

  for (const [route, navLabel] of ROUTES) {
    // Reach the route through its own nav item, since a hash change does
    // not re-route a single-page app.
    const nav = page.locator(`button:has-text("${navLabel}")`).first();
    if (!(await nav.isVisible({ timeout: 4000 }).catch(() => false))) {
      findings.push({ route, kind: 'unreachable', detail: `no nav item "${navLabel}"` });
      continue;
    }
    await nav.click().catch(() => {});
    await page.waitForTimeout(4000);

    const before = jsErrors.length;
    const labels = await page.locator('main button:visible, button:visible').evaluateAll(
      els => els.map(e => (e.innerText || e.getAttribute('aria-label') || e.title || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
    );
    const seen = new Set();
    for (const label of labels) {
      if (seen.has(label)) continue;
      seen.add(label);
      if (DESTRUCTIVE.test(label)) { findings.push({ route, kind: 'not-audited', label, detail: 'destructive — needs its own fixture' }); skipped++; continue; }
      if (NAVIGATES.test(label)) continue;

      const btn = page.locator(`button:visible:has-text("${label.replace(/"/g, '')}")`).first();
      if (!(await btn.isVisible({ timeout: 1200 }).catch(() => false))) continue;

      const sigBefore = await signature(page);
      await btn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1100);
      const sigAfter = await signature(page);
      clicked++;

      if (sigBefore === sigAfter) {
        findings.push({ route, kind: 'DEAD CLICK', label, detail: 'clicked and nothing on the page changed' });
      }
      // Return to a known state before the next button.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(250);
      if (await page.locator('h2:has-text("Your Companies")').first().isVisible({ timeout: 600 }).catch(() => false)) {
        await page.locator(`.font-semibold.truncate:has-text("${COMPANY}")`).first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(3000);
      }
      const navBack = page.locator(`button:has-text("${navLabel}")`).first();
      if (await navBack.isVisible({ timeout: 1500 }).catch(() => false)) { await navBack.click().catch(() => {}); await page.waitForTimeout(1200); }
    }
    if (jsErrors.length > before) {
      findings.push({ route, kind: 'js-error', detail: jsErrors.slice(before).join(' | ').slice(0, 300) });
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ clicked, skipped, findings }, null, 2));
  const dead = findings.filter(f => f.kind === 'DEAD CLICK');
  const errs = findings.filter(f => f.kind === 'js-error');
  console.log(`\n   clicked ${clicked} buttons, skipped ${skipped} destructive`);
  console.log(`   DEAD CLICKS: ${dead.length}`);
  dead.slice(0, 40).forEach(f => console.log(`     [${f.route}] ${f.label}`));
  console.log(`   JS ERRORS: ${errs.length}`);
  errs.forEach(f => console.log(`     [${f.route}] ${f.detail}`));
  console.log(`   full findings: ${OUT}`);
});
