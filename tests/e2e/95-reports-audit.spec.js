// Opens EVERY report in the accounting catalogue, screenshots it, and
// records whether it actually rendered something.
//
// 32 reports across 6 categories. Nothing had ever opened them all --
// acct_reports was covered only by a route-health check ("does the page
// render") and an axe scan of the catalogue screen. Whether each report
// produces correct figures, or opens at all, was unknown.
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const path = require('path');

const COMPANY = process.env.E2E_COMPANY || 'e2e-sandbox';
const SHOTS = path.join(__dirname, '..', 'screenshots', 'reports');
const APP = process.env.APP_URL || 'http://localhost:3000';

const REPORTS = [
  ['pl', 'Profit & Loss'], ['pl_by_class', 'P&L by Property'], ['pl_compare', 'P&L Comparison'],
  ['bs', 'Balance Sheet'], ['cash_flow', 'Cash Flow Statement'], ['budget_vs_actual', 'Budget vs. Actuals'],
  ['ar_aging_summary', 'AR Aging Summary'], ['ar_aging_detail', 'AR Aging Detail'],
  ['customer_balance_summary', 'Tenant Balance Summary'], ['open_invoices', 'Open Invoices'],
  ['collections', 'Collections Report'],
  ['ap_aging_summary', 'AP Aging Summary'], ['unpaid_bills', 'Unpaid Bills'],
  ['vendor_balance_summary', 'Vendor Balance Summary'],
  ['expenses_by_category', 'Expenses by Category'], ['expenses_by_vendor', 'Expenses by Vendor'],
  ['tb', 'Trial Balance'], ['gl', 'General Ledger'], ['journal', 'Journal'],
  ['txn_by_date', 'Transaction List by Date'], ['account_list', 'Account Listing'],
  ['audit_log', 'Audit Log'], ['recon_summary', 'Reconciliation Summary'],
  ['rent_roll', 'Rent Roll'], ['vacancy', 'Vacancy Report'], ['lease_expirations', 'Lease Expirations'],
  ['rent_collection', 'Rent Collection'], ['work_orders_summary', 'Work Order Summary'],
  ['security_deposits', 'Security Deposit Ledger'], ['noi_by_property', 'NOI by Property'],
  ['license_compliance', 'License Compliance'],
];

