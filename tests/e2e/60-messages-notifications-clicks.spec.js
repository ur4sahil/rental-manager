// ═══════════════════════════════════════════════════════════════
// 60 — MESSAGES + NOTIFICATIONS click-coverage sweep
// Smoke-tests the Messages and Notifications pages: tab strip,
// composer, settings/templates/log tabs. No seed dependencies —
// these pages render even on an empty company.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const {
  login, navigateTo,
  assertNoHorizontalOverflow, assertButtonsClickable,
} = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

test.describe('Messages — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Messages');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow', async ({ page }) => {
    // PageHeader title is "Messages"
    await expect(page.locator('h2:has-text("Messages")').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  test('tenant list and message thread panels render', async ({ page }) => {
    // Either we have threads with tenants OR an empty state
    const body = await page.locator('main').innerText();
    const hasThreadsOrEmpty = /No (messages|conversations|threads)|Compose|Send|tenant/i.test(body);
    expect(hasThreadsOrEmpty, 'messages page renders threads or empty state').toBeTruthy();
  });

  test('compose / send button is present', async ({ page }) => {
    const send = page.locator('button:has-text("Send"), button:has-text("Compose")').first();
    if (!await send.isVisible({ timeout: 3000 }).catch(() => false)) {
      test.skip(true, 'no compose/send button — needs a selected thread');
      return;
    }
    // Just assert it exists; don't actually send
    await expect(send).toBeVisible();
  });
});

test.describe('Notifications — click coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SMITH);
    await navigateTo(page, 'Notifications');
    await page.waitForTimeout(1500);
  });

  test('page renders without overflow', async ({ page }) => {
    await expect(page.locator('h2:has-text("Notifications")').first()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertButtonsClickable(page);
  });

  test('tab strip (Settings/Templates/Log) is reachable', async ({ page }) => {
    const tabs = ['Settings', 'Templates', 'Log'];
    let found = 0;
    for (const t of tabs) {
      const btn = page.locator(`button:has-text("${t}")`).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) found++;
    }
    expect(found, `at least one of ${tabs.join('/')} tabs is rendered`).toBeGreaterThan(0);
  });

  test('Settings tab is reachable and renders content', async ({ page }) => {
    const settingsTab = page.locator('button:has-text("Settings")').first();
    if (!await settingsTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'no Settings tab in current layout');
      return;
    }
    await settingsTab.click();
    await page.waitForTimeout(1000);
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed, 'Settings tab should not crash').toBeFalsy();
    // Settings tab should render some content (event types, channels,
    // toggles, or at minimum a heading). Loose check — the exact event
    // names vary by implementation.
    const body = await page.locator('main').innerText();
    expect(body.length, 'Settings tab body has content').toBeGreaterThan(20);
  });

  test('Log tab shows recent queue activity (no crash)', async ({ page }) => {
    const logTab = page.locator('button:has-text("Log")').first();
    if (!await logTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      test.skip(true, 'no Log tab in current layout');
      return;
    }
    await logTab.click();
    await page.waitForTimeout(1000);
    const crashed = await page.locator('text=Something went wrong').first().isVisible({ timeout: 1500 }).catch(() => false);
    expect(crashed, 'Log tab should not crash').toBeFalsy();
  });
});
