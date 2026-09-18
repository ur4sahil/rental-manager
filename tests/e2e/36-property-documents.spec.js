// ═══════════════════════════════════════════════════════════════
// 36 — PROPERTY DOCUMENTS: FOLDERS, PAGING, SEARCH, SOURCES
// ═══════════════════════════════════════════════════════════════
//
// The property panel used to render ONE flat list, capped at .limit(100),
// drawn from the documents table alone. These specs exercise the module that
// replaced it in a real browser, because the faults it fixes are all things
// that look fine in a unit test:
//
//   a folder that never renders because its type is not in FOLDER_ORDER
//   a case variant ("insurance" vs "Insurance") showing as two folders
//   a View link that 404s because file_name held a bare filename
//   an empty folder list that is actually a failed query
const { test, expect } = require('@playwright/test');
const { login, gotoRoute, collectConsoleErrors } = require('./helpers');

// Open a property's detail panel and land on its Documents tab.
//
// Three things get in the way, all found by watching it fail rather than by
// reading the code:
//
//   THE PROPERTIES PAGE IS CARDS, NOT A TABLE, by default. A
//   `table tbody tr` locator matches nothing, so every test skipped on
//   "no properties matched" while the page was showing the property fine.
//
//   AN INCOMPLETE-SETUP PROPERTY OPENS THE SETUP WIZARD instead of the
//   detail panel. The wizard is a modal, so the next click lands inside it.
//
//   A PROPERTY WITH ONE FILE PROVES NOTHING. Landing on an arbitrary
//   property met a single utility statement and every grouping assertion
//   skipped -- a green run that tested nothing, which is the failure mode
//   that let 72 tests in this repo sit unrun for weeks. So this targets a
//   property seeded with a real mix: two tenants' paperwork, statements, a
//   receipt, and the Insurance/insurance case pair.
async function openDocuments(page) {
  const target = process.env.TEST_DOC_PROPERTY || '100 Oak Street';

  // Use the repo's own navigator. Hand-rolling this went wrong twice:
  // "Properties" in the sidebar is a collapsible PARENT -- Maintenance,
  // Inspections, Utilities and the rest are its children -- so clicking it
  // toggles the group rather than navigating, and a retry loop just toggles
  // it back. gotoRoute already knows that, plus the fact that a sidebar
  // button's innerText concatenates its icon ligature with its label
  // ("apartment\nProperties"), and it falls back to a deep link.
  await gotoRoute(page, 'properties');

  // The property search box exists only on the Properties page, so it is the
  // proof we arrived. The header's "Search or jump to..." does not match it.
  const search = page.getByPlaceholder(/Search properties/i).first();
  await expect(search, 'never reached the Properties page').toBeVisible({ timeout: 20000 });

  await search.fill(target);
  await page.waitForTimeout(1500);

  // Click the property by its NAME, which works in either view. Scoped to
  // the main panel so the sidebar and the "Setup incomplete" banner -- which
  // names a different property -- cannot be what gets clicked.
  const card = page.locator('main, [role="main"], body')
    .locator(`text="${target}"`).first();
  const hit = await card.isVisible({ timeout: 8000 }).catch(() => false);
  if (!hit) test.skip(true, `no property named ${target} on this page`);
  await card.click();
  await page.waitForTimeout(2500);

  // If the setup wizard opened instead, close it and fail loudly: silently
  // testing a different property is worse than saying we could not get here.
  const wizard = page.locator('text=/^Property Setup$/').first();
  if (await wizard.isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.keyboard.press('Escape');
    throw new Error(`${target} opened the setup wizard, not the detail panel`);
  }

  const tab = page.locator('button:has-text("Documents")').last();
  await tab.click();

  // The module's own search box is the marker that it mounted, rather than a
  // timeout: a fixed wait passes on a blank panel just as happily.
  await expect(page.getByPlaceholder(/Search this property/i))
    .toBeVisible({ timeout: 20000 });
}

// Everything below is scoped to the module itself. The property detail panel
// carries its own Insurance and Utilities cards, so a page-wide query for a
// folder called "Insurance" also matches the panel's card -- which reported a
// duplicate folder that was not there.
const panel = page => page.getByTestId('property-documents');

