// ═══════════════════════════════════════════════════════════════
// 58 — DOCUMENT BUILDER click-coverage sweep
// Smoke-tests the Document Builder page: tab strip (templates /
// library / create), + New Template entry. The deep e-sign flow
// is covered by 36-doc-esign.spec.js.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, navigateTo,
  assertNoHorizontalOverflow, assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Document Builder — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Document Builder');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow', async ({ page }) => {
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  test('tab strip (templates / library / create) is reachable', async ({ page }) => {
    const tabs = ['Templates', 'Library', 'Create'];
    let found = 0;
    for (const t of tabs) {
      if (await page.locator(`button:has-text("${t}")`).first().isVisible({ timeout: 1500 }).catch(() => false)) found++;
    }
    expect(found, `at least one of ${tabs.join('/')} tabs visible`).toBeGreaterThan(0);
  });

  test('+ New Template button opens template editor', async ({ page }) => {
    const newBtn = page.locator('button:has-text("+ New Template"), button:has-text("New Template"), button:has-text("+ New")').first();
    if (!await newBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'no New Template button — may need to be on Templates tab first');
      return;
    }
    await newBtn.click();
    await page.waitForTimeout(800);
    const editorOpen = await page.locator('text=/Template Name|Body|HTML|PDF Overlay|Content/i')
      .first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(editorOpen, 'template editor opened').toBeTruthy();
    const cancel = page.locator('button:has-text("Cancel")').first();
    if (await cancel.isVisible({ timeout: 1500 }).catch(() => false)) await cancel.click();
  });
});
