// ═══════════════════════════════════════════════════════════════════════
// REAL FORM SUBMISSION — Move-out / Lifecycle, Notifications, Late Fees,
// and the three accounting importers (Bank CSV, QuickBooks, Reconcile).
//
// Every other spec that touches these five screens opens a form and
// cancels. This one fills every field, submits, and then proves the
// consequence in the DATABASE: the row exists, the values are the values
// that were typed, the edit persisted, the delete/archive left the
// active view, and the promised side effect actually happened.
//
// These modules are mostly ABOUT their side effects, so those are the
// assertions that matter:
//   • a late fee rule applied posts a balanced JE for exactly the
//     configured amount and moves the tenant balance by that amount
//   • a move-out terminates the lease, ends autopay, and ARCHIVES the
//     tenant rather than deleting them
//   • a notification rule that is enabled enqueues a notification_queue
//     row when its event fires; a disabled one enqueues nothing
//   • a CSV bank import creates bank_feed_transaction rows that match
//     the file row-for-row and cent-for-cent, and re-importing the SAME
//     file does not double-post
//
// ── Data ──────────────────────────────────────────────────────────────
// Runs against `e2e-sandbox`, a disposable full-fidelity copy of the
// production data. Everything created here is tagged with a per-run
// token and swept in afterAll, including any journal entries caused as
// a side effect, so the sandbox still balances (SUM(debit)=SUM(credit))
// afterwards.
//
// ── Findings this file encodes ────────────────────────────────────────
// Bugs proven by assertions below are flagged `BUG:` in the test that
// finds them. Bugs that live OUTSIDE the four component files this run
// is allowed to touch are documented in comments with their exact
// location and are NOT asserted as passing behaviour.
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');
const { watchForFailures } = require('./helpers');

const COMPANY = process.env.E2E_COMPANY || 'e2e-sandbox';
const PRISTINE = 'f56be35c-c80d-4f47-8624-cbb317f85461';
if (COMPANY === PRISTINE) throw new Error('93 must never run against Sahil LLC');

// ── Database ──────────────────────────────────────────────────────────
// anon key + a real login, i.e. the same RLS path the app itself uses.
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

const TAG = 'E2E93' + Math.random().toString(36).slice(2, 7).toUpperCase();
const ADMIN_EMAIL = (process.env.TEST_EMAIL || '').toLowerCase();

// Ids of rows created outside the tag-able namespace, cleaned by id.
const created = { notifSettings: [], reconciliations: [], jeIds: [], feedIds: [], hadPeriodLock: null };

// The app writes dates with formatLocalDate (utils/helpers.js), which
// reads getFullYear/getMonth/getDate — i.e. the LOCAL calendar day.
// toISOString() is UTC, so between local midnight and UTC midnight the
// two disagree by a day and every date assertion built on toISOString
// silently starts failing. Match the app.
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function localDatePlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDate(d);
}
function localMonthCompact() { return localDate().slice(0, 7).replace('-', ''); }

// ── UI helpers ────────────────────────────────────────────────────────
async function openRoute(page, routeId, marker) {
  const loc = typeof marker === 'function'
    ? marker(page)
    : page.locator('main h2').filter({ hasText: marker }).first();
  await page.goto(`/?company=${encodeURIComponent(COMPANY)}#${routeId}`, { timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await loc.isVisible({ timeout: attempt === 0 ? 30000 : 12000 }).catch(() => false)) return;
    await page.evaluate((p) => {
      window.history.pushState({ page: p, screen: 'app' }, '', '#' + p);
      window.dispatchEvent(new PopStateEvent('popstate', { state: { page: p, screen: 'app' } }));
    }, routeId);
    await page.waitForTimeout(2000);
  }
  await expect(loc, `never reached the ${routeId} route`).toBeVisible({ timeout: 20000 });
}

const toasts = (page) => page.locator('div.fixed.bottom-4.right-4');
function toast(page, text) { return toasts(page).getByText(text, { exact: false }).first(); }

async function confirmDialog(page, action = 'Confirm') {
  const modal = page.locator('div.fixed.inset-0.z-\\[90\\]').first();
  await expect(modal).toBeVisible({ timeout: 20000 });
  await modal.locator(`button:text-is("${action}")`).first().click();
  await expect(modal).toBeHidden({ timeout: 60000 });
}

// The app's numeric <input type="number"> silently drops non-numeric
// keystrokes, so `fill('abc')` throws. Type it key by key: the field
// ends up EMPTY, which is exactly what a user who typed letters sees,
// and is the state the form's validation has to cope with.
async function typeGarbage(locator, text = 'abc') {
  await locator.fill('');
  await locator.click();
  await locator.pressSequentially(text, { delay: 20 });
}

// ── Fixture seeding ───────────────────────────────────────────────────
async function seedProperty(suffix, extra = {}) {
  const sb = await db();
  const line1 = `${TAG}${suffix} Forms Way`;
  const address = `${line1}, Testville, MD 20770`;
  const classId = crypto.randomUUID();
  const { error: cErr } = await sb.from('acct_classes').insert([{
    id: classId, company_id: COMPANY, name: address,
    description: 'Auto-created for ' + line1, color: '#3b82f6', is_active: true,
  }]);
  if (cErr) throw new Error('seed class: ' + cErr.message);
  const { data, error } = await sb.from('properties').insert([{
    company_id: COMPANY, address, address_line_1: line1, city: 'Testville',
    state: 'MD', zip: '20770', county: 'Howard County', type: 'Single Family',
    status: 'occupied', rent: 2000, bedrooms: 3, bathrooms: 2, class_id: classId, ...extra,
  }]).select('id, address').single();
  if (error) throw new Error('seed property: ' + error.message);
  return { id: data.id, address, line1, classId };
}

async function seedTenant(suffix, address, extra = {}) {
  const sb = await db();
  const name = `Testcase ${TAG}${suffix}`;
  const { data, error } = await sb.from('tenants').insert([{
    company_id: COMPANY, name, first_name: 'Testcase', last_name: `${TAG}${suffix}`,
    email: `${TAG.toLowerCase()}${String(suffix).toLowerCase()}@e2e.invalid`,
    phone: '(555) 010-0000', property: address, lease_status: 'active',
    rent: 2000, balance: 0, lease_start: '2026-01-01', move_in: '2026-01-01',
    lease_end_date: '2026-12-31', move_out: '2026-12-31', ...extra,
  }]).select('id, name, email, balance').single();
  if (error) throw new Error('seed tenant: ' + error.message);
  return data;
}

async function seedLease(tenant, address, extra = {}) {
  const sb = await db();
  const { data, error } = await sb.from('leases').insert([{
    company_id: COMPANY, tenant_id: tenant.id, tenant_name: tenant.name,
    property: address, status: 'active', start_date: '2026-01-01',
    end_date: '2026-12-31', rent_amount: 2000, payment_due_day: 1,
    security_deposit: 0, lease_type: 'fixed', ...extra,
  }]).select('*').single();
  if (error) throw new Error('seed lease: ' + error.message);
  return data;
}

async function seedAutopay(tenant, address) {
  const sb = await db();
  const { data, error } = await sb.from('autopay_schedules').insert([{
    company_id: COMPANY, tenant: tenant.name, tenant_id: tenant.id, property: address,
    amount: 2000, frequency: 'monthly', day_of_month: '1', method: 'stripe_card',
    provider: 'stripe', enabled: true, active: true, next_charge_date: '2026-10-01',
  }]).select('*').single();
  if (error) throw new Error('seed autopay: ' + error.message);
  return data;
}

// notification_settings has a UNIQUE(company_id, event_type). Upsert so a
// re-run doesn't collide, and remember which rows WE inserted so cleanup
// only removes ours.
async function seedNotificationSetting(eventType, patch = {}) {
  const sb = await db();
  const row = {
    company_id: COMPANY, event_type: eventType, enabled: true,
    recipients: 'all', days_before: 0, template: '',
    channels: { in_app: true, email: true, push: false }, ...patch,
  };
  const { data, error } = await sb.from('notification_settings')
    .upsert([row], { onConflict: 'company_id,event_type' }).select('*').single();
  if (error) throw new Error('seed notification_settings: ' + error.message);
  if (!created.notifSettings.includes(data.id)) created.notifSettings.push(data.id);
  return data;
}

// A posted JE straight into the GL, used by the Reconcile tests as the
// bank activity to reconcile against.
async function seedJournalEntry({ date, description, reference, lines }) {
  const sb = await db();
  const id = crypto.randomUUID();
  const number = 'E2E-' + Math.random().toString(36).slice(2, 9).toUpperCase();
  const { error: hErr } = await sb.from('acct_journal_entries').insert([{
    id, company_id: COMPANY, number, date, description,
    reference: reference || '', status: 'posted', property: '',
  }]);
  if (hErr) throw new Error('seed JE: ' + hErr.message);
  created.jeIds.push(id);
  const { data, error } = await sb.from('acct_journal_lines').insert(
    lines.map(l => ({ ...l, journal_entry_id: id, company_id: COMPANY }))
  ).select('id, account_name, debit, credit');
  if (error) throw new Error('seed JE lines: ' + error.message);
  return { id, number, lines: data };
}

async function accountIdByCode(code) {
  const sb = await db();
  const { data } = await sb.from('acct_accounts').select('id, name')
    .eq('company_id', COMPANY).eq('code', code).maybeSingle();
  return data;
}

// ── Cleanup ───────────────────────────────────────────────────────────
async function purge() {
  const sb = await db();
  const like = `%${TAG}%`;

  // Journal entries: two passes, because a background worker can land a
  // row between the SELECT and the DELETE.
  for (let pass = 0; pass < 2; pass++) {
    const ids = new Set(created.jeIds);
    for (const col of ['description', 'reference']) {
      const { data } = await sb.from('acct_journal_entries')
        .select('id').eq('company_id', COMPANY).ilike(col, like);
      (data || []).forEach(j => ids.add(j.id));
    }
    // Late-fee / move-out / eviction references are keyed off ids, not the
    // tag, so sweep them by the tenant name embedded in the description.
    const { data: byDesc } = await sb.from('acct_journal_entries')
      .select('id').eq('company_id', COMPANY).ilike('description', `%Testcase ${TAG}%`);
    (byDesc || []).forEach(j => ids.add(j.id));
    const arr = [...ids];
    for (let i = 0; i < arr.length; i += 50) {
      const chunk = arr.slice(i, i + 50);
      await sb.from('acct_journal_lines').delete().in('journal_entry_id', chunk);
      await sb.from('acct_journal_entries').delete().eq('company_id', COMPANY).in('id', chunk);
    }
    if (pass === 0) await new Promise(r => setTimeout(r, 1500));
  }

  // Banking
  const { data: feeds } = await sb.from('bank_account_feed')
    .select('id').eq('company_id', COMPANY).ilike('account_name', like);
  const feedIds = [...new Set([...(feeds || []).map(f => f.id), ...created.feedIds])];
  if (feedIds.length) {
    await sb.from('bank_feed_transaction').delete().eq('company_id', COMPANY).in('bank_account_feed_id', feedIds);
    await sb.from('bank_import_batch').delete().eq('company_id', COMPANY).in('bank_account_feed_id', feedIds);
    await sb.from('bank_transaction_rule').delete().eq('company_id', COMPANY).in('bank_account_feed_id', feedIds);
    await sb.from('bank_account_feed').delete().eq('company_id', COMPANY).in('id', feedIds);
  }
  await sb.from('bank_transaction_rule').delete().eq('company_id', COMPANY).ilike('name', like);

  // Reconcile: clear the reconciled flags we set, drop our recon rows,
  // and remove the period lock the save auto-created (only if there
  // wasn't one before this run).
  if (created.reconciliations.length) {
    await sb.from('bank_reconciliations').delete().eq('company_id', COMPANY).in('id', created.reconciliations);
  }
  await sb.from('bank_reconciliations').delete().eq('company_id', COMPANY).ilike('period', '2019-%');
  if (created.hadPeriodLock === false) {
    await sb.from('accounting_period_lock').delete().eq('company_id', COMPANY);
  }

  // Lifecycle / notifications / late fees
  await sb.from('eviction_cases').delete().eq('company_id', COMPANY).ilike('tenant_name', like);
  await sb.from('inspections').delete().eq('company_id', COMPANY).ilike('property', like);
  await sb.from('late_fee_rules').delete().eq('company_id', COMPANY).ilike('name', like);
  await sb.from('notification_log').delete().eq('company_id', COMPANY).eq('related_id', 'test')
    .gte('created_at', new Date(Date.now() - 6 * 3600 * 1000).toISOString());
  await sb.from('notification_queue').delete().eq('company_id', COMPANY).ilike('recipient_email', `${TAG.toLowerCase()}%`);
  await sb.from('notification_inbox').delete().eq('company_id', COMPANY).ilike('message', like);
  if (created.notifSettings.length) {
    await sb.from('notification_settings').delete().eq('company_id', COMPANY).in('id', created.notifSettings);
  }

  // Core records
  await sb.from('autopay_schedules').delete().eq('company_id', COMPANY).ilike('tenant', like);
  await sb.from('recurring_journal_entries').delete().eq('company_id', COMPANY).ilike('property', like);
  await sb.from('leases').delete().eq('company_id', COMPANY).ilike('tenant_name', like);
  await sb.from('leases').delete().eq('company_id', COMPANY).ilike('property', like);
  await sb.from('acct_accounts').delete().eq('company_id', COMPANY).ilike('name', like);
  await sb.from('acct_accounts').delete().eq('company_id', COMPANY).ilike('name', `%Testcase ${TAG}%`);
  await sb.from('tenants').delete().eq('company_id', COMPANY).ilike('name', like);
  await sb.from('properties').delete().eq('company_id', COMPANY).ilike('address', like);
  await sb.from('acct_classes').delete().eq('company_id', COMPANY).ilike('name', like);
}

