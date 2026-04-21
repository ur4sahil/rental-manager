// ═══════════════════════════════════════════════════════════════
// Shared helpers for all E2E test files
// ═══════════════════════════════════════════════════════════════
const { expect } = require('@playwright/test');

/**
 * Login to the app with test credentials.
 * Handles landing → sign-in → company selector → dashboard flow.
 */
async function login(page) {
  await page.goto('/', { timeout: 30000 });

  // If already on dashboard (sidebar visible), skip
  if (await page.locator('button:has-text("Dashboard")').first().isVisible({ timeout: 2000 }).catch(() => false)) {
    return;
  }

  // Step 1: Click "Sign In" on landing page header
  await page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first().click();
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });

  // Step 2: Fill credentials
  await page.fill('input[type="email"]', process.env.TEST_EMAIL);
  await page.fill('input[type="password"]', process.env.TEST_PASSWORD);

  // Step 3: Submit — click the last "Sign In" button (the form submit, not header)
  await page.locator('button:has-text("Sign In")').last().click();

  // Step 4: Wait for company selector to appear
  // The company selector shows "YOUR COMPANIES" heading and company rows
  await page.locator('text=/YOUR COMPANIES|Your Companies|PropManager/i').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(1000);

  // Step 5: Click into Sandbox LLC. The clickable area is the outer
  // cursor-pointer <div onClick>, which wraps the avatar + name. Click
  // THAT div directly (not the inner name span) — clicks on nested
  // spans have been flaky when React rerenders mid-click. Retry up to
  // three times if the navigation to the app doesn't happen.
  const dashboardBtn = page.locator('button:has-text("Dashboard")').first();
  for (let attempt = 0; attempt < 3; attempt++) {
    const target = page.locator('div.cursor-pointer:has-text("Sandbox")').first();
    const fallback = page.locator('.font-semibold:has-text("Sandbox")').first();
    if (await target.isVisible({ timeout: 2000 }).catch(() => false)) {
      await target.click();
    } else if (await fallback.isVisible({ timeout: 1500 }).catch(() => false)) {
      await fallback.click();
    } else {
      // Last resort: first cursor-pointer row
      const firstCompany = page.locator('div.cursor-pointer:has(.font-semibold)').first();
      if (await firstCompany.isVisible({ timeout: 1500 }).catch(() => false)) await firstCompany.click();
    }
    if (await dashboardBtn.isVisible({ timeout: 15000 }).catch(() => false)) return;
  }
  // Final wait with a longer budget — if this throws the test fails
  // loudly rather than passing a wrong page snapshot.
  await dashboardBtn.waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Navigate to a sidebar module by label text.
 *
 * Sidebar was reorganized: Maintenance, Utilities, HOA Payments, Loans,
 * Insurance, Tax Bills, and Inspections are now nested under a
 * collapsed "Properties" expander. Clicking their buttons fails until
 * the parent is expanded. This helper auto-expands when the target
 * isn't visible.
 */
const NESTED_UNDER_PROPERTIES = new Set([
  'Maintenance', 'Utilities', 'HOA Payments', 'Loans',
  'Insurance', 'Tax Bills', 'Inspections',
]);

async function navigateTo(page, label) {
  // On mobile: open hamburger first
  const hamburger = page.locator('button:has-text("menu")').first();
  if (await hamburger.isVisible({ timeout: 1000 }).catch(() => false)) {
    await hamburger.click();
    await page.waitForTimeout(300);
  }
  const target = page.locator(`button:has-text("${label}")`).first();
  // If target isn't visible and it's known-nested under Properties,
  // expand the Properties group first.
  if (NESTED_UNDER_PROPERTIES.has(label) && !await target.isVisible({ timeout: 1000 }).catch(() => false)) {
    const chevron = page.locator('button:has(span:has-text("expand_more"))').first();
    if (await chevron.isVisible({ timeout: 1000 }).catch(() => false)) {
      await chevron.click();
      await page.waitForTimeout(400);
    }
  }
  await target.click();
  await page.waitForTimeout(1500);
}

