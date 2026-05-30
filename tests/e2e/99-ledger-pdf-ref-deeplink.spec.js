// Verifies the three ledger changes against the running app:
//   1. Account-name rows are real <a href="?ledger=…#acct_coa"> (LedgerLink)
//   2. Normal click opens the ledger modal in place (preventDefault, same tab)
//   3. PDF + Export CSV buttons present
//   4. Deep-link ?ledger=<id> auto-opens the ledger and strips the param
//   5. REF column shows friendly labels (DEP-→Deposit, RENT-→Rent Charge),
//      no raw system prefix leaks
const { test, expect } = require('@playwright/test');
const { login, navigateTo } = require('./helpers');

// sandbox-llc fixtures (posted 2026-03-01, inside default "This Year"):
//   1100-001 line ref = DEP-…        → "Deposit"
//   1100   (parent) ref = RENT-AUTO-… → "Rent Charge"
const DEP_ACCT = '47a2678a-cfc2-4488-8bd4-71d93e8a9d8b';
const RENT_ACCT = 'aae56fd2-fba0-4f11-9cdc-96dfddb001f3';

function ledgerModal(page) {
  return page.locator('div.fixed').filter({ hasText: 'entries' })
    .filter({ has: page.locator('button:has-text("Export CSV")') }).last();
}

async function refColumnTexts(page) {
  const table = ledgerModal(page).locator('table').first();
  const headers = await table.locator('thead th').allInnerTexts();
  const refIdx = headers.findIndex(h => h.trim().toLowerCase() === 'ref');
  expect(refIdx, 'Ref column header found').toBeGreaterThanOrEqual(0);
  return table.locator(`tbody tr td:nth-child(${refIdx + 1})`).allInnerTexts();
}

test('ledger: anchor rows + normal-click modal + PDF/CSV buttons', async ({ page }) => {
  await login(page);
  await navigateTo(page, 'Accounting');
  const coaTab = page.locator('button:has-text("Chart of Accounts"), button:has-text("Accounts")').first();
  if (await coaTab.isVisible({ timeout: 3000 }).catch(() => false)) await coaTab.click();
  await page.waitForTimeout(800);

  // 1. Account-name cells are LedgerLink anchors with the right href shape
  const link = page.locator('a[href*="ledger="]').first();
  await expect(link).toBeVisible({ timeout: 8000 });
  const href = await link.getAttribute('href');
  expect(href).toContain('?ledger=');
  expect(href).toContain('#acct_coa');

  // 2. Plain left-click opens the modal in place — URL must NOT change
  const urlBefore = page.url();
  await link.click();
  await expect(page.locator('text=/\\d+ entries/').first()).toBeVisible({ timeout: 8000 });
  expect(page.url(), 'normal click preventDefault → same tab').toBe(urlBefore);
  // (export-button presence is asserted in the next test against a POPULATED
  //  ledger — the first COA account may be empty, in which case the new guard
  //  intentionally hides the export buttons.)
});

test('ledger: deep-link auto-opens + friendly REF labels (Deposit / Rent Charge)', async ({ page }) => {
  await login(page);

  // 4 + 5a: deep-link to a DEP- account → modal opens, REF shows "Deposit"
  await page.goto('/?ledger=' + DEP_ACCT + '#acct_coa');
  await expect(page.locator('text=/\\d+ entries/').first()).toBeVisible({ timeout: 12000 });
  expect(page.url(), 'param stripped after consumption').not.toContain('ledger=');
  let refs = await refColumnTexts(page);
  console.log('DEP account REF cells =', refs);
  expect(refs.some(t => t.trim() === 'Deposit'), 'DEP- mapped to "Deposit"').toBeTruthy();
  expect(refs.some(t => /^DEP-/.test(t.trim())), 'no raw DEP- leak').toBeFalsy();

  // export buttons present on a POPULATED ledger (guard shows them)
  await expect(ledgerModal(page).locator('button:has-text("PDF"):visible').first()).toBeVisible();
  await expect(ledgerModal(page).locator('button:has-text("Export CSV"):visible').first()).toBeVisible();

  // 5b: deep-link to a RENT-AUTO- account → REF shows the distinct "Auto Rent"
  await page.goto('/?ledger=' + RENT_ACCT + '#acct_coa');
  await expect(page.locator('text=/\\d+ entries/').first()).toBeVisible({ timeout: 12000 });
  refs = await refColumnTexts(page);
  console.log('RENT account REF cells =', refs);
  expect(refs.some(t => t.trim() === 'Auto Rent'), 'RENT-AUTO- mapped to "Auto Rent"').toBeTruthy();
  expect(refs.some(t => /^RENT/.test(t.trim())), 'no raw RENT- leak').toBeFalsy();
});
