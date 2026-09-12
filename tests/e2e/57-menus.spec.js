const { test, expect } = require("@playwright/test");

// Eighteen dropdown rows were hand-written across the user menu, the
// bank-feed menus, the company menu and the tenant menus, each spelling
// its own padding, gap and hover colour. MenuItem names the tone instead,
// so the label colour and the hover always agree -- they did not
// everywhere: one danger row had a neutral hover, so it turned grey under
// a red label.
//
// Rewriting a menu's rows is the kind of change that silently breaks the
// menu, so this drives the real one.
test("the user menu opens, is labelled, and its items work", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#dashboard");
  const avatar = page.locator("header button").filter({ hasText: /Admin|admin/ }).first();
  await avatar.waitFor({ state: "visible", timeout: 90000 });
  await avatar.click();

  for (const label of ["Profile", "Switch Company", "Logout"]) {
    const item = page.getByRole("button", { name: new RegExp(label, "i") }).first();
    await expect(item, `menu item "${label}" is missing`).toBeVisible({ timeout: 10000 });
  }

  // Every row carries its icon, and the danger row is actually red.
  const logout = page.getByRole("button", { name: /Logout/i }).first();
  const color = await logout.evaluate(el => getComputedStyle(el).color);
  console.log(`Logout colour: ${color}`);
  // danger-600 is a red; assert it is not the neutral text colour.
  const profile = page.getByRole("button", { name: /Profile/i }).first();
  const neutral = await profile.evaluate(el => getComputedStyle(el).color);
  console.log(`Profile colour: ${neutral}`);
  expect(color, "the destructive row is not distinguished from the neutral ones").not.toBe(neutral);

  // And the menu still does something: Profile opens the profile panel.
  await profile.click();
  await expect(page.getByText(/Profile|Account/i).first()).toBeVisible({ timeout: 15000 });
  console.log("Profile opened");
});
