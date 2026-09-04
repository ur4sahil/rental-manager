// Every route loads cleanly: renders, logs no console error, and issues
// no failing request.
//
// This tier exists because the suite it joins had 500 tests and still
// missed a card that was blank for months. Dashboard.js sent up to 2,000
// journal entry ids back as an `.in(...)` filter; past roughly 650 the
// query string overflows and PostgREST answers 400. The response came
// back undefined, a guard skipped the calculation, and the year-to-date
// figures simply did not render. Nothing threw. A suite that asks "is
// the page visible" cannot see that. A suite that asks "did anything
// fail" catches it on the first run.
const { test, expect } = require('@playwright/test');
const { gotoRoute, watchForFailures, ROUTES } = require('./helpers');

// Routes needing data the sandbox may not have are still expected to
// LOAD; they simply may show an empty state.
const ROUTE_IDS = Object.keys(ROUTES);

test.describe('Every route loads without errors', () => {
  // Deliberately NOT serial: one broken route must not hide the other
  // thirty-three. A health sweep that stops at the first problem tells
  // you about one page and nothing about the rest.

  for (const routeId of ROUTE_IDS) {
    test(`${routeId} renders and logs nothing broken`, async ({ page }) => {
      const problems = watchForFailures(page);
      // No login() call: the session comes from the shared storageState
      // set up in auth.setup.js.
      await gotoRoute(page, routeId);

      // Rendered at all: <main> has to contain something interactive or
      // textual, not just an empty shell.
      const bodyText = await page.locator('body').innerText();
      expect(bodyText.length, `${routeId} rendered an empty page`).toBeGreaterThan(50);

      // Never silently show the login screen because a session expired
      // mid-run — that would make every later assertion meaningless.
      expect(bodyText, `${routeId} bounced to the sign-in screen`)
        .not.toContain('Property Management Made Simple');

      expect(problems, `${routeId} logged failures:\n  ${problems.join('\n  ')}`)
        .toEqual([]);
    });
  }
});
