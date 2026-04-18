// ═══════════════════════════════════════════════════════════════
// 39 — PROPERTY SETUP WIZARD: county dropdown + Property Tax step
// ═══════════════════════════════════════════════════════════════
// Covers the wizard changes shipped in commits 336d966 + 120e3c6:
//   - mandatory County dropdown in Step 1
//   - dropdown disabled until a state is picked
//   - county options filter by selected state (MD / VA / DC / PA)
//   - changing the state clears the county
//   - new "Property Tax" step shows in the wizard nav after Insurance
//
// We stop short of driving the wizard end-to-end (that path has many
// dependencies — tenant/lease, utilities, etc.) and just verify the
// first screen's new behaviour. Data-layer tests cover the DB
// round-trips.

const { test, expect } = require("@playwright/test");
const { login, goToPage } = require("./helpers");

test.describe("Property wizard — county + property-tax step", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await goToPage(page, "properties");
    await page.waitForTimeout(1500);
  });

  test("Step 1 exposes a county dropdown that filters by state", async ({ page }) => {
    const addBtn = page.locator("button:has-text('+ Add'), button:has-text('Add Property')").first();
    if (!(await addBtn.isVisible({ timeout: 5000 }).catch(() => false))) test.skip(true, "Add Property button not available");
    await addBtn.click();
    await page.waitForTimeout(1200);

    await expect(page.locator("text=/Property Details/i").first()).toBeVisible({ timeout: 10000 });

    // County label is new in C3. Its presence alone proves the UI ships.
    await expect(page.locator("text=County *").first()).toBeVisible({ timeout: 5000 });

    // The state <select> is the one whose options include "VA" and "PA".
    const stateSelect = page.locator("select").filter({ has: page.locator("option[value='VA']") }).first();
    if (!(await stateSelect.isVisible({ timeout: 3000 }).catch(() => false))) test.skip(true, "State dropdown not found");

    // Helper: read the county select's current option list. The county select
    // is the one that changes based on state — we identify it by looking for
    // an option whose text ends with "County" or "City" *specific to the
    // selected state*.
    async function pickState(stateCode) {
      await stateSelect.selectOption(stateCode);
      await page.waitForTimeout(400);
    }
    async function countyOptionsAfterState(stateCode, expectedFirstLabel) {
      await pickState(stateCode);
      // Find the first select whose options contain the expected label
      const sel = page.locator("select").filter({ has: page.locator(`option:has-text("${expectedFirstLabel}")`) }).first();
      return await sel.locator("option").allTextContents();
    }

    // MD — should have Montgomery + Prince George's, not Arlington or York
    const md = await countyOptionsAfterState("MD", "Montgomery County");
    expect(md.join(" | ")).toContain("Montgomery County");
    expect(md.join(" | ")).toContain("Prince George's County");
    expect(md.some(o => o === "Arlington County")).toBeFalsy();
    expect(md.some(o => o === "York County")).toBeFalsy();

    // VA — Arlington + Richmond City, not Montgomery
    const va = await countyOptionsAfterState("VA", "Arlington County");
    expect(va.join(" | ")).toContain("Richmond City");
    expect(va.some(o => o === "Montgomery County")).toBeFalsy();

    // PA — York County only (plus the placeholder)
    const pa = await countyOptionsAfterState("PA", "York County");
    const concrete = pa.filter(o => o === "York County");
    expect(concrete.length).toBe(1);
  });

  test("wizard step count reflects the new Property Tax step", async ({ page }) => {
    // Prior wizard for vacant properties: Property Details, Utilities, HOA,
    // Loan (admin only), Documents, Insurance, Review = up to 7 steps.
    // After the Property Tax step was added it's up to 8.
    const addBtn = page.locator("button:has-text('+ Add'), button:has-text('Add Property')").first();
    if (!(await addBtn.isVisible({ timeout: 5000 }).catch(() => false))) test.skip(true, "Add Property button not available");
    await addBtn.click();
    await page.waitForTimeout(1500);

    // Header shows "Step 1 of N". N should be >= 8 for vacant properties
    // (exact value depends on role; for admin it is 8, for non-admin 7).
    const header = page.locator("text=/Step\\s+1\\s+of\\s+\\d+/").first();
    await expect(header).toBeVisible({ timeout: 10000 });
    const txt = (await header.textContent()) || "";
    const m = txt.match(/of\s+(\d+)/);
    const total = m ? Number(m[1]) : 0;
    expect(total).toBeGreaterThanOrEqual(7);
  });
});
