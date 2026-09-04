// ═══════════════════════════════════════════════════════════════════════
// PROPERTIES module — functional behaviour, not just "the page loaded".
//
// Covers: properties, maintenance, inspections, utilities, hoa, loans,
// insurance, tax_bills.
//
// Every assertion here is written so that it can FAIL. Filters must
// change the visible row count; a detail drawer must show the values of
// the row that was clicked; a create form must refuse an empty submit
// with the exact message the source promises. Counting "the page has
// more than 50 characters of text" is what let a broken module sit in
// the suite unnoticed, so none of that appears below.
//
// ── Navigation ────────────────────────────────────────────────────────
// gotoRoute() is given `?company=<id>#<route>`, and App.js's auto-select
// path runs `history.replaceState({}, "", window.location.pathname)`
// (App.js:717) which throws the hash away before the deep-link is
// replayed — every such load lands on Dashboard. So the primary
// navigation here is a plain `/#<route>` load, which restores the
// company from localStorage (lastCompanyId, already in the shared
// storageState) and honours the deep-link. gotoRoute + a sidebar click
// is kept as the fallback so the spec still works if that ever changes.
//
// ── Data ──────────────────────────────────────────────────────────────
// The test company has 41 properties and nothing in the child modules.
// HOA / Loans / Insurance are the three children whose rows can be
// created AND removed entirely through the UI, so those tests seed a
// row named `E2E-TEST-<timestamp>`, prove the list/filter/drawer
// behaviour against it, and delete it in a finally block. Maintenance,
// Inspections and Utilities have no delete control in the UI (see the
// report accompanying this file), so those tests exercise validation
// and cancel without writing anything.
const { test, expect } = require('@playwright/test');
const { gotoRoute, navigateTo, watchForFailures } = require('./helpers');

// PageHeader renders an <h2>; that is the proof a route really rendered.
const HEADING = {
  properties:  'Properties',
  maintenance: 'Maintenance',
  inspections: 'Inspections',
  utilities:   'Utilities',
  hoa:         'HOA Payments',
  loans:       'Loans',
  insurance:   'Insurance',
  tax_bills:   'Property Tax Bills',
};

// Sidebar labels, for the fallback navigation path only.
const SIDEBAR = {
  properties: 'Properties', maintenance: 'Maintenance', inspections: 'Inspections',
  utilities: 'Utilities', hoa: 'HOA Payments', loans: 'Loans',
  insurance: 'Insurance', tax_bills: 'Tax Bills',
};

