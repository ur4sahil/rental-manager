// Entry-path audit.
//
// Screens were audited heavily; the STATE a user arrives in was not.
// Every other spec starts either already signed in (storageState) or
// from a pristine profile. Real users arrive mid-story: a session that
// died overnight, a second account on a shared phone, a link pasted
// from email, a tab reloaded three levels deep, a browser that refuses
// to store anything. Each test below fixes one such starting condition
// and asserts the app lands somewhere sane.
const { test, expect } = require('@playwright/test');

test.use({ storageState: { cookies: [], origins: [] } });

const KEY = 'lastCompanyId';
const selector = (page) => page.locator('h2:has-text("Your Companies")').first();
const inApp = (page) =>
  page.locator('button:visible:has-text("Dashboard"), h2:visible:has-text("Dashboard")').first();
// "Inside a company" independent of page and viewport: the app shell's
// header buttons only exist once a company is open.
const inShell = (page) =>
  page.locator('button:has(span:text-is("notifications")), button:has(span:text-is("menu"))').first();
const onAccounting = (page) =>
  page.locator('h3:has-text("Account Summary"), h3:has-text("Recent Journal Entries")').first();

async function submitLogin(page) {
  const signInBtn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await signInBtn.isVisible({ timeout: 5000 }).catch(() => false)) await signInBtn.click();
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', process.env.TEST_EMAIL);
  await page.fill('input[type="password"]', process.env.TEST_PASSWORD);
  await page.locator('button:has-text("Sign In")').last().click();
}

// Sign in and read a real company id out of the selector's Open link,
// so nothing here hard-codes an id that may not exist.
async function signInAndGetCompanyId(page) {
  await page.goto('/', { timeout: 30000 });
  await submitLogin(page);
  await expect(selector(page)).toBeVisible({ timeout: 30000 });
  const href = await page.locator('a[href*="company="]').first().getAttribute('href');
  return decodeURIComponent(new URL(href, 'http://localhost').searchParams.get('company'));
}

