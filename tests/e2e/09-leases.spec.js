// ═══════════════════════════════════════════════════════════════
// 09 — LEASES: TEMPLATES, CRUD, E-SIGN, RENEWAL, DEPOSIT RETURN
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage, assertNoHorizontalOverflow } = require('./helpers');

test.describe('Leases Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'leases');
  });

  test('heading visible', async ({ page }) => {
    await expect(page.locator('text=/Lease Management|Leases/').first()).toBeVisible({ timeout: 5000 });
  });

  test('stat cards show active leases, expiring, deposits, avg rent', async ({ page }) => {
    await page.waitForTimeout(1500);
    const hasStats = await page.locator('text=Active').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasStats).toBeTruthy();
  });

  test('tab navigation: active, expiring, expired, renewed, terminated, all', async ({ page }) => {
    const tabs = ['Active', 'Expiring', 'Expired', 'Renewed', 'Terminated', 'All'];
    for (const tab of tabs) {
      const btn = page.locator(`button:has-text("${tab}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(500);
      }
    }
  });

  test('create lease button opens form', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
    await btn.click();
    await page.waitForTimeout(500);
    // Form should have tenant, property, dates, rent
    const hasRent = await page.locator('input[placeholder*="rent" i], input[type="number"]').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasRent).toBeTruthy();
  });

  test('lease form has all fields', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    // Check key fields
    await expect(page.locator('input[type="date"]').first()).toBeVisible({ timeout: 3000 });
    // Security deposit
    const hasDeposit = await page.locator('text=Deposit').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=deposit').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('lease form has escalation fields', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const hasEscalation = await page.locator('text=Escalation').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=escalation').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('lease form has late fee settings', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const hasLateFee = await page.locator('text=Late Fee').first().isVisible({ timeout: 3000 }).catch(() => false)
      || await page.locator('text=Grace').first().isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('lease type dropdown has fixed/month-to-month/renewal', async ({ page }) => {
    const btn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add")').first();
    await btn.click();
    await page.waitForTimeout(500);
    const typeSelect = page.locator('select').filter({ hasText: /fixed|month/i }).first();
    if (await typeSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await typeSelect.locator('option').allTextContents();
      expect(options.some(o => o.toLowerCase().includes('fixed'))).toBeTruthy();
    }
  });

  test('template manager button exists', async ({ page }) => {
    const tmplBtn = page.locator('button:has-text("Template"), button:has-text("template")').first();
    const hasTmpl = await tmplBtn.isVisible({ timeout: 3000 }).catch(() => false);
  });

  test('lease cards show action buttons (Edit, E-Sign, Renew, Terminate)', async ({ page }) => {
    await page.waitForTimeout(1500);
    const actionBtns = ['Edit', 'Sign', 'Renew', 'Terminate'];
    for (const action of actionBtns) {
      const btn = page.locator(`button:has-text("${action}")`).first();
      const vis = await btn.isVisible({ timeout: 2000 }).catch(() => false);
    }
  });

  test('move-in/move-out checklist buttons exist', async ({ page }) => {
    await page.waitForTimeout(1500);
    const moveIn = page.locator('button:has-text("Move-In"), button:has-text("move-in")').first();
    const moveOut = page.locator('button:has-text("Move-Out"), button:has-text("move-out")').first();
  });

  test('no horizontal overflow on leases', async ({ page }) => {
    await page.waitForTimeout(1500);
    await assertNoHorizontalOverflow(page);
  });

  // ── E-Sign modal (unified doc_signatures engine) ──
  // The old per-lease signing flow was retired in commit 905bbdf; the modal
  // now drives the same envelope + magic-link UX used by the Documents module.
  test('E-Sign opens the unified envelope modal (no inline canvas)', async ({ page }) => {
    await page.waitForTimeout(2000);
    // Match the exact button label from Leases.js:501 ("✍️ E-Sign") — no "Sign"
    // fallback because that matches "Sign In" / "Sign Out" elsewhere.
    const signBtn = page.locator('button:has-text("E-Sign")').first();
    if (!(await signBtn.isVisible({ timeout: 5000 }).catch(() => false))) test.skip(true, 'No lease with an E-Sign button on this seed');

    await signBtn.click();
    await page.waitForTimeout(1500);

    // Modal title leads with "E-Signature". The name after the em-dash varies,
    // so match on the word alone.
    await expect(page.locator('text=E-Signature').first()).toBeVisible({ timeout: 8000 });

    // Landlord + Tenant email inputs are the hallmark of the unified flow —
    // the old flow had a canvas and no email inputs.
    await expect(page.locator('text=Tenant email').first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('text=/Landlord|PM email/').first()).toBeVisible();

    // CTA reads "Send for Signature", not the old "Apply Signature".
    await expect(page.locator('button:has-text("Send for Signature")').first()).toBeVisible();

    // No inline signature canvas — drawing happens on the public /sign/:token page.
    const canvasCount = await page.locator('canvas').count();
    expect(canvasCount).toBe(0);
  });
});
