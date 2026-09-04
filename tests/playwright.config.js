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
    // Mobile
    { name: 'iphone', use: { ...devices['iPhone 14 Pro'] } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
});