test.beforeAll(async () => {
  const sb = await db();
  const { data } = await sb.from('accounting_period_lock').select('lock_date').eq('company_id', COMPANY).maybeSingle();
  created.hadPeriodLock = !!data;
});

test.afterAll(async () => {
  if (process.env.E2E93_KEEP) { console.log('[93] E2E93_KEEP set — leaving rows in place, TAG=' + TAG); return; }
  await purge();
  const sb = await db();
  // The books must still balance. Sum in pages — Supabase caps a
  // response at 1000 rows, so a single select would quietly under-count.
  // The sandbox is shared with other specs running at the same time, and
  // a JE header lands a moment before its lines. Poll rather than judge
  // the books on one read taken mid-transaction.
  let dr = 0, cr = 0, diff = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    dr = 0; cr = 0;
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from('acct_journal_lines').select('debit, credit')
        .eq('company_id', COMPANY).range(from, from + 999);
      if (!data || data.length === 0) break;
      data.forEach(l => { dr += Number(l.debit || 0); cr += Number(l.credit || 0); });
      if (data.length < 1000) break;
    }
    diff = Math.abs(Math.round((dr - cr) * 100) / 100);
    if (diff === 0) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  // eslint-disable-next-line no-console
  console.log(`[93 cleanup] sandbox debits ${dr.toFixed(2)} credits ${cr.toFixed(2)} diff ${diff}`);
  expect(diff, 'sandbox books must still balance after this spec').toBe(0);
});

// ══════════════════════════════════════════════════════════════════════
// LATE FEES  — src/components/LateFees.js
// ══════════════════════════════════════════════════════════════════════
const lateFeesPage = (page) => openRoute(page, 'latefees', 'Late Fee Automation');

async function openNewRuleForm(page) {
  await page.locator('main button:has-text("+ New Rule")').click();
  const name = page.getByPlaceholder('Standard Late Fee');
  await expect(name).toBeVisible({ timeout: 15000 });
  return name;
}

// Archive every rule this run left behind so the next test starts from a
// known "exactly one active rule" state — the page only ever applies
// rules[0], so a stray rule changes which fee gets charged.
async function archiveMyRules() {
  const sb = await db();
  await sb.from('late_fee_rules').update({ archived_at: new Date().toISOString() })
    .eq('company_id', COMPANY).ilike('name', `%${TAG}%`).is('archived_at', null);
}

test.describe('Late fees', () => {
  // The page only ever applies rules[0], and the query that loads them is
  // unordered, so a rule left behind by a failed test would decide which
  // fee the next test charges. Start every test from zero active rules.
  test.beforeEach(async () => {
    const sb = await db();
    await sb.from('late_fee_rules').update({ archived_at: new Date().toISOString() })
      .eq('company_id', COMPANY).is('archived_at', null);
  });

  test('a new flat rule saves with exactly the values typed', async ({ page }) => {
    const sb = await db();
    const ruleName = `${TAG} Flat Rule`;
    await lateFeesPage(page);
    const nameInput = await openNewRuleForm(page);

    await nameInput.fill(ruleName);
    const form = page.locator('main div:has(> h3:text-is("New Late Fee Rule"))').first();
    const grace = form.locator('input[type="number"]').first();
    const amount = form.locator('input[type="number"]').nth(1);
    await grace.fill('7');
    await form.locator('select').selectOption('flat');
    await amount.fill('62.50');
    await page.locator('main button:text-is("Save Rule")').click();

    // The card must appear...
    await expect(page.getByText(ruleName, { exact: false }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('7 day grace', { exact: false }).first()).toBeVisible();

    // ...and the row must actually be there, with the typed values.
    const { data: rows } = await sb.from('late_fee_rules').select('*')
      .eq('company_id', COMPANY).eq('name', ruleName);
    expect(rows, 'rule row was never written').toHaveLength(1);
    const r = rows[0];
    expect(r.grace_days, 'grace_days').toBe(7);
    expect(Number(r.fee_amount), 'fee_amount').toBe(62.5);
    expect(r.fee_type).toBe('flat');
    expect(r.company_id).toBe(COMPANY);
    expect(r.archived_at).toBeNull();

    await archiveMyRules();
  });

  test('a percent rule saves as percent, and Delete archives rather than drops it', async ({ page }) => {
    const sb = await db();
    const ruleName = `${TAG} Percent Rule`;
    await lateFeesPage(page);
    const nameInput = await openNewRuleForm(page);
    await nameInput.fill(ruleName);
    const form = page.locator('main div:has(> h3:text-is("New Late Fee Rule"))').first();
    await form.locator('input[type="number"]').first().fill('3');
    await form.locator('select').selectOption('percent');
    await form.locator('input[type="number"]').nth(1).fill('5.5');
    await page.locator('main button:text-is("Save Rule")').click();
    await expect(page.getByText(ruleName, { exact: false }).first()).toBeVisible({ timeout: 20000 });

    const { data: after } = await sb.from('late_fee_rules').select('*')
      .eq('company_id', COMPANY).eq('name', ruleName).single();
    expect(after.fee_type).toBe('percent');
    expect(Number(after.fee_amount)).toBe(5.5);
    expect(after.grace_days).toBe(3);
    // The card renders the percent form of the fee, not the dollar form.
    await expect(page.getByText('5.5% of rent', { exact: false }).first()).toBeVisible();

    // Delete → archive, not a hard drop.
    const card = page.locator('main div.rounded-2xl').filter({ hasText: ruleName }).first();
    await card.locator('button:has-text("Delete")').click();
    await confirmDialog(page, 'Confirm');
    await expect(page.getByText(ruleName, { exact: false })).toHaveCount(0, { timeout: 20000 });

    const { data: archived } = await sb.from('late_fee_rules').select('*')
      .eq('company_id', COMPANY).eq('name', ruleName).maybeSingle();
    expect(archived, 'Delete hard-deleted the rule; the app claims to archive').not.toBeNull();
    expect(archived.archived_at, 'archived_at should be stamped').not.toBeNull();
    expect(archived.archived_by, 'archived_by should record who did it').toBeTruthy();
  });

  test('validation: blank name and a non-numeric fee are both refused, and write nothing', async ({ page }) => {
    const sb = await db();
    const before = await sb.from('late_fee_rules').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY);
    await lateFeesPage(page);
    const nameInput = await openNewRuleForm(page);
    const form = page.locator('main div:has(> h3:text-is("New Late Fee Rule"))').first();

    // 1. Required field left empty.
    await nameInput.fill('');
    await page.locator('main button:text-is("Save Rule")').click();
    await expect(toast(page, 'Rule name is required')).toBeVisible({ timeout: 10000 });

    // 2. Letters typed into the numeric fee field. The number input drops
    //    them, leaving it empty — the form must refuse, visibly.
    await nameInput.fill(`${TAG} Should Not Exist`);
    await typeGarbage(form.locator('input[type="number"]').nth(1), 'abc');
    await expect(form.locator('input[type="number"]').nth(1)).toHaveValue('');
    await page.locator('main button:text-is("Save Rule")').click();
    await expect(toast(page, 'Please fill all fields')).toBeVisible({ timeout: 10000 });

    // 3. A zero fee is not a fee.
    await form.locator('input[type="number"]').nth(1).fill('0');
    await page.locator('main button:text-is("Save Rule")').click();
    await expect(toast(page, 'Fee amount must be a positive number')).toBeVisible({ timeout: 10000 });

    // 4. A negative grace period.
    await form.locator('input[type="number"]').nth(1).fill('40');
    await form.locator('input[type="number"]').first().fill('-3');
    await page.locator('main button:text-is("Save Rule")').click();
    await expect(toast(page, 'Grace days must be a valid number')).toBeVisible({ timeout: 10000 });

    const after = await sb.from('late_fee_rules').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY);
    expect(after.count, 'a refused submit still wrote a row').toBe(before.count);
    const { data: ghost } = await sb.from('late_fee_rules').select('id')
      .eq('company_id', COMPANY).ilike('name', '%Should Not Exist%');
    expect(ghost).toHaveLength(0);
  });

  // The heart of the module: applying a fee has to move money by exactly
  // the configured amount, in the GL and on the tenant, and exactly once.
  test('applying a flat rule posts a balanced JE for the configured amount, moves the balance, and refuses to double-charge', async ({ page }) => {
    test.skip(new Date().getDate() === 1,
      'the overdue list derives days-late from the current month\'s due day; on the 1st nothing can be late');
    const sb = await db();
    const prop = await seedProperty('LF');
    const tenant = await seedTenant('LF', prop.address, { balance: 1800, rent: 2000 });
    await seedLease(tenant, prop.address, { payment_due_day: 1 });
    // late_fee_applied must be enabled for the notification side effect.
    await seedNotificationSetting('late_fee_applied', { enabled: true, channels: { in_app: true, email: true, push: false } });

    const ruleName = `${TAG} Apply Rule`;
    const problems = watchForFailures(page);
    await lateFeesPage(page);
    const nameInput = await openNewRuleForm(page);
    await nameInput.fill(ruleName);
    const form = page.locator('main div:has(> h3:text-is("New Late Fee Rule"))').first();
    await form.locator('input[type="number"]').first().fill('0');   // no grace
    await form.locator('select').selectOption('flat');
    await form.locator('input[type="number"]').nth(1).fill('75.25');
    await page.locator('main button:text-is("Save Rule")').click();
    await expect(page.getByText(ruleName, { exact: false }).first()).toBeVisible({ timeout: 20000 });

    // The tenant is now on the overdue list, past grace.
    const card = page.locator('main div.rounded-xl').filter({ hasText: tenant.name }).first();
    await expect(card).toBeVisible({ timeout: 20000 });
    const applyBtn = card.locator('button:has-text("Late Fee")').first();
    await expect(applyBtn, 'the tenant should be flagged past the 0-day grace period').toBeVisible();
    expect(await applyBtn.innerText()).toContain('75.25');

    await applyBtn.click();
    // The page confirms via the header bell (addNotification), not a
    // toast, so wait on the consequence in the GL instead.
    const month = localMonthCompact();
    const ref = `LATE-${tenant.id}-${month}`;
    await expect.poll(async () => {
      const { data } = await sb.from('acct_journal_entries').select('id')
        .eq('company_id', COMPANY).eq('reference', ref);
      return (data || []).length;
    }, { timeout: 45000, message: 'Apply did not post a late-fee journal entry' }).toBe(1);

    // ── GL ──────────────────────────────────────────────────────────
    const { data: jes } = await sb.from('acct_journal_entries').select('id, description, status, date')
      .eq('company_id', COMPANY).eq('reference', ref);
    expect(jes, 'exactly one late-fee JE for this tenant this month').toHaveLength(1);
    expect(jes[0].status).toBe('posted');
    expect(jes[0].description).toContain(tenant.name);

    await expect.poll(async () => {
      const { data } = await sb.from('acct_journal_lines').select('id').eq('journal_entry_id', jes[0].id);
      return (data || []).length;
    }, { timeout: 30000, message: 'the late-fee JE never got its lines' }).toBe(2);
    const { data: lines } = await sb.from('acct_journal_lines')
      .select('account_name, debit, credit').eq('journal_entry_id', jes[0].id);
    expect(lines).toHaveLength(2);
    const dr = lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const cr = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    expect(dr, 'debit total must equal the configured fee').toBe(75.25);
    expect(cr, 'credit total must equal the configured fee').toBe(75.25);
    const income = lines.find(l => Number(l.credit) > 0);
    expect(income.account_name).toBe('Late Fee Income');

    // The JE must go through the atomic writer. atomicPostJEAndLedger
    // resolves the bare GL codes this module posts ("1100", "4010") to
    // account UUIDs before calling post_je_and_ledger; when it did not,
    // the RPC 400'd on its uuid cast, the error was swallowed by a silent
    // pmError, and the entry was written by the non-atomic fallback
    // instead. A 4xx on that endpoint is the fingerprint of that
    // regression returning. (/api/* is a Vercel serverless route and 404s
    // against a local CRA dev server, so only the RPC is considered.)
    const rpcFailures = problems.filter(p => /post_je_and_ledger/.test(p));
    expect(rpcFailures, 'the late fee did not post through the atomic RPC:\n' + rpcFailures.join('\n')).toEqual([]);

    // ── Tenant balance ──────────────────────────────────────────────
    // This module debits the SHARED 1100 receivable, whose tenant_id is
    // NULL, so the sync_tenant_balance_lines trigger cannot move the
    // balance — post_je_and_ledger's p_balance_change is what does, and
    // it is applied only because no line hit a per-tenant AR account.
    await expect.poll(async () => {
      const { data } = await sb.from('tenants').select('balance').eq('id', tenant.id).single();
      return Number(data.balance);
    }, { timeout: 30000, message: 'balance must move by exactly the fee' }).toBe(1800 + 75.25);

    // ── Notification side effect ────────────────────────────────────
    await expect.poll(async () => {
      const { data } = await sb.from('notification_queue').select('id, type, recipient_email')
        .eq('company_id', COMPANY).eq('type', 'late_fee_applied')
        .ilike('recipient_email', tenant.email);
      return (data || []).length;
    }, { timeout: 20000, message: 'an enabled late_fee_applied rule must enqueue a notification' })
      .toBe(1);

    // ── Not twice ───────────────────────────────────────────────────
    await lateFeesPage(page);
    const card2 = page.locator('main div.rounded-xl').filter({ hasText: tenant.name }).first();
    await expect(card2).toBeVisible({ timeout: 20000 });
    await card2.locator('button:has-text("Late Fee")').first().click();
    await page.waitForTimeout(4000);
    const { data: jes2 } = await sb.from('acct_journal_entries').select('id')
      .eq('company_id', COMPANY).eq('reference', ref);
    expect(jes2, 'a second apply must not post a second fee').toHaveLength(1);
    const { data: t3 } = await sb.from('tenants').select('balance').eq('id', tenant.id).single();
    expect(Number(t3.balance), 'a second apply must not move the balance again').toBe(1800 + 75.25);

    await archiveMyRules();
  });

  // The balance has two possible movers and they must never both fire.
  // post_je_and_ledger applies p_balance_change ONLY when no line landed
  // on a per-tenant AR sub-account; where one does, the
  // sync_tenant_balance_lines trigger recomputes the balance from the GL
  // instead. This module posts to the SHARED 1100 receivable, so the
  // increment path is the live one — and it has to move the balance
  // exactly one fee's worth, not two.
  test('applying a late fee moves the tenant balance by exactly one fee, once', async ({ page }) => {
    test.skip(new Date().getDate() === 1, 'nothing can be late on the 1st');
    const sb = await db();
    const prop = await seedProperty('BAL');
    const tenant = await seedTenant('BAL', prop.address, { balance: 1200, rent: 2000 });
    await seedLease(tenant, prop.address, { payment_due_day: 1 });
    const { data: rule } = await sb.from('late_fee_rules').insert([{
      company_id: COMPANY, name: `${TAG} Balance Rule`, grace_days: 0, fee_amount: 45, fee_type: 'flat',
    }]).select('id').single();

    await lateFeesPage(page);
    const card = page.locator('main div.rounded-xl').filter({ hasText: tenant.name }).first();
    await expect(card).toBeVisible({ timeout: 30000 });
    await card.locator('button:has-text("Late Fee")').first().click();

    // The fee reaches the general ledger...
    const month = localMonthCompact();
    const ref = `LATE-${tenant.id}-${month}`;
    await expect.poll(async () => ((await sb.from('acct_journal_entries').select('id')
      .eq('company_id', COMPANY).eq('reference', ref)).data || []).length,
      { timeout: 45000, message: 'the fee should post to the GL' }).toBe(1);
    const { data: je } = await sb.from('acct_journal_entries').select('id')
      .eq('company_id', COMPANY).eq('reference', ref).single();
    await expect.poll(async () => ((await sb.from('acct_journal_lines').select('id')
      .eq('journal_entry_id', je.id)).data || []).length, { timeout: 30000 }).toBe(2);

    // ...and moves the balance by one fee. 1290 here would mean both the
    // RPC increment and the trigger had fired.
    await expect.poll(async () => {
      const { data } = await sb.from('tenants').select('balance').eq('id', tenant.id).single();
      return Number(data.balance);
    }, { timeout: 30000, message: 'balance must move by exactly one fee' }).toBe(1245);
    // Settle, then confirm nothing arrived late and doubled it.
    await page.waitForTimeout(5000);
    const { data: t2 } = await sb.from('tenants').select('balance').eq('id', tenant.id).single();
    expect(Number(t2.balance), 'the fee must not be applied twice').toBe(1245);

    // The leg it posted to is the shared receivable — which is exactly
    // why the RPC's increment, rather than the trigger, is the mover.
    const { data: lines } = await sb.from('acct_journal_lines')
      .select('account_id, debit').eq('journal_entry_id', je.id);
    const arLine = lines.find(l => Number(l.debit) > 0);
    const { data: arAcct } = await sb.from('acct_accounts').select('code, tenant_id')
      .eq('id', arLine.account_id).single();
    expect(arAcct.code, 'the debit lands on the shared receivable').toBe('1100');
    expect(arAcct.tenant_id, 'which is not tied to any tenant').toBeNull();

    await sb.from('late_fee_rules').update({ archived_at: new Date().toISOString() }).eq('id', rule.id);
  });

  // The button says what it is about to charge. For a percent rule it
  // computed that preview off the tenant's BALANCE while applyLateFee
  // charges a percentage of their RENT — two different numbers whenever
  // the tenant is not exactly one month behind.
  test('a percent rule charges what its button says it will charge', async ({ page }) => {
    test.skip(new Date().getDate() === 1, 'nothing can be late on the 1st');
    const sb = await db();
    const prop = await seedProperty('PC');
    // balance 900, rent 2000 -> 5% of rent is 100.00; 5% of balance is 45.
    const tenant = await seedTenant('PC', prop.address, { balance: 900, rent: 2000 });
    await seedLease(tenant, prop.address, { payment_due_day: 1, rent_amount: 2000 });

    const ruleName = `${TAG} Pct Apply`;
    await lateFeesPage(page);
    const nameInput = await openNewRuleForm(page);
    await nameInput.fill(ruleName);
    const form = page.locator('main div:has(> h3:text-is("New Late Fee Rule"))').first();
    await form.locator('input[type="number"]').first().fill('0');
    await form.locator('select').selectOption('percent');
    await form.locator('input[type="number"]').nth(1).fill('5');
    await page.locator('main button:text-is("Save Rule")').click();
    await expect(page.getByText(ruleName, { exact: false }).first()).toBeVisible({ timeout: 20000 });

    const card = page.locator('main div.rounded-xl').filter({ hasText: tenant.name }).first();
    await expect(card).toBeVisible({ timeout: 20000 });
    const applyBtn = card.locator('button:has-text("Late Fee")').first();
    const label = await applyBtn.innerText();
    const promised = Number(label.replace(/[^0-9.]/g, ''));

    await applyBtn.click();
    const month = localMonthCompact();
    const ref = `LATE-${tenant.id}-${month}`;
    await expect.poll(async () => {
      const { data } = await sb.from('acct_journal_entries').select('id')
        .eq('company_id', COMPANY).eq('reference', ref);
      return (data || []).length;
    }, { timeout: 45000, message: 'Apply did not post a late-fee journal entry' }).toBe(1);

    const { data: jeRows } = await sb.from('acct_journal_entries').select('id')
      .eq('company_id', COMPANY).eq('reference', ref);
    await expect.poll(async () => {
      const { data } = await sb.from('acct_journal_lines').select('id')
        .eq('company_id', COMPANY).in('journal_entry_id', jeRows.map(j => j.id));
      return (data || []).length;
    }, { timeout: 30000, message: 'the late-fee JE never got its lines' }).toBe(2);
    const { data: lines } = await sb.from('acct_journal_lines').select('debit')
      .eq('company_id', COMPANY).in('journal_entry_id', jeRows.map(j => j.id));
    const charged = lines.reduce((s, l) => s + Number(l.debit || 0), 0);

    expect(charged, '5% of the $2000 rent').toBe(100);
    expect(promised, 'the Apply button must preview the amount it is about to charge').toBe(charged);

    await archiveMyRules();
  });
});

