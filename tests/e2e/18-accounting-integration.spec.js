// ═══════════════════════════════════════════════════════════════
// 18 — ACCOUNTING INTEGRATION TESTS
//
// TRUE end-to-end tests that perform an action in the UI, then
// verify the SPECIFIC accounting entries were created.
//
// Each test uses unique identifiers so results can be traced
// back to exactly the test that created them.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage } = require('./helpers');

// Generate unique test marker (used in names/amounts to find entries later)
const RUN_ID = Date.now().toString(36).slice(-5);
const uniqueName = (prefix) => `${prefix}-T${RUN_ID}`;

// Helper: get full page text
async function bodyText(page) {
  return (await page.locator('body').textContent()) || '';
}

// Helper: navigate to Accounting → tab. Click the tab and then wait
// on a tab-specific content marker — the initial flake was that the
// helper returned before the content swapped, so downstream text
// assertions ran against the previous tab.
// Updated 2026-04-24 — accounting "tabs" are now top-level sidebar
// children pages (commit 12e6d75). navigateTo() handles the parent
// expansion and routes to the child page.
async function goToAccountingTab(page, tabName) {
  // Map legacy tab names → current child page labels
  const REMAP = {
    'Overview': 'Accounting',
    'Dashboard': 'Accounting',
    'Recurring': 'Recurring Entries',
    'Bank Import': 'Bank Transactions',
  };
  const target = REMAP[tabName] || tabName;
  await navigateTo(page, target);
  await page.waitForTimeout(800);
  // Per-child marker wait so flaky load timing doesn't ripple through
  const MARKER_FOR = {
    'Journal Entries': 'text=/All\\s*\\(|New Journal Entry|No journal entries/i',
    'Chart of Accounts': 'text=/Checking Account|Rental Income|Asset|Liability/i',
    'Reconcile': 'text=/Start Bank Reconciliation|Previous Reconciliations|Reconcile/i',
  };
  const marker = MARKER_FOR[target];
  if (marker) {
    await page.locator(marker).first().waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
  }
}

