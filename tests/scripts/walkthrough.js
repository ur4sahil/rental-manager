// FULL walk-through (v2): screenshot every page + click every button
// in the main pane by INDEX (not by label) to avoid Playwright strict-
// mode failures. Each page gets:
//   00-landing.png                     — initial render
//   NN-<safe-label>-before.png         — before clicking button N
//   NN-<safe-label>-after.png          — immediately after click
// Plus a per-page log line summarising clicks/errors.

const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '/Users/aggar/rental-manager/tests/.env' });

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';
const APP_URL = 'https://rental-manager-one.vercel.app';
const OUT_DIR = '/tmp/walkthrough-shots';
const LOG_FILE = path.join(OUT_DIR, '_log.txt');

if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const log = (s) => { console.log(s); fs.appendFileSync(LOG_FILE, s + '\n'); };

const PAGES = [
  { id: 'dashboard',      label: '01-Dashboard'        },
  { id: 'properties',     label: '02-Properties'       },
  { id: 'tenants',        label: '03-Tenants'          },
  { id: 'payments',       label: '04-Payments'         },
  { id: 'maintenance',    label: '05-Maintenance'      },
  { id: 'utilities',      label: '06-Utilities'        },
  { id: 'hoa',            label: '07-HOA'              },
  { id: 'property_loans', label: '08-Loans'            },
  { id: 'insurance',      label: '09-Insurance'        },
  { id: 'tax_bills',      label: '10-TaxBills'         },
  { id: 'accounting',     label: '11-Accounting'       },
  { id: 'acct_coa',       label: '12-ChartOfAccounts'  },
  { id: 'acct_journal',   label: '13-JournalEntries'   },
  { id: 'acct_recurring', label: '14-RecurringJEs'     },
  { id: 'acct_reports',   label: '15-Reports'          },
  { id: 'acct_classes',   label: '16-ClassTracking'    },
  { id: 'acct_reconcile', label: '17-Reconcile'        },
  { id: 'acct_bankimport',label: '18-BankTransactions' },
  { id: 'acct_opening',   label: '19-OpeningBalances'  },
  { id: 'doc_builder',    label: '20-DocBuilder'       },
  { id: 'documents',      label: '21-Documents'        },
  { id: 'leases',         label: '22-Leases'           },
  { id: 'inspections',    label: '23-Inspections'      },
  { id: 'autopay',        label: '24-Autopay'          },
  { id: 'latefees',       label: '25-LateFees'         },
  { id: 'moveout',        label: '26-MoveOut'          },
  { id: 'evictions',      label: '27-Evictions'        },
  { id: 'owners',         label: '28-Owners'           },
  { id: 'vendors',        label: '29-Vendors'          },
  { id: 'tasks',          label: '30-Tasks'            },
  { id: 'messages',       label: '31-Messages'         },
  { id: 'notifications',  label: '32-Notifications'    },
  { id: 'admin',          label: '33-Admin'            },
];

// Skip these labels — destructive or material-icon-only buttons we
// don't want to fire / that aren't actionable on their own.
const SKIP_LABELS = /^(Delete|Disconnect|Archive|Sign Out|Logout|Confirm|Void|Reverse|Pay|Submit|Send|Mark Complete|Approve|Reject|Generate|Run Now|Post|Apply All|Authorize|delete|disconnect|archive|expand_more|expand_less|menu|notifications|swap_horiz|content_copy|edit|delete_outline|description|history|edit_note|auto_fix_high|add_circle_outline|add_circle|search|more_vert|close|chevron_left|chevron_right|arrow_back|arrow_forward|visibility|cloud_upload|download|print|share|filter_list|sort)$/;

const MAX_CLICKS_PER_PAGE = 15;

async function gotoHash(page, pid) {
  await page.evaluate((id) => {
    window.history.pushState({ page: id, screen: 'app' }, '', '#' + id);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new PopStateEvent('popstate', { state: { page: id, screen: 'app' } }));
  }, pid);
  await page.waitForTimeout(2000);
}

