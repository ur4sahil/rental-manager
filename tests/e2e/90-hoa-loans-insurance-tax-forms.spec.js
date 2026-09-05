// ═══════════════════════════════════════════════════════════════════════
// HOA · LOANS · INSURANCE · TAX BILLS — real form submissions.
//
// Four modules that, until this file existed, had never had a single
// form filled in and submitted by a test. 20-loans / 21-hoa-payments /
// 22-insurance / 40-tax-bills open the form, look at it, and cancel.
// That proves the form renders. It does not prove that pressing Save
// writes a row, that the row holds the values that were typed, that an
// edit reaches the database, that Delete archives instead of dropping,
// or that "Pay" posts the journal entry the module promises.
//
// Every test here does the whole loop:
//     fill every field → save → re-read from Postgres → compare the
//     values field by field → reload the page and compare again →
//     edit → re-read → delete → prove it left the active view AND
//     that archived_at was stamped rather than the row vanishing.
//
// Side effects are checked where the module claims one: HOA "Pay" and
// Loans "Record Payment" both post a two-line journal entry, and the
// loan payment must move current_balance by exactly the payment.
//
// Validation is checked the only way that means anything: submit with a
// required field blank, assert a visible message, then assert the table
// still has zero rows carrying this run's tag.
//
// ── Data ──────────────────────────────────────────────────────────────
// Runs against `e2e-sandbox`, the disposable full-fidelity copy. Every
// row this file writes carries a per-test random tag in a text column,
// and afterAll hard-deletes everything matching, so the file is
// re-runnable and no test depends on another.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
const { watchForFailures } = require('./helpers');

const COMPANY = process.env.E2E_COMPANY || 'e2e-sandbox';
// Guard rail: Sahil LLC is the pristine reference copy. Nothing here may
// ever be pointed at it.
const PRISTINE = 'f56be35c-c80d-4f47-8624-cbb317f85461';
if (COMPANY === PRISTINE) throw new Error('90-forms must never run against Sahil LLC');

// ── Database ──────────────────────────────────────────────────────────
// Assertions go through the anon key + a real login, i.e. the same RLS
// path the app itself uses. A service-key client would happily confirm
// rows the app could never read.
let _db = null;
async function db() {
  if (_db) return _db;
  const sb = createClient(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb.auth.signInWithPassword({
    email: process.env.TEST_EMAIL, password: process.env.TEST_PASSWORD,
  });
  if (error) throw new Error('test DB login failed: ' + error.message);
  _db = sb;
  return sb;
}

const TAGS = [];
function tag() {
  const t = 'E2E90' + Math.random().toString(36).slice(2, 8).toUpperCase();
  TAGS.push(t);
  return t;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── Fixtures ──────────────────────────────────────────────────────────
// Every one of these four modules hangs off a property (PropertySelect
// lists properties by address, and the tax generator needs a county), so
// each test seeds its own and tears it down again.
async function seedProperty(t, { county = 'Howard County', state = 'MD' } = {}) {
  const sb = await db();
  const line1 = `${t} Ledger Lane`;
  const address = `${line1}, Testville, ${state} 20770`;
  const classId = crypto.randomUUID();
  const { error: cErr } = await sb.from('acct_classes').insert([{
    id: classId, company_id: COMPANY, name: address,
    description: 'Auto-created for ' + line1, color: '#3b82f6', is_active: true,
  }]);
  if (cErr) throw new Error('seed class: ' + cErr.message);
  const { data, error } = await sb.from('properties').insert([{
    company_id: COMPANY, address, address_line_1: line1, city: 'Testville',
    state, zip: '20770', county, type: 'Single Family',
    status: 'vacant', rent: 2000, bedrooms: 3, bathrooms: 2, class_id: classId,
  }]).select('id, address').single();
  if (error) throw new Error('seed property: ' + error.message);
  return { id: data.id, address, line1, classId };
}

// Remove everything a tag touched, in FK-safe order.
async function purge(t) {
  const sb = await db();
  const like = `%${t}%`;
  for (let pass = 0; pass < 2; pass++) {
    const { data: jes } = await sb.from('acct_journal_entries')
      .select('id').eq('company_id', COMPANY).ilike('description', like);
    const ids = (jes || []).map(j => j.id);
    if (ids.length) {
      await sb.from('acct_journal_lines').delete().eq('company_id', COMPANY).in('journal_entry_id', ids);
      await sb.from('acct_journal_entries').delete().eq('company_id', COMPANY).in('id', ids);
    }
    if (pass === 0) await new Promise(r => setTimeout(r, 1200));
  }
  await sb.from('hoa_payments').delete().eq('company_id', COMPANY).ilike('hoa_name', like);
  await sb.from('hoa_payments').delete().eq('company_id', COMPANY).ilike('property', like);
  await sb.from('property_loans').delete().eq('company_id', COMPANY).ilike('lender_name', like);
  await sb.from('property_loans').delete().eq('company_id', COMPANY).ilike('property', like);
  await sb.from('property_insurance').delete().eq('company_id', COMPANY).ilike('provider', like);
  await sb.from('property_insurance').delete().eq('company_id', COMPANY).ilike('property', like);
  // property_tax_bills has RLS policies for SELECT / INSERT / UPDATE and
  // NONE for DELETE, so this delete matches nothing and returns no error
  // — a silent no-op under the app's own role. It stays because it is
  // the right call the day a DELETE policy is added; the archive below
  // is what actually clears the rows today. (Reported separately: the
  // missing policy also means nothing in the product, including a future
  // purge job, can ever hard-delete a tax bill.)
  await sb.from('property_tax_bills').delete().eq('company_id', COMPANY).ilike('property', like);
  await sb.from('property_tax_bills')
    .update({ archived_at: new Date().toISOString(), archived_by: 'e2e-purge' })
    .eq('company_id', COMPANY).ilike('property', like).is('archived_at', null);
  await sb.from('properties').delete().eq('company_id', COMPANY).ilike('address', like);
  await sb.from('acct_classes').delete().eq('company_id', COMPANY).ilike('name', like);
}

// "Regenerate for current year" is a company-wide bulk write: it walks
// EVERY property in the company and generates bills for each one that
// has a county. There is no way to scope it to one property, so the tax
// test necessarily creates rows against other specs' fixture properties
// too whenever they run against the same sandbox. Sweep that collateral
// up — but only rows whose property address is a test fixture AND whose
// property no longer exists, so a spec still running is never touched.
async function purgeOrphanFixtureBills() {
  const sb = await db();
  const { data: bills } = await sb.from('property_tax_bills')
    .select('id, property').eq('company_id', COMPANY)
    .ilike('property', 'E2E%').is('archived_at', null);
  if (!bills || !bills.length) return;
  const { data: props } = await sb.from('properties')
    .select('address').eq('company_id', COMPANY).ilike('address', 'E2E%');
  const live = new Set((props || []).map(p => p.address));
  const orphans = bills.filter(b => !live.has(b.property)).map(b => b.id);
  for (let i = 0; i < orphans.length; i += 50) {
    await sb.from('property_tax_bills')
      .update({ archived_at: new Date().toISOString(), archived_by: 'e2e-purge' })
      .in('id', orphans.slice(i, i + 50));
  }
}

test.afterAll(async () => {
  for (const t of TAGS) await purge(t);
  await purgeOrphanFixtureBills();
});

// ── UI helpers ────────────────────────────────────────────────────────
// A cold `/?company=<id>#<route>` load intermittently lands on the
// Dashboard (two auth callbacks race into handleSelectCompany). Prove
// arrival, and if it did not happen re-route through the history-state
// channel the app's own popstate listener reads. Same shape as
// 80-workflows-end-to-end.spec.js.
async function openRoute(page, routeId, heading) {
  const marker = page.locator('main h2').filter({ hasText: heading }).first();
  await page.goto(`/?company=${encodeURIComponent(COMPANY)}#${routeId}`, { timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await marker.isVisible({ timeout: attempt === 0 ? 25000 : 12000 }).catch(() => false)) return;
    await page.evaluate((p) => {
      window.history.pushState({ page: p, screen: 'app' }, '', '#' + p);
      window.dispatchEvent(new PopStateEvent('popstate', { state: { page: p, screen: 'app' } }));
    }, routeId);
    await page.waitForTimeout(1500);
  }
  await expect(marker, `never reached the ${routeId} route`).toBeVisible({ timeout: 20000 });
}

const toasts = (page) => page.locator('div.fixed.bottom-4.right-4');
const toast = (page, text) => toasts(page).getByText(text, { exact: false }).first();

// Toasts live for 4s. A second submit asserted against a toast the FIRST
// submit raised is not an assertion at all, so wait for the container to
// empty before pressing anything that raises a new one.
async function clearToasts(page) {
  await expect(toasts(page).locator('> div')).toHaveCount(0, { timeout: 12000 });
}

// Credential encryption is a Vercel serverless function (/api/encrypt).
// `npm start` serves the CRA dev server only, so on a local run the
// endpoint 404s and every save that carries a username/password is
// refused by design. Probe once and let the credential test assert the
// branch that actually applies.
let _encryptApi = null;
async function encryptApiAvailable() {
  if (_encryptApi !== null) return _encryptApi;
  const base = process.env.APP_URL || 'http://localhost:3000';
  try {
    const r = await fetch(base + '/api/encrypt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer probe' },
      body: JSON.stringify({ action: 'encrypt', plaintext: 'probe', companyId: COMPANY }),
    });
    // 401 means the function exists and rejected our fake token — that
    // still counts as "deployed". 404 means it isn't there at all.
    _encryptApi = r.status !== 404;
  } catch (_) { _encryptApi = false; }
  return _encryptApi;
}