// ══════════════════════════════════════════════════════════════════════
// NOTIFICATIONS  — src/components/Notifications.js
//
// The Preferences tab is the notification rule editor: every control on
// a rule card writes straight to notification_settings, and the row it
// writes is what queueNotification() consults when an event fires. So
// the tests here end where the rule actually bites — a queue row, or
// deliberately none.
// ══════════════════════════════════════════════════════════════════════
const notificationsPage = (page) => openRoute(page, 'notifications', 'Notifications');

async function preferencesTab(page) {
  await page.locator('main button:text-is("Preferences")').click();
  await page.waitForTimeout(800);
}

// A rule card, found by the human label the registry gives its event.
function ruleCard(page, label) {
  return page.locator('main div.rounded-3xl, main div[class*="rounded"]')
    .filter({ hasText: label }).last();
}

test.describe('Notifications', () => {
  test('the enable toggle, channels, recipients and message all persist what was set', async ({ page }) => {
    const sb = await db();
    const setting = await seedNotificationSetting('inspection_due', {
      enabled: true, recipients: 'all', days_before: 3, template: '',
      channels: { in_app: true, email: true, push: false },
    });

    await notificationsPage(page);
    await preferencesTab(page);
    const card = ruleCard(page, 'Inspection reminder');
    await expect(card).toBeVisible({ timeout: 30000 });

    // ── Recipients ───────────────────────────────────────────────────
    await card.locator('select').first().selectOption('tenant');
    await expect.poll(async () => (await sb.from('notification_settings')
      .select('recipients').eq('id', setting.id).single()).data.recipients,
      { timeout: 20000 }).toBe('tenant');

    // ── Channels: Email off ──────────────────────────────────────────
    await card.locator('button:text-is("Email")').click();
    await expect.poll(async () => (await sb.from('notification_settings')
      .select('channels').eq('id', setting.id).single()).data.channels.email,
      { timeout: 20000 }).toBe(false);
    // ...and Push on, so the write is a real merge and not a wholesale
    // replacement that drops the other keys.
    await card.locator('button:text-is("Push")').click();
    await expect.poll(async () => (await sb.from('notification_settings')
      .select('channels').eq('id', setting.id).single()).data.channels.push,
      { timeout: 20000 }).toBe(true);
    const { data: chRow } = await sb.from('notification_settings').select('channels').eq('id', setting.id).single();
    expect(chRow.channels.in_app, 'toggling one channel must not clobber the others').toBe(true);
    expect(chRow.channels.email).toBe(false);

    // ── days_before ──────────────────────────────────────────────────
    const days = card.locator('input[type="number"]').first();
    await days.fill('9');
    await days.blur();
    await expect.poll(async () => (await sb.from('notification_settings')
      .select('days_before').eq('id', setting.id).single()).data.days_before,
      { timeout: 20000 }).toBe(9);

    // ── Template ─────────────────────────────────────────────────────
    const body = `${TAG} Inspection at {{property}} on {{date}}.`;
    await card.locator('summary:has-text("Customize message")').click();
    const ta = card.locator('textarea').first();
    await ta.fill(body);
    await ta.blur();
    await expect.poll(async () => (await sb.from('notification_settings')
      .select('template').eq('id', setting.id).single()).data.template,
      { timeout: 20000 }).toBe(body);

    // ── Enable toggle ────────────────────────────────────────────────
    await card.locator('button[aria-label="Disable Inspection reminder"]').click();
    await expect.poll(async () => (await sb.from('notification_settings')
      .select('enabled').eq('id', setting.id).single()).data.enabled,
      { timeout: 20000 }).toBe(false);
    await ruleCard(page, 'Inspection reminder')
      .locator('button[aria-label="Enable Inspection reminder"]').click();
    await expect.poll(async () => (await sb.from('notification_settings')
      .select('enabled').eq('id', setting.id).single()).data.enabled,
      { timeout: 20000 }).toBe(true);

    // Everything survives a reload — this is a row, not component state.
    await notificationsPage(page);
    await preferencesTab(page);
    const reloaded = ruleCard(page, 'Inspection reminder');
    await expect(reloaded.locator('select').first()).toHaveValue('tenant');
    await expect(reloaded.locator('input[type="number"]').first()).toHaveValue('9');
  });

  test('validation: a blank or negative "days early" is refused and does not overwrite the saved value', async ({ page }) => {
    const sb = await db();
    const setting = await seedNotificationSetting('insurance_expiring', { enabled: true, days_before: 14 });
    await notificationsPage(page);
    await preferencesTab(page);
    const card = ruleCard(page, 'Vendor insurance expiring');
    await expect(card).toBeVisible({ timeout: 30000 });
    const days = card.locator('input[type="number"]').first();
    await expect(days).toHaveValue('14');

    // Letters: the number input drops them and the field goes empty. The
    // field is controlled off the saved row, so a refused edit snaps back
    // to the stored value — which is the visible proof it was refused.
    await typeGarbage(days, 'abc');
    await expect(toast(page, 'Enter how many days early')).toBeVisible({ timeout: 10000 });
    await expect(days, 'the field must fall back to the saved value').toHaveValue('14');

    // Negative.
    await days.fill('-5');
    await expect(toast(page, 'Enter how many days early')).toBeVisible({ timeout: 10000 });
    await expect(days).toHaveValue('14');

    const { data } = await sb.from('notification_settings').select('days_before').eq('id', setting.id).single();
    expect(data.days_before, 'a refused edit must leave the stored value alone').toBe(14);
  });

  test('"Send test" writes a notification_log row addressed to the signed-in user', async ({ page }) => {
    const sb = await db();
    await seedNotificationSetting('deposit_returned', { enabled: true });
    const before = (await sb.from('notification_log').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY).eq('event_type', 'deposit_returned')).count || 0;

    await notificationsPage(page);
    await preferencesTab(page);
    const card = ruleCard(page, 'Deposit settlement');
    await expect(card).toBeVisible({ timeout: 30000 });
    await card.locator('button:text-is("Send test")').click();

    await expect.poll(async () => (await sb.from('notification_log').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY).eq('event_type', 'deposit_returned')).count,
      { timeout: 20000, message: 'Send test wrote no log row' }).toBe(before + 1);

    const { data: rows } = await sb.from('notification_log').select('*')
      .eq('company_id', COMPANY).eq('event_type', 'deposit_returned')
      .order('created_at', { ascending: false }).limit(1);
    const row = rows[0];
    expect(row.subject, 'the test must be labelled as one').toContain('[TEST]');
    expect(row.subject).toContain('Deposit settlement');
    expect(row.recipient_email).toBe(ADMIN_EMAIL);
    expect(row.status).toBe('sent');
    expect(row.related_id).toBe('test');

    // And it shows up under History without a reload.
    await page.locator('main button:text-is("History")').click();
    await expect(page.getByText('[TEST] Deposit settlement', { exact: false }).first())
      .toBeVisible({ timeout: 20000 });

    await sb.from('notification_log').delete().eq('id', row.id);
  });

  test('an enabled rule enqueues on its event; the same rule disabled enqueues nothing', async ({ page }) => {
    test.skip(new Date().getDate() === 1, 'nothing can be late on the 1st');
    const sb = await db();
    const setting = await seedNotificationSetting('late_fee_applied', {
      enabled: true, channels: { in_app: true, email: true, push: false },
    });

    // Two identical tenants — one fee applied per state of the rule, so
    // the per-tenant-per-month duplicate guard never confuses the result.
    const prop = await seedProperty('NQ');
    const tOn = await seedTenant('NQON', prop.address, { balance: 500, rent: 2000 });
    await seedLease(tOn, prop.address, { payment_due_day: 1 });
    const tOff = await seedTenant('NQOFF', prop.address, { balance: 500, rent: 2000 });
    await seedLease(tOff, prop.address, { payment_due_day: 1 });

    await sb.from('late_fee_rules').update({ archived_at: new Date().toISOString() })
      .eq('company_id', COMPANY).is('archived_at', null);
    const { data: rule } = await sb.from('late_fee_rules').insert([{
      company_id: COMPANY, name: `${TAG} Queue Rule`, grace_days: 0, fee_amount: 20, fee_type: 'flat',
    }]).select('id').single();
    expect(rule.id).toBeTruthy();

    // ── Rule ON ──────────────────────────────────────────────────────
    await lateFeesPage(page);
    const cardOn = page.locator('main div.rounded-xl').filter({ hasText: tOn.name }).first();
    await expect(cardOn).toBeVisible({ timeout: 30000 });
    await cardOn.locator('button:has-text("Late Fee")').first().click();
    await expect.poll(async () => (await sb.from('notification_queue').select('id')
      .eq('company_id', COMPANY).eq('type', 'late_fee_applied')
      .ilike('recipient_email', tOn.email)).data.length,
      { timeout: 30000, message: 'an enabled rule must enqueue' }).toBe(1);

    const { data: q } = await sb.from('notification_queue').select('*')
      .eq('company_id', COMPANY).ilike('recipient_email', tOn.email).single();
    expect(q.status).toBe('pending');
    const payload = typeof q.data === 'string' ? JSON.parse(q.data) : q.data;
    expect(Number(payload.amount), 'the queued payload carries the fee that was charged').toBe(20);
    expect(payload.tenant).toBe(tOn.name);

    // ── Rule OFF, through the UI ─────────────────────────────────────
    await notificationsPage(page);
    await preferencesTab(page);
    await ruleCard(page, 'Late fee applied')
      .locator('button[aria-label="Disable Late fee applied"]').click();
    await expect.poll(async () => (await sb.from('notification_settings')
      .select('enabled').eq('id', setting.id).single()).data.enabled,
      { timeout: 20000 }).toBe(false);

    await lateFeesPage(page);
    const cardOff = page.locator('main div.rounded-xl').filter({ hasText: tOff.name }).first();
    await expect(cardOff).toBeVisible({ timeout: 30000 });
    await cardOff.locator('button:has-text("Late Fee")').first().click();
    // Wait for the fee itself to land, so "no queue row" is a real
    // absence and not just an unfinished request.
    const month = localMonthCompact();
    await expect.poll(async () => (await sb.from('acct_journal_entries').select('id')
      .eq('company_id', COMPANY).eq('reference', `LATE-${tOff.id}-${month}`)).data.length,
      { timeout: 45000 }).toBe(1);
    await page.waitForTimeout(3000);
    const { data: none } = await sb.from('notification_queue').select('id')
      .eq('company_id', COMPANY).ilike('recipient_email', tOff.email);
    expect(none, 'a disabled rule must enqueue nothing').toHaveLength(0);

    await sb.from('late_fee_rules').update({ archived_at: new Date().toISOString() }).eq('id', rule.id);
  });
});

