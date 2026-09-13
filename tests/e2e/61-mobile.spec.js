const { test, expect } = require("@playwright/test");

// Phase 5's mobile pass, as a standing check rather than a one-off look.
//
// Two things measured badly at iPhone width before this: Maintenance had
// 18 tap targets at 13x13 CSS pixels (the browser's default checkbox, far
// below a usable target), and the tenant sort select was 26px tall.
//
// The fix is in the primitives: Checkbox renders a 16px box but wraps an
// unlabelled one in a padded <label>, and clicking a label toggles the
// input it wraps -- so the TARGET grows while the box does not. Inputs
// carry a minimum height. That is why this measures the label, not the
// input: the tappable thing is not always the styled thing.
// Runs under the `iphone` project (see playwright.config.js), which owns
// the device descriptor and the session. Deliberately NOT
// test.use({...devices[...]}) on a desktop project -- see the note there.

const PAGES = ["dashboard", "tenants", "properties", "payments", "maintenance", "acct_reports"];

for (const pg of PAGES) {
  test(`${pg}: no sideways scroll and no tiny tap targets`, async ({ page }) => {
    test.setTimeout(180000);
    await page.goto(`/?company=sandbox-llc&n=${Date.now()}#${pg}`);
    // Wait for the app to be READY, not for a stopwatch. A fixed timeout
    // raced the paint here: six mobile contexts run in parallel, and
    // measuring mid-layout reported selects at 19px with no padding while
    // the same elements settled at 32-36px a moment later. Every
    // "undersized target" in the first version of this spec was that race.
    await page.waitForFunction(() => document.body.innerText.trim().length > 200,
      null, { timeout: 120000 });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForFunction(() => {
      // Layout has settled when two consecutive frames agree on the height
      // of the first form control -- measuring mid-paint is what reported
      // selects at 19px when they settle at 32px.
      const el = document.querySelector("select, input, button");
      if (!el) return true;
      const h = el.getBoundingClientRect().height;
      return new Promise(r => requestAnimationFrame(() =>
        r(Math.abs(el.getBoundingClientRect().height - h) < 0.5 && h > 0)));
    }, null, { timeout: 60000 });

    const r = await page.evaluate(() => {
      const de = document.documentElement;
      const small = [];
      for (const el of document.querySelectorAll("button, a[href], [role=tab], input, select")) {
        const box = el.closest("label") || el;
        const b = box.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;      // hidden
        if (b.height < 32 || b.width < 32) {
          const cs = getComputedStyle(el);
          small.push(`${Math.round(b.width)}x${Math.round(b.height)} ${el.tagName.toLowerCase()}` +
            `` +
            ` "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 16)}"`);
        }
      }
      return { overflow: de.scrollWidth - de.clientWidth, small,
               vw: window.innerWidth, dpr: window.devicePixelRatio };
    });

    console.log(`${pg}: viewport=${r.vw}px overflow=${r.overflow}px, undersized targets=${r.small.length}` +
      (r.small.length ? `\n   ${r.small.slice(0, 4).join("\n   ")}` : ""));
    expect(r.overflow, "the page scrolls sideways on a phone").toBeLessThanOrEqual(0);
    expect(r.small, `tap targets under 32px: ${r.small.slice(0, 3).join(", ")}`).toHaveLength(0);
  });
}
