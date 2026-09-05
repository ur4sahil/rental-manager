// ═══════════════════════════════════════════════════════════════
// 83 — ROLES AND PERMISSIONS
// ═══════════════════════════════════════════════════════════════
//
// Everything else in this suite runs as an admin. This file is the
// only place that asks the question that actually matters: what
// happens when someone who is NOT an admin — or not in the company at
// all — reaches for something.
//
// Three things are asserted, in order of consequence:
//
//   1. CROSS-COMPANY ISOLATION. A member of one company must not be
//      able to read another company's books, whether by putting the
//      other company's id in the URL or by querying PostgREST
//      directly with their own JWT. RLS is the only thing standing
//      between two customers' general ledgers.
//
//   2. ROUTE ALLOWLISTS, BOTH DIRECTIONS. Every page a role's
//      ROLES[...].pages list grants must actually render, and every
//      page it does not grant must be refused — tested by navigating
//      DIRECTLY to `?company=<id>#<route>`, not by checking whether
//      the sidebar hid the link. A hidden link is not a permission.
//
//   3. THE DISABLED-BUTTON TRAP. Where the UI hides or disables a
//      privileged control (delete a property, remove a period lock,
//      manage team members), the backend must refuse the same
//      operation. A guard that exists only in React is not a guard;
//      anyone with the anon key and a session can POST around it.
//
// ── HOW TEST USERS ARE MADE ────────────────────────────────────────
// There is no invite-free API for this, and the invite flow sends
// email, so users are minted directly in the TEST database over psql.
// The recipe (see seedUsers() below) is four inserts:
//
//   1. auth.users      — id, email, crypt(password, gen_salt('bf')) in
//                        encrypted_password, email_confirmed_at = now().
//                        CRITICAL: the eight token columns
//                        (confirmation_token, recovery_token,
//                        email_change_token_new, email_change,
//                        email_change_token_current, phone_change,
//                        phone_change_token, reauthentication_token)
//                        must be '' and not NULL. GoTrue scans them
//                        into non-nullable Go strings; leave them NULL
//                        and every sign-in fails with the extremely
//                        unhelpful "Database error querying schema".
//   2. auth.identities — one 'email' provider row, provider_id = the
//                        user's uuid, identity_data carrying sub/email.
//   3. app_users       — the app's profile row. password_set_at MUST be
//                        non-null or App.js's needsPasswordSetup()
//                        parks the user on the set-password screen
//                        instead of the app.
//   4. company_members — company_id + user_email + role + status
//                        'active' + auth_user_id. THIS row, not
//                        app_users.role, is what the app reads for
//                        authorization (fetchUserRoleForCompany).
//
// Everything is torn down in afterAll.
//
// ── CLOSED HOLES ───────────────────────────────────────────────────
// Seven tests here were written as test.fail() markers recording
// confirmed privilege-escalation holes. All seven were closed by
// migration 20260905090000_rls_membership_lockdown.sql and the markers
// removed, so they are now ordinary regression tests: each asserts the
// security-correct behaviour and must PASS. The HOLE comments are kept
// as-is -- they describe what an attacker got before the fix, which is
// the clearest statement of what each test is defending.
//
// One caution kept from the original run: apiAs() re-authenticates ten
// minutes before the JWT expires and every test calls
// assertSessionAlive() first. That is not padding. An expired token
// makes every write fail with 401, which is indistinguishable from
// "RLS refused it" -- during development that made a test report an
// open hole as closed. Any test that concludes something from a
// refusal needs the same liveness proof.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { login } = require('./helpers');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ── Fixtures ───────────────────────────────────────────────────────

// The disposable sandbox company (full-fidelity copy of Sahil LLC).
const SANDBOX = 'e2e-sandbox';
// Pristine reference company. Read attempts only — never written to.
const SAHIL = 'f56be35c-c80d-4f47-8624-cbb317f85461';
// A throwaway third company used to prove cross-company WRITE holes
// without touching Sahil LLC.
const FOREIGN = 'e2e-83-foreign-llc';

const PASSWORD = 'E2eRoles!2026';
const USERS = {
  admin:            { email: 'e2e-83-admin@propmanager.test',   name: 'E2E 83 Admin' },
  manager:          { email: 'e2e-83-manager@propmanager.test', name: 'E2E 83 Manager' },
  office_assistant: { email: 'e2e-83-oa@propmanager.test',      name: 'E2E 83 OA' },
};
const ROLE_KEYS = Object.keys(USERS);

// Test database. Overridable, but defaulted so the spec is runnable
// straight from the repo the way every other spec here is.
const DB_URL = process.env.TEST_DB_URL ||
  'postgresql://postgres.vpeewlplgxthckpidhxo:Sheebasoin1%23@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
const SUPA_URL = process.env.TEST_SUPABASE_URL;
const SUPA_ANON = process.env.TEST_SUPABASE_ANON_KEY;

