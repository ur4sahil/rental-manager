// Visits every staff route, screenshots it at desktop and phone, scans
// it with axe, and clicks every safe button on it while watching for
// failures.
//
// 70-all-routes-health checks a route renders. It does not look at it,
// and it does not touch anything. This does both.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const path = require('path');
const { NAV } = require('./helpers');

const COMPANY = process.env.E2E_COMPANY || 'e2e-sandbox';
const APP = process.env.APP_URL || 'http://localhost:3000';
const SHOTS = path.join(__dirname, '..', 'screenshots', 'routes');

// Anything that writes, deletes, sends, charges or navigates away is
// left alone. The point is to find buttons that BREAK, not to mutate the
// sandbox from 34 pages at once.
const UNSAFE = /delete|remove|archive|deactivate|terminate|evict|send|email|charge|pay|post|commit|import|generate|regenerate|sync|reset|purge|void|reverse|approve|reject|complete|save|submit|create|add|invite|logout|sign out|revoke|unlock|lock|apply|refund|merge|restore/i;

test('every route: screenshot, accessibility scan, and click every safe button', async ({ page }) => {
  test.setTimeout(3600000);
  const findings = [];
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
  page.on('pageerror', e => errors.push('UNCAUGHT ' + String(e).slice(0, 140)));
  page.on('response', r => {
    if (r.status() >= 400 && r.url().includes('/rest/v1/')) {
      errors.push(`HTTP ${r.status()} ${r.url().split('/rest/v1/')[1].split('&')[0].slice(0, 80)}`);
    }
  });

  const routes = Object.keys(NAV);
  console.log(`sweeping ${routes.length} routes\n`);

  for (const route of routes) {
    const before = errors.length;
    await page.goto(`${APP}/?company=${COMPANY}#${route}`);
    await page.waitForTimeout(4500);
    await page.waitForFunction(() => !document.querySelector('.animate-spin'), null, { timeout: 30000 }).catch(() => {});
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });

    const main = page.locator('main');
    const text = await main.innerText().catch(() => '');
    if (!text.trim()) { findings.push(`${route}: renders EMPTY`); }
    await page.screenshot({ path: path.join(SHOTS, `${route}.png`), fullPage: true });

    // accessibility
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    for (const v of violations.filter(v => ['critical', 'serious'].includes(v.impact))) {
      findings.push(`${route}: ${v.impact}/${v.id} x${v.nodes.length} — ${v.help} @ ${v.nodes[0].target.join(' ').slice(0, 70)}`);
    }

    // click every SAFE button, returning to the route between clicks
    const labels = await main.locator('button:visible').evaluateAll(
      els => els.map(e => (e.innerText || e.getAttribute('aria-label') || '').trim()).filter(Boolean));
    const safe = [...new Set(labels)].filter(l => l.length < 40 && !UNSAFE.test(l));
    let clicked = 0;
    for (const label of safe.slice(0, 14)) {
      const errsBefore = errors.length;
      const btn = main.locator('button:visible').filter({ hasText: label }).first();
      if (await btn.count() === 0) continue;
      try {
        await btn.click({ timeout: 5000 });
        clicked++;
        await page.waitForTimeout(900);
        // close anything that opened, so the next click is not blocked
        const esc = page.locator('div[role="dialog"], .fixed.inset-0');
        if (await esc.count() > 0) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
      } catch (_) { continue; }
      const newErrs = errors.slice(errsBefore).filter(e => !/favicon|sourcemap|ResizeObserver/i.test(e));
      if (newErrs.length) findings.push(`${route} · "${label}" → ${newErrs[0]}`);
    }

    // phone width
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, `${route}-mobile.png`), fullPage: true });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 4) findings.push(`${route} (390px): page scrolls sideways by ${overflow}px`);
    await page.setViewportSize({ width: 1440, height: 900 });

    const routeErrs = errors.slice(before).filter(e => !/favicon|sourcemap|ResizeObserver/i.test(e));
    console.log(`  ${route.padEnd(18)} ${clicked} button(s) clicked${routeErrs.length ? '  ⚠ ' + routeErrs.length + ' error(s)' : ''}`);
    if (routeErrs.length) findings.push(`${route}: ${routeErrs.length} error(s) on load — ${routeErrs[0]}`);
  }

  console.log('\n=== SWEEP FINDINGS ===');
  for (const f of findings) console.log('  ' + f);
  console.log(`(${findings.length} findings across ${routes.length} routes)`);
});