/**
 * Assert no console errors on page (ignores known noise)
 */
function collectConsoleErrors(page) {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore known noise
      if (text.includes('favicon') || text.includes('manifest') || text.includes('service-worker')) return;
      errors.push(text);
    }
  });
  return errors;
}

/**
 * Assert no horizontal overflow (nothing bleeding off-screen)
 */
async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(overflow, 'Page should not have horizontal overflow / bleed').toBeFalsy();
}

/**
 * Assert no overlapping z-index issues with modals
 */
async function assertModalIsTopLayer(page, modalSelector) {
  const isOnTop = await page.evaluate((sel) => {
    const modal = document.querySelector(sel);
    if (!modal) return true; // no modal = pass
    const rect = modal.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topEl = document.elementFromPoint(centerX, centerY);
    return modal.contains(topEl);
  }, modalSelector);
  expect(isOnTop, `Modal ${modalSelector} should be the top element`).toBeTruthy();
}

/**
 * Assert every visible button is actually clickable (not hidden behind something)
 */
async function assertButtonsClickable(page) {
  const buttons = page.locator('button:visible');
  const count = await buttons.count();
  for (let i = 0; i < Math.min(count, 50); i++) {
    const btn = buttons.nth(i);
    const isEnabled = await btn.isEnabled().catch(() => true);
    if (!isEnabled) continue;
    const box = await btn.boundingBox();
    if (!box) continue;
    // Check element is within viewport
    const vp = page.viewportSize();
    expect(box.x + box.width > 0, `Button ${i} not off-screen left`).toBeTruthy();
    expect(box.y + box.height > 0, `Button ${i} not off-screen top`).toBeTruthy();
    if (vp) {
      expect(box.x < vp.width + 10, `Button ${i} not off-screen right`).toBeTruthy();
    }
  }
}

/**
 * Check text is not visually truncated with ellipsis (when it shouldn't be)
 */
async function assertNoUnexpectedTruncation(page, selector) {
  const truncated = await page.evaluate((sel) => {
    const els = document.querySelectorAll(sel);
    let issues = [];
    els.forEach(el => {
      if (el.scrollWidth > el.clientWidth + 2) {
        const style = getComputedStyle(el);
        if (style.overflow === 'hidden' && style.textOverflow !== 'ellipsis') {
          issues.push(el.textContent.substring(0, 40));
        }
      }
    });
    return issues;
  }, selector);
  return truncated;
}

/**
 * Navigate to a page that may not be in the sidebar.
 * Uses sidebar button if available, otherwise falls back to:
 * - History icon for audit trail
 * - Bell → View All for notifications
 * - Direct React state injection for hidden pages (leases, documents, vendors, etc.)
 */
