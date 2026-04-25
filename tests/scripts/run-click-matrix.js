// ════════════════════════════════════════════════════════════════════
// Auto-runner for tests/MANUAL-CLICK-MATRIX.md
//
// Walks matrix rows whose handler matches one of the SUPPORTED patterns
// (currently `setPage("X")`), drives the click in Playwright, verifies
// the intended effect (URL hash change for setPage), and writes Status
// + Notes back into the matrix file.
//
// Why only setPage for v1: those are the surfaces with a deterministic
// post-click signal (hash). Other handlers (saveEntry, openModal, row
// edit) need modal/row state set up first, which is better handled by
// focused click-coverage specs (tests/e2e/50-66) than a generic walker.
//
// Usage:
//   cd tests
//   node seed-clicktest-data.js          # ensure CT seed exists at Smith
//   node scripts/run-click-matrix.js     # run + write back
//
// The matrix file's Status column gets ticked:
//   ✓ — clicked + handler intent observed
//   ✗ — clicked + intent NOT observed (hash didn't change to expected)
//   ?  — selector didn't resolve / page wasn't reachable
// Existing markers from prior runs are preserved by the generator's
// merge-by-file:line logic — re-running this script and then the
// generator does NOT clobber human-set values for non-supported rows.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MATRIX = path.join(__dirname, '..', 'MANUAL-CLICK-MATRIX.md');
const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
// Default to production so the script works even without a dev server.
// Override via APP_URL env to point at localhost:3000 if you want.
const APP_URL = process.env.APP_URL || 'https://rental-manager-one.vercel.app';

// Map source-component file → page id where its top-level surfaces are
// reachable. Sub-components (drawer panels, modal forms) aren't covered
// in v1; they need state setup the runner can't derive from the matrix.
const FILE_TO_PAGE = {
  'src/components/Dashboard.js':       'dashboard',
  'src/components/Properties.js':      'properties',
  'src/components/Tenants.js':         'tenants',
  'src/components/Payments.js':        'payments',
  'src/components/Maintenance.js':     'maintenance',
  'src/components/Utilities.js':       'utilities',
  'src/components/Accounting.js':      'accounting',
  'src/components/Documents.js':       'documents',
  'src/components/Vendors.js':         'vendors',
  'src/components/Owners.js':          'owners',
  'src/components/Notifications.js':   'notifications',
  'src/components/Messages.js':        'messages',
  'src/components/HOA.js':             'hoa',
  'src/components/Loans.js':           'loans',
  'src/components/Insurance.js':       'insurance',
  'src/components/TaxBills.js':        'tax_bills',
  'src/components/Leases.js':          'leases',
  'src/components/LateFees.js':        'late_fees',
  'src/components/Lifecycle.js':       'moveout',
  'src/components/Admin.js':           'admin',
  'src/components/TenantPortal.js':    'tenant_portal',
};

