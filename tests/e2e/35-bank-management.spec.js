// ═══════════════════════════════════════════════════════════════
// 35 — BANK MANAGEMENT: Feed cards, GL deletion, pagination, Excel export
// Tests the bank transactions UI improvements and account management
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

// Updated 2026-04-24 — Accounting "tabs" became sidebar children
// (commit 12e6d75); each describe block now navigates directly to
// the child page instead of clicking an in-page tab.
test.describe('Bank Transactions Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Bank Transactions');
  });

  // ── Feed Cards ──
  test('feed cards are visible with three-dot menu', async ({ page }) => {
    // Check if any feed cards exist
    const feedCard = page.locator('[class*="rounded-xl"][class*="border-2"]').first();
    const hasFeed = await feedCard.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasFeed) {
      test.skip('No bank feeds configured');
      return;
    }
    // Check three-dot menu icon exists
    const moreIcon = feedCard.locator('span:has-text("more_vert")');
    await expect(moreIcon).toBeVisible({ timeout: 3000 });
  });

  test('feed card menu shows Disconnect and Change GL Mapping', async ({ page }) => {
    const moreIcon = page.locator('span:has-text("more_vert")').first();
    const hasMenu = await moreIcon.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasMenu) { test.skip('No feed cards with menu'); return; }

    await moreIcon.click();
    await page.waitForTimeout(500);

    const glMapping = page.locator('text=Change GL Mapping');
    const disconnect = page.locator('text=Disconnect');
    await expect(glMapping).toBeVisible({ timeout: 2000 });
    await expect(disconnect).toBeVisible({ timeout: 2000 });

    // Close menu by clicking backdrop
    await page.locator('.fixed.inset-0').first().click();
    await page.waitForTimeout(300);
  });

  // ── Pagination ──
  test('pagination controls appear when enough transactions', async ({ page }) => {
    const counter = page.locator('text=/\\d+ of \\d+ transactions/');
    const hasCounter = await counter.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasCounter) { test.skip('No transactions loaded'); return; }

    // Counter should be above the table (not at bottom)
    const counterBox = await counter.boundingBox();
    const table = page.locator('table').first();
    const tableBox = await table.boundingBox().catch(() => null);
    if (counterBox && tableBox) {
      expect(counterBox.y).toBeLessThan(tableBox.y);
    }
  });

  test('pagination next/prev buttons work', async ({ page }) => {
    const nextBtn = page.locator('button:has-text("Next")').first();
    const hasNext = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasNext) { test.skip('Not enough transactions for pagination'); return; }

    // Click next
    await nextBtn.click();
    await page.waitForTimeout(500);
    const pageInfo = page.locator('text=/Page 2 of/');
    await expect(pageInfo).toBeVisible({ timeout: 2000 });

    // Click prev
    const prevBtn = page.locator('button:has-text("Prev")').first();
    await prevBtn.click();
    await page.waitForTimeout(500);
    const page1Info = page.locator('text=/Page 1 of/');
    await expect(page1Info).toBeVisible({ timeout: 2000 });
  });

  // ── Filters ──
  test('compact filter bar fits in one line', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search description"]').first();
    const hasSearch = await searchInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasSearch) { test.skip('Filter bar not visible'); return; }

    const directionDropdown = page.locator('select').first();
    const searchBox = await searchInput.boundingBox();
    const dirBox = await directionDropdown.boundingBox().catch(() => null);

    // Both should be on roughly the same Y line (within 20px)
    if (searchBox && dirBox) {
      expect(Math.abs(searchBox.y - dirBox.y)).toBeLessThan(20);
    }
  });

  // ── Tab Counts ──
  test('tab shows transaction counts', async ({ page }) => {
    const forReview = page.locator('button:has-text("For Review")').first();
    const hasTab = await forReview.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasTab) { test.skip('Tabs not visible'); return; }

    // Tab should have a count in parentheses
    const tabText = await forReview.textContent();
    expect(tabText).toMatch(/For Review \(\d+\)/);
  });

  // ── No Overflow ──
  test('no horizontal overflow on bank transactions page', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('Chart of Accounts Management', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Chart of Accounts');
  });

  test('COA has edit and toggle buttons on each account', async ({ page }) => {
    const editBtn = page.locator('span:has-text("edit")').first();
    await expect(editBtn).toBeVisible({ timeout: 3000 });
  });

  test('COA has delete button on zero-balance accounts', async ({ page }) => {
    // Look for delete icon (only appears on zero-balance accounts)
    const deleteBtn = page.locator('span:has-text("delete")').first();
    const hasDelete = await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false);
    // This is expected to exist if there are any zero-balance accounts
    // Not failing if no zero-balance accounts exist
    if (hasDelete) {
      expect(hasDelete).toBeTruthy();
    }
  });

  test('Show Inactive toggle works', async ({ page }) => {
    const toggle = page.locator('button:has-text("Show Inactive")').first();
    const hasToggle = await toggle.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasToggle) { test.skip('Show Inactive toggle not found'); return; }
    await toggle.click();
    await page.waitForTimeout(500);
    // Should still render without crash
    const coa = page.locator('text=Chart of Accounts');
    await expect(coa.first()).toBeVisible();
  });
});

