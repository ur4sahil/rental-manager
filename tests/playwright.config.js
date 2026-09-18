const { defineConfig, devices } = require('@playwright/test');
require('dotenv').config();

module.exports = defineConfig({
  testDir: './e2e',
  // 3 minutes. The Accounting page on a real dataset genuinely takes
  // longer than 90s to settle, and a timeout there reports as "browser
  // closed" rather than anything informative. Raise the ceiling so a
  // slow page fails on an assertion that says something useful.
  timeout: 180000,
  expect: { timeout: 10000 },
  retries: 1,
  workers: 1,           // sequential — shared auth state
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.APP_URL || 'http://localhost:3000',
    // BLOCK SERVICE WORKERS.
    //
    // Tests want the deployment that was just built, not whatever a previous
    // one cached. This app is a PWA, and its worker serves /static/ cache-first
    // by design, so a run against a fresh deploy can otherwise be reading an
    // older bundle from a previous one.
    //
    // Correcting an earlier note here: this was first written up as the cause
    // of a hung login on the test site -- net::ERR_ABORTED on /auth/v1/token
    // with the form stuck on "Please wait...". That was wrong. The deployed
    // worker returns early for non-GET AND for cross-origin requests, so it
    // never touches a Supabase auth POST. The real fault was in LoginPage.js:
    // the auth call can REJECT rather than return { error }, nothing caught
    // it, and setLoading(false) never ran. Fixed there, with
    // e2e/37-login-resilience.spec.js holding it. Blocking workers here is
    // still right, for the reason above and not that one.
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    // Signs in once; every other project reuses the session. See
    // e2e/auth.setup.js for why.
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    // Desktop browsers
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'],
        storageState: './playwright/.auth/admin.json' }, dependencies: ['setup'] },
    { name: 'firefox-desktop',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-desktop',   use: { ...devices['Desktop Safari'] } },
    // Tablet
    { name: 'ipad',  use: { ...devices['iPad Pro 11'] } },
    // Mobile. Carries the signed-in session like the desktop project, so a
    // mobile spec exercises the real app rather than the landing page.
    //
    // A mobile spec must run HERE, not as test.use({...devices[...]}) on
    // top of chromium-desktop: mixing a phone descriptor into a desktop
    // project produced a context whose measurements disagreed with two
    // independent probes of the same page (selects reported 18px tall
    // with no padding, while the real element computed 32px/10px).
    { name: 'iphone', use: { ...devices['iPhone 14 Pro'],
        storageState: './playwright/.auth/admin.json' }, dependencies: ['setup'] },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
});
