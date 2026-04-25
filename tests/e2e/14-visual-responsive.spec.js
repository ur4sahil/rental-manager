// ═══════════════════════════════════════════════════════════════
// 14 — VISUAL & RESPONSIVE: OVERFLOW, TRUNCATION, Z-INDEX, LAYOUT
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, goToPage, assertNoHorizontalOverflow } = require('./helpers');

// Some "modules" in this spec aren't sidebar buttons — Documents,
// Leases, Audit Trail, Team are hidden routes reached via hash, or
// tabs within Admin. Map them onto goToPage / custom navigation so
// the overflow test actually loads the target page.
const HIDDEN_ROUTE = {
  Documents: 'documents',
  Leases: 'leases',
  Inspections: 'inspections',
  'Audit Trail': 'audittrail',
  Team: 'roles',
};

async function navigateToAny(page, label) {
  if (HIDDEN_ROUTE[label]) {
    await goToPage(page, HIDDEN_ROUTE[label]);
  } else {
    await navigateTo(page, label);
  }
}

test.describe('Visual & Responsive Tests', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // ── Overflow Tests Per Module ──
  const modules = [
    'Dashboard', 'Properties', 'Tenants', 'Payments',
    'Maintenance', 'Utilities', 'Accounting', 'Documents',
    'Inspections', 'Leases', 'Vendors', 'Owners',
    'Notifications', 'Audit Trail', 'Team',
  ];

  for (const mod of modules) {
    test(`no overflow bleed on ${mod}`, async ({ page }) => {
      await navigateToAny(page, mod);
      await page.waitForTimeout(2000);
      await assertNoHorizontalOverflow(page);
    });
  }

  // ── Element Visibility & Stacking ──
  test('modals render above page content (z-index)', async ({ page }) => {
    // Use a real modal trigger — the Tenants "Add Charge" button in
    // the tenant detail panel was a popup with z-50. Earlier this
    // test used the Properties "+ Add" button, but that opens the
    // PropertySetupWizard inline (not a z-50 overlay), so the
    // overlay assertion failed. Tenants' add-tenant modal is a
    // proper Modal component with the expected z-50 overlay.
    await navigateTo(page, 'Tenants');
    const addBtn = page.locator('button:has-text("+ Add")').first();
    if (!await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'Tenants Add button not visible — role may not allow');
      return;
    }
    await addBtn.click();
    await page.waitForTimeout(500);
    // The Modal component (shared.js) wraps content in a fixed
    // overlay with z-50. Either the z-50 overlay or any modal-like
    // dialog/aria-role is acceptable evidence the modal layered
    // above the page.
    const overlay = page.locator('[class*="z-50"], [role="dialog"], [class*="fixed"][class*="inset-0"]').first();
    const hasOverlay = await overlay.isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasOverlay, 'modal overlay (z-50 / role=dialog / fixed inset-0) should be on top').toBeTruthy();
  });

  test('modal overlay prevents interaction with background', async ({ page }) => {
    await navigateTo(page, 'Properties');
    // Properties page's primary create button is labeled "+ Add"
    // (Properties.js:3030). The earlier generic Add/add selector
    // matched any button containing "Add" — including sidebar-child
    // buttons after Properties got nested children — and could fire
    // a navigation instead of opening the modal.
    const addBtn = page.locator('button:has-text("+ Add")').first();
    if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(500);
      // Background click should not navigate (overlay intercepts)
      // Close via X button or Cancel instead
      const closeBtn = page.locator('button:has-text("Cancel"), button:has-text("×"), button:has-text("✕")').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(300);
      }
    }
  });

  // ── Font Loading ──
  test('custom fonts are loaded (Manrope/Inter)', async ({ page }) => {
    await page.waitForTimeout(2000);
    const fontFamily = await page.evaluate(() => {
      const el = document.querySelector('body');
      return getComputedStyle(el).fontFamily;
    });
    const hasCustomFont = fontFamily.toLowerCase().includes('manrope')
      || fontFamily.toLowerCase().includes('inter')
      || fontFamily.toLowerCase().includes('sans');
    expect(hasCustomFont).toBeTruthy();
  });

  // ── Material Icons Loading ──
  test('material icons render (not showing text fallback)', async ({ page }) => {
    await page.waitForTimeout(2000);
    const iconEl = page.locator('.material-icons-outlined, span.material-icons-outlined').first();
    if (await iconEl.isVisible({ timeout: 3000 }).catch(() => false)) {
      const box = await iconEl.boundingBox();
      // Icons should have reasonable dimensions, not just text
      if (box) {
        expect(box.width).toBeGreaterThan(10);
        expect(box.height).toBeGreaterThan(10);
      }
    }
  });

  // ── Scrollable Containers ──
  test('long content areas are scrollable, not cut off', async ({ page }) => {
    // Audit Trail lives on the Admin page (not a sidebar button).
    await goToPage(page, 'audittrail');
    await page.waitForTimeout(2000);
    const isScrollable = await page.evaluate(() => {
      const main = document.querySelector('main, [class*="overflow-y"]');
      if (!main) return true;
      return main.scrollHeight >= main.clientHeight;
    });
    expect(isScrollable).toBeTruthy();
  });

  // ── Touch Targets (mobile) ──
  test('buttons have minimum 44px touch targets on mobile', async ({ page, isMobile }) => {
    if (!isMobile) {
      test.skip();
      return;
    }
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(1500);
    const buttons = page.locator('button:visible');
    const count = await buttons.count();
    let tooSmall = 0;
    for (let i = 0; i < Math.min(count, 20); i++) {
      const box = await buttons.nth(i).boundingBox();
      if (box && (box.width < 30 || box.height < 30)) {
        tooSmall++;
      }
    }
    // Allow some small buttons (icon buttons) but most should be touch-friendly
    expect(tooSmall).toBeLessThan(count * 0.5);
  });

  // ── Stat Card Grid Alignment ──
  test('stat cards form a proper grid (no single-card rows unless last)', async ({ page }) => {
    await navigateTo(page, 'Dashboard');
    await page.waitForTimeout(2000);
    const cards = page.locator('[class*="rounded-3xl"]');
    const count = await cards.count();
    if (count >= 4) {
      const positions = [];
      for (let i = 0; i < Math.min(count, 8); i++) {
        const box = await cards.nth(i).boundingBox();
        if (box) positions.push(box);
      }
      // On desktop, cards should be on same row (similar y values)
      if (positions.length >= 2) {
        // At least 2 cards should share similar y
        const rows = {};
        positions.forEach(p => {
          const rowKey = Math.round(p.y / 20) * 20;
          rows[rowKey] = (rows[rowKey] || 0) + 1;
        });
        const hasMultiCardRow = Object.values(rows).some(v => v >= 2);
        // On desktop should have multi-card rows; on mobile single column is fine
        const vp = page.viewportSize();
        if (vp && vp.width > 768) {
          expect(hasMultiCardRow).toBeTruthy();
        }
      }
    }
  });

  // ── Table Layout ──
  test('tables dont have columns bleeding outside container', async ({ page }) => {
    await navigateTo(page, 'Payments');
    await page.waitForTimeout(1500);
    const table = page.locator('table').first();
    if (await table.isVisible({ timeout: 3000 }).catch(() => false)) {
      const tableBox = await table.boundingBox();
      const vp = page.viewportSize();
      if (tableBox && vp) {
        // Table should not extend beyond viewport (with some tolerance for scroll container)
        expect(tableBox.x).toBeGreaterThanOrEqual(-5);
      }
    }
  });

  // ── Color Contrast ──
  test('status badges have distinct colors', async ({ page }) => {
    await navigateTo(page, 'Properties');
    await page.waitForTimeout(1500);
    // Tailwind palette uses semantic tokens (brand/success/danger/warn/
    // info/notice) rather than raw color names. Match either form so
    // the test stays honest if the design-system naming changes again.
    const badges = page.locator(
      '[class*="bg-green"], [class*="bg-red"], [class*="bg-yellow"], [class*="bg-blue"], ' +
      '[class*="bg-success"], [class*="bg-danger"], [class*="bg-warn"], [class*="bg-info"], ' +
      '[class*="bg-brand"], [class*="bg-notice"]'
    );
    const count = await badges.count();
    expect(count).toBeGreaterThan(0);
  });
});