test.describe('Property documents', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('the module mounts with its controls', async ({ page }) => {
    await openDocuments(page);
    await expect(page.getByPlaceholder(/Search this property/i)).toBeVisible();
    await expect(page.locator('text=/Show deleted/i').first()).toBeVisible();
    // The count line says how many files, or "N of M" while filtered. Its
    // absence means the header rendered without knowing what it is showing.
    await expect(page.locator('text=/\\d+ files?|\\d+ of \\d+/').first()).toBeVisible();
  });

  test('documents are grouped into folders, not one flat list', async ({ page }) => {
    await openDocuments(page);

    const body = await page.locator('body').innerText();
    const empty = /No documents for this property yet/i.test(body);
    test.skip(empty, 'this property has no documents to group');

    // Target the folder HEADER, not any ancestor that happens to contain the
    // word. `div:has-text("Lease")` matches every wrapper up the tree, so
    // .first() was a page-sized container: clicking it toggled nothing and
    // the assertion compared a body length to itself.
    // The header is a div with role="button"; the name is a span inside it,
    // so div.font-semibold never matched. getByRole is the right locator and
    // does not break when a class changes.
    const header = panel(page).getByRole('button', { name: /Tenant Documents/ }).first();
    await expect(header).toBeVisible();

    // A folder is a real disclosure, so the FILES inside it must appear and
    // disappear. Counting a document row is the honest check; comparing the
    // length of the whole page is not.
    const aliceRow = panel(page).locator('text="Signed lease 2026"').first();
    const openAtStart = await aliceRow.isVisible().catch(() => false);

    await header.click();
    await page.waitForTimeout(600);
    expect(await aliceRow.isVisible().catch(() => false)).toBe(!openAtStart);

    await header.click();
    await page.waitForTimeout(600);
    expect(await aliceRow.isVisible().catch(() => false)).toBe(openAtStart);
  });

  test('one folder per type, and case variants do not split it', async ({ page }) => {
    await openDocuments(page);
    const body = await page.locator('body').innerText();
    test.skip(/No documents for this property yet/i.test(body), 'nothing to group');

    // Real data holds "Insurance" and "insurance" as separate type values.
    // Folded, they are one folder; unfolded, they render as two headers.
    // Only FOLDER names, not every button on the page: "View" repeats once
    // per document row and the sidebar has its own buttons, so a blanket
    // duplicate check would fail for reasons that have nothing to do with
    // folders. This is the case-folding assertion -- real data holds both
    // "Insurance" and "insurance", and they must produce ONE folder.
    const FOLDERS = ['Lease', 'Signed & Generated', 'Tenant Documents', 'ID',
      'Insurance', 'Utility Bill', 'Utility Receipt', 'Utility Transfer',
      'Inspection', 'Maintenance', 'Maintenance Photos', 'Financial',
      'Notice', 'Receipt', 'Other', 'Unfiled'];
    const names = (await panel(page).getByRole('button').allInnerTexts())
      .map(t => t.split('\n').map(x => x.trim()).filter(Boolean).find(x => FOLDERS.includes(x)))
      .filter(Boolean);
    expect(names.length, 'no folder headers found at all').toBeGreaterThan(0);
    const dupes = names.filter((h, i) => names.indexOf(h) !== i);
    expect(dupes, `the same folder rendered twice: ${JSON.stringify(dupes)}`).toHaveLength(0);
  });

  test('search narrows the list and opens the folders', async ({ page }) => {
    await openDocuments(page);
    const body = await page.locator('body').innerText();
    test.skip(/No documents for this property yet/i.test(body), 'nothing to search');

    await page.getByPlaceholder(/Search this property/i).fill('zzzzz-no-such-document');
    await expect(page.locator('text=/Nothing matches/i')).toBeVisible({ timeout: 8000 });

    // Clearing restores. A search that cannot be undone is a dead end.
    await page.getByPlaceholder(/Search this property/i).fill('');
    await expect(page.locator('text=/Nothing matches/i')).toBeHidden({ timeout: 8000 });
  });

  test('a filed utility statement opens', async ({ page }) => {
    await openDocuments(page);
    const body = await page.locator('body').innerText();
    test.skip(!/Utility Bill/i.test(body), 'no utility statements filed against this property');

    // Open the Utility Bill folder if it is closed. Clicking blind toggled a
    // folder that was already open, so the row it wanted was never there.
    const utilHeader = panel(page).getByRole('button', { name: /Utility Bill/ }).first();
    await expect(utilHeader).toBeVisible({ timeout: 10000 });
    const anyStatement = panel(page).locator('text=/statement/i').first();
    if (!(await anyStatement.isVisible().catch(() => false))) {
      await utilHeader.click();
      await page.waitForTimeout(800);
    }

    // The View link must produce a signed URL, not a 404. This is the check
    // that catches file_name holding a bare filename instead of the storage
    // path -- getSignedUrl reads (file_name || url), so the wrong one signs a
    // path that does not exist and every link silently fails.
    // TextLink renders a <button> whose content is an icon ligature followed
    // by the label, so its text is "open_in_new\nView" -- text=/^View$/ can
    // never match it. The same trap helpers.js documents for sidebar buttons.
    // A role query with a loose name matches the accessible name instead.
    const view = panel(page).getByRole('button', { name: /View/ }).first();
    await expect(view, 'no View link — the folder did not open').toBeVisible({ timeout: 10000 });

    // Assert the SIGNING REQUEST, not the popup.
    //
    // This is the bug worth guarding: documents store their storage path in
    // BOTH file_name and url, and getSignedUrl is called as
    // getSignedUrl("documents", d.file_name || d.url). If file_name ever
    // holds a bare filename instead of the path, every View link signs a
    // path that does not exist and silently fails.
    //
    // The request carries that path, so it proves the right thing directly.
    // Whether a popup then opens depends on storage contents this test does
    // not own -- the seeded fixtures share one object -- so asserting on the
    // window would be asserting on the fixture, not the code.
    const signing = page.waitForRequest(
      r => /\/storage\/v1\/object\/sign\//.test(r.url()),
      { timeout: 15000 },
    );
    await view.click();
    const req = await signing;

    // The signed path must look like a stored object -- "<company>/<folder>/
    // <file>" -- and not a bare filename, which is what the bug produced.
    const signedPath = decodeURIComponent(new URL(req.url()).pathname);
    expect(signedPath, `signed a path with no folders: ${signedPath}`)
      .toMatch(/\/documents\/.+\/.+/);
  });

  test('showing deleted files does not error', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await openDocuments(page);
    await page.locator('text=/Show deleted/i').first().click();
    // Refetches with archived rows included.
    await expect(page.getByPlaceholder(/Search this property/i)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(errors.filter(e => !/favicon|sourcemap/i.test(e))).toHaveLength(0);
  });

  test('the panel renders without console errors or sideways scroll', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await openDocuments(page);
    await page.waitForTimeout(1500);

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    expect(overflow, 'the documents panel scrolls sideways').toBe(false);
    expect(errors.filter(e => !/favicon|sourcemap/i.test(e))).toHaveLength(0);
  });
});
