// ═══════════════════════════════════════════════════════════════
// Shared helpers for all E2E test files
// ═══════════════════════════════════════════════════════════════
const { expect } = require('@playwright/test');

/**
 * Login to the app with test credentials.
 * Handles landing → sign-in → company selector → dashboard flow.
 *
 * @param {Page} page
 * @param {string|object} [arg='sandbox-llc']
 *   String form: companies.id to auto-select (back-compat).
 *   Object form: { companySlug, email, password, expectsPortal }
 *     • email/password — override TEST_EMAIL/TEST_PASSWORD env (used by
 *       64/65 portal specs to log in as tenant/owner roles).
 *     • expectsPortal — when true, skip the dashboard-marker wait
 *       (tenant/owner roles auto-route to tenant_portal/owner_portal,
 *       not Dashboard).
 */
async function login(page, arg = 'sandbox-llc') {
  const opts = typeof arg === 'string' ? { companySlug: arg } : (arg || {});
  const companySlug = opts.companySlug || 'sandbox-llc';
  const email = opts.email || process.env.TEST_EMAIL;
  const password = opts.password || process.env.TEST_PASSWORD;
  const expectsPortal = !!opts.expectsPortal;
  await page.goto('/?company=' + encodeURIComponent(companySlug), { timeout: 30000 });

  // Success markers vary by role:
  //   • admin/manager/etc → Dashboard sidebar button or h2
  //   • tenant role → "Pay Rent" tab in tenant portal
  //   • owner role → "Statements" / "Distributions" / "Properties" tab
  // For the portal cases we don't have a single text marker, so use a
  // generic `main` locator that matches once auth has resolved past
  // the loading screen.
  const dashboardMarker = page.locator('button:visible:has-text("Dashboard"), h2:visible:has-text("Dashboard")').first();
  const portalMarker = page.locator('main:visible button, main:visible [role="tab"]').first();
  const successMarker = expectsPortal ? portalMarker : dashboardMarker;
  if (await successMarker.isVisible({ timeout: 3000 }).catch(() => false)) return;

  // Landing page: click Sign In to reveal the login form.
  const signInBtn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await signInBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await signInBtn.click();
  }
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });

  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  // The form submit button — the last "Sign In" on page, not the header.
  await page.locator('button:has-text("Sign In")').last().click();

  // Supabase auth rate-limits any flood of logins (~30/min/IP). When a
  // full E2E run hits the limit we just see "Request rate limit
  // reached" on the login form and the dashboard never appears.
  // Detect, back off, and retry up to 3 times so the suite can recover
  // without rerunning the whole batch from scratch.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await successMarker.isVisible({ timeout: 8000 }).catch(() => false)) return;
    const rateLimit = page.locator('text=/rate limit reached/i').first();
    if (await rateLimit.isVisible({ timeout: 1000 }).catch(() => false)) {
      const wait = 8000 + attempt * 7000;
      // eslint-disable-next-line no-console
      console.log(`[login] rate-limited, waiting ${wait}ms before retry ${attempt + 1}/3`);
      await page.waitForTimeout(wait);
      await page.fill('input[type="email"]', email);
      await page.fill('input[type="password"]', password);
      await page.locator('button:has-text("Sign In")').last().click();
    } else {
      break;
    }
  }

  // Auto-select via ?company= kicks in once auth resolves. If that
  // path silently doesn't match (e.g. stale membership cache), fall
  // back to clicking the company row in the selector.
  if (await successMarker.isVisible({ timeout: 20000 }).catch(() => false)) return;

  // Fallback: Company Selector is up. Try the name span, then a
  // broader cursor-pointer row as last resort.
  for (let attempt = 0; attempt < 2; attempt++) {
    const nameEl = page.locator('.font-semibold.truncate:has-text("Sandbox")').first();
    if (await nameEl.isVisible({ timeout: 2500 }).catch(() => false)) {
      await nameEl.click({ force: true }).catch(() => {});
    } else {
      const firstRow = page.locator('div.cursor-pointer:has(.font-semibold)').first();
      if (await firstRow.isVisible({ timeout: 2000 }).catch(() => false)) await firstRow.click({ force: true }).catch(() => {});
    }
    if (await successMarker.isVisible({ timeout: 15000 }).catch(() => false)) return;
  }
  await successMarker.waitFor({ state: 'visible', timeout: 10000 });
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

// Added 2026-04-24: Accounting got the same nested-children pattern
// as Properties when its in-page tab sidebar was retired in favor of
// global-sidebar children (commit 12e6d75).
const NESTED_UNDER_ACCOUNTING = new Set([
  'Opening Balances', 'Chart of Accounts', 'Journal Entries',
  'Recurring Entries', 'Bank Transactions', 'Reconcile',
  'Class Tracking', 'Reports',
]);

async function navigateTo(page, label) {
  // On mobile: open hamburger first
  const hamburger = page.locator('button:has-text("menu")').first();
  if (await hamburger.isVisible({ timeout: 1000 }).catch(() => false)) {
    await hamburger.click();
    await page.waitForTimeout(300);
  }
  // Scope to the sidebar <nav>. Several pages render quick-access buttons
  // with the same labels as the sidebar (e.g. Accounting overview has
  // "Chart of Accounts" + "Journal Entries" tile buttons). A bare
  // `button:has-text("Foo").first()` may resolve to those tiles —
  // sometimes hidden, sometimes leading to a different state — instead
  // of the sidebar link. Falling back to the broader selector keeps
  // backwards-compat for headers / non-nav buttons.
  const navTarget = page.locator('nav button').filter({ hasText: label }).first();
  const target = await navTarget.count() > 0
    ? navTarget
    : page.locator(`button:has-text("${label}")`).first();
  // If target isn't visible and it's known-nested, expand the
  // appropriate parent group first. Tries Properties' chevron, then
  // Accounting's, since both use the same expand_more icon and the
  // `.first()` selector would otherwise hit whichever DOM-renders first.
  const isNested = NESTED_UNDER_PROPERTIES.has(label) || NESTED_UNDER_ACCOUNTING.has(label);
  if (isNested && !await target.isVisible({ timeout: 1000 }).catch(() => false)) {
    const parentLabel = NESTED_UNDER_PROPERTIES.has(label) ? 'Properties' : 'Accounting';
    // Find the parent's expand chevron — scoped to the parent's row
    // so we don't accidentally toggle the wrong section.
    const parentRow = page.locator(`button:has-text("${parentLabel}")`).first();
    if (await parentRow.isVisible({ timeout: 1000 }).catch(() => false)) {
      const chevron = parentRow.locator('xpath=following-sibling::button').first();
      if (await chevron.isVisible({ timeout: 1000 }).catch(() => false)) {
        await chevron.click();
        await page.waitForTimeout(400);
      } else {
        // Fall back to clicking the parent itself — App.js auto-expands
        // when you click into the parent page.
        await parentRow.click();
        await page.waitForTimeout(400);
      }
    }
    // After expand, wait up to 5s for the child target to actually render
    // before attempting to click. On heavier company datasets (Smith) the
    // 400ms post-chevron wait wasn't enough — React state + child render
    // can stretch past it.
    await target.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
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
    'owners',
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
