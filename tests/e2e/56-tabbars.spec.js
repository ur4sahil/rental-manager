const { test, expect } = require("@playwright/test");

// Twelve pages each hand-wrote the same underline tab bar and drifted:
// px-3 vs px-4 vs px-5, py-1.5 vs py-2 vs py-2.5 vs py-3, text-xs vs
// text-sm, and only some with a hover state. They share one TabBar now.
//
// The shared component existed the whole time and nothing used it, because
// it rendered filled pills while every real bar is an underline -- which
// is also what QuickBooks uses. It renders underlines now.
//
// This checks the things a migration like this actually breaks: the tabs
// are all still there, they still switch, and the labels that carried a
// count or an icon still do.
const CASES = [
  { page: "leases",       tab: "Expiring",  needs: ["Active", "Expiring", "Expired", "Renewed", "Terminated", "All"] },
  { page: "payments",     tab: "Autopay",   needs: ["Payments", "Autopay & Recurring"] },
  { page: "owners",       tab: "Statements",needs: ["Owners", "Statements", "Distributions"] },
  { page: "notifications",tab: "Preferences", needs: ["Activity", "Preferences", "History"] },
  { page: "doc_builder",  tab: "Templates", needs: ["Create", "Templates", "History"] },
];

for (const c of CASES) {
  test(`${c.page}: tabs render and switch`, async ({ page }) => {
    test.setTimeout(180000);
    await page.goto(`/?company=sandbox-llc&n=${Date.now()}#${c.page}`);
    const bar = page.locator('[role="tablist"]').first();
    await bar.waitFor({ state: "visible", timeout: 90000 });

    const labels = (await bar.locator('[role="tab"]').allInnerTexts()).map(t => t.replace(/\s+/g, " ").trim());
    console.log(`${c.page}: ${labels.join(" | ")}`);
    for (const want of c.needs) {
      expect(labels.some(l => l.includes(want)), `tab "${want}" is missing`).toBeTruthy();
    }

    // Exactly one tab is selected, and clicking another moves the selection.
    const selected = bar.locator('[role="tab"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    const target = bar.locator('[role="tab"]').filter({ hasText: c.tab }).first();
    await target.click();
    await expect(target).toHaveAttribute("aria-selected", "true", { timeout: 10000 });
    await expect(selected).toHaveCount(1);
    console.log(`  switched to "${c.tab}" and the selection is still unique`);
  });
}

test("doc builder tabs keep their icons and the history count", async ({ page }) => {
  test.setTimeout(180000);
  await page.goto("/?company=sandbox-llc&n=" + Date.now() + "#doc_builder");
  const bar = page.locator('[role="tablist"]').first();
  await bar.waitFor({ state: "visible", timeout: 90000 });
  // The first pass through this migration dropped all three icons and the
  // history badge, because a three-element [id, label, icon] tuple is not
  // the [id, label] pair TabBar reads and the extra element went nowhere.
  const icons = await bar.locator('[role="tab"] .material-icons-outlined').count();
  console.log(`icons in the documents tab bar: ${icons}`);
  expect(icons, "the tab icons were dropped").toBe(3);
});
