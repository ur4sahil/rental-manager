// Logs in once and saves the session for every other spec.
//
// Without this each test signs in from scratch. On a real dataset that is
// roughly twelve seconds per test, which turned a fourteen-test run into
// eight minutes and made the suite too slow to run often enough to matter.
const { test: setup, expect } = require('@playwright/test');
const path = require('path');
const { login, TEST_COMPANY } = require('./helpers');

const authFile = path.join(__dirname, '..', 'playwright', '.auth', 'admin.json');

setup('authenticate as admin', async ({ page }) => {
  await login(page, TEST_COMPANY);
  await expect(
    page.locator('button:visible:has-text("Dashboard"), h2:visible:has-text("Dashboard")').first()
  ).toBeVisible({ timeout: 120000 });
  await page.context().storageState({ path: authFile });
});