async function goToPage(page, pageId) {
  // Map of page IDs to sidebar labels
  const sidebarMap = {
    dashboard: 'Dashboard', properties: 'Properties', tenants: 'Tenants',
    payments: 'Payments', accounting: 'Accounting', owners: 'Owners',
    doc_builder: 'Document Builder', notifications: 'Notifications',
    messages: 'Messages',
  };

  // Nested sidebar items (under Properties expand)
  const nestedSidebarMap = {
    maintenance: 'Maintenance', utilities: 'Utilities', hoa: 'HOA Payments',
    loans: 'Loans', insurance: 'Insurance', inspections: 'Inspections',
  };

  if (sidebarMap[pageId]) {
    await navigateTo(page, sidebarMap[pageId]);
    return true;
  }

  // For nested items, expand Properties first then click child
  if (nestedSidebarMap[pageId]) {
    // Click the expand chevron on Properties
    const chevron = page.locator('button:has(span:has-text("expand_more"))').first();
    if (await chevron.isVisible({ timeout: 2000 }).catch(() => false)) {
      await chevron.click();
      await page.waitForTimeout(500);
    }
    await navigateTo(page, nestedSidebarMap[pageId]);
    return true;
  }

  // Admin page: route via hash (same mechanism the sidebar uses).
  // Previous approach tried to click a button[title="Admin Settings"]
  // that doesn't exist — the real entry is the avatar dropdown in the
  // header ("A Admin expand_more" → Settings menu item → setPage("admin")).
  if (pageId === 'admin' || pageId === 'audittrail' || pageId === 'roles') {
    await page.evaluate(() => {
      window.history.pushState({ page: 'admin', screen: 'app' }, '', '#admin');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'admin', screen: 'app' } }));
    });
    await page.waitForTimeout(1500);
    if (pageId === 'roles') {
      const teamTab = page.locator('button:has-text("Team & Roles")').first();
      if (await teamTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await teamTab.click();
        await page.waitForTimeout(1000);
      }
    }
    return true;
  }

  // Hidden pages (leases, documents, vendors, inspections, autopay,
  // moveout, evictions, latefees) — no sidebar link, but App.js routes
  // via window.location.hash. Navigate by setting the hash + firing a
  // hashchange event so React's route subscriber picks it up. Much more
  // reliable than the previous React-fiber-walk approach which depended
  // on specific internal hook ordering.
  const routableHiddenPages = new Set([
    'leases', 'documents', 'vendors', 'inspections', 'autopay',
    'moveout', 'evictions', 'latefees', 'tax_bills', 'tasks',
  ]);
  if (routableHiddenPages.has(pageId)) {
    await page.evaluate((hash) => {
      window.history.pushState({ page: hash, screen: 'app' }, '', '#' + hash);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      window.dispatchEvent(new PopStateEvent('popstate', { state: { page: hash, screen: 'app' } }));
    }, pageId);
    await page.waitForTimeout(2000);
    return true;
  }

  // Last resort: try clicking any button with the page name
  const btn = page.locator(`button:has-text("${pageId}")`).first();
  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(1500);
    return true;
  }

  return false;
}

/**
 * Detect toast notifications (replaced native alert/confirm).
 * Toasts render in a fixed container at bottom-right with type-specific classes.
 */
async function waitForToast(page, { type, textContains, timeout = 3000 } = {}) {
  // Toast container: fixed bottom-4 right-4 z-[100]
  const toastSelector = type
    ? `[class*="z-\\[100\\]"] [class*="${type === 'error' ? 'red' : type === 'success' ? 'emerald' : type === 'warning' ? 'amber' : 'white'}"]`
    : '[class*="z-\\[100\\]"] [class*="rounded-2xl"]';
  try {
    const toast = page.locator(toastSelector).first();
    await toast.waitFor({ state: 'visible', timeout });
    if (textContains) {
      const text = await toast.textContent();
      return text && text.toLowerCase().includes(textContains.toLowerCase());
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect custom confirmation modal (replaced native window.confirm).
 * Confirm modal renders with z-[90] and has Confirm/Cancel buttons.
 */
async function waitForConfirmModal(page, timeout = 3000) {
  try {
    const modal = page.locator('[class*="z-\\[90\\]"]').first();
    await modal.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Click confirm or cancel on the custom confirmation modal.
 */
async function respondToConfirmModal(page, confirm = true) {
  const modal = page.locator('[class*="z-\\[90\\]"]').first();
  if (await modal.isVisible({ timeout: 2000 }).catch(() => false)) {
    if (confirm) {
      await modal.locator('button:has-text("Confirm"), button:has-text("Delete"), button:has-text("OK")').first().click();
    } else {
      await modal.locator('button:has-text("Cancel")').first().click();
    }
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

module.exports = {
  login,
  navigateTo,
  goToPage,
  collectConsoleErrors,
  assertNoHorizontalOverflow,
  assertModalIsTopLayer,
  assertButtonsClickable,
  assertNoUnexpectedTruncation,
  waitForToast,
  waitForConfirmModal,
  respondToConfirmModal,
};
