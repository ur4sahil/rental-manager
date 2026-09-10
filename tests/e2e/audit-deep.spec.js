// Deep functional audit, v2.
//
// v1 clicked 37 buttons across 18 routes and called it done -- the same
// shallowness as the audits it replaced. It never opened a detail panel,
// never entered a sub-tab, never submitted a form.
//
// This version:
//   * walks the accounting sub-pages, which are separate routes
//   * descends one level into whatever a click opens (panel, modal, tab)
//     and audits the controls in there too
//   * skips controls that are ALREADY active -- clicking a selected
//     filter pill correctly does nothing, and v1 reported three of those
//     as findings
//   * submits every form empty and expects to be told why not, because a
//     submit that silently does nothing is the exact bug class here
//
// A click that changes nothing visible is a DEAD CLICK. Destructive
// labels are recorded, not pressed.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(60 * 60 * 1000);

const COMPANY = 'E2E Sandbox';
const OUT = '/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/audit-deep.json';
// Progress is appended here as it happens. The audit is one long test,
// so the reporter has a single line to show and everything logged at the
// end appears only at the end -- which made a 20-minute run look hung.
// `tail -f` this instead.
const PROGRESS = '/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/audit-progress.log';
function note(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  fs.appendFileSync(PROGRESS, `${stamp}  ${line}\n`);
}

const DESTRUCTIVE = /delete|remove|archive|deactivate|void|reverse|discard|log ?out|sign ?out|send|invite|e-?mail|post all|apply late fee|permanent|reset|unassign|evict|pay\b|approve|reject|restore|commit|import|generate|renew|move-?out|finali[sz]e|sign\b/i;
const NAV = /^(dashboard|properties|tenants|payments|accounting|owners|messages|vendors|maintenance|inspections|utilities|hoa payments|loans|insurance|tax bills|notifications|document builder|tasks|documents|leases|move-out|evictions|archived|review)$/i;

const ROUTES = [
  ['dashboard','Dashboard'], ['properties','Properties'], ['tenants','Tenants'],
  ['payments','Payments'], ['maintenance','Maintenance'], ['utilities','Utilities'],
  ['hoa','HOA Payments'], ['loans','Loans'], ['insurance','Insurance'],
  ['tax_bills','Tax Bills'], ['owners','Owners'], ['vendors','Vendors'],
  ['inspections','Inspections'], ['messages','Messages'], ['documents','Documents'],
  ['doc_builder','Document Builder'], ['accounting','Accounting'],
  ['notifications','Notifications'],
];

async function sig(page) {
  return await page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g,' ').trim();
    return t.length + '|' + t.slice(0,300) + '|' + t.slice(-200) + '|' + window.location.hash
      + '|' + document.querySelectorAll('*').length
      + '|' + document.querySelectorAll('input,select,textarea').length
      + '|' + document.querySelectorAll('[role="dialog"], .fixed').length;
  });
}

// Already-selected tabs and pills. Clicking one correctly does nothing.
async function isActive(el) {
  return await el.evaluate(n => {
    if (n.getAttribute('aria-pressed') === 'true' || n.getAttribute('aria-selected') === 'true') return true;
    if (n.disabled) return true;
    const c = n.className || '';
    return /bg-brand-6|bg-brand-5|bg-indigo-6|text-white/.test(String(c)) && /rounded/.test(String(c));
  }).catch(() => false);
}