async function tryClose(page) {
  // Cancel buttons
  const cancel = page.locator('button:has-text("Cancel"), button:has-text("Close"), button[aria-label*="close" i]').first();
  if (await cancel.isVisible({ timeout: 600 }).catch(() => false)) {
    await cancel.click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(150);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', m => {
    if (m.type() === 'error') {
      const t = m.text();
      if (!/favicon|manifest|service-worker|sw\.js|VAPID|push subscription/i.test(t)) {
        consoleErrors.push(t.slice(0, 220));
        log('  ERR(console): ' + t.slice(0, 200));
      }
    }
  });
  page.on('pageerror', e => {
    pageErrors.push(e.message.slice(0, 220));
    log('  ERR(page): ' + e.message.slice(0, 200));
  });

  // Login
  log(`Walk-through starting · ${new Date().toISOString()}`);
  await page.goto(`${APP_URL}/?company=${SMITH}`, { timeout: 30000 });
  const dashAlready = await page.locator('button:visible:has-text("Dashboard")').first()
    .isVisible({ timeout: 3000 }).catch(() => false);
  if (!dashAlready) {
    const signIn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
    if (await signIn.isVisible({ timeout: 3000 }).catch(() => false)) await signIn.click();
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.fill('input[type="email"]', process.env.TEST_EMAIL);
    await page.fill('input[type="password"]', process.env.TEST_PASSWORD);
    await page.locator('button:has-text("Sign In")').last().click();
    await page.waitForSelector('button:visible:has-text("Dashboard")', { timeout: 30000 });
  }
  await page.screenshot({ path: path.join(OUT_DIR, '_login-success.png') });
  log('Login OK\n');

  let totalClicks = 0;
  const findings = [];

  for (const p of PAGES) {
    const pageDir = path.join(OUT_DIR, p.label);
    fs.mkdirSync(pageDir, { recursive: true });
    consoleErrors.length = 0;
    pageErrors.length = 0;

    try {
      await gotoHash(page, p.id);
      await page.screenshot({ path: path.join(pageDir, '00-landing.png') });
      const bodyAtLanding = await page.locator('main').innerText().catch(() => '');
      const crashed = /Something went wrong/i.test(bodyAtLanding);
      if (crashed) {
        findings.push(p.label + ': CRASH on landing');
        log(`✗ ${p.label}: CRASH on landing`);
        continue;
      }

      // First, build a list of click targets by their unique nth-index.
      // We capture (index, label) pairs UPFRONT so re-renders don't shift
      // the DOM under us mid-loop.
      const targets = await page.locator('main button:visible').evaluateAll((els) => {
        return els.map((el, i) => {
          const t = (el.innerText || '').trim().split('\n')[0].slice(0, 40);
          return { i, label: t };
        }).filter(x => x.label.length > 0);
      });

      // Filter out skipped + dedupe by label (only first occurrence)
      const seen = new Set();
      const work = [];
      for (const t of targets) {
        if (SKIP_LABELS.test(t.label)) continue;
        if (seen.has(t.label)) continue;
        seen.add(t.label);
        work.push(t);
        if (work.length >= MAX_CLICKS_PER_PAGE) break;
      }

      log(`\n${p.label}: ${targets.length} buttons found, exercising ${work.length}`);

      let pageClicks = 0;
      for (const t of work) {
        const safeLabel = t.label.replace(/[^a-z0-9]/gi, '_').slice(0, 35) || 'btn';
        const seq = String(pageClicks + 1).padStart(2, '0');

        try {
          // Re-resolve the button by current DOM index — DOM may have
          // shifted due to a previous click. If the label at this index
          // doesn't match, scan for it.
          let btn = page.locator('main button:visible').nth(t.i);
          let label = (await btn.innerText().catch(() => '')).trim().split('\n')[0].slice(0, 40);
          if (label !== t.label) {
            // Scan for the label by re-collecting all current buttons
            const ix = await page.locator('main button:visible').evaluateAll((els, want) => {
              for (let k = 0; k < els.length; k++) {
                const tt = (els[k].innerText || '').trim().split('\n')[0].slice(0, 40);
                if (tt === want) return k;
              }
              return -1;
            }, t.label);
            if (ix === -1) { log(`  ?  "${t.label}" — gone`); continue; }
            btn = page.locator('main button:visible').nth(ix);
          }

          // Pre-click screenshot is the previous "after" — we just
          // overwrite landing/00 with the rolling state. The "after"
          // screenshot below is the meaningful one.
          await btn.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
          await btn.click({ timeout: 4000 });
          await page.waitForTimeout(700);
          await page.screenshot({ path: path.join(pageDir, `${seq}-${safeLabel}.png`) });

          const postBody = await page.locator('main, body').innerText().catch(() => '');
          if (/Something went wrong/i.test(postBody)) {
            findings.push(`${p.label} → "${t.label}": CRASH`);
            log(`  ✗ ${pageClicks + 1}. "${t.label}" — CRASH`);
          } else {
            log(`  ✓ ${pageClicks + 1}. "${t.label}"`);
          }
          await tryClose(page);

          // If we navigated off, return to source page
          const nowHash = await page.evaluate(() => window.location.hash);
          if (!nowHash.includes(p.id) && p.id !== 'dashboard') {
            await gotoHash(page, p.id);
          }
          pageClicks++;
          totalClicks++;
        } catch (e) {
          log(`  !  "${t.label}" — ${(e.message || '').split('\n')[0].slice(0, 80)}`);
        }
      }

      if (consoleErrors.length) findings.push(p.label + ': ' + consoleErrors.length + ' console errors');
      if (pageErrors.length) findings.push(p.label + ': ' + pageErrors.length + ' page errors');
      log(`  → page total: ${pageClicks} clicks`);
    } catch (e) {
      log(`!! ${p.label} — top-level: ${e.message.slice(0, 80)}`);
    }
  }

  await browser.close();
  log(`\n══════════════════════════════════════════`);
  log(`Total successful clicks: ${totalClicks}`);
  log(`Findings (${findings.length}):`);
  for (const f of findings) log('  • ' + f);
  log(`\nScreenshots: ${OUT_DIR}/<NN-PageName>/`);
})();