async function confirmDialog(page, action) {
  const modal = page.locator('div.fixed.inset-0.z-\\[90\\]').first();
  await expect(modal).toBeVisible({ timeout: 15000 });
  await modal.locator(`button:text-is("${action}")`).first().click();
  await expect(modal).toBeHidden({ timeout: 30000 });
}

// Every field in these four forms is wrapped as
//   <div><label>Label</label><input|select …/></div>
// so the label is the only stable handle. Positional nth() indexes break
// the moment a conditional field (escrow) appears.
const field = (scope, label) =>
  scope.locator(`div:has(> label:text-is("${label}"))`).locator('input, select').first();

// type=number refuses non-numeric input at the DOM level, and
// locator.fill() throws rather than showing what the user would see.
// pressSequentially types character by character exactly as a person
// would, so the assertion afterwards is about the real browser behaviour.
async function typeRaw(locator, text) {
  await locator.click();
  await locator.press('Control+A').catch(() => {});
  await locator.press('Delete').catch(() => {});
  await locator.pressSequentially(text, { delay: 15 });
}

// The tax-bill page lists EVERY property's bills, grouped. Other specs
// running against the same sandbox seed their own county properties, so
// `tr:has-text("1st half (MD)")` is not unique — it can resolve to
// someone else's row and then the assertions are about their data. Drive
// the page's own property filter instead, and pick the status filter
// explicitly rather than relying on the default.
async function scopeBills(page, address, pill = 'All') {
  const sel = page.locator('main select').first();
  await expect.poll(async () => sel.locator(`option[value="${address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await sel.selectOption(address);
  await page.locator(`main button:text-is("${pill}")`).first().click();
  await page.waitForTimeout(500);
}

// watchForFailures() collects every console error and every 4xx/5xx. We
// only fail on the ones that touch these four modules — that is exactly
// the "a column that does not exist gets written, PostgREST 400s, the
// try/catch swallows it" bug class this file is hunting.
const OURS = /(hoa_payments|property_loans|property_insurance|property_tax_bills|acct_journal_entries|acct_journal_lines)/;
function moduleFailures(problems) {
  return problems.filter(p => OURS.test(p));
}

// ═══════════════════════════════════════════════════════════════════════
// HOA PAYMENTS
// ═══════════════════════════════════════════════════════════════════════

test('HOA: a payment filled in full saves every field, survives a reload, edits, and archives', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  const problems = watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const hoaName = `${t} Riverside HOA`;
  const website = 'https://portal.riverside-hoa.example.com';

  await openRoute(page, 'hoa', /^HOA Payments$/);

  // ── create ──
  await page.locator('main button:has-text("+ Add HOA")').first().click();
  const form = page.locator('main div:has(> h3)').filter({ hasText: 'New HOA Payment' }).first();
  await expect(form).toBeVisible({ timeout: 20000 });

  // The property dropdown is populated by its own query; wait for our
  // seeded address to arrive before selecting it.
  const propSel = field(form, 'Property *');
  await expect.poll(async () => propSel.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await propSel.selectOption(prop.address);
  await field(form, 'HOA Company').fill(hoaName);
  await field(form, 'Amount ($)').fill('275.50');
  await field(form, 'Due Date').fill('2026-11-15');
  await field(form, 'Frequency').selectOption('quarterly');
  await field(form, 'Notes').fill('Quarterly dues incl. pool access');
  await field(form, 'Website').fill(website);
  // Username/Password are covered by their own test below — they route
  // through /api/encrypt, which is a serverless function and therefore
  // absent from the CRA dev server.
  await form.locator('button:text-is("Save")').click();

  await expect(form, 'the HOA form should close on a successful save').toBeHidden({ timeout: 30000 });

  // ── the database agrees, field by field ──
  const read = async () => {
    const { data } = await sb.from('hoa_payments').select('*')
      .eq('company_id', COMPANY).eq('hoa_name', hoaName).is('archived_at', null).maybeSingle();
    return data;
  };
  await expect.poll(read, { timeout: 20000, message: 'no hoa_payments row was written' }).toBeTruthy();
  const row = await read();
  expect(row.property).toBe(prop.address);
  expect(Number(row.amount)).toBe(275.5);
  expect(row.due_date).toBe('2026-11-15');
  expect(row.frequency).toBe('quarterly');
  expect(row.status).toBe('pending');
  expect(row.notes).toBe('Quarterly dues incl. pool access');
  expect(row.website, 'the portal website typed into the form was not saved').toBe(website);
  expect(row.archived_at).toBeNull();
  // The trigger resolves the address to the FK. A NULL here means every
  // per-property report will miss this row.
  expect(row.property_id, 'auto_fill_property_id did not resolve the address').toBe(prop.id);

  // ── and so does the screen, after a full reload ──
  await openRoute(page, 'hoa', /^HOA Payments$/);
  const tr = page.locator('main table tbody tr').filter({ hasText: hoaName }).first();
  await expect(tr).toBeVisible({ timeout: 30000 });
  await expect(tr).toContainText('$275.5');
  await expect(tr).toContainText('2026-11-15');
  await expect(tr).toContainText('quarterly');
  await expect(tr, 'the portal link is missing from the row').toContainText('portal.riverside-hoa.example.com');

  // ── edit ──
  await tr.locator('button:text-is("Edit")').click();
  const editForm = page.locator('main div:has(> h3)').filter({ hasText: 'Edit HOA Payment' }).first();
  await expect(editForm).toBeVisible({ timeout: 20000 });
  // The edit form must arrive pre-filled with what is on the row —
  // including the website, or saving silently blanks it.
  await expect(field(editForm, 'HOA Company')).toHaveValue(hoaName);
  await expect(field(editForm, 'Amount ($)')).toHaveValue('275.5');
  await expect(field(editForm, 'Website'),
    'Edit did not load the saved website, so pressing Save would wipe it').toHaveValue(website);

  await field(editForm, 'Amount ($)').fill('310.25');
  await field(editForm, 'Due Date').fill('2026-12-01');
  await field(editForm, 'Frequency').selectOption('annual');
  await field(editForm, 'Notes').fill('Raised at the 2026 AGM');
  await editForm.locator('button:text-is("Save")').click();
  await expect(editForm).toBeHidden({ timeout: 30000 });

  await expect.poll(async () => Number((await read())?.amount), { timeout: 20000 }).toBe(310.25);
  const edited = await read();
  expect(edited.due_date).toBe('2026-12-01');
  expect(edited.frequency).toBe('annual');
  expect(edited.notes).toBe('Raised at the 2026 AGM');
  expect(edited.website, 'editing an HOA payment wiped its portal website').toBe(website);
  expect(edited.id).toBe(row.id);

  // ── delete = archive, not drop ──
  const tr2 = page.locator('main table tbody tr').filter({ hasText: hoaName }).first();
  await tr2.locator('button:text-is("Delete")').click();
  await confirmDialog(page, 'Delete');
  await expect(page.locator('main table tbody tr').filter({ hasText: hoaName }))
    .toHaveCount(0, { timeout: 30000 });

  const { data: gone } = await sb.from('hoa_payments').select('id, archived_at, archived_by')
    .eq('company_id', COMPANY).eq('id', row.id).maybeSingle();
  expect(gone, 'Delete hard-dropped the row; the module claims to archive').toBeTruthy();
  expect(gone.archived_at, 'archived_at was never stamped').toBeTruthy();
  expect(gone.archived_by).toBeTruthy();

  expect(moduleFailures(problems), 'the HOA module produced request/console failures').toEqual([]);
});

test('HOA: Pay marks the row paid and posts a balanced two-line journal entry', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  const problems = watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const hoaName = `${t} Lakeside HOA`;

  await openRoute(page, 'hoa', /^HOA Payments$/);
  await page.locator('main button:has-text("+ Add HOA")').first().click();
  const form = page.locator('main div:has(> h3)').filter({ hasText: 'New HOA Payment' }).first();
  const propSel = field(form, 'Property *');
  await expect.poll(async () => propSel.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await propSel.selectOption(prop.address);
  await field(form, 'HOA Company').fill(hoaName);
  await field(form, 'Amount ($)').fill('412.00');
  await field(form, 'Due Date').fill('2026-10-01');
  await form.locator('button:text-is("Save")').click();
  await expect(form).toBeHidden({ timeout: 30000 });

  const { data: created } = await sb.from('hoa_payments').select('id, status')
    .eq('company_id', COMPANY).eq('hoa_name', hoaName).is('archived_at', null).single();
  expect(created.status).toBe('pending');

  // ── pay ──
  const tr = page.locator('main table tbody tr').filter({ hasText: hoaName }).first();
  await expect(tr).toBeVisible({ timeout: 30000 });
  await tr.locator('button:text-is("Pay")').click();
  await expect(page.locator('main table tbody tr').filter({ hasText: hoaName })
    .first().locator('button:text-is("Pay")')).toHaveCount(0, { timeout: 30000 });

  await expect.poll(async () => {
    const { data } = await sb.from('hoa_payments').select('status').eq('id', created.id).maybeSingle();
    return data?.status;
  }, { timeout: 20000 }).toBe('paid');
  const { data: paid } = await sb.from('hoa_payments').select('*').eq('id', created.id).single();
  expect(paid.paid_date, 'paid_date must be stamped with the day it was paid').toBe(today());

  // ── the promised side effect: a journal entry keyed HOA-<id> ──
  await expect.poll(async () => {
    const { count } = await sb.from('acct_journal_entries')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', COMPANY).like('reference', `HOA-${created.id}-%`);
    return count;
  }, { timeout: 30000, message: 'paying an HOA bill posted no journal entry' }).toBe(1);

  const { data: je } = await sb.from('acct_journal_entries').select('*')
    .eq('company_id', COMPANY).like('reference', `HOA-${created.id}-%`).single();
  expect(je.date).toBe(today());
  expect(je.status).toBe('posted');
  expect(je.property).toBe(prop.address);
  expect(je.description).toContain(hoaName);

  const { data: lines } = await sb.from('acct_journal_lines')
    .select('account_id, account_name, debit, credit, class_id').eq('journal_entry_id', je.id);
  expect(lines).toHaveLength(2);
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  expect(dr, 'the HOA entry does not balance').toBeCloseTo(cr, 2);
  expect(dr).toBeCloseTo(412, 2);
  const expense = lines.find(l => Number(l.debit) > 0);
  const cash = lines.find(l => Number(l.credit) > 0);
  expect(expense.account_name).toBe('HOA Fees');
  expect(cash.account_name).toBe('Checking Account');

  // account_name on a journal line is just a label the caller passed.
  // What lands on the P&L is whatever account_id resolves to, so check
  // the account itself.
  //
  // FIXED. HOA.js used to post the expense leg to GL code 5500, which
  // _acctCodeToName maps to "Bad Debt Expense" — so every HOA payment
  // was booked to bad debt while the line merely READ "HOA Fees", and in
  // a company with no 5500 yet resolveAccountId would create a Bad Debt
  // Expense account to receive it. Production had code 5500 meaning
  // three different things across companies (Bad Debt Expense, HOA Fees,
  // Property Management Fees). No HOA line had actually landed in bad
  // debt yet — it was latent. HOA now has its own code, 5450.
  expect(expense.account_id, 'the expense leg points at no account at all').toBeTruthy();
  const { data: expAcct } = await sb.from('acct_accounts')
    .select('code, name, type').eq('company_id', COMPANY).eq('id', expense.account_id).single();
  expect(expAcct.code, 'HOA fees must post to their own GL code, not 5500').toBe('5450');
  expect(expAcct.type).toBe('Expense');
  expect(expAcct.name,
    'the account HOA fees post to is no longer named "HOA Fees"').toBe('HOA Fees');
  expect(expAcct.name,
    'REGRESSION: HOA fees are posting to Bad Debt Expense again').not.toBe('Bad Debt Expense');
  // Without a class the entry cannot be attributed to the property on
  // any per-property report.
  expect(expense.class_id, 'the HOA expense line carries no property class').toBe(prop.classId);

  // Paying twice must not double-post.
  await openRoute(page, 'hoa', /^HOA Payments$/);
  const tr2 = page.locator('main table tbody tr').filter({ hasText: hoaName }).first();
  await expect(tr2).toBeVisible({ timeout: 30000 });
  await expect(tr2.locator('button:text-is("Pay")'),
    'a paid HOA row still offers Pay').toHaveCount(0);

  expect(moduleFailures(problems)).toEqual([]);
});

test('HOA: the form refuses to write a row when a required field is blank or the amount is not a number', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const hoaName = `${t} Nonexistent HOA`;

  const rowCount = async () => {
    const { count } = await sb.from('hoa_payments').select('*', { count: 'exact', head: true })
      .eq('company_id', COMPANY).or(`hoa_name.ilike.%${t}%,property.ilike.%${t}%`);
    return count;
  };
  expect(await rowCount()).toBe(0);

  await openRoute(page, 'hoa', /^HOA Payments$/);
  await page.locator('main button:has-text("+ Add HOA")').first().click();
  const form = page.locator('main div:has(> h3)').filter({ hasText: 'New HOA Payment' }).first();
  await expect(form).toBeVisible({ timeout: 20000 });

  // 1 — no property, no name, no amount.
  await form.locator('button:text-is("Save")').click();
  await expect(toast(page, 'Property, HOA name, and amount are required'),
    'an empty HOA form saved without complaint').toBeVisible({ timeout: 15000 });
  await expect(form, 'the form closed on a rejected save').toBeVisible();
  expect(await rowCount(), 'a row was written despite validation failing').toBe(0);

  // 2 — property + name, letters in the amount box. type=number drops
  // them, which leaves the field empty, which is still a refusal.
  const propSel = field(form, 'Property *');
  await expect.poll(async () => propSel.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await clearToasts(page);
  await propSel.selectOption(prop.address);
  await field(form, 'HOA Company').fill(hoaName);
  await typeRaw(field(form, 'Amount ($)'), 'abc');
  await expect(field(form, 'Amount ($)'),
    'the amount box accepted letters').toHaveValue('');
  await form.locator('button:text-is("Save")').click();
  await expect(toast(page, 'Property, HOA name, and amount are required')).toBeVisible({ timeout: 15000 });
  expect(await rowCount(), 'a non-numeric amount produced a row').toBe(0);

  // 3 — a valid amount but no due date. Deliberately a two-press flow:
  // the first press fills today's date into the FIELD and stops, so the
  // user can see and correct the guessed date before a payment record is
  // committed against it. It must not write a row on the first press.
  // (The toast used to be error-styled for what is a prompt, not a
  // failure; that part was fixed, the two-press behaviour was kept.)
  await clearToasts(page);
  await field(form, 'Amount ($)').fill('99');
  await form.locator('button:text-is("Save")').click();
  await expect(toast(page, "today's date has been filled in")).toBeVisible({ timeout: 15000 });
  expect(await rowCount(), 'the missing-due-date path wrote a row anyway').toBe(0);
  await expect(field(form, 'Due Date'), 'the due date was not defaulted to today').toHaveValue(today());

  // The second press is the one that commits, with the defaulted date.
  await clearToasts(page);
  await form.locator('button:text-is("Save")').click();
  await expect(form).toBeHidden({ timeout: 30000 });
  await expect.poll(rowCount, { timeout: 20000 }).toBe(1);
  const { data: saved } = await sb.from('hoa_payments').select('due_date, amount')
    .eq('company_id', COMPANY).eq('hoa_name', hoaName).single();
  expect(saved.due_date).toBe(today());
  expect(Number(saved.amount)).toBe(99);
});

// ═══════════════════════════════════════════════════════════════════════
// LOANS
// ═══════════════════════════════════════════════════════════════════════

test('Loans: a loan filled in full saves every field including escrow, survives a reload, edits, and archives', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  const problems = watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const lender = `${t} Wells Fargo`;
  const website = 'https://loans.wellsfargo.example.com';

  await openRoute(page, 'loans', /^Loans$/);
  await page.locator('main button:has-text("+ Add Loan")').first().click();
  const modal = page.locator('div[role="dialog"]').filter({ hasText: 'New Loan' }).first();
  await expect(modal).toBeVisible({ timeout: 20000 });

  const propSel = field(modal, 'Property *');
  await expect.poll(async () => propSel.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await propSel.selectOption(prop.address);
  await field(modal, 'Lender Name *').fill(lender);
  await field(modal, 'Loan Type').selectOption('DSCR');
  await field(modal, 'Original Amount ($) *').fill('250000');
  await field(modal, 'Current Balance ($)').fill('231450.75');
  await field(modal, 'Interest Rate (%)').fill('6.875');
  await field(modal, 'Monthly Payment ($)').fill('1842.33');
  await field(modal, 'Account Number').fill('LN-4455-9921');
  await field(modal, 'Loan Start Date').fill('2024-03-01');
  await field(modal, 'Maturity Date').fill('2054-03-01');
  await field(modal, 'Status').selectOption('active');
  await field(modal, 'Notes').fill('30-yr fixed, no prepayment penalty');
  // Escrow fields only exist once the checkbox is ticked.
  await modal.locator('input[type="checkbox"]').first().check();
  await field(modal, 'Escrow Amount ($)').fill('361.40');
  await field(modal, 'Escrow Covers').fill('Taxes, Insurance');
  await field(modal, 'Website').fill(website);
  await modal.locator('button:text-is("Save")').click();
  await expect(modal, 'the loan modal should close on a successful save').toBeHidden({ timeout: 30000 });

  const read = async () => {
    const { data } = await sb.from('property_loans').select('*')
      .eq('company_id', COMPANY).eq('lender_name', lender).is('archived_at', null).maybeSingle();
    return data;
  };
  await expect.poll(read, { timeout: 20000, message: 'no property_loans row was written' }).toBeTruthy();
  const row = await read();
  expect(row.property).toBe(prop.address);
  expect(row.loan_type).toBe('DSCR');
  expect(Number(row.original_amount)).toBe(250000);
  expect(Number(row.current_balance)).toBe(231450.75);
  expect(Number(row.interest_rate)).toBe(6.875);
  expect(Number(row.monthly_payment)).toBe(1842.33);
  expect(row.account_number).toBe('LN-4455-9921');
  expect(row.loan_start_date).toBe('2024-03-01');
  expect(row.maturity_date).toBe('2054-03-01');
  expect(row.status).toBe('active');
  expect(row.notes).toBe('30-yr fixed, no prepayment penalty');
  expect(row.escrow_included).toBe(true);
  expect(Number(row.escrow_amount)).toBe(361.4);
  expect(row.escrow_covers, 'what was typed into Escrow Covers is not what came back')
    .toBe('Taxes, Insurance');
  expect(row.website, 'the lender portal website typed into the form was not saved').toBe(website);
  expect(row.archived_at).toBeNull();

  // ── and on screen after a reload ──
  await openRoute(page, 'loans', /^Loans$/);
  const tr = page.locator('main table tbody tr').filter({ hasText: lender }).first();
  await expect(tr).toBeVisible({ timeout: 30000 });
  await expect(tr).toContainText('DSCR');
  await expect(tr).toContainText('6.88%');            // safeNum(...).toFixed(2)
  await expect(tr).toContainText('$1,842.33');
  await expect(tr).toContainText('$231,450.75');
  await expect(tr).toContainText('2054-03-01');
  await expect(tr).toContainText('loans.wellsfargo.example.com');

  // ── edit ──
  await tr.locator('button:text-is("Edit")').click();
  const editModal = page.locator('div[role="dialog"]').filter({ hasText: 'Edit Loan' }).first();
  await expect(editModal).toBeVisible({ timeout: 20000 });
  await expect(field(editModal, 'Lender Name *')).toHaveValue(lender);
  await expect(field(editModal, 'Current Balance ($)')).toHaveValue('231450.75');
  await expect(field(editModal, 'Escrow Covers')).toHaveValue('Taxes, Insurance');
  await expect(field(editModal, 'Website'),
    'Edit did not load the saved website, so pressing Save would wipe it').toHaveValue(website);

  await field(editModal, 'Current Balance ($)').fill('228000');
  await field(editModal, 'Interest Rate (%)').fill('7.125');
  await field(editModal, 'Loan Type').selectOption('HELOC');
  await field(editModal, 'Status').selectOption('paid_off');
  await field(editModal, 'Escrow Covers').fill('Taxes only');
  await editModal.locator('button:text-is("Save")').click();
  await expect(editModal).toBeHidden({ timeout: 30000 });

  await expect.poll(async () => Number((await read())?.current_balance), { timeout: 20000 }).toBe(228000);
  const edited = await read();
  expect(Number(edited.interest_rate)).toBe(7.125);
  expect(edited.loan_type).toBe('HELOC');
  expect(edited.status).toBe('paid_off');
  expect(edited.escrow_covers).toBe('Taxes only');
  expect(edited.website, 'editing a loan wiped its lender portal website').toBe(website);
  expect(edited.id).toBe(row.id);

  // ── delete = archive ──
  await openRoute(page, 'loans', /^Loans$/);
  const tr2 = page.locator('main table tbody tr').filter({ hasText: lender }).first();
  await expect(tr2).toBeVisible({ timeout: 30000 });
  await tr2.locator('button:text-is("Delete")').click();
  await confirmDialog(page, 'Delete');
  await expect(page.locator('main table tbody tr').filter({ hasText: lender }))
    .toHaveCount(0, { timeout: 30000 });

  const { data: gone } = await sb.from('property_loans').select('id, archived_at, archived_by')
    .eq('id', row.id).maybeSingle();
  expect(gone, 'Delete hard-dropped the loan; the module claims to archive').toBeTruthy();
  expect(gone.archived_at).toBeTruthy();
  expect(gone.archived_by).toBeTruthy();

  expect(moduleFailures(problems), 'the Loans module produced request/console failures').toEqual([]);
});

test('Loans: Record Payment posts a balanced entry and moves the balance by exactly the payment', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  const problems = watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const lender = `${t} Truist`;

  await openRoute(page, 'loans', /^Loans$/);
  await page.locator('main button:has-text("+ Add Loan")').first().click();
  const modal = page.locator('div[role="dialog"]').filter({ hasText: 'New Loan' }).first();
  const propSel = field(modal, 'Property *');
  await expect.poll(async () => propSel.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await propSel.selectOption(prop.address);
  await field(modal, 'Lender Name *').fill(lender);
  await field(modal, 'Original Amount ($) *').fill('180000');
  await field(modal, 'Current Balance ($)').fill('150000');
  await field(modal, 'Monthly Payment ($)').fill('1250.55');
  await modal.locator('button:text-is("Save")').click();
  await expect(modal).toBeHidden({ timeout: 30000 });

  const { data: loan } = await sb.from('property_loans').select('*')
    .eq('company_id', COMPANY).eq('lender_name', lender).is('archived_at', null).single();
  expect(Number(loan.current_balance)).toBe(150000);

  const tr = page.locator('main table tbody tr').filter({ hasText: lender }).first();
  await expect(tr).toBeVisible({ timeout: 30000 });
  await tr.locator('button:text-is("Record Payment")').click();
  await confirmDialog(page, 'Record Payment');

  await expect.poll(async () => {
    const { data } = await sb.from('property_loans').select('current_balance').eq('id', loan.id).maybeSingle();
    return Number(data?.current_balance);
  }, { timeout: 30000, message: 'the loan balance never moved' }).toBe(150000 - 1250.55);

  const { data: je } = await sb.from('acct_journal_entries').select('*')
    .eq('company_id', COMPANY).like('reference', `LOAN-${loan.id}-%`).maybeSingle();
  expect(je, 'recording a loan payment posted no journal entry').toBeTruthy();
  expect(je.date).toBe(today());
  expect(je.property).toBe(prop.address);

  const { data: lines } = await sb.from('acct_journal_lines')
    .select('account_id, account_name, debit, credit, class_id').eq('journal_entry_id', je.id);
  expect(lines).toHaveLength(2);
  const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  expect(dr).toBeCloseTo(cr, 2);
  expect(dr).toBeCloseTo(1250.55, 2);
  const loanExpense = lines.find(l => Number(l.debit) > 0);
  expect(loanExpense.account_name).toBe('Mortgage/Loan Payment');
  expect(lines.find(l => Number(l.credit) > 0).account_name).toBe('Checking Account');
  expect(loanExpense.class_id).toBe(prop.classId);
  // Unlike HOA, the loan leg's code and the account it resolves to agree.
  const { data: loanAcct } = await sb.from('acct_accounts')
    .select('code, name, type').eq('company_id', COMPANY).eq('id', loanExpense.account_id).single();
  expect(loanAcct.code).toBe('5600');
  expect(loanAcct.name, 'the loan expense line is labelled one thing and posted to another')
    .toBe(loanExpense.account_name);

  // Everything above must be clean. The block below deliberately provokes
  // a 409, so the failure snapshot is taken here.
  expect(moduleFailures(problems)).toEqual([]);

  // ── recording a SECOND payment ──
  // FIXED, partially by design. The reference used to be `LOAN-<id>`
  // with no date, against a unique index on (company_id, reference), so
  // the second payment on a loan — next month's, and every month after,
  // for the life of the loan — collided and was refused. It is now
  // `LOAN-<id>-<date>`.
  //
  // This test presses Record Payment twice on the SAME DAY, so it still
  // collides, and deliberately so: that collision is the double-click
  // protection the unique index exists to give. Next month's payment
  // goes through, which is what the bug prevented.
  //
  // The assertion is the invariant that must hold either way: the ledger
  // and the balance never disagree, and if the payment is refused the
  // user is told rather than left with a stale balance.
  await openRoute(page, 'loans', /^Loans$/);
  const tr2 = page.locator('main table tbody tr').filter({ hasText: lender }).first();
  await expect(tr2).toBeVisible({ timeout: 30000 });
  await tr2.locator('button:text-is("Record Payment")').click();
  await confirmDialog(page, 'Record Payment');
  await page.waitForTimeout(3000);
  const { count: jeCount } = await sb.from('acct_journal_entries')
    .select('*', { count: 'exact', head: true })
    .eq('company_id', COMPANY).like('reference', `LOAN-${loan.id}-%`);
  const { data: after } = await sb.from('property_loans').select('current_balance').eq('id', loan.id).single();
  const expected = 150000 - 1250.55 * jeCount;
  expect(Number(after.current_balance),
    `${jeCount} journal entr${jeCount === 1 ? 'y' : 'ies'} posted but the balance moved a different number of times`)
    .toBeCloseTo(expected, 2);
  // Whichever way it went, the user has to be told. A silent no-op that
  // leaves the balance stale is the worst of the available outcomes.
  if (jeCount === 1) {
    await expect(toast(page, 'Balance NOT updated'),
      'the second payment was silently dropped with no message').toBeVisible({ timeout: 15000 });
  }
});

test('Loans: the form refuses to write a row when a required field is blank or the amount is not a number', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const lender = `${t} Ghost Bank`;

  const rowCount = async () => {
    const { count } = await sb.from('property_loans').select('*', { count: 'exact', head: true })
      .eq('company_id', COMPANY).or(`lender_name.ilike.%${t}%,property.ilike.%${t}%`);
    return count;
  };
  expect(await rowCount()).toBe(0);

  await openRoute(page, 'loans', /^Loans$/);
  await page.locator('main button:has-text("+ Add Loan")').first().click();
  const modal = page.locator('div[role="dialog"]').filter({ hasText: 'New Loan' }).first();
  await expect(modal).toBeVisible({ timeout: 20000 });

  await modal.locator('button:text-is("Save")').click();
  await expect(toast(page, 'Property, lender name, and original amount are required'),
    'an empty loan form saved without complaint').toBeVisible({ timeout: 15000 });
  await expect(modal).toBeVisible();
  expect(await rowCount()).toBe(0);

  const propSel = field(modal, 'Property *');
  await expect.poll(async () => propSel.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await clearToasts(page);
  await propSel.selectOption(prop.address);
  await field(modal, 'Lender Name *').fill(lender);
  await typeRaw(field(modal, 'Original Amount ($) *'), 'not-a-number');
  await expect(field(modal, 'Original Amount ($) *')).toHaveValue('');
  await modal.locator('button:text-is("Save")').click();
  await expect(toast(page, 'Property, lender name, and original amount are required')).toBeVisible({ timeout: 15000 });
  expect(await rowCount(), 'a non-numeric original amount produced a row').toBe(0);

  // Letters in a NON-required numeric field must not corrupt the row
  // either: the value has to land as 0, never as NaN/null.
  await clearToasts(page);
  await field(modal, 'Original Amount ($) *').fill('100000');
  await typeRaw(field(modal, 'Interest Rate (%)'), 'six');
  await expect(field(modal, 'Interest Rate (%)')).toHaveValue('');
  await modal.locator('button:text-is("Save")').click();
  await expect(modal).toBeHidden({ timeout: 30000 });
  await expect.poll(rowCount, { timeout: 20000 }).toBe(1);
  const { data: saved } = await sb.from('property_loans').select('*')
    .eq('company_id', COMPANY).eq('lender_name', lender).single();
  expect(Number(saved.original_amount)).toBe(100000);
  expect(saved.interest_rate, 'a blank rate should store 0, not null').not.toBeNull();
  expect(Number(saved.interest_rate)).toBe(0);
  // current_balance defaults to the original amount when left blank.
  expect(Number(saved.current_balance)).toBe(100000);
  // Blank optional dates must be NULL, never the empty string.
  expect(saved.loan_start_date).toBeNull();
  expect(saved.maturity_date).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════
// INSURANCE
// ═══════════════════════════════════════════════════════════════════════

test('Insurance: a policy filled in full saves every field, survives a reload, edits, and archives', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  const problems = watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const provider = `${t} State Farm`;
  const website = 'https://myaccount.statefarm.example.com';

  await openRoute(page, 'insurance', /^Insurance$/);
  await page.locator('main button:has-text("+ Add Policy")').first().click();
  const modal = page.locator('div[role="dialog"]').filter({ hasText: 'New Insurance Policy' }).first();
  await expect(modal).toBeVisible({ timeout: 20000 });

  const propSel = field(modal, 'Property *');
  await expect.poll(async () => propSel.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await propSel.selectOption(prop.address);
  await field(modal, 'Provider *').fill(provider);
  await field(modal, 'Policy Number').fill('POL-77-3321-A');
  await field(modal, 'Premium Amount ($) *').fill('1487.25');
  await field(modal, 'Premium Frequency').selectOption('Quarterly');
  await field(modal, 'Coverage Amount ($)').fill('375000');
  await field(modal, 'Expiration Date').fill('2027-04-30');
  await field(modal, 'Notes').fill('Landlord policy, $2,500 deductible');
  await field(modal, 'Website').fill(website);
  await modal.locator('button:text-is("Save")').click();
  await expect(modal, 'the policy modal should close on a successful save').toBeHidden({ timeout: 30000 });

  const read = async () => {
    const { data } = await sb.from('property_insurance').select('*')
      .eq('company_id', COMPANY).eq('provider', provider).is('archived_at', null).maybeSingle();
    return data;
  };
  await expect.poll(read, { timeout: 20000, message: 'no property_insurance row was written' }).toBeTruthy();
  const row = await read();
  expect(row.property).toBe(prop.address);
  expect(row.policy_number).toBe('POL-77-3321-A');
  expect(Number(row.premium_amount)).toBe(1487.25);
  expect(row.premium_frequency).toBe('Quarterly');
  expect(Number(row.coverage_amount)).toBe(375000);
  expect(row.expiration_date).toBe('2027-04-30');
  expect(row.notes).toBe('Landlord policy, $2,500 deductible');
  expect(row.website).toBe(website);
  expect(row.archived_at).toBeNull();

  // ── and on screen after a reload ──
  await openRoute(page, 'insurance', /^Insurance$/);
  const tr = page.locator('main table tbody tr').filter({ hasText: provider }).first();
  await expect(tr).toBeVisible({ timeout: 30000 });
  await expect(tr).toContainText('POL-77-3321-A');
  await expect(tr).toContainText('$1,487.25');
  await expect(tr).toContainText('Quarterly');
  await expect(tr).toContainText('$375,000');
  await expect(tr).toContainText('2027-04-30');
  await expect(tr).toContainText('myaccount.statefarm.example.com');

  // ── edit ──
  await tr.locator('button:text-is("Edit")').click();
  const editModal = page.locator('div[role="dialog"]').filter({ hasText: 'Edit Policy' }).first();
  await expect(editModal).toBeVisible({ timeout: 20000 });
  await expect(field(editModal, 'Provider *')).toHaveValue(provider);
  await expect(field(editModal, 'Premium Amount ($) *')).toHaveValue('1487.25');
  await expect(field(editModal, 'Website')).toHaveValue(website);

  await field(editModal, 'Premium Amount ($) *').fill('1599.99');
  await field(editModal, 'Premium Frequency').selectOption('Annual');
  await field(editModal, 'Coverage Amount ($)').fill('420000');
  await field(editModal, 'Expiration Date').fill('2028-01-15');
  await field(editModal, 'Policy Number').fill('POL-77-3321-B');
  await field(editModal, 'Notes').fill('Renewed with higher dwelling limit');
  await editModal.locator('button:text-is("Save")').click();
  await expect(editModal).toBeHidden({ timeout: 30000 });

  await expect.poll(async () => Number((await read())?.premium_amount), { timeout: 20000 }).toBe(1599.99);
  const edited = await read();
  expect(edited.premium_frequency).toBe('Annual');
  expect(Number(edited.coverage_amount)).toBe(420000);
  expect(edited.expiration_date).toBe('2028-01-15');
  expect(edited.policy_number).toBe('POL-77-3321-B');
  expect(edited.notes).toBe('Renewed with higher dwelling limit');
  expect(edited.website, 'editing a policy wiped its portal website').toBe(website);
  expect(edited.id).toBe(row.id);

  // ── delete = archive ──
  await openRoute(page, 'insurance', /^Insurance$/);
  const tr2 = page.locator('main table tbody tr').filter({ hasText: provider }).first();
  await expect(tr2).toBeVisible({ timeout: 30000 });
  await tr2.locator('button:text-is("Delete")').click();
  await confirmDialog(page, 'Delete');
  await expect(page.locator('main table tbody tr').filter({ hasText: provider }))
    .toHaveCount(0, { timeout: 30000 });

  const { data: gone } = await sb.from('property_insurance').select('id, archived_at, archived_by')
    .eq('id', row.id).maybeSingle();
  expect(gone, 'Delete hard-dropped the policy; the module claims to archive').toBeTruthy();
  expect(gone.archived_at).toBeTruthy();
  expect(gone.archived_by).toBeTruthy();

  expect(moduleFailures(problems), 'the Insurance module produced request/console failures').toEqual([]);
});

test('Insurance: the form refuses to write a row when a required field is blank or the premium is not a number', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const provider = `${t} Phantom Mutual`;

  const rowCount = async () => {
    const { count } = await sb.from('property_insurance').select('*', { count: 'exact', head: true })
      .eq('company_id', COMPANY).or(`provider.ilike.%${t}%,property.ilike.%${t}%`);
    return count;
  };
  expect(await rowCount()).toBe(0);

  await openRoute(page, 'insurance', /^Insurance$/);
  await page.locator('main button:has-text("+ Add Policy")').first().click();
  const modal = page.locator('div[role="dialog"]').filter({ hasText: 'New Insurance Policy' }).first();
  await expect(modal).toBeVisible({ timeout: 20000 });

  await modal.locator('button:text-is("Save")').click();
  await expect(toast(page, 'Property, provider, and premium amount are required'),
    'an empty policy form saved without complaint').toBeVisible({ timeout: 15000 });
  await expect(modal).toBeVisible();
  expect(await rowCount()).toBe(0);

  const propSel = field(modal, 'Property *');
  await expect.poll(async () => propSel.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await clearToasts(page);
  await propSel.selectOption(prop.address);
  await field(modal, 'Provider *').fill(provider);
  await typeRaw(field(modal, 'Premium Amount ($) *'), 'twelve hundred');
  await expect(field(modal, 'Premium Amount ($) *')).toHaveValue('');
  await modal.locator('button:text-is("Save")').click();
  await expect(toast(page, 'Property, provider, and premium amount are required')).toBeVisible({ timeout: 15000 });
  expect(await rowCount(), 'a non-numeric premium produced a row').toBe(0);

  // A blank expiration date is a `date` column — it must become NULL,
  // not the empty string, or the insert 400s and disappears into a
  // try/catch.
  await clearToasts(page);
  await field(modal, 'Premium Amount ($) *').fill('900');
  await modal.locator('button:text-is("Save")').click();
  await expect(modal).toBeHidden({ timeout: 30000 });
  await expect.poll(rowCount, { timeout: 20000 }).toBe(1);
  const { data: saved } = await sb.from('property_insurance').select('*')
    .eq('company_id', COMPANY).eq('provider', provider).single();
  expect(saved.expiration_date).toBeNull();
  expect(Number(saved.premium_amount)).toBe(900);
  expect(Number(saved.coverage_amount)).toBe(0);
});

// ═══════════════════════════════════════════════════════════════════════
// TAX BILLS
//
// This module has no "new bill" form — rows are generated from the
// property's county schedule. Its forms are the generator, the Mark
// Paid modal and the Edit modal, plus the Skip prompt.
// ═══════════════════════════════════════════════════════════════════════

test('Tax bills: generation, Mark paid, Undo, Edit, Skip and Delete each reach the database', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  const problems = watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t, { county: 'Howard County', state: 'MD' });
  const year = new Date().getFullYear();

  const bills = async () => {
    const { data } = await sb.from('property_tax_bills').select('*')
      .eq('company_id', COMPANY).eq('property', prop.address).is('archived_at', null)
      .order('due_date', { ascending: true });
    return data || [];
  };
  expect(await bills()).toHaveLength(0);

  await openRoute(page, 'tax_bills', /^Property Tax Bills$/);

  // ── generate ──
  // The company-wide write now asks first, naming how many properties it
  // will touch. Deleting one bill already confirmed; a bulk write across
  // every property did not, which was the wrong way round.
  await page.locator('main button:has-text("Regenerate for current year")').click();
  await confirmDialog(page, 'Generate');
  await expect(toast(page, 'Generated'), 'the generator reported nothing').toBeVisible({ timeout: 90000 });

  await expect.poll(async () => (await bills()).length,
    { timeout: 30000, message: 'the Howard County MD schedule produced no bills' }).toBe(2);
  const generated = await bills();
  expect(generated.map(b => b.due_date)).toEqual([`${year}-09-30`, `${year}-12-31`]);
  expect(generated.map(b => b.installment_label)).toEqual(['1st half (MD)', '2nd half (MD)']);
  for (const b of generated) {
    expect(b.tax_year).toBe(year);
    expect(b.status).toBe('pending');
    expect(b.auto_generated).toBe(true);
    expect(b.property_id, 'the bill does not carry the property FK').toBe(prop.id);
  }

  // Re-running must be idempotent — the module's headline promise.
  await page.locator('main button:has-text("Regenerate for current year")').click();
  await confirmDialog(page, 'Generate');
  await expect(toast(page, 'Generated')).toBeVisible({ timeout: 90000 });
  await page.waitForTimeout(2000);
  expect((await bills()).length, 'regenerating duplicated the bills').toBe(2);

  await scopeBills(page, prop.address);
  const group = page.locator('main div.bg-white.rounded-xl').filter({ hasText: prop.line1 }).first();
  await expect(group).toBeVisible({ timeout: 30000 });

  // ── Mark paid: every field on the modal ──
  const first = page.locator('main table tbody tr').filter({ hasText: '1st half (MD)' }).first();
  await expect(first).toBeVisible({ timeout: 30000 });
  await first.locator('button:text-is("Mark paid")').click();
  const paidModal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'Mark bill paid' }).first();
  await expect(paidModal).toBeVisible({ timeout: 20000 });
  await field(paidModal, 'Paid date *').fill('2026-09-28');
  await field(paidModal, 'Amount paid').fill('1234.56');
  await field(paidModal, 'Notes').fill('check #4471');
  await paidModal.locator('button:text-is("Mark paid")').click();
  await expect(paidModal).toBeHidden({ timeout: 30000 });
  await expect(toast(page, 'Bill marked paid')).toBeVisible({ timeout: 20000 });

  const billId = generated[0].id;
  await expect.poll(async () => (await bills()).find(b => b.id === billId)?.status,
    { timeout: 20000 }).toBe('paid');
  let b1 = (await bills()).find(b => b.id === billId);
  expect(b1.paid_date).toBe('2026-09-28');
  expect(Number(b1.paid_amount)).toBe(1234.56);
  expect(b1.paid_notes).toBe('check #4471');

  // ── Undo ──
  await openRoute(page, 'tax_bills', /^Property Tax Bills$/);
  await scopeBills(page, prop.address);
  const paidRow = page.locator('main table tbody tr').filter({ hasText: '1st half (MD)' }).first();
  await expect(paidRow).toBeVisible({ timeout: 30000 });
  await paidRow.locator('button:text-is("Undo")').click();
  await confirmDialog(page, 'Confirm');
  await expect.poll(async () => (await bills()).find(b => b.id === billId)?.status,
    { timeout: 20000 }).toBe('pending');
  b1 = (await bills()).find(b => b.id === billId);
  expect(b1.paid_date, 'Undo left the paid date behind').toBeNull();
  expect(b1.paid_amount, 'Undo left the paid amount behind').toBeNull();
  expect(b1.paid_notes).toBeNull();

  // ── Edit ──
  await openRoute(page, 'tax_bills', /^Property Tax Bills$/);
  await scopeBills(page, prop.address);
  const editRow = page.locator('main table tbody tr').filter({ hasText: '1st half (MD)' }).first();
  await expect(editRow).toBeVisible({ timeout: 30000 });
  await editRow.locator('button:text-is("Edit")').click();
  const editModal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'Edit bill' }).first();
  await expect(editModal).toBeVisible({ timeout: 20000 });
  await expect(field(editModal, 'Installment label')).toHaveValue('1st half (MD)');
  await expect(field(editModal, 'Due date')).toHaveValue(`${year}-09-30`);
  await field(editModal, 'Installment label').fill('1st half (revised)');
  await field(editModal, 'Due date').fill(`${year}-10-15`);
  await field(editModal, 'Expected amount').fill('2100.75');
  await editModal.locator('button:text-is("Save")').click();
  await expect(editModal).toBeHidden({ timeout: 30000 });
  await expect(toast(page, 'Bill updated')).toBeVisible({ timeout: 20000 });

  await expect.poll(async () => (await bills()).find(b => b.id === billId)?.installment_label,
    { timeout: 20000 }).toBe('1st half (revised)');
  b1 = (await bills()).find(b => b.id === billId);
  expect(b1.due_date).toBe(`${year}-10-15`);
  expect(Number(b1.expected_amount)).toBe(2100.75);
  expect(b1.auto_generated,
    'an edited bill must detach from the generator or the next run stomps it').toBe(false);

  // ── Skip (window.prompt) ──
  await openRoute(page, 'tax_bills', /^Property Tax Bills$/);
  await scopeBills(page, prop.address);
  const secondId = generated[1].id;
  const skipRow = page.locator('main table tbody tr').filter({ hasText: '2nd half (MD)' }).first();
  await expect(skipRow).toBeVisible({ timeout: 30000 });
  page.once('dialog', d => d.accept('lender escrow'));
  await skipRow.locator('button:text-is("Skip")').click();
  await expect(toast(page, 'Bill skipped')).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await bills()).find(b => b.id === secondId)?.status,
    { timeout: 20000 }).toBe('skipped');
  expect((await bills()).find(b => b.id === secondId).paid_notes).toBe('lender escrow');

  // ── Delete = archive ──
  await openRoute(page, 'tax_bills', /^Property Tax Bills$/);
  await scopeBills(page, prop.address);
  const delRow = page.locator('main table tbody tr').filter({ hasText: '1st half (revised)' }).first();
  await expect(delRow).toBeVisible({ timeout: 30000 });
  await delRow.locator('button:text-is("✕")').click();
  await confirmDialog(page, 'Delete');
  await expect(page.locator('main table tbody tr').filter({ hasText: '1st half (revised)' }))
    .toHaveCount(0, { timeout: 30000 });

  const { data: gone } = await sb.from('property_tax_bills')
    .select('id, archived_at, archived_by').eq('id', billId).maybeSingle();
  expect(gone, 'Delete hard-dropped the bill; the dialog promises 180-day recovery').toBeTruthy();
  expect(gone.archived_at).toBeTruthy();
  expect(gone.archived_by).toBeTruthy();

  expect(moduleFailures(problems), 'the Tax Bills module produced request/console failures').toEqual([]);
});

test('Tax bills: Mark paid with no date is refused and changes nothing', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t, { county: 'Howard County', state: 'MD' });
  const year = new Date().getFullYear();

  // Seed the bill directly — generation is covered above and this test
  // is about the modal's validation.
  const { data: bill, error } = await sb.from('property_tax_bills').insert([{
    company_id: COMPANY, property: prop.address, property_id: prop.id,
    tax_year: year, installment_label: '1st half (MD)', due_date: `${year}-09-30`,
    expected_amount: 1500, status: 'pending', auto_generated: true,
  }]).select('*').single();
  if (error) throw new Error('seed tax bill: ' + error.message);

  await openRoute(page, 'tax_bills', /^Property Tax Bills$/);
  await scopeBills(page, prop.address);
  const anyRow = page.locator('main table tbody tr').filter({ hasText: '1st half (MD)' }).first();
  await expect(anyRow).toBeVisible({ timeout: 30000 });
  await anyRow.locator('button:text-is("Mark paid")').click();
  const paidModal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'Mark bill paid' }).first();
  await expect(paidModal).toBeVisible({ timeout: 20000 });

  // The date is pre-filled with today; clearing it is the user error
  // this guard exists for.
  await field(paidModal, 'Paid date *').fill('');
  await paidModal.locator('button:text-is("Mark paid")').click();
  await expect(toast(page, 'Paid date is required'),
    'a bill was marked paid with no date').toBeVisible({ timeout: 15000 });
  await expect(paidModal, 'the modal closed on a rejected save').toBeVisible();

  const { data: unchanged } = await sb.from('property_tax_bills').select('*').eq('id', bill.id).single();
  expect(unchanged.status).toBe('pending');
  expect(unchanged.paid_date).toBeNull();
  expect(unchanged.paid_amount).toBeNull();
});

// ═══════════════════════════════════════════════════════════════════════
// PORTAL CREDENTIALS — the one field group shared by three of the four
// modules, and the only one whose write path leaves the browser.
//
// encryptCredential() posts to /api/encrypt, a Vercel serverless
// function. It is NOT served by the CRA dev server, so on a local run
// the call 404s. The contract that matters either way is: a credential
// is stored encrypted, or the WHOLE save is refused — never a row with
// the password sitting in it, and never a row saved with the
// credentials silently dropped.
// ═══════════════════════════════════════════════════════════════════════

test('Portal credentials are stored encrypted, or the entire save is refused — never dropped or stored in the clear', async ({ page }) => {
  test.setTimeout(300000);
  const t = tag();
  watchForFailures(page);
  const sb = await db();
  const prop = await seedProperty(t);
  const available = await encryptApiAvailable();
  const USER = 'sigma.portal.user';
  const PASS = 'C0rrect-Horse-Battery';

  // ── HOA ──
  const hoaName = `${t} Creds HOA`;
  await openRoute(page, 'hoa', /^HOA Payments$/);
  await page.locator('main button:has-text("+ Add HOA")').first().click();
  const hoaForm = page.locator('main div:has(> h3)').filter({ hasText: 'New HOA Payment' }).first();
  const hoaProp = field(hoaForm, 'Property *');
  await expect.poll(async () => hoaProp.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await hoaProp.selectOption(prop.address);
  await field(hoaForm, 'HOA Company').fill(hoaName);
  await field(hoaForm, 'Amount ($)').fill('150');
  await field(hoaForm, 'Due Date').fill('2026-11-30');
  await field(hoaForm, 'Website').fill('https://hoa.example.com');
  await field(hoaForm, 'Username').fill(USER);
  await field(hoaForm, 'Password').fill(PASS);
  await hoaForm.locator('button:text-is("Save")').click();

  const hoaRow = async () => {
    const { data } = await sb.from('hoa_payments').select('*')
      .eq('company_id', COMPANY).eq('hoa_name', hoaName).maybeSingle();
    return data;
  };

  if (available) {
    await expect(hoaForm).toBeHidden({ timeout: 30000 });
    await expect.poll(hoaRow, { timeout: 20000 }).toBeTruthy();
    const r = await hoaRow();
    expect(r.username_encrypted, 'the username was dropped instead of stored').toBeTruthy();
    expect(r.password_encrypted, 'the password was dropped instead of stored').toBeTruthy();
    expect(r.username_encrypted, 'the username was stored in the clear').not.toBe(USER);
    expect(r.password_encrypted, 'the password was stored in the clear').not.toBe(PASS);
    expect(r.encryption_iv, 'no IV was persisted, so the value can never be decrypted').toBeTruthy();
    expect(r.encryption_iv_username,
      'username and password share one IV slot — the username is unreadable after save').toBeTruthy();
    expect(r.encryption_iv_username).not.toBe(r.encryption_iv);
    expect(r.encryption_salt).toBeTruthy();
  } else {
    // No encryption service ⇒ the save must abort with a visible message
    // and leave nothing behind. A row here would mean credentials were
    // silently discarded while the user believes they were saved.
    await expect(toast(page, 'Could not encrypt credentials'),
      'the save neither encrypted the credentials nor said why it could not').toBeVisible({ timeout: 20000 });
    await expect(hoaForm, 'the form closed on a save that did not happen').toBeVisible();
    expect(await hoaRow(),
      'the HOA row was written even though its credentials could not be encrypted').toBeNull();
  }

  // ── Loans ──
  const lender = `${t} Creds Bank`;
  await openRoute(page, 'loans', /^Loans$/);
  await page.locator('main button:has-text("+ Add Loan")').first().click();
  const loanModal = page.locator('div[role="dialog"]').filter({ hasText: 'New Loan' }).first();
  const loanProp = field(loanModal, 'Property *');
  await expect.poll(async () => loanProp.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await loanProp.selectOption(prop.address);
  await field(loanModal, 'Lender Name *').fill(lender);
  await field(loanModal, 'Original Amount ($) *').fill('90000');
  await field(loanModal, 'Username').fill(USER);
  await field(loanModal, 'Password').fill(PASS);
  await loanModal.locator('button:text-is("Save")').click();

  const loanRow = async () => {
    const { data } = await sb.from('property_loans').select('*')
      .eq('company_id', COMPANY).eq('lender_name', lender).maybeSingle();
    return data;
  };
  if (available) {
    await expect(loanModal).toBeHidden({ timeout: 30000 });
    await expect.poll(loanRow, { timeout: 20000 }).toBeTruthy();
    const r = await loanRow();
    expect(r.password_encrypted).toBeTruthy();
    expect(r.password_encrypted).not.toBe(PASS);
    expect(r.encryption_iv_username).toBeTruthy();
  } else {
    await expect(toast(page, 'Could not encrypt credentials')).toBeVisible({ timeout: 20000 });
    expect(await loanRow(),
      'the loan row was written even though its credentials could not be encrypted').toBeNull();
    await loanModal.locator('button:text-is("Cancel")').click();
  }

  // ── Insurance ──
  const provider = `${t} Creds Mutual`;
  await openRoute(page, 'insurance', /^Insurance$/);
  await page.locator('main button:has-text("+ Add Policy")').first().click();
  const insModal = page.locator('div[role="dialog"]').filter({ hasText: 'New Insurance Policy' }).first();
  const insProp = field(insModal, 'Property *');
  await expect.poll(async () => insProp.locator(`option[value="${prop.address}"]`).count(),
    { timeout: 30000 }).toBe(1);
  await insProp.selectOption(prop.address);
  await field(insModal, 'Provider *').fill(provider);
  await field(insModal, 'Premium Amount ($) *').fill('700');
  await field(insModal, 'Username').fill(USER);
  await field(insModal, 'Password').fill(PASS);
  await insModal.locator('button:text-is("Save")').click();

  const insRow = async () => {
    const { data } = await sb.from('property_insurance').select('*')
      .eq('company_id', COMPANY).eq('provider', provider).maybeSingle();
    return data;
  };
  if (available) {
    await expect(insModal).toBeHidden({ timeout: 30000 });
    await expect.poll(insRow, { timeout: 20000 }).toBeTruthy();
    const r = await insRow();
    expect(r.password_encrypted).toBeTruthy();
    expect(r.password_encrypted).not.toBe(PASS);
    expect(r.encryption_iv_username).toBeTruthy();
  } else {
    await expect(toast(page, 'Could not encrypt credentials')).toBeVisible({ timeout: 20000 });
    expect(await insRow(),
      'the policy row was written even though its credentials could not be encrypted').toBeNull();
  }
});
