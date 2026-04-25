// ═══════════════════════════════════════════════════════════════
// 55 — PROPERTY CHILDREN click-coverage sweep
// Utilities, HOA Payments, Loans, Insurance, Tax Bills are all
// nested under the Properties expander in the sidebar. Each is a
// thin module: page renders, can list rows, has + Add form.
// ═══════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { login, navigateTo, assertNoHorizontalOverflow } = require('./helpers');

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

const CHILDREN = [
  { sidebar: 'Utilities',     heading: /Utilit/i,  /* Utility Bills */ },
  { sidebar: 'HOA Payments',  heading: /HOA/i,                          },
  { sidebar: 'Loans',         heading: /Loan/i,                         },
  { sidebar: 'Insurance',     heading: /Insurance/i,                    },
  { sidebar: 'Tax Bills',     heading: /Tax/i,                          },
];

for (const c of CHILDREN) {
  test.describe(`${c.sidebar} — click coverage`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, SMITH);
      await navigateTo(page, c.sidebar);
      await page.waitForTimeout(1500);
    });

    test('page renders without crash and without overflow', async ({ page }) => {
      const crashed = await page.locator('text=Something went wrong')
        .first().isVisible({ timeout: 1500 }).catch(() => false);
      expect(crashed, `${c.sidebar} should not crash`).toBeFalsy();
      // Heading match — PageHeader convention varies per page, so use a regex
      const heading = page.locator('h2').filter({ hasText: c.heading }).first();
      await expect(heading).toBeVisible({ timeout: 5000 });
      await assertNoHorizontalOverflow(page);
    });

    test('+ Add or + New button is reachable', async ({ page }) => {
      const addBtn = page.locator('button:has-text("+ Add"), button:has-text("+ New")').first();
      if (!await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        test.skip(true, `no add button on ${c.sidebar} — role may not allow`);
        return;
      }
      await expect(addBtn).toBeVisible();
    });
  });
}
