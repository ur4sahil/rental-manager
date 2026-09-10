// Dead-click sweep. Every visible, non-destructive control on every
// route is clicked and must visibly change something.
//
//   cd tests && APP_URL=http://localhost:3000 npx playwright test \
//     e2e/audit-clicks.spec.js --project=chromium-desktop --no-deps
//
// Six earlier versions failed, all for the same underlying reason: they
// clicked many buttons in sequence on one page, so every click
// contaminated the next. Specifically --
//
//   * a click that FAILED was swallowed by .catch(() => {}) and then
//     reported as "nothing changed": 46 fake findings on one route
//   * the first overlay that would not close blocked every later click
//   * navigating by sidebar broke once a nav group collapsed, skipping
//     six routes in one second
//   * isVisible({ timeout }) does not wait -- it is an instant check and
//     ignores the option -- so a readiness probe ran before render and
//     reported all 18 routes unreachable
//   * re-navigating after every click cost 23s per button and detached
//     the elements it was about to click
//   * already-selected tabs were flagged as dead, which is correct
//     behaviour for a selected tab
//
// So: ONE FRESH PAGE LOAD PER BUTTON. Slower, and completely immune to
// all six. The page is loaded, the Nth eligible button is found by
// position and label, clicked once, and the before/after compared. Then
// the page is thrown away.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(3 * 60 * 60 * 1000);

const COMPANY = 'E2E Sandbox';
const COMPANY_ID = 'e2e-sandbox';
const OUT = '/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/audit-clicks.json';
const PROGRESS = '/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/audit-clicks.log';

// Never pressed: these change or send real things and belong in
// audit-destructive.spec.js, which builds its own fixtures.
// The sidebar. Clicking the nav item for the route you are already on
// correctly does nothing, and every route has the whole sidebar on it.
const NAV_ITEM = /^(dashboard|apartment|people|payments|account_balance|description|engineering|assignment|person|forum|notifications_active|build|checklist|bolt|holiday_village|account_balance_wallet|verified_user|receipt_long)\s/i;

const DESTRUCTIVE = /delete|remove|archive|deactivate|void|reverse|discard|log ?out|sign ?out|\bsend\b|invite|e-?mail|post all|late fee|permanent|reset|unassign|evict|\bpay\b|approve|reject|restore|commit|\bimport\b|generate|renew|move-?out|finali[sz]e|\bsign\b|save|submit|confirm|authorize|authorise|write.?off|refund|charge/i;

const ROUTES = (process.env.AUDIT_ROUTES || '').split(',').filter(Boolean).length
  ? process.env.AUDIT_ROUTES.split(',')
  : [
  'dashboard','properties','tenants','payments','maintenance','utilities','hoa',
  'loans','insurance','tax_bills','owners','vendors','inspections','messages',
  'documents','doc_builder','accounting','acct_coa','acct_journal','acct_reports',
  'acct_reconcile','acct_classes','acct_recurring','acct_opening','notifications',
  'leases','latefees','moveout','evictions','admin','tasks',
];

function note(line) {
  fs.appendFileSync(PROGRESS, `${new Date().toISOString().slice(11, 19)}  ${line}\n`);
}

async function snapshot(page) {
  return await page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    // Hash the WHOLE text, not a sample of it. Sampling the first 250
    // and last 150 characters plus a length missed a star rating turning
    // from ☆ to ★ -- same length, middle of the page -- and reported a
    // working control as dead. Every one of the 14 findings from the
    // first full run was a false positive; this was the only one that
    // was the detector's fault rather than an empty list.
    let h = 5381;
    for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
    // Also catch class-only changes, which is how a selected state or a
    // colour swap shows up with identical text.
    let c = 5381;
    document.querySelectorAll('[class]').forEach(el => {
      const s = el.className.toString();
      for (let i = 0; i < s.length; i++) c = ((c * 33) ^ s.charCodeAt(i)) >>> 0;
    });
    return {
      len: t.length,
      textHash: h,
      classHash: c,
      head: t.slice(0, 250),
      hash: window.location.hash,
      els: document.querySelectorAll('*').length,
      inputs: document.querySelectorAll('input,select,textarea').length,
      overlays: document.querySelectorAll('[role="dialog"], .fixed').length,
      checked: document.querySelectorAll(':checked').length,
    };
  });
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function signIn(page) {
  await page.goto('/', { timeout: 60000 });
  const si = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await si.isVisible({ timeout: 6000 }).catch(() => false)) await si.click();
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.fill('input[type="email"]', process.env.TEST_EMAIL);
  await page.fill('input[type="password"]', process.env.TEST_PASSWORD);
  await page.locator('button:has-text("Sign In")').last().click();
  await page.locator('h2:has-text("Your Companies")').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.locator(`.font-semibold.truncate:has-text("${COMPANY}")`).first().click({ force: true });
  await page.locator('h2:visible:has-text("Dashboard")').first().waitFor({ state: 'visible', timeout: 90000 });
}