test('every accounting report opens, renders and is screenshotted', async ({ page }) => {
  test.setTimeout(1800000);
  const findings = [];
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  page.on('response', r => {
    if (r.status() >= 400 && r.url().includes('/rest/v1/')) {
      consoleErrors.push(`HTTP ${r.status()} ${r.url().split('/rest/v1/')[1].slice(0, 90)}`);
    }
  });

  // The Reports page takes ~18s to become usable on this dataset -- it
  // pages the company's whole ledger on load (19 requests to
  // acct_journal_lines, 13 to acct_journal_entries). So load it ONCE and
  // navigate the catalogue in-page afterwards; reloading per report
  // would add ten minutes of pure waiting and tell us nothing new.
  await page.goto(`${APP}/?company=${COMPANY}#acct_reports`);
  // waitForFunction is (fn, arg, options) -- passing the options object
  // as the second argument makes it the ARG, and the wait silently falls
  // back to the config's 15s actionTimeout. That is why this timed out
  // at 15s while asking for 120s.
  await page.waitForFunction(
    () => /Profit & Loss/i.test(document.querySelector('main')?.innerText || ''),
    null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
  await page.screenshot({ path: path.join(SHOTS, '00-catalog.png'), fullPage: true });

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  for (const v of violations.filter(v => ['critical', 'serious'].includes(v.impact))) {
    findings.push(`catalog: ${v.impact}/${v.id} x${v.nodes.length} — ${v.help}`);
  }

  for (const [id, title] of REPORTS) {
    const before = consoleErrors.length;
    // In-page return to the catalogue, no reload.
    const back = page.locator('text=Back to Reports').first();
    if (await back.count() > 0 && await back.isVisible().catch(() => false)) {
      await back.click();
      await page.waitForTimeout(1200);
    }

    const card = page.locator(`text="${title}"`).first();
    if (await card.count() === 0) { findings.push(`${title}: NOT FOUND in the catalogue`); continue; }
    await card.click();
    await page.waitForTimeout(4500);
    await page.waitForFunction(() => !document.querySelector('.animate-spin'), { timeout: 20000 }).catch(() => {});
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await page.screenshot({ path: path.join(SHOTS, `${id}.png`), fullPage: true });

    const body = await page.locator('main').innerText().catch(() => '');
    // Did the viewer actually open, and did it put anything in?
    if (!body.includes(title)) findings.push(`${title}: viewer did not open (title absent)`);
    const empty = /no data|nothing to show|no transactions|no results|^\s*$/i.test(body.replace(title, ''));
    if (empty) findings.push(`${title}: rendered EMPTY`);
    // Word boundaries, and NaN case-SENSITIVELY. The first version used
    // a loose case-insensitive /NaN/ and matched "maiNANce" and "teNANt",
    // so 20 of 21 "faults" were the words Maintenance and Tenant. A
    // detector that cries wolf on ordinary content is worse than none.
    const faultRe = /\b(error|failed|undefined)\b|\bNaN\b|\[object Object\]/;
    const faultReI = /\b(error|failed|undefined)\b/i;
    if (faultRe.test(body) || faultReI.test(body)) {
      const m = body.match(/.{0,60}(\b(?:[Ee]rror|[Ff]ailed|undefined)\b|\bNaN\b|\[object Object\]).{0,60}/) || [];
      findings.push(`${title}: shows a fault — "${(m[0] || '').replace(/\s+/g, ' ').trim()}"`);
    }
    const newErrs = consoleErrors.slice(before);
    if (newErrs.length) findings.push(`${title}: ${newErrs.length} request/console error(s) — ${newErrs[0]}`);

    // Screenshots show whether a report RENDERS. They do not show whether
    // it is right. These three have arithmetic that must hold, so check
    // the numbers the report itself printed.
    const money = (label) => {
      const re = new RegExp(label + '[^0-9\\-$]{0,40}\\$?\\(?(-?[\\d,]+\\.?\\d*)\\)?', 'i');
      const m = body.match(re);
      return m ? parseFloat(m[1].replace(/,/g, '')) : null;
    };
    if (id === 'tb') {
      const nums = [...body.matchAll(/\$([\d,]+\.\d{2})/g)].map(m => parseFloat(m[1].replace(/,/g, '')));
      const totalLine = body.match(/TOTAL[^0-9]{0,40}\$([\d,]+\.\d{2})[^0-9]{0,40}\$([\d,]+\.\d{2})/i);
      if (!totalLine) findings.push('Trial Balance: no TOTAL row found — cannot verify it balances');
      else {
        const dr = parseFloat(totalLine[1].replace(/,/g, '')), cr = parseFloat(totalLine[2].replace(/,/g, ''));
        if (Math.abs(dr - cr) > 0.01) findings.push(`Trial Balance DOES NOT BALANCE: debits ${dr} vs credits ${cr}`);
        else console.log(`  ✓ Trial Balance balances: ${dr.toLocaleString()} = ${cr.toLocaleString()}`);
        if (nums.length < 3) findings.push('Trial Balance: suspiciously few figures');
      }
    }
    if (id === 'bs') {
      const assets = money('TOTAL ASSETS'), liab = money('TOTAL LIABILITIES'), eq = money('TOTAL EQUITY');
      if (assets === null) findings.push('Balance Sheet: no TOTAL ASSETS figure found');
      else if (liab !== null && eq !== null && Math.abs(assets - (liab + eq)) > 0.01) {
        findings.push(`Balance Sheet DOES NOT BALANCE: assets ${assets} vs liabilities+equity ${(liab + eq).toFixed(2)}`);
      } else console.log(`  ✓ Balance Sheet: assets ${assets?.toLocaleString()} = L+E ${(liab + eq).toLocaleString()}`);
    }
    if (id === 'pl') {
      const inc = money('TOTAL INCOME'), exp = money('TOTAL EXPENSES'), net = money('NET (?:INCOME|OPERATING INCOME|PROFIT)');
      if (inc !== null && exp !== null && net !== null && Math.abs((inc - exp) - net) > 0.01) {
        findings.push(`P&L arithmetic wrong: income ${inc} - expenses ${exp} = ${(inc-exp).toFixed(2)}, but it prints ${net}`);
      } else if (inc !== null) console.log(`  ✓ P&L: income ${inc.toLocaleString()} - expenses ${exp?.toLocaleString()} = net ${net?.toLocaleString()}`);
    }
  }

  console.log('\n=== REPORT AUDIT: ' + REPORTS.length + ' reports ===');
  for (const f of findings) console.log('  ' + f);
  console.log(`(${findings.length} findings; screenshots in screenshots/reports)`);
});
