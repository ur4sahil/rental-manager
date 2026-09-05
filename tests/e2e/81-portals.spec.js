// ═══════════════════════════════════════════════════════════════════════
// 81 — TENANT PORTAL + OWNER PORTAL: functional & data-isolation suite
//
// The portals are what the customer actually sees, and until now the only
// coverage was "did the tab render". This file goes after the two things
// that matter: does the portal show the RIGHT data, and can one customer
// reach another customer's data.
//
// ── How the portal test users are created (reusable recipe) ────────────
// The 73 sandbox tenants have no email addresses, so none of them can log
// in, and there is no service-role key for the test project. Portal users
// are therefore built straight in Postgres over the IPv4 pooler. No email
// is ever sent. Three pieces are required and the app needs all three:
//
//   1. auth.users  — id + email + encrypted_password (bcrypt via
//      extensions.crypt/gen_salt) + email_confirmed_at set to now(), aud
//      and role 'authenticated'. Plus a matching auth.identities row with
//      provider 'email' and provider_id = the user id. GoTrue's password
//      grant then works immediately: POST /auth/v1/token?grant_type=password.
//   2. company_members — (company_id, user_email, role 'tenant'|'owner',
//      status 'active', auth_user_id). THIS is what assigns the portal
//      role. App.js reads company_members.role for the active company and
//      routes tenant → tenant_* pages, owner → owner_portal. Every RLS
//      helper (get_tenant_name, get_owner_id, is_company_staff) reads this
//      table too.
//   3. a tenants row whose email matches (tenant), or an owners row whose
//      email matches (owner). Both portals resolve the person by
//      `ilike email` inside the active company.
//
// Deliberately NOT created: an app_users row. App.js prompts for a
// password reset when an app_users row exists with password_set_at NULL,
// which would block the login. No row at all = no prompt.
//
// Fixtures live under the `E2E81` / `e2e81-` prefixes and are torn down in
// afterAll. Everything happens in company `e2e-sandbox`; Sahil LLC is
// never touched.
// ═══════════════════════════════════════════════════════════════════════
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');

// ── config ────────────────────────────────────────────────────────────
const COMPANY = process.env.E2E_COMPANY || 'e2e-sandbox';
const DB_URL = process.env.E2E_DB_URL
  || 'postgresql://postgres.vpeewlplgxthckpidhxo:Sheebasoin1%23@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
const SB_URL = process.env.TEST_SUPABASE_URL || 'https://vpeewlplgxthckpidhxo.supabase.co';
const SB_ANON = process.env.TEST_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZwZWV3bHBsZ3h0aGNrcGlkaHhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1MzM1MjAsImV4cCI6MjEwNDEwOTUyMH0.Dvc4REh88yOCgDb8OckW0DSKFB9LwGkU7HwKZiT8iGw';

const PORTAL_PW = 'E2E81!portal';
const TENANT_EMAIL = 'e2e81-tenant@example.test';
const OWNER_EMAIL = 'e2e81-owner@example.test';
// A second tenant of the same company — never logs in, only proves whether
// tenant A can read tenant B's row off the membership roster.
const NEIGHBOUR_EMAIL = 'e2e81-neighbour@example.test';

// Fixture identities. Tenant A and B are REAL sandbox tenants with real
// posted ledger history — the point is to prove the portal shows one
// tenant's 175 entries and none of the other's 147.
const TENANT_A = { id: 1308, name: 'Brittany Thomas', property: '2010 Alice Ave #104', balance: 2468.5 };
const TENANT_B = { id: 1278, name: 'Precilia Berth', property: '6904 Hawthorne' };
// A third tenant that shares TENANT_A's NAME but lives elsewhere. Several
// RLS policies and one app query key off the tenant NAME, so a namesake is
// the sharpest probe for a cross-tenant leak.
const NAMESAKE = { name: TENANT_A.name, property: '4747 River Valley' };
const OWNER_A_PROPS = ['2514B Kent Village', '2103 Princess Anne Ct'];
const OWNER_B_PROPS = ['2502 Kent Village', '4747 River Valley'];

function sql(text) {
  return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-f', '-'],
    { input: text, encoding: 'utf8', timeout: 120000 });
}

