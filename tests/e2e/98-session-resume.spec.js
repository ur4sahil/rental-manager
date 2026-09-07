// Signing in must always land on the company selector; only a page
// refresh may jump straight back into the last company.
//
// This is the case the rest of the suite structurally cannot reach:
// chromium-desktop always starts WITH a session (storageState), and
// every other project starts from a completely empty profile. Neither
// produces the real-world shape — leftover device state, no session —
// which is what happens on a phone when a session quietly expires.
// Self-contained on purpose: no shared auth, no fixed company id.
const { test, expect } = require('@playwright/test');

test.use({ storageState: { cookies: [], origins: [] } });

const KEY = 'lastCompanyId';
const selector = (page) => page.locator('h2:has-text("Your Companies")').first();
const inApp = (page) =>
  page.locator('button:visible:has-text("Dashboard"), h2:visible:has-text("Dashboard")').first();

async function submitLogin(page) {
  const signInBtn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await signInBtn.isVisible({ timeout: 5000 }).catch(() => false)) await signInBtn.click();
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', process.env.TEST_EMAIL);
  await page.fill('input[type="password"]', process.env.TEST_PASSWORD);
  await page.locator('button:has-text("Sign In")').last().click();
}

test.describe('Session resume vs fresh login', () => {
  test('a refresh resumes the last company, a fresh login does not', async ({ page }) => {
    await page.goto('/', { timeout: 30000 });
    await submitLogin(page);

    // A first-ever login has nothing to resume, so the selector is the
    // only correct destination.
    await expect(selector(page)).toBeVisible({ timeout: 30000 });
    await page.locator('[class*="cursor-pointer"]').first().click({ force: true });
    await expect(inApp(page)).toBeVisible({ timeout: 40000 });

    // 1. A refresh must NOT dump the user back to the selector.
    await page.reload({ timeout: 40000 });
    await expect(inApp(page)).toBeVisible({ timeout: 40000 });

    // 2. Drop only the auth session, exactly as an expiry does on a
    //    phone, and leave every other key in place.
    const cleared = await page.evaluate(() => {
      const gone = Object.keys(localStorage).filter(
        (k) => k.startsWith('sb-') || k.includes('supabase.auth')
      );
      gone.forEach((k) => localStorage.removeItem(k));
      return gone.length;
    });
    expect(cleared).toBeGreaterThan(0);         // an auth token was there to remove
    const survived = await page.evaluate((k) => localStorage.getItem(k), KEY);
    expect(survived).toBeTruthy();              // device state outlives the session

    // 3. Sign in again. This is a LOGIN, not a refresh: selector.
    await page.goto('/', { timeout: 30000 });
    await submitLogin(page);
    await expect(selector(page)).toBeVisible({ timeout: 30000 });
    await expect(inApp(page)).toBeHidden();
  });

  test('the stored choice is stamped with the account that made it', async ({ page }) => {
    await page.goto('/', { timeout: 30000 });
    await submitLogin(page);
    await expect(selector(page)).toBeVisible({ timeout: 30000 });
    await page.locator('[class*="cursor-pointer"]').first().click({ force: true });
    await expect(inApp(page)).toBeVisible({ timeout: 40000 });

    // A bare company id is browser-global; it must carry a user id so a
    // second account on the same device can never inherit it.
    const saved = await page.evaluate((k) => localStorage.getItem(k), KEY);
    expect(saved).toBeTruthy();
    expect(saved.startsWith('{')).toBe(true);
    const parsed = JSON.parse(saved);
    expect(parsed.c).toBeTruthy();              // stores the company id
    expect(parsed.u).toBeTruthy();              // stamped with the chooser
  });

  test("another account's leftover choice is never restored", async ({ page }) => {
    await page.goto('/', { timeout: 30000 });
    // A stamp from a different user id, as a shared device would carry.
    await page.evaluate(
      (k) => localStorage.setItem(k, JSON.stringify({
        u: '00000000-0000-0000-0000-000000000000',
        c: 'f56be35c-c80d-4f47-8624-cbb317f85461',
      })), KEY);
    await submitLogin(page);
    // A company saved by a different account must not be restored.
    await expect(selector(page)).toBeVisible({ timeout: 30000 });
  });
});
