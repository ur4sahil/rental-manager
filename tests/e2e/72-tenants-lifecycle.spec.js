// Tenant lifecycle: list → detail drawer → leases → move-out → evictions
// → late fees → payments.
//
// The company under test is a real QuickBooks import: 73 active tenants,
// 41 properties, 36 tenants carrying an AR balance, and ZERO leases. That
// shape is the point. A suite seeded with tidy fixtures never sees what
// happens when a page's primary table is empty but the sidebar counter is
// not, or when every tenant's lease_status is a value the filter dropdown
// has never heard of. Every assertion below is written against invariants
// that must hold on that data, not against a golden row count.
//
// Nothing here commits a write. Create forms are opened, submitted empty
// to prove validation fires, and then cancelled. The move-out and eviction
// wizards are stepped into and abandoned. No E2E-TEST- records are needed
// because no record is ever created.
const { test, expect } = require('@playwright/test');
const { watchForFailures, TEST_COMPANY } = require('./helpers');

// ── helpers ───────────────────────────────────────────────────────────

// Navigate to a route and PROVE we landed on it.
//
// A cold load of `/?company=<id>#<route>` intermittently lands on the
// Dashboard instead. Two auth callbacks — the getSession() promise and
// the INITIAL_SESSION event — can both reach handleSelectCompany, and the
// second one re-derives the page from window.location.hash, which by then
// may read "#company_select" (setScreen writes snake_case; the filter that
// is supposed to reject screen names tests the camelCase "companySelect").
// The unrecognised page id then falls through safePage to the first
// allowed page. See the bug report accompanying this spec.
//
// Recovery uses the history-state channel the app's own popstate listener
// reads, which routes without a reload and without re-running auth. Every
// test below therefore starts from a page it has confirmed is the right
// one, so a failure downstream means a real defect rather than a lost race.
async function openRoute(page, routeId, heading) {
  const marker = page.locator('main h2').filter({ hasText: heading }).first();
  await page.goto(`/?company=${encodeURIComponent(TEST_COMPANY)}#${routeId}`, { timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await marker.isVisible({ timeout: attempt === 0 ? 20000 : 12000 }).catch(() => false)) return;
    await page.evaluate((p) => {
      window.history.pushState({ page: p, screen: 'app' }, '', '#' + p);
      window.dispatchEvent(new PopStateEvent('popstate', { state: { page: p, screen: 'app' } }));
    }, routeId);
    await page.waitForTimeout(1500);
  }
  await expect(marker, `never reached the ${routeId} route`).toBeVisible({ timeout: 20000 });
}

// Switch the Tenants page into table view. Table rows are countable and
// column-addressable; the default card grid is neither.
async function useTableView(page) {
  // Toolbar view toggle renders three glyph buttons: ▦ card, ☰ table,
  // ≡ compact. Match the glyph exactly — "table" appears nowhere in the
  // accessible name.
  await page.locator('main button', { hasText: '☰' }).first().click();
  await expect(page.locator('main table tbody tr').first()).toBeVisible({ timeout: 20000 });
}

const rows = (page) => page.locator('main table tbody tr');
// 1 checkbox · 2 Name · 3 Property · 4 Email · 5 Status · 6 Rent · 7 Balance · 8 Actions
const NAME_COL = 2, PROP_COL = 3, BAL_COL = 7;

// A toast is a plain div in the fixed z-[100] stack. Text match is the
// only stable handle — the container has no role or test id.
function toast(page, text) {
  return page.locator('div.fixed.bottom-4.right-4').getByText(text, { exact: false }).first();
}

// ── Tenants list ──────────────────────────────────────────────────────