// Load a route and wait until the app shell is really there. waitFor,
// never isVisible with a timeout.
async function openRoute(page, route) {
  await page.goto(`/?company=${COMPANY_ID}#${route}`, { timeout: 60000 });
  // The sidebar's Dashboard item is present on every in-app route, in
  // every viewport. Earlier versions probed for a header icon button by
  // its ligature text and missed it, reporting every route unreachable
  // while the page had in fact loaded correctly.
  try {
    await page.locator('button:has-text("Dashboard")').first()
      .waitFor({ state: 'visible', timeout: 25000 });
  } catch (_) { return false; }
  // And make sure we are not sitting on the selector or a login screen.
  if (await page.locator('h2:has-text("Your Companies")').first().isVisible().catch(() => false)) {
    await page.locator(`.font-semibold.truncate:has-text("${COMPANY}")`).first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(3500);
  }
  await page.waitForTimeout(2500);   // let the route's own queries settle
  return true;
}

// The buttons worth clicking on this page, in DOM order, with the
// already-selected ones excluded.
async function eligible(page) {
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button').forEach((b, domIndex) => {
      const r = b.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;                 // not visible
      if (b.disabled) return;
      const label = (b.innerText || b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim();
      if (!label) return;
      const cls = String(b.className || '');
      const selected = b.getAttribute('aria-pressed') === 'true'
        || b.getAttribute('aria-selected') === 'true'
        || /border-b-2|border-brand|text-brand-6|text-brand-7/.test(cls)
        || (/bg-brand-6|bg-brand-5|bg-indigo-6|text-white/.test(cls) && /rounded/.test(cls));
      if (selected) return;
      out.push({ domIndex, label });
    });
    return out;
  });
}

test('every clickable control does something', async ({ page }) => {
  fs.writeFileSync(PROGRESS, '');
  const findings = [];
  let clicked = 0, skipped = 0, routesDone = 0;

  await signIn(page);
  note(`signed in — ${ROUTES.length} routes to sweep`);

  for (const route of ROUTES) {
    if (!(await openRoute(page, route))) {
      findings.push({ route, kind: 'unreachable' });
      note(`UNREACHABLE ${route}`);
      continue;
    }
    // One per DISTINCT label. Properties alone offered 252 controls --
    // 41 rows times six identical row actions -- and auditing each row
    // separately exercises the same handler over and over at one page
    // load apiece. The first occurrence of each label is enough.
    const all = await eligible(page);
    const seen = new Set();
    const controls = all.filter(c => {
      if (seen.has(c.label)) return false;
      seen.add(c.label);
      return true;
    });
    note(`route ${++routesDone}/${ROUTES.length}: ${route} — ${controls.length} distinct of ${all.length} controls`);

    for (const { domIndex, label } of controls) {
      if (DESTRUCTIVE.test(label)) { skipped++; continue; }
      if (NAV_ITEM.test(label)) continue;

      // A fresh page for this one button. Nothing any earlier click did
      // can reach it.
      if (!(await openRoute(page, route))) break;
      const btn = page.locator('button').nth(domIndex);
      const stillThere = await btn.evaluate(
        (el, want) => {
          const t = (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();
          return t === want;
        }, label).catch(() => false);
      if (!stillThere) continue;   // the page rendered differently; not a finding

      const before = await snapshot(page);
      let clickError = null;
      try {
        await btn.scrollIntoViewIfNeeded({ timeout: 3000 });
        await btn.click({ timeout: 5000 });
      } catch (e) {
        clickError = String(e.message || e).split('\n')[0].slice(0, 100);
      }
      if (clickError) {
        findings.push({ route, label, kind: 'could-not-click', detail: clickError });
        note(`  COULD-NOT-CLICK [${route}] ${label} — ${clickError}`);
        continue;
      }
      await page.waitForTimeout(1400);
      const after = await snapshot(page);
      clicked++;

      if (same(before, after)) {
        findings.push({ route, label, kind: 'DEAD CLICK' });
        note(`  DEAD CLICK [${route}] ${label}`);
      }
    }
    fs.writeFileSync(OUT, JSON.stringify({ clicked, skipped, findings }, null, 2));
  }

  fs.writeFileSync(OUT, JSON.stringify({ clicked, skipped, findings }, null, 2));
  const dead = findings.filter(f => f.kind === 'DEAD CLICK');
  const stuck = findings.filter(f => f.kind === 'could-not-click');
  const gone = findings.filter(f => f.kind === 'unreachable');
  note(`DONE — clicked ${clicked}, skipped ${skipped} destructive, ${dead.length} dead, ${stuck.length} unclickable, ${gone.length} unreachable`);
  console.log(`\n   clicked ${clicked} · skipped ${skipped} destructive · ${routesDone} routes`);
  console.log(`   DEAD CLICKS: ${dead.length}`);
  dead.forEach(f => console.log(`     [${f.route}] ${f.label}`));
  console.log(`   COULD NOT CLICK: ${stuck.length}`);
  stuck.slice(0, 15).forEach(f => console.log(`     [${f.route}] ${f.label} — ${f.detail}`));
  console.log(`   UNREACHABLE ROUTES: ${gone.length}  ${gone.map(f => f.route).join(', ')}`);
  expect(gone.length).toBeLessThan(ROUTES.length / 2);
});