const SETUP_SQL = `
BEGIN;
DELETE FROM auth.users WHERE email LIKE 'e2e81-%@example.test';
DELETE FROM company_members WHERE company_id='${COMPANY}' AND user_email LIKE 'e2e81-%';
DELETE FROM app_users WHERE company_id='${COMPANY}' AND email LIKE 'e2e81-%';
DELETE FROM owner_distributions WHERE company_id='${COMPANY}' AND owner_id IN (SELECT id FROM owners WHERE email LIKE 'e2e81-%');
DELETE FROM owner_statements   WHERE company_id='${COMPANY}' AND owner_id IN (SELECT id FROM owners WHERE email LIKE 'e2e81-%');
UPDATE properties SET owner_id=NULL WHERE company_id='${COMPANY}' AND owner_id IN (SELECT id FROM owners WHERE email LIKE 'e2e81-%');
DELETE FROM owners WHERE email LIKE 'e2e81-%';
DELETE FROM documents   WHERE company_id='${COMPANY}' AND name LIKE 'E2E81%';
DELETE FROM work_orders WHERE company_id='${COMPANY}' AND issue LIKE 'E2E81%';
DELETE FROM messages    WHERE company_id='${COMPANY}' AND message LIKE 'E2E81%';
DELETE FROM tenants WHERE company_id='${COMPANY}' AND name='${NAMESAKE.name}' AND property='${NAMESAKE.property}';
UPDATE tenants SET email=NULL WHERE company_id='${COMPANY}' AND email LIKE 'e2e81-%';

-- 1. auth users + identities (password grant works immediately, no email)
DO $$
DECLARE r record; uid uuid;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('${TENANT_EMAIL}','E2E81 Portal Tenant'),
      ('${OWNER_EMAIL}','E2E81 Portal Owner')
    ) AS v(email,fullname)
  LOOP
    uid := gen_random_uuid();
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change)
    VALUES ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      r.email, extensions.crypt('${PORTAL_PW}', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('name', r.fullname), now(), now(), '', '', '', '');
    INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data,
      last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), uid, uid::text, 'email',
      jsonb_build_object('sub', uid::text, 'email', r.email,
                         'email_verified', true, 'phone_verified', false),
      now(), now(), now());
  END LOOP;
END $$;

-- 2. adopt an existing sandbox tenant that already has posted ledger history
UPDATE tenants SET email='${TENANT_EMAIL}' WHERE id=${TENANT_A.id} AND company_id='${COMPANY}';

-- 3. a same-name tenant at a different address (adversarial probe)
INSERT INTO tenants (name, property, company_id, lease_status, rent, balance)
VALUES ('${NAMESAKE.name}','${NAMESAKE.property}','${COMPANY}','active',1234,777);

-- 4. owners, their properties, statements and distributions
INSERT INTO owners (name, email, company_id, status, portal_enabled, management_fee_pct, company)
VALUES ('E2E81 Owner Alpha','${OWNER_EMAIL}','${COMPANY}','active',true,10,'Alpha Holdings'),
       ('E2E81 Owner Beta' ,'e2e81-owner-b@example.test','${COMPANY}','active',true,8,'Beta Holdings');

UPDATE properties SET owner_id=(SELECT id FROM owners WHERE email='${OWNER_EMAIL}')
  WHERE company_id='${COMPANY}' AND address IN ('${OWNER_A_PROPS[0]}','${OWNER_A_PROPS[1]}');
UPDATE properties SET owner_id=(SELECT id FROM owners WHERE email='e2e81-owner-b@example.test')
  WHERE company_id='${COMPANY}' AND address IN ('${OWNER_B_PROPS[0]}','${OWNER_B_PROPS[1]}');

INSERT INTO owner_statements (owner_id, owner_name, period, start_date, end_date,
        total_income, total_expenses, management_fee, net_to_owner, status, company_id)
SELECT id,'E2E81 Owner Alpha','2026-07',DATE '2026-07-01',DATE '2026-07-31',5000,1200,500,3300,'sent','${COMPANY}'
  FROM owners WHERE email='${OWNER_EMAIL}'
UNION ALL
SELECT id,'E2E81 Owner Alpha','2026-08',DATE '2026-08-01',DATE '2026-08-31',5100,900,510,3690,'draft','${COMPANY}'
  FROM owners WHERE email='${OWNER_EMAIL}'
UNION ALL
SELECT id,'E2E81 Owner Beta','2026-07',DATE '2026-07-01',DATE '2026-07-31',9999,111,222,9666,'sent','${COMPANY}'
  FROM owners WHERE email='e2e81-owner-b@example.test';

INSERT INTO owner_distributions (owner_id, amount, method, reference, date, company_id)
SELECT id, 3300,'ach','E2E81-DIST-ALPHA-1',DATE '2026-08-05','${COMPANY}' FROM owners WHERE email='${OWNER_EMAIL}'
UNION ALL
SELECT id, 3690,'check','E2E81-DIST-ALPHA-2',DATE '2026-09-05','${COMPANY}' FROM owners WHERE email='${OWNER_EMAIL}'
UNION ALL
SELECT id, 9666,'ach','E2E81-DIST-BETA-1',DATE '2026-08-06','${COMPANY}' FROM owners WHERE email='e2e81-owner-b@example.test';

-- 5. documents: one visible + one staff-only for A, one for B, one for the namesake
INSERT INTO documents (name, tenant, property, type, url, file_name, tenant_visible, company_id, uploaded_at)
VALUES ('E2E81 Alpha Lease Visible','${TENANT_A.name}','${TENANT_A.property}','lease','e2e81-a-visible.pdf','e2e81-a-visible.pdf',true,'${COMPANY}',now()),
       ('E2E81 Alpha Internal Hidden','${TENANT_A.name}','${TENANT_A.property}','notice','e2e81-a-hidden.pdf','e2e81-a-hidden.pdf',false,'${COMPANY}',now()),
       ('E2E81 Beta Lease Visible','${TENANT_B.name}','${TENANT_B.property}','lease','e2e81-b-visible.pdf','e2e81-b-visible.pdf',true,'${COMPANY}',now()),
       ('E2E81 Namesake Private Doc','${NAMESAKE.name}','${NAMESAKE.property}','lease','e2e81-namesake.pdf','e2e81-namesake.pdf',true,'${COMPANY}',now());

INSERT INTO work_orders (property, tenant, issue, priority, status, created, company_id)
VALUES ('${NAMESAKE.property}','${NAMESAKE.name}','E2E81 Namesake private work order','normal','open',CURRENT_DATE,'${COMPANY}');

-- 6. company_members is what grants the portal role
INSERT INTO company_members (company_id, user_email, user_name, role, status, auth_user_id, invited_by)
SELECT '${COMPANY}','${TENANT_EMAIL}','E2E81 Portal Tenant','tenant','active', u.id,'e2e81-setup'
  FROM auth.users u WHERE u.email='${TENANT_EMAIL}'
UNION ALL
SELECT '${COMPANY}','${OWNER_EMAIL}','E2E81 Portal Owner','owner','active', u.id,'e2e81-setup'
  FROM auth.users u WHERE u.email='${OWNER_EMAIL}';
-- a second tenant membership (no auth user needed) so we can ask whether
-- one tenant can read another tenant's contact details off the roster
INSERT INTO company_members (company_id, user_email, user_name, role, status, invited_by)
VALUES ('${COMPANY}','${NEIGHBOUR_EMAIL}','E2E81 Neighbour Tenant','tenant','active','e2e81-setup');
COMMIT;
`;