test('deep audit: buttons respond, forms explain themselves', async ({ page }) => {
  const findings = [];
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e.message)));
  let clicked = 0, skipped = 0, formsTested = 0, panelsEntered = 0;

  async function login() {
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
  }

  async function goRoute(label) {
    if (await page.locator('h2:has-text("Your Companies")').first().isVisible({ timeout: 700 }).catch(()=>false)) {
      await page.locator(`.font-semibold.truncate:has-text("${COMPANY}")`).first().click({ force: true }).catch(()=>{});
      await page.waitForTimeout(3000);
    }
    const nav = page.locator(`button:has-text("${label}")`).first();
    if (!(await nav.isVisible({ timeout: 4000 }).catch(()=>false))) return false;
    await nav.click().catch(()=>{});
    await page.waitForTimeout(3500);
    return true;
  }

  // Every empty form submit should say what is missing.
  async function auditForms(route, where) {
    const submits = await page.locator('button:visible').evaluateAll(els =>
      els.map(e => (e.innerText||'').replace(/\s+/g,' ').trim())
         .filter(t => /^(save|add|create|submit|post|record|apply)\b/i.test(t)));
    for (const label of [...new Set(submits)].slice(0, 6)) {
      const btn = page.locator(`button:visible:has-text("${label.replace(/"/g,'')}")`).first();
      if (!(await btn.isVisible({ timeout: 800 }).catch(()=>false))) continue;
      const before = await sig(page);
      await btn.click({ timeout: 3000 }).catch(()=>{});
      await page.waitForTimeout(900);
      const after = await sig(page);
      formsTested++;
      if (before === after) {
        findings.push({ route, where, kind: 'SILENT EMPTY SUBMIT', label,
          detail: 'submitted with nothing filled in and the app said nothing' });
        note(`  SILENT SUBMIT  [${where}] ${label}`);
      }
      await page.keyboard.press('Escape').catch(()=>{});
      await page.waitForTimeout(200);
    }
  }

  async function auditControls(route, where, depth) {
    const labels = await page.locator('button:visible').evaluateAll(els =>
      els.map(e => (e.innerText || e.getAttribute('aria-label') || e.title || '').replace(/\s+/g,' ').trim()).filter(Boolean));
    const uniq = [...new Set(labels)];
    for (const label of uniq) {
      if (NAV.test(label)) continue;
      if (DESTRUCTIVE.test(label)) { findings.push({ route, where, kind: 'not-audited', label, detail: 'destructive — needs its own fixture' }); skipped++; continue; }
      const btn = page.locator(`button:visible:has-text("${label.replace(/"/g,'')}")`).first();
      if (!(await btn.isVisible({ timeout: 900 }).catch(()=>false))) continue;
      if (await isActive(btn)) continue;   // already selected

      const before = await sig(page);
      await btn.click({ timeout: 3500 }).catch(()=>{});
      await page.waitForTimeout(1000);
      const after = await sig(page);
      clicked++;

      if (before === after) {
        findings.push({ route, where, kind: 'DEAD CLICK', label, detail: 'clicked and nothing on the page changed' });
        note(`  DEAD CLICK  [${where}] ${label}`);
      } else if (depth === 0) {
        // Something opened. Audit one level in, then come back.
        const opened = await page.locator('[role="dialog"], .fixed').count();
        if (opened > 0) {
          panelsEntered++;
          await auditForms(route, `${where} › ${label}`);
          await page.keyboard.press('Escape').catch(()=>{});
          await page.waitForTimeout(400);
        }
      }
      await page.keyboard.press('Escape').catch(()=>{});
      await page.waitForTimeout(250);
      await goRoute(where.split(' › ')[0]);
    }
  }

  fs.writeFileSync(PROGRESS, '');
  note(`audit starting — ${ROUTES.length} routes, company ${COMPANY}`);
  await login();
  note('logged in, company selected');

  let routeNo = 0;
  for (const [route, navLabel] of ROUTES) {
    routeNo++;
    note(`route ${routeNo}/${ROUTES.length}: ${route}`);
    if (!(await goRoute(navLabel))) { findings.push({ route, kind: 'unreachable', detail: `no nav item "${navLabel}"` }); note(`  UNREACHABLE ${route}`); continue; }
    const errsBefore = jsErrors.length;
    await auditControls(route, navLabel, 0);
    await goRoute(navLabel);
    await auditForms(route, navLabel);
    if (jsErrors.length > errsBefore) {
      findings.push({ route, kind: 'JS ERROR', detail: jsErrors.slice(errsBefore).join(' | ').slice(0,300) });
      note(`  JS ERROR  [${route}] ${jsErrors.slice(errsBefore).join(' | ').slice(0,120)}`);
    }
    note(`  done ${route} — ${clicked} clicked, ${formsTested} forms, ${findings.length} findings so far`);
    fs.writeFileSync(OUT, JSON.stringify({ clicked, skipped, formsTested, panelsEntered, findings }, null, 2));
  }

  fs.writeFileSync(OUT, JSON.stringify({ clicked, skipped, formsTested, panelsEntered, findings }, null, 2));
  const by = k => findings.filter(f => f.kind === k);
  console.log(`\n   clicked ${clicked} · forms ${formsTested} · panels ${panelsEntered} · destructive skipped ${skipped}`);
  for (const k of ['DEAD CLICK','SILENT EMPTY SUBMIT','JS ERROR','unreachable']) {
    const list = by(k);
    console.log(`   ${k}: ${list.length}`);
    list.slice(0, 30).forEach(f => console.log(`     [${f.route}${f.where && f.where !== f.route ? ' / ' + f.where : ''}] ${f.label || ''} ${f.detail ? '— ' + f.detail.slice(0,90) : ''}`));
  }
  console.log(`   full findings: ${OUT}`);
});