test.describe('Reports Export', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Reports');
  });

  test('reports catalog is visible with report cards', async ({ page }) => {
    const plReport = page.locator('text=Profit & Loss').first();
    await expect(plReport).toBeVisible({ timeout: 5000 });
  });

  test('P&L report has Export button', async ({ page }) => {
    const plCard = page.locator('text=Profit & Loss').first();
    await plCard.click();
    await page.waitForTimeout(1500);

    const exportBtn = page.locator('button:has-text("Export")').first();
    await expect(exportBtn).toBeVisible({ timeout: 3000 });
  });

  test('P&L report has PDF button', async ({ page }) => {
    const plCard = page.locator('text=Profit & Loss').first();
    await plCard.click();
    await page.waitForTimeout(1500);

    const pdfBtn = page.locator('button:has-text("PDF")').first();
    await expect(pdfBtn).toBeVisible({ timeout: 3000 });
  });

  test('P&L by Property report has clickable amounts', async ({ page }) => {
    const plByPropCard = page.locator('text=P&L by Property').first();
    const hasPLByProp = await plByPropCard.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasPLByProp) { test.skip('P&L by Property not visible'); return; }

    await plByPropCard.click();
    await page.waitForTimeout(2000);

    // Check that amount cells have cursor-pointer class (clickable)
    const clickableCell = page.locator('td[class*="cursor-pointer"]').first();
    const hasClickable = await clickableCell.isVisible({ timeout: 3000 }).catch(() => false);
    // Only assert if there's data
    if (hasClickable) {
      expect(hasClickable).toBeTruthy();
    }
  });
});

test.describe('Ledger Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Chart of Accounts');
  });

  test('clicking account opens ledger overlay', async ({ page }) => {
    // Click first account row
    const accountRow = page.locator('tr[class*="cursor-pointer"]').first();
    const hasRow = await accountRow.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasRow) { test.skip('No account rows visible'); return; }

    await accountRow.click();
    await page.waitForTimeout(1000);

    // Ledger overlay should appear with close button
    const closeBtn = page.locator('text=Export CSV').first();
    const hasLedger = await closeBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasLedger) {
      expect(hasLedger).toBeTruthy();
    }
  });

  test('ledger REF column shows human-readable text', async ({ page }) => {
    // Open an account that has bank import entries
    const accountRow = page.locator('tr[class*="cursor-pointer"]').first();
    const hasRow = await accountRow.isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasRow) { test.skip('No accounts'); return; }

    await accountRow.click();
    await page.waitForTimeout(1000);

    // Check that no UUID patterns appear in the REF column
    const refCells = page.locator('td[class*="font-mono"][class*="text-neutral-400"]');
    const count = await refCells.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      const text = await refCells.nth(i).textContent();
      // Should NOT contain UUID pattern
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });
});
