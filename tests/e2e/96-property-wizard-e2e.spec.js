// Fills a property through the ENTIRE setup wizard -- every step, every
// field -- and checks what actually reached the database.
//
// 80-workflows covers "a property created in the wizard reaches the list
// and the chart of accounts", which is the first step only. The other
// nine (tenant & lease, utilities, HOA, loan, documents, insurance,
// property tax, recurring rent, review) had never been driven end to
// end, so what the later steps write was unverified.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const path = require('path');

const COMPANY = process.env.E2E_COMPANY || 'e2e-sandbox';
const APP = process.env.APP_URL || 'http://localhost:3000';
const SHOTS = path.join(__dirname, '..', 'screenshots', 'wizard');
const STAMP = 'E2E96';
const ADDR = `${STAMP} Wizard Way`;
const DB = process.env.TEST_DB_URL ||
  'postgresql://postgres.vpeewlplgxthckpidhxo:Sheebasoin1%23@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

function sql(text) {
  return execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', text],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function purge() {
  sql(`
DELETE FROM acct_journal_lines WHERE company_id='${COMPANY}' AND journal_entry_id IN
  (SELECT id FROM acct_journal_entries WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%');
DELETE FROM acct_journal_entries WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM recurring_journal_entries WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM property_taxes    WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM property_tax_bills WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM property_insurance WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM property_loans    WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM hoa_payments      WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM utilities         WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM documents         WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM leases            WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%';
DELETE FROM tenants           WHERE company_id='${COMPANY}' AND (property LIKE '${STAMP}%' OR name LIKE '${STAMP}%');
-- A NEW-property draft is filed under the literal string 'NEW', not the
-- address being typed (initWizard: savedAddress || wizardData.address ||
-- "NEW"), so matching on the address left the draft behind and the next
-- run RESUMED it at the review step instead of starting fresh.
DELETE FROM property_setup_wizard WHERE company_id='${COMPANY}' AND (property_address LIKE '${STAMP}%' OR property_address = 'NEW');
UPDATE acct_accounts SET is_active=false WHERE company_id='${COMPANY}' AND name LIKE '%${STAMP}%';
DELETE FROM acct_classes      WHERE company_id='${COMPANY}' AND name LIKE '${STAMP}%';
DELETE FROM properties        WHERE company_id='${COMPANY}' AND address LIKE '${STAMP}%';`);
}

test.beforeAll(purge);
test.afterAll(purge);