function sql(text) {
  return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-Atc', text], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// ── ROLES allowlists, mirrored from src/App.js ─────────────────────
// Copied deliberately rather than imported: if App.js quietly widens a
// role's access, this file should disagree with it loudly.
const ACCT_SUB = ['acct_opening', 'acct_coa', 'acct_journal', 'acct_recurring',
  'acct_bankimport', 'acct_qbimport', 'acct_reconcile', 'acct_classes', 'acct_reports'];

const ROLES = {
  admin: ['dashboard', 'tasks', 'properties', 'property_import', 'tenants', 'payments',
    'maintenance', 'utilities', 'hoa', 'loans', 'insurance', 'tax_bills', 'accounting',
    ...ACCT_SUB, 'owners', 'notifications', 'messages', 'admin', 'documents', 'doc_builder',
    'leases', 'autopay', 'inspections', 'vendors', 'moveout', 'evictions', 'latefees'],
  manager: ['dashboard', 'tasks', 'properties', 'property_import', 'tenants', 'payments',
    'maintenance', 'utilities', 'hoa', 'tax_bills', 'accounting', ...ACCT_SUB,
    'notifications', 'messages', 'documents', 'doc_builder', 'leases', 'inspections',
    'vendors', 'moveout', 'evictions'],
  office_assistant: ['dashboard', 'tasks', 'properties', 'tenants', 'payments', 'maintenance',
    'utilities', 'hoa', 'tax_bills', 'accounting', ...ACCT_SUB, 'notifications', 'messages',
    'admin', 'documents', 'doc_builder', 'leases', 'inspections', 'vendors', 'moveout',
    'evictions'],
};

// Every route the app knows about, so "denied" can be computed as the
// complement of a role's allowlist rather than hand-listed per role.
const ALL_ROUTES = ROLES.admin;

// App.js does not use ROLES[...].pages as-is. It expands it: "If the
// user has the parent ('accounting'), they implicitly have all child
// page IDs too." The rule was written for the Accounting sub-pages, but
// it runs over every ALL_NAV parent — and Properties' children include
// Loans, Insurance and Import-from-Excel, which the manager and
// office_assistant allowlists deliberately withhold. Mirrored here so
// the leak is derived from the two lists rather than hand-maintained.
const NAV_CHILDREN = {
  properties: ['property_import', 'maintenance', 'inspections', 'utilities', 'hoa',
    'loans', 'insurance', 'tax_bills'],
  accounting: ACCT_SUB,
};

function expandParents(pages) {
  const set = new Set(pages);
  for (const [parent, kids] of Object.entries(NAV_CHILDREN)) {
    if (set.has(parent)) for (const k of kids) set.add(k);
  }
  return set;
}

// `autopay` is in admin's allowlist but has no entry in App.js's
// pageComponents map, so it falls through to Dashboard for EVERY role.
// It is a dead route, not a permission boundary — excluded from both
// directions and pinned by its own test below.
const DEAD_ROUTES = new Set(['autopay']);

// What "this page actually rendered" looks like. Text unique to the
// page and absent from the Dashboard the app clamps to on refusal.
const MARKER = {
  dashboard: /OCCUPANCY/i,
  tasks: /Tasks & Approvals/i,
  properties: /Setup Drafts/i,
  property_import: /Import properties from Excel/i,
  tenants: /Archived Tenants/i,
  payments: /Stripe Payments/i,
  maintenance: /Work Orders/i,
  utilities: /Manual Bills/i,
  hoa: /HOA Payments/i,
  loans: /Add Loan/i,
  insurance: /Add Policy/i,
  tax_bills: /Property Tax Bills/i,
  accounting: /New Journal Entry/i,
  acct_opening: /Opening Balances/i,
  acct_coa: /Chart of Accounts/i,
  acct_journal: /Journal Entries/i,
  acct_recurring: /Post Now|\+ Add Entry/i,
  acct_bankimport: /Bank Transactions/i,
  acct_qbimport: /Import from QuickBooks/i,
  acct_reconcile: /Period Lock/i,
  acct_classes: /Class Tracking/i,
  acct_reports: /Standard Reports/i,
  owners: /Owners & Statements/i,
  notifications: /Stay up to date/i,
  messages: /Chat with your tenants/i,
  admin: /Audit Trail/i,
  documents: /Document Management/i,
  doc_builder: /Document Builder/i,
  leases: /Lease Management/i,
  inspections: /Inspections/i,
  vendors: /Vendor Management/i,
  moveout: /Move-Out Wizard/i,
  evictions: /Eviction Tracker/i,
  latefees: /Late Fee Automation/i,
};

// ── Seeding ────────────────────────────────────────────────────────

function seedUsers() {
  const values = ROLE_KEYS
    .map(r => `('${USERS[r].email}','${r}','${USERS[r].name}')`)
    .join(',');
  sql(`
DO $seed$
DECLARE r record; uid uuid;
BEGIN
  -- Throwaway third company: proves cross-company writes without ever
  -- naming the pristine reference company.
  DELETE FROM acct_journal_entries WHERE company_id = '${FOREIGN}';
  DELETE FROM properties           WHERE company_id = '${FOREIGN}';
  DELETE FROM company_members      WHERE company_id = '${FOREIGN}';
  DELETE FROM companies            WHERE id = '${FOREIGN}';
  INSERT INTO companies (id, name, type, company_code, created_by)
    VALUES ('${FOREIGN}', 'E2E 83 Foreign LLC', 'LLC', 'E2E83FGN', 'nobody@propmanager.test');
  INSERT INTO properties (address, type, status, company_id)
    VALUES ('999 Foreign Confidential Way', 'Single Family', 'vacant', '${FOREIGN}');
  INSERT INTO acct_journal_entries (number, date, description, company_id, status)
    VALUES ('E2E83-FGN-1', CURRENT_DATE, 'Foreign confidential entry', '${FOREIGN}', 'posted');

  FOR r IN SELECT * FROM (VALUES ${values}) AS t(em, rl, nm) LOOP
    DELETE FROM company_members WHERE lower(user_email) = r.em;
    DELETE FROM app_users       WHERE lower(email) = r.em;
    DELETE FROM auth.identities WHERE user_id IN (SELECT id FROM auth.users WHERE lower(email) = r.em);
    DELETE FROM auth.users      WHERE lower(email) = r.em;

    uid := gen_random_uuid();
    -- The eight '' token columns are load-bearing. NULL there = every
    -- sign-in returns "Database error querying schema".
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    VALUES (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      r.em, crypt('${PASSWORD}', gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(),
      '', '', '', '', '', '', '', '');

    INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), uid, uid::text,
      json_build_object('sub', uid::text, 'email', r.em, 'email_verified', true)::jsonb,
      'email', now(), now(), now());

    -- password_set_at non-null, else needsPasswordSetup() traps the
    -- user on the set-password screen and login() never sees a sidebar.
    INSERT INTO app_users (email, name, role, company_id, user_type, password_set_at)
      VALUES (r.em, r.nm, r.rl, '${SANDBOX}', 'pm', now());

    -- The authorization row. App.js reads role from HERE.
    INSERT INTO company_members (company_id, user_email, user_name, role, status, auth_user_id)
      VALUES ('${SANDBOX}', r.em, r.nm, r.rl, 'active', uid);
  END LOOP;
END
$seed$;`);
}

function cleanupAll() {
  const emails = ROLE_KEYS.map(r => `'${USERS[r].email}'`).join(',');
  sql(`
DELETE FROM acct_journal_entries WHERE company_id IN ('${SANDBOX}','${FOREIGN}') AND number LIKE 'E2E83-%';
DELETE FROM properties           WHERE company_id IN ('${SANDBOX}','${FOREIGN}') AND address LIKE 'E2E83 %';
DELETE FROM properties           WHERE company_id = '${FOREIGN}';
DELETE FROM accounting_period_lock WHERE company_id = '${SANDBOX}' AND locked_by LIKE 'e2e-83-%';
DELETE FROM company_members      WHERE company_id = '${FOREIGN}' OR lower(user_email) IN (${emails});
DELETE FROM app_users            WHERE lower(email) IN (${emails});
DELETE FROM auth.identities      WHERE user_id IN (SELECT id FROM auth.users WHERE lower(email) IN (${emails}));
DELETE FROM auth.users           WHERE lower(email) IN (${emails});
DELETE FROM companies            WHERE id = '${FOREIGN}';`);
}

// Signed-in PostgREST clients, one per role, memoised so a full run
// does not trip Supabase's auth rate limiter — but re-authenticated
// before the JWT goes stale.
//
// This matters more than it looks. A full run takes over an hour on a
// shared dev server, and Supabase access tokens last an hour. An
// expired token makes every request fail with 401, which from the
// caller's side is indistinguishable from "RLS refused this write" —
// so a hole test would quietly report the hole as closed. That is the
// single worst failure mode this file can have, so the session is
// renewed with ten minutes to spare and every hole test additionally
// proves the session still works before drawing a conclusion.
const clients = {};
async function apiAs(role) {
  const cached = clients[role];
  if (cached) {
    const { data } = await cached.auth.getSession();
    const expiresAt = data?.session?.expires_at || 0;
    if (expiresAt * 1000 - Date.now() > 10 * 60 * 1000) return cached;
  }
  const c = createClient(SUPA_URL, SUPA_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.signInWithPassword({ email: USERS[role].email, password: PASSWORD });
  if (error) throw new Error(`sign-in as ${role} failed: ${error.message}`);
  clients[role] = c;
  return c;
}

// Prove the client's session is alive before concluding anything from a
// refusal. Without this, an expired JWT reads as "the backend said no".
async function assertSessionAlive(c, role) {
  const { error, count } = await c.from('properties')
    .select('id', { count: 'exact', head: true }).eq('company_id', SANDBOX);
  expect(error, `${role}'s session is broken (${error && error.message}) — a refusal below would be meaningless`).toBeNull();
  expect(count, `${role} cannot read its own company; session is not usable`).toBeGreaterThan(0);
}

// Restore a role to its seeded value. Used immediately after an
// escalation attempt so the assertion (which may throw) can never
// leave a privileged row behind.
function resetRole(role) {
  sql(`UPDATE company_members SET role='${role}' WHERE lower(user_email)='${USERS[role].email}';`);
}

// ── Navigation ─────────────────────────────────────────────────────

// Read <main> as one whitespace-collapsed string.
async function mainText(page) {
  return (await page.evaluate(() => (document.querySelector('main')?.innerText || ''))).replace(/\s+/g, ' ');
}

// Wait until <main> shows text unique to the expected page, and say
// whether it ever did.
//
// The obvious version of this — wait for <main> to be non-empty, then
// test the marker — is wrong twice over. It returns instantly on the
// PREVIOUS page's still-mounted content (false negative), and when a
// page genuinely never renders it burns the full ceiling on every
// route. Polling for the marker itself returns the moment the page is
// really there and only pays the ceiling when something is broken.
// 240s, not 90s: on a cold CRA dev server with several suites sharing
// it, Tenants and Accounting genuinely take minutes to paint. A ceiling
// tight enough to trip on that turns a slow page into a fake
// permissions failure, which is the worst possible lie for this file to
// tell.
async function pageShows(page, re, timeout = 240000) {
  try {
    await page.waitForFunction(
      // Collapse whitespace exactly the way mainText() does. innerText
      // breaks lines wherever the layout does, so a two-word marker
      // ("Archived Tenants") arrives split by a newline and a raw test
      // reports a perfectly rendered page as missing — which reads as a
      // permissions failure. The two must normalise identically.
      ({ src, flags }) => new RegExp(src, flags)
        .test((document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ')),
      { src: re.source, flags: re.flags },
      { timeout, polling: 500 });
    return true;
  } catch (_) {
    return false;
  }
}

// In-app hash navigation. Used for the "can reach" direction, where
// the question is whether the page renders, not how you got there.
async function hashNav(page, route) {
  await page.evaluate((h) => {
    window.history.pushState({ page: h, screen: 'app' }, '', '#' + h);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    window.dispatchEvent(new PopStateEvent('popstate', { state: { page: h, screen: 'app' } }));
  }, route);
  await page.waitForTimeout(400);
}

// Which page won: the one we asked for, the Dashboard the app clamps to
// on refusal, or neither.
//
// Racing the two in a single poll instead of waiting for them in
// sequence is not a micro-optimisation. Waiting for the Dashboard first
// costs the full ceiling on exactly the cases that matter — a route
// that WAS reachable never shows a Dashboard, so the check that finds a
// permission hole is the slowest one in the file.
async function whichPage(page, routeRe, timeout = 120000) {
  try {
    const handle = await page.waitForFunction(
      ({ r, rf, d, df }) => {
        const t = (document.querySelector('main')?.innerText || '').replace(/\s+/g, ' ');
        if (new RegExp(r, rf).test(t)) return 'route';
        if (new RegExp(d, df).test(t)) return 'dashboard';
        return false;
      },
      { r: routeRe.source, rf: routeRe.flags, d: MARKER.dashboard.source, df: MARKER.dashboard.flags },
      { timeout, polling: 500 });
    return await handle.jsonValue();
  } catch (_) {
    return 'neither';
  }
}

// Full cold navigation straight at the URL, which is what an actual
// attacker types. Used for every "cannot reach" assertion.
async function deepLink(page, route, company = SANDBOX) {
  await page.goto(`/?company=${encodeURIComponent(company)}#${route}`, { timeout: 90000 });
}

async function signInAs(page, role) {
  await login(page, { companySlug: SANDBOX, email: USERS[role].email, password: PASSWORD });
}

// ═══════════════════════════════════════════════════════════════════

// Every test in this file signs in as its own user; the shared admin
// storageState would silently give each of them admin rights.
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(() => {
  if (!SUPA_URL || !SUPA_ANON) throw new Error('TEST_SUPABASE_URL / TEST_SUPABASE_ANON_KEY missing from tests/.env');
  seedUsers();
});

test.afterAll(() => {
  cleanupAll();
});

// ───────────────────────────────────────────────────────────────────
test.describe('83.0 — fixtures', () => {
  test('three users exist at admin / manager / office_assistant', () => {
    const rows = sql(`SELECT lower(user_email)||'='||role FROM company_members
      WHERE company_id='${SANDBOX}' AND status='active'
        AND lower(user_email) IN (${ROLE_KEYS.map(r => `'${USERS[r].email}'`).join(',')})
      ORDER BY 1;`).split('\n').filter(Boolean);
    expect(rows.sort()).toEqual(ROLE_KEYS.map(r => `${USERS[r].email}=${r}`).sort());
  });

  test('each user can sign in and PostgREST accepts their JWT', async () => {
    for (const role of ROLE_KEYS) {
      const c = await apiAs(role);
      const { error, count } = await c.from('properties')
        .select('id', { count: 'exact', head: true }).eq('company_id', SANDBOX);
      expect(error, `${role} property read errored`).toBeNull();
      expect(count, `${role} should see sandbox properties`).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────
// 1. CROSS-COMPANY ISOLATION — the most important tests in the file.
// ───────────────────────────────────────────────────────────────────
test.describe('83.1 — cross-company isolation', () => {
  // Every table that carries a company's confidential business data.
  const CONFIDENTIAL = [
    'properties', 'tenants', 'payments', 'owners', 'leases', 'documents',
    'acct_accounts', 'acct_journal_entries', 'acct_classes', 'bank_reconciliations',
    'accounting_period_lock', 'company_members', 'app_users', 'audit_trail',
    'work_orders', 'vendors', 'messages', 'utilities', 'property_loans',
    'property_insurance', 'owner_statements', 'owner_distributions',
  ];

  for (const role of ROLE_KEYS) {
    test(`${role} cannot read ANY Sahil LLC row through the Supabase client (RLS)`, async () => {
      test.setTimeout(180000);
      const c = await apiAs(role);
      await assertSessionAlive(c, role);
      const leaks = [];
      for (const table of CONFIDENTIAL) {
        const { data, error } = await c.from(table).select('*').eq('company_id', SAHIL).limit(5);
        // A missing column / unknown table is not a leak; a row is.
        if (error) continue;
        if (data && data.length) leaks.push(`${table}: ${data.length} row(s)`);
      }
      expect(leaks, `LEAK — ${role} read Sahil LLC data: ${leaks.join(', ')}`).toEqual([]);
    });

    test(`${role}'s unfiltered reads return only their own company`, async () => {
      const c = await apiAs(role);
      await assertSessionAlive(c, role);
      for (const table of ['properties', 'tenants', 'acct_journal_entries', 'acct_accounts']) {
        const { data, error } = await c.from(table).select('company_id').limit(2000);
        expect(error, `${table} errored`).toBeNull();
        const companies = [...new Set((data || []).map(r => r.company_id))];
        expect(companies.filter(x => x !== SANDBOX),
          `LEAK — ${role} saw foreign company_ids in ${table}`).toEqual([]);
      }
    });
  }

  // The sandbox is literally named "E2E Sandbox (copy of Sahil LLC)",
  // so a naive text search for "Sahil LLC" matches the sandbox's own
  // header. Strip the sandbox name first, then any remaining mention of
  // Sahil LLC means the app actually admitted the user into it. The
  // authoritative check is localStorage.lastCompanyId, which App.js
  // writes in handleSelectCompany() for whichever company it resolved.
  const SANDBOX_NAME = 'E2E Sandbox (copy of Sahil LLC)';
  const strip = (t) => t.replace(/\s+/g, ' ').split(SANDBOX_NAME).join('[sandbox]');

  test('a sandbox manager cannot open Sahil LLC by putting its id in the URL', async ({ page }) => {
    test.setTimeout(240000);
    await signInAs(page, 'manager');
    await page.goto(`/?company=${SAHIL}`, { timeout: 90000 });
    await page.waitForTimeout(8000);
    const body = strip(await page.locator('body').innerText());
    expect(body, 'a sandbox member was admitted into Sahil LLC').not.toMatch(/Sahil LLC/i);
    const settled = await page.evaluate(() => { try { return localStorage.getItem('lastCompanyId'); } catch (_) { return null; } });
    expect(settled, 'the app resolved the active company to Sahil LLC').not.toBe(SAHIL);
  });

  test('deep-linking a page WITH Sahil LLC\'s company id still shows no Sahil data', async ({ page }) => {
    test.setTimeout(300000);
    await signInAs(page, 'admin'); // admin OF THE SANDBOX, not of Sahil LLC
    for (const route of ['properties', 'acct_journal', 'tenants']) {
      await deepLink(page, route, SAHIL);
      await page.waitForTimeout(8000);
      const body = strip(await page.locator('body').innerText());
      expect(body, `sandbox admin saw Sahil LLC branding on #${route}`).not.toMatch(/Sahil LLC/i);
      const settled = await page.evaluate(() => { try { return localStorage.getItem('lastCompanyId'); } catch (_) { return null; } });
      expect(settled, `#${route} resolved the active company to Sahil LLC`).not.toBe(SAHIL);
    }
  });

  // HOLE (CRITICAL). company_members' INSERT policy `cm_insert` checks
  // only that the row's user_email matches the caller's JWT email — it
  // never checks the company. Any authenticated user can therefore
  // insert themselves into ANY company with role='admin',
  // status='active' and immediately read that company's books, because
  // every other table's RLS trusts company_members. Reproduced here
  // against a throwaway company; the same insert would work verbatim
  // against any real customer's company id.
  test('a member of one company cannot insert themselves into another company', async () => {
    const c = await apiAs('office_assistant');
    await assertSessionAlive(c, 'office_assistant');
    const ins = await c.from('company_members').insert({
      company_id: FOREIGN, user_email: USERS.office_assistant.email,
      user_name: 'intruder', role: 'admin', status: 'active',
    }).select();

    // Read the foreign books with the membership the insert just granted.
    const props = await c.from('properties').select('address').eq('company_id', FOREIGN);
    const jes = await c.from('acct_journal_entries').select('description').eq('company_id', FOREIGN);

    // Undo before asserting — the assertion is expected to throw.
    sql(`DELETE FROM company_members WHERE company_id='${FOREIGN}';`);

    expect(
      { insertRefused: !!ins.error, foreignProperties: (props.data || []).length, foreignJEs: (jes.data || []).length },
      'HOLE: self-insert into a foreign company succeeded and exposed its data'
    ).toEqual({ insertRefused: true, foreignProperties: 0, foreignJEs: 0 });
  });
});

// ───────────────────────────────────────────────────────────────────
// 2. ROUTE ALLOWLISTS — both directions, per role.
// ───────────────────────────────────────────────────────────────────
for (const role of ROLE_KEYS) {
  const allowed = ROLES[role].filter(r => !DEAD_ROUTES.has(r));
  const effective = expandParents(ROLES[role]);
  // Routes the role is denied AND the parent→children rule does not
  // hand back. These must be refused, no excuses.
  const denied = ALL_ROUTES.filter(r => !effective.has(r) && !DEAD_ROUTES.has(r));
  // Routes ROLES withholds but the parent→children rule grants anyway.
  const leaked = ALL_ROUTES.filter(r => !ROLES[role].includes(r) && effective.has(r) && !DEAD_ROUTES.has(r));

  test.describe(`83.2 — ${role} route allowlist`, () => {
    test(`${role} CAN reach every page its allowlist grants (${allowed.length} routes)`, async ({ page }) => {
      test.setTimeout(1500000);
      await signInAs(page, role);
      const broken = [];
      for (const route of allowed) {
        const t0 = Date.now();
        // Retry the hash navigation, not just the wait. App.js resolves
        // its route from several places at once (the hash listener, the
        // popstate listener, and autoSelectCompany's second pass, which
        // re-pushes pageRef.current), so a hash pushed milliseconds
        // after the previous page mounted can be clobbered before React
        // ever renders it. helpers.gotoRoute retries deep links for the
        // same reason. Waiting longer does not help — the navigation is
        // gone, not slow — so re-issue it before spending the ceiling.
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          await hashNav(page, route);
          ok = await pageShows(page, MARKER[route], attempt === 2 ? 120000 : 20000);
        }
        // 34 routes in one test: without a per-route line, a slow or
        // stuck page is indistinguishable from a slow suite.
        console.log(`      [${role}] ${route} ${ok ? 'rendered' : 'MISSING'} in ${Math.round((Date.now() - t0) / 1000)}s`);
        if (!ok) {
          const txt = await mainText(page);
          broken.push(`${route} (did not render; main="${txt.slice(0, 90)}")`);
        } else if (route !== 'dashboard' && MARKER.dashboard.test(await mainText(page))) {
          broken.push(`${route} (clamped to Dashboard despite being granted)`);
        }
      }
      expect(broken, `${role} could not render granted pages`).toEqual([]);
    });

    if (denied.length) {
      test(`${role} CANNOT reach any page it is not granted, by direct URL (${denied.length} routes)`, async ({ page }) => {
        test.setTimeout(1500000);
        await signInAs(page, role);

        // Control: prove a full cold ?company=…#route navigation DOES
        // land where it is asked to for this role. Without this, every
        // "denied" assertion below could pass simply because deep links
        // are broken.
        const control = allowed.find(r => r !== 'dashboard');
        await deepLink(page, control);
        expect(await pageShows(page, MARKER[control]),
          `deep-link control failed: ${role} could not reach granted #${control} by URL, so the denial results below are meaningless`
        ).toBe(true);

        const reached = [];
        for (const route of denied) {
          await deepLink(page, route);
          const landed = await whichPage(page, MARKER[route]);
          if (landed === 'route') reached.push(`${route} RENDERED`);
          else if (landed !== 'dashboard') {
            reached.push(`${route} did not clamp to Dashboard (main="${(await mainText(page)).slice(0, 90)}")`);
          }
        }
        expect(reached, `${role} reached pages outside its allowlist`).toEqual([]);
      });
    }

    if (leaked.length) {
      // HOLE (privilege widening). ROLES withholds these pages from this
      // role, but App.js's parent→children expansion hands them back
      // because the role has "properties". They are not merely reachable
      // by deep link — the sidebar renders them too, since adminNav
      // shows every child once the parent is allowed. A manager or
      // office_assistant therefore reads mortgage balances (Loans) and
      // policy premiums (Insurance) that the role definition says are
      // admin/owner-only, and an office_assistant gets the bulk Excel
      // property importer.
      test(`${role} cannot reach pages ROLES withholds but the parent→children rule re-grants (${leaked.join(', ')})`, async ({ page }) => {
        test.setTimeout(1500000);
            await signInAs(page, role);
        const reached = [];
        for (const route of leaked) {
          await deepLink(page, route);
          const landed = await whichPage(page, MARKER[route]);
          if (landed === 'route') reached.push(`${route} RENDERED`);
          else if (landed !== 'dashboard') reached.push(`${route} did not clamp to Dashboard`);
        }
        expect(reached, `${role} reached withheld pages via the parent→children rule`).toEqual([]);
      });
    }

    test(`${role} cannot reach the tenant/owner portals`, async ({ page }) => {
      test.setTimeout(300000);
      await signInAs(page, role);
      for (const route of ['tenant_portal', 'tenant_ledger', 'tenant_pay', 'owner_portal']) {
        await deepLink(page, route);
        const clamped = await pageShows(page, MARKER.dashboard);
        expect(clamped,
          `${role} was not clamped away from #${route} (main="${(await mainText(page)).slice(0, 90)}")`).toBe(true);
      }
    });

    test(`${role} is clamped to Dashboard on an unknown route`, async ({ page }) => {
      test.setTimeout(240000);
      await signInAs(page, role);
      await deepLink(page, 'totally-not-a-route');
      expect(await pageShows(page, MARKER.dashboard)).toBe(true);
    });
  });
}

test.describe('83.2x — dead route', () => {
  // Not a permission finding: `autopay` is listed in admin's ROLES
  // allowlist but has no pageComponents entry, so App.js falls through
  // to Dashboard for everyone. Pinned so nobody "fixes" the allowlist
  // and quietly exposes a half-wired page.
  test('#autopay is dead for every role and renders the Dashboard', async ({ page }) => {
    test.setTimeout(240000);
    await signInAs(page, 'admin');
    await deepLink(page, 'autopay');
    expect(await pageShows(page, MARKER.dashboard)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────
// 3. PRIVILEGED ACTIONS — asserted at the API, not the button.
// ───────────────────────────────────────────────────────────────────
test.describe('83.3 — privileged actions (backend enforcement)', () => {

  // office_assistant DOES have "admin" in its allowlist — it gets the
  // Audit Trail — but must not get the team-management tabs.
  test('the Admin page hides Team & Roles / Settings / Error Log from an office_assistant', async ({ page }) => {
    test.setTimeout(300000);
    await signInAs(page, 'office_assistant');
    await deepLink(page, 'admin');
    expect(await pageShows(page, MARKER.admin), 'office_assistant should still reach the Audit Trail').toBe(true);
    const oaText = await mainText(page);
    for (const tab of ['Team & Roles', 'Error Log', 'Settings']) {
      expect(oaText, `office_assistant was shown the "${tab}" tab`).not.toMatch(new RegExp(tab, 'i'));
    }
  });

  test('the Admin page shows Team & Roles to an admin', async ({ page }) => {
    test.setTimeout(300000);
    await signInAs(page, 'admin');
    await deepLink(page, 'admin');
    expect(await pageShows(page, /Team & Roles/i)).toBe(true);
  });

  // HOLE. company_members' UPDATE policies (`cm_update`, `cm_staff_all`)
  // grant write to any active member of the company, not just admins.
  // A manager or office_assistant can PATCH their own membership row to
  // role='admin' with the anon key and their own session — full
  // self-service privilege escalation, no UI involved.
  test('a non-admin cannot escalate their own role to admin', async () => {
    const results = {};
    for (const role of ['manager', 'office_assistant']) {
      const c = await apiAs(role);
      await assertSessionAlive(c, role);
      const { data: mine } = await c.from('company_members')
        .select('id').eq('company_id', SANDBOX).ilike('user_email', USERS[role].email).maybeSingle();
      await c.from('company_members').update({ role: 'admin' }).eq('id', mine.id);
      results[role] = sql(`SELECT role FROM company_members WHERE id=${mine.id};`);
      resetRole(role); // undo BEFORE the assertion can throw
    }
    expect(results, 'HOLE: non-admins escalated themselves to admin')
      .toEqual({ manager: 'manager', office_assistant: 'office_assistant' });
  });

  // HOLE. Same policies also grant DELETE (`cm_delete` USING
  // is_member_of_company). Any active member can evict any other
  // member — including every admin — locking the owner out of their
  // own company.
  test('a non-admin cannot remove another member from the company', async () => {
    const c = await apiAs('office_assistant');
    await assertSessionAlive(c, 'office_assistant');
    const { data: victim } = await c.from('company_members')
      .select('id').eq('company_id', SANDBOX).ilike('user_email', USERS.admin.email).maybeSingle();
    const before = sql(`SELECT count(*) FROM company_members WHERE id=${victim.id};`);
    await c.from('company_members').delete().eq('id', victim.id);
    const after = sql(`SELECT count(*) FROM company_members WHERE id=${victim.id};`);
    if (after === '0') {
      // Undo BEFORE asserting (the assertion is expected to throw).
      // Re-insert only this row — a full re-seed would recycle the auth
      // uids and invalidate every cached JWT client in this file.
      sql(`INSERT INTO company_members (company_id, user_email, user_name, role, status, auth_user_id)
           SELECT '${SANDBOX}', '${USERS.admin.email}', '${USERS.admin.name}', 'admin', 'active', u.id
           FROM auth.users u WHERE lower(u.email)='${USERS.admin.email}';`);
    }
    expect({ before, after }, 'HOLE: an office_assistant deleted an admin\'s membership')
      .toEqual({ before: '1', after: '1' });
  });

  // HOLE. The Reconcile → Period Lock panel prints "Only admin/manager
  // can unlock." for an office_assistant and hides the Remove Lock
  // button. accounting_period_lock's only policy (`apl_company_access`,
  // FOR ALL) grants every active member — tenants and owners included —
  // full write. The office_assistant can DELETE the lock over the API
  // and then backdate entries into a closed period.
  test('an office_assistant cannot remove a period lock the UI forbids them to remove', async () => {
    // Admin sets a lock.
    sql(`DELETE FROM accounting_period_lock WHERE company_id='${SANDBOX}';
         INSERT INTO accounting_period_lock (company_id, lock_date, locked_by, locked_at)
         VALUES ('${SANDBOX}','2020-01-31','e2e-83-admin@propmanager.test', now());`);
    const c = await apiAs('office_assistant');
    await assertSessionAlive(c, 'office_assistant');
    await c.from('accounting_period_lock').delete().eq('company_id', SANDBOX);
    const remaining = sql(`SELECT count(*) FROM accounting_period_lock WHERE company_id='${SANDBOX}';`);
    sql(`DELETE FROM accounting_period_lock WHERE company_id='${SANDBOX}';`);
    expect(remaining, 'HOLE: office_assistant deleted a period lock the UI told them they could not touch')
      .toBe('1');
  });

  // HOLE. Properties.js offers an office_assistant only "Request
  // Delete" (which files a property_change_request for admin approval)
  // and runs a server-side role re-check inside deleteProperty(). Both
  // used to live only in React: `properties_staff` (FOR ALL,
  // is_company_staff) let any non-tenant/owner member DELETE the row
  // outright. Closed by properties_delete (admin/manager only).
  //
  // Asserts on SURVIVAL, not on an error. A DELETE refused by RLS is
  // filtered by the USING clause, so PostgREST reports success with
  // zero rows affected -- it does not raise 42501. Only INSERT/UPDATE
  // WITH CHECK violations raise. Requiring an error here would fail
  // against a correctly locked-down table.
  test('an office_assistant cannot hard-delete a property (UI only offers "Request Delete")', async () => {
    const c = await apiAs('office_assistant');
    await assertSessionAlive(c, 'office_assistant');
    const created = await c.from('properties')
      .insert({ address: 'E2E83 Delete Probe', type: 'Single Family', status: 'vacant', company_id: SANDBOX })
      .select().maybeSingle();
    expect(created.error, 'setup: office_assistant could not create the probe property').toBeNull();
    const id = created.data.id;
    const del = await c.from('properties').delete().eq('id', id).select();
    const gone = sql(`SELECT count(*) FROM properties WHERE id=${id};`) === '0';
    sql(`DELETE FROM properties WHERE id=${id};`); // backstop
    expect({ rowsDeleted: (del.data || []).length, rowGone: gone },
      'HOLE: office_assistant hard-deleted a property the UI would only let them REQUEST to delete')
      .toEqual({ rowsDeleted: 0, rowGone: false });
  });

  test('manager and office_assistant CAN post to the ledger (both are granted Accounting)', async () => {
    for (const role of ['manager', 'office_assistant']) {
      const c = await apiAs(role);
      await assertSessionAlive(c, role);
      const num = `E2E83-JE-${role}`;
      const { error } = await c.from('acct_journal_entries').insert({
        number: num, date: '2026-01-02', description: 'e2e 83 ledger probe',
        company_id: SANDBOX, status: 'posted',
      });
      sql(`DELETE FROM acct_journal_entries WHERE company_id='${SANDBOX}' AND number='${num}';`);
      expect(error, `${role} should be able to post a journal entry`).toBeNull();
    }
  });

  // Not a hole — the opposite. Accounting.js shows the "Re-open"
  // button to admin, owner AND manager, but bank_reconciliations is
  // gated by has_write_access(), whose role list is
  // (admin, office_assistant, accountant, maintenance) — manager is
  // absent. A manager clicks Re-open and gets an RLS error. Pinned so
  // whoever reconciles the two lists sees both halves.
  test('a manager is refused writes to bank_reconciliations despite the UI offering Re-open', async () => {
    const c = await apiAs('manager');
    await assertSessionAlive(c, 'manager');
    const { error } = await c.from('bank_reconciliations').insert({
      company_id: SANDBOX, period: '2026-01', status: 'reconciled',
      bank_ending_balance: 0, book_balance: 0, difference: 0,
    });
    sql(`DELETE FROM bank_reconciliations WHERE company_id='${SANDBOX}' AND period='2026-01';`);
    expect(error, 'manager unexpectedly gained bank_reconciliations write access').not.toBeNull();
    expect(error.code).toBe('42501');
  });

  test('an office_assistant cannot read the error log of a company it does not belong to', async () => {
    const c = await apiAs('office_assistant');
    await assertSessionAlive(c, 'office_assistant');
    const { data, error } = await c.from('error_log').select('*').eq('company_id', SAHIL).limit(5);
    if (!error) expect(data || [], 'LEAK — office_assistant read Sahil LLC error_log').toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────
test.describe('83.9 — reference company untouched', () => {
  test('Sahil LLC still reads 41 properties / 73 tenants / 7,722 entries and balances', () => {
    const props = sql(`SELECT count(*) FROM properties WHERE company_id='${SAHIL}';`);
    const tenants = sql(`SELECT count(*) FROM tenants WHERE company_id='${SAHIL}';`);
    const entries = sql(`SELECT count(*) FROM acct_journal_entries WHERE company_id='${SAHIL}';`);
    const bal = sql(`SELECT round(sum(l.debit)::numeric,2)||'|'||round(sum(l.credit)::numeric,2)
      FROM acct_journal_lines l JOIN acct_journal_entries e ON e.id=l.journal_entry_id
      WHERE e.company_id='${SAHIL}';`);
    expect({ props, tenants, entries, bal })
      .toEqual({ props: '41', tenants: '73', entries: '7722', bal: '53671220.15|53671220.15' });
  });
});
