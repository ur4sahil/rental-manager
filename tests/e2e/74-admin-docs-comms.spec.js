// ═══════════════════════════════════════════════════════════════
// 74 — Admin, documents, comms + cross-cutting UI behaviour
//
// Covers the eight modules no other spec asserts on in depth
// (admin / tasks / documents / doc_builder / vendors / owners /
// messages / notifications) plus the four global behaviours that
// live outside any single page: the command palette, the keyboard
// shortcuts sheet, sidebar parent→child navigation, and mobile
// layout integrity.
//
// ── Why this file does not use helpers.gotoRoute ────────────────
// `?company=<id>#<route>` does NOT deep-link. App.js:717 answers a
// matching ?company= with
//     window.history.replaceState({}, "", window.location.pathname)
// which drops the hash, and the one-shot deep-link replay at
// App.js:828 loses the race against the second auth pass — so the
// app lands on Dashboard. `/#<route>` on its own works most of the
// time but still loses that race occasionally. Every navigation
// here therefore verifies it actually arrived and falls back to
// clicking the sidebar, which is the only fully reliable route.
//
// ── What this file deliberately never does ─────────────────────
// No message is ever sent (Messages.handleSend fires a real email
// via queueNotification), no invite is resent, no team member is
// removed, no document or message is deleted, and no notification
// rule is toggled or test-fired. Every create form is exercised as
// open → submit empty → assert the app refuses → Cancel.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { watchForFailures } = require('./helpers');

// Heading that proves the route genuinely rendered. These are the
// page's own <h2>, not the sidebar label — several differ ("Owners"
// in the sidebar is "Owners & Statements" on the page).
const HEADING = {
  dashboard:     'Dashboard',
  admin:         'Admin',
  tasks:         'Tasks & Approvals',
  documents:     'Document Management',
  doc_builder:   'Document Builder',
  vendors:       'Vendor Management',
  owners:        'Owners & Statements',
  messages:      'Messages',
  notifications: 'Notifications',
};

// Sidebar label for the routes that have one. `admin` is reached
// through the avatar menu and `documents` has no entry at all, so
// both are hash-only and get a retry instead of a click fallback.
const NAV_LABEL = {
  dashboard:     'Dashboard',
  tasks:         'Tasks & Approvals',
  doc_builder:   'Document Builder',
  vendors:       'Vendors',
  owners:        'Owners',
  messages:      'Messages',
  notifications: 'Notifications',
};

function heading(page, routeId) {
  return page.locator(`main h2:text-is("${HEADING[routeId]}")`).first();
}

