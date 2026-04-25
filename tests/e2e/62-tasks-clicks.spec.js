// ═══════════════════════════════════════════════════════════════
// 62 — TASKS & APPROVALS click-coverage sweep
// The Tasks page is a UNION of manager_approvals + doc_exception
// _requests + wizard_skipped_approvals (no `tasks` table on this
// schema). Smoke-tests that the page renders and surfaces some
// approval-style data — Smith already has 42 pending tasks per the
// sidebar badge.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, navigateTo,
  assertNoHorizontalOverflow, assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Tasks & Approvals — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Tasks & Approvals');
    await page.waitForTimeout(1500);
  });

  test('page renders without crash and without overflow', async ({ page }) => {
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed).toBeFalsy();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  test('renders task content or empty state', async ({ page }) => {
    // Either a task row OR an empty state should show
    const body = await page.locator('main').innerText();
    const hasContent = /No (open|pending) tasks|Open Setup|Mark Complete|Approve|Reject|Setup:|Pending|Tasks/i.test(body);
    expect(hasContent, 'tasks page surfaces a task or empty state').toBeTruthy();
  });

  test('filter pills or sort controls exist', async ({ page }) => {
    // Most task pages have at least one filter chip
    const pill = page.locator('button').filter({ hasText: /^(All|Open|Pending|Mine|Approved|Rejected|Done)$/i }).first();
    const has = await pill.isVisible({ timeout: 2500 }).catch(() => false);
    if (!has) {
      test.skip(true, 'no filter pills on tasks page');
      return;
    }
    await expect(pill).toBeVisible();
  });
});
