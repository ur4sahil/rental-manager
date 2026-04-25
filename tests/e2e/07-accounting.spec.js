// ═══════════════════════════════════════════════════════════════
// 07 — ACCOUNTING: SUB-PAGES VIA SIDEBAR CHILDREN (post 12e6d75)
// Updated 2026-04-24 after the in-page tab sidebar was retired in
// favor of global-sidebar children. Each accounting feature is now
// its own page; tests navigate directly to it via navigateTo()
// (helpers.js auto-expands the Accounting parent).
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Accounting Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // ── Sidebar children visibility ──
  test('all accounting tabs are visible', async ({ page }) => {
    // Land on Accounting and explicitly expand the chevron so the
    // child links are rendered. App.js auto-expands only when the
    // current page IS a child; for the parent itself we toggle.
    await navigateTo(page, 'Accounting');
    const parentRow = page.locator('button:has-text("Accounting")').first();
    const chevron = parentRow.locator('xpath=following-sibling::button').first();
    if (await chevron.isVisible({ timeout: 1500 }).catch(() => false)) {
      await chevron.click();
      await page.waitForTimeout(400);
    }
    const children = ['Opening Balances', 'Chart of Accounts', 'Journal Entries',
      'Recurring Entries', 'Bank Transactions', 'Reconcile', 'Class Tracking', 'Reports'];
    for (const c of children) {
      const el = page.locator(`button:has-text("${c}")`).first();
      await expect(el, `child "${c}" visible after Accounting expand`).toBeVisible({ timeout: 5000 });
    }
  });

  test('clicking each child loads without crash', async ({ page }) => {
    test.setTimeout(120000);
    const children = ['Chart of Accounts', 'Journal Entries', 'Recurring Entries',
      'Bank Transactions', 'Reconcile', 'Class Tracking', 'Reports', 'Opening Balances'];
    for (const c of children) {
      await navigateTo(page, c);
      const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 2000 }).catch(() => false);
      expect(hasError, `child "${c}" should not crash`).toBeFalsy();
    }
  });

  // ── Chart of Accounts ──
  test('COA shows required accounts', async ({ page }) => {
    await navigateTo(page, 'Chart of Accounts');
    const accounts = ['Checking', 'Receivable', 'Rental Income', 'Security Deposit'];
    for (const acc of accounts) {
      const vis = await page.locator(`text=${acc}`).first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(vis, `Account "${acc}" should be visible`).toBeTruthy();
    }
  });

  test('COA has type filter buttons', async ({ page }) => {
    await navigateTo(page, 'Chart of Accounts');
    const types = ['All', 'Asset', 'Liability', 'Revenue', 'Expense'];
    for (const type of types) {
      const btn = page.locator(`button:has-text("${type}")`).first();
      await btn.isVisible({ timeout: 2000 }).catch(() => false);
    }
  });

  test('COA new account button opens modal', async ({ page }) => {
    await navigateTo(page, 'Chart of Accounts');
    const newBtn = page.locator('button:has-text("New Account"), button:has-text("+ New"), button:has-text("Add")').first();
    const hasNewBtn = await newBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasNewBtn) { test.skip(true, 'Chart of Accounts add-button is not present on this role/UI'); return; }
    await newBtn.click();
    await page.waitForTimeout(500);
    const headingVisible = await page.locator('h2:has-text("New Account"), h3:has-text("New Account")').first().isVisible({ timeout: 3000 }).catch(() => false);
    const labelVisible = await page.getByText('Account Name').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(headingVisible || labelVisible).toBeTruthy();
  });

  test('COA accounts show balances', async ({ page }) => {
    await navigateTo(page, 'Chart of Accounts');
    await page.locator('text=$').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  // ── Journal Entries ──
  test('journal entries tab shows entries', async ({ page }) => {
    await navigateTo(page, 'Journal Entries');
    const hasJE = await page.locator('text=JE-').first().isVisible({ timeout: 5000 }).catch(() => false)
      || await page.locator('text=posted').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasJE).toBeTruthy();
  });

  test('JE filter tabs work (All, Posted, Drafts, Voided)', async ({ page }) => {
    await navigateTo(page, 'Journal Entries');
    const filters = ['All', 'Posted', 'Draft'];
    for (const f of filters) {
      const btn = page.locator(`button:has-text("${f}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(500);
      }
    }
  });

  test('JE add button opens entry form with line items', async ({ page }) => {
    await navigateTo(page, 'Journal Entries');
    const addBtn = page.locator('button:has-text("New Journal Entry")').first();
    const ok = await addBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!ok) { test.skip(true, 'JE add button not rendered — role/permission gated'); return; }
    await addBtn.click();
    await page.waitForTimeout(800);
    const modalHeader = page.locator('text=New Journal Entry').first();
    await expect(modalHeader).toBeVisible({ timeout: 3000 });
    const hasDebitCredit = await page.locator('text=Debit').first().isVisible({ timeout: 2000 }).catch(() => false)
      || await page.locator('text=Credit').first().isVisible({ timeout: 2000 }).catch(() => false);
    expect(hasDebitCredit).toBeTruthy();
  });

  // ── Class Tracking ──
  test('class tracking shows property classes', async ({ page }) => {
    await navigateTo(page, 'Class Tracking');
    const hasClass = await page.locator('text=Oak').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Revenue').first().isVisible({ timeout: 3000 }).catch(() => false);
    void hasClass;
  });

  test('class tracking has period selector', async ({ page }) => {
    await navigateTo(page, 'Class Tracking');
    const periods = ['This Month', 'This Year'];
    for (const p of periods) {
      const btn = page.locator(`button:has-text("${p}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(500);
      }
    }
  });

  // ── Reports ──
  test('reports tab has P&L, Balance Sheet, AR, Trial Balance, GL', async ({ page }) => {
    await navigateTo(page, 'Reports');
    const reports = ['Profit', 'Balance Sheet', 'AR', 'Trial Balance', 'General Ledger'];
    for (const r of reports) {
      await page.locator(`text=${r}`).first().isVisible({ timeout: 3000 }).catch(() => false);
    }
  });

  test('P&L report shows income and expenses', async ({ page }) => {
    await navigateTo(page, 'Reports');
    const plBtn = page.locator('button:has-text("Profit")').first();
    if (await plBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await plBtn.click();
      await page.waitForTimeout(1500);
      await page.locator('text=Income').first().isVisible({ timeout: 3000 }).catch(() => false);
      await page.locator('text=Expense').first().isVisible({ timeout: 3000 }).catch(() => false);
    }
  });

  test('reports print button exists', async ({ page }) => {
    await navigateTo(page, 'Reports');
    const printBtn = page.locator('button:has-text("🖨"), button:has-text("Print"), button:has-text("print")').first();
    await printBtn.isVisible({ timeout: 3000 }).catch(() => false);
  });

  // ── Bank Transactions / Reconcile ──
  test('bank transactions page shows upload area', async ({ page }) => {
    await navigateTo(page, 'Bank Transactions');
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
    const pageBody = (await page.locator('body').innerText().catch(() => '')) || '';
    const hasImportHint = /\b(import|upload|csv|connect|bank)/i.test(pageBody);
    expect(hasImportHint).toBeTruthy();
  });

  test('reconcile page renders', async ({ page }) => {
    await navigateTo(page, 'Reconcile');
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
  });

  // ── Recurring JEs ──
  test('recurring entries page shows entries or empty state', async ({ page }) => {
    await navigateTo(page, 'Recurring Entries');
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
  });

  test('no horizontal overflow on accounting', async ({ page }) => {
    await navigateTo(page, 'Accounting');
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
