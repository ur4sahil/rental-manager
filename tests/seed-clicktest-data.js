// ════════════════════════════════════════════════════════════════════
// Click-coverage E2E seed — Smith Properties LLC
//
// Mirrors the "tagged feed" cleanup pattern from bank-recon-stress.test.js:
// every row inserted by this script carries the CLICKTEST tag in a free-text
// column (notes / description / memo / account_name) so cleanup is one
// DELETE per related table.
//
// Usage:
//   cd tests && node seed-clicktest-data.js              # idempotent seed
//   cd tests && node seed-clicktest-data.js --cleanup    # rollback
//
// The corresponding click-coverage specs (tests/e2e/50-..66-..*.spec.js)
// log in to Smith Properties LLC and exercise every visible button.
// ════════════════════════════════════════════════════════════════════
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in tests/.env');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ── Constants ─────────────────────────────────────────────────────
const COMPANY_ID = 'dce4974d-afa9-4e65-afdf-1189b815195d'; // Smith Properties LLC
const TAG = 'CLICKTEST';                  // free-text marker on every row
const EMAIL_TAG = 'clicktest+';           // prefix on synthetic emails
const ID_PREFIX = 'CT-';                  // prefix on string ids we control

const TEST_EMAIL = process.env.TEST_EMAIL || 'admin@propmanager.com';

// Portal test users — separate auth identities so 64/65 specs can
// log in as the tenant/owner role and exercise tenant_portal /
// owner_portal. Passwords are deterministic; tests/.env can override
// (CLICK_TENANT_PASSWORD / CLICK_OWNER_PASSWORD) for prod-style runs.
const PORTAL_PASSWORD = process.env.CLICK_PORTAL_PASSWORD || 'ClickTest!2026';
const TENANT_TEST_EMAIL = 'clicktest-tenant@propmanager.com';
const OWNER_TEST_EMAIL  = 'clicktest-owner@propmanager.com';

// Deterministic addresses → reruns hit the same rows
const PROPS = [
  { address: '101 Click Test Way',     type: 'Single Family', status: 'occupied' },
  { address: '102 Click Test Way',     type: 'Apartment',     status: 'occupied' },
  { address: '103 Click Test Way',     type: 'Townhouse',     status: 'occupied' },
  { address: '104 Click Test Way',     type: 'Condo',         status: 'occupied' },
  { address: '201 Click Test Vacant',  type: 'Single Family', status: 'vacant'   },
  { address: '202 Click Test Vacant',  type: 'Apartment',     status: 'vacant'   },
  { address: '301 Click Test Archive', type: 'Single Family', status: 'archived' },
  { address: '401 Click Test Setup',   type: 'Single Family', status: 'in_setup' },
];

const TENANTS = [
  { name: 'CT Active Alice',   email: EMAIL_TAG + 'alice@test.com',   propIdx: 0, balance: 0,    lease_status: 'active'   },
  { name: 'CT Active Bob',     email: EMAIL_TAG + 'bob@test.com',     propIdx: 1, balance: 0,    lease_status: 'active'   },
  { name: 'CT Active Carol',   email: EMAIL_TAG + 'carol@test.com',   propIdx: 2, balance: 0,    lease_status: 'active'   },
  { name: 'CT Active Dave',    email: EMAIL_TAG + 'dave@test.com',    propIdx: 3, balance: 0,    lease_status: 'active'   },
  { name: 'CT Past-Due Erin',  email: EMAIL_TAG + 'erin@test.com',    propIdx: 0, balance: 1500, lease_status: 'active'   },
  { name: 'CT Inactive Frank', email: EMAIL_TAG + 'frank@test.com',   propIdx: 4, balance: 0,    lease_status: 'inactive' },
  { name: 'CT Archived Gina',  email: EMAIL_TAG + 'gina@test.com',    propIdx: 6, balance: 0,    lease_status: 'archived' },
  { name: 'CT DocPending Hal', email: EMAIL_TAG + 'hal@test.com',     propIdx: 1, balance: 0,    lease_status: 'active'   },
];

// ── Logging helpers ──────────────────────────────────────────────
const errors = [];
function logErr(phase, msg, raw) {
  errors.push({ phase, msg, raw: raw?.message || raw });
  console.log(`  ❌ [${phase}] ${msg}${raw ? ' — ' + (raw.message || raw) : ''}`);
}
function logOk(msg) { console.log(`  ✓ ${msg}`); }
function header(label) { console.log(`\n━━ ${label} ━━`); }

// ── Cleanup ──────────────────────────────────────────────────────
// Helper: tolerate tables that don't exist in some envs (legacy schemas,
// new migrations). Supabase JS v2's PostgrestBuilder is thenable but not
// a real Promise, so chained .catch() throws — wrap with try/await.
async function tryDelete(label, builderFn) {
  try { await builderFn(); }
  catch (e) { /* ignore */ }
}