// Parser ---------------------------------------------------------------
function parseMatrix(text) {
  const lines = text.split('\n');
  const rows = [];
  let currentFile = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fileHeader = line.match(/^## .+ \(`([^`]+)`\)/);
    if (fileHeader) { currentFile = fileHeader[1]; continue; }
    const m = line.match(/^\|\s*([\w/.-]+:\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*`([^`]*)`\s*\|\s*([✓✗\?\s]?)\s*\|\s*([^|]*?)\s*\|\s*$/);
    if (m) {
      rows.push({
        file: currentFile,
        key: m[1],          // e.g. src/components/Dashboard.js:123
        section: m[2],
        label: m[3],
        handler: m[4],
        status: m[5].trim(),
        notes: m[6].trim(),
        lineIdx: i,
      });
    }
  }
  return { lines, rows };
}

// Match `setPage("X")` — that's the handler shape v1 verifies. Captures
// the destination page id.
function isSetPageHandler(handler) {
  const m = handler.match(/setPage\(\s*["']([\w_-]+)["']/);
  return m ? m[1] : null;
}

// Read source file and extract a clean visible label for a JSX element
// at the given line. The matrix's "label" column is regex-parsed and
// often noisy ("setPage(\"properties\")} className=...").
function readSourceLabel(filePath, lineNum) {
  const abs = path.join(__dirname, '..', '..', filePath);
  if (!fs.existsSync(abs)) return null;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  // Look forward up to 20 lines for content between > and <
  for (let i = lineNum - 1; i < Math.min(lines.length, lineNum + 20); i++) {
    const m = lines[i].match(/>([A-Z][^<{}]{2,40}|[+\-→](?:\s+[\w]+){1,6})</);
    if (m) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      if (t && t.length >= 2) return t;
    }
    // Also try `label="..."` for StatCard rendering
    const lab = lines[i].match(/label\s*=\s*"([^"]+)"/);
    if (lab) return lab[1];
  }
  return null;
}

// Run -------------------------------------------------------------------
(async () => {
  const matrixText = fs.readFileSync(MATRIX, 'utf8');
  const { lines, rows } = parseMatrix(matrixText);

  // Filter to verifiable rows: setPage handler + file we know how to reach
  const candidates = rows
    .map(r => ({ ...r, dest: isSetPageHandler(r.handler) }))
    .filter(r => r.dest && FILE_TO_PAGE[r.file]);

  console.log(`Matrix has ${rows.length} rows; ${candidates.length} are setPage candidates this runner can verify.\n`);
  if (!candidates.length) { console.log('Nothing to run.'); process.exit(0); }

  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.error('TEST_EMAIL / TEST_PASSWORD missing from tests/.env'); process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Login once
  await page.goto(`${APP_URL}/?company=${SMITH}`, { waitUntil: 'networkidle', timeout: 30000 });
  // Sign-in screen if needed
  const signInBtn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await signInBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await signInBtn.click();
  }
  await page.waitForSelector('input[type="email"]', { timeout: 10000 }).catch(() => {});
  if (await page.locator('input[type="email"]').isVisible({ timeout: 1000 }).catch(() => false)) {
    await page.fill('input[type="email"]', TEST_EMAIL);
    await page.fill('input[type="password"]', TEST_PASSWORD);
    await page.locator('button:has-text("Sign In")').last().click();
  }
  await page.waitForSelector('button:visible:has-text("Dashboard")', { timeout: 30000 });
  console.log('Login OK; running rows...\n');

  // Track results: rowKey → { status, notes }
  const results = new Map();

  // Helper: deterministic page navigation via hash (bypasses sidebar
  // lookup races — we only need the surface to be RENDERED to click
  // the button at file:line).
  async function gotoPage(pageId) {
    await page.evaluate((pid) => {
      window.history.pushState({ page: pid, screen: 'app' }, '', '#' + pid);
      window.dispatchEvent(new PopStateEvent('popstate', { state: { page: pid, screen: 'app' } }));
    }, pageId);
    await page.waitForTimeout(1200);
  }

  for (const row of candidates) {
    const sourcePage = FILE_TO_PAGE[row.file];
    const expectedHash = '#' + row.dest;
    const sourceLabel = readSourceLabel(row.file, parseInt(row.key.split(':')[1], 10));
    const labelToUse = sourceLabel || (row.label.match(/^[A-Z+→][\w +&]{1,30}$/)?.[0] || '');

    let result;
    try {
      await gotoPage(sourcePage);
      if (!labelToUse) {
        result = { status: '?', notes: `no clean label for ${row.key}` };
      } else {
        // Try four selectors in order, broadest-last:
        //   1. <button> / <a> with the text
        //   2. role=button / cursor-pointer divs (StatCard renders this way)
        //   3. any descendant containing exact text (Playwright bubbles
        //      click to the nearest onClick handler).
        // The progression matches the actual JSX patterns: most surfaces
        // are buttons, but StatCard / Chip / FilterPill use clickable
        // divs.
        let target = page.locator('main button, main a').filter({ hasText: labelToUse }).first();
        if (!await target.isVisible({ timeout: 1500 }).catch(() => false)) {
          target = page.locator('main [role="button"], main [class*="cursor-pointer"]').filter({ hasText: labelToUse }).first();
        }
        if (!await target.isVisible({ timeout: 1500 }).catch(() => false)) {
          // Last resort: any element under main with exact text. Click
          // bubbles to the onClick-bearing ancestor.
          target = page.locator('main').getByText(labelToUse, { exact: true }).first();
        }
        if (!await target.isVisible({ timeout: 2000 }).catch(() => false)) {
          result = { status: '?', notes: `label "${labelToUse}" not visible on ${sourcePage}` };
        } else {
          // Reset hash so we don't false-positive on a stale match
          await page.evaluate((src) => {
            window.history.replaceState({ page: src, screen: 'app' }, '', '#' + src);
          }, sourcePage);
          await target.click({ timeout: 5000 });
          await page.waitForTimeout(800);
          const hash = await page.evaluate(() => window.location.hash);
          if (hash === expectedHash) {
            result = { status: '✓', notes: `auto-run: clicked "${labelToUse}", hash → ${hash}` };
          } else {
            result = { status: '✗', notes: `auto-run: clicked "${labelToUse}", expected ${expectedHash} got ${hash || '(none)'}` };
          }
        }
      }
    } catch (e) {
      result = { status: '?', notes: 'auto-run error: ' + (e.message || e).slice(0, 80) };
    }
    results.set(row.key, result);
    process.stdout.write(`${result.status} ${row.key.padEnd(46)} → ${result.notes}\n`);
  }

  await browser.close();

  // Write back to matrix --------------------------------------------------
  const updatedLines = lines.slice();
  for (const row of rows) {
    const r = results.get(row.key);
    if (!r) continue;
    // Reconstruct the row with new status/notes; preserve the rest.
    updatedLines[row.lineIdx] = `| ${row.key} | ${row.section} | ${row.label} | \`${row.handler}\` | ${r.status} | ${r.notes.replace(/\|/g, '\\|')} |`;
  }
  fs.writeFileSync(MATRIX, updatedLines.join('\n'));
  const summary = { '✓': 0, '✗': 0, '?': 0 };
  for (const r of results.values()) summary[r.status] = (summary[r.status] || 0) + 1;
  console.log('\n──────────────');
  console.log(`✓ ${summary['✓']}   ✗ ${summary['✗']}   ? ${summary['?']}   total ${results.size}`);
  console.log(`Matrix updated: ${MATRIX}`);
})();
