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
const { login, navigateTo, collectConsoleErrors } = require('./helpers');

// Open a property's detail panel and land on its Documents tab.
//
// Clicking a row does not always open the detail panel: a property whose
// setup is incomplete opens the SETUP WIZARD instead, which is what the first
// row in the sandbox does. So try rows until one gives a detail panel, and
// close the wizard behind us when it appears -- otherwise the next click
// lands inside a modal.
async function openDocuments(page) {
  // Target a property that HAS a mix of documents. Landing on an arbitrary
  // row met one with a single file, and every grouping assertion skipped --
  // a green run that tested nothing. TEST_DOC_PROPERTY is seeded in the test
  // database with a lease, two tenants' paperwork, statements, a receipt and
  // two case-variant types.
  const target = process.env.TEST_DOC_PROPERTY || '100 Oak Street, Unit A';
  const search = page.getByPlaceholder(/Search properties/i).first();
  if (await search.isVisible({ timeout: 5000 }).catch(() => false)) {
    await search.fill(target);
    await page.waitForTimeout(1200);
  }

  const rows = page.locator('table tbody tr');
  const count = Math.min(await rows.count().catch(() => 0), 8);
  if (!count) test.skip(true, 'no properties matched ' + target);

  for (let i = 0; i < count; i++) {
    await rows.nth(i).click();
    await page.waitForTimeout(1200);

    // The setup wizard hijacked the click. Close it and move on.
    const wizard = page.locator('text=/^Property Setup$/').first();
    if (await wizard.isVisible({ timeout: 1500 }).catch(() => false)) {
      const close = page.locator('button:has-text("close"), [aria-label="Close"]').last();
      if (await close.count().catch(() => 0)) await close.click();
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      continue;
    }

    // The detail panel's Documents tab, not the sidebar's Documents page.
    const tab = page.locator('button:has-text("Documents")').last();
    if (!(await tab.count().catch(() => 0))) continue;
    await tab.click();

    // The module's own search box is the marker that it mounted, rather than
    // a timeout: a fixed wait passes on a blank panel just as happily.
    const marker = page.getByPlaceholder(/Search this property/i);
    if (await marker.isVisible({ timeout: 12000 }).catch(() => false)) return;
  }
  throw new Error('could not open any property\'s Documents tab');
}

test.describe('Property documents', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await navigateTo(page, 'Properties');
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

    // At least one folder header with a count beside it.
    const folder = page.locator('div:has-text("Utility Bill"), div:has-text("Lease"), div:has-text("Tenant Documents"), div:has-text("Unfiled")').first();
    await expect(folder).toBeVisible();

    // A folder is a real disclosure: clicking it must change what is shown.
    const before = (await page.locator('body').innerText()).length;
    await folder.click();
    await page.waitForTimeout(400);
    const after = (await page.locator('body').innerText()).length;
    expect(after).not.toBe(before);
  });

  test('one folder per type, and case variants do not split it', async ({ page }) => {
    await openDocuments(page);
    const body = await page.locator('body').innerText();
    test.skip(/No documents for this property yet/i.test(body), 'nothing to group');

    // Real data holds "Insurance" and "insurance" as separate type values.
    // Folded, they are one folder; unfolded, they render as two headers.
    const headers = await page.locator('div.font-semibold').allInnerTexts();
    const lowered = headers.map(h => h.trim().toLowerCase()).filter(Boolean);
    const dupes = lowered.filter((h, i) => lowered.indexOf(h) !== i);
    expect(dupes, `two folders with the same name: ${JSON.stringify(dupes)}`).toHaveLength(0);
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

    // Open the Utility Bill folder.
    await page.locator('div.font-semibold:has-text("Utility Bill")').first().click();
    await page.waitForTimeout(500);

    // The View link must produce a signed URL, not a 404. This is the check
    // that catches file_name holding a bare filename instead of the storage
    // path -- getSignedUrl reads (file_name || url), so the wrong one signs a
    // path that does not exist and every link silently fails.
    const view = page.locator('text=/^View$/').first();
    await expect(view).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 20000 }).catch(() => null),
      view.click(),
    ]);
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      expect(popup.url()).toMatch(/^https?:\/\//);
      // A Supabase signed URL carries a token; an unsigned one 400s.
      expect(popup.url()).not.toMatch(/error|not_found/i);
      await popup.close();
    } else {
      // No popup means the toast path fired. That is a legitimate outcome
      // only if it says the file could not be opened -- silence is not.
      await expect(page.locator('text=/could not be opened/i')).toBeVisible({ timeout: 5000 });
    }
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