async function cleanup() {
  header('CLEANUP — removing CLICKTEST rows from Smith Properties');

  // tenants has no notes column — match by the seeded email prefix.
  const { data: ctTenants } = await sb.from('tenants').select('id, name, email')
    .eq('company_id', COMPANY_ID).ilike('email', EMAIL_TAG + '%');
  const tenantIds = (ctTenants || []).map(t => t.id);

  const { data: ctProps } = await sb.from('properties').select('id, address')
    .eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%');
  const propIds = (ctProps || []).map(p => p.id);

  // 1. Bank/JE artefacts (children first)
  const { data: ctJEs } = await sb.from('acct_journal_entries').select('id')
    .eq('company_id', COMPANY_ID).ilike('description', '%' + TAG + '%');
  const jeIds = (ctJEs || []).map(j => j.id);
  if (jeIds.length) {
    await sb.from('acct_journal_lines').delete().in('journal_entry_id', jeIds);
    await sb.from('acct_journal_entries').delete().in('id', jeIds);
    logOk(`removed ${jeIds.length} journal entries + lines`);
  }
  await tryDelete('recurring_journal_entries', () =>
    sb.from('recurring_journal_entries').delete().eq('company_id', COMPANY_ID).ilike('description', '%' + TAG + '%'));

  // 2. Payments / autopay / late fees — payments has no notes column;
  // dedup by tenant-name prefix, which every seeded row starts with.
  await tryDelete('payments', () =>
    sb.from('payments').delete().eq('company_id', COMPANY_ID).ilike('tenant', 'CT %'));
  if (tenantIds.length) {
    await tryDelete('autopay_schedules', () =>
      sb.from('autopay_schedules').delete().eq('company_id', COMPANY_ID).in('tenant_id', tenantIds));
    await tryDelete('late_fees_applied', () =>
      sb.from('late_fees_applied').delete().eq('company_id', COMPANY_ID).in('tenant_id', tenantIds));
  }
  await tryDelete('late_fee_rules', () =>
    sb.from('late_fee_rules').delete().eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%'));

  // 3. Maintenance / inspections / vendors
  await tryDelete('work_orders', () =>
    sb.from('work_orders').delete().eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%'));
  await tryDelete('inspections', () =>
    sb.from('inspections').delete().eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%'));
  await tryDelete('vendors', () =>
    sb.from('vendors').delete().eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%'));

  // 4. Property children
  for (const t of ['utilities', 'hoa_payments', 'loans', 'insurance_policies', 'property_tax_bills']) {
    await tryDelete(t, () =>
      sb.from(t).delete().eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%'));
  }

  // 5. Leases / docs
  if (tenantIds.length) {
    await tryDelete('lease_signatures', () =>
      sb.from('lease_signatures').delete().eq('company_id', COMPANY_ID).in('tenant_id', tenantIds));
  }
  await tryDelete('leases', () =>
    sb.from('leases').delete().eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%'));
  await tryDelete('lease_templates', () =>
    sb.from('lease_templates').delete().eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%'));
  await tryDelete('documents', () =>
    sb.from('documents').delete().eq('company_id', COMPANY_ID).ilike('description', '%' + TAG + '%'));

  // 6. Owners + statements
  await tryDelete('owner_distributions', () =>
    sb.from('owner_distributions').delete().eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%'));
  await tryDelete('owner_statements', () =>
    sb.from('owner_statements').delete().eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%'));
  await tryDelete('owners', () =>
    sb.from('owners').delete().eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%'));

  // 7. Messages / notifications / tasks / approvals
  await tryDelete('messages', () =>
    sb.from('messages').delete().eq('company_id', COMPANY_ID).ilike('body', '%' + TAG + '%'));
  await tryDelete('tasks', () =>
    sb.from('tasks').delete().eq('company_id', COMPANY_ID).ilike('title', '%' + TAG + '%'));
  await tryDelete('manager_approvals', () =>
    sb.from('manager_approvals').delete().eq('company_id', COMPANY_ID).ilike('description', '%' + TAG + '%'));
  await tryDelete('doc_exception_requests', () =>
    sb.from('doc_exception_requests').delete().eq('company_id', COMPANY_ID).ilike('reason', '%' + TAG + '%'));
  await tryDelete('wizard_skipped_approvals', () =>
    sb.from('wizard_skipped_approvals').delete().eq('company_id', COMPANY_ID).ilike('section_label', '%' + TAG + '%'));

  // 7b. Portal-user tenants/owners (separate from CT-tagged ones)
  await tryDelete('tenants-portal', () =>
    sb.from('tenants').delete().eq('company_id', COMPANY_ID).ilike('email', TENANT_TEST_EMAIL));
  await tryDelete('owners-portal', () =>
    sb.from('owners').delete().eq('company_id', COMPANY_ID).ilike('email', OWNER_TEST_EMAIL));
  // Memberships for portal users — also clear so the auth user isn't
  // tied to Smith on next seed run (will be reattached idempotently).
  await tryDelete('company_members-portal', () =>
    sb.from('company_members').delete().eq('company_id', COMPANY_ID)
      .or(`user_email.ilike.${TENANT_TEST_EMAIL},user_email.ilike.${OWNER_TEST_EMAIL}`));

  // 8. Tenants → Properties
  if (tenantIds.length) {
    await sb.from('tenants').delete().in('id', tenantIds);
    logOk(`removed ${tenantIds.length} tenants`);
  }
  if (propIds.length) {
    await sb.from('properties').delete().in('id', propIds);
    logOk(`removed ${propIds.length} properties`);
  }

  // 9. Accounting classes / accounts (only the ones we tagged)
  await sb.from('acct_classes').delete().eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%');
  await sb.from('acct_accounts').delete().eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%');

  // 10. Membership flip stays — flipping back to 'removed' would lock us
  //     out of re-running the seed. Use --cleanup-membership to also
  //     reset the test user's role at Smith.
  if (process.argv.includes('--cleanup-membership')) {
    await sb.from('company_members').update({ status: 'removed' })
      .eq('company_id', COMPANY_ID).ilike('user_email', TEST_EMAIL);
    logOk('reset test user membership to removed');
  }

  console.log('\n✅ Cleanup complete. ' + errors.length + ' soft errors logged.');
}

// ── Membership: ensure TEST_EMAIL is admin/active at Smith Properties ──
async function ensureMembership() {
  header('Step 0 — membership for ' + TEST_EMAIL);

  // app_users row first (foreign-key target)
  try {
    await sb.from('app_users').upsert({ email: TEST_EMAIL.toLowerCase() }, { onConflict: 'email' });
  } catch { /* table may be empty/legacy on some envs — ignore */ }

  // Flip company_members → admin/active. Critical: also CLEAR
  // custom_pages — App.js:929 uses customAllowedPages OVER the role
  // default when present, so a stale per-user page list (e.g. one
  // missing "owners" / "latefees" / accounting sub-pages) silently
  // routes those pages back to dashboard. Setting custom_pages=NULL
  // lets the admin role's full list apply.
  const { data: existing } = await sb.from('company_members').select('id, role, status, custom_pages')
    .eq('company_id', COMPANY_ID).ilike('user_email', TEST_EMAIL).maybeSingle();
  const updates = { role: 'admin', status: 'active', custom_pages: null };
  if (existing) {
    const needsUpdate = existing.role !== 'admin' || existing.status !== 'active' || existing.custom_pages !== null;
    if (needsUpdate) {
      const { error } = await sb.from('company_members').update(updates).eq('id', existing.id);
      if (error) return logErr('membership', 'failed to set admin/active/full-pages', error);
      logOk(`flipped existing membership ${existing.id} → admin/active + cleared custom_pages`);
    } else {
      logOk('membership already admin/active with role-default pages');
    }
  } else {
    const { error } = await sb.from('company_members').insert({
      company_id: COMPANY_ID,
      user_email: TEST_EMAIL.toLowerCase(),
      ...updates,
    });
    if (error) return logErr('membership', 'failed to insert', error);
    logOk('inserted admin membership');
  }
}

// Idempotent insert helper: select-then-insert when the table doesn't
// have a useful UNIQUE constraint. Returns existing rows + newly-inserted
// rows. `keyCols` is the natural key to dedupe on.
async function upsertManual(table, rows, keyCols, selectCols = '*') {
  const { data: existing } = await sb.from(table).select(selectCols)
    .eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%');
  const existingByKey = new Map();
  for (const r of existing || []) {
    existingByKey.set(keyCols.map(c => r[c]).join('||'), r);
  }
  const toInsert = [];
  const merged = [];
  for (const r of rows) {
    const k = keyCols.map(c => r[c]).join('||');
    if (existingByKey.has(k)) merged.push(existingByKey.get(k));
    else toInsert.push(r);
  }
  if (toInsert.length) {
    const { data: inserted, error } = await sb.from(table).insert(toInsert).select(selectCols);
    if (error) { logErr(table, 'insert failed', error); return merged; }
    merged.push(...(inserted || []));
  }
  return merged;
}

// ── 1. Properties ────────────────────────────────────────────────
// `properties.address` is generated from address_line_1/city/state/zip via
// a trigger — any literal we set is overwritten to ''. The unique index is
// on the generated `address` column, so inserting two rows with empty
// `address_line_1` collides on ''. We use the city field as the dedup
// surface (each row gets a unique city = the deterministic address).
async function seedProperties() {
  header('Step 1 — properties (8 rows)');
  const rows = PROPS.map((p, i) => ({
    company_id: COMPANY_ID,
    address_line_1: p.address,
    city: 'Clicktown',
    state: 'MD',
    zip: '20850',
    type: p.type,
    status: p.status,
    rent: 1200 + i * 100,
    notes: TAG + ' — ' + p.address,
  }));
  const data = await upsertManual('properties', rows, ['address_line_1'], 'id, address, address_line_1, status');
  logOk(`${data.length} properties (existing+new)`);
  return data;
}

// ── 2. Tenants ───────────────────────────────────────────────────
// `tenants` has no `notes` column — cleanup keys off the email prefix
// (clicktest+...) instead, which is the natural-key pattern flagged in
// the plan for tables without a free-text column.
async function seedTenants(props) {
  header('Step 2 — tenants (8 rows + balances)');
  const propAddrByIdx = idx => props[idx]?.address || (props[idx] && props[idx].address_line_1) || PROPS[idx].address;

  const { data: existing } = await sb.from('tenants').select('id, name, email, property')
    .eq('company_id', COMPANY_ID).ilike('email', EMAIL_TAG + '%');
  const have = new Map();
  for (const r of existing || []) have.set(r.email, r);

  const toInsert = [];
  for (const t of TENANTS) {
    if (have.has(t.email)) continue;
    toInsert.push({
      company_id: COMPANY_ID,
      name: t.name,
      email: t.email,
      phone: '555-9' + Math.floor(Math.random() * 900 + 100),
      property: propAddrByIdx(t.propIdx),
      rent: 1500,
      balance: t.balance,
      lease_status: t.lease_status,
    });
  }
  if (toInsert.length) {
    const { data: inserted, error } = await sb.from('tenants').insert(toInsert).select('id, name, email, property');
    if (error) { logErr('tenants', 'insert failed', error); return Array.from(have.values()); }
    for (const r of inserted || []) have.set(r.email, r);
  }
  logOk(`${have.size} tenants (existing+new)`);
  return Array.from(have.values());
}

// ── 3. Accounting classes (1 per property) ───────────────────────
async function seedClasses(props) {
  header('Step 3 — acct_classes (one per property + 1 inactive)');
  const rows = props.map((p, i) => ({
    id: ID_PREFIX + 'class-' + p.id,
    company_id: COMPANY_ID,
    name: TAG + ' — ' + p.address,
    description: 'Click-test class for ' + p.address,
    color: ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'][i % 8],
    is_active: i < props.length - 1,
  }));
  for (const c of rows) {
    const { error } = await sb.from('acct_classes').upsert(c, { onConflict: 'id' });
    if (error) logErr('acct_classes', `upsert ${c.id}`, error);
  }
  logOk(`${rows.length} classes upserted`);
}

// ── 4. Payments (across methods/statuses/months) ─────────────────
async function seedPayments(tenants, props) {
  header('Step 4 — payments (12 rows across methods/statuses)');
  const today = new Date().toISOString().slice(0, 10);
  const lastMo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const twoMoAgo = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const methods = ['ACH', 'credit_card', 'check', 'cash'];
  const statuses = ['paid', 'pending', 'partial'];

  // `payments` has no notes column; cleanup keys off the tenant prefix
  // 'CT ' (every seeded tenant name starts with it).
  const { data: existing } = await sb.from('payments').select('id')
    .eq('company_id', COMPANY_ID).ilike('tenant', 'CT %');
  if ((existing || []).length > 0) { logOk(`${existing.length} payments already seeded`); return; }

  const rows = [];
  for (let i = 0; i < tenants.length && i < 6; i++) {
    const t = tenants[i];
    for (const date of [twoMoAgo, lastMo, today]) {
      rows.push({
        company_id: COMPANY_ID,
        tenant: t.name,
        property: t.property,
        amount: 1500 + i * 50,
        date,
        type: 'rent',
        method: methods[i % methods.length],
        status: statuses[i % statuses.length],
      });
    }
  }
  const { error } = await sb.from('payments').insert(rows);
  if (error) return logErr('payments', 'insert failed', error);
  logOk(`${rows.length} payments inserted`);
}

// ── 5. Work orders (mixed states) ────────────────────────────────
// `work_orders` columns: issue (free text), notes, status, priority, cost,
// property, created (auto), no `created_at` / `description` / `title`.
// Cleanup matches on `notes` (which contains TAG).
async function seedWorkOrders(props) {
  header('Step 5 — work_orders (6 mixed states)');
  const { data: existing } = await sb.from('work_orders').select('id')
    .eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%');
  if ((existing || []).length > 0) { logOk(`${existing.length} work orders already seeded`); return; }
  const propAddr = (i) => props[i]?.address || props[i]?.address_line_1 || PROPS[i].address;
  const rows = [
    { company_id: COMPANY_ID, property: propAddr(0), issue: 'Burst pipe',           status: 'open',        priority: 'emergency', cost: 0,   notes: TAG },
    { company_id: COMPANY_ID, property: propAddr(1), issue: 'Replacing dishwasher', status: 'in_progress', priority: 'high',      cost: 0,   notes: TAG },
    { company_id: COMPANY_ID, property: propAddr(2), issue: 'Interior painting',    status: 'completed',   priority: 'normal',    cost: 450, notes: TAG },
    { company_id: COMPANY_ID, property: propAddr(3), issue: 'AC tune-up',           status: 'completed',   priority: 'normal',    cost: 320, notes: TAG },
    { company_id: COMPANY_ID, property: propAddr(0), issue: 'Filter replacement',   status: 'open',        priority: 'low',       cost: 0,   notes: TAG },
    { company_id: COMPANY_ID, property: propAddr(1), issue: 'Carpet clean',         status: 'completed',   priority: 'normal',    cost: 180, notes: TAG },
  ];
  const { error } = await sb.from('work_orders').insert(rows);
  if (error) return logErr('work_orders', 'insert failed', error);
  logOk(`${rows.length} work orders inserted`);
}

// ── 6. Vendors ───────────────────────────────────────────────────
async function seedVendors() {
  header('Step 6 — vendors (5 rows)');
  // Cleanup-by-name uses ilike '% TAG %', so we can match by name.
  const { data: existingV } = await sb.from('vendors').select('name')
    .eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%');
  const have = new Set((existingV || []).map(v => v.name));
  // `vendors` uses `specialty` (not service_type) per the live schema.
  const all = [
    { company_id: COMPANY_ID, name: TAG + ' Plumbing Pros',  specialty: 'Plumbing',   status: 'active',   email: EMAIL_TAG + 'plumb@test.com', phone: '555-1111' },
    { company_id: COMPANY_ID, name: TAG + ' Spark Electric', specialty: 'Electrical', status: 'active',   email: EMAIL_TAG + 'spark@test.com', phone: '555-2222' },
    { company_id: COMPANY_ID, name: TAG + ' Cool HVAC',      specialty: 'HVAC',       status: 'active',   email: EMAIL_TAG + 'cool@test.com',  phone: '555-3333' },
    { company_id: COMPANY_ID, name: TAG + ' Lawn & Order',   specialty: 'Landscape',  status: 'active',   email: EMAIL_TAG + 'lawn@test.com',  phone: '555-4444' },
    { company_id: COMPANY_ID, name: TAG + ' Old Vendor',     specialty: 'General',    status: 'inactive', email: EMAIL_TAG + 'old@test.com',   phone: '555-5555' },
  ];
  const toInsert = all.filter(r => !have.has(r.name));
  if (!toInsert.length) { logOk('vendors already seeded'); return; }
  const { error } = await sb.from('vendors').insert(toInsert);
  if (error) return logErr('vendors', 'insert failed', error);
  logOk(`${toInsert.length} vendors inserted (${have.size} already present)`);
}

// ── Portal users: tenant + owner Supabase auth users ───────────
// Idempotently create or update auth users + corresponding tenants/owners
// rows + company_members. Specs 64/65 sign in as these to exercise
// tenant_portal / owner_portal.
async function findAuthUserByEmail(email) {
  // Supabase JS doesn't expose getUserByEmail; list+filter (cap 50 — fine
  // for a test-data seed).
  const { data } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
  const users = data?.users || [];
  return users.find(u => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

async function ensureAuthUser(email, password) {
  let u = await findAuthUserByEmail(email);
  if (!u) {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,  // skip the confirmation flow
    });
    if (error) { logErr('auth', `createUser ${email}`, error); return null; }
    u = data.user;
    logOk(`created auth user ${email}`);
  } else {
    // Reset password each run so tests/.env can be regenerated without
    // leaving an unknown-password user.
    const { error } = await sb.auth.admin.updateUserById(u.id, { password, email_confirm: true });
    if (error) { logErr('auth', `update ${email}`, error); return null; }
    logOk(`auth user ${email} ready (password reset)`);
  }
  return u;
}

async function seedPortalUsers(props) {
  header('Step 9 — portal users (tenant + owner auth)');
  const tenantUser = await ensureAuthUser(TENANT_TEST_EMAIL, PORTAL_PASSWORD);
  const ownerUser  = await ensureAuthUser(OWNER_TEST_EMAIL, PORTAL_PASSWORD);

  // — Tenant: tenants table row at the first CT property + tenant
  //   role membership.
  if (tenantUser && props && props[0]) {
    const propAddr = props[0].address || props[0].address_line_1 || PROPS[0].address;
    const { data: existingT } = await sb.from('tenants').select('id, email')
      .eq('company_id', COMPANY_ID).ilike('email', TENANT_TEST_EMAIL).maybeSingle();
    if (!existingT) {
      const { error } = await sb.from('tenants').insert({
        company_id: COMPANY_ID,
        name: 'CT Portal Tenant',
        email: TENANT_TEST_EMAIL,
        phone: '555-7000',
        property: propAddr,
        rent: 1500,
        balance: 0,
        lease_status: 'active',
      });
      if (error) logErr('tenants-portal', 'insert failed', error);
      else logOk('inserted CT Portal Tenant row');
    } else {
      logOk('tenant row for portal user already present');
    }
    // company_members → role=tenant active
    const { data: tm } = await sb.from('company_members').select('id, role, status, custom_pages')
      .eq('company_id', COMPANY_ID).ilike('user_email', TENANT_TEST_EMAIL).maybeSingle();
    if (tm) {
      await sb.from('company_members').update({ role: 'tenant', status: 'active', custom_pages: null }).eq('id', tm.id);
      logOk(`flipped tenant membership ${tm.id} → tenant/active`);
    } else {
      await sb.from('company_members').insert({
        company_id: COMPANY_ID, user_email: TENANT_TEST_EMAIL.toLowerCase(),
        role: 'tenant', status: 'active', custom_pages: null,
      });
      logOk('inserted tenant membership');
    }
  }

  // — Owner: owners table row + company_members role=owner active.
  //   companyRole must NOT be admin (App.js:937 forces owner_portal
  //   only when effectiveRole=owner AND companyRole !== "admin").
  if (ownerUser) {
    const { data: existingO } = await sb.from('owners').select('id, email')
      .eq('company_id', COMPANY_ID).ilike('email', OWNER_TEST_EMAIL).maybeSingle();
    if (!existingO) {
      const { error } = await sb.from('owners').insert({
        company_id: COMPANY_ID,
        name: 'CT Portal Owner',
        email: OWNER_TEST_EMAIL,
        phone: '555-7100',
        status: 'active',
      });
      if (error) logErr('owners-portal', 'insert failed', error);
      else logOk('inserted CT Portal Owner row');
    } else {
      logOk('owner row for portal user already present');
    }
    const { data: om } = await sb.from('company_members').select('id, role, status, custom_pages')
      .eq('company_id', COMPANY_ID).ilike('user_email', OWNER_TEST_EMAIL).maybeSingle();
    if (om) {
      await sb.from('company_members').update({ role: 'owner', status: 'active', custom_pages: null }).eq('id', om.id);
      logOk(`flipped owner membership ${om.id} → owner/active`);
    } else {
      await sb.from('company_members').insert({
        company_id: COMPANY_ID, user_email: OWNER_TEST_EMAIL.toLowerCase(),
        role: 'owner', status: 'active', custom_pages: null,
      });
      logOk('inserted owner membership');
    }
  }
}

// ── 7. Owners (3 rows + 2 props each) ────────────────────────────
async function seedOwners(props) {
  header('Step 7 — owners (3 rows, 2 props each)');
  const { data: existingO } = await sb.from('owners').select('name, id')
    .eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%');
  const have = new Set((existingO || []).map(v => v.name));
  // owners.status check constraint allows 'active' / 'inactive' (not 'archived').
  // Archived owners use the archived_at column instead.
  const all = [
    { company_id: COMPANY_ID, name: TAG + ' Alpha Holdings',   email: EMAIL_TAG + 'alpha@test.com', phone: '555-6001', status: 'active'   },
    { company_id: COMPANY_ID, name: TAG + ' Beta Investments', email: EMAIL_TAG + 'beta@test.com',  phone: '555-6002', status: 'active'   },
    { company_id: COMPANY_ID, name: TAG + ' Gamma Inactive',   email: EMAIL_TAG + 'gamma@test.com', phone: '555-6003', status: 'inactive', archived_at: new Date().toISOString() },
  ];
  const toInsert = all.filter(r => !have.has(r.name));
  if (toInsert.length) {
    const { error } = await sb.from('owners').insert(toInsert);
    if (error) return logErr('owners', 'insert failed', error);
  }
  logOk(`${toInsert.length} new owners (${have.size} already present)`);
  return existingO || [];
}

// ── Tasks: there is NO `tasks` table on this schema. The Tasks &
// Approvals page reads from doc_exception_requests (seeded below).
async function seedTasks() {
  header('Step 8 — tasks (skipped — no `tasks` table on this schema)');
  logOk('skipped (table not in schema; covered by doc_exception_requests below)');
}

// ── Property children — Utilities, HOA, Loans, Insurance, Tax Bills ──
async function seedPropertyChildren(props) {
  header('Step 10 — property children (utilities/hoa/loans/insurance/tax)');
  if (!props || !props.length) return;
  const propAddr = (i) => props[i]?.address || props[i]?.address_line_1 || PROPS[i].address;
  const today = new Date().toISOString().slice(0, 10);
  const future = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // utilities (Utilities.js): cleanup keyed by property_id (CT props),
  // status mix so filter pills render
  const utilExisting = await sb.from('utilities').select('id').eq('company_id', COMPANY_ID)
    .in('property_id', props.map(p => p.id));
  if ((utilExisting.data || []).length === 0) {
    const utilRows = [
      { company_id: COMPANY_ID, property: propAddr(0), property_id: props[0].id, provider: TAG + ' Dominion Energy', amount: 145.50, status: 'pending',         responsibility: 'owner',  due_date: future(7) },
      { company_id: COMPANY_ID, property: propAddr(0), property_id: props[0].id, provider: TAG + ' Fairfax Water',  amount: 62.30,  status: 'paid',            responsibility: 'tenant', due_date: today },
      { company_id: COMPANY_ID, property: propAddr(1), property_id: props[1].id, provider: TAG + ' WGL Gas',        amount: 98.00,  status: 'pending_review',  responsibility: 'owner',  due_date: future(3) },
      { company_id: COMPANY_ID, property: propAddr(2), property_id: props[2].id, provider: TAG + ' Cox Internet',   amount: 75.00,  status: 'pending',         responsibility: 'tenant', due_date: future(14) },
    ];
    const { error } = await sb.from('utilities').insert(utilRows);
    if (error) logErr('utilities', 'insert', error);
    else logOk(`${utilRows.length} utilities inserted`);
  } else logOk(`${utilExisting.data.length} utilities already present`);

  // hoa_payments
  const hoaExisting = await sb.from('hoa_payments').select('id').eq('company_id', COMPANY_ID).ilike('hoa_name', '%' + TAG + '%');
  if ((hoaExisting.data || []).length === 0) {
    const rows = [
      { company_id: COMPANY_ID, property: propAddr(0), property_id: props[0].id, hoa_name: TAG + ' Oakwood HOA',     amount: 250, frequency: 'monthly',   status: 'paid',    due_date: today,        paid_date: today },
      { company_id: COMPANY_ID, property: propAddr(1), property_id: props[1].id, hoa_name: TAG + ' Maple Ridge HOA', amount: 185, frequency: 'monthly',   status: 'pending', due_date: future(5)  },
      { company_id: COMPANY_ID, property: propAddr(2), property_id: props[2].id, hoa_name: TAG + ' Cedar Pines HOA', amount: 125, frequency: 'quarterly', status: 'pending', due_date: future(-3) /* overdue */ },
    ];
    const { error } = await sb.from('hoa_payments').insert(rows);
    if (error) logErr('hoa_payments', 'insert', error);
    else logOk(`${rows.length} hoa_payments inserted`);
  } else logOk(`${hoaExisting.data.length} hoa_payments already present`);

  // property_loans (note: real table name is property_loans, not loans)
  const loansExisting = await sb.from('property_loans').select('id').eq('company_id', COMPANY_ID).ilike('lender_name', '%' + TAG + '%');
  if ((loansExisting.data || []).length === 0) {
    const rows = [
      { company_id: COMPANY_ID, property: propAddr(0), property_id: props[0].id, lender_name: TAG + ' Wells Fargo Home', loan_type: 'mortgage', original_amount: 250000, current_balance: 198000, interest_rate: 6.5, monthly_payment: 1580, status: 'active' },
      { company_id: COMPANY_ID, property: propAddr(1), property_id: props[1].id, lender_name: TAG + ' Chase HELOC',      loan_type: 'heloc',    original_amount: 50000,  current_balance: 0,      interest_rate: 7.25, monthly_payment: 0, status: 'paid_off' },
    ];
    const { error } = await sb.from('property_loans').insert(rows);
    if (error) logErr('property_loans', 'insert', error);
    else logOk(`${rows.length} property_loans inserted`);
  } else logOk(`${loansExisting.data.length} property_loans already present`);

  // property_insurance
  const insExisting = await sb.from('property_insurance').select('id').eq('company_id', COMPANY_ID).ilike('provider', '%' + TAG + '%');
  if ((insExisting.data || []).length === 0) {
    const rows = [
      { company_id: COMPANY_ID, property: propAddr(0), property_id: props[0].id, provider: TAG + ' Allstate', policy_number: 'CT-12345', premium_amount: 1200, premium_frequency: 'annual', coverage_amount: 350000, expiration_date: future(180) },
      { company_id: COMPANY_ID, property: propAddr(1), property_id: props[1].id, provider: TAG + ' State Farm', policy_number: 'CT-67890', premium_amount: 950,  premium_frequency: 'annual', coverage_amount: 275000, expiration_date: future(20) /* expiring soon */ },
    ];
    const { error } = await sb.from('property_insurance').insert(rows);
    if (error) logErr('property_insurance', 'insert', error);
    else logOk(`${rows.length} property_insurance inserted`);
  } else logOk(`${insExisting.data.length} property_insurance already present`);

  // property_tax_bills
  const taxExisting = await sb.from('property_tax_bills').select('id').eq('company_id', COMPANY_ID).ilike('paid_notes', '%' + TAG + '%');
  if ((taxExisting.data || []).length === 0) {
    const rows = [
      // status check constraint accepts 'pending'; 'paid'/'overdue' are
      // derived from paid_date / due_date in the UI, not stored as
      // separate enum values.
      { company_id: COMPANY_ID, property: propAddr(0), property_id: props[0].id, tax_year: 2025, installment_label: 'H2 2025', expected_amount: 1450, status: 'pending', paid_amount: 1450, paid_date: today, paid_notes: TAG + ' paid', due_date: future(-90) },
      { company_id: COMPANY_ID, property: propAddr(1), property_id: props[1].id, tax_year: 2026, installment_label: 'H1 2026', expected_amount: 1620, status: 'pending', paid_notes: TAG + ' due',     due_date: future(20) },
      { company_id: COMPANY_ID, property: propAddr(2), property_id: props[2].id, tax_year: 2026, installment_label: 'H1 2026', expected_amount: 1380, status: 'pending', paid_notes: TAG + ' overdue', due_date: future(-15) },
    ];
    const { error } = await sb.from('property_tax_bills').insert(rows);
    if (error) logErr('property_tax_bills', 'insert', error);
    else logOk(`${rows.length} property_tax_bills inserted`);
  } else logOk(`${taxExisting.data.length} property_tax_bills already present`);
}

// ── Accounting: journal entries + recurring entries ──
async function seedAccounting(props) {
  header('Step 11 — accounting JEs + recurring');
  // Resolve a few real account IDs (cash, AR, rent income, repairs)
  // for double-entry. acct_accounts is per-company auto-seeded.
  const { data: accts } = await sb.from('acct_accounts').select('id, code, name')
    .eq('company_id', COMPANY_ID).in('code', ['1000', '1100', '4000', '5300']);
  const byCode = Object.fromEntries((accts || []).map(a => [a.code, a]));
  if (!byCode['1000'] || !byCode['4000']) { logErr('accounting', 'missing core accounts (1000/4000)'); return; }

  // Journal entries — 6 across draft/posted/voided
  const { data: jeExisting } = await sb.from('acct_journal_entries').select('id, reference')
    .eq('company_id', COMPANY_ID).ilike('description', '%' + TAG + '%');
  if ((jeExisting || []).length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [
      { company_id: COMPANY_ID, number: 'CTJE-001', date: today, description: TAG + ' Test rent receipt — posted', reference: 'CT-' + Date.now() + '-1', status: 'posted', property: props[0]?.address || '' },
      { company_id: COMPANY_ID, number: 'CTJE-002', date: today, description: TAG + ' Test repair expense — posted', reference: 'CT-' + Date.now() + '-2', status: 'posted', property: props[1]?.address || '' },
      { company_id: COMPANY_ID, number: 'CTJE-003', date: today, description: TAG + ' Test draft entry', reference: 'CT-' + Date.now() + '-3', status: 'draft' },
      { company_id: COMPANY_ID, number: 'CTJE-004', date: today, description: TAG + ' Test draft 2', reference: 'CT-' + Date.now() + '-4', status: 'draft' },
      { company_id: COMPANY_ID, number: 'CTJE-005', date: today, description: TAG + ' Test voided', reference: 'CT-' + Date.now() + '-5', status: 'voided' },
    ];
    const { data: inserted, error } = await sb.from('acct_journal_entries').insert(rows).select('id, reference');
    if (error) { logErr('acct_journal_entries', 'insert', error); return; }
    // Add lines (DR cash / CR rent income — keeps balance real)
    const lines = [];
    for (const je of inserted || []) {
      lines.push({ company_id: COMPANY_ID, journal_entry_id: je.id, account_id: byCode['1000'].id, account_name: byCode['1000'].name, debit: 1500, credit: 0, memo: TAG });
      lines.push({ company_id: COMPANY_ID, journal_entry_id: je.id, account_id: byCode['4000'].id, account_name: byCode['4000'].name, debit: 0, credit: 1500, memo: TAG });
    }
    const { error: lineErr } = await sb.from('acct_journal_lines').insert(lines);
    if (lineErr) logErr('acct_journal_lines', 'insert', lineErr);
    else logOk(`${rows.length} JEs + ${lines.length} lines inserted`);
  } else logOk(`${jeExisting.length} CT journal entries already present`);

  // Recurring journal entries — active/paused mix
  const { data: recExisting } = await sb.from('recurring_journal_entries').select('id')
    .eq('company_id', COMPANY_ID).ilike('description', '%' + TAG + '%');
  if ((recExisting || []).length === 0) {
    // recurring_journal_entries uses `status` ('active'/'paused'),
    // not is_active. Constraint recurring_je_tenant_pair_check
    // requires tenant_id + tenant_name to BOTH be set or BOTH null.
    // Look up the seeded tenant id once.
    const { data: aliceRow } = await sb.from('tenants').select('id, name')
      .eq('company_id', COMPANY_ID).ilike('email', EMAIL_TAG + 'alice@test.com').maybeSingle();
    const rows = [
      // Tenant pair: tenant_id + tenant_name BOTH set (only when alice exists)
      ...(aliceRow ? [{ company_id: COMPANY_ID, description: TAG + ' Monthly rent — Alice', frequency: 'monthly', day_of_month: 1, amount: 1500, tenant_id: aliceRow.id, tenant_name: aliceRow.name, property: props[0]?.address || '', debit_account_id: byCode['1100']?.id || byCode['1000'].id, debit_account_name: 'AR', credit_account_id: byCode['4000'].id, credit_account_name: 'Rent Income', status: 'active' }] : []),
      // Property-only entries (no tenant pair) — both tenant fields null
      { company_id: COMPANY_ID, description: TAG + ' Monthly HOA — Oak',      frequency: 'monthly', day_of_month: 5,  amount: 250, property: props[0]?.address || '', debit_account_id: byCode['5300']?.id || byCode['1000'].id, debit_account_name: 'Repairs', credit_account_id: byCode['1000'].id, credit_account_name: 'Cash', status: 'active' },
      { company_id: COMPANY_ID, description: TAG + ' Quarterly HOA — paused', frequency: 'monthly', day_of_month: 15, amount: 125, property: props[2]?.address || '', debit_account_id: byCode['5300']?.id || byCode['1000'].id, debit_account_name: 'Repairs', credit_account_id: byCode['1000'].id, credit_account_name: 'Cash', status: 'paused' },
    ];
    const { error } = await sb.from('recurring_journal_entries').insert(rows);
    if (error) logErr('recurring_journal_entries', 'insert', error);
    else logOk(`${rows.length} recurring JEs inserted`);
  } else logOk(`${recExisting.length} recurring entries already present`);
}

// ── Leases + lease_templates ──
async function seedLeases(props, tenants) {
  header('Step 12 — leases + lease_templates');
  if (!tenants || !tenants.length) return;

  const { data: tplExisting } = await sb.from('lease_templates').select('id').ilike('name', '%' + TAG + '%');
  if ((tplExisting || []).length === 0) {
    const rows = [
      { name: TAG + ' Standard 12-month MD', description: 'Click-test template', clauses: 'Standard MD residential lease', default_lease_months: 12, default_deposit_months: 1, default_escalation_pct: 3, payment_due_day: 1, is_active: true },
      { name: TAG + ' Month-to-month',       description: 'Click-test M2M',     clauses: 'Month-to-month tenancy',          default_lease_months: 0,  default_deposit_months: 1, default_escalation_pct: 0, payment_due_day: 1, is_active: true },
    ];
    const { error } = await sb.from('lease_templates').insert(rows);
    if (error) logErr('lease_templates', 'insert', error);
    else logOk(`${rows.length} lease_templates inserted`);
  } else logOk(`${tplExisting.length} lease_templates already present`);

  const { data: leaseExisting } = await sb.from('leases').select('id')
    .eq('company_id', COMPANY_ID).ilike('special_terms', '%' + TAG + '%');
  if ((leaseExisting || []).length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (let i = 0; i < Math.min(tenants.length, 4); i++) {
      const t = tenants[i];
      // leases.status check constraint allows 'active' / 'terminated'.
      // The expiring/expired UI states are derived from end_date, not
      // a separate status enum.
      rows.push({
        company_id: COMPANY_ID,
        tenant_id: t.id,
        tenant_name: t.name,
        property: t.property,
        status: i === 3 ? 'terminated' : 'active',
        start_date: new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10),
        end_date:   new Date(Date.now() + (i === 2 ? 25 : i === 3 ? -10 : 165) * 86400000).toISOString().slice(0, 10),
        rent_amount: 1500 + i * 50,
        payment_due_day: 1,
        security_deposit: 1500 + i * 50,
        special_terms: TAG + ' click-test lease',
        signature_status: 'fully_signed',
      });
    }
    const { error } = await sb.from('leases').insert(rows);
    if (error) logErr('leases', 'insert', error);
    else logOk(`${rows.length} leases inserted`);
  } else logOk(`${leaseExisting.length} leases already present`);
}

// ── Documents + doc_templates + doc_generated ──
async function seedDocuments(props, tenants) {
  header('Step 13 — documents + templates + generated');

  // doc_templates — system templates exist; add custom CT ones
  const { data: tplExisting } = await sb.from('doc_templates').select('id')
    .eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%');
  if ((tplExisting || []).length === 0) {
    const rows = [
      { company_id: COMPANY_ID, name: TAG + ' Notice of Entry',  category: 'notice',     description: 'Click-test template', body: 'Notice for {{tenant_name}} at {{property}}', fields: ['tenant_name','property'], is_system: false, is_active: true },
      { company_id: COMPANY_ID, name: TAG + ' Pet Addendum',     category: 'addendum',   description: 'Click-test addendum', body: 'Pet addendum for {{tenant_name}}.',          fields: ['tenant_name'],            is_system: false, is_active: true },
    ];
    const { error } = await sb.from('doc_templates').insert(rows);
    if (error) logErr('doc_templates', 'insert', error);
    else logOk(`${rows.length} doc_templates inserted`);
  } else logOk(`${tplExisting.length} doc_templates already present`);

  // documents (uploaded files)
  const { data: docsExisting } = await sb.from('documents').select('id')
    .eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%');
  if ((docsExisting || []).length === 0) {
    const rows = [
      { company_id: COMPANY_ID, name: TAG + ' lease.pdf',       tenant: tenants[0]?.name || '', property: tenants[0]?.property || '', type: 'lease',    url: 'https://example.com/ct-lease.pdf',    file_name: 'ct-lease.pdf',    size: 245000 },
      { company_id: COMPANY_ID, name: TAG + ' insurance.pdf',   tenant: '', property: props[0]?.address || '',                          type: 'insurance', url: 'https://example.com/ct-ins.pdf',     file_name: 'ct-ins.pdf',      size: 88000  },
      { company_id: COMPANY_ID, name: TAG + ' inspection.jpg',  tenant: '', property: props[1]?.address || '',                          type: 'inspection',url: 'https://example.com/ct-insp.jpg',    file_name: 'ct-insp.jpg',     size: 410000 },
    ];
    const { error } = await sb.from('documents').insert(rows);
    if (error) logErr('documents', 'insert', error);
    else logOk(`${rows.length} documents inserted`);
  } else logOk(`${docsExisting.length} documents already present`);
}

// ── Inspections ──
async function seedInspections(props) {
  header('Step 14 — inspections');
  const { data: existing } = await sb.from('inspections').select('id')
    .eq('company_id', COMPANY_ID).ilike('notes', '%' + TAG + '%');
  if ((existing || []).length > 0) { logOk(`${existing.length} inspections already present`); return; }
  const today = new Date().toISOString().slice(0, 10);
  const rows = [
    { company_id: COMPANY_ID, property: props[0]?.address || '', date: today, type: 'move_in',   status: 'completed', inspector: 'CT Inspector', notes: TAG + ' move-in inspection',  checklist: { kitchen: true, bath: true, walls: true } },
    { company_id: COMPANY_ID, property: props[1]?.address || '', date: today, type: 'periodic',  status: 'scheduled', inspector: 'CT Inspector', notes: TAG + ' periodic inspection', checklist: {} },
    { company_id: COMPANY_ID, property: props[6]?.address || '', date: today, type: 'move_out',  status: 'completed', inspector: 'CT Inspector', notes: TAG + ' move-out inspection', checklist: { walls: true, floor: false } },
  ];
  const { error } = await sb.from('inspections').insert(rows);
  if (error) logErr('inspections', 'insert', error);
  else logOk(`${rows.length} inspections inserted`);
}

// ── Autopay schedules ──
async function seedAutopay(tenants) {
  header('Step 15 — autopay_schedules');
  if (!tenants || tenants.length < 3) return;
  const { data: existing } = await sb.from('autopay_schedules').select('id')
    .eq('company_id', COMPANY_ID).in('tenant', tenants.slice(0, 3).map(t => t.name));
  if ((existing || []).length > 0) { logOk(`${existing.length} autopay schedules already present`); return; }
  const today = new Date().toISOString().slice(0, 10);
  const rows = [
    { company_id: COMPANY_ID, tenant: tenants[0].name, property: tenants[0].property, amount: 1500, frequency: 'monthly', day_of_month: 1, start_date: today, method: 'stripe', active: true  },
    { company_id: COMPANY_ID, tenant: tenants[1].name, property: tenants[1].property, amount: 1550, frequency: 'monthly', day_of_month: 1, start_date: today, method: 'stripe', active: false /* paused */ },
    { company_id: COMPANY_ID, tenant: tenants[2].name, property: tenants[2].property, amount: 1600, frequency: 'monthly', day_of_month: 5, start_date: today, method: 'ach',    active: true  },
  ];
  const { error } = await sb.from('autopay_schedules').insert(rows);
  if (error) logErr('autopay_schedules', 'insert', error);
  else logOk(`${rows.length} autopay_schedules inserted`);
}

// ── Late fee rules ──
async function seedLateFeeRules() {
  header('Step 16 — late_fee_rules');
  const { data: existing } = await sb.from('late_fee_rules').select('id')
    .eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%');
  if ((existing || []).length > 0) { logOk(`${existing.length} late_fee_rules already present`); return; }
  const rows = [
    { company_id: COMPANY_ID, name: TAG + ' Standard MD',  grace_days: 5, fee_amount: 50,    fee_type: 'fixed',      apply_to: 'all' },
    { company_id: COMPANY_ID, name: TAG + ' VA 5pct',      grace_days: 7, fee_amount: 5,     fee_type: 'percentage', apply_to: 'all' },
  ];
  const { error } = await sb.from('late_fee_rules').insert(rows);
  if (error) logErr('late_fee_rules', 'insert', error);
  else logOk(`${rows.length} late_fee_rules inserted`);
}

// ── Owner statements + distributions ──
async function seedOwnerStatements() {
  header('Step 17 — owner_statements + owner_distributions');
  // Find CT owners
  const { data: ctOwners } = await sb.from('owners').select('id, name')
    .eq('company_id', COMPANY_ID).ilike('name', '%' + TAG + '%');
  if (!ctOwners || ctOwners.length === 0) { logOk('no CT owners — skipping statements'); return; }

  const { data: stExisting } = await sb.from('owner_statements').select('id')
    .eq('company_id', COMPANY_ID).in('owner_id', ctOwners.map(o => o.id));
  if ((stExisting || []).length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = [];
    for (const o of ctOwners.slice(0, 2)) {
      rows.push({
        company_id: COMPANY_ID, owner_id: o.id, owner_name: o.name,
        period: 'Mar 2026', start_date: monthAgo, end_date: today,
        total_income: 4500, total_expenses: 800, management_fee: 450, net_to_owner: 3250,
        line_items: [{ desc: 'Rent — 101', amount: 1500 }, { desc: 'Repairs', amount: -800 }],
        status: 'sent',
      });
      rows.push({
        company_id: COMPANY_ID, owner_id: o.id, owner_name: o.name,
        period: 'Apr 2026', start_date: today, end_date: today,
        total_income: 4500, total_expenses: 0, management_fee: 450, net_to_owner: 4050,
        line_items: [{ desc: 'Rent — 101', amount: 1500 }],
        status: 'draft',
      });
    }
    const { error } = await sb.from('owner_statements').insert(rows);
    if (error) logErr('owner_statements', 'insert', error);
    else logOk(`${rows.length} owner_statements inserted`);
  } else logOk(`${stExisting.length} statements already present`);

  // owner_distributions
  const { data: distExisting } = await sb.from('owner_distributions').select('id')
    .eq('company_id', COMPANY_ID).in('owner_id', ctOwners.map(o => o.id));
  if ((distExisting || []).length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    // owner_distributions has owner_id but not owner_name; the UI
    // joins to the owners table for the display name.
    const rows = ctOwners.slice(0, 2).map(o => ({
      company_id: COMPANY_ID, owner_id: o.id,
      date: today, amount: 3250, method: 'ach', notes: TAG + ' distribution',
    }));
    const { error } = await sb.from('owner_distributions').insert(rows);
    if (error) logErr('owner_distributions', 'insert', error);
    else logOk(`${rows.length} owner_distributions inserted`);
  } else logOk(`${distExisting.length} distributions already present`);
}

// ── Audit trail ──
async function seedAuditTrail() {
  header('Step 18 — audit_trail (sample entries for filter testing)');
  const { data: existing } = await sb.from('audit_trail').select('id')
    .eq('company_id', COMPANY_ID).ilike('details', '%' + TAG + '%');
  if ((existing || []).length > 0) { logOk(`${existing.length} CT audit rows already present`); return; }
  const modules = ['tenants', 'properties', 'payments', 'maintenance', 'leases', 'accounting'];
  const actions = ['create', 'update', 'archive', 'restore', 'login', 'logout'];
  const rows = [];
  for (let i = 0; i < 18; i++) {
    rows.push({
      company_id: COMPANY_ID,
      action: actions[i % actions.length],
      module: modules[i % modules.length],
      details: TAG + ' synthetic audit entry #' + i,
      user_email: TEST_EMAIL,
      user_role: 'admin',
    });
  }
  const { error } = await sb.from('audit_trail').insert(rows);
  if (error) logErr('audit_trail', 'insert', error);
  else logOk(`${rows.length} audit_trail entries inserted`);
}

// ── Doc exception requests (Tasks page) ──
async function seedDocExceptions(tenants) {
  header('Step 19 — doc_exception_requests (Tasks page)');
  if (!tenants || !tenants.length) return;
  const { data: existing } = await sb.from('doc_exception_requests').select('id')
    .eq('company_id', COMPANY_ID).ilike('reason', '%' + TAG + '%');
  if ((existing || []).length > 0) { logOk(`${existing.length} doc_exception_requests already present`); return; }
  const rows = [
    { company_id: COMPANY_ID, tenant_name: tenants[0].name, property: tenants[0].property, requested_by: TEST_EMAIL, approver_email: TEST_EMAIL, reason: TAG + ' missing W9',         status: 'pending' },
    { company_id: COMPANY_ID, tenant_name: tenants[1].name, property: tenants[1].property, requested_by: TEST_EMAIL, approver_email: TEST_EMAIL, reason: TAG + ' lease scan delayed', status: 'pending' },
  ];
  const { error } = await sb.from('doc_exception_requests').insert(rows);
  if (error) logErr('doc_exception_requests', 'insert', error);
  else logOk(`${rows.length} doc_exception_requests inserted`);
}

// ── Messages ──
async function seedMessages(tenants) {
  header('Step 20 — messages');
  if (!tenants || tenants.length < 2) return;
  const { data: existing } = await sb.from('messages').select('id')
    .eq('company_id', COMPANY_ID).ilike('message', '%' + TAG + '%');
  if ((existing || []).length > 0) { logOk(`${existing.length} messages already present`); return; }
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const t = tenants[i];
    rows.push({
      company_id: COMPANY_ID, tenant: t.name, tenant_id: t.id, property: t.property,
      sender: t.name, sender_email: t.email, sender_role: 'tenant',
      message: TAG + ' Hi, when can someone come look at the leak? — msg ' + i, read: i > 0,
    });
    rows.push({
      company_id: COMPANY_ID, tenant: t.name, tenant_id: t.id, property: t.property,
      sender: 'Admin', sender_email: TEST_EMAIL, sender_role: 'admin',
      message: TAG + ' Got it — sending a plumber tomorrow morning. Reply ' + i, read: true,
    });
  }
  const { error } = await sb.from('messages').insert(rows);
  if (error) logErr('messages', 'insert', error);
  else logOk(`${rows.length} messages inserted`);
}

// ── Top-level ─────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--cleanup')) {
    await cleanup();
    return;
  }
  console.log('🌱 Click-coverage seed → ' + COMPANY_ID + ' (Smith Properties LLC)');
  console.log('   tag: ' + TAG + '\n');
  await ensureMembership();
  const props = await seedProperties();
  if (!props || !props.length) { console.error('Aborting — no properties'); process.exit(1); }
  const tenants = await seedTenants(props);
  await seedClasses(props);
  if (tenants && tenants.length) await seedPayments(tenants, props);
  await seedWorkOrders(props);
  await seedVendors();
  const owners = await seedOwners(props);
  await seedTasks();
  await seedPortalUsers(props);
  // Phase 2 — close the ultraplan gap. These cover the modules that
  // the click-coverage specs (50–66) actually exercise.
  await seedPropertyChildren(props);
  await seedAccounting(props);
  if (tenants && tenants.length) await seedLeases(props, tenants);
  if (tenants && tenants.length) await seedDocuments(props, tenants);
  await seedInspections(props);
  if (tenants && tenants.length) await seedAutopay(tenants);
  await seedLateFeeRules();
  await seedOwnerStatements();
  await seedAuditTrail();
  if (tenants && tenants.length) await seedDocExceptions(tenants);
  if (tenants && tenants.length) await seedMessages(tenants);

  console.log('\n──────────────────────────────────────────────────');
  console.log(errors.length ? `⚠  Done with ${errors.length} soft errors:` : '✅ Done — no errors');
  for (const e of errors) console.log('  - [' + e.phase + '] ' + e.msg + (e.raw ? ' — ' + e.raw : ''));
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