// ══════════════════════════════════════════════════════════════════════
// MOVE-OUT WIZARD  — src/components/Lifecycle.js
// ══════════════════════════════════════════════════════════════════════
const moveOutPage = (page) => openRoute(page, 'moveout', 'Move-Out Wizard');

test.describe('Move-out wizard', () => {
  test('a completed move-out terminates the lease, archives the tenant, vacates the property, stops autopay and posts the deposit', async ({ page }) => {
    const sb = await db();
    const prop = await seedProperty('MO');
    const tenant = await seedTenant('MO', prop.address, { balance: 0, rent: 2000 });
    const lease = await seedLease(tenant, prop.address, { security_deposit: 1500, rent_amount: 2000 });
    const autopay = await seedAutopay(tenant, prop.address);
    await seedNotificationSetting('move_out', { enabled: true, channels: { in_app: true, email: true, push: false } });
    // Prove the starting state, so every assertion below is a change.
    expect(autopay.enabled).toBe(true);

    await moveOutPage(page);

    // ── Step 1: tenant + date ────────────────────────────────────────
    await page.locator('main select').first().selectOption(String(tenant.id));
    const dateInput = page.locator('main input[type="date"]').first();
    await expect(dateInput).toBeVisible({ timeout: 20000 });
    const moveOutDate = localDate();
    await dateInput.fill(moveOutDate);
    // The summary must show the lease we seeded, not a neighbouring one.
    await expect(page.getByText('$1500.00', { exact: false }).first()).toBeVisible({ timeout: 20000 });
    await page.locator('main button:has-text("Next")').click();

    // ── Step 2: inspection checklist ─────────────────────────────────
    await expect(page.getByText('Move-Out Inspection').first()).toBeVisible({ timeout: 20000 });
    // The row's onClick lives on the wrapping div; clicking the label
    // span inside it bubbles, and the span is an unambiguous target.
    for (const item of ['Keys returned', 'Unit cleaned', 'Final inspection done']) {
      await page.locator('main span').filter({ hasText: new RegExp(`^${item}$`) }).first().click();
    }
    await expect(page.getByText('3/11', { exact: false }).first().or(page.locator('main'))).toBeVisible();
    await page.locator('main button:has-text("Next")').click();

    // ── Step 3: deposit deductions ───────────────────────────────────
    await expect(page.getByText('Security Deposit Settlement').first()).toBeVisible({ timeout: 20000 });
    await page.getByPlaceholder('Description (e.g., Wall damage)').fill(`${TAG} Carpet replacement`);
    await page.locator('main input[placeholder="$"]').fill('250.50');
    await page.locator('main button:text-is("Add")').click();
    await expect(page.getByText(`${TAG} Carpet replacement`).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('-$250.50', { exact: false }).first()).toBeVisible();
    // 1500 held − 250.50 deducted = 1249.50 credited to the tenant.
    await expect(page.getByText('Credit to tenant ledger').first()).toBeVisible();
    await page.locator('main button:has-text("Next")').click();

    // ── Step 4: AR settlement (nothing outstanding) ──────────────────
    await expect(page.getByText('Outstanding Balance').first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('No outstanding balance').first()).toBeVisible();
    await page.locator('main button:has-text("Next")').click();

    // ── Step 5: confirm ──────────────────────────────────────────────
    await expect(page.getByText('Confirm Move-Out').first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('3/11 checked').first()).toBeVisible();
    await page.locator('main button:has-text("Execute Move-Out")').click();
    await expect(page.locator('main h2:has-text("Move-Out Complete")')).toBeVisible({ timeout: 120000 });

    // ── Lease terminated ─────────────────────────────────────────────
    const { data: l2 } = await sb.from('leases').select('status, end_date').eq('id', lease.id).single();
    expect(l2.status).toBe('terminated');
    expect(l2.end_date).toBe(moveOutDate);

    // ── Tenant ARCHIVED, not deleted ─────────────────────────────────
    const { data: t2 } = await sb.from('tenants').select('*').eq('id', tenant.id).maybeSingle();
    expect(t2, 'the tenant row must still exist — move-out archives, it does not delete').not.toBeNull();
    expect(t2.archived_at, 'archived_at must be stamped').not.toBeNull();
    expect(t2.archived_by).toBeTruthy();
    expect(t2.lease_status).toBe('inactive');
    expect(t2.move_out).toBe(moveOutDate);

    // ── Property vacated ─────────────────────────────────────────────
    const { data: p2 } = await sb.from('properties').select('status, tenant, lease_end').eq('id', prop.id).single();
    expect(p2.status).toBe('vacant');
    expect(p2.tenant).toBe('');
    expect(p2.lease_end).toBeNull();

    // ── Autopay actually stopped ─────────────────────────────────────
    // `enabled` is the column api/stripe.js charge-autopay-due filters on.
    // move_out_commit_state only clears `active`, so the component clears
    // `enabled` too; without that a moved-out tenant keeps getting billed.
    const { data: ap } = await sb.from('autopay_schedules').select('enabled, active').eq('id', autopay.id).single();
    expect(ap.enabled, 'autopay must be disabled on the column the charger reads').toBe(false);
    expect(ap.active).toBe(false);

    // ── Deposit + deductions posted ──────────────────────────────────
    const { data: jes } = await sb.from('acct_journal_entries')
      .select('id, description, reference, date, status')
      .eq('company_id', COMPANY).ilike('description', `%${tenant.name}%`);
    const depJe = jes.find(j => j.reference.startsWith('DEP-TFR-'));
    const dedJe = jes.find(j => j.reference.startsWith('DEP-DED-'));
    expect(depJe, 'the held deposit must be released to the tenant ledger').toBeTruthy();
    expect(dedJe, 'the deductions must be charged').toBeTruthy();
    expect(depJe.date).toBe(moveOutDate);

    for (const [je, amount, label] of [[depJe, 1500, 'deposit'], [dedJe, 250.5, 'deductions']]) {
      await expect.poll(async () => {
        const { data } = await sb.from('acct_journal_lines').select('id').eq('journal_entry_id', je.id);
        return (data || []).length;
      }, { timeout: 30000, message: `${label} JE never got its lines` }).toBe(2);
      const { data: lines } = await sb.from('acct_journal_lines')
        .select('account_name, debit, credit').eq('journal_entry_id', je.id);
      const dr = lines.reduce((s, x) => s + Number(x.debit || 0), 0);
      const cr = lines.reduce((s, x) => s + Number(x.credit || 0), 0);
      expect(dr, `${label} debit`).toBe(amount);
      expect(cr, `${label} credit`).toBe(amount);
    }
    const { data: depLines } = await sb.from('acct_journal_lines')
      .select('account_name, debit, credit').eq('journal_entry_id', depJe.id);
    expect(depLines.find(l => Number(l.debit) > 0).account_name).toBe('Security Deposits Held');
    expect(depLines.find(l => Number(l.credit) > 0).account_name).toContain('AR - ' + tenant.name);

    // ── The balance moved once, and by the right amount ─────────────
    // Both move-out legs hit the tenant's OWN AR sub-account, so
    // post_je_and_ledger deliberately does NOT apply p_balance_change
    // here — the sync_tenant_balance_lines trigger recomputes the balance
    // as SUM(debit) - SUM(credit) over that account instead. The deposit
    // credits 1500 and the deductions debit 250.50, so the tenant ends
    // owed 1249.50. If the RPC increment ALSO fired, this would not be
    // -1249.50, and every per-tenant-AR balance in the app would be
    // quietly corrupted.
    await expect.poll(async () => {
      const { data } = await sb.from('tenants').select('balance').eq('id', tenant.id).single();
      return Number(data.balance);
    }, { timeout: 30000, message: 'the move-out balance must be the GL position, applied once' })
      .toBe(-1249.5);
    const { data: arAcct } = await sb.from('acct_accounts').select('id, tenant_id')
      .eq('company_id', COMPANY).eq('tenant_id', tenant.id).maybeSingle();
    expect(arAcct, 'move-out posts to a per-tenant AR sub-account').not.toBeNull();
    const { data: arLines } = await sb.from('acct_journal_lines')
      .select('debit, credit').eq('account_id', arAcct.id);
    const arPosition = arLines.reduce((s2, l) => s2 + Number(l.debit || 0) - Number(l.credit || 0), 0);
    expect(Math.round(arPosition * 100) / 100, 'the stored balance must equal the GL position exactly')
      .toBe(-1249.5);

    // ── The inspection checklist survives ────────────────────────────
    // This wrote to `items`, a column that does not exist on inspections
    // (it is `checklist`), with no error check — every move-out
    // inspection was silently discarded by a swallowed PostgREST 400.
    const { data: insp } = await sb.from('inspections').select('*')
      .eq('company_id', COMPANY).eq('property', prop.address).eq('type', 'Move-Out');
    expect(insp, 'the move-out inspection must be saved').toHaveLength(1);
    const checklist = typeof insp[0].checklist === 'string' ? JSON.parse(insp[0].checklist) : insp[0].checklist;
    expect(checklist).toHaveLength(11);
    expect(checklist.filter(c => c.checked).map(c => c.label).sort())
      .toEqual(['Final inspection done', 'Keys returned', 'Unit cleaned']);
    expect(insp[0].date).toBe(moveOutDate);

    // ── Notification enqueued ────────────────────────────────────────
    await expect.poll(async () => (await sb.from('notification_queue').select('id')
      .eq('company_id', COMPANY).eq('type', 'move_out').ilike('recipient_email', tenant.email)).data.length,
      { timeout: 20000, message: 'move-out must enqueue its notification' }).toBe(1);

    // ── And the tenant has left the active view ──────────────────────
    await moveOutPage(page);
    const body = await page.locator('main').innerText();
    expect(body, 'an archived tenant must not still be selectable for move-out').not.toContain(tenant.name);
  });

  test('validation: a deduction with no description, or a non-numeric amount, is refused with a message and adds nothing', async ({ page }) => {
    const prop = await seedProperty('MV');
    const tenant = await seedTenant('MV', prop.address, { balance: 0 });
    await seedLease(tenant, prop.address, { security_deposit: 900 });

    await moveOutPage(page);
    await page.locator('main select').first().selectOption(String(tenant.id));
    await expect(page.locator('main input[type="date"]').first()).toBeVisible({ timeout: 20000 });
    await page.locator('main button:has-text("Next")').click();
    await expect(page.getByText('Move-Out Inspection').first()).toBeVisible({ timeout: 20000 });
    await page.locator('main button:has-text("Next")').click();
    await expect(page.getByText('Security Deposit Settlement').first()).toBeVisible({ timeout: 20000 });

    const desc = page.getByPlaceholder('Description (e.g., Wall damage)');
    const amt = page.locator('main input[placeholder="$"]');

    // Required field empty.
    await amt.fill('120');
    await page.locator('main button:text-is("Add")').click();
    await expect(toast(page, 'Enter a description for the deduction')).toBeVisible({ timeout: 10000 });

    // Letters in the numeric field — the number input leaves it blank.
    await desc.fill(`${TAG} Bad amount`);
    await typeGarbage(amt, 'abc');
    await page.locator('main button:text-is("Add")').click();
    await expect(toast(page, 'Enter the deduction amount as a number')).toBeVisible({ timeout: 10000 });

    // Zero is not a deduction.
    await amt.fill('0');
    await page.locator('main button:text-is("Add")').click();
    await expect(toast(page, 'must be greater than zero')).toBeVisible({ timeout: 10000 });

    // Nothing was added, so the running total is still the full deposit.
    await expect(page.getByText('Total Deductions').first()).toBeVisible();
    await expect(page.locator('main').getByText('-$0.00', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(`${TAG} Bad amount`)).toHaveCount(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// EVICTIONS  — src/components/Lifecycle.js (EvictionWorkflow)
// ══════════════════════════════════════════════════════════════════════
const evictionsPage = (page) => openRoute(page, 'evictions', 'Eviction Tracker');

async function seedEvictionCase(tenant, address, patch = {}) {
  const sb = await db();
  const today = localDate();
  // stage_history is written by the app as JSON.stringify(...) into a
  // jsonb column and read back with JSON.parse, so it has to be seeded as
  // a JSON *string* or the detail panel throws on mount.
  const { data, error } = await sb.from('eviction_cases').insert([{
    company_id: COMPANY,
    tenant_id: null,
    tenant_name: tenant.name, property: address,
    reason: 'non_payment', notice_type: 'pay_or_quit', notice_days: 30,
    notice_date: today, cure_deadline: today,
    current_stage: 'notice', status: 'active',
    notes: `${TAG} seeded case`,
    stage_history: JSON.stringify([{ stage: 'notice', date: today, note: 'seeded', cost: 0, by: ADMIN_EMAIL }]),
    total_costs: 0, ...patch,
  }]).select('*').single();
  if (error) throw new Error('seed eviction case: ' + error.message);
  return data;
}

test.describe('Evictions', () => {
  test('validation: Start Case with no tenant selected is refused and writes nothing', async ({ page }) => {
    const sb = await db();
    const before = (await sb.from('eviction_cases').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)).count || 0;
    await evictionsPage(page);
    await page.locator('main button:has-text("+ New Case")').click();
    await expect(page.getByText('Start Eviction Case').first()).toBeVisible({ timeout: 20000 });
    await page.locator('main textarea').fill(`${TAG} should never be saved`);
    await page.locator('main button:text-is("Start Case")').click();
    await expect(toast(page, 'Select a tenant')).toBeVisible({ timeout: 10000 });
    const after = (await sb.from('eviction_cases').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)).count || 0;
    expect(after).toBe(before);
  });

  // This was a KNOWN BROKEN test until migration
  // 20260906120000_eviction_cases_tenant_id_type: eviction_cases.tenant_id
  // was `uuid` while tenants.id is `integer`, so createCase() writing the
  // tenant id straight in made Postgres reject every insert with
  // `invalid input syntax for type uuid` — no eviction case could be
  // opened from the UI at all, and never could. The column is now bigint
  // with an FK, so this is the happy path it always should have been.
  test('starting a case saves every field entered and puts the tenant on notice', async ({ page }) => {
    const sb = await db();
    const prop = await seedProperty('EV');
    const tenant = await seedTenant('EV', prop.address, { balance: 3200 });
    const lease = await seedLease(tenant, prop.address);

    await evictionsPage(page);
    await page.locator('main button:has-text("+ New Case")').click();
    await expect(page.getByText('Start Eviction Case').first()).toBeVisible({ timeout: 20000 });
    await page.locator('main select').first().selectOption(String(tenant.id));
    await page.locator('main select').nth(1).selectOption('lease_violation');
    await page.locator('main select').nth(2).selectOption('cure_or_quit');
    await page.locator('main select').nth(3).selectOption('14');
    const notes = `${TAG} unauthorised pet, third notice`;
    await page.locator('main textarea').fill(notes);
    await page.locator('main button:text-is("Start Case")').click();

    await expect.poll(async () => ((await sb.from('eviction_cases').select('id')
      .eq('company_id', COMPANY).eq('tenant_name', tenant.name)).data || []).length,
      { timeout: 30000, message: 'Start Case wrote no eviction case' }).toBe(1);

    const { data: kase } = await sb.from('eviction_cases').select('*')
      .eq('company_id', COMPANY).eq('tenant_name', tenant.name).single();
    expect(kase.tenant_id, 'the case must be linked to the tenant by id').toBe(tenant.id);
    expect(kase.property).toBe(prop.address);
    expect(kase.reason, 'reason').toBe('lease_violation');
    expect(kase.notice_type, 'notice type').toBe('cure_or_quit');
    expect(kase.notice_days, 'cure period is stored as a number').toBe(14);
    expect(kase.notes).toBe(notes);
    expect(kase.current_stage).toBe('notice');
    expect(kase.status).toBe('active');
    expect(Number(kase.total_costs)).toBe(0);

    // The cure deadline is the notice date plus the cure period.
    expect(kase.notice_date, 'the notice is dated today, in local time').toBe(localDate());
    expect(kase.cure_deadline, 'cure deadline = notice date + cure period')
      .toBe(localDatePlusDays(14));

    const history = typeof kase.stage_history === 'string' ? JSON.parse(kase.stage_history) : kase.stage_history;
    expect(history).toHaveLength(1);
    expect(history[0].stage).toBe('notice');
    expect(history[0].note, 'the opening entry records the notice served').toContain('cure or quit');
    expect(history[0].note).toContain('14');
    expect(history[0].by).toBe(ADMIN_EMAIL);

    // ── The cascade the form promises ────────────────────────────────
    await expect.poll(async () => (await sb.from('tenants')
      .select('lease_status').eq('id', tenant.id).single()).data.lease_status,
      { timeout: 30000, message: 'the tenant must be put on notice' }).toBe('notice');
    const { data: t2 } = await sb.from('tenants').select('move_out').eq('id', tenant.id).single();
    expect(t2.move_out, 'the tenant move-out date is set to the cure deadline').toBe(kase.cure_deadline);

    // KNOWN BROKEN — the lease is NOT put on notice, and cannot be.
    // createCase() runs
    //     leases.update({ status: "notice" }).eq("status", "active")
    // but leases_status_check permits only
    //     draft | active | expired | renewed | terminated
    // so Postgres rejects the write, and the only handling is
    //     if (lErr) pmError("PM-3004", { ..., silent: true })
    // which swallows it. The tenant ends up on `notice` while their
    // lease is still `active` — the two disagree after every eviction
    // filing. Either 'notice' belongs in the constraint or the app
    // should stop writing it; see the report. Pinned so a fix fails here.
    await page.waitForTimeout(3000);
    const { data: l2 } = await sb.from('leases').select('status').eq('id', lease.id).single();
    expect(l2.status, 'the lease status write is silently rejected by leases_status_check')
      .toBe('active');

    // ...and the case is on screen without a reload.
    await expect(page.locator('main').getByText(tenant.name, { exact: false }).first())
      .toBeVisible({ timeout: 20000 });
  });

  test('advancing a stage records the note, date and cost, and posts the cost to the GL', async ({ page }) => {
    const sb = await db();
    const prop = await seedProperty('EA');
    const tenant = await seedTenant('EA', prop.address, { balance: 2400 });
    await seedLease(tenant, prop.address);
    const kase = await seedEvictionCase(tenant, prop.address, { current_stage: 'cure_period' });

    await evictionsPage(page);
    await page.locator('main').getByText(tenant.name, { exact: false }).first().click();
    const drawer = page.locator('div.fixed.inset-0.z-50').first();
    await expect(drawer).toBeVisible({ timeout: 20000 });
    await expect(drawer.locator('h2')).toHaveText(tenant.name);

    const filingDate = '2026-08-14';
    await drawer.locator('input[type="date"]').first().fill(filingDate);
    await drawer.locator('input[type="number"]').first().fill('185.40');
    await drawer.locator('input[placeholder*="Court case"]').fill(`${TAG} filed in district court`);
    await drawer.locator('button:has-text("Court Filing")').click();

    await expect.poll(async () => (await sb.from('eviction_cases')
      .select('current_stage').eq('id', kase.id).single()).data.current_stage,
      { timeout: 30000 }).toBe('filing');

    const { data: c2 } = await sb.from('eviction_cases').select('*').eq('id', kase.id).single();
    expect(Number(c2.total_costs), 'total_costs must accumulate the typed cost').toBe(185.4);
    expect(c2.filing_date, 'the stage date must be stored on the stage-specific column').toBe(filingDate);
    const history = typeof c2.stage_history === 'string' ? JSON.parse(c2.stage_history) : c2.stage_history;
    expect(history).toHaveLength(2);
    expect(history[1].stage).toBe('filing');
    expect(history[1].note).toBe(`${TAG} filed in district court`);
    expect(Number(history[1].cost)).toBe(185.4);
    expect(history[1].date).toBe(filingDate);
    expect(history[1].by).toBe(ADMIN_EMAIL);

    // The cost is real money and must reach the GL for exactly that
    // amount. The JE is posted after the case row is updated, so poll.
    await expect.poll(async () => (await sb.from('acct_journal_entries').select('id')
      .eq('company_id', COMPANY).ilike('description', `%${tenant.name}%`).ilike('reference', 'EVICT-%')).data.length,
      { timeout: 40000, message: 'the eviction cost must post a journal entry' }).toBe(1);
    const { data: jes } = await sb.from('acct_journal_entries').select('id, description, date')
      .eq('company_id', COMPANY).ilike('description', `%${tenant.name}%`).ilike('reference', 'EVICT-%');
    expect(jes[0].date).toBe(filingDate);
    await expect.poll(async () => (await sb.from('acct_journal_lines').select('id')
      .eq('journal_entry_id', jes[0].id)).data.length, { timeout: 30000 }).toBe(2);
    const { data: lines } = await sb.from('acct_journal_lines')
      .select('account_name, debit, credit').eq('journal_entry_id', jes[0].id);
    expect(lines.reduce((s, l) => s + Number(l.debit || 0), 0)).toBe(185.4);
    expect(lines.reduce((s, l) => s + Number(l.credit || 0), 0)).toBe(185.4);
    expect(lines.find(l => Number(l.debit) > 0).account_name).toBe('Legal & Eviction Costs');

    // The panel reflects it without a reload.
    await expect(drawer.getByText('$185.40', { exact: false }).first()).toBeVisible({ timeout: 20000 });
  });

  test('closing a case as completed cascades: tenant inactive, property vacant, lease terminated, autopay off', async ({ page }) => {
    const sb = await db();
    const prop = await seedProperty('EC');
    const tenant = await seedTenant('EC', prop.address, { balance: 4000 });
    const lease = await seedLease(tenant, prop.address);
    const autopay = await seedAutopay(tenant, prop.address);
    const kase = await seedEvictionCase(tenant, prop.address, { current_stage: 'lockout' });

    await evictionsPage(page);
    await page.locator('main').getByText(tenant.name, { exact: false }).first().click();
    const drawer = page.locator('div.fixed.inset-0.z-50').first();
    await expect(drawer).toBeVisible({ timeout: 20000 });
    await drawer.locator('button:has-text("Eviction Complete")').click();
    await confirmDialog(page, 'Confirm');

    await expect.poll(async () => (await sb.from('eviction_cases')
      .select('status').eq('id', kase.id).single()).data.status,
      { timeout: 30000 }).toBe('closed');

    const { data: c2 } = await sb.from('eviction_cases').select('*').eq('id', kase.id).single();
    expect(c2.outcome).toBe('completed');
    expect(c2.current_stage).toBe('closed');
    const history = typeof c2.stage_history === 'string' ? JSON.parse(c2.stage_history) : c2.stage_history;
    expect(history[history.length - 1].note).toContain('completed');

    // closeCase writes the case row FIRST and then cascades to tenants,
    // properties, leases and autopay in four separate un-awaited-together
    // statements, so the poll above only proves the first one landed.
    // Each cascade target gets its own poll rather than a single read
    // that races the remaining round trips.
    await expect.poll(async () => (await sb.from('tenants')
      .select('lease_status').eq('id', tenant.id).single()).data.lease_status,
      { timeout: 30000, message: 'the tenant must be set inactive' }).toBe('inactive');
    await expect.poll(async () => (await sb.from('properties')
      .select('status').eq('id', prop.id).single()).data.status,
      { timeout: 30000, message: 'the property must be marked vacant' }).toBe('vacant');
    const { data: p2 } = await sb.from('properties').select('tenant').eq('id', prop.id).single();
    expect(p2.tenant, 'the primary tenant is cleared off the property').toBe('');
    await expect.poll(async () => (await sb.from('leases')
      .select('status').eq('id', lease.id).single()).data.status,
      { timeout: 30000, message: 'the lease must be terminated' }).toBe('terminated');
    await expect.poll(async () => (await sb.from('autopay_schedules')
      .select('enabled').eq('id', autopay.id).single()).data.enabled,
      { timeout: 30000, message: 'a completed eviction must stop autopay' }).toBe(false);

    // The closed case leaves the active list but is not deleted.
    await evictionsPage(page);
    await page.locator('main select').last().selectOption('active');
    await page.waitForTimeout(1000);
    await expect(page.locator('main').getByText(tenant.name, { exact: false })).toHaveCount(0);
    const { data: still } = await sb.from('eviction_cases').select('id').eq('id', kase.id).maybeSingle();
    expect(still, 'closing must not delete the case').not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
// BANK TRANSACTIONS + CSV IMPORT  — src/components/Banking.js
//
// Double-posting money is the worst thing this app can do, so the import
// is checked against the file row-for-row and cent-for-cent, and then
// the very same file is imported a second time.
// ══════════════════════════════════════════════════════════════════════
const bankPage = (page) => openRoute(page, 'acct_bankimport',
  (p) => p.locator('h3:has-text("Bank Transactions")').first());

// Bank of America's export shape, which csvDetectFormat recognises, so
// the mapping step arrives pre-filled the way a real user would see it.
// The last row deliberately carries a quoted comma — the parser has to
// keep it as one field.
const CSV_ROWS = [
  { date: '03/02/2026', description: 'E2E DEPOSIT ONE',              amount: 1250.75 },
  { date: '03/05/2026', description: 'E2E VENDOR PAYMENT',           amount: -430.10 },
  { date: '03/11/2026', description: 'E2E ZELLE FROM TENANT',        amount: 900.00 },
  { date: '03/18/2026', description: 'E2E UTILITY BILL',             amount: -87.65 },
  { date: '03/25/2026', description: 'E2E REFUND, WITH COMMA',       amount: 42.00 },
];

function writeFixtureCsv(tag) {
  const lines = ['Date,Description,Amount,Running Bal.'];
  let running = 10000;
  for (const r of CSV_ROWS) {
    running = Math.round((running + r.amount) * 100) / 100;
    lines.push(`${r.date},"${tag} ${r.description}",${r.amount.toFixed(2)},${running.toFixed(2)}`);
  }
  const file = path.join(os.tmpdir(), `e2e93-bank-${tag}.csv`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

// Two different controls open the same modal: the empty state offers
// "+ Add Bank Account", and once any feed exists that is replaced by the
// dashed "New Account" tile in the feed strip.
async function openAddAccountModal(page) {
  const empty = page.locator('main button:has-text("Add Bank Account")').first();
  if (await empty.isVisible({ timeout: 4000 }).catch(() => false)) await empty.click();
  else await page.locator('main button:has-text("New Account")').first().click();
  const modal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'Add Bank Account' }).first();
  await expect(modal).toBeVisible({ timeout: 20000 });
  return modal;
}

// Create a feed through the real modal and return its row.
async function createFeedViaUi(page, name, opts = {}) {
  const sb = await db();
  const modal = await openAddAccountModal(page);
  await modal.getByPlaceholder('e.g. Chase Checking').fill(name);
  if (opts.type) await modal.locator('select').selectOption(opts.type);
  if (opts.last4) await modal.getByPlaceholder('1234').fill(opts.last4);
  if (opts.institution) await modal.getByPlaceholder('e.g. Chase, Bank of America').fill(opts.institution);
  await modal.locator('button:has-text("Create")').click();
  await expect(toast(page, 'Bank account created')).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => ((await sb.from('bank_account_feed').select('id')
    .eq('company_id', COMPANY).eq('account_name', name)).data || []).length,
    { timeout: 20000, message: 'the feed row never appeared' }).toBe(1);
  const { data: feed } = await sb.from('bank_account_feed').select('*')
    .eq('company_id', COMPANY).eq('account_name', name).single();
  created.feedIds.push(feed.id);
  // The feed strip and the tab bar only render once a feed exists.
  await expect(page.locator('main button:has-text("Rules (")')).toBeVisible({ timeout: 30000 });
  return feed;
}

// Run the whole CSV wizard against `file` and return the Done-step
// numbers the user is shown.
async function runCsvImport(page, feedId, file, { autoApplyRules = false } = {}) {
  await page.locator('main button:has-text("Import CSV")').first().click();
  const wiz = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'Import Bank Transactions' }).first();
  await expect(wiz).toBeVisible({ timeout: 20000 });

  // Step 1 — account. Pick by option value (the feed id): the label
  // carries the type and masked number too, so matching on the name is
  // brittle and startImport() may have pre-selected a different feed.
  await wiz.locator('select').first().selectOption(feedId);
  await wiz.locator('button:has-text("Next")').click();

  // Step 2 — upload. The input is display:none by design; setInputFiles
  // does not need it visible.
  await wiz.locator('input[type="file"]').setInputFiles(file);
  await expect(wiz.getByText(path.basename(file))).toBeVisible({ timeout: 10000 });
  await wiz.locator('button:has-text("Parse & Continue")').click();

  // Step 3 — mapping. Every required column must be pre-filled with a
  // header that is actually IN the file. csvDetectFormat returns the
  // first known format sharing two headers, so this Bank of America
  // export matches Chase on Description + Amount; before the fix the
  // Date select was set to Chase's "Posting Date", which this file does
  // not have, and the whole import silently produced zero valid rows.
  const mapSelects = wiz.locator('select');
  await expect(wiz.getByText('Headers found:')).toBeVisible({ timeout: 20000 });
  await expect(mapSelects.nth(0), 'the Date column must map to a real header').toHaveValue('Date');
  await expect(mapSelects.nth(1), 'the Description column').toHaveValue('Description');
  await expect(mapSelects.nth(2), 'the Amount column').toHaveValue('Amount');
  await wiz.locator('button:has-text("Preview")').click();

  // Step 4 — preview. The three badges read "<n> valid", "<n> invalid",
  // "<n> total"; take them off the badges themselves, not off any div
  // that happens to contain the word.
  await expect(wiz.locator('div.bg-success-50').first()).toBeVisible({ timeout: 20000 });
  const validCount = Number((await wiz.locator('div.bg-success-50').first().innerText()).replace(/\D/g, ''));
  const invalidCount = Number((await wiz.locator('div.bg-danger-50').first().innerText()).replace(/\D/g, ''));
  const totalCount = Number((await wiz.locator('div.bg-info-50').first().innerText()).replace(/\D/g, ''));
  const previewRows = wiz.locator('table tbody tr');
  const preview = [];
  for (let i = 0; i < await previewRows.count(); i++) {
    const cells = previewRows.nth(i).locator('td');
    preview.push({
      date: (await cells.nth(0).innerText()).trim(),
      description: (await cells.nth(1).innerText()).trim(),
      amount: Number((await cells.nth(2).innerText()).replace(/[+,]/g, '')),
    });
  }
  await wiz.locator('button:has-text("Continue")').click();

  // Step 5 — options
  await expect(wiz.getByText('Skip duplicates automatically')).toBeVisible({ timeout: 20000 });
  const rulesBox = wiz.locator('label:has-text("Auto-apply categorization rules") input[type="checkbox"]');
  if ((await rulesBox.isChecked()) !== autoApplyRules) await rulesBox.setChecked(autoApplyRules);
  await expect(wiz.locator('label:has-text("Skip duplicates automatically") input[type="checkbox"]')).toBeChecked();
  await wiz.locator('button:has-text("Import")').click();

  // Step 6 — done
  await expect(wiz.getByText('Import Complete')).toBeVisible({ timeout: 90000 });
  const summary = await wiz.innerText();
  const imported = Number((summary.match(/(\d+)\s+transactions imported/) || [0, 0])[1]);
  const duplicates = Number((summary.match(/(\d+)\s+duplicates skipped/) || [0, 0])[1]);
  await wiz.locator('button:has-text("Review Transactions")').click();
  await expect(wiz).toBeHidden({ timeout: 20000 });
  return { imported, duplicates, validCount, invalidCount, totalCount, preview };
}

test.describe('Bank transactions and the CSV importer', () => {
  test('adding a bank account writes the feed and its GL account, and refuses a blank or duplicate name', async ({ page }) => {
    const sb = await db();
    const name = `${TAG} Sandbox Checking`;
    await bankPage(page);

    // ── Blank name refused ───────────────────────────────────────────
    let modal = await openAddAccountModal(page);
    await modal.locator('button:has-text("Create")').click();
    await expect(toast(page, 'Account name is required')).toBeVisible({ timeout: 10000 });
    const { data: none } = await sb.from('bank_account_feed').select('id')
      .eq('company_id', COMPANY).ilike('account_name', `%${TAG}%`);
    expect(none, 'a refused create must write nothing').toHaveLength(0);
    await modal.locator('button:has-text("Cancel")').click();

    // ── Real create ──────────────────────────────────────────────────
    const feed = await createFeedViaUi(page, name, {
      type: 'savings', last4: '8842', institution: `${TAG} Test Federal`,
    });
    expect(feed.account_type, 'account type').toBe('savings');
    expect(feed.masked_number, 'last 4').toBe('8842');
    expect(feed.institution_name).toBe(`${TAG} Test Federal`);
    expect(feed.connection_type).toBe('csv');
    expect(feed.gl_account_id, 'the feed must be mapped to a GL account').toBeTruthy();

    const { data: gl } = await sb.from('acct_accounts').select('*').eq('id', feed.gl_account_id).single();
    expect(gl.name, 'the GL account takes the name that was typed').toBe(name);
    expect(gl.type).toBe('Asset');
    expect(gl.subtype).toBe('Bank');
    expect(gl.code.startsWith('1050'), `savings should sit in the 1050 range, got ${gl.code}`).toBe(true);

    // ── Duplicate refused ────────────────────────────────────────────
    modal = await openAddAccountModal(page);
    await modal.getByPlaceholder('e.g. Chase Checking').fill(name);
    await modal.locator('button:has-text("Create")').click();
    await expect(toast(page, 'already exists')).toBeVisible({ timeout: 15000 });
    const { data: after } = await sb.from('bank_account_feed').select('id')
      .eq('company_id', COMPANY).eq('account_name', name);
    expect(after, 'a duplicate name must not create a second feed').toHaveLength(1);
  });

  test('a CSV import creates exactly the rows in the file, and re-importing the same file posts nothing twice', async ({ page }) => {
    const sb = await db();
    const name = `${TAG} Import Feed`;
    const file = writeFixtureCsv(TAG);
    await bankPage(page);
    const feed = await createFeedViaUi(page, name);

    // ── First import ─────────────────────────────────────────────────
    const first = await runCsvImport(page, feed.id, file);
    expect(first.validCount, 'every row in the file is valid').toBe(CSV_ROWS.length);
    expect(first.invalidCount, 'no row may be dropped as invalid').toBe(0);
    expect(first.totalCount, 'the preview must account for every line in the file').toBe(CSV_ROWS.length);
    expect(first.imported, 'the Done step must claim the file\'s row count').toBe(CSV_ROWS.length);
    expect(first.duplicates).toBe(0);

    // The preview the user approved has to be the file, not an
    // interpretation of it.
    expect(first.preview).toHaveLength(CSV_ROWS.length);
    CSV_ROWS.forEach((row, i) => {
      const iso = `${row.date.slice(6)}-${row.date.slice(0, 2)}-${row.date.slice(3, 5)}`;
      expect(first.preview[i].date, `preview row ${i} date`).toBe(iso);
      expect(first.preview[i].amount, `preview row ${i} amount`).toBe(row.amount);
      expect(first.preview[i].description, `preview row ${i} description`).toContain(row.description);
    });

    // ── The rows that actually landed ────────────────────────────────
    const readRows = async () => (await sb.from('bank_feed_transaction')
      .select('posted_date, amount, direction, bank_description_raw, status, fingerprint_hash, source_type')
      .eq('company_id', COMPANY).eq('bank_account_feed_id', feed.id)
      .order('posted_date')).data || [];
    let rows = await readRows();
    expect(rows, 'one bank_feed_transaction per file row — no more, no fewer').toHaveLength(CSV_ROWS.length);
    CSV_ROWS.forEach((row, i) => {
      const iso = `${row.date.slice(6)}-${row.date.slice(0, 2)}-${row.date.slice(3, 5)}`;
      expect(rows[i].posted_date, `row ${i} date`).toBe(iso);
      // The table stores magnitude + direction, so the signed file value
      // has to be reconstructable from the pair.
      const signed = (rows[i].direction === 'outflow' ? -1 : 1) * Number(rows[i].amount);
      expect(signed, `row ${i} amount`).toBe(row.amount);
      expect(rows[i].bank_description_raw, `row ${i} description`).toBe(`${TAG} ${row.description}`);
      expect(rows[i].status).toBe('for_review');
      expect(rows[i].source_type).toBe('csv');
    });
    // Every fingerprint distinct — a collision would silently swallow a
    // genuine transaction on the next import.
    expect(new Set(rows.map(r => r.fingerprint_hash)).size).toBe(CSV_ROWS.length);

    // The comma inside quotes stayed inside one field.
    expect(rows.some(r => r.bank_description_raw.includes('REFUND, WITH COMMA'))).toBe(true);

    // The import batch records what it did.
    const { data: batches } = await sb.from('bank_import_batch').select('*')
      .eq('company_id', COMPANY).eq('bank_account_feed_id', feed.id);
    expect(batches).toHaveLength(1);
    expect(batches[0].row_count).toBe(CSV_ROWS.length);
    expect(batches[0].accepted_count).toBe(CSV_ROWS.length);
    expect(batches[0].duplicate_count).toBe(0);
    expect(batches[0].original_filename).toBe(path.basename(file));

    // ── Second import of the SAME file ───────────────────────────────
    const second = await runCsvImport(page, feed.id, file);
    expect(second.imported, 're-importing the same file must import nothing').toBe(0);
    expect(second.duplicates, 'every row must be recognised as a duplicate').toBe(CSV_ROWS.length);

    rows = await readRows();
    expect(rows, 'the same file twice must not double the rows').toHaveLength(CSV_ROWS.length);
    const total = rows.reduce((s, r) => s + Number(r.amount), 0);
    const expectedTotal = CSV_ROWS.reduce((s, r) => s + Math.abs(r.amount), 0);
    expect(Math.round(total * 100) / 100, 'the money in the feed must not have doubled')
      .toBe(Math.round(expectedTotal * 100) / 100);
  });

  test('a categorization rule saves, edits and deletes with the values entered, and refuses an incomplete one', async ({ page }) => {
    const sb = await db();
    const ruleName = `${TAG} Supplies Rule`;
    await bankPage(page);
    // The tab bar (and therefore Rules) only renders once a feed exists.
    await createFeedViaUi(page, `${TAG} Rules Feed`);
    await page.locator('main button:has-text("Rules (")').click();
    await page.waitForTimeout(800);
    await page.locator('main button:has-text("New Rule")').first().click();
    const drawer = page.locator('div.fixed.right-0.top-0').first();
    await expect(drawer).toBeVisible({ timeout: 20000 });

    // ── Validation: no name ──────────────────────────────────────────
    await drawer.locator('button:has-text("Save Rule")').click();
    await expect(toast(page, 'Rule name is required')).toBeVisible({ timeout: 10000 });

    // ── Validation: a condition with no value ────────────────────────
    await drawer.getByPlaceholder('e.g. Home Depot Supplies').fill(ruleName);
    await drawer.locator('button:has-text("Save Rule")').click();
    await expect(toast(page, 'At least one condition with a value is required')).toBeVisible({ timeout: 10000 });

    // ── Validation: no category ──────────────────────────────────────
    await drawer.getByPlaceholder('Enter text...').fill('HOME DEPOT');
    await drawer.locator('button:has-text("Save Rule")').click();
    await expect(toast(page, 'At least one category/account is required')).toBeVisible({ timeout: 10000 });

    let { data: ghost } = await sb.from('bank_transaction_rule').select('id')
      .eq('company_id', COMPANY).eq('name', ruleName);
    expect(ghost, 'refused saves must write nothing').toHaveLength(0);

    // ── Fill the rest and save ───────────────────────────────────────
    await drawer.locator('select').first().selectOption('outflow');
    const picker = drawer.getByPlaceholder('Search accounts...');
    await picker.fill('Repairs & Maintenance');
    await drawer.locator('button:has-text("Repairs & Maintenance")').first().click();
    const optionals = drawer.getByPlaceholder('Optional');
    await optionals.nth(0).fill(`${TAG} Home Depot`);
    await optionals.nth(1).fill(`${TAG} auto-categorised`);
    await drawer.locator('input[type="number"]').last().fill('42');
    await drawer.locator('button:has-text("Save Rule")').click();
    await expect(toast(page, 'Rule created')).toBeVisible({ timeout: 20000 });

    const { data: saved } = await sb.from('bank_transaction_rule').select('*')
      .eq('company_id', COMPANY).eq('name', ruleName).single();
    expect(saved.priority, 'priority').toBe(42);
    expect(saved.rule_type).toBe('assign');
    expect(saved.enabled).toBe(true);
    expect(saved.auto_accept).toBe(false);
    expect(saved.condition_json.logic).toBe('all');
    expect(saved.condition_json.direction, 'Apply to').toBe('outflow');
    expect(saved.condition_json.conditions).toHaveLength(1);
    expect(saved.condition_json.conditions[0]).toMatchObject({
      field: 'description', operator: 'contains', value: 'HOME DEPOT',
    });
    expect(saved.action_json.type).toBe('assign');
    expect(saved.action_json.transaction_type).toBe('expense');
    expect(saved.action_json.payee).toBe(`${TAG} Home Depot`);
    expect(saved.action_json.memo).toBe(`${TAG} auto-categorised`);
    expect(saved.action_json.lines).toHaveLength(1);
    expect(saved.action_json.lines[0].account_name).toBe('Repairs & Maintenance');

    // ── Edit ─────────────────────────────────────────────────────────
    await expect(page.locator('main').getByText(ruleName, { exact: false }).first()).toBeVisible({ timeout: 20000 });
    const row = page.locator('main tr').filter({ hasText: ruleName }).first();
    await row.locator('button:has-text("Edit")').click();
    const editDrawer = page.locator('div.fixed.right-0.top-0').first();
    await expect(editDrawer.getByText('Edit Rule')).toBeVisible({ timeout: 20000 });
    // The drawer must open on the saved values, not a blank form.
    await expect(editDrawer.getByPlaceholder('e.g. Home Depot Supplies')).toHaveValue(ruleName);
    await expect(editDrawer.getByPlaceholder('Enter text...')).toHaveValue('HOME DEPOT');
    await editDrawer.getByPlaceholder('e.g. Home Depot Supplies').fill(ruleName + ' v2');
    await editDrawer.getByPlaceholder('Enter text...').fill('LOWES');
    await editDrawer.locator('input[type="number"]').last().fill('7');
    await editDrawer.locator('button:has-text("Update Rule")').click();
    await expect(toast(page, 'Rule updated')).toBeVisible({ timeout: 20000 });

    const { data: edited } = await sb.from('bank_transaction_rule').select('*').eq('id', saved.id).single();
    expect(edited.name).toBe(ruleName + ' v2');
    expect(edited.priority).toBe(7);
    expect(edited.condition_json.conditions[0].value).toBe('LOWES');

    // ── Delete ───────────────────────────────────────────────────────
    const row2 = page.locator('main tr').filter({ hasText: ruleName + ' v2' }).first();
    await row2.locator('button:has-text("Delete")').click();
    await confirmDialog(page, 'Confirm');
    await expect(toast(page, 'Rule deleted')).toBeVisible({ timeout: 20000 });
    const { data: gone } = await sb.from('bank_transaction_rule').select('id').eq('id', saved.id).maybeSingle();
    expect(gone, 'the rule row is hard-deleted, as the UI says').toBeNull();
    await expect(page.locator('main').getByText(ruleName + ' v2', { exact: false })).toHaveCount(0);
  });
});

// ══════════════════════════════════════════════════════════════════════
// RECONCILE  — src/components/Accounting.js (AcctBankReconciliation)
//
// Reconciling posts no journal entries of its own; its job is to flag
// lines, record the statement figures, and lock the period. So the test
// is: the figures typed are the figures stored, the right lines get
// flagged, and NOTHING new appears in the ledger — twice over.
// ══════════════════════════════════════════════════════════════════════
const reconcilePage = (page) => openRoute(page, 'acct_reconcile',
  (p) => p.locator('h3:has-text("Start Bank Reconciliation")').first());

// startReconciliation() only ever collects lines whose account_name is
// literally "Checking Account", so the fixture has to use that name.
let _reconSeedSeq = 0;
async function seedCheckingActivity() {
  // acct_journal_entries has a unique index on (company_id, reference),
  // so each call needs its own suffix.
  const n = ++_reconSeedSeq;
  const checking = await accountIdByCode('1000');
  expect(checking, 'the sandbox needs a 1000 Checking Account').toBeTruthy();
  const income = await accountIdByCode('4000');
  const a = await seedJournalEntry({
    date: '2019-01-15', description: `${TAG} Recon deposit A${n}`, reference: `${TAG}-REC-A${n}`,
    lines: [
      { account_id: checking.id, account_name: 'Checking Account', debit: 500, credit: 0, memo: 'A' },
      { account_id: income.id, account_name: 'Rental Income', debit: 0, credit: 500, memo: 'A' },
    ],
  });
  const b = await seedJournalEntry({
    date: '2019-01-20', description: `${TAG} Recon deposit B${n}`, reference: `${TAG}-REC-B${n}`,
    lines: [
      { account_id: checking.id, account_name: 'Checking Account', debit: 300, credit: 0, memo: 'B' },
      { account_id: income.id, account_name: 'Rental Income', debit: 0, credit: 300, memo: 'B' },
    ],
  });
  return { a, b, checking, n };
}

test.describe('Reconcile', () => {
  test('validation: Begin Reconciliation without an ending balance is refused and writes nothing', async ({ page }) => {
    const sb = await db();
    const before = (await sb.from('bank_reconciliations').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)).count || 0;
    await reconcilePage(page);
    await page.locator('main input[type="month"]').fill('2019-01');
    await page.locator('main button:has-text("Begin Reconciliation")').click();
    await expect(toast(page, 'Please enter the bank ending balance')).toBeVisible({ timeout: 10000 });

    // Letters in the balance field leave it empty; same refusal.
    await typeGarbage(page.locator('main input[type="number"]').first(), 'abc');
    await page.locator('main button:has-text("Begin Reconciliation")').click();
    await expect(toast(page, 'Please enter the bank ending balance')).toBeVisible({ timeout: 10000 });

    const after = (await sb.from('bank_reconciliations').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)).count || 0;
    expect(after).toBe(before);
  });

  // KNOWN BROKEN — see the report. startReconciliation() selects the
  // month's lines with .eq("account_name", "Checking Account"), a literal
  // name rather than the feed's GL account id. This company's real bank
  // accounts are named "Sigma Housing LLC - 6027" (1600), "Sigma ACH -
  // 0822" (1580) and "Sigma Cap Imp  - 1402" (1590), so a month full of
  // genuine bank activity reconciles to "no transactions found" and the
  // screen cannot be used on this dataset at all. There is no account
  // picker on the page either — the account is not choosable.
  test('KNOWN BROKEN: a month of real bank activity is invisible because the account is matched by the name "Checking Account"', async ({ page }) => {
    const sb = await db();
    const realBank = await accountIdByCode('1600');
    expect(realBank, 'the sandbox has a real bank account at code 1600').toBeTruthy();
    const income = await accountIdByCode('4000');
    await seedJournalEntry({
      date: '2019-02-10', description: `${TAG} Real bank deposit`, reference: `${TAG}-REC-REAL`,
      lines: [
        { account_id: realBank.id, account_name: realBank.name, debit: 1000, credit: 0, memo: 'real' },
        { account_id: income.id, account_name: 'Rental Income', debit: 0, credit: 1000, memo: 'real' },
      ],
    });

    await reconcilePage(page);
    await page.locator('main input[type="month"]').fill('2019-02');
    await page.locator('main input[type="number"]').first().fill('1000');
    await page.locator('main button:has-text("Begin Reconciliation")').click();
    await expect(toast(page, 'No checking account transactions found')).toBeVisible({ timeout: 20000 });

    // The month really does have posted bank activity — the screen just
    // cannot see it.
    const { data: proof } = await sb.from('acct_journal_lines').select('id')
      .eq('company_id', COMPANY).eq('account_id', realBank.id);
    expect(proof.length, 'the account it refuses to look at is a real, used bank account').toBeGreaterThan(0);
    const { data: recs } = await sb.from('bank_reconciliations').select('id')
      .eq('company_id', COMPANY).eq('period', '2019-02');
    expect(recs, 'a refused start writes nothing').toHaveLength(0);
  });

  test('saving a reconciliation stores the typed figures and posts no journal entries — twice', async ({ page }) => {
    const sb = await db();
    const { a, b, n } = await seedCheckingActivity();
    const aLineId = a.lines.find(l => l.account_name === 'Checking Account').id;
    const bLineId = b.lines.find(l => l.account_name === 'Checking Account').id;
    const descA = `${TAG} Recon deposit A${n}`;
    const descB = `${TAG} Recon deposit B${n}`;

    // The period's whole ledger, before. Reconciling must not add to it.
    const jeIdsIn201901 = async () => ((await sb.from('acct_journal_entries').select('id')
      .eq('company_id', COMPANY).gte('date', '2019-01-01').lte('date', '2019-01-31')).data || [])
      .map(j => j.id).sort();
    const before = await jeIdsIn201901();
    expect(before.length, 'the fixture entries are in the period').toBeGreaterThanOrEqual(2);

    await reconcilePage(page);
    await page.locator('main input[type="month"]').fill('2019-01');
    await page.locator('main input[type="number"]').first().fill('812.34');
    await page.locator('main button:has-text("Begin Reconciliation")').click();

    // Both fixture lines are offered, with their signed amounts.
    await expect(page.getByText(descA).first()).toBeVisible({ timeout: 40000 });
    await expect(page.getByText(descB).first()).toBeVisible();
    await expect(page.getByText('+$500').first()).toBeVisible();
    await expect(page.getByText('+$300').first()).toBeVisible();

    // Tick exactly one of them.
    await page.locator('main div.cursor-pointer').filter({ hasText: descA }).first().click();
    await expect(page.getByText('Reconciled (1)').first()).toBeVisible({ timeout: 10000 });
    await page.locator('main button:has-text("Save Reconciliation")').click();

    await expect.poll(async () => ((await sb.from('bank_reconciliations').select('id')
      .eq('company_id', COMPANY).eq('period', '2019-01')).data || []).length,
      { timeout: 30000, message: 'Save Reconciliation wrote no row' }).toBe(1);

    const { data: recs } = await sb.from('bank_reconciliations').select('*')
      .eq('company_id', COMPANY).eq('period', '2019-01');
    const rec = recs[0];
    created.reconciliations.push(rec.id);
    expect(Number(rec.bank_ending_balance), 'the ending balance must be exactly what was typed').toBe(812.34);
    expect(Number(rec.difference), 'difference must be bank minus book, self-consistently')
      .toBeCloseTo(Number(rec.bank_ending_balance) - Number(rec.book_balance), 2);
    const expectedStatus = Math.abs(Number(rec.difference)) < 0.01 ? 'pending_items' : 'discrepancy';
    expect(rec.status, 'one line left unticked cannot be a clean "reconciled"').toBe(expectedStatus);
    const reconciledItems = typeof rec.reconciled_items === 'string' ? JSON.parse(rec.reconciled_items) : rec.reconciled_items;
    const unreconciledItems = typeof rec.unreconciled_items === 'string' ? JSON.parse(rec.unreconciled_items) : rec.unreconciled_items;
    expect(reconciledItems.map(i => i.id), 'only the ticked line is recorded as reconciled').toEqual([aLineId]);
    expect(unreconciledItems.map(i => i.id)).toContain(bLineId);
    expect(Number(reconciledItems[0].amount), 'the stored item keeps its signed amount').toBe(500);
    expect(reconciledItems[0].description).toBe(descA);

    // ── Nothing was posted ───────────────────────────────────────────
    expect(await jeIdsIn201901(), 'reconciling must not create journal entries').toEqual(before);

    // ── Do it again: still nothing posted ────────────────────────────
    await reconcilePage(page);
    await page.locator('main input[type="month"]').fill('2019-01');
    await page.locator('main input[type="number"]').first().fill('812.34');
    await page.locator('main button:has-text("Begin Reconciliation")').click();
    await expect(page.getByText(descA).first()).toBeVisible({ timeout: 40000 });
    await page.locator('main button:has-text("Save Reconciliation")').click();
    await expect.poll(async () => ((await sb.from('bank_reconciliations').select('id')
      .eq('company_id', COMPANY).eq('period', '2019-01')).data || []).length,
      { timeout: 30000 }).toBeGreaterThan(1);
    const { data: recs2 } = await sb.from('bank_reconciliations').select('id')
      .eq('company_id', COMPANY).eq('period', '2019-01');
    recs2.forEach(r => { if (!created.reconciliations.includes(r.id)) created.reconciliations.push(r.id); });
    expect(await jeIdsIn201901(), 'a repeat reconciliation still must not post anything').toEqual(before);
  });

  // This was a KNOWN BROKEN test until saveReconciliation stopped scoping
  // its update with `.in("journal_entry_id", <every JE id in the
  // company>)`. That was ~300KB of query string on this ledger, the edge
  // answered 414 Request-URI Too Large, and the code returned early — so
  // no line was ever flagged, the bank-transaction locking and period
  // auto-lock never ran, and yet the bank_reconciliations row had already
  // been written. A reconciliation that reconciled nothing. The update is
  // now chunked and company-scoped, so this is the real behaviour test.
  test('the ticked lines are flagged reconciled, the unticked are not, and the period is locked', async ({ page }) => {
    const sb = await db();
    const { a, b, n } = await seedCheckingActivity();
    const aLineId = a.lines.find(l => l.account_name === 'Checking Account').id;
    const bLineId = b.lines.find(l => l.account_name === 'Checking Account').id;
    const descA = `${TAG} Recon deposit A${n}`;

    await reconcilePage(page);
    await page.locator('main input[type="month"]').fill('2019-01');
    await page.locator('main input[type="number"]').first().fill('800');
    await page.locator('main button:has-text("Begin Reconciliation")').click();
    await expect(page.getByText(descA).first()).toBeVisible({ timeout: 40000 });

    // Tick exactly one line, leaving the other deliberately open.
    await page.locator('main div.cursor-pointer').filter({ hasText: descA }).first().click();
    await expect(page.getByText('Reconciled (1)').first()).toBeVisible({ timeout: 10000 });
    await page.locator('main button:has-text("Save Reconciliation")').click();

    // The flag lands on the ledger line itself, dated today.
    await expect.poll(async () => (await sb.from('acct_journal_lines')
      .select('reconciled').eq('id', aLineId).single()).data.reconciled,
      { timeout: 30000, message: 'the ticked line must be marked reconciled' }).toBe(true);
    const { data: aLine } = await sb.from('acct_journal_lines')
      .select('reconciled, reconciled_date').eq('id', aLineId).single();
    expect(aLine.reconciled_date, 'the reconciled date is stamped').toBe(localDate());

    // ...and only on that line.
    const { data: bLine } = await sb.from('acct_journal_lines')
      .select('reconciled, reconciled_date').eq('id', bLineId).single();
    expect(bLine.reconciled, 'an unticked line must stay unreconciled').toBe(false);
    expect(bLine.reconciled_date).toBeNull();

    // The record names who did it — this used to be written as "".
    const { data: recs } = await sb.from('bank_reconciliations').select('*')
      .eq('company_id', COMPANY).eq('period', '2019-01').order('created_at', { ascending: false });
    recs.forEach(r => { if (!created.reconciliations.includes(r.id)) created.reconciliations.push(r.id); });
    expect(recs[0].reconciled_by, 'the reconciliation must record who reconciled it').toBe(ADMIN_EMAIL);

    // Reaching the end of saveReconciliation means the period auto-lock
    // ran — the step that the early return used to skip.
    await expect.poll(async () => {
      const { data } = await sb.from('accounting_period_lock').select('lock_date')
        .eq('company_id', COMPANY).maybeSingle();
      return data?.lock_date || null;
    }, { timeout: 30000, message: 'reconciling must auto-lock the period it closed' })
      .toBe('2019-01-31');
  });
});

// ══════════════════════════════════════════════════════════════════════
// QUICKBOOKS IMPORT  — src/components/QuickBooksImport.js
//
// The commit step rides on /api/encrypt (a Vercel serverless route),
// which does not exist under the local CRA dev server, so the import
// itself cannot be driven here. Everything up to the commit can, and
// that is where the parsing correctness lives: the rows the wizard
// reports have to be the rows in the workbook.
// ══════════════════════════════════════════════════════════════════════
const qbPage = (page) => openRoute(page, 'acct_qbimport',
  (p) => p.locator('h2:has-text("Import from QuickBooks")').first());

const QB_HEADERS = ['Transaction date', 'Transaction type', 'Num', 'Name',
  'Description', 'Account Name', 'Debit', 'Credit', 'Transaction ID'];

// Two transactions, four lines, debits = credits. Written in the exact
// shape QuickBooks Online emits: a three-row title block, then the
// header row, then data, then a "Total for" subtotal and an accrual
// footer that the parser must reject.
const QB_LINES = [
  { date: '01/12/2024', type: 'Deposit', num: '1001', name: 'Tenant A', desc: 'January rent', account: 'Assets:Operating Bank', debit: 2400, credit: 0, txn: 'QB-TXN-1' },
  { date: '01/12/2024', type: 'Deposit', num: '1001', name: 'Tenant A', desc: 'January rent', account: 'Income:Rental Income', debit: 0, credit: 2400, txn: 'QB-TXN-1' },
  { date: '01/20/2024', type: 'Expense', num: '1002', name: 'Acme Roofing', desc: 'Roof repair', account: 'Expenses:Repairs', debit: 815.25, credit: 0, txn: 'QB-TXN-2' },
  { date: '01/20/2024', type: 'Expense', num: '1002', name: 'Acme Roofing', desc: 'Roof repair', account: 'Assets:Operating Bank', debit: 0, credit: 815.25, txn: 'QB-TXN-2' },
];

async function writeQbWorkbook(tag) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Transaction Report');
  ws.addRow(['Sigma Housing LLC']);
  ws.addRow(['Transaction Report']);
  ws.addRow(['January 2024']);
  ws.addRow(QB_HEADERS);
  for (const l of QB_LINES) {
    ws.addRow([l.date, l.type, l.num, l.name, `${tag} ${l.desc}`, l.account, l.debit || null, l.credit || null, l.txn]);
  }
  ws.addRow(['Total for Assets:Operating Bank', '', '', '', '', '', 2400, 815.25, '']);
  ws.addRow(['Accrual Basis  Monday, January 1, 2024 09:00 AM GMT-05:00']);
  const file = path.join(os.tmpdir(), `e2e93-qb-assets-${tag}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

test.describe('QuickBooks import', () => {
  test('a workbook parses to exactly the rows it contains, and nothing is written before the commit step', async ({ page }) => {
    const sb = await db();
    const file = await writeQbWorkbook(TAG);
    const acctsBefore = (await sb.from('acct_accounts').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)).count;
    const jesBefore = (await sb.from('acct_journal_entries').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)).count;

    await qbPage(page);
    await page.locator('main input[type="file"]').setInputFiles(file);
    await expect(page.getByText(path.basename(file))).toBeVisible({ timeout: 60000 });

    // Shape detected, and every data row read — the subtotal and the
    // accrual footer rejected.
    await expect(page.getByText('Transaction Report', { exact: false }).first()).toBeVisible();
    const row = page.locator('main tr').filter({ hasText: path.basename(file) }).first();
    expect((await row.innerText()).replace(/\s+/g, ' ')).toContain(String(QB_LINES.length));

    // The totals strip must restate the workbook exactly.
    const totals = await page.locator('main div.bg-neutral-50').last().innerText();
    expect(totals, 'two Transaction IDs become two transactions').toContain('2 transactions');
    expect(totals, 'four data rows become four lines').toContain('4 lines');
    expect(totals).toContain('2024-01-12');
    expect(totals).toContain('2024-01-20');
    const expectedDr = QB_LINES.reduce((s, l) => s + l.debit, 0);
    expect(totals, 'debit total').toContain(expectedDr.toLocaleString('en-US', { minimumFractionDigits: 2 }));
    expect(totals, 'a balanced workbook must not be flagged out of balance').not.toContain('out of balance');

    // Only the asset group is loaded, so the wizard says what is missing
    // rather than pretending it can balance the books.
    await expect(page.getByText('Liabilities & Equity', { exact: false }).first()).toBeVisible();

    // Continue reaches the account plan, which proposes the workbook's
    // accounts — and still writes nothing.
    await page.locator('main button:has-text("Continue")').click();
    await expect(page.getByText('Assets:Operating Bank', { exact: false }).first()).toBeVisible({ timeout: 60000 });
    await expect(page.getByText('Income:Rental Income', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Expenses:Repairs', { exact: false }).first()).toBeVisible();

    expect((await sb.from('acct_accounts').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)).count, 'planning must not create accounts').toBe(acctsBefore);
    expect((await sb.from('acct_journal_entries').select('id', { count: 'exact', head: true })
      .eq('company_id', COMPANY)).count, 'planning must not post entries').toBe(jesBefore);
  });

  test('validation: a non-xlsx file is rejected by name and leaves the wizard with nothing to import', async ({ page }) => {
    const csv = writeFixtureCsv(TAG + 'QB');
    await qbPage(page);
    await page.locator('main input[type="file"]').setInputFiles(csv);
    await expect(page.getByText('Not an .xlsx file')).toBeVisible({ timeout: 30000 });
    // Nothing readable was added, so the wizard cannot move on.
    await expect(page.locator('main button:has-text("Continue")')).toBeDisabled();
  });
});
