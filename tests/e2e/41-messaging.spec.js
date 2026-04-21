// ═══════════════════════════════════════════════════════════════
// 41 — MESSAGING (admin Messages page + tenant portal thread)
// Covers: page loads, conversation list renders, thread opens,
// composer disabled with empty input, attachment picker, send path.
// Doesn't cross-log-in as a tenant — that's left to the unit tests,
// which can drive the DB directly without swapping auth contexts.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, goToPage } = require('./helpers');

test.describe('Messages Module', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, 'messages');
    await page.waitForTimeout(1500);
  });

  test('messages page loads without error', async ({ page }) => {
    const hasError = await page.locator('text=Something went wrong').first().isVisible({ timeout: 3000 }).catch(() => false);
    expect(hasError).toBeFalsy();
    await expect(page.locator('text=Messages').first()).toBeVisible();
  });

  test('conversation list shows a search input', async ({ page }) => {
    const search = page.locator('input[placeholder*="Search tenants"]');
    await expect(search).toBeVisible();
  });

  test('selecting a tenant opens the right pane', async ({ page }) => {
    // Click the first tenant in the left pane (any button row with an avatar).
    const firstConvo = page.locator('button.w-full.text-left').first();
    if (await firstConvo.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstConvo.click();
      await page.waitForTimeout(800);
      // Composer appears when a conversation is selected.
      const composer = page.locator('textarea[placeholder*="Message"]').first();
      await expect(composer).toBeVisible();
    }
  });

  test('send button disabled when textarea empty and no attachment', async ({ page }) => {
    const firstConvo = page.locator('button.w-full.text-left').first();
    if (await firstConvo.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstConvo.click();
      await page.waitForTimeout(500);
      const sendBtn = page.locator('button:has-text("Send")').last();
      await expect(sendBtn).toBeDisabled();
    }
  });

  test('attachment picker renders', async ({ page }) => {
    const firstConvo = page.locator('button.w-full.text-left').first();
    if (await firstConvo.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstConvo.click();
      await page.waitForTimeout(500);
      const attach = page.locator('button[title="Attach file"]');
      await expect(attach).toBeVisible();
    }
  });

  test('typing enables the send button', async ({ page }) => {
    const firstConvo = page.locator('button.w-full.text-left').first();
    if (await firstConvo.isVisible({ timeout: 3000 }).catch(() => false)) {
      await firstConvo.click();
      await page.waitForTimeout(500);
      const composer = page.locator('textarea[placeholder*="Message"]').first();
      await composer.fill('hello from e2e');
      const sendBtn = page.locator('button:has-text("Send")').last();
      await expect(sendBtn).toBeEnabled();
    }
  });
});