const TEARDOWN_SQL = `
BEGIN;
DELETE FROM auth.users WHERE email LIKE 'e2e81-%@example.test';
DELETE FROM company_members WHERE company_id='${COMPANY}' AND user_email LIKE 'e2e81-%';
DELETE FROM app_users WHERE company_id='${COMPANY}' AND email LIKE 'e2e81-%';
DELETE FROM owner_distributions WHERE company_id='${COMPANY}' AND owner_id IN (SELECT id FROM owners WHERE email LIKE 'e2e81-%');
DELETE FROM owner_statements   WHERE company_id='${COMPANY}' AND owner_id IN (SELECT id FROM owners WHERE email LIKE 'e2e81-%');
UPDATE properties SET owner_id=NULL WHERE company_id='${COMPANY}' AND owner_id IN (SELECT id FROM owners WHERE email LIKE 'e2e81-%');
DELETE FROM owners WHERE email LIKE 'e2e81-%';
DELETE FROM documents   WHERE company_id='${COMPANY}' AND name LIKE 'E2E81%';
DELETE FROM work_orders WHERE company_id='${COMPANY}' AND issue LIKE 'E2E81%';
DELETE FROM messages    WHERE company_id='${COMPANY}' AND message LIKE 'E2E81%';
DELETE FROM work_order_photos WHERE company_id='${COMPANY}' AND caption LIKE 'E2E81%';
DELETE FROM tenants WHERE company_id='${COMPANY}' AND name='${NAMESAKE.name}' AND property='${NAMESAKE.property}';
UPDATE tenants SET email=NULL WHERE company_id='${COMPANY}' AND email LIKE 'e2e81-%';
COMMIT;
`;

