const { test, expect } = require("@playwright/test");

// Keyboard focus was invisible everywhere.
//
// Btn, IconBtn and TextLink -- 576 buttons across the app -- had no focus
// state at all, so a keyboard or screen-reader user could not see where
// they were. The ring is defined once in ui.js now. It is also why
// brand-400 had to be added: the ramp jumped 300 -> 500, and there was no
// step that stays visible both on white and on a brand-600 fill.
test("keyboard focus is visible on the app's buttons", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#tenants");
  await page.locator("button").first().waitFor({ state: "visible", timeout: 90000 });

  // Tab until a real, visible control has focus, then read its ring.
  let checked = 0, ringed = 0;
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        label: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 28),
        // A ring is a box-shadow in Tailwind; an outline counts too.
        shadow: cs.boxShadow,
        outline: cs.outlineStyle + " " + cs.outlineWidth,
      };
    });
    if (!info || info.tag !== "button") continue;
    checked++;
    const visible = (info.shadow && info.shadow !== "none") ||
                    (info.outline && !/none/.test(info.outline));
    if (visible) ringed++;
    else console.log(`  no focus indicator: <${info.tag}> "${info.label}"  shadow=${info.shadow}`);
    if (checked >= 6) break;
  }
  console.log(`buttons tabbed: ${checked}, with a visible focus indicator: ${ringed}`);
  expect(checked, "tabbing reached no buttons at all").toBeGreaterThan(0);
  expect(ringed, "no button showed a focus indicator").toBe(checked);
});

// The command palette existed but was reachable only by Cmd/Ctrl-K, with
// nothing on screen to say so -- so for anyone who had not been told, the
// app had no search.
test("the top bar has a search box that opens the command palette", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#dashboard");

  const trigger = page.locator('header button[aria-label*="Search or jump to"]');
  await trigger.waitFor({ state: "visible", timeout: 90000 });
  const label = (await trigger.innerText()).replace(/\s+/g, " ").trim();
  console.log(`search trigger: "${label}"`);
  // It advertises its own shortcut, which is the part that was missing.
  expect(label).toMatch(/⌘K|CtrlK|Ctrl K/);

  await trigger.click();
  // The palette's own input takes focus.
  const box = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
  await box.waitFor({ state: "visible", timeout: 15000 });
  await expect(box).toBeFocused();
  await box.fill("tenants");
  await page.waitForTimeout(400);
  const results = await page.locator('[role="option"], [data-palette-item]').count();
  console.log(`palette opened and filtered to ${results} result(s) for "tenants"`);

  // And it still closes on Escape.
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0, { timeout: 10000 });
  console.log("Escape closed it");
});