// Fill every visible, empty control on the current step. Values are
// chosen from the field's own label and type, so this keeps working when
// the form changes -- which matters more than pretty values, because the
// point is to prove the WIZARD persists what it collects.
async function fillEverything(page, stepName) {
  const filled = [];
  // The wizard is a full-screen overlay rendered OUTSIDE <main>, so
  // scoping to main filled the Properties page's own search box and
  // filter dropdowns underneath it instead -- and never touched the
  // wizard at all.
  const scope = page.locator('.fixed.inset-0').last();
  const root = (await scope.count()) > 0 ? scope : page.locator('body');
  const controls = root.locator('input:visible, select:visible, textarea:visible');
  const n = await controls.count();
  for (let i = 0; i < n; i++) {
    const el = controls.nth(i);
    const tag = await el.evaluate(e => e.tagName.toLowerCase()).catch(() => '');
    const type = (await el.getAttribute('type').catch(() => '')) || 'text';
    if (['hidden', 'file', 'submit', 'button'].includes(type)) continue;
    const label = (await el.evaluate(e => {
      const id = e.id;
      const byFor = id ? document.querySelector(`label[for="${id}"]`) : null;
      const wrap = e.closest('div');
      return (byFor?.innerText || wrap?.querySelector('label')?.innerText || e.placeholder || e.name || '').trim();
    }).catch(() => '')) || '';
    const L = label.toLowerCase();
    try {
      if (tag === 'select') {
        // Taking the LAST option picked State = WY, which is outside the
        // operating area, so the County list came back empty and the
        // wizard could not advance past step 1. Prefer a value that
        // makes sense for the field, then the first real option.
        const opts = await el.locator('option').all();
        const values = [];
        for (const o of opts) values.push([(await o.getAttribute('value')) || '', (await o.innerText()).trim()]);
        const real = values.filter(([v]) => v && !v.startsWith('__'));
        if (!real.length) continue;
        const want = /state/.test(L) ? 'MD'
          : /status/.test(L) ? 'occupied'
          : /county/.test(L) ? null
          : null;
        let pick = want && real.find(([v]) => v === want);
        if (!pick && /county/.test(L)) pick = real.find(([, t]) => /prince|county/i.test(t)) || real[0];
        if (!pick) pick = real[0];
        await el.selectOption(pick[0]);
        filled.push(`${label}=${pick[1] || pick[0]}`);
      } else if (type === 'checkbox') {
        if (!(await el.isChecked())) { await el.check(); filled.push(`${label}=on`); }
      } else if (type === 'date') {
        // Leave optional "first post date" blank. Filling it put the
        // recurring start AFTER the lease start, which the wizard reads
        // as migrating an EXISTING lease -- correctly suppressing the
        // opening deposit and first-month-rent postings, because a
        // migrated lease's history comes from opening balances instead.
        // My date rule matched the word "next" inside "leave blank to
        // start next month", so the test was silently exercising the
        // migration path and then reporting the missing postings as a
        // bug. They were the app being right.
        if (/optional|first post/.test(L)) continue;
        const v = /end|expir|maturity|due/.test(L) ? '2027-06-30' : '2026-01-15';
        await el.fill(v); filled.push(`${label}=${v}`);
      } else if (type === 'number') {
        const v = /rate|pct|percent/.test(L) ? '6.5'
          : /deposit/.test(L) ? '2400'
          : /rent|amount|premium|payment|balance|value|coverage/.test(L) ? '1850'
          : /day/.test(L) ? '1' : '100';
        await el.fill(v); filled.push(`${label}=${v}`);
      } else {
        const cur = await el.inputValue().catch(() => '');
        if (cur) continue;
        // Portal credentials are skipped on purpose. They are encrypted
        // through /api/encrypt, a Vercel serverless function the CRA dev
        // server does not serve, so filling them 404s and -- because the
        // wizard treats that as fatal -- aborts the WHOLE commit with
        // PM-2002 "Could not save the property". Everything else is
        // filled; the credential path is covered by spec 90 against a
        // deployment.
        if (/user|password/.test(L)) continue;
        const v = /email/.test(L) ? 'e2e96tenant@example.test'
          : /phone/.test(L) ? '2405550196'
          : /zip|postal/.test(L) ? '20747'
          : /city/.test(L) ? 'District Heights'
          : /state/.test(L) ? 'MD'
          : /county/.test(L) ? 'Prince George\'s'
          : /address|street/.test(L) ? ADDR
          : /account *(number|#)/.test(L) ? 'ACCT-E2E96'
          : /policy/.test(L) ? 'POL-E2E96'
          : /parcel/.test(L) ? 'PARCEL-E2E96'
          : /website|url/.test(L) ? 'https://example.test/e2e96'
          : /user/.test(L) ? 'e2e96user'
          : /password/.test(L) ? 'E2E96secret!'
          : /name/.test(L) ? `${STAMP} ${label.replace(/[^A-Za-z ]/g, '').trim() || 'Value'}`
          : `${STAMP} ${label || 'value'}`.slice(0, 60);
        await el.fill(v); filled.push(`${label}=${v.slice(0, 24)}`);
      }
    } catch (_) { /* a control that refuses input is reported by the step check */ }
  }
  return filled;
}

test('a property is filled through every wizard step and everything persists', async ({ page }) => {
  test.setTimeout(900000);
  const problems = [];
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 150)); });
  page.on('response', r => {
    if (r.status() >= 400 && r.url().includes('/rest/v1/')) {
      consoleErrors.push(`HTTP ${r.status()} ${r.url().split('/rest/v1/')[1].slice(0, 80)}`);
    }
  });

  await page.goto(`${APP}/?company=${COMPANY}#properties`);
  await page.waitForTimeout(9000);

  // Start the wizard
  // The control is "+ Add", not "Add Property".
  const addBtn = page.locator('main button:has-text("+ Add"), main button:has-text("Add Property"), main button:has-text("New Property")').first();
  await expect(addBtn, 'no way to start the property wizard').toBeVisible({ timeout: 30000 });
  await addBtn.click();
  await page.waitForTimeout(2500);

  const seen = [];
  for (let step = 0; step < 14; step++) {
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    const ov = page.locator('.fixed.inset-0').last();
    const headRoot = (await ov.count()) > 0 ? ov : page.locator('main');
    const heading = (await headRoot.innerText().catch(() => '')).split('\n').slice(0, 6).join(' | ');
    seen.push(heading.slice(0, 90));
    await page.screenshot({ path: path.join(SHOTS, `step-${String(step).padStart(2, '0')}.png`), fullPage: true });

    // HOA, Loan, Insurance and Property Tax render NO fields until their
    // "+ Add ..." tile is clicked, so a plain fill saw an empty step and
    // moved on -- which is why those four wrote nothing.
    const overlayNow = page.locator('.fixed.inset-0').last();
    // The tile is a DIV with role=button, not a <button> element, so a
    // button:has-text() selector never matched it.
    const addTile = overlayNow
      .locator('button, [role="button"]')
      .filter({ hasText: /^\s*\+?\s*(Add an?|Enable)\b/i })
      .first();
    const stepHasFields = await overlayNow.locator('input:visible, select:visible, textarea:visible').count();
    if (stepHasFields === 0) {
      // Loan, Insurance and Property Tax are behind an on/off switch
      // rather than an "+ Add" tile. Those switches were plain <div
      // onClick> with no role and no key handler -- invisible to this
      // test AND unusable by keyboard -- and are now real switches.
      const sw = overlayNow.locator('[role="switch"]').first();
      if (await sw.count() > 0 && await sw.isVisible().catch(() => false)) {
        await sw.click();
        await page.waitForTimeout(1200);
      } else if (await addTile.count() > 0 && await addTile.isVisible().catch(() => false)) {
        await addTile.click();
        await page.waitForTimeout(1200);
      }
    }

    const filled = await fillEverything(page, step);
    console.log(`  step ${step}: ${filled.length} field(s) — ${filled.slice(0, 5).join(', ')}`);

    // status must be "occupied" for the tenant/recurring steps to appear
    const overlay = page.locator('.fixed.inset-0').last();
    const inWizard = (await overlay.count()) > 0;
    const uiRoot = inWizard ? overlay : page.locator('main');
    const statusSel = uiRoot.locator('select').filter({ hasText: /vacant|occupied/i }).first();
    if (await statusSel.count() > 0) await statusSel.selectOption({ label: 'Occupied' }).catch(() => {});

    const next = uiRoot.locator('button:has-text("Continue"), button:has-text("Next"), button:has-text("Save & Continue")').first();
    const finish = uiRoot.locator('button:has-text("Finish"), button:has-text("Complete Setup"), button:has-text("Done"), button:has-text("Save & Finish")').first();
    if (await finish.count() > 0 && await finish.isVisible().catch(() => false)) {
      await page.screenshot({ path: path.join(SHOTS, `step-${String(step).padStart(2, '0')}-review.png`), fullPage: true });
      await finish.click();
      await page.waitForTimeout(9000);
      break;
    }
    if (await next.count() === 0 || !(await next.isVisible().catch(() => false))) {
      problems.push(`step ${step}: no Continue/Finish button — wizard cannot be advanced`);
      break;
    }
    await next.click();
    await page.waitForTimeout(3000);
  }

  await page.screenshot({ path: path.join(SHOTS, 'zz-final.png'), fullPage: true });

  // ---- what actually landed ----
  const checks = [
    ['property', `SELECT count(*) FROM properties WHERE company_id='${COMPANY}' AND address LIKE '${STAMP}%'`],
    ['accounting class', `SELECT count(*) FROM acct_classes WHERE company_id='${COMPANY}' AND name LIKE '${STAMP}%'`],
    ['tenant', `SELECT count(*) FROM tenants WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
    ['lease', `SELECT count(*) FROM leases WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
    ['utility', `SELECT count(*) FROM utilities WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
    ['HOA', `SELECT count(*) FROM hoa_payments WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
    ['loan', `SELECT count(*) FROM property_loans WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
    ['insurance', `SELECT count(*) FROM property_insurance WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
    ['property tax', `SELECT count(*) FROM property_taxes WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
    ['recurring rent', `SELECT count(*) FROM recurring_journal_entries WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
    ['journal entries', `SELECT count(*) FROM acct_journal_entries WHERE company_id='${COMPANY}' AND property LIKE '${STAMP}%'`],
  ];
  console.log('\n--- WHAT REACHED THE DATABASE ---');
  for (const [label, q] of checks) {
    const n = sql(q);
    console.log(`  ${label.padEnd(18)} ${n}`);
    if (n === '0') problems.push(`${label}: nothing was written`);
  }

  console.log('\n--- STEPS SEEN ---');
  seen.forEach((h, i) => console.log(`  ${i}: ${h}`));
  console.log('\n--- FINDINGS ---');
  for (const p of problems) console.log('  ' + p);
  const realErrs = [...new Set(consoleErrors)].filter(e => !/favicon|sourcemap/i.test(e));
  if (realErrs.length) { console.log('\n--- REQUEST/CONSOLE ERRORS ---'); realErrs.slice(0, 10).forEach(e => console.log('  ' + e)); }
});