async function hashLoad(page, routeId) {
  await page.goto(`/#${routeId}`, { timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
}

// Navigate and PROVE we arrived. A bare goto is not enough here:
// see the deep-link note at the top of the file.
async function open(page, routeId) {
  const want = heading(page, routeId);
  await hashLoad(page, routeId);
  if (await want.isVisible({ timeout: 45000 }).catch(() => false)) return;

  // Deep-link lost the race. We are sitting on Dashboard with the
  // shell up, so drive the sidebar instead.
  const label = NAV_LABEL[routeId];
  if (label) {
    await page.locator('nav button').filter({ hasText: label }).first()
      .click({ timeout: 30000 });
  } else {
    await hashLoad(page, routeId);
  }
  await want.waitFor({ state: 'visible', timeout: 60000 });
}

// The app replaced window.confirm/alert with in-page components; a
// React crash instead renders this boundary text.
async function assertNoCrash(page) {
  await expect(page.locator('text=Something went wrong').first())
    .toBeHidden({ timeout: 2000 });
}

// ═══════════════════════════════════════════════════════════════
// MODULE PAGES
// ═══════════════════════════════════════════════════════════════
test.describe('Admin', () => {
  test('Audit Trail renders a populated log and every tab', async ({ page }) => {
    const problems = watchForFailures(page);
    await open(page, 'admin');

    // AdminPage defaults to the Audit Trail tab, not Team & Roles.
    await expect(page.locator('main h2:text-is("Audit Trail")')).toBeVisible();

    // Five tabs, and only for a full admin — a narrower role sees
    // just "Audit Trail", so this doubles as a role check.
    for (const t of ['Audit Trail', 'Team & Roles', 'Notifications', 'Settings', 'Error Log']) {
      await expect(page.locator('main button').filter({ hasText: new RegExp(`^${t}$`) }).first())
        .toBeVisible();
    }

    // The log itself: real rows, not the colSpan empty-state row.
    const realRows = page.locator('main table tbody tr:not(:has(td[colspan]))');
    await expect.poll(() => realRows.count(), { timeout: 20000 }).toBeGreaterThan(0);

    await expect(page.locator('main table thead th')).toHaveText(
      [/Time/i, /User/i, /Role/i, /Module/i, /Action/i, /Details/i]);

    expect(problems, `admin logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('audit email filter narrows the log, then restores it', async ({ page }) => {
    await open(page, 'admin');
    const rows = page.locator('main table tbody tr:not(:has(td[colspan]))');
    const before = await rows.count();
    expect(before, 'need audit rows to filter').toBeGreaterThan(0);

    const search = page.locator('input[placeholder="Filter by user email..."]');
    await search.fill('zzz-nobody@nowhere.invalid');
    // Filtering is synchronous state, but the re-render is not
    // instant on a 50-row page.
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(0);
    await expect(page.locator('text=No audit logs found')).toBeVisible();

    await search.fill('');
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(before);
  });

  test('Team & Roles: Add User form refuses an empty submit, then cancels', async ({ page }) => {
    await open(page, 'admin');
    await page.locator('main button').filter({ hasText: /^Team & Roles$/ }).first().click();
    await expect(page.locator('main h2:text-is("Team & Role Management")')).toBeVisible({ timeout: 20000 });

    await page.locator('main button').filter({ hasText: '+ Add User' }).first().click();
    await expect(page.locator('main h3:text-is("Add Team Member")')).toBeVisible({ timeout: 10000 });

    // Every field the form needs must be present...
    for (const ph of ['First', 'M', 'Last', 'Email address']) {
      await expect(page.locator(`main input[placeholder="${ph}"]`)).toBeVisible();
    }
    // ...and the submit must be inert while they are empty. This
    // form gates on the button rather than a toast (Admin.js:422),
    // so "validates on empty submit" means the click cannot happen.
    const submit = page.locator('main button').filter({ hasText: /^Add User$/ });
    await expect(submit).toHaveCount(1);          // not the "+ Add User" trigger
    await expect(submit).toBeDisabled();

    // Typing a name alone must not unlock it — email is required too.
    await page.locator('main input[placeholder="First"]').fill('Zz');
    await page.locator('main input[placeholder="Last"]').fill('Testonly');
    await expect(submit).toBeDisabled();

    // CANCEL — never create.
    await page.locator('main button').filter({ hasText: /^Cancel$/ }).first().click();
    await expect(page.locator('main h3:text-is("Add Team Member")')).toBeHidden({ timeout: 10000 });
    await assertNoCrash(page);
  });
});

test.describe('Tasks & Approvals', () => {
  test('renders counted filter pills and grouped task cards', async ({ page }) => {
    const problems = watchForFailures(page);
    await open(page, 'tasks');

    const all = page.locator('main button').filter({ hasText: /^All \(\d+\)$/ }).first();
    await expect(all).toBeVisible();
    await expect(page.locator('main button').filter({ hasText: /^Approvals \(\d+\)$/ }).first()).toBeVisible();
    await expect(page.locator('main button').filter({ hasText: /^Tasks \(\d+\)$/ }).first()).toBeVisible();

    // The pill count must agree with what is actually on screen:
    // a non-zero "Tasks (n)" with no cards is exactly the silent
    // failure a "does it render" check would miss.
    const tasksPill = await page.locator('main button')
      .filter({ hasText: /^Tasks \(\d+\)$/ }).first().innerText();
    const claimed = Number(tasksPill.match(/\((\d+)\)/)[1]);
    const cards = page.locator('main button').filter({ hasText: /\d+ pending/ });
    if (claimed > 0) {
      await expect.poll(() => cards.count(), { timeout: 20000 }).toBeGreaterThan(0);
    } else {
      await expect(page.locator('text=All caught up!')).toBeVisible();
    }

    expect(problems, `tasks logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('pills switch sections and a property card expands its steps', async ({ page }) => {
    await open(page, 'tasks');
    const cards = page.locator('main button').filter({ hasText: /\d+ pending/ });
    const withTasks = await cards.count();
    test.skip(withTasks === 0, 'company has no pending tasks to expand');

    // Approvals-only hides the task cards entirely.
    await page.locator('main button').filter({ hasText: /^Approvals \(\d+\)$/ }).first().click();
    await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(0);

    // Tasks-only brings them back.
    await page.locator('main button').filter({ hasText: /^Tasks \(\d+\)$/ }).first().click();
    await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(withTasks);

    // Expanding is a pure UI toggle — no approve/reject is clicked.
    const first = cards.first();
    await expect(first).toContainText('expand_more');
    // The header promises "N pending"; the body must produce exactly
    // N step rows. A group that expands to a different number than it
    // advertises is a counting bug the eye would not catch.
    const promised = Number((await first.innerText()).match(/(\d+) pending/)[1]);
    expect(promised).toBeGreaterThan(0);
    const group = first.locator('xpath=..');
    const steps = group.locator('div.rounded-lg.px-3.py-2');
    await expect(steps).toHaveCount(0);

    await first.click();
    await expect(first).toContainText('expand_less', { timeout: 10000 });
    await expect(steps).toHaveCount(promised, { timeout: 10000 });

    // And collapsing puts them away again.
    await first.click();
    await expect(steps).toHaveCount(0, { timeout: 10000 });
    await assertNoCrash(page);
  });
});

test.describe('Documents', () => {
  test('renders the document table with all six columns', async ({ page }) => {
    const problems = watchForFailures(page);
    await open(page, 'documents');

    await expect(page.locator('main table thead th')).toHaveText(
      [/Document/i, /Property/i, /Type/i, /Date/i, /Tenant Visible/i, /Actions/i]);

    // Rows or the empty state — but never a table with neither.
    const realRows = page.locator('main table tbody tr:not(:has(td[colspan]))');
    const n = await realRows.count();
    if (n === 0) {
      await expect(page.locator('text=No documents yet. Upload one above.')).toBeVisible();
    }

    expect(problems, `documents logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('type filter pills toggle, and the upload form refuses an empty submit', async ({ page }) => {
    await open(page, 'documents');

    // "all" starts active; clicking Lease must move the highlight.
    const allPill = page.locator('main button').filter({ hasText: /^all$/ }).first();
    const leasePill = page.locator('main button').filter({ hasText: /^Lease$/ }).first();
    await expect(allPill).toHaveClass(/bg-brand-600/);
    await leasePill.click();
    await expect(leasePill).toHaveClass(/bg-brand-600/, { timeout: 10000 });
    await expect(allPill).not.toHaveClass(/bg-brand-600/);
    // Filtering can only ever shrink the list, never grow it.
    const rowsAfter = await page.locator('main table tbody tr:not(:has(td[colspan]))').count();
    await allPill.click();
    await expect.poll(() => page.locator('main table tbody tr:not(:has(td[colspan]))').count(),
      { timeout: 10000 }).toBeGreaterThanOrEqual(rowsAfter);

    // Upload form: no name, no file → Documents.js:35 returns
    // silently, so the proof is that nothing happened at all.
    const rowsBefore = await page.locator('main table tbody tr').count();
    await page.locator('main button').filter({ hasText: '+ Upload Document' }).first().click();
    await expect(page.locator('main h3:text-is("Upload Document")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('main input[placeholder="Lease Agreement 2026"]')).toBeVisible();
    await expect(page.locator('main input[type="file"]')).toHaveCount(1);

    await page.locator('main button').filter({ hasText: /^Upload$/ }).first().click();
    await page.waitForTimeout(1500);
    // Form still open, nothing saved, no success toast.
    await expect(page.locator('main h3:text-is("Upload Document")')).toBeVisible();
    expect(await page.locator('main table tbody tr').count()).toBe(rowsBefore);

    await page.locator('main button').filter({ hasText: /^Cancel$/ }).first().click();
    await expect(page.locator('main h3:text-is("Upload Document")')).toBeHidden({ timeout: 10000 });
    await assertNoCrash(page);
  });
});

test.describe('Document Builder', () => {
  test('three tabs render and Templates lists reusable templates', async ({ page }) => {
    const problems = watchForFailures(page);
    await open(page, 'doc_builder');

    // Create is the default tab and gates the template picker
    // behind a start-mode choice.
    await expect(page.locator('main h3').filter({ hasText: /How do you want to start/i })).toBeVisible();

    await page.locator('main button').filter({ hasText: 'Templates' }).first().click();
    const useBtns = page.locator('main button').filter({ hasText: /^Use$/ });
    await expect.poll(() => useBtns.count(), { timeout: 20000 }).toBeGreaterThan(0);
    // Every template card offers the same three affordances.
    const n = await useBtns.count();
    await expect(page.locator('main button').filter({ hasText: /^Edit$/ })).toHaveCount(n);
    await expect(page.locator('main button').filter({ hasText: '+ New Template' })).toHaveCount(1);

    await page.locator('main button').filter({ hasText: 'History' }).first().click();
    await page.waitForTimeout(1500);
    const docRows = page.locator('main button').filter({ hasText: /^PDF$/ });
    if (await docRows.count() === 0) {
      await expect(page.locator('text=No documents generated yet')).toBeVisible();
    }

    expect(problems, `doc_builder logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('new-template editor rejects an empty submit, then Esc closes it', async ({ page }) => {
    await open(page, 'doc_builder');
    await page.locator('main button').filter({ hasText: 'Templates' }).first().click();
    await page.locator('main button').filter({ hasText: '+ New Template' }).first().click();

    const editor = page.locator('.fixed.inset-0.z-50').first();
    await expect(editor).toBeVisible({ timeout: 15000 });
    await expect(editor).toContainText('New Template');

    // Documents.js:1361 — name is required before anything is saved.
    await editor.locator('button').filter({ hasText: /^Create$/ }).first().click();
    await expect(page.locator('text=Template name is required')).toBeVisible({ timeout: 10000 });

    // The editor must stay open so the user can fix it.
    await expect(editor).toBeVisible();

    // Esc is the documented dismissal (Documents.js:325) — nothing
    // is created.
    await page.keyboard.press('Escape');
    await expect(page.locator('.fixed.inset-0.z-50')).toHaveCount(0, { timeout: 15000 });
    await expect(heading(page, 'doc_builder')).toBeVisible();
    await assertNoCrash(page);
  });
});

test.describe('Vendors', () => {
  test('list renders and search narrows it, then restores', async ({ page }) => {
    const problems = watchForFailures(page);
    await open(page, 'vendors');

    // One Edit button per vendor card — the cards share their class
    // string with Owners' and with StatCard, so counting the row
    // action is the only unambiguous handle.
    const rows = page.locator('main button').filter({ hasText: /^Edit$/ });
    const before = await rows.count();
    expect(before, 'sandbox should have vendors').toBeGreaterThan(0);

    const search = page.locator('input[placeholder="Search vendors..."]');
    await search.fill('zzz-no-such-vendor');
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(0);
    await expect(page.locator('text=No vendors found')).toBeVisible();

    await search.fill('');
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(before);

    // The specialty filter is a real narrowing control, not decoration.
    const specialty = page.locator('main select').first();
    await expect(specialty.locator('option').first()).toHaveText('All Specialties');
    await specialty.selectOption({ label: 'Plumbing' });
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBeLessThanOrEqual(before);
    await specialty.selectOption({ label: 'All Specialties' });
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(before);

    expect(problems, `vendors logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('new-vendor form rejects an empty submit, then cancels', async ({ page }) => {
    await open(page, 'vendors');
    const rows = page.locator('main button').filter({ hasText: /^Edit$/ });
    const before = await rows.count();

    await page.locator('main button').filter({ hasText: '+ New Vendor' }).first().click();
    await expect(page.locator('main h3:text-is("Add New Vendor")')).toBeVisible({ timeout: 10000 });

    await page.locator('main button').filter({ hasText: /^Add Vendor$/ }).first().click();
    // Maintenance.js:732 — a toast, not an inline message.
    await expect(page.locator('text=Vendor name is required.')).toBeVisible({ timeout: 10000 });
    // Refusing means refusing: no vendor may have been created.
    await expect(page.locator('main h3:text-is("Add New Vendor")')).toBeVisible();

    await page.locator('main button').filter({ hasText: /^Cancel$/ }).first().click();
    await expect(page.locator('main h3:text-is("Add New Vendor")')).toBeHidden({ timeout: 10000 });
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(before);
    await assertNoCrash(page);
  });
});

test.describe('Owners', () => {
  test('renders three tabs and each shows its own panel', async ({ page }) => {
    const problems = watchForFailures(page);
    await open(page, 'owners');

    const tabBar = page.locator('main div.border-b').filter({ hasText: 'Distributions' }).first();
    for (const t of ['Owners', 'Statements', 'Distributions']) {
      await expect(tabBar.locator('button').filter({ hasText: new RegExp(`^${t}$`) })).toHaveCount(1);
    }

    // Each tab must render distinct content, not the same panel
    // with a different highlight.
    const seen = [];
    for (const t of ['Owners', 'Statements', 'Distributions']) {
      await tabBar.locator('button').filter({ hasText: new RegExp(`^${t}$`) }).first().click();
      await page.waitForTimeout(1200);
      seen.push((await page.locator('main').innerText()).replace(/\s+/g, ' '));
    }
    expect(new Set(seen).size, 'Owners/Statements/Distributions render identical panels').toBe(3);

    expect(problems, `owners logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('new-owner form rejects an empty submit, then cancels', async ({ page }) => {
    await open(page, 'owners');

    await page.locator('main button').filter({ hasText: '+ New Owner' }).first().click();
    await expect(page.locator('main h3:text-is("Add New Owner")')).toBeVisible({ timeout: 10000 });
    for (const ph of ['First', 'Last', 'Mailing address']) {
      await expect(page.locator(`main input[placeholder="${ph}"]`)).toBeVisible();
    }

    // Whitespace-only must be rejected too — Owners.js:55 trims.
    await page.locator('main input[placeholder="First"]').fill('   ');
    await page.locator('main button').filter({ hasText: /^Add Owner$/ }).first().click();
    await expect(page.locator('text=Owner name is required.')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('main h3:text-is("Add New Owner")')).toBeVisible();

    await page.locator('main button').filter({ hasText: /^Cancel$/ }).first().click();
    await expect(page.locator('main h3:text-is("Add New Owner")')).toBeHidden({ timeout: 10000 });
    await assertNoCrash(page);
  });
});

test.describe('Messages', () => {
  test('conversation list renders and the search narrows it', async ({ page }) => {
    const problems = watchForFailures(page);
    await open(page, 'messages');

    // Rows are buttons inside the left pane's scroller. Nothing is
    // clicked: selecting a conversation writes read_at, and the
    // composer sends a real email on Enter.
    const rows = page.locator('main div.flex-1.overflow-y-auto > button');
    const before = await rows.count();
    expect(before, 'sandbox should have tenant conversations').toBeGreaterThan(0);

    const search = page.locator('input[placeholder="Search tenants…"]');
    await search.fill('zzz-no-such-tenant');
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(0);
    await expect(page.locator('text=No tenants match.')).toBeVisible();

    // A real substring must return a genuine subset, not everything
    // and not nothing.
    await search.fill('a');
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBeGreaterThan(0);
    expect(await rows.count()).toBeLessThanOrEqual(before);

    await search.fill('');
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(before);

    expect(problems, `messages logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

test.describe('Notifications', () => {
  test('three tabs each mount their own panel', async ({ page }) => {
    const problems = watchForFailures(page);
    await open(page, 'notifications');

    const tabBar = page.locator('main div.border-b').filter({ hasText: 'Preferences' }).first();
    const texts = {};
    for (const t of ['Activity', 'Preferences', 'History']) {
      const tab = tabBar.locator('button').filter({ hasText: new RegExp(`^${t}$`) }).first();
      await tab.click();
      await expect(tab).toHaveClass(/border-brand-600/, { timeout: 10000 });
      await page.waitForTimeout(1200);
      const body = await page.locator('main').innerText();
      texts[t] = body.slice(body.indexOf('Activity')).replace(/\s+/g, ' ');
      // Only one tab may be active at a time.
      await expect(tabBar.locator('button.border-brand-600')).toHaveCount(1);
    }
    // Panels are conditionally mounted, so their content must differ.
    expect(new Set(Object.values(texts)).size,
      'notification tabs render identical panels').toBe(3);

    // Activity's own filter pills carry live counts.
    await tabBar.locator('button').filter({ hasText: /^Activity$/ }).first().click();
    await expect(page.locator('main button').filter({ hasText: /^All \(\d+\)$/ }).first()).toBeVisible();
    await expect(page.locator('main button').filter({ hasText: /^Unread \(\d+\)$/ }).first()).toBeVisible();

    expect(problems, `notifications logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// CROSS-CUTTING UI
// ═══════════════════════════════════════════════════════════════
const PALETTE = '[role="dialog"][aria-label="Command palette"]';
const SHEET   = '[role="dialog"][aria-label="Keyboard shortcuts"]';

test.describe('Command palette', () => {
  test('Cmd+K opens it, typing filters, Escape closes', async ({ page }) => {
    await open(page, 'dashboard');

    await page.keyboard.press('Meta+k');
    await expect(page.locator(PALETTE)).toBeVisible({ timeout: 10000 });

    const options = page.locator('#cmdk-list [role="option"]');
    const idle = await options.count();
    expect(idle, 'palette should suggest pages before any typing').toBeGreaterThan(0);

    // A query must actually narrow the list AND surface the right
    // page — fuzzyScore returning null for a legitimate match once
    // dropped exactly the best results (CommandPalette.js:29).
    await page.locator('input[aria-label="Search pages and actions"]').fill('journ');
    await expect.poll(() => options.count(), { timeout: 10000 }).toBeLessThan(idle);
    await expect(options.first()).toContainText('Journal Entries');

    // A subsequence query with no match must say so, not show a
    // stale list.
    await page.locator('input[aria-label="Search pages and actions"]').fill('zzqqxx');
    await expect.poll(() => options.count(), { timeout: 10000 }).toBe(0);
    await expect(page.locator('#cmdk-list')).toContainText('Nothing matches');

    await page.keyboard.press('Escape');
    await expect(page.locator(PALETTE)).toHaveCount(0, { timeout: 10000 });
  });

  test('Ctrl+K opens it too, and Enter navigates to the chosen page', async ({ page }) => {
    await open(page, 'dashboard');

    // Handlers accept either modifier so Windows/Linux works.
    await page.keyboard.press('Control+k');
    await expect(page.locator(PALETTE)).toBeVisible({ timeout: 10000 });

    await page.locator('input[aria-label="Search pages and actions"]').fill('vend');
    await expect(page.locator('#cmdk-list [role="option"]').first()).toContainText('Vendors');
    await page.keyboard.press('Enter');

    // Running a command closes the palette and actually routes.
    await expect(page.locator(PALETTE)).toHaveCount(0, { timeout: 10000 });
    await expect(heading(page, 'vendors')).toBeVisible({ timeout: 60000 });
    expect(await page.evaluate(() => window.location.hash)).toBe('#vendors');
  });
});

test.describe('Keyboard shortcuts sheet', () => {
  test('"?" opens the sheet with every group, Escape closes it', async ({ page }) => {
    await open(page, 'dashboard');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());

    await page.keyboard.press('?');
    const sheet = page.locator(SHEET);
    await expect(sheet).toBeVisible({ timeout: 10000 });

    // The sheet renders from SHORTCUT_GROUPS, so a missing group
    // means the registry and the help drifted apart.
    await expect(sheet.locator('section h4')).toHaveText([
      /Anywhere in the app/i,
      /Bank Transactions/i,
      /Journal Entry form/i,
    ]);
    // Each group must list actual keys, not just a title.
    await expect.poll(() => sheet.locator('kbd').count(), { timeout: 10000 }).toBeGreaterThan(20);
    await expect(sheet).toContainText('Open the command palette');

    await page.keyboard.press('Escape');
    await expect(page.locator(SHEET)).toHaveCount(0, { timeout: 10000 });
  });

  test('"?" typed into a field types a "?" instead of opening the sheet', async ({ page }) => {
    await open(page, 'vendors');

    const search = page.locator('input[placeholder="Search vendors..."]');
    await search.click();
    await page.keyboard.type('?');

    // isTypingTarget must swallow the shortcut...
    await expect(page.locator(SHEET)).toHaveCount(0);
    // ...without swallowing the keystroke.
    await expect(search).toHaveValue('?');
  });
});

test.describe('Sidebar navigation', () => {
  test('expanding Properties reveals children and a child navigates', async ({ page }) => {
    await open(page, 'dashboard');

    const child = page.locator('nav button').filter({ hasText: 'Insurance' });
    await expect(child, 'children must start collapsed').toHaveCount(0);

    // The chevron is the sibling button of the parent's own row.
    const parent = page.locator('nav button').filter({ hasText: 'Properties' }).first();
    await parent.locator('xpath=following-sibling::button').first().click();

    await expect(child).toHaveCount(1, { timeout: 10000 });
    // The whole child set, not just one.
    for (const c of ['Import from Excel', 'Maintenance', 'Inspections', 'Utilities',
                     'HOA Payments', 'Loans', 'Insurance', 'Tax Bills']) {
      await expect(page.locator('nav button').filter({ hasText: c }).first()).toBeVisible();
    }

    await child.first().click();
    await expect(page.locator('main h2:text-is("Insurance")')).toBeVisible({ timeout: 60000 });
    expect(await page.evaluate(() => window.location.hash)).toBe('#insurance');
  });

  test('expanding Accounting reveals its nine sub-pages', async ({ page }) => {
    await open(page, 'dashboard');

    const coa = page.locator('nav button').filter({ hasText: 'Chart of Accounts' });
    await expect(coa).toHaveCount(0);

    const parent = page.locator('nav button').filter({ hasText: 'Accounting' }).first();
    await parent.locator('xpath=following-sibling::button').first().click();

    for (const c of ['Opening Balances', 'Chart of Accounts', 'Journal Entries',
                     'Recurring Entries', 'Bank Transactions', 'Import from QuickBooks',
                     'Reconcile', 'Class Tracking', 'Reports']) {
      await expect(page.locator('nav button').filter({ hasText: c }).first())
        .toBeVisible({ timeout: 10000 });
    }

    // Collapsing must put them away again.
    await parent.locator('xpath=following-sibling::button').first().click();
    await expect(coa).toHaveCount(0, { timeout: 10000 });
  });
});

test.describe('Responsive', () => {
  test('no horizontal overflow at 390x844 across key pages', async ({ page }) => {
    // Viewport is set before the first load: this app resolves its
    // route during boot, and reloading mid-session loses the hash.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/', { timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
    await expect(heading(page, 'dashboard')).toBeVisible({ timeout: 90000 });

    const check = async (label) => {
      const { docOver, bodyOver, sw, cw } = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        docOver: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        bodyOver: document.body.scrollWidth > document.documentElement.clientWidth,
      }));
      expect(docOver, `${label} overflows horizontally at 390px (${sw} > ${cw})`).toBeFalsy();
      expect(bodyOver, `${label} body overflows horizontally at 390px`).toBeFalsy();
    };
    await check('dashboard');

    // The sidebar is behind the hamburger at this width; that it
    // opens at all is part of the assertion.
    const hamburger = page.locator('header button').filter({ hasText: 'menu' }).first();
    await expect(hamburger).toBeVisible();

    for (const [label, routeId] of [
      ['Tasks & Approvals', 'tasks'],
      ['Vendors', 'vendors'],
      ['Notifications', 'notifications'],
    ]) {
      await hamburger.click();
      const navItem = page.locator('nav button').filter({ hasText: label }).first();
      await expect(navItem).toBeVisible({ timeout: 10000 });
      await navItem.click();
      await expect(heading(page, routeId)).toBeVisible({ timeout: 90000 });
      await check(label);
    }
  });
});