test.describe('Tenants list', () => {
  test('renders every tenant with a real balance column', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'tenants', /^Tenants$/);

    await useTableView(page);
    const total = await rows(page).count();
    // The import carries 73 tenants. Assert a floor rather than the exact
    // number so a legitimate add doesn't fail the suite, but a floor high
    // enough that a silently-truncated query (PostgREST's default page,
    // a bad .limit(), an RLS regression) still trips it.
    expect(total, 'tenant list should render the whole imported roster').toBeGreaterThan(60);

    const balances = await rows(page).locator(`td:nth-child(${BAL_COL})`).allInnerTexts();
    expect(balances.length).toBe(total);
    const owing = balances.filter(b => b.trim().startsWith('-$'));
    const current = balances.filter(b => b.trim() === 'Current');
    // Real AR: many tenants owe, many are square. Both buckets must be
    // populated, and together they must account for every row — a third
    // rendering (blank cell, "NaN", "$undefined") means safeNum or the
    // formatter let something through.
    expect(owing.length, 'tenants with an outstanding balance').toBeGreaterThan(10);
    expect(current.length, 'tenants with no outstanding balance').toBeGreaterThan(10);
    expect(owing.length + current.length,
      `every balance cell must render as "-$x" or "Current"; got: ${
        balances.filter(b => !b.trim().startsWith('-$') && b.trim() !== 'Current').slice(0, 5).join(' | ')}`)
      .toBe(total);

    expect(problems, `tenants logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('search narrows the visible rows and Clear restores them', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'tenants', /^Tenants$/);
    await useTableView(page);
    const total = await rows(page).count();

    // Take a token off a real tenant name rather than inventing one, so
    // the test can't pass by matching nothing and can't be broken by a
    // fixture rename.
    const firstName = (await rows(page).first().locator(`td:nth-child(${NAME_COL})`).innerText()).trim();
    const token = firstName.split(/\s+/).filter(w => /^[A-Za-z]{4,}$/.test(w)).pop();
    expect(token, `could not derive a search token from "${firstName}"`).toBeTruthy();

    await page.locator('main input[placeholder*="Search name"]').fill(token);
    // Filtering is client-side and synchronous; give React a beat.
    await expect.poll(async () => rows(page).count(), { timeout: 15000 })
      .toBeLessThan(total);

    const matched = await rows(page).count();
    expect(matched, `search for "${token}" should still match its own tenant`).toBeGreaterThan(0);
    // Every surviving row must actually contain the token somewhere. The
    // filter also matches phone, which has no column — an alphabetic
    // token can't hit a phone number, so a row without the token would
    // mean the filter is matching the wrong field.
    const texts = await rows(page).allInnerTexts();
    for (const t of texts) {
      expect(t.toLowerCase(), `row survived the "${token}" filter without containing it`)
        .toContain(token.toLowerCase());
    }

    await page.locator('main button', { hasText: 'Clear Filters' }).first().click();
    await expect.poll(async () => rows(page).count(), { timeout: 15000 }).toBe(total);

    expect(problems, `tenant search logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('balance filter partitions the roster exactly', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'tenants', /^Tenants$/);
    await useTableView(page);
    const total = await rows(page).count();

    const balanceFilter = page.locator('main select').filter({ hasText: 'All Balances' }).first();

    await balanceFilter.selectOption('delinquent');
    await page.waitForTimeout(500);
    const delinquent = await rows(page).count();
    const delinquentCells = await rows(page).locator(`td:nth-child(${BAL_COL})`).allInnerTexts();
    for (const c of delinquentCells) {
      expect(c.trim(), 'a "Delinquent (owes)" row showed no balance owed').toMatch(/^-\$/);
    }

    await balanceFilter.selectOption('current');
    await page.waitForTimeout(500);
    const notOwing = await rows(page).count();
    const currentCells = await rows(page).locator(`td:nth-child(${BAL_COL})`).allInnerTexts();
    for (const c of currentCells) {
      expect(c.trim(), 'a "Current ($0)" row showed a balance owed').not.toMatch(/^-\$/);
    }

    await balanceFilter.selectOption('credit');
    await page.waitForTimeout(500);
    const credit = await rows(page).count();

    expect(delinquent, 'this dataset has tenants who owe money').toBeGreaterThan(0);
    expect(notOwing, 'this dataset has tenants who are square').toBeGreaterThan(0);
    // "Delinquent" is balance > 0 and "Current" is balance <= 0, so the
    // two are complementary and must sum to the whole roster. A tenant
    // with a null balance falling out of both is exactly the kind of gap
    // this catches.
    expect(delinquent + notOwing,
      'delinquent + current must cover every tenant (no row falls through both filters)')
      .toBe(total);
    // Credit (balance < 0) is a strict subset of Current (balance <= 0).
    expect(credit, 'credit balances must be a subset of the non-owing set')
      .toBeLessThanOrEqual(notOwing);

    expect(problems, `balance filter logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('property filter isolates a multi-tenant address', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'tenants', /^Tenants$/);
    await useTableView(page);

    // This portfolio has addresses with several tenants on file (current
    // and former). Find one from the rendered rows rather than hardcoding.
    const props = (await rows(page).locator(`td:nth-child(${PROP_COL})`).allInnerTexts()).map(s => s.trim());
    const counts = props.reduce((m, p) => (p ? { ...m, [p]: (m[p] || 0) + 1 } : m), {});
    const shared = Object.entries(counts).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    expect(shared.length, 'expected at least one address with more than one tenant').toBeGreaterThan(0);

    const [address, expected] = shared[0];
    const propFilter = page.locator('main select').filter({ hasText: 'All Properties' }).first();
    await propFilter.selectOption(address);
    await expect.poll(async () => rows(page).count(), { timeout: 15000 }).toBe(expected);

    // Every remaining row must be that exact address — not a prefix match,
    // not a sibling unit at the same street.
    const filtered = (await rows(page).locator(`td:nth-child(${PROP_COL})`).allInnerTexts()).map(s => s.trim());
    for (const p of filtered) expect(p).toBe(address);

    expect(problems, `property filter logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

// ── Tenant detail drawer ──────────────────────────────────────────────

test.describe('Tenant detail drawer', () => {
  test('opens on a delinquent tenant, tabs render, balance agrees with the list', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'tenants', /^Tenants$/);
    await useTableView(page);

    // Pick a tenant who actually owes money so the header's Balance tile
    // has something to be wrong about.
    const owingRow = rows(page).filter({ has: page.locator(`td:nth-child(${BAL_COL}):text-matches("^-\\\\$")`) }).first();
    await expect(owingRow).toBeVisible({ timeout: 20000 });
    const name = (await owingRow.locator(`td:nth-child(${NAME_COL})`).innerText()).trim();
    const listBalance = (await owingRow.locator(`td:nth-child(${BAL_COL})`).innerText()).trim();

    await owingRow.locator(`td:nth-child(${NAME_COL})`).click();

    const drawer = page.locator('div.fixed.inset-0.z-50').first();
    await expect(drawer).toBeVisible({ timeout: 20000 });
    await expect(drawer.locator('h2').first()).toHaveText(name);

    // The drawer recomputes the header tiles from the same row. If the
    // list says -$18,944.00 and the drawer says something else, one of
    // them is lying about what the tenant owes.
    const balanceTile = drawer.locator('div', { hasText: /^Balance$/ }).first()
      .locator('xpath=following-sibling::div').first();
    await expect(balanceTile).toHaveText(listBalance);

    // All four tabs must exist. The default panel is "detail", which the
    // Ledger tab treats as its own selected state.
    for (const label of ['Ledger', 'Documents', 'Messages', 'Actions']) {
      await expect(drawer.locator('button', { hasText: new RegExp(`^${label}$`) }).first())
        .toBeVisible({ timeout: 10000 });
    }

    // Ledger tab.
    await drawer.locator('button', { hasText: /^Ledger$/ }).first().click();
    await expect(drawer.getByText('Transaction History')).toBeVisible({ timeout: 15000 });
    const ledgerRows = drawer.locator('div.space-y-1 > div.flex.items-center.justify-between');
    const ledgerCount = await ledgerRows.count();
    if (ledgerCount === 0) {
      // A tenant carrying an AR balance with no transaction history is a
      // legitimate state for a QuickBooks import (balances came over,
      // line-level history did not). It must still render an explicit
      // empty state rather than a blank panel.
      await expect(drawer.getByText('No transactions yet')).toBeVisible();
    } else {
      // Every entry needs a description, a date, and a signed amount.
      for (let i = 0; i < Math.min(ledgerCount, 10); i++) {
        const text = await ledgerRows.nth(i).innerText();
        expect(text, 'ledger row is missing a date').toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(text, 'ledger row is missing a signed amount').toMatch(/[+-]\$/);
      }
    }

    // Documents tab: the required-docs checklist is the whole point of
    // this panel and is rendered from a constant, so it must always show.
    await drawer.locator('button', { hasText: /^Documents$/ }).first().click();
    await expect(drawer.getByText('Required Documents')).toBeVisible({ timeout: 15000 });
    for (const doc of ['Signed Lease Agreement', 'Government-Issued ID', 'Renters Insurance', 'Proof of Utility Transfer']) {
      await expect(drawer.getByText(doc, { exact: true }).first()).toBeVisible();
    }

    // Actions tab: five tiles, none of them clicked — every one of them
    // writes.
    await drawer.locator('button', { hasText: /^Actions$/ }).first().click();
    for (const action of ['Edit Tenant', 'Send Invite', 'Renew Lease', 'Move-Out', 'Archive Tenant']) {
      await expect(drawer.getByText(action, { exact: true }).first()).toBeVisible({ timeout: 10000 });
    }

    // Close and confirm the drawer really unmounts (a drawer that only
    // goes transparent still swallows clicks on the list beneath it).
    await drawer.locator('button:has(span:text("close"))').first().click();
    await expect(drawer).toBeHidden({ timeout: 10000 });
    await expect(rows(page).first()).toBeVisible();

    expect(problems, `tenant drawer logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

// ── Leases ────────────────────────────────────────────────────────────

test.describe('Leases', () => {
  test('zero leases renders an empty state, not an error', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'leases', 'Lease Management');

    // Stat cards must compute over an empty array without producing NaN.
    // "Avg Rent" divides by active.length — the classic 0/0 → NaN site.
    const statBlock = await page.locator('main').innerText();
    expect(statBlock, 'a stat card rendered NaN over an empty lease set').not.toMatch(/\bNaN\b/);
    expect(statBlock, 'a stat card rendered undefined over an empty lease set').not.toMatch(/undefined/);
    await expect(page.getByText('No leases found')).toBeVisible({ timeout: 15000 });

    expect(problems, `leases logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('new-lease form rejects an empty submit, then a dateless one, then cancels', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'leases', 'Lease Management');

    await page.locator('main button', { hasText: '+ New Lease' }).first().click();
    await expect(page.getByText('Create New Lease')).toBeVisible({ timeout: 10000 });

    // Empty submit → first validation gate.
    await page.locator('main button', { hasText: /^Create Lease$/ }).first().click();
    await expect(toast(page, 'Please select a tenant')).toBeVisible({ timeout: 10000 });

    // Choosing a tenant prefills the property from the tenant row. Two of
    // the 73 imported tenants have no property on file, so pin the
    // property explicitly rather than depending on which option lands at
    // index 1 — otherwise the next gate would sometimes be "select a
    // property" and sometimes "dates required", and the test would be
    // asserting the dataset instead of the validator.
    const tenantSelect = page.locator('main select').filter({ hasText: 'Select tenant...' }).first();
    const options = await tenantSelect.locator('option').allTextContents();
    expect(options.length, 'the new-lease tenant dropdown should list the roster').toBeGreaterThan(10);
    await tenantSelect.selectOption({ index: 1 });
    await page.waitForTimeout(500);

    const propertySelect = page.locator('main select').filter({ hasText: 'Select property...' }).first();
    const propOptions = await propertySelect.locator('option').allTextContents();
    expect(propOptions.length, 'the property dropdown should list the portfolio').toBeGreaterThan(10);
    await propertySelect.selectOption({ index: 1 });
    await page.waitForTimeout(300);

    // Tenant and property satisfied; dates are the next gate. Rent is
    // checked AFTER dates, so this proves the date validator fires on its
    // own rather than being masked by the rent check.
    await page.locator('main button', { hasText: /^Create Lease$/ }).first().click();
    await expect(toast(page, 'Lease start and end dates are required')).toBeVisible({ timeout: 10000 });

    // Fill dates the wrong way round: end before start must be rejected
    // even though every required field now has a value.
    await page.locator('main input[type="date"]').nth(0).fill('2026-12-01');
    await page.locator('main input[type="date"]').nth(1).fill('2026-01-01');
    await page.locator('main input[placeholder="1500.00"]').first().fill('1500');
    await page.locator('main button', { hasText: /^Create Lease$/ }).first().click();
    await expect(toast(page, 'Lease end date must be after start date')).toBeVisible({ timeout: 10000 });

    // Abandon without committing.
    await page.locator('main button', { hasText: /^Cancel$/ }).first().click();
    await expect(page.getByText('Create New Lease')).toBeHidden({ timeout: 10000 });
    // Still zero leases: nothing was written by the two rejected submits.
    await expect(page.getByText('No leases found')).toBeVisible();

    expect(problems, `new-lease validation logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

// ── Move-out wizard ───────────────────────────────────────────────────

test.describe('Move-out wizard', () => {
  // The wizard has two legitimate shapes, and which one you get is a
  // property of the data, not of the code being right or wrong:
  //   • at least one tenant with lease_status = "active"  → the 5-step rail
  //   • none (this QuickBooks import: all 73 are "past")  → an empty state
  // Asserting only one shape would make this test a hostage to the
  // fixture. Assert the contract that must hold in BOTH: the wizard never
  // offers a path to commit a move-out for nobody.
  async function moveOutShape(page) {
    const rail = page.getByText('Select Tenant & Move-Out Date');
    const empty = page.getByText('No tenants with an active lease');
    await expect(rail.or(empty).first(),
      'Move-Out Wizard rendered neither the step rail nor an empty state')
      .toBeVisible({ timeout: 20000 });
    return (await rail.isVisible().catch(() => false)) ? 'rail' : 'empty';
  }

  test('offers no route to commit a move-out without a tenant', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'moveout', 'Move-Out Wizard');
    const shape = await moveOutShape(page);

    if (shape === 'rail') {
      // All five steps advertised up front.
      for (const s of ['Select Tenant', 'Inspection', 'Deposit', 'AR Settlement', 'Confirm']) {
        await expect(page.getByText(s, { exact: true }).first()).toBeVisible({ timeout: 10000 });
      }
      // The gate: Next is disabled until a tenant is chosen. This is the
      // only thing standing between an empty selection and a wizard that
      // goes on to post deposit and AR journal entries for `null`.
      const next = page.locator('main button', { hasText: 'Next' }).first();
      await expect(next).toBeDisabled();
      await next.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      await expect(page.getByText('Select Tenant & Move-Out Date')).toBeVisible();
      await expect(page.getByText('Move-Out Inspection')).toBeHidden();
    } else {
      // Empty state: it must explain itself and offer a way out, not just
      // render a dead select and a permanently disabled Next.
      await expect(page.getByText('No tenants with an active lease')).toBeVisible();
      await expect(page.locator('main')).toContainText('lease status is Active');
      await expect(page.locator('main button', { hasText: 'Go to Tenants' }).first()).toBeVisible();
      // And crucially, the wizard itself must NOT be reachable behind it.
      await expect(page.locator('main select')).toHaveCount(0);
      await expect(page.locator('main button', { hasText: 'Next' })).toHaveCount(0);
    }

    // Either way, nothing was committed.
    await expect(page.getByText('Move-Out Complete')).toBeHidden();
    expect(problems, `move-out wizard logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('never pre-selects a tenant on step 1', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'moveout', 'Move-Out Wizard');
    const shape = await moveOutShape(page);
    test.skip(shape === 'empty', 'no tenant carries an active lease in this company');

    const select = page.locator('main select').first();
    await expect(select).toBeVisible({ timeout: 15000 });
    // A wizard that pre-selected a tenant would arm Next on load.
    await expect(select).toHaveValue('');
    await expect(select.locator('option').first()).toHaveText('Select tenant...');

    // Move-out date, property, rent and deposit summary are all gated
    // behind a selection. exact:true matters — the step-1 heading is
    // "Select Tenant & Move-Out Date", which a substring match would
    // happily count as the date field being on screen.
    await expect(page.getByText('Move-Out Date', { exact: true })).toBeHidden();
    await expect(page.getByText('Security Deposit', { exact: true })).toBeHidden();

    expect(problems, `move-out step 1 logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

// ── Evictions ─────────────────────────────────────────────────────────

test.describe('Evictions', () => {
  test('tracker renders stat cards over an empty case list', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'evictions', 'Eviction Tracker');

    for (const label of ['Active Cases', 'In Court', 'Total Costs', 'Closed']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 10000 });
    }
    const body = await page.locator('main').innerText();
    expect(body, 'an eviction stat card rendered NaN').not.toMatch(/\bNaN\b/);
    expect(body, 'an eviction stat card rendered undefined').not.toMatch(/undefined/);

    expect(problems, `evictions logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('new-case form rejects an empty submit, accepts a tenant, then cancels', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'evictions', 'Eviction Tracker');

    await page.locator('main button', { hasText: '+ New Case' }).first().click();
    await expect(page.getByText('Start Eviction Case')).toBeVisible({ timeout: 10000 });

    // Empty submit must be refused. If this ever silently succeeds it
    // writes an eviction_cases row with a null tenant — a legal document
    // generator pointed at nobody.
    await page.locator('main button', { hasText: /^Start Case$/ }).first().click();
    await expect(toast(page, 'Select a tenant')).toBeVisible({ timeout: 10000 });

    // The dropdown must actually be populated — unlike the move-out
    // wizard, evictions read every non-archived tenant regardless of
    // lease_status, so the whole roster belongs here.
    const tenantSelect = page.locator('main select').filter({ hasText: 'Select tenant...' }).first();
    const options = await tenantSelect.locator('option').allTextContents();
    expect(options.length, 'the eviction tenant dropdown should list the roster').toBeGreaterThan(10);
    // Tenants who owe money are annotated with the amount — that annotation
    // is what makes the picker usable for a non-payment filing.
    expect(options.some(o => /owes\s+\$/.test(o)),
      'expected at least one tenant annotated with an amount owed').toBeTruthy();

    await tenantSelect.selectOption({ index: 1 });
    await page.waitForTimeout(400);
    await expect(tenantSelect).not.toHaveValue('');

    // Abandon before Start Case — deliberately never clicked with a valid
    // selection, since that would file a real case.
    await page.locator('main button', { hasText: /^Cancel$/ }).first().click();
    await expect(page.getByText('Start Eviction Case')).toBeHidden({ timeout: 10000 });

    // Nothing filed: the Active Cases counter is unchanged at zero.
    // StatCard renders <label> then <value>, so the number is the
    // following sibling of the label div.
    const activeCard = page.locator('main').getByText('Active Cases', { exact: true }).first()
      .locator('xpath=following-sibling::div[1]');
    await expect(activeCard).toHaveText('0');

    expect(problems, `eviction form logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

// ── Late fees ─────────────────────────────────────────────────────────

test.describe('Late fees', () => {
  test('rule form rejects empty and non-positive fees, then cancels without creating a rule', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'latefees', 'Late Fee Automation');

    for (const label of ['Overdue', 'Past Grace Period', 'Total Overdue']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 10000 });
    }

    await page.locator('main button', { hasText: '+ New Rule' }).first().click();
    await expect(page.getByText('New Late Fee Rule')).toBeVisible({ timeout: 10000 });

    const save = page.locator('main button', { hasText: /^Save Rule$/ }).first();
    const nameInput = page.locator('main input[placeholder="Standard Late Fee"]').first();
    const graceInput = page.locator('main input[placeholder="5"]').first();
    const feeInput = page.locator('main input[placeholder="50.00"]').first();

    // The name must start EMPTY. That is what makes "+ New Rule" →
    // "Save Rule" a deliberate act instead of a one-click insert of a
    // fully pre-filled row — an earlier build seeded the name too, and
    // clicking Save on what looked like a blank form created a live rule.
    // The numeric policy fields stay seeded from company settings.
    await expect(nameInput, 'a new rule must not arrive pre-named').toHaveValue('');
    await expect(graceInput, 'grace period should be seeded from settings').not.toHaveValue('');
    await expect(feeInput, 'fee amount should be seeded from settings').not.toHaveValue('');

    // 1. Nothing typed → the name gate fires first.
    await save.click();
    await expect(toast(page, 'Rule name is required')).toBeVisible({ timeout: 10000 });

    // 2. Named, but the seeded numbers cleared.
    await nameInput.fill('E2E-TEST-should-never-be-saved');
    await graceInput.fill('');
    await feeInput.fill('');
    await save.click();
    await expect(toast(page, 'Please fill all fields')).toBeVisible({ timeout: 10000 });

    // 3. Fee of zero — a $0 late fee rule is meaningless and would
    //    silently post zero-dollar journal entries forever.
    await graceInput.fill('5');
    await feeInput.fill('0');
    await save.click();
    await expect(toast(page, 'Fee amount must be a positive number')).toBeVisible({ timeout: 10000 });

    // 4. Negative grace — would make every payment retroactively late.
    await graceInput.fill('-3');
    await feeInput.fill('50');
    await save.click();
    await expect(toast(page, 'Grace days must be a valid number')).toBeVisible({ timeout: 10000 });

    await page.locator('main button', { hasText: /^Cancel$/ }).first().click();
    await expect(page.getByText('New Late Fee Rule')).toBeHidden({ timeout: 10000 });

    // No rule was created: the "Active Rules" section only renders when
    // rules.length > 0.
    await expect(page.getByText('Active Rules')).toBeHidden();

    expect(problems, `late fee form logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

// ── Payments ──────────────────────────────────────────────────────────

test.describe('Payments', () => {
  test('Stripe tab totals agree with the rows it renders', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'payments', 'Stripe Payments');

    await expect(page.locator('main').getByText('Transactions', { exact: true }).first()).toBeVisible({ timeout: 15000 });
    const txCount = Number((await page.locator('main').getByText('Transactions', { exact: true }).first()
      .locator('xpath=following-sibling::div[1]').innerText()).replace(/[^0-9]/g, ''));
    const rendered = await page.locator('main table tbody tr').count();
    // The counter and the table are computed from the same array; if they
    // disagree, one of them is reading stale state.
    expect(rendered, 'Transactions stat card disagrees with the rendered rows').toBe(txCount);

    if (rendered === 0) {
      await expect(page.getByText('No payment transactions found')).toBeVisible();
      // Total Collected must be a real zero, not blank or NaN.
      const total = await page.locator('main').getByText('Total Collected', { exact: true }).first()
        .locator('xpath=following-sibling::div[1]').innerText();
      expect(total.trim(), 'Total Collected over an empty set').toMatch(/^\$0(\.00)?$/);
    }

    // Typing in the search box re-queries the server. It must not error,
    // and it must not resurrect rows out of an empty result set.
    await page.locator('main input[placeholder*="Search tenant"]').fill('zzz-no-such-tenant');
    await page.waitForTimeout(2500);
    expect(await page.locator('main table tbody tr').count(),
      'an impossible search term returned rows').toBe(0);
    await page.locator('main button', { hasText: /^Clear$/ }).first().click();
    await page.waitForTimeout(2000);
    expect(await page.locator('main table tbody tr').count()).toBe(rendered);

    expect(problems, `payments logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  test('autopay schedule form validates in order, then cancels', async ({ page }) => {
    const problems = watchForFailures(page);
    await openRoute(page, 'payments', 'Stripe Payments');

    await page.locator('main button', { hasText: 'Autopay & Recurring' }).first().click();
    await expect(page.locator('main h2', { hasText: 'Autopay & Recurring Rent' })).toBeVisible({ timeout: 20000 });

    await page.locator('main button', { hasText: '+ New Schedule' }).first().click();
    await expect(page.getByText('New Autopay Schedule')).toBeVisible({ timeout: 10000 });

    const save = page.locator('main button', { hasText: /^Save Schedule$/ }).first();

    // Empty → tenant gate.
    await save.click();
    await expect(toast(page, 'Please select a tenant')).toBeVisible({ timeout: 10000 });

    // Choosing a tenant prefills amount from tenants.rent. On this
    // QuickBooks import rent is frequently blank, so the next gate is
    // either the amount or the start date — assert one of them fires,
    // and that the form has NOT been submitted either way.
    const tenantSelect = page.locator('main select').filter({ hasText: 'Select tenant...' }).first();
    await tenantSelect.selectOption({ index: 1 });
    await page.waitForTimeout(400);
    await save.click();
    await expect(
      page.locator('div.fixed.bottom-4.right-4')
        .getByText(/valid positive amount|Start date is required/)
        .first()
    ).toBeVisible({ timeout: 10000 });

    await page.locator('main button', { hasText: /^Cancel$/ }).first().click();
    await expect(page.getByText('New Autopay Schedule')).toBeHidden({ timeout: 10000 });
    // Nothing scheduled.
    await expect(page.getByText('No autopay schedules yet. Create one above.')).toBeVisible({ timeout: 10000 });

    expect(problems, `autopay form logged failures:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});
