const { defineConfig, devices } = require('@playwright/test');
require('dotenv').config();

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 90000,
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
    // Desktop browsers
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox-desktop',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit-desktop',   use: { ...devices['Desktop Safari'] } },
    // Tablet
    { name: 'ipad',  use: { ...devices['iPad Pro 11'] } },
    // Mobile
    { name: 'iphone', use: { ...devices['iPhone 14 Pro'] } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
});