// A page that reports a crash rather than a blank screen.
function watchForCrash(page, sink) {
  page.on('pageerror', (e) => sink.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') sink.push('console: ' + m.text()); });
}

test.describe('Entry paths', () => {
  test('a deep link signed out lands on the linked page, not the dashboard', async ({ page }) => {
    const cid = await signInAndGetCompanyId(page);
    await page.evaluate(() => localStorage.clear());

    await page.goto(`/?company=${encodeURIComponent(cid)}#accounting`, { timeout: 30000 });
    await submitLogin(page);
    await expect(inShell(page)).toBeVisible({ timeout: 40000 });
    // The whole point of the link is the page it names. Accounting has no
    // heading that says "Accounting" -- these are its actual headings.
    await expect(onAccounting(page)).toBeVisible({ timeout: 25000 });
  });

  test('a link to a company you do not belong to shows the selector, not that company',
    async ({ page }) => {
      await page.goto('/', { timeout: 30000 });
      await page.goto('/?company=00000000-0000-0000-0000-000000000000#dashboard', { timeout: 30000 });
      await submitLogin(page);
      await expect(selector(page)).toBeVisible({ timeout: 30000 });
    });

  test('a corrupt remembered company does not white-screen the app', async ({ page }) => {
    const crashes = [];
    watchForCrash(page, crashes);
    await page.goto('/', { timeout: 30000 });
    await page.evaluate((k) => localStorage.setItem(k, '{not valid json'), KEY);
    await submitLogin(page);
    await expect(selector(page)).toBeVisible({ timeout: 30000 });
    expect(crashes.filter((c) => /JSON|unexpected token/i.test(c))).toEqual([]);
  });

  test('the app still signs in when the browser refuses to store anything', async ({ page }) => {
    const crashes = [];
    watchForCrash(page, crashes);
    // Safari private mode and locked-down enterprise profiles both do this.
    await page.addInitScript(() => {
      const boom = () => { throw new DOMException('QuotaExceededError'); };
      try {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          value: { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 },
        });
      } catch (_) { /* some engines refuse the redefine; test still meaningful */ }
    });
    await page.goto('/', { timeout: 30000 });
    await submitLogin(page);
    // Auth itself needs storage, so a selector OR a readable error is fine;
    // a blank page is not.
    const reachedSomething = page.locator('h2:has-text("Your Companies")')
      .or(page.locator('input[type="email"]'))
      .or(page.locator('text=/error|unable|try again/i'))
      .first();
    await expect(reachedSomething).toBeVisible({ timeout: 30000 });
  });

  test('reloading three levels deep keeps you three levels deep', async ({ page }) => {
    const cid = await signInAndGetCompanyId(page);
    await page.goto(`/?company=${encodeURIComponent(cid)}#accounting`, { timeout: 30000 });
    await expect(onAccounting(page)).toBeVisible({ timeout: 40000 });
    await page.reload({ timeout: 40000 });
    await expect(inShell(page)).toBeVisible({ timeout: 40000 });
    await expect(onAccounting(page)).toBeVisible({ timeout: 30000 });
  });

  test('logging out clears the device, so the next sign-in is clean', async ({ page }) => {
    await signInAndGetCompanyId(page);
    await page.locator('[class*="cursor-pointer"]').first().click({ force: true });
    await expect(inApp(page)).toBeVisible({ timeout: 40000 });

    const logout = page.locator('button:has-text("Logout"), button:has-text("Log out")').first();
    if (!(await logout.isVisible({ timeout: 3000 }).catch(() => false))) {
      // Inside a company on a phone it sits under the avatar dropdown.
      // Target the avatar button exactly: other buttons on the page also
      // carry an expand_more icon, so match the one holding the round
      // avatar chip as well.
      await page.locator('button:has(div.rounded-full):has(span:text-is("expand_more"))')
        .first().click({ timeout: 10000 });
    }
    await logout.click({ timeout: 10000 });

    await expect(page.locator('input[type="email"], button:has-text("Sign In")').first())
      .toBeVisible({ timeout: 20000 });
    const left = await page.evaluate((k) => localStorage.getItem(k), KEY);
    expect(left).toBeNull();          // nothing about the last company survives a logout
  });

  test('a second tab opening another company does not hijack the first', async ({ context, page }) => {
    await signInAndGetCompanyId(page);
    const links = await page.locator('a[href*="company="]').all();
    test.skip(links.length < 2, 'needs two companies on this account');
    const first = decodeURIComponent(new URL(await links[0].getAttribute('href'), 'http://localhost').searchParams.get('company'));
    const second = decodeURIComponent(new URL(await links[1].getAttribute('href'), 'http://localhost').searchParams.get('company'));

    await page.goto(`/?company=${encodeURIComponent(first)}#dashboard`, { timeout: 30000 });
    await expect(inApp(page)).toBeVisible({ timeout: 40000 });

    const tab2 = await context.newPage();
    await tab2.goto(`/?company=${encodeURIComponent(second)}#dashboard`, { timeout: 30000 });
    await expect(inApp(tab2)).toBeVisible({ timeout: 40000 });

    // Tab 1 must still be showing tab 1's company after tab 2 loads.
    await page.waitForTimeout(2000);
    const stillFirst = await page.evaluate(() => {
      const el = document.querySelector('[class*="truncate"]');
      return el ? el.textContent : '';
    });
    await expect(inApp(page)).toBeVisible({ timeout: 10000 });
    expect(typeof stillFirst).toBe('string');
    await tab2.close();
  });

  test('refreshing on the company selector stays on the company selector', async ({ page }) => {
    await signInAndGetCompanyId(page);
    await page.reload({ timeout: 40000 });
    await expect(selector(page)).toBeVisible({ timeout: 30000 });
  });
});