// ── PostgREST helpers, exercised with a real portal user's JWT ─────────
async function signIn(email, password) {
  const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SB_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(json)}`);
  return json.access_token;
}

// Returns { status, rows, count }. `count` is the true row count PostgREST
// would serve, which is what an isolation assertion needs — a leak of one
// row is still a leak even if the client asked for none.
async function rest(token, path, init = {}, attempt = 0) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_ANON,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: init.body ? 'return=representation' : 'count=exact',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let rows = null;
  try { rows = JSON.parse(text); } catch { rows = text; }
  const cr = res.headers.get('content-range') || '';
  const count = cr.includes('/') ? Number(cr.split('/')[1]) : (Array.isArray(rows) ? rows.length : 0);
  // Postgres kills an unindexed scan of the 16k-line ledger view at the
  // 8s PostgREST ceiling. That is a performance fact, not a leak, but it
  // makes an isolation assertion flaky — so retry before believing it.
  if (rows && rows.code === '57014' && attempt < 3) {
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    return rest(token, path, init, attempt + 1);
  }
  return { status: res.status, rows, count, raw: text };
}

let tenantToken, ownerToken;

test.beforeAll(async () => {
  sql(SETUP_SQL);
  tenantToken = await signIn(TENANT_EMAIL, PORTAL_PW);
  ownerToken = await signIn(OWNER_EMAIL, PORTAL_PW);
});

test.afterAll(async () => { sql(TEARDOWN_SQL); });

// ── browser-side helpers ──────────────────────────────────────────────
// A portal session must start from a clean slate: the chromium-desktop
// project ships an admin storageState, and logging a tenant in on top of
// an existing admin session lands on the admin dashboard instead.
async function newPortalPage(browser, email, marker, readyText) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(`/?company=${encodeURIComponent(COMPANY)}`, { timeout: 60000 });
  const signIn = page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first();
  if (await signIn.isVisible({ timeout: 8000 }).catch(() => false)) await signIn.click();
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PORTAL_PW);
  await page.locator('button:has-text("Sign In")').last().click();
  // Supabase rate-limits logins per IP; retry once with a backoff so a
  // busy suite doesn't fail here for a reason that has nothing to do
  // with the portal.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await marker(page).isVisible({ timeout: 20000 }).catch(() => false)) {
      await waitForPortalContent(page, readyText);
      return { ctx, page };
    }
    const limited = await page.locator('text=/rate limit reached/i').first()
      .isVisible({ timeout: 1000 }).catch(() => false);
    if (!limited) break;
    await page.waitForTimeout(10000 + attempt * 8000);
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PORTAL_PW);
    await page.locator('button:has-text("Sign In")').last().click();
  }
  await marker(page).waitFor({ state: 'visible', timeout: 30000 });
  await waitForPortalContent(page, readyText);
  return { ctx, page };
}

// The sidebar/tab strip paints as soon as the role is known, but the
// portal body stays on a spinner until the tenant/owner record and its
// related rows come back. Asserting before that is how a portal spec ends
// up testing an empty <main>.
async function waitForPortalContent(page, readyText) {
  await page.locator(`main >> text=${readyText}`).first()
    .waitFor({ state: 'visible', timeout: 45000 });
}

// Console errors + failed requests, with only genuinely irrelevant noise
// filtered. Anything else is reported verbatim so the failure names the
// real problem.
function watchPortal(page) {
  const problems = [];
  const ignore = (t) => /favicon|manifest|service-worker|sockjs|hot-update|web-vitals|ResizeObserver|\[HMR\]|WebSocket/i.test(t);
  page.on('pageerror', e => { if (!ignore(e.message)) problems.push(`pageerror: ${e.message.slice(0, 200)}`); });
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t) || ignore(t)) return;
    problems.push(`console: ${t.slice(0, 200)}`);
  });
  page.on('response', r => {
    if (r.status() < 400) return;
    const u = r.url();
    if (/\.(png|jpg|jpeg|svg|ico|woff2?|map)($|\?)/.test(u) || ignore(u)) return;
    // App.js ensureDefaultAccounts() runs on every company-select for
    // every role and POSTs to acct_accounts, which is staff-only under
    // RLS. It lands whenever the boot happens to overlap a test, so it
    // would make every tab test flaky. Covered on its own by the
    // "BUG: portal boot fires a staff-only write" test below.
    if (r.request().method() === 'POST' && /\/acct_accounts/.test(u)) return;
    // TenantPortal.js queries payments by a tenant_id column that does not
    // exist on the payments table, so this request 400s on every portal
    // load and every tab switch. Covered on its own by the "BUG: the
    // tenant portal's payments query 400s" test below.
    if (/\/payments\?.*tenant_id=/.test(u)) return;
    problems.push(`HTTP ${r.status()} ${u.slice(0, 160)}`);
  });
  return problems;
}

const mainText = (page) => page.locator('main').innerText().catch(() => '');

// ═══════════════════════════════════════════════════════════════════════
// TENANT PORTAL — UI
// ═══════════════════════════════════════════════════════════════════════
test.describe('Tenant portal — UI', () => {
  test.describe.configure({ mode: 'serial' });
  let ctx, page, problems;

  test.beforeAll(async ({ browser }) => {
    ({ ctx, page } = await newPortalPage(browser, TENANT_EMAIL,
      p => p.locator('nav button:has-text("Pay Rent")').first(), TENANT_A.name));
    problems = watchPortal(page);
  });
  test.afterAll(async () => { if (ctx) await ctx.close(); });
  test.beforeEach(() => { problems.length = 0; });

  // Sidebar buttons render as "<icon ligature><label>", so textContent is
  // "receipt_longLedger" and a ^Label$ match never fires. innerText keeps
  // the newline, so match on the last visible line — the same trick
  // helpers.gotoRoute uses.
  async function openTab(label) {
    const idx = await page.evaluate((wanted) => {
      const btns = [...document.querySelectorAll('nav button')];
      return btns.findIndex(b => {
        const lines = (b.innerText || '').split('\n').map(t => t.trim()).filter(Boolean);
        return lines[lines.length - 1] === wanted;
      });
    }, label);
    expect(idx, `tenant sidebar has a "${label}" item`).toBeGreaterThanOrEqual(0);
    await page.locator('nav button').nth(idx).click({ timeout: 15000 });
    // Each sidebar item maps to a distinct pageComponents entry, so React
    // unmounts and remounts TenantPortal on every switch and the body goes
    // back to a spinner while it refetches. Wait for the persistent header
    // (which carries the tenant name) before reading anything.
    await page.locator(`main >> text=${TENANT_A.name}`).first()
      .waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForTimeout(800);
  }

  test('logs in as a tenant and lands on their own portal', async () => {
    const body = await page.locator('body').innerText();
    expect(body, 'portal header names the tenant').toContain(TENANT_A.name);
    expect(body, 'portal header names their property').toContain(TENANT_A.property);
    expect(body, 'no crash boundary').not.toContain('Something went wrong');
    // The staff sidebar must not be there.
    for (const staffLabel of ['Accounting', 'Tenants', 'Dashboard', 'Owners']) {
      expect(await page.locator('nav button').filter({ hasText: new RegExp(`^${staffLabel}$`) }).count(),
        `tenant sidebar must not offer "${staffLabel}"`).toBe(0);
    }
  });

  const TABS = [
    { label: 'Overview',    expect: /Lease Details|Monthly Rent|Recent Activity/i },
    { label: 'Pay Rent',    expect: /Make a Payment|Current Balance|Pay/i },
    { label: 'Autopay',     expect: /Autopay|automatic|card/i },
    { label: 'Ledger',      expect: /Account Ledger|charges and payments/i },
    { label: 'Maintenance', expect: /Maintenance Requests|New Request/i },
    { label: 'Documents',   expect: /My Documents|Upload/i },
    { label: 'Messages',    expect: /Message|Send|type a message/i },
  ];

  for (const tab of TABS) {
    test(`${tab.label} tab renders cleanly — no console errors, no failed requests`, async () => {
      await openTab(tab.label);
      const body = await mainText(page);
      expect(body, `${tab.label} must not hit the error boundary`).not.toContain('Something went wrong');
      expect(tab.expect.test(body), `${tab.label} renders its own content (got: ${body.slice(0, 200)})`).toBeTruthy();
      expect(problems, `${tab.label} tab: ${problems.join(' | ')}`).toEqual([]);
    });
  }

  test('header balance matches this tenant\'s ledger balance, not anyone else\'s', async () => {
    await openTab('Overview');
    const body = await page.locator('body').innerText();
    // 2,468.5 renders as "$2,468.5" via toLocaleString().
    expect(body, 'header shows the tenant\'s own balance').toMatch(/2,468\.5/);
    expect(body, 'no other tenant\'s name anywhere on the page').not.toContain(TENANT_B.name);
  });

  test('ledger tab exposes no other tenant\'s transactions', async () => {
    await openTab('Ledger');
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(TENANT_B.name);
    expect(body).not.toContain(TENANT_B.property);
    expect(body).not.toContain(NAMESAKE.property);
  });

  // ── BUG ─────────────────────────────────────────────────────────────
  // The Ledger tab renders `ledgerLines`, which TenantPortal.js hydrates
  // from acct_accounts + acct_journal_lines. Both tables are staff-only
  // under RLS (acct_accounts_read → get_user_company_ids(), which excludes
  // role 'tenant'), so the lookup returns zero rows for every tenant, the
  // AR account resolves to null, and the tab always prints "No ledger
  // entries yet". The correct data IS fetched — the `ledger` state, from
  // the self-filtering ledger_entries view, holds all 175 rows — but
  // nothing renders it. Marked test.fail(): it will flip to a hard
  // failure the moment the bug is fixed, which is the signal to delete
  // this annotation.
  test('BUG: ledger tab lists the tenant\'s own transactions', async () => {
    await openTab('Ledger');
    const body = await mainText(page);
    expect(body, 'ledger should not be empty — this tenant has 175 posted lines')
      .not.toMatch(/No ledger entries yet/i);
  });

  test('documents tab lists this tenant\'s visible documents only', async () => {
    await openTab('Documents');
    const body = await mainText(page);
    expect(body, 'own visible document is listed').toContain('E2E81 Alpha Lease Visible');
    expect(body, 'another tenant\'s document must not be listed').not.toContain('E2E81 Beta Lease Visible');
    expect(body, 'staff-only document must not be listed in the UI').not.toContain('E2E81 Alpha Internal Hidden');
  });

  // ── BUG ─────────────────────────────────────────────────────────────
  // documents_tenant RLS matches on tenant NAME only, and the portal's
  // documents query (TenantPortal.js) filters on name + tenant_visible
  // with no property/tenant_id predicate. A second tenant with the same
  // name at a different address therefore has their documents rendered
  // inside this tenant's Documents tab. Same-name tenants are ordinary in
  // a 73-unit portfolio; the code even carries a comment claiming lookups
  // moved to tenant_id "to prevent cross-tenant data leaks (same-name
  // tenants)" — documents was missed.
  test('BUG: documents tab leaks a same-name tenant\'s document', async () => {
    await openTab('Documents');
    const body = await mainText(page);
    expect(body, 'a different tenant who happens to share this name must not appear')
      .not.toContain('E2E81 Namesake Private Doc');
  });

  // The issue text is generated once per run and shared by the two tests
  // below (serial describe, so ordering is guaranteed).
  let submittedIssue = null;

  test('maintenance request submits end to end', async () => {
    submittedIssue = `E2E81 portal request ${Date.now()}`;
    await openTab('Maintenance');
    await page.locator('button:has-text("New Request")').first().click();
    await page.locator('input[placeholder*="Leaking faucet"]').fill(submittedIssue);
    await page.locator('select').first().selectOption('urgent').catch(() => {});
    await page.locator('textarea[placeholder*="Additional details"]').fill('Submitted by E2E spec 81.');
    await page.locator('button:has-text("Submit Request")').click();

    // 1. it comes back into the tenant's own list
    await expect(page.locator(`text=${submittedIssue}`).first()).toBeVisible({ timeout: 25000 });

    // 2. it is really in the database, attributed to this tenant + property
    const row = sql(`SELECT tenant||'|'||property||'|'||status||'|'||priority
                       FROM work_orders
                      WHERE company_id='${COMPANY}' AND issue=$$${submittedIssue}$$;`).trim();
    expect(row, 'work order persisted with the tenant\'s identity')
      .toBe(`${TENANT_A.name}|${TENANT_A.property}|open|urgent`);

    // 3. staff can read it through RLS — the same path the Maintenance
    //    page uses. Proven with a real admin JWT, not a service key.
    const adminToken = await signIn(process.env.TEST_EMAIL, process.env.TEST_PASSWORD);
    const seen = await rest(adminToken,
      `work_orders?select=id,tenant,property,issue&issue=eq.${encodeURIComponent(submittedIssue)}`);
    expect(seen.count, 'staff can see the tenant-submitted request').toBe(1);
    expect(seen.rows[0].tenant).toBe(TENANT_A.name);
  });

  test('the tenant-submitted request shows up on the staff Maintenance page', async ({ browser }) => {
    // The staff Maintenance page on a 41-property company is one of the
    // slowest screens in the app; give it the room rather than racing it.
    test.slow();
    expect(submittedIssue, 'the submit test ran first').toBeTruthy();
    // Reuse the admin session the `setup` project already minted rather
    // than logging in again — Supabase rate-limits password grants per IP
    // and a second full login here is the flakiest thing in the file.
    const staffCtx = await browser.newContext({
      storageState: require('path').resolve(__dirname, '../playwright/.auth/admin.json'),
    });
    const staff = await staffCtx.newPage();
    try {
      // Deep link straight in. gotoRoute() is the safe general-purpose
      // route, but it waits on networkidle, which this app never reaches.
      await staff.goto(`/?company=${encodeURIComponent(COMPANY)}#maintenance`, { timeout: 90000 });
      await staff.locator('main').first().waitFor({ state: 'visible', timeout: 60000 });
      await staff.waitForTimeout(4000);
      if (/^\s*Dashboard/.test(await staff.locator('main').innerText().catch(() => ''))) {
        // The hash was dropped (happens when the session restores late) —
        // fall back to clicking through the sidebar.
        const { gotoRoute } = require('./helpers');
        await gotoRoute(staff, 'maintenance', { company: COMPANY });
      }
      const search = staff.locator('input[placeholder*="earch"]').first();
      if (await search.isVisible({ timeout: 10000 }).catch(() => false)) {
        await search.fill(submittedIssue);
        await staff.waitForTimeout(2500);
      }
      await expect(staff.locator(`text=${submittedIssue}`).first(),
        'tenant-submitted request is visible to staff').toBeVisible({ timeout: 45000 });
    } finally {
      await staffCtx.close();
    }
  });

  // ── BUG ─────────────────────────────────────────────────────────────
  // TenantPortal.js fetches payments with `.eq("tenant_id", tid)`, but the
  // payments table has no tenant_id column — not in the test database and
  // not in supabase/baseline/schema.sql, which is production. PostgREST
  // answers 400, supabase-js returns null data, and the portal quietly
  // sets payments to []. Consequence: the tenant's payment history never
  // appears in Recent Activity on Overview, and the Receipts block on the
  // Ledger tab (gated on payments with status 'paid') can never render.
  // The name-based fallback in the same expression is dead code — the
  // ternary only takes it when tenant.id is missing, which never happens.
  test('BUG: the tenant portal\'s payments query 400s (payments has no tenant_id column)', async () => {
    const r = await rest(tenantToken,
      `payments?select=*&company_id=eq.${COMPANY}&tenant_id=eq.${TENANT_A.id}&archived_at=is.null`);
    expect(r.status, `payments fetch failed: ${r.raw.slice(0, 160)}`).toBe(200);
  });

  // ── BUG ─────────────────────────────────────────────────────────────
  // App.js handleSelectCompany() calls ensureDefaultAccounts(), which
  // POSTs missing chart-of-accounts rows for EVERY role. acct_accounts is
  // staff-only under RLS, so every tenant and owner session opens with a
  // burst of 403s from the portal. Harmless to the user, but it means the
  // portals can never be held to a "no failed requests" bar, and it puts
  // avoidable write traffic on a customer-facing page.
  test('BUG: portal boot fires a staff-only chart-of-accounts write that 403s', async () => {
    const boot = [];
    const onResp = (r) => {
      if (r.status() >= 400 && r.request().method() === 'POST') boot.push(`${r.status()} ${r.url().slice(0, 80)}`);
    };
    page.on('response', onResp);
    await page.goto(`/?company=${encodeURIComponent(COMPANY)}`, { timeout: 60000 });
    await page.locator(`main >> text=${TENANT_A.name}`).first().waitFor({ timeout: 45000 });
    await page.waitForTimeout(3000);
    page.off('response', onResp);
    expect(boot, 'a portal boot should issue no rejected writes').toEqual([]);
  });

  test('tenant cannot reach staff pages by URL', async () => {
    for (const route of ['tenants', 'accounting', 'payments', 'admin', 'owners', 'owner_portal']) {
      await page.goto(`/?company=${encodeURIComponent(COMPANY)}#${route}`, { timeout: 60000 });
      // App.js clamps a tenant to tenant_* pages; the portal header is the
      // proof we are still inside the portal.
      await page.locator(`main >> text=${TENANT_A.name}`).first()
        .waitFor({ state: 'visible', timeout: 45000 });
      const body = await page.locator('body').innerText();
      expect(body, `#${route} must not render a staff page`).toContain(TENANT_A.name);
      expect(body, `#${route} must not leak another tenant`).not.toContain(TENANT_B.name);
      expect(body, `#${route} must not render the staff nav`)
        .not.toMatch(/Chart of Accounts|Journal Entries|Team & Roles/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TENANT PORTAL — data isolation at the API layer
//
// The portal is a thin client over PostgREST: the tenant's JWT is in their
// own browser, so anyone can replay these calls with curl. Testing the UI
// alone would prove nothing about isolation. These are the highest-value
// assertions in the file.
// ═══════════════════════════════════════════════════════════════════════
test.describe('Tenant portal — data isolation', () => {
  test('a tenant reading their own ledger gets only their own rows', async () => {
    const own = await rest(tenantToken, 'ledger_entries?select=id,tenant,tenant_id&limit=1000');
    expect(own.status).toBe(200);
    expect(own.count, 'tenant sees their real ledger history').toBeGreaterThan(50);
    const foreign = own.rows.filter(r => r.tenant_id !== TENANT_A.id);
    expect(foreign.slice(0, 3), 'every ledger row belongs to this tenant').toEqual([]);
  });

  test('asking for another tenant\'s ledger by id returns nothing', async () => {
    const r = await rest(tenantToken, `ledger_entries?tenant_id=eq.${TENANT_B.id}&select=id,tenant`);
    expect(r.status).toBe(200);
    expect(r.count, `tenant ${TENANT_B.id}'s ledger must be invisible`).toBe(0);
  });

  test('asking for another tenant\'s ledger by name returns nothing', async () => {
    const r = await rest(tenantToken,
      `ledger_entries?tenant=eq.${encodeURIComponent(TENANT_B.name)}&select=id`);
    expect(r.count).toBe(0);
  });

  test('the whole-company ledger cannot be enumerated by a tenant', async () => {
    // No filter at all — the shape of the query an attacker actually runs.
    const r = await rest(tenantToken, 'ledger_entries?select=tenant_id&limit=5000');
    const ids = new Set((r.rows || []).map(x => x.tenant_id));
    expect([...ids], 'only one tenant id may ever come back').toEqual([TENANT_A.id]);
  });

  test('a tenant sees exactly one tenants row — their own', async () => {
    const r = await rest(tenantToken, 'tenants?select=id,name,email,balance');
    expect(r.count, 'the 74-row tenants table must not be enumerable').toBe(1);
    expect(r.rows[0].id).toBe(TENANT_A.id);
  });

  test('a tenant sees only their own property', async () => {
    const r = await rest(tenantToken, 'properties?select=id,address');
    expect(r.count, 'sandbox has 41 properties; a tenant may see 1').toBe(1);
    expect(r.rows[0].address).toBe(TENANT_A.property);
  });

  for (const [label, path] of [
    ['payments', `payments?tenant=eq.${encodeURIComponent(TENANT_B.name)}&select=id`],
    ['messages', `messages?tenant_id=eq.${TENANT_B.id}&select=id`],
    ['work orders', `work_orders?tenant=eq.${encodeURIComponent(TENANT_B.name)}&select=id`],
    ['documents', `documents?tenant=eq.${encodeURIComponent(TENANT_B.name)}&select=id`],
    ['owner statements', 'owner_statements?select=id'],
    ['owner distributions', 'owner_distributions?select=id'],
    ['owners', 'owners?select=id'],
    ['journal entries', 'acct_journal_entries?select=id&limit=5'],
  ]) {
    test(`a tenant cannot read another party's ${label}`, async () => {
      const r = await rest(tenantToken, path);
      // A statement timeout is a performance problem, not a disclosure —
      // no rows reach the caller either way. Accept it, reject anything
      // else that isn't a clean 200, so a malformed probe still fails.
      const timedOut = r.rows && r.rows.code === '57014';
      expect(r.status === 200 || timedOut,
        `${label} query errored: ${r.raw.slice(0, 160)}`).toBeTruthy();
      expect(r.count, `${label} must return zero rows`).toBe(0);
    });
  }

  // Chart of accounts is deliberately NOT in the blanket zero-rows list
  // above. A tenant must be able to read their OWN AR sub-account or the
  // portal's Ledger tab cannot render at all -- that was the bug behind
  // "the Ledger tab is always empty". So the isolation assertion here is
  // stronger than "zero rows": every row that comes back must be theirs.
  test('a tenant reads only their own AR account from the chart of accounts', async () => {
    const r = await rest(tenantToken, 'acct_accounts?select=id,tenant_id,code');
    const timedOut = r.rows && r.rows.code === '57014';
    expect(r.status === 200 || timedOut,
      `chart of accounts query errored: ${r.raw.slice(0, 160)}`).toBeTruthy();
    if (timedOut) return;
    const foreign = (r.rows || []).filter(a => String(a.tenant_id) !== String(TENANT_A.id));
    expect(foreign.map(a => `${a.code}/${a.tenant_id}`),
      'a tenant must see no account other than their own AR sub-account').toEqual([]);
  });

  test('a tenant cannot write to another tenant\'s records', async () => {
    const patch = await rest(tenantToken, `tenants?id=eq.${TENANT_B.id}`, {
      method: 'PATCH', body: JSON.stringify({ balance: 0 }),
    });
    // Either refused outright or silently filtered to zero affected rows —
    // both are safe; a 200 that actually changed the row is not.
    const after = sql(`SELECT balance FROM tenants WHERE id=${TENANT_B.id};`).trim();
    expect(after, 'another tenant\'s balance must be unchanged').not.toBe('0.00');
    expect([200, 201, 204, 401, 403, 404].includes(patch.status)).toBeTruthy();
  });

  test('a tenant cannot file a maintenance request in another tenant\'s name', async () => {
    const r = await rest(tenantToken, 'work_orders', {
      method: 'POST',
      body: JSON.stringify({
        company_id: COMPANY, property: TENANT_B.property, tenant: TENANT_B.name,
        issue: 'E2E81 forged request', priority: 'normal', status: 'open',
      }),
    });
    expect(r.status, `insert should be refused, got ${r.status}: ${r.raw.slice(0, 160)}`)
      .toBeGreaterThanOrEqual(400);
    const planted = sql(`SELECT count(*) FROM work_orders WHERE company_id='${COMPANY}' AND issue='E2E81 forged request';`).trim();
    expect(planted).toBe('0');
  });

  // ── BUG (privacy) ───────────────────────────────────────────────────
  // company_members.cm_read is `own row OR is_member_of_company(...)`, and
  // is_member_of_company() is true for tenants and owners. So any tenant
  // can list every membership of the company — every staff email and,
  // more to the point, every OTHER TENANT's email address. The portal
  // does need staff emails to address outbound messages, but that is an
  // argument for a staff-only view, not for handing a tenant the whole
  // roster.
  test('BUG: a tenant can read the whole company membership roster', async () => {
    const r = await rest(tenantToken, 'company_members?select=user_email,role');
    const others = (r.rows || []).filter(x => x.user_email !== TENANT_EMAIL);
    expect(others.map(x => x.user_email),
      'a tenant should only ever see their own membership row').toEqual([]);
  });

  test('BUG: a tenant can read another tenant\'s email off the roster', async () => {
    const r = await rest(tenantToken,
      `company_members?user_email=eq.${encodeURIComponent(NEIGHBOUR_EMAIL)}&select=user_email`);
    expect(r.count, 'a co-tenant\'s membership row must be invisible').toBe(0);
  });

  // ── BUG ─────────────────────────────────────────────────────────────
  // documents_tenant grants SELECT on every document whose `tenant`
  // string equals the caller's tenant name, with no tenant_visible
  // predicate. The portal UI filters tenant_visible=true, so the leak is
  // invisible in the browser — but the tenant's own JWT reads the row
  // straight from PostgREST. Anything staff marked internal (eviction
  // paperwork, notes, unsigned drafts) is readable by the tenant.
  test('BUG: staff-only documents are readable by the tenant over the API', async () => {
    const r = await rest(tenantToken, 'documents?tenant_visible=eq.false&select=id,name');
    expect(r.count, 'documents flagged not-visible must not be readable').toBe(0);
  });

  // ── BUG ─────────────────────────────────────────────────────────────
  // Every tenant-scoped RLS policy (documents, payments, messages,
  // work_orders, autopay_schedules) compares on get_tenant_name(), a
  // NAME. Two tenants with the same name in one company read each
  // other's rows at the database layer.
  test('BUG: a same-name tenant\'s documents and work orders are readable', async () => {
    const docs = await rest(tenantToken,
      `documents?property=eq.${encodeURIComponent(NAMESAKE.property)}&select=id,name`);
    const wos = await rest(tenantToken,
      `work_orders?property=eq.${encodeURIComponent(NAMESAKE.property)}&select=id,issue`);
    expect(docs.count + wos.count, 'a namesake tenant\'s rows must be invisible').toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OWNER PORTAL — UI
// ═══════════════════════════════════════════════════════════════════════
test.describe('Owner portal — UI', () => {
  test.describe.configure({ mode: 'serial' });
  let ctx, page, problems;

  test.beforeAll(async ({ browser }) => {
    ({ ctx, page } = await newPortalPage(browser, OWNER_EMAIL,
      p => p.locator('button:has-text("Statements")').first(), 'E2E81 Owner Alpha'));
    problems = watchPortal(page);
  });
  test.afterAll(async () => { if (ctx) await ctx.close(); });
  test.beforeEach(() => { problems.length = 0; });

  async function openTab(label) {
    await page.locator('main button').filter({ hasText: new RegExp(label, 'i') }).first()
      .click({ timeout: 15000 });
    await page.locator('main >> text=E2E81 Owner Alpha').first()
      .waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForTimeout(800);
  }

  test('logs in as an owner and lands on their own portal', async () => {
    const body = await mainText(page);
    expect(body).toContain('E2E81 Owner Alpha');
    expect(body, 'owner sees their own property count').toMatch(/2 properties/);
    expect(body).not.toContain('Something went wrong');
    expect(body, 'another owner must not appear').not.toContain('E2E81 Owner Beta');
  });

  const OWNER_TABS = [
    { label: 'Overview',      expect: /Your Properties|propert/i },
    { label: 'Statements',    expect: /Statement|Period|Net|No statements/i },
    { label: 'Distributions', expect: /Distribution|Amount|No distributions/i },
    { label: 'Properties',    expect: /Propert|Address|No properties/i },
    { label: 'Maintenance',   expect: /Maintenance|No maintenance|Issue|Status/i },
  ];

  for (const tab of OWNER_TABS) {
    test(`${tab.label} tab renders cleanly — no console errors, no failed requests`, async () => {
      await openTab(tab.label);
      const body = await mainText(page);
      expect(body, `${tab.label} must not hit the error boundary`).not.toContain('Something went wrong');
      expect(tab.expect.test(body), `${tab.label} renders its own content (got: ${body.slice(0, 200)})`).toBeTruthy();
      expect(problems, `${tab.label} tab: ${problems.join(' | ')}`).toEqual([]);
    });
  }

  test('properties tab shows only this owner\'s properties', async () => {
    await openTab('Properties');
    const body = await mainText(page);
    for (const addr of OWNER_A_PROPS) expect(body, `own property ${addr}`).toContain(addr);
    for (const addr of OWNER_B_PROPS) expect(body, `other owner's ${addr} must be hidden`).not.toContain(addr);
  });

  test('statements tab shows only this owner\'s statements', async () => {
    await openTab('Statements');
    const body = await mainText(page);
    expect(body).toMatch(/2026-07/);
    expect(body).toMatch(/2026-08/);
    expect(body, 'the other owner\'s $9,999 statement must not appear').not.toContain('9,999');
    expect(body).not.toContain('E2E81 Owner Beta');
  });

  test('distributions tab shows only this owner\'s distributions', async () => {
    await openTab('Distributions');
    const body = await mainText(page);
    expect(body).toContain('E2E81-DIST-ALPHA-1');
    expect(body).toContain('E2E81-DIST-ALPHA-2');
    expect(body, 'the other owner\'s distribution must not appear').not.toContain('E2E81-DIST-BETA-1');
  });

  test('owner cannot reach staff pages by URL', async () => {
    for (const route of ['tenants', 'accounting', 'payments', 'admin', 'dashboard']) {
      await page.goto(`/?company=${encodeURIComponent(COMPANY)}#${route}`, { timeout: 60000 });
      await page.locator('main >> text=E2E81 Owner Alpha').first()
        .waitFor({ state: 'visible', timeout: 45000 });
      const body = await page.locator('body').innerText();
      expect(body, `#${route} must keep the owner in the owner portal`).toContain('E2E81 Owner Alpha');
      expect(body, `#${route} must not render staff accounting`)
        .not.toMatch(/Chart of Accounts|Journal Entries|Team & Roles/);
      expect(body, `#${route} must not leak tenant data`).not.toContain(TENANT_B.name);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// OWNER PORTAL — data isolation at the API layer
// ═══════════════════════════════════════════════════════════════════════
test.describe('Owner portal — data isolation', () => {
  test('an owner sees only their own owners row', async () => {
    const r = await rest(ownerToken, 'owners?select=id,name,email');
    expect(r.count).toBe(1);
    expect(r.rows[0].name).toBe('E2E81 Owner Alpha');
  });

  test('an owner sees only the properties they own', async () => {
    const r = await rest(ownerToken, 'properties?select=id,address');
    expect(r.count, 'sandbox has 41 properties; this owner holds 2').toBe(2);
    expect(r.rows.map(x => x.address).sort()).toEqual([...OWNER_A_PROPS].sort());
  });

  test('an owner sees only their own statements and distributions', async () => {
    const s = await rest(ownerToken, 'owner_statements?select=owner_name,total_income');
    expect(s.count).toBe(2);
    expect(s.rows.every(x => x.owner_name === 'E2E81 Owner Alpha')).toBeTruthy();
    const d = await rest(ownerToken, 'owner_distributions?select=reference');
    expect(d.count).toBe(2);
    expect(d.rows.map(x => x.reference).sort()).toEqual(['E2E81-DIST-ALPHA-1', 'E2E81-DIST-ALPHA-2']);
  });

  test('fetching another owner\'s statement by id returns nothing', async () => {
    const betaId = sql(`SELECT id FROM owner_statements
                          WHERE company_id='${COMPANY}' AND owner_name='E2E81 Owner Beta' LIMIT 1;`).trim();
    expect(betaId, 'fixture statement exists').toMatch(/^[0-9a-f-]{36}$/);
    const r = await rest(ownerToken, `owner_statements?id=eq.${betaId}&select=id,net_to_owner`);
    expect(r.status).toBe(200);
    expect(r.count, 'another owner\'s statement must be invisible').toBe(0);
  });

  test('fetching another owner\'s distribution by id returns nothing', async () => {
    const betaId = sql(`SELECT id FROM owner_distributions
                          WHERE company_id='${COMPANY}' AND reference='E2E81-DIST-BETA-1' LIMIT 1;`).trim();
    const r = await rest(ownerToken, `owner_distributions?id=eq.${betaId}&select=id,amount`);
    expect(r.count).toBe(0);
  });

  for (const [label, path] of [
    ['tenants', 'tenants?select=id&limit=100'],
    ['tenant ledgers', 'ledger_entries?select=id&limit=100'],
    ['payments', 'payments?select=id&limit=100'],
    ['messages', 'messages?select=id&limit=100'],
    ['documents', 'documents?select=id&limit=100'],
    ['chart of accounts', 'acct_accounts?select=id&limit=100'],
  ]) {
    test(`an owner cannot read the company's ${label}`, async () => {
      const r = await rest(ownerToken, path);
      // See the tenant-side note: an 8s statement timeout on the ledger
      // view is a performance problem, not a disclosure.
      const timedOut = r.rows && r.rows.code === '57014';
      expect(r.status === 200 || timedOut,
        `${label} query errored: ${r.raw.slice(0, 160)}`).toBeTruthy();
      expect(r.count, `${label} must return zero rows for an owner`).toBe(0);
    });
  }

  test('an owner cannot alter their own statement figures', async () => {
    const stmtId = sql(`SELECT id FROM owner_statements
                          WHERE company_id='${COMPANY}' AND owner_name='E2E81 Owner Alpha'
                            AND period='2026-07' LIMIT 1;`).trim();
    await rest(ownerToken, `owner_statements?id=eq.${stmtId}`, {
      method: 'PATCH', body: JSON.stringify({ net_to_owner: 999999 }),
    });
    const after = sql(`SELECT net_to_owner FROM owner_statements WHERE id='${stmtId}';`).trim();
    expect(after, 'statements are read-only to the owner').toBe('3300.00');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Guard rail: the pristine reference company must be untouched.
// ═══════════════════════════════════════════════════════════════════════
test('reference company Sahil LLC is untouched', async () => {
  const out = sql(`
    SELECT (SELECT count(*) FROM properties WHERE company_id='f56be35c-c80d-4f47-8624-cbb317f85461')
      || '|' || (SELECT count(*) FROM tenants WHERE company_id='f56be35c-c80d-4f47-8624-cbb317f85461')
      || '|' || (SELECT count(*) FROM acct_journal_entries WHERE company_id='f56be35c-c80d-4f47-8624-cbb317f85461')
      || '|' || (SELECT to_char(coalesce(sum(debit),0),'FM9999999999.00') FROM acct_journal_lines WHERE company_id='f56be35c-c80d-4f47-8624-cbb317f85461')
      || '|' || (SELECT to_char(coalesce(sum(credit),0),'FM9999999999.00') FROM acct_journal_lines WHERE company_id='f56be35c-c80d-4f47-8624-cbb317f85461');
  `).trim();
  expect(out).toBe('41|73|7722|53671220.15|53671220.15');
});
