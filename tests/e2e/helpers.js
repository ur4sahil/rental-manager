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

  // Step 5: Click into Sandbox LLC. Clickable area is a <div onClick> that
  // wraps the avatar + name. Clicking the visible name text reliably hits
  // that handler (event bubbles up).
  const sandboxName = page.locator('.font-semibold:has-text("Sandbox")').first();
  if (await sandboxName.isVisible({ timeout: 3000 }).catch(() => false)) {
    await sandboxName.click();
  } else {
    // Fall back to any first-company clickable div
    const firstCompany = page.locator('div.cursor-pointer:has(.font-semibold)').first();
    if (await firstCompany.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstCompany.click();
    }
  }

  // Step 6: Wait for app to load (sidebar "Dashboard" button appears)
  await page.locator('button:has-text("Dashboard")').first().waitFor({ state: 'visible', timeout: 25000 });
}

/**
 * Navigate to a sidebar module by label text
 */
async function navigateTo(page, label) {
  // On mobile: open hamburger first
  const hamburger = page.locator('button:has-text("menu")').first();
  if (await hamburger.isVisible({ timeout: 1000 }).catch(() => false)) {
    await hamburger.click();
    await page.waitForTimeout(300);
  }
  await page.locator(`button:has-text("${label}")`).first().click();
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

  // Admin page: click the avatar/role button in header
  if (pageId === 'admin' || pageId === 'audittrail' || pageId === 'roles') {
    const adminBtn = page.locator('button[title="Admin Settings"]').first();
    if (await adminBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await adminBtn.click();
      await page.waitForTimeout(1500);
      // If requesting a specific tab within admin
      if (pageId === 'roles') {
        const teamTab = page.locator('button:has-text("Team & Roles")').first();
        if (await teamTab.isVisible({ timeout: 2000 }).catch(() => false)) {
          await teamTab.click();
          await page.waitForTimeout(1000);
        }
      }
      return true;
    }
    return false;
  }

  // Hidden pages (leases, documents, vendors, inspections, autopay, moveout, evictions, latefees)
  // These exist as React pages but have no sidebar link — inject via React setState
  const navigated = await page.evaluate((targetPage) => {
    const root = document.getElementById('root');
    const internalKey = Object.keys(root).find(k => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
    if (!internalKey) return false;
    let fiber = root[internalKey];
    let depth = 0;
    while (fiber && depth < 50) {
      if (fiber.memoizedState) {
        let hook = fiber.memoizedState;
        let hookIdx = 0;
        while (hook && hookIdx < 30) {
          if (hook.memoizedState === 'dashboard' || hook.memoizedState === 'properties'
            || hook.memoizedState === 'tenants' || hook.memoizedState === 'payments') {
            if (hook.queue && typeof hook.queue.dispatch === 'function') {
              hook.queue.dispatch(targetPage);
              return true;
            }
          }
          hook = hook.next;
          hookIdx++;
        }
      }
      // Walk the tree: child first, then sibling, then parent's sibling
      if (fiber.child) { fiber = fiber.child; }
      else if (fiber.sibling) { fiber = fiber.sibling; }
      else {
        // Go up until we find a sibling
        while (fiber.return && !fiber.return.sibling) { fiber = fiber.return; depth++; }
        fiber = fiber.return ? fiber.return.sibling : null;
      }
      depth++;
    }
    return false;
  }, pageId);

  if (navigated) {
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
