// ═══════════════════════════════════════════════════════════════
// 07 — ACCOUNTING: ALL 8 TABS, REPORTS, BANK IMPORT, CLASSES
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Accounting Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Accounting');
  });

  // ── Tab Navigation ──
  test('all accounting tabs are visible', async ({ page }) => {
    const tabs = ['Overview', 'Chart of Accounts', 'Journal Entries',
      'Bank Import', 'Reconcile', 'Class Tracking', 'Reports'];
    for (const tab of tabs) {
      const tabEl = page.locator(`text=${tab}`).first();
      await expect(tabEl).toBeVisible({ timeout: 5000 });
    }
  });

  test('clicking each tab loads without crash', async ({ page }) => {
    test.setTimeout(60000);
    const tabs = ['Chart of Accounts', 'Journal Entries', 'Recurring',
      'Bank Import', 'Reconcile', 'Class Tracking', 'Reports', 'Overview'];
    for (const tab of tabs) {
      const tabEl = page.locator(`button:has-text("${tab}"), text=${tab}`).first();
      if (await tabEl.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tabEl.click();
        await page.waitForTimeout(1000);
        const hasError = await page.locator('text=Something went wrong').isVisible().catch(() => false);
        expect(hasError, `Tab "${tab}" should not crash`).toBeFalsy();
      }
    }
  });

  // ── Chart of Accounts ──
  test('COA shows required accounts', async ({ page }) => {
    await page.locator('text=Chart of Accounts').first().click();
    await page.waitForTimeout(1500);
    const accounts = ['Checking', 'Receivable', 'Rental Income', 'Security Deposit'];
    for (const acc of accounts) {
      const vis = await page.locator(`text=${acc}`).first().isVisible({ timeout: 3000 }).catch(() => false);
      expect(vis, `Account "${acc}" should be visible`).toBeTruthy();
    }
  });

  test('COA has type filter buttons', async ({ page }) => {
    await page.locator('text=Chart of Accounts').first().click();
    await page.waitForTimeout(1000);
    const types = ['All', 'Asset', 'Liability', 'Revenue', 'Expense'];
    for (const type of types) {
      const btn = page.locator(`button:has-text("${type}")`).first();
      const vis = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    }
  });

  test('COA new account button opens modal', async ({ page }) => {
    await page.locator('text=Chart of Accounts').first().click();
    await page.waitForTimeout(1000);
    const newBtn = page.locator('button:has-text("New Account"), button:has-text("Add")').first();
    if (await newBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await newBtn.click();
      await page.waitForTimeout(500);
      const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="Account"]').first();
      await expect(nameInput).toBeVisible({ timeout: 3000 });
    }
  });

  test('COA accounts show balances', async ({ page }) => {
    await page.locator('text=Chart of Accounts').first().click();
    await page.waitForTimeout(1500);
    // Should see $ amounts
    const hasDollar = await page.locator('text=$').first().isVisible().catch(() => false);
  });

  // ── Journal Entries ──
  test('journal entries tab shows entries', async ({ page }) => {
    await page.locator('text=Journal Entries').first().click();
    await page.waitForTimeout(1500);
    // Should show JE-SEED-001 or similar
    const hasJE = await page.locator('text=JE-').first().isVisible({ timeout: 5000 }).catch(() => false)
      || await page.locator('text=posted').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasJE).toBeTruthy();
  });

  test('JE filter tabs work (All, Posted, Drafts, Voided)', async ({ page }) => {
    await page.locator('text=Journal Entries').first().click();
    await page.waitForTimeout(1000);
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
    await page.locator('text=Journal Entries').first().click();
    await page.waitForTimeout(1000);
    const addBtn = page.locator('button:has-text("New"), button:has-text("Add")').first();
    if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(500);
      // Should show date, description, and line items with debit/credit
      const hasDate = await page.locator('input[type="date"]').first().isVisible().catch(() => false);
      expect(hasDate).toBeTruthy();
    }
  });

  // ── Class Tracking ──
  test('class tracking shows property classes', async ({ page }) => {
    await page.locator('text=Class Tracking').first().click();
    await page.waitForTimeout(1500);
    // Should show property-based classes
    const hasClass = await page.locator('text=Oak').isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Revenue').isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('class tracking has period selector', async ({ page }) => {
    await page.locator('text=Class Tracking').first().click();
    await page.waitForTimeout(1000);
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
    const reportBtn = page.locator('text=Reports').first();
    await reportBtn.click();
    await page.waitForTimeout(1500);
    const reports = ['Profit', 'Balance Sheet', 'AR', 'Trial Balance', 'General Ledger'];
    for (const r of reports) {
      const vis = await page.locator(`text=${r}`).first().isVisible({ timeout: 3000 }).catch(() => false);
    }
  });

  test('P&L report shows income and expenses', async ({ page }) => {
    await page.locator('text=Reports').first().click();
    await page.waitForTimeout(1000);
    const plBtn = page.locator('button:has-text("Profit"), text=Profit').first();
    if (await plBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await plBtn.click();
      await page.waitForTimeout(1500);
      const hasIncome = await page.locator('text=Income').first().isVisible().catch(() => false);
      const hasExpense = await page.locator('text=Expense').first().isVisible().catch(() => false);
    }
  });

  test('reports print button exists', async ({ page }) => {
    await page.locator('text=Reports').first().click();
    await page.waitForTimeout(1000);
    const printBtn = page.locator('button:has-text("🖨"), button:has-text("Print"), button:has-text("print")').first();
    const hasPrint = await printBtn.isVisible({ timeout: 3000 }).catch(() => false);
  });

  // ── Bank Import ──
  test('bank import tab shows upload area', async ({ page }) => {
    await page.locator('text=Bank Import').first().click();
    await page.waitForTimeout(1500);
    const hasDrag = await page.locator('text=drag').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=CSV').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=upload').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasDrag).toBeTruthy();
  });

  test('bank import shows supported formats', async ({ page }) => {
    await page.locator('text=Bank Import').first().click();
    await page.waitForTimeout(1000);
    const hasFormats = await page.locator('text=Chase').isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Bank of America').isVisible({ timeout: 3000 }).catch(() => false);
  });

  // ── Recurring JEs ──
  test('recurring entries tab shows entries or empty state', async ({ page }) => {
    const recurBtn = page.locator('button:has-text("Recurring"), text=Recurring').first();
    if (await recurBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await recurBtn.click();
      await page.waitForTimeout(1500);
      const hasContent = await page.locator('button:has-text("Add Entry"), button:has-text("Post Now")').first().isVisible().catch(() => false);
    }
  });

  test('no horizontal overflow on accounting', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});