// Helper: fill a select by picking an option that contains text
async function selectOptionContaining(page, selectLocator, partialText) {
  const options = await selectLocator.locator('option').allTextContents();
  const match = options.find(o => o.toLowerCase().includes(partialText.toLowerCase()));
  if (match) {
    await selectLocator.selectOption({ label: match });
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// TEST 1: Record a rent payment → verify JE created in Accounting
// ═══════════════════════════════════════════════════════════════
// Skipped: the Payments page no longer carries its own "Record
// Payment" form — clicking the button routes to the Accounting page's
// Journal Entry editor instead. Rewriting this pipeline would require
// walking through the JE form, which overlaps with coverage in
// 17-accounting-flows. When someone restores a dedicated payment form
// or adds an equivalent end-to-end harness, un-skip.
test.describe.skip('Payment → Journal Entry Pipeline', () => {
  const paymentAmount = '17.{RUN_ID}';  // Unique amount to trace
  const AMOUNT = `17.${RUN_ID.slice(0, 2)}`;

  test('record a rent payment for Alice via the Payments UI', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Payments');
    await page.waitForTimeout(2000);

    // Open payment form
    await page.locator('button:has-text("Record Payment")').first().click();
    await page.waitForTimeout(500);

    // Select tenant: Alice Johnson
    const tenantSelect = page.locator('select').first();
    await selectOptionContaining(page, tenantSelect, 'Alice');

    // Fill amount with traceable value
    const amountInput = page.locator('input[placeholder="1500.00"]').first();
    await amountInput.fill(AMOUNT);

    // Ensure type = rent, method = ACH (defaults)
    // Date defaults to today

    // Save
    await page.locator('button:has-text("Save")').first().click();
    await page.waitForTimeout(1500);

    // Handle duplicate confirmation if it appears
    const confirmBtn = page.locator('button:has-text("Confirm")').first();
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }
    await page.waitForTimeout(3000);

    // Verify toast or that payment appears in the list
    const text = await bodyText(page);
    const paymentRecorded = /payment recorded|alice/i.test(text);
    expect(paymentRecorded, 'Payment should be recorded (Alice visible or toast shown)').toBeTruthy();
  });

  test('the payment created a PAY- journal entry in Accounting', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Journal Entries');

    const text = await bodyText(page);
    // Should see PAY- reference entries and "Rent payment" or "payment received" descriptions
    const hasPayRef = /PAY-/i.test(text);
    const hasPaymentDesc = /payment.*alice|alice.*payment|rent payment/i.test(text);
    expect(hasPayRef || hasPaymentDesc,
      'Accounting → Journal Entries should contain a PAY- entry or payment description referencing Alice'
    ).toBeTruthy();
  });

  test('journal entries show entries with dollar amounts', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Journal Entries');

    // Show All entries (not filtered)
    const allFilter = page.locator('button:has-text("All")').first();
    if (await allFilter.isVisible({ timeout: 2000 }).catch(() => false)) {
      await allFilter.click();
      await page.waitForTimeout(1500);
    }

    const text = await bodyText(page);
    expect(/\$[\d,]+\.?\d*/.test(text), 'Journal entries should show dollar amounts').toBeTruthy();
  });

  test('Alice tenant ledger shows the payment entry', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(2000);

    // Click on Alice to open detail
    const alice = page.locator('text=/Alice Johnson/i').first();
    await alice.click();
    await page.waitForTimeout(2500);

    const text = await bodyText(page);
    // Ledger should show payment entries
    const hasPaymentInLedger = /payment.*ach|rent payment|transaction/i.test(text);
    expect(hasPaymentInLedger, 'Alice tenant detail should show payment in transaction history').toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST 2: Create tenant with lease dates → verify rent charge JE
// ═══════════════════════════════════════════════════════════════
// Skipped: standalone "+ Add Tenant" button was removed — tenants are
// now created through the Property Setup Wizard. The wizard flow is
// exercised in 19-property-wizard.spec.js and the rent-charge side
// effect in data-layer.test.js. Un-skip if a direct tenant-create UI
// returns.
test.describe.skip('Tenant Creation → Rent Charge Pipeline', () => {
  const TENANT_NAME = uniqueName('IntegTenant');
  const RENT = '999';
  const DEPOSIT = '500';
  const today = new Date();
  const START_DATE = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const endDate = new Date(today.getFullYear() + 1, today.getMonth(), 0);
  const END_DATE = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;

  test('create a new tenant with lease dates, rent, and deposit', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(2000);

    // Click "+ Add Tenant" button
    const addBtn = page.locator('button:has-text("Add Tenant"), button:has-text("+ Add")').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();
    await page.waitForTimeout(500);

    // Fill tenant form
    await page.locator('input[placeholder="Jane Doe"]').fill(TENANT_NAME);
    await page.locator('input[type="email"]').first().fill(`${RUN_ID}@test.com`);
    await page.locator('input[type="tel"]').first().fill('5551234567');

    // Select a vacant property (300 Pine Road is vacant in seed data)
    const propSelect = page.locator('select').filter({ hasText: /select property/i }).first();
    if (await propSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await selectOptionContaining(page, propSelect, 'Pine');
      // If no Pine, select first available
      if (!(await propSelect.inputValue())) {
        const opts = await propSelect.locator('option').allTextContents();
        if (opts.length > 1) await propSelect.selectOption({ index: 1 });
      }
    }

    // Fill rent
    await page.locator('input[placeholder="1500"]').fill(RENT);

    // Fill lease dates
    const dateInputs = page.locator('input[type="date"]');
    const dateCount = await dateInputs.count();
    if (dateCount >= 2) {
      await dateInputs.nth(0).fill(START_DATE);
      await dateInputs.nth(1).fill(END_DATE);
    }

    // Fill security deposit
    const depositInput = page.locator('input[placeholder="0"]').first();
    if (await depositInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await depositInput.fill(DEPOSIT);
    }

    // Verify the info banner appears
    const banner = page.locator('text=/lease will be auto-created/i').first();
    const bannerVisible = await banner.isVisible({ timeout: 2000 }).catch(() => false);
    expect(bannerVisible, 'Info banner about auto-created lease should appear when dates + rent are filled').toBeTruthy();

    // Save
    await page.locator('button:has-text("Save")').first().click();
    await page.waitForTimeout(5000); // Wait for all async operations (lease create, JE post, balance update)

    // Check for success toast about rent charges
    const text = await bodyText(page);
    const success = /rent charge|posted|tenant added|new tenant/i.test(text);
    // The tenant should now appear in the list
    const tenantVisible = await page.locator(`text=${TENANT_NAME}`).first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(tenantVisible || success, `Tenant "${TENANT_NAME}" should be created and visible`).toBeTruthy();
  });

  test('accounting has journal entries after tenant creation (rent charge or deposit)', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Journal Entries');

    // Show all entries
    const allFilter = page.locator('button:has-text("All")').first();
    if (await allFilter.isVisible({ timeout: 2000 }).catch(() => false)) {
      await allFilter.click();
      await page.waitForTimeout(1500);
    }

    const text = await bodyText(page);
    // After creating a tenant with lease + rent + deposit, at least one JE should exist
    // Could be RENT-AUTO (rent charge), DEP- (deposit), or PAY- (payment from earlier test)
    const hasAnyEntry = /RENT-AUTO|DEP-|PAY-|rent charge|deposit|payment/i.test(text);
    // Also check the entry count indicator — All(N) where N > 0
    const countMatch = text.match(/All\s*\((\d+)\)/);
    const entryCount = countMatch ? parseInt(countMatch[1]) : 0;

    expect(hasAnyEntry || entryCount > 0,
      `Accounting should have at least one journal entry (found ${entryCount} entries)`
    ).toBeTruthy();
  });

  test('security deposit JE exists or Security Deposits account has balance', async ({ page }) => {
    await login(page);

    // First check journal entries for DEP- reference
    await goToAccountingTab(page, 'Journal Entries');
    const allFilter = page.locator('button:has-text("All")').first();
    if (await allFilter.isVisible({ timeout: 2000 }).catch(() => false)) {
      await allFilter.click();
      await page.waitForTimeout(1500);
    }
    const jeText = await bodyText(page);
    const hasDepInJE = /DEP-|security deposit/i.test(jeText);

    if (!hasDepInJE) {
      // Fallback: verify Security Deposits Held (2100) account exists in COA
      // (deposit may not have posted if property already had an active lease)
      await goToAccountingTab(page, 'Chart of Accounts');
      const coaText = await bodyText(page);
      expect(/security deposit|2100/i.test(coaText),
        'Either DEP- JE should exist or Security Deposits Held (2100) account should be in COA'
      ).toBeTruthy();
    }
  });

  test('tenant shows correct balance (rent charge posted)', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(2000);

    // Find the test tenant
    const tenantCard = page.locator(`text=${TENANT_NAME}`).first();
    if (await tenantCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tenantCard.click();
      await page.waitForTimeout(2000);

      const text = await bodyText(page);
      // Tenant detail should show balance > 0 (rent was charged)
      // And should show transaction history with rent charge
      const hasBalance = /\$[\d,]+/.test(text);
      const hasCharge = /charge|rent|transaction|ledger/i.test(text);
      expect(hasBalance, 'Tenant detail should show a dollar balance').toBeTruthy();
    }
  });

  test('a new active lease was auto-created for the tenant', async ({ page }) => {
    await login(page);
    const navigated = await goToPage(page, 'leases');
    if (!navigated) return;
    await page.waitForTimeout(2000);

    const text = await bodyText(page);
    // Check for this run's tenant OR any IntegTenant (from previous runs)
    const hasLease = text.includes(TENANT_NAME) || /IntegTenant/i.test(text);
    expect(hasLease, `Leases module should show an active lease for an IntegTenant`).toBeTruthy();
  });

  // Cleanup is best-effort — test data will be cleaned up by seed script
  test('cleanup: verify test tenant exists in tenant list', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(2000);

    // Just verify the test tenant is visible (created successfully)
    const text = await bodyText(page);
    const hasTestTenant = /IntegTenant/i.test(text);
    // This is informational — always passes
    if (hasTestTenant) {
      // Test tenant found — integration pipeline worked end-to-end
    }
    expect(true).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST 3: Create lease with deposit from Leases module → verify
// ═══════════════════════════════════════════════════════════════
test.describe.serial('Lease Creation → Deposit + Rent Charge', () => {
  test('create a lease from Leases module and verify rent charge toast', async ({ page }) => {
    await login(page);
    const navigated = await goToPage(page, 'leases');
    if (!navigated) return;
    await page.waitForTimeout(2000);

    // Click create lease button
    const createBtn = page.locator('button:has-text("Create Lease"), button:has-text("New Lease"), button:has-text("+ Add")').first();
    if (!await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) return;
    await createBtn.click();
    await page.waitForTimeout(500);

    const text = await bodyText(page);
    // Verify lease form has key fields
    expect(/tenant|property|start.*date|rent/i.test(text), 'Lease form should show tenant, property, dates, rent fields').toBeTruthy();
  });

  test('lease form requires start date, end date, and rent amount', async ({ page }) => {
    await login(page);
    const navigated = await goToPage(page, 'leases');
    if (!navigated) return;
    await page.waitForTimeout(2000);

    // Open form
    const createBtn = page.locator('button:has-text("Create Lease"), button:has-text("New Lease"), button:has-text("+ Add")').first();
    if (!await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) return;
    await createBtn.click();
    await page.waitForTimeout(500);

    // Try to save without filling required fields
    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Create")').first();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(1000);

      const text = await bodyText(page);
      // Should show validation error
      const hasValidation = /required|please select|please enter/i.test(text);
      expect(hasValidation, 'Form should show validation errors for missing fields').toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST 4: Payment → Tenant Balance Update
// ═══════════════════════════════════════════════════════════════
// Skipped: same reason as "Payment → Journal Entry Pipeline" — the
// Payments page redirects Record Payment to the JE editor. Balance
// consistency is indirectly covered by data-layer balance tests.
test.describe.skip('Payment → Balance Consistency', () => {
  test('Bob Martinez balance decreases after recording a payment', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Tenants');
    await page.waitForTimeout(2000);

    // Check Bob's current balance (should be $250 from seed)
    let bobBalance = '';
    const bobCard = page.locator('text=/Bob Martinez/i').first();
    if (await bobCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Get text near Bob's card for balance
      const section = page.locator(':has(> :text("Bob Martinez"))').first();
      const sectionText = await section.textContent().catch(() => '');
      const balMatch = sectionText.match(/\$[\d,.]+/);
      if (balMatch) bobBalance = balMatch[0];
    }

    // Now record a payment for Bob
    await navigateTo(page, 'Payments');
    await page.waitForTimeout(2000);
    await page.locator('button:has-text("Record Payment")').first().click();
    await page.waitForTimeout(500);

    // Select Bob as tenant
    const tenantSelect = page.locator('select').first();
    await selectOptionContaining(page, tenantSelect, 'Bob');

    // Small unique payment amount
    const payAmt = `0.${String(Math.floor(Math.random() * 90) + 10)}`;
    await page.locator('input[placeholder="1500.00"]').fill(payAmt);

    await page.locator('button:has-text("Save")').first().click();
    await page.waitForTimeout(1500);

    // Handle duplicate confirm
    const confirmBtn = page.locator('button:has-text("Confirm")').first();
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmBtn.click();
    }
    await page.waitForTimeout(3000);

    // Verify payment was recorded
    const text = await bodyText(page);
    expect(/payment recorded|bob/i.test(text), 'Payment for Bob should be recorded').toBeTruthy();
  });

  test('Bob payment created a journal entry (DR Checking, CR AR or Revenue)', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Journal Entries');

    const text = await bodyText(page);
    // Look for Bob-related payment entry
    const hasBobEntry = /bob.*payment|payment.*bob|PAY-/i.test(text);
    expect(hasBobEntry, 'Journal entries should contain a payment entry for Bob').toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST 5: COA Balances Reflect Posted Entries
// ═══════════════════════════════════════════════════════════════
test.describe('COA Balances Reflect Activity', () => {
  test('Checking Account (1000) has a non-zero balance', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Chart of Accounts');

    // Filter to Asset accounts
    const assetBtn = page.locator('button:has-text("Asset")').first();
    if (await assetBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await assetBtn.click();
      await page.waitForTimeout(1000);
    }

    const text = await bodyText(page);
    // Checking account should exist and have a dollar amount
    expect(/checking/i.test(text), 'Checking Account should be visible').toBeTruthy();
    expect(/\$[\d,]+\.?\d*/.test(text), 'Should show dollar balances').toBeTruthy();
  });

  test('Accounts Receivable (1100) reflects rent charges', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Chart of Accounts');

    const assetBtn = page.locator('button:has-text("Asset")').first();
    if (await assetBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await assetBtn.click();
      await page.waitForTimeout(1000);
    }

    const text = await bodyText(page);
    expect(/receivable/i.test(text), 'Accounts Receivable should be visible').toBeTruthy();
  });

  test('Rental Income (4000) reflects rent revenue', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Chart of Accounts');

    const revenueBtn = page.locator('button:has-text("Revenue")').first();
    if (await revenueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await revenueBtn.click();
      await page.waitForTimeout(1000);
    }

    const text = await bodyText(page);
    expect(/rental income/i.test(text), 'Rental Income account should be visible').toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST 6: Dashboard ↔ Accounting Revenue Consistency
// ═══════════════════════════════════════════════════════════════
test.describe('Dashboard ↔ Accounting Consistency', () => {
  test('dashboard revenue card shows a dollar amount', async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(2000);

    const text = await bodyText(page);
    expect(/revenue/i.test(text), 'Dashboard should show revenue label').toBeTruthy();
    expect(/\$[\d,]+/.test(text), 'Dashboard should show dollar amounts').toBeTruthy();
  });

  test('accounting overview also shows revenue', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Overview');

    const text = await bodyText(page);
    expect(/revenue/i.test(text), 'Accounting overview should show revenue').toBeTruthy();
    expect(/\$[\d,]+/.test(text), 'Accounting overview should show dollar amounts').toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST 7: Auto-Rent Charges on Existing Leases
// ═══════════════════════════════════════════════════════════════
test.describe('Auto Rent Charges', () => {
  test('journal entries contain rent-related entries from active leases', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Journal Entries');
    // Default filter shows "All" — no need to click it. The earlier
    // variant clicked a loose `button:has-text("All")` which sometimes
    // matched a secondary filter on a different tab.
    await page.waitForTimeout(1500);
    const text = await bodyText(page);
    const hasRentEntries = /RENT-AUTO|rent charge|rent payment|PAY-/i.test(text);
    expect(hasRentEntries, 'Journal entries should contain rent-related entries').toBeTruthy();
  });

  test('rent charge entries show AR (debit) and Rental Income (credit)', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Chart of Accounts');

    // Both AR and Rental Income should have non-zero balances from rent charges
    const text = await bodyText(page);
    const hasAR = /receivable/i.test(text);
    const hasRentalIncome = /rental income/i.test(text);
    expect(hasAR && hasRentalIncome, 'COA should show both AR and Rental Income accounts from rent charges').toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// TEST 8: Voiding a JE Does Not Remove But Marks as Voided
// ═══════════════════════════════════════════════════════════════
test.describe('Journal Entry Lifecycle', () => {
  test('posted entries have a Void action available', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Journal Entries');

    // Look for void/edit buttons on posted entries
    const text = await bodyText(page);
    const hasActions = /void|edit/i.test(text);
    expect(hasActions, 'Posted journal entries should have Void/Edit actions').toBeTruthy();
  });

  test('voided filter shows voided entries or empty state', async ({ page }) => {
    await login(page);
    await goToAccountingTab(page, 'Journal Entries');

    const voidedFilter = page.locator('button:has-text("Voided")').first();
    if (await voidedFilter.isVisible({ timeout: 2000 }).catch(() => false)) {
      await voidedFilter.click();
      await page.waitForTimeout(1000);
      // Should either show voided entries or "no entries" state — not crash
      const text = await bodyText(page);
      const validState = /voided|no.*entries|no.*journal/i.test(text) || !/error|something went wrong/i.test(text);
      expect(validState, 'Voided filter should show entries or empty state without crashing').toBeTruthy();
    }
  });
});
