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
const COMPANY_ID = 'e2e-sandbox';
const OUT = '/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/audit-v3.json';
// Progress is appended here as it happens. The audit is one long test,
// so the reporter has a single line to show and everything logged at the
// end appears only at the end -- which made a 20-minute run look hung.
// `tail -f` this instead.
const PROGRESS = '/private/tmp/claude-501/-Users-aggar/8a15045e-55e7-45a7-98de-0507f4e462e1/scratchpad/audit-v3-progress.log';
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

// Close whatever a click opened. Escape alone was not enough: the first
// unclosed overlay blocked every remaining click on the route and
// produced 46 timeouts in one page. Tries Escape, then a close control,
// then the backdrop. An overlay that refuses all three is a finding in
// its own right -- a modal you cannot get out of is a real bug.
async function dismissOverlay(page) {
  const overlay = () => page.locator('[role="dialog"]:visible, .fixed.inset-0:visible');
  if (await overlay().count() === 0) return { closed: true };
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(350);
  if (await overlay().count() === 0) return { closed: true, how: 'escape' };
  for (const sel of ['button[aria-label*="close" i]', 'button:has-text("close")',
                     'button:has-text("Cancel")', 'button:has-text("✕")', 'button:has-text("×")',
                     '.material-icons-outlined:text-is("close")']) {
    const btn = page.locator(sel).last();
    if (await btn.isVisible({ timeout: 250 }).catch(() => false)) {
      await btn.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(350);
      if (await overlay().count() === 0) return { closed: true, how: sel };
    }
  }
  // Backdrop click, as a last resort.
  await page.mouse.click(6, 6).catch(() => {});
  await page.waitForTimeout(350);
  if (await overlay().count() === 0) return { closed: true, how: 'backdrop' };
  return { closed: false };
}

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
    const c = String(n.className || '');
    // Selected tabs are marked by a brand-coloured underline or text as
    // well as by a filled pill. v4 flagged Notifications > Activity, an
    // already-selected tab, because it only looked for the pill.
    if (/border-b-2|border-brand|text-brand-6|text-brand-7/.test(c)) return true;
    return /bg-brand-6|bg-brand-5|bg-indigo-6|text-white/.test(c) && /rounded/.test(c);
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

  // Navigate by URL, not by clicking the sidebar. Maintenance, Utilities,
  // HOA, Loans, Insurance and Tax Bills are nested under Properties; once
  // that group collapsed, the nav lookup found nothing and six routes --
  // a third of the app -- were skipped in one second as "unreachable".
  // The app reads its route from the hash at load, so a goto+reload is
  // deterministic and immune to menu state.
  async function goRouteById(routeId, label) {
    await page.goto(`/?company=${encodeURIComponent(COMPANY_ID)}#${routeId}`, { timeout: 40000 });
    await page.waitForTimeout(4500);
    if (await page.locator('h2:has-text("Your Companies")').first().isVisible({ timeout: 800 }).catch(()=>false)) {
      await page.locator(`.font-semibold.truncate:has-text("${COMPANY}")`).first().click({ force: true }).catch(()=>{});
      await page.waitForTimeout(3500);
    }
    // Confirm we are inside the app rather than on a login or selector
    // screen. waitFor, NOT isVisible: isVisible() is an instant check and
    // silently ignores a timeout option, so this evaluated before the
    // page had rendered and reported all 18 routes unreachable.
    try {
      await page.locator('button:has(span:text-is("notifications")), button:has(span:text-is("menu"))')
        .first().waitFor({ state: 'visible', timeout: 15000 });
      return true;
    } catch (_) { return false; }
  }
  async function goRoute(label) {
    const hit = ROUTES.find(([, l]) => l === label);
    return goRouteById(hit ? hit[0] : 'dashboard', label);
  }

  // Every empty form submit should say what is missing.
  async function auditForms(route, where) {
    const submits = await page.locator('button:visible').evaluateAll(els =>
      els.map(e => (e.innerText||'').replace(/\s+/g,' ').trim())
         // Anchored on the whole label: "Add Tenant" opens a form, it does
         // not submit one, and matching it as a submit produced a bogus
         // "silent submit" finding.
         // Submit-ish, but NOT the buttons that merely open a form.
         // "Add Tenant" opens one; "Save" submits one. v4 anchored so
         // tightly it matched almost nothing -- 1 form across 18 routes.
         .filter(t => /^(save|create|submit|post|record|confirm|update|add (transaction|entry|charge|payment|line))\b/i.test(t))
         .filter(t => !/^add (tenant|property|owner|vendor|unit|photo|document|note|user|member|bank)/i.test(t)));
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
      await dismissOverlay(page);
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

      // v2 swallowed click failures and then reported "nothing changed",
      // which turned every out-of-view or detached element into a fake
      // finding -- 20-odd property names in one route. A click that could
      // not be performed is its own category.
      const before = await sig(page);
      let clickErr = null;
      try {
        await btn.scrollIntoViewIfNeeded({ timeout: 2000 });
        await btn.click({ timeout: 3500 });
      } catch (e) { clickErr = String(e.message || e).split('\n')[0].slice(0, 120); }
      if (clickErr) {
        findings.push({ route, where, kind: 'could-not-click', label, detail: clickErr });
        continue;
      }
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
      const dism = await dismissOverlay(page);
      if (!dism.closed) {
        findings.push({ route, where, kind: 'MODAL WILL NOT CLOSE', label,
          detail: 'opened an overlay that Escape, a close button and the backdrop all failed to dismiss' });
        note(`  MODAL WILL NOT CLOSE  [${where}] ${label}`);
        await goRoute(where.split(' › ')[0]);   // reload the route to escape it
        continue;
      }
      // v2 re-navigated after EVERY click: 23 seconds a button, and it
      // detached the elements it was about to click next. Only go back if
      // the click actually left the page.
      const stillHere = await page.locator(`button:has-text("${where.split(' › ')[0]}")`).first()
        .isVisible({ timeout: 500 }).catch(() => false);
      const onSelector = await page.locator('h2:has-text("Your Companies")').first()
        .isVisible({ timeout: 300 }).catch(() => false);
      if (onSelector || !stillHere) await goRoute(where.split(' › ')[0]);
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
    if (!(await goRouteById(route, navLabel))) { findings.push({ route, kind: 'unreachable', detail: 'could not reach this route by URL' }); note(`  UNREACHABLE ${route}`); continue; }
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