async function open(page, routeId) {
  const heading = page.locator(`main h2:text-is("${HEADING[routeId]}")`).first();
  await page.goto(`/#${routeId}`, { timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  if (await heading.isVisible({ timeout: 45000 }).catch(() => false)) return;
  // Fallback: full load then click through the sidebar.
  await gotoRoute(page, routeId);
  await navigateTo(page, SIDEBAR[routeId]).catch(() => {});
  await heading.waitFor({ state: 'visible', timeout: 45000 });
}

// PropertySelect fetches its options from Supabase after mount, so a
// form that has only just opened still shows nothing but the
// "Select property..." placeholder. Reading options straight away
// yields an empty array and selectOption() throws. Wait for the real
// options, then pick the first and hand its address back.
async function pickFirstProperty(scope) {
  const sel = scope.locator('select:has(option:text-is("Select property..."))').first();
  await expect.poll(() => sel.locator('option').count(), { timeout: 30000 })
    .toBeGreaterThan(1);
  const addresses = await sel.locator('option').evaluateAll(
    os => os.map(o => o.value).filter(Boolean));
  await sel.selectOption(addresses[0]);
  await expect(sel).toHaveValue(addresses[0]);
  return addresses[0];
}

// Open a specific property's detail drawer from the Properties list.
async function openPropertyDrawer(page, address) {
  await open(page, 'properties');
  await page.locator('main input[placeholder="Search properties..."]').fill(address);
  const card = propertyCards(page).filter({ hasText: address.split(',')[0].trim() }).first();
  await expect(card).toBeVisible({ timeout: 30000 });
  // Click the address heading, not the card's geometric centre: the
  // action strip ("Edit / Add Tenant / Delete / …") occupies most of a
  // card's lower half and stops propagation, so a centre-click is
  // swallowed and the drawer never opens.
  await card.locator('h3').click();
  const drawer = page.locator('div.fixed.inset-0.z-50.justify-end').first();
  await expect(drawer).toBeVisible({ timeout: 30000 });
  return drawer;
}

// Toasts live 4s, so assert on them straight after the action. Scoped
// to the toast container so a match cannot come from page copy, and
// matched as a substring so a fragment of a long message still works.
function toast(page, text) {
  return expect(
    page.locator('div.fixed.bottom-4.right-4').getByText(text, { exact: false }).first()
  ).toBeVisible({ timeout: 8000 });
}

// Wait for the toast stack to empty (they self-dismiss after 4s).
// Sequential validation steps have to start from a clean stack,
// otherwise the assertion for step 2 can resolve against the toast
// still on screen from step 1 — or race the re-render that produces it.
async function toastsCleared(page) {
  await expect(page.locator('div.fixed.bottom-4.right-4 > div'))
    .toHaveCount(0, { timeout: 10000 });
}

// The custom confirm dialog (ConfirmModal, z-[90]).
async function confirmDialog(page, action = 'Delete') {
  const modal = page.locator('div.fixed.inset-0.z-\\[90\\]').first();
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  await modal.locator(`button:text-is("${action}")`).first().click();
  await modal.waitFor({ state: 'hidden', timeout: 15000 });
}

// One of the four stat tiles on the Properties page ("Total", "Occupied",
// "Vacant", "Total Rent") — matched on the exact label so "Total" does
// not also pick up "Total Rent".
async function propertyStat(page, label) {
  const tile = page.locator('main div.rounded-3xl.text-center')
    .filter({ has: page.locator(`div.text-xs:text-is("${label}")`) }).first();
  const txt = await tile.innerText();
  return Number(txt.replace(/[^0-9]/g, ''));
}

const propertyCards = (page) =>
  page.locator('main div.cursor-pointer.rounded-xl.shadow-sm:has(h3)');

// The three Properties filter dropdowns, identified by an option only
// that dropdown has. Positional indexes break as soon as the optional
// owner / ownership selects appear on a different dataset.
const statusFilter = (page) => page.locator('main select:has(option[value="occupied"])').first();
const typeFilter   = (page) => page.locator('main select:has(option:text-is("All Types"))').first();
const cityFilter   = (page) => page.locator('main select:has(option:text-is("All Cities"))').first();

// ═══════════════════════════════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════════════════════════════

test('properties: list renders real rows and the header counts agree with them', async ({ page }) => {
  await open(page, 'properties');

  const cards = propertyCards(page);
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  const shown = await cards.count();
  expect(shown, 'the sandbox must have properties for this suite to mean anything')
    .toBeGreaterThan(0);

  // "Active (41)" pill, the Total stat tile and the number of rendered
  // cards are three independent code paths over the same array. If any
  // one of them drifts the page is lying to the user somewhere.
  const activePill = await page.locator('main button:has-text("Active (")').first().innerText();
  const activeCount = Number(activePill.replace(/[^0-9]/g, ''));
  expect(activeCount, '"Active (n)" pill vs rendered cards').toBe(shown);
  expect(await propertyStat(page, 'Total'), 'Total stat vs rendered cards').toBe(shown);

  // Occupied + Vacant cannot exceed the total.
  const occupied = await propertyStat(page, 'Occupied');
  const vacant = await propertyStat(page, 'Vacant');
  expect(occupied + vacant).toBeLessThanOrEqual(shown);

  // A row is a real record, not a skeleton: it has an address heading,
  // a type line and a rent figure.
  const first = cards.first();
  expect((await first.locator('h3').innerText()).trim().length).toBeGreaterThan(2);
  await expect(first).toContainText('Rent:');
});

test('properties: search narrows the list, a miss empties it, clearing restores it', async ({ page }) => {
  await open(page, 'properties');
  const cards = propertyCards(page);
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  const baseline = await cards.count();
  expect(baseline).toBeGreaterThan(1);

  // A distinctive fragment of the first row's address.
  const firstAddress = (await cards.first().locator('h3').innerText()).trim();
  const term = firstAddress.split(/\s+/).filter(w => w.length > 3)[0] || firstAddress.slice(0, 6);

  const search = page.locator('main input[placeholder="Search properties..."]');
  await search.fill(term);
  // 200ms debounce in Properties.js, plus React re-render.
  await expect.poll(() => cards.count(), { timeout: 15000 })
    .toBeLessThan(baseline);
  const hits = await cards.count();
  expect(hits, `searching "${term}" should still match its own row`).toBeGreaterThan(0);
  // Every surviving row genuinely contains the term somewhere.
  for (const text of await cards.allInnerTexts()) {
    expect(text.toLowerCase()).toContain(term.toLowerCase());
  }

  // A term that cannot match anything empties the list outright.
  await search.fill('E2E-NO-SUCH-PROPERTY-ZZZ');
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(0);

  await search.fill('');
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(baseline);
});

test('properties: status and type filters change which rows are visible', async ({ page }) => {
  await open(page, 'properties');
  const cards = propertyCards(page);
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  const baseline = await cards.count();
  const occupied = await propertyStat(page, 'Occupied');
  const vacant = await propertyStat(page, 'Vacant');

  // The status filter must reproduce the counts the stat tiles claim.
  await statusFilter(page).selectOption('occupied');
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(occupied);
  await statusFilter(page).selectOption('vacant');
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(vacant);
  // …and the two selections must actually differ, or this proves nothing.
  expect(occupied, 'occupied and vacant counts are identical — filter untested')
    .not.toBe(vacant);

  await statusFilter(page).selectOption('all');
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(baseline);

  // Type filter: pick the first concrete type and check every surviving
  // card reports it.
  const typeValues = await typeFilter(page).locator('option').evaluateAll(
    os => os.map(o => o.value).filter(v => v !== 'all'));
  expect(typeValues.length).toBeGreaterThan(0);
  await typeFilter(page).selectOption(typeValues[0]);
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBeGreaterThan(0);
  for (const text of await cards.allInnerTexts()) {
    expect(text).toContain(typeValues[0]);
  }

  // City filter narrows further and is undone cleanly.
  const cityValues = await cityFilter(page).locator('option').evaluateAll(
    os => os.map(o => o.value).filter(v => v !== 'all'));
  if (cityValues.length > 0) {
    const withType = await cards.count();
    await cityFilter(page).selectOption(cityValues[0]);
    await expect.poll(() => cards.count(), { timeout: 15000 }).toBeLessThanOrEqual(withType);
    await cityFilter(page).selectOption('all');
    await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(withType);
  }
  await typeFilter(page).selectOption('all');
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(baseline);
});

test('properties: card, table and compact views render the same rows', async ({ page }) => {
  await open(page, 'properties');
  const cards = propertyCards(page);
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  const expected = await cards.count();
  const firstAddress = (await cards.first().locator('h3').innerText()).trim();

  await page.locator('main button[title="table"]').click();
  const rows = page.locator('main table tbody tr');
  await expect.poll(() => rows.count(), { timeout: 15000 }).toBe(expected);
  await expect(page.locator('main table thead')).toContainText('Address');
  await expect(rows.first()).toContainText(firstAddress);

  await page.locator('main button[title="compact"]').click();
  const compact = page.locator('main div.divide-y > div.cursor-pointer');
  await expect.poll(() => compact.count(), { timeout: 15000 }).toBe(expected);
  await expect(compact.first()).toContainText(firstAddress);

  await page.locator('main button[title="card"]').click();
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(expected);
});

test('properties: the table column picker removes and restores a column', async ({ page }) => {
  await open(page, 'properties');
  await expect(propertyCards(page).first()).toBeVisible({ timeout: 30000 });
  await page.locator('main button[title="table"]').click();

  const headers = page.locator('main table thead th');
  await expect(headers.first()).toBeVisible({ timeout: 15000 });
  const before = await headers.count();
  await expect(page.locator('main table thead')).toContainText('Type');

  await page.locator('main button:has-text("Columns")').click();
  const typeBox = page.locator('main label:has-text("Type") input[type="checkbox"]').first();
  await expect(typeBox).toBeChecked();
  await typeBox.uncheck();

  await expect.poll(() => headers.count(), { timeout: 15000 }).toBe(before - 1);
  await expect(page.locator('main table thead')).not.toContainText('Type');

  await typeBox.check();
  await expect.poll(() => headers.count(), { timeout: 15000 }).toBe(before);
  await expect(page.locator('main table thead')).toContainText('Type');
});

test('properties: the detail drawer shows the clicked row and every tab renders', async ({ page }) => {
  await open(page, 'properties');
  const cards = propertyCards(page);
  await expect(cards.first()).toBeVisible({ timeout: 30000 });

  const card = cards.first();
  const address = (await card.locator('h3').innerText()).trim();
  // See openPropertyDrawer(): the heading is the reliable hit target.
  await card.locator('h3').click();

  const drawer = page.locator('div.fixed.inset-0.z-50.justify-end').first();
  await expect(drawer).toBeVisible({ timeout: 20000 });
  // The drawer belongs to the row that was clicked, not to row zero of
  // some other list.
  await expect(drawer.locator('h2')).toHaveText(address);
  // Header chips.
  for (const label of ['Status', 'Type', 'Rent', 'Lease End']) {
    await expect(drawer).toContainText(label);
  }

  // Details tab: the per-property roll-ups Properties.js loads in
  // openPropertyDetail().
  for (const section of ['Utilities', 'HOA', 'Insurance']) {
    await expect(drawer).toContainText(section);
  }
  await expect(drawer.locator('button:has-text("Upload Doc")')).toBeVisible();

  // Every tab switches to visibly different content.
  await drawer.locator('button:has-text("Documents (")').click();
  await expect(drawer.locator('button:has-text("Upload Doc")')).toHaveCount(0);

  await drawer.locator('button:has-text("Licenses (")').click();
  // The licences panel owns copy and an "Add License" affordance that
  // no other tab has; that is what proves the tab actually switched.
  await expect(drawer).toContainText('Rental Licenses & Permits');
  await expect(drawer.locator('button:has-text("Add License")')).toBeVisible();

  await drawer.locator('button:has-text("Work Orders (")').click();
  await drawer.locator('button:has-text("History (")').click();

  // Back to Details, and the quick actions are there again.
  await drawer.locator('button:text-is("Details")').click();
  await expect(drawer.locator('button:has-text("Upload Doc")')).toBeVisible();

  await drawer.locator('button:has-text("close")').first().click();
  await expect(drawer).toBeHidden({ timeout: 15000 });
  // Closing the drawer must not disturb the list behind it.
  await expect(cards.first()).toBeVisible();
});

test('properties: the Add wizard refuses an empty submit and closes without creating a property', async ({ page }) => {
  await open(page, 'properties');
  const cards = propertyCards(page);
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  const before = await cards.count();

  await page.locator('main button:has-text("+ Add")').first().click();

  const wizard = page.locator('div.fixed:has(h2:text-is("Property Setup"))').first();
  await expect(wizard).toBeVisible({ timeout: 20000 });
  await expect(wizard).toContainText('Step 1 of');
  await expect(wizard.locator('input[placeholder="123 Main Street"]')).toHaveValue('');

  // Empty submit: savePropertyDetails() throws and handleNext toasts it.
  await wizard.locator('button:has-text("Next")').click();
  await toast(page, 'Address Line 1 is required');
  // Still on step 1 — a failed validation must not advance the wizard.
  await expect(wizard).toContainText('Step 1 of');
  await toastsCleared(page);

  // Partial submit is still rejected, on the next field along.
  await wizard.locator('input[placeholder="123 Main Street"]').fill('E2E-TEST street');
  await wizard.locator('button:has-text("Next")').click();
  await toast(page, 'City is required');
  await expect(wizard).toContainText('Step 1 of');

  // Cancel out. Nothing entered was committed, so no confirm appears.
  await wizard.locator('button:has-text("close")').first().click();
  await expect(wizard).toBeHidden({ timeout: 20000 });
  await expect.poll(() => cards.count(), { timeout: 30000 }).toBe(before);
});

test('properties: Active / Setup Drafts / Archived tabs each render their own view', async ({ page }) => {
  await open(page, 'properties');
  const cards = propertyCards(page);
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  const active = await cards.count();

  await page.locator('main button:has-text("Setup Drafts (")').click();
  // The drafts view replaces the property grid entirely, and the search
  // / filter toolbar goes with it.
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(0);
  await expect(page.locator('main input[placeholder="Search properties..."]')).toHaveCount(0);
  await expect(page.locator('main button:has-text("Setup Drafts (")'))
    .toHaveClass(/bg-brand-600/);

  await page.locator('main button:has-text("Archived (")').click();
  await expect.poll(() => cards.count(), { timeout: 15000 }).toBe(0);
  await expect(page.locator('main button:has-text("Archived (")'))
    .toHaveClass(/bg-brand-600/);
  await expect(page.locator('main button:has-text("Setup Drafts (")'))
    .not.toHaveClass(/bg-brand-600/);

  await page.locator('main button:has-text("Active (")').click();
  await expect.poll(() => cards.count(), { timeout: 20000 }).toBe(active);
});

// ═══════════════════════════════════════════════════════════════════════
// MAINTENANCE
// ═══════════════════════════════════════════════════════════════════════

test('maintenance: the Work Orders, Inspections and Vendors tabs each swap the page body', async ({ page }) => {
  await open(page, 'maintenance');

  // Work Orders (default): the status pills + the "n of m" counter.
  await expect(page.locator('main button:text-is("+ New Work Order")')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('main')).toContainText(/\d+ of \d+ work orders/);

  await page.locator('main button:text-is("Inspections")').click();
  await expect(page.locator('main button:text-is("+ New Inspection")')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('main button:text-is("+ New Work Order")')).toHaveCount(0);

  await page.locator('main button:text-is("Vendors")').click();
  await expect(page.locator('main input[placeholder="Search vendors..."]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('main select:has(option:text-is("All Specialties"))')).toBeVisible();
  await expect(page.locator('main button:text-is("+ New Inspection")')).toHaveCount(0);

  await page.locator('main button:text-is("Work Orders")').click();
  await expect(page.locator('main button:text-is("+ New Work Order")')).toBeVisible({ timeout: 30000 });
});

// KNOWN BUG — Maintenance.js renders <ArchivedItems> at line 369 but
// never imports it (it lives in components/Admin.js). Clicking the
// "Archived" tab therefore throws
//     ReferenceError: ArchivedItems is not defined
// which the error boundary catches as PM-8009: the whole Maintenance
// page is replaced by "Something went wrong / Reload App" and the only
// way out is a reload. This was a live crash when the test was written
// (ArchivedItems was rendered without being imported); the import is
// added this test starts reporting "expected to fail but passed" and
// the marker should be deleted.
test('maintenance: the Archived tab does not take the page down', async ({ page }) => {
  await open(page, 'maintenance');
  await expect(page.locator('main button:text-is("+ New Work Order")')).toBeVisible({ timeout: 30000 });

  await page.locator('main button:text-is("Archived")').click();
  await page.waitForTimeout(2000);

  await expect(page.locator('main'), 'Archived tab crashed into the error boundary')
    .not.toContainText('Something went wrong');
  await expect(page.locator('main button:text-is("Work Orders")'))
    .toBeVisible({ timeout: 10000 });
});

test('maintenance: the work-order form enforces each required field, then cancels cleanly', async ({ page }) => {
  await open(page, 'maintenance');
  const newBtn = page.locator('main button:text-is("+ New Work Order")');
  await expect(newBtn).toBeVisible({ timeout: 20000 });
  await newBtn.click();

  const form = page.locator('main div:has(> h3:text-is("New Work Order"))').last();
  await expect(form).toBeVisible({ timeout: 15000 });

  // Empty submit → property first.
  await form.locator('button:text-is("Save")').click();
  await toast(page, 'Property is required.');
  await toastsCleared(page);

  // Choose a real property; the next field takes over.
  await pickFirstProperty(form);
  await form.locator('button:text-is("Save")').click();
  await toast(page, 'Issue description is required.');

  // Cancel discards the form; nothing was written.
  await form.locator('button:text-is("Cancel")').click();
  await expect(page.locator('main h3:text-is("New Work Order")')).toHaveCount(0);
  await expect(page.locator('main')).toContainText(/\d+ of \d+ work orders/);
});

test('maintenance: work-order status pills stay consistent with the visible list', async ({ page }) => {
  await open(page, 'maintenance');
  await expect(page.locator('main button:text-is("+ New Work Order")')).toBeVisible({ timeout: 30000 });

  const counter = page.locator('main').getByText(/^\d+ of \d+ work orders$/);
  const woCards = page.locator('main div.rounded-3xl.shadow-card:has(input[type="checkbox"])');
  // Addressed positionally: the pill labels carry a CSS `capitalize`,
  // so their textContent is "in progress", not "In Progress", and a
  // text-is() match on the rendered casing silently never fires.
  const pills = page.locator('main div.flex.flex-wrap.gap-2.mb-4').first().locator('button');
  await expect(pills).toHaveCount(5);
  const labels = await pills.allTextContents();

  // The "n of m" counter is rendered from `filtered.length`; it has to
  // match the number of cards actually painted, under every pill. This
  // is the invariant that breaks when a filter drops rows it should
  // have kept.
  for (let i = 0; i < 5; i++) {
    await pills.nth(i).click();
    await page.waitForTimeout(500);
    const shownInCounter = Number((await counter.innerText()).split(' of ')[0]);
    expect(await woCards.count(), `"${labels[i]}" pill: counter says ${shownInCounter}`)
      .toBe(shownInCounter);
    // Clicking a pill selects it, and deselects the one before it.
    await expect(pills.nth(i)).toHaveClass(/bg-brand-600/);
    if (i > 0) await expect(pills.nth(i - 1)).not.toHaveClass(/bg-brand-600/);
  }
  // The total never changes as the filter moves — only the filtered half.
  const totals = new Set();
  for (let i = 0; i < 5; i++) {
    await pills.nth(i).click();
    await page.waitForTimeout(300);
    totals.add((await counter.innerText()).split(' of ')[1]);
  }
  expect(totals.size, 'the "of m" total must not change with the filter').toBe(1);
});

// ═══════════════════════════════════════════════════════════════════════
// INSPECTIONS
// ═══════════════════════════════════════════════════════════════════════

test('inspections: the checklist template follows the inspection type, and an empty save is rejected', async ({ page }) => {
  await open(page, 'inspections');
  const newBtn = page.locator('main button:text-is("+ New Inspection")');
  await expect(newBtn).toBeVisible({ timeout: 20000 });
  await newBtn.click();

  const form = page.locator('main div:has(> h3:text-is("New Inspection"))').last();
  await expect(form).toBeVisible({ timeout: 15000 });

  // Move-In template is seeded on open.
  await expect(form).toContainText('Front door & locks');
  await expect(form).toContainText('Garage/parking');
  const moveInItems = await form.locator('div.bg-brand-50\\/30 > span.flex-1').count();
  expect(moveInItems).toBeGreaterThan(4);

  // Switching the type must rebuild the checklist with different items.
  const typeSelect = form.locator('select:has(option:text-is("Periodic"))').first();
  await typeSelect.selectOption('Periodic');
  await expect(form).toContainText('Roof & gutters');
  await expect(form).not.toContainText('Garage/parking');

  await typeSelect.selectOption('Move-Out');
  await expect(form).toContainText('Cleaning condition');
  await expect(form).not.toContainText('Roof & gutters');

  // Pass / Fail toggles are live controls, not decoration.
  const firstRow = form.locator('div.bg-brand-50\\/30').first();
  const fail = firstRow.locator('button:text-is("Fail")');
  await fail.click();
  await expect(fail).toHaveClass(/bg-danger-500/);
  const pass = firstRow.locator('button:text-is("Pass")');
  await pass.click();
  await expect(pass).toHaveClass(/bg-positive-500/);
  await expect(fail).not.toHaveClass(/bg-danger-500/);

  // Empty submit is refused.
  await form.locator('button:text-is("Save Inspection")').click();
  await toast(page, 'Property is required.');
  await toastsCleared(page);

  await form.locator('button:text-is("Cancel")').click();
  await expect(page.locator('main h3:text-is("New Inspection")')).toHaveCount(0);
});

// ═══════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════

test('utilities: tabs swap the body and the bill form validates field by field', async ({ page }) => {
  await open(page, 'utilities');

  const addBill = page.locator('main button:text-is("+ Add Bill")');
  await expect(addBill).toBeVisible({ timeout: 20000 });

  // Tab switching genuinely changes what is on screen.
  await page.locator('main button:has-text("Automation")').click();
  await expect(page.locator('main')).toContainText('Connected Utility Accounts');
  await expect(addBill).toHaveCount(0);

  await page.locator('main button:text-is("Job History")').click();
  await expect(page.locator('main')).not.toContainText('Connected Utility Accounts');

  await page.locator('main button:text-is("Manual Bills")').click();
  await expect(addBill).toBeVisible({ timeout: 15000 });

  // Stat tiles are derived from the same list the table renders.
  const rowsBefore = await page.locator('main table tbody tr').count();

  await addBill.click();
  const form = page.locator('main div:has(> h3:text-is("New Utility Bill"))').last();
  await expect(form).toBeVisible({ timeout: 15000 });

  // addUtility() validates property → provider → amount → due date, in
  // that order. Walk the whole chain; each step must move the message on.
  await form.locator('button:text-is("Save")').click();
  await toast(page, 'Property is required.');
  await toastsCleared(page);

  await pickFirstProperty(form);
  await form.locator('button:text-is("Save")').click();
  await toast(page, 'Provider name is required.');
  await toastsCleared(page);

  await form.locator('input[placeholder="e.g. PEPCO, Washington Gas"]').fill('E2E-TEST provider');
  await form.locator('button:text-is("Save")').click();
  await toast(page, 'Please enter a valid amount.');
  await toastsCleared(page);

  // Zero is not a valid amount either.
  await form.locator('input[placeholder="150.00"]').fill('0');
  await form.locator('button:text-is("Save")').click();
  await toast(page, 'Please enter a valid amount.');
  await toastsCleared(page);

  await form.locator('input[placeholder="150.00"]').fill('42.50');
  await form.locator('button:text-is("Save")').click();
  await toast(page, 'Due date is required.');

  // Bail out — nothing was written.
  await form.locator('button:text-is("Cancel")').click();
  await expect(page.locator('main h3:text-is("New Utility Bill")')).toHaveCount(0);
  expect(await page.locator('main table tbody tr').count()).toBe(rowsBefore);
});

// ═══════════════════════════════════════════════════════════════════════
// HOA — full create / filter / cross-module / delete round trip
// ═══════════════════════════════════════════════════════════════════════

test('hoa: validates, creates a payment, filters on it, shows it on the property, then deletes it', async ({ page }) => {
  const stamp = Date.now();
  const name = `E2E-TEST-${stamp}`;
  let created = false;
  let address = '';

  await open(page, 'hoa');
  const rows = page.locator('main table tbody tr');
  const before = await rows.count();

  try {
    await page.locator('main button:text-is("+ Add HOA")').click();
    const form = page.locator('main div:has(> h3:text-is("New HOA Payment"))').last();
    await expect(form).toBeVisible({ timeout: 15000 });

    // Empty submit is refused before anything hits the database.
    await form.locator('button:text-is("Save")').click();
    await toast(page, 'Property, HOA name, and amount are required.');
    expect(await rows.count(), 'a rejected save must not add a row').toBe(before);
    await toastsCleared(page);

    address = await pickFirstProperty(form);
    await form.locator('input[placeholder="e.g. Riverside HOA"]').fill(name);
    await form.locator('input[placeholder="250.00"]').fill('123.45');

    // Amount + property + name are set but the date is not: the code
    // defaults the date and asks for a re-save rather than guessing.
    await form.locator('button:text-is("Save")').click();
    await toast(page, 'Due date was not set');
    await toastsCleared(page);

    await form.locator('input[type="date"]').fill('2026-06-15');
    await form.locator('button:text-is("Save")').click();

    const ourRow = rows.filter({ hasText: name });
    await expect(ourRow).toHaveCount(1, { timeout: 20000 });
    created = true;
    await expect.poll(() => rows.count(), { timeout: 20000 }).toBeGreaterThan(before - 1);

    // The row carries the values that were typed.
    await expect(ourRow).toContainText('$123.45');
    await expect(ourRow).toContainText('2026-06-15');
    await expect(ourRow).toContainText('monthly');
    await expect(ourRow).toContainText(address.split(',')[0]);

    // Status filter: a pending payment survives "Pending" and vanishes
    // under "Paid".
    const status = page.locator('main select:has(option[value="pending"])').first();
    await status.selectOption('pending');
    await expect(ourRow).toHaveCount(1, { timeout: 15000 });
    await status.selectOption('paid');
    await expect(ourRow).toHaveCount(0, { timeout: 15000 });
    await status.selectOption('all');
    await expect(ourRow).toHaveCount(1, { timeout: 15000 });

    // Edit prefills from the row rather than opening blank.
    await ourRow.locator('button:text-is("Edit")').click();
    const editForm = page.locator('main div:has(> h3:text-is("Edit HOA Payment"))').last();
    await expect(editForm).toBeVisible({ timeout: 15000 });
    await expect(editForm.locator('input[placeholder="e.g. Riverside HOA"]')).toHaveValue(name);
    await expect(editForm.locator('input[placeholder="250.00"]')).toHaveValue('123.45');
    await editForm.locator('button:text-is("Cancel")').click();

    // Cross-module: the property drawer reads hoa_payments by address,
    // so the new payment has to surface there too.
    const drawer = await openPropertyDrawer(page, address);
    await expect(drawer).toContainText(name, { timeout: 30000 });
    await expect(drawer).toContainText('$123.45');
    await drawer.locator('button:has-text("close")').first().click();
  } finally {
    if (created) {
      await open(page, 'hoa');
      const ourRow = page.locator('main table tbody tr').filter({ hasText: name });
      await expect(ourRow).toHaveCount(1, { timeout: 20000 });
      await ourRow.locator('button:text-is("Delete")').click();
      await confirmDialog(page, 'Delete');
      await expect(ourRow).toHaveCount(0, { timeout: 20000 });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════
// LOANS
// ═══════════════════════════════════════════════════════════════════════

test('loans: validates, creates a loan, filters on it, shows it on the property, then deletes it', async ({ page }) => {
  const stamp = Date.now();
  const lender = `E2E-TEST-${stamp}`;
  let created = false;
  let address = '';

  await open(page, 'loans');
  const rows = page.locator('main table tbody tr');
  const before = await rows.count();

  try {
    await page.locator('main button:text-is("+ Add Loan")').click();
    const modal = page.locator('div.fixed:has(h3:text-is("New Loan"))').first();
    await expect(modal).toBeVisible({ timeout: 15000 });

    await modal.locator('button:text-is("Save")').click();
    await toast(page, 'Property, lender name, and original amount are required.');
    expect(await rows.count()).toBe(before);
    await toastsCleared(page);

    address = await pickFirstProperty(modal);
    await modal.locator('input[placeholder="e.g. Wells Fargo"]').fill(lender);
    await modal.locator('button:text-is("Save")').click();
    await toast(page, 'Property, lender name, and original amount are required.');
    await toastsCleared(page);

    await modal.locator('input[placeholder="250000"]').fill('300000');
    await modal.locator('input[placeholder="230000"]').fill('275000');
    await modal.locator('input[placeholder="6.5"]').fill('6.25');
    await modal.locator('input[placeholder="1800"]').fill('1750');
    // Dates filled here so this test covers the happy path; the
    // blank-date case is exercised separately below.
    await modal.locator('input[type="date"]').nth(0).fill('2026-01-01');
    await modal.locator('input[type="date"]').nth(1).fill('2056-01-01');

    // The escrow fields are conditionally rendered on the checkbox.
    await expect(modal.locator('input[placeholder="350"]')).toHaveCount(0);
    await modal.locator('input[type="checkbox"]').first().check();
    await expect(modal.locator('input[placeholder="350"]')).toBeVisible();
    await modal.locator('input[type="checkbox"]').first().uncheck();
    await expect(modal.locator('input[placeholder="350"]')).toHaveCount(0);

    await modal.locator('button:text-is("Save")').click();
    await expect(modal).toBeHidden({ timeout: 20000 });

    const ourRow = rows.filter({ hasText: lender });
    await expect(ourRow).toHaveCount(1, { timeout: 20000 });
    created = true;
    await expect(ourRow).toContainText('6.25%');
    await expect(ourRow).toContainText('Conventional');

    // Property filter is built from the loans themselves, so the new
    // address must now be selectable and must isolate our row.
    const propFilter = page.locator('main select:has(option:text-is("All Properties"))').first();
    await propFilter.selectOption(address);
    await expect(ourRow).toHaveCount(1, { timeout: 15000 });
    await expect.poll(() => rows.count(), { timeout: 15000 }).toBeGreaterThan(0);

    // Status filter: an active loan disappears under "Paid Off".
    const statusFilterSel = page.locator('main select:has(option[value="paid_off"])').first();
    await statusFilterSel.selectOption('paid_off');
    await expect(ourRow).toHaveCount(0, { timeout: 15000 });
    await statusFilterSel.selectOption('active');
    await expect(ourRow).toHaveCount(1, { timeout: 15000 });
    await statusFilterSel.selectOption('all');
    await propFilter.selectOption('all');

    // Stat tiles reflect the new loan.
    await expect(page.locator('main')).toContainText('$275,000');

    // Cross-module: the property drawer's Loan / Mortgage section.
    const drawer = await openPropertyDrawer(page, address);
    await expect(drawer).toContainText(lender, { timeout: 30000 });
    await expect(drawer).toContainText('6.25%');
    await drawer.locator('button:has-text("close")').first().click();
  } finally {
    if (created) {
      await open(page, 'loans');
      const ourRow = page.locator('main table tbody tr').filter({ hasText: lender });
      await expect(ourRow).toHaveCount(1, { timeout: 20000 });
      await ourRow.locator('button:text-is("Delete")').click();
      await confirmDialog(page, 'Delete');
      await expect(ourRow).toHaveCount(0, { timeout: 20000 });
    }
  }
});

// KNOWN BUG — Loans.js saveLoan() coerces empty dates on the UPDATE
// path (`loan_start_date: payload.loan_start_date || null`) but sends
// the raw form object on the INSERT path. "Loan Start Date" and
// "Maturity Date" are optional in the UI (no asterisk, no validation),
// so leaving them blank posts "" to a date column and Postgres answers
//     invalid input syntax for type date: ""
// The modal stays open and the loan is never created. Marked
// Fixed: the insert now coerces "" to null, as the update path always did.
test('loans: a loan can be created without the optional date fields', async ({ page }) => {
  const lender = `E2E-TEST-${Date.now()}`;
  await open(page, 'loans');
  await page.locator('main button:text-is("+ Add Loan")').click();
  const modal = page.locator('div.fixed:has(h3:text-is("New Loan"))').first();
  await expect(modal).toBeVisible({ timeout: 15000 });
  await pickFirstProperty(modal);
  await modal.locator('input[placeholder="e.g. Wells Fargo"]').fill(lender);
  await modal.locator('input[placeholder="250000"]').fill('100000');
  await modal.locator('button:text-is("Save")').click();
  // Both required fields are set and the dates are optional, so the
  // modal should close and the row should appear.
  await expect(modal).toBeHidden({ timeout: 15000 });
  await expect(page.locator('main table tbody tr').filter({ hasText: lender }))
    .toHaveCount(1, { timeout: 15000 });
});

// ═══════════════════════════════════════════════════════════════════════
// INSURANCE
// ═══════════════════════════════════════════════════════════════════════

test('insurance: validates, creates a policy, filters on it, shows it on the property, then deletes it', async ({ page }) => {
  const stamp = Date.now();
  const provider = `E2E-TEST-${stamp}`;
  let created = false;
  let address = '';

  await open(page, 'insurance');
  const rows = page.locator('main table tbody tr');
  const before = await rows.count();

  try {
    await page.locator('main button:text-is("+ Add Policy")').click();
    const modal = page.locator('div.fixed:has(h3:text-is("New Insurance Policy"))').first();
    await expect(modal).toBeVisible({ timeout: 15000 });

    await modal.locator('button:text-is("Save")').click();
    await toast(page, 'Property, provider, and premium amount are required.');
    expect(await rows.count()).toBe(before);
    await toastsCleared(page);

    address = await pickFirstProperty(modal);
    await modal.locator('input[placeholder="e.g. State Farm"]').fill(provider);
    await modal.locator('button:text-is("Save")').click();
    await toast(page, 'Property, provider, and premium amount are required.');
    await toastsCleared(page);

    await modal.locator('input[placeholder="Policy #"]').fill(`POL-${stamp}`);
    await modal.locator('input[placeholder="1200"]').fill('1500');
    await modal.locator('input[placeholder="300000"]').fill('450000');
    await modal.locator('select:has(option:text-is("Quarterly"))').first().selectOption('Quarterly');
    await modal.locator('input[type="date"]').fill('2027-01-31');
    await modal.locator('button:text-is("Save")').click();
    await expect(modal).toBeHidden({ timeout: 20000 });

    const ourRow = rows.filter({ hasText: provider });
    await expect(ourRow).toHaveCount(1, { timeout: 20000 });
    created = true;
    await expect(ourRow).toContainText(`POL-${stamp}`);
    await expect(ourRow).toContainText('Quarterly');
    await expect(ourRow).toContainText('2027-01-31');

    // Quarterly $1,500 annualises to $6,000 in the header tile — a real
    // calculation, not an echo of the input.
    await expect(page.locator('main')).toContainText('$6,000');

    const propFilter = page.locator('main select:has(option:text-is("All Properties"))').first();
    await propFilter.selectOption(address);
    await expect(ourRow).toHaveCount(1, { timeout: 15000 });
    await propFilter.selectOption('all');

    const drawer = await openPropertyDrawer(page, address);
    await expect(drawer).toContainText(provider, { timeout: 30000 });
    await expect(drawer).toContainText(`#POL-${stamp}`);
    await drawer.locator('button:has-text("close")').first().click();
  } finally {
    if (created) {
      await open(page, 'insurance');
      const ourRow = page.locator('main table tbody tr').filter({ hasText: provider });
      await expect(ourRow).toHaveCount(1, { timeout: 20000 });
      await ourRow.locator('button:text-is("Delete")').click();
      await confirmDialog(page, 'Delete');
      await expect(ourRow).toHaveCount(0, { timeout: 20000 });
    }
  }
});

// KNOWN BUG — the same empty-date defect as Loans, in
// Insurance.js savePolicy(). "Expiration Date" is optional in the UI;
// leaving it blank posts "" to a date column and the insert is
// rejected with `invalid input syntax for type date: ""`, so the modal
// hung open and no policy was created. Fixed alongside the loans case.
test('insurance: a policy can be created without an expiration date', async ({ page }) => {
  const provider = `E2E-TEST-${Date.now()}`;
  await open(page, 'insurance');
  await page.locator('main button:text-is("+ Add Policy")').click();
  const modal = page.locator('div.fixed:has(h3:text-is("New Insurance Policy"))').first();
  await expect(modal).toBeVisible({ timeout: 15000 });
  await pickFirstProperty(modal);
  await modal.locator('input[placeholder="e.g. State Farm"]').fill(provider);
  await modal.locator('input[placeholder="1200"]').fill('900');
  await modal.locator('button:text-is("Save")').click();
  await expect(modal).toBeHidden({ timeout: 15000 });
  await expect(page.locator('main table tbody tr').filter({ hasText: provider }))
    .toHaveCount(1, { timeout: 15000 });
});

// ═══════════════════════════════════════════════════════════════════════
// TAX BILLS
// ═══════════════════════════════════════════════════════════════════════

test('tax_bills: filter pills carry live counts and drive the view; the property picker matches Properties', async ({ page }) => {
  // How many properties the Properties page believes exist.
  await open(page, 'properties');
  await expect(propertyCards(page).first()).toBeVisible({ timeout: 30000 });
  const propertyCount = await propertyCards(page).count();

  await open(page, 'tax_bills');

  // Header subtitle is generated from the same counters as the pills.
  const subtitle = await page.locator('main h2:text-is("Property Tax Bills") + p').innerText();
  const [openCount, overdueCount] = subtitle.match(/\d+/g).map(Number);
  const pillCount = async (label) => {
    const t = await page.locator(`main button:has-text("${label} ·")`).first().innerText();
    return Number(t.split('·')[1].trim());
  };
  expect(await pillCount('Open'), 'Open pill vs header subtitle').toBe(openCount);
  expect(await pillCount('Overdue'), 'Overdue pill vs header subtitle').toBe(overdueCount);
  // Overdue is a subset of open; it can never exceed it.
  expect(overdueCount).toBeLessThanOrEqual(openCount);

  // The property picker is loaded from the properties table, so it must
  // agree with the Properties page (plus the "All properties" option).
  const picker = page.locator('main select:has(option:text-is("All properties"))').first();
  const options = await picker.locator('option').count();
  expect(options, 'tax-bill property picker vs Properties list').toBe(propertyCount + 1);

  // Each pill selects itself and drives the body. With no bills the
  // empty state is the body, and its wording differs between "open"
  // and the rest — a real, observable change.
  const rowsFor = async (label) => {
    await page.locator(`main button:has-text("${label}")`).first().click();
    await page.waitForTimeout(400);
    return page.locator('main table tbody tr').count();
  };
  await page.locator('main button:has-text("Open ·")').click();
  await expect(page.locator('main button:has-text("Open ·")')).toHaveClass(/bg-brand-600/);
  const openBody = await page.locator('main').innerText();

  await page.locator('main button:text-is("All")').click();
  await expect(page.locator('main button:text-is("All")')).toHaveClass(/bg-brand-600/);
  await expect(page.locator('main button:has-text("Open ·")')).not.toHaveClass(/bg-brand-600/);
  const allBody = await page.locator('main').innerText();
  expect(allBody, 'switching from Open to All must change the body').not.toBe(openBody);

  // Every pill leaves the table consistent with its own count.
  await page.locator('main button:has-text("Paid ·")').click();
  await page.waitForTimeout(400);
  expect(await page.locator('main table tbody tr').count()).toBe(await pillCount('Paid'));

  // Search is wired to the same filtered list.
  const search = page.locator('main input[placeholder="Search property / installment"]');
  await page.locator('main button:text-is("All")').click();
  const allRows = await page.locator('main table tbody tr').count();
  await search.fill('E2E-NO-SUCH-BILL-ZZZ');
  await expect.poll(() => page.locator('main table tbody tr').count(), { timeout: 10000 }).toBe(0);
  await expect(page.locator('main')).toContainText('No bills here');
  await search.fill('');
  await expect.poll(() => page.locator('main table tbody tr').count(), { timeout: 10000 }).toBe(allRows);
  void rowsFor;
});

// ═══════════════════════════════════════════════════════════════════════
// HEALTH — no route in this module may log an error or fail a request
// ═══════════════════════════════════════════════════════════════════════

test('every properties-module route loads without console errors or failed requests', async ({ page }) => {
  // Eight full page loads of a deliberately slow app; the default
  // three-minute budget is not enough when the dev server is busy.
  test.setTimeout(600000);
  const problems = watchForFailures(page);
  for (const routeId of Object.keys(HEADING)) {
    await open(page, routeId);
    await expect(page.locator(`main h2:text-is("${HEADING[routeId]}")`).first())
      .toBeVisible({ timeout: 30000 });
  }
  expect(problems, `properties-module routes logged failures:\n  ${problems.join('\n  ')}`)
    .toEqual([]);
});
