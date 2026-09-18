// ═══════════════════════════════════════════════════════════════
// 37 — LOGIN: A FAILED REQUEST MUST NOT HANG THE FORM
// ═══════════════════════════════════════════════════════════════
//
// The auth call can reject rather than return { error }: offline, DNS, a
// blocked or aborted fetch. Nothing caught that, so setLoading(false) never
// ran and the button sat on "Please wait..." for ever with no message --
// indistinguishable from a broken site.
//
// This aborts the auth request deliberately and asserts the form RECOVERS:
// the spinner ends, something is said, and a retry is possible. A unit test
// can check the try/finally is present; only a browser can confirm the
// button comes back.
const { test, expect } = require('@playwright/test');

// Its own context: no stored session, because this spec needs the login form.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Login resilience', () => {
  test('an aborted auth request leaves a usable form, not a stuck spinner', async ({ page }) => {
    // Fail the token request the way a dropped connection does.
    await page.route('**/auth/v1/token**', route => route.abort('failed'));

    await page.goto('/?company=sandbox-llc', { timeout: 60000 });
    const signIn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
    if (await signIn.isVisible({ timeout: 8000 }).catch(() => false)) await signIn.click();
    await page.waitForSelector('input[type="password"]', { timeout: 20000 });

    await page.fill('input[type="email"]', process.env.TEST_EMAIL || 'nobody@example.com');
    await page.fill('input[type="password"]', process.env.TEST_PASSWORD || 'wrong-password');
    const submit = page.locator('button:has-text("Sign In")').last();
    await submit.click();

    // 1. The spinner must END. This is the whole bug: it used to never clear.
    await expect(page.locator('text=/Please wait/i')).toBeHidden({ timeout: 25000 });

    // 2. Something must be SAID. A silent failure changes nothing on screen,
    //    so the person cannot tell a dead form from a wrong password.
    await expect(
      page.locator('text=/Could not reach the server|Something went wrong|Failed to fetch/i').first()
    ).toBeVisible({ timeout: 10000 });

    // 3. The button must be usable again, so a retry is possible.
    await expect(submit).toBeEnabled({ timeout: 10000 });

    // 4. And a retry with the route restored must actually work.
    await page.unroute('**/auth/v1/token**');
    await page.fill('input[type="password"]', process.env.TEST_PASSWORD || 'wrong-password');
    await submit.click();
    // Either it signs in, or it reports a real server answer. What it must
    // NOT do is hang again.
    await expect(page.locator('text=/Please wait/i')).toBeHidden({ timeout: 30000 });
  });
});
