// Visual + functional audit of the TENANT and OWNER portals.
//
// 81-portals proves the portals are SAFE -- roughly twenty tests show a
// tenant cannot reach another tenant's ledger, documents, contacts,
// property or receivables. What it does not do is look at them. The
// accessibility work (82) scanned only staff pages, so the portals had
// never had an axe scan, a keyboard check, a mobile check, or a single
// screenshot taken of them.
//
// This file captures every portal screen at desktop and phone widths so
// the rendering can actually be reviewed, runs axe on each, and drives
// the one flow that spans both sides: a tenant messages staff, staff
// reply, the tenant sees the reply.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const AxeBuilder = require('@axe-core/playwright').default;
const path = require('path');

// Every test here signs in as its own user. Without this the shared
// admin storageState is applied and the browser lands on the staff
// Dashboard already authenticated -- which is exactly what happened on
// the first run: the login form never appeared and the fill timed out.
test.use({ storageState: { cookies: [], origins: [] } });

const COMPANY = process.env.E2E_COMPANY || 'e2e-sandbox';
const PW = 'E2E94!portal';
const T_EMAIL = 'e2e94-tenant@example.test';
const SHOTS = path.join(__dirname, '..', 'screenshots', 'portal-audit');
const DB = process.env.TEST_DB_URL ||
  'postgresql://postgres.vpeewlplgxthckpidhxo:Sheebasoin1%23@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

function sql(text) {
  return execFileSync('psql', [DB, '-v', 'ON_ERROR_STOP=1', '-Atc', text],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let TENANT_ID, TENANT_NAME;

test.beforeAll(() => {
  // Borrow a real sandbox tenant that already has ledger history, so the
  // screens show realistic content rather than empty states.
  const row = sql(`
    SELECT t.id || '|' || t.name FROM tenants t
     JOIN acct_accounts a ON a.company_id=t.company_id AND a.tenant_id=t.id
     JOIN acct_journal_lines l ON l.account_id=a.id
     WHERE t.company_id='${COMPANY}' AND t.archived_at IS NULL
     GROUP BY t.id, t.name HAVING count(l.id) > 5
     ORDER BY count(l.id) DESC LIMIT 1;`);
  [TENANT_ID, TENANT_NAME] = row.split('|');

  sql(`
DELETE FROM auth.users WHERE email = '${T_EMAIL}';
DELETE FROM company_members WHERE company_id='${COMPANY}' AND user_email='${T_EMAIL}';
DELETE FROM app_users WHERE email='${T_EMAIL}';
DELETE FROM messages WHERE company_id='${COMPANY}' AND message LIKE 'E2E94%';

-- The eight token columns must be '' and not NULL: GoTrue scans them
-- into non-nullable Go strings and every sign-in fails with "Database
-- error querying schema" otherwise.
DO $$
DECLARE uid uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  VALUES ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    '${T_EMAIL}', extensions.crypt('${PW}', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', '', '', '', '', '');
  INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  VALUES (uid::text, uid,
    json_build_object('sub', uid::text, 'email', '${T_EMAIL}', 'email_verified', true)::jsonb,
    'email', now(), now());
  INSERT INTO app_users (email, name, role, user_type, company_id, password_set_at)
  VALUES ('${T_EMAIL}', 'E2E94 Portal Tenant', 'tenant', 'tenant', '${COMPANY}', now());
  INSERT INTO company_members (company_id, user_email, user_name, role, status, auth_user_id, invited_by)
  VALUES ('${COMPANY}', '${T_EMAIL}', 'E2E94 Portal Tenant', 'tenant', 'active', uid, 'e2e94-setup');
END $$;

UPDATE tenants SET email='${T_EMAIL}' WHERE id=${TENANT_ID};`);
});

test.afterAll(() => {
  sql(`
DELETE FROM messages WHERE company_id='${COMPANY}' AND message LIKE 'E2E94%';
DELETE FROM company_members WHERE company_id='${COMPANY}' AND user_email='${T_EMAIL}';
DELETE FROM app_users WHERE email='${T_EMAIL}';
DELETE FROM auth.users WHERE email='${T_EMAIL}';
UPDATE tenants SET email=NULL WHERE id=${TENANT_ID};`);
});

async function loginAs(page, email, pw) {
  await page.goto(process.env.APP_URL || 'http://localhost:3000');
  // Signed out, the app shows a MARKETING landing page ("I am a...
  // Property Manager / Property Owner / Tenant") with no form on it.
  // The login fields only exist after clicking Sign In. The first
  // version of this went straight for input[type=email] and timed out.
  const emailBox = page.locator('input[type="email"]').first();
  if (await emailBox.count() === 0 || !(await emailBox.isVisible().catch(() => false))) {
    await page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first().click();
    await page.waitForTimeout(1500);
  }
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(pw);
  await page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")').last().click();
  await page.waitForTimeout(7000);
}

// Freeze animation so a screenshot is the settled page, not a fade.
async function settle(page) {
  await page.addStyleTag({ content: `*,*::before,*::after{animation:none!important;transition:none!important}` });
  await page.waitForTimeout(800);
}

async function shoot(page, name) {
  // Wait for the loading spinner to clear, or the screenshot captures a
  // spinner and tells us nothing -- which is what the first Ledger
  // capture did.
  await page.waitForFunction(
    () => !document.querySelector('svg.animate-spin, .animate-spin'),
    { timeout: 25000 }
  ).catch(() => {});
  await settle(page);
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

async function axeOn(page, label, problems) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  for (const v of violations.filter(v => v.impact === 'critical' || v.impact === 'serious')) {
    // Name the offending element and its colours. "color-contrast x10"
    // on its own sent me to fix the wrong element -- the count did not
    // move, because the dash I darkened was never what axe was flagging.
    const where = v.nodes.slice(0, 3).map(n => {
      const msg = (n.any || []).map(a => a.message).join(' ').replace(/\s+/g, ' ');
      return `${n.target.join(' ')} :: ${msg.slice(0, 170)}`;
    });
    problems.push(`${label}: ${v.impact}/${v.id} x${v.nodes.length} — ${v.help}\n      ${where.join('\n      ')}`);
  }
}

test('tenant portal: every tab captured at desktop and phone, with an accessibility scan', async ({ browser }) => {
  test.setTimeout(600000);
  const problems = [];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await loginAs(page, T_EMAIL, PW);
  await shoot(page, 'tenant-01-landing-desktop');
  await axeOn(page, 'tenant landing', problems);

  const tabs = ['Overview', 'Pay Rent', 'Autopay', 'Ledger', 'Maintenance', 'Documents', 'Messages'];
  for (const tab of tabs) {
    const link = page.locator(`aside a:has-text("${tab}"), nav a:has-text("${tab}"), button:has-text("${tab}")`).first();
    if (await link.count() === 0) { problems.push(`tenant: no way to reach "${tab}"`); continue; }
    await link.click();
    await page.waitForTimeout(2500);
    await shoot(page, `tenant-${tab.toLowerCase().replace(/\s+/g, '-')}-desktop`);
    await axeOn(page, `tenant ${tab}`, problems);
  }
  await ctx.close();

  // Phone width — the portal is the surface a tenant is most likely to
  // open on a phone, and it had never been looked at on one.
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mpage = await mctx.newPage();
  await loginAs(mpage, T_EMAIL, PW);
  await shoot(mpage, 'tenant-01-landing-mobile');
  for (const tab of tabs) {
    const opener = mpage.locator('button[aria-label*="menu" i], button:has(span:text-is("menu"))').first();
    if (await opener.count() > 0 && await opener.isVisible()) { await opener.click(); await mpage.waitForTimeout(600); }
    const link = mpage.locator(`aside a:has-text("${tab}"), nav a:has-text("${tab}"), button:has-text("${tab}")`).first();
    if (await link.count() === 0) continue;
    await link.click();
    await mpage.waitForTimeout(2500);
    await shoot(mpage, `tenant-${tab.toLowerCase().replace(/\s+/g, '-')}-mobile`);
    // Horizontal overflow is the classic phone failure and is invisible
    // in a DOM assertion.
    const overflow = await mpage.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 4) problems.push(`tenant ${tab} (390px): page scrolls sideways by ${overflow}px`);
  }
  await mctx.close();

  console.log('\n--- TENANT PORTAL FINDINGS ---');
  for (const p of problems) console.log('  ' + p);
  console.log(`(${problems.length} findings; screenshots in screenshots/portal-audit)`);
});

test('a tenant messages staff, staff reply, and the tenant sees the reply', async ({ browser }) => {
  test.setTimeout(600000);
  const problems = [];
  const stamp = Date.now().toString().slice(-6);
  const fromTenant = `E2E94 tenant asking about the boiler ${stamp}`;
  const fromStaff = `E2E94 staff replying about the boiler ${stamp}`;

  // --- tenant sends ---
  const tctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tpage = await tctx.newPage();
  await loginAs(tpage, T_EMAIL, PW);
  const msgTab = tpage.locator('aside a:has-text("Messages"), nav a:has-text("Messages"), button:has-text("Messages")').first();
  await msgTab.click();
  await tpage.waitForTimeout(2500);
  const box = tpage.locator('textarea, input[placeholder*="essage" i]').first();
  await box.fill(fromTenant);
  await shoot(tpage, 'msg-01-tenant-composed');
  await tpage.locator('button:has-text("Send")').first().click();
  await tpage.waitForTimeout(4000);
  await shoot(tpage, 'msg-02-tenant-after-send');

  const landed = sql(`SELECT count(*) FROM messages WHERE company_id='${COMPANY}' AND message='${fromTenant}';`);
  expect(landed, 'the tenant\'s message never reached the database').toBe('1');
  const notified = sql(`SELECT count(*) FROM notification_queue WHERE company_id='${COMPANY}' AND type='message_received';`);
  if (notified === '0') problems.push('tenant message notified NO staff (notification_queue empty)');

  // --- staff read and reply ---
  const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const spage = await sctx.newPage();
  await loginAs(spage, process.env.TEST_EMAIL, process.env.TEST_PASSWORD);
  // A staff login lands on the company PICKER, not the app. Going
  // straight to /#messages just re-renders the picker -- which is what
  // the first run captured. Open the sandbox company first.
  // Select the company by URL parameter rather than by clicking a card.
  // Clicking was brittle -- one selector matched an outer container and
  // opened the Sahil LLC row instead, which a test must never do -- and
  // App.js already supports ?company=<id> for exactly this.
  await spage.goto(`${process.env.APP_URL || 'http://localhost:3000'}/?company=${COMPANY}#messages`);
  await spage.waitForTimeout(8000);
  const staffCompany = await spage.locator('body').innerText().catch(() => '');
  expect(staffCompany, 'staff session landed on the wrong company').toContain('E2E Sandbox');
  await shoot(spage, 'msg-03-staff-inbox');
  const seesIt = (await spage.locator('main').innerText()).includes(stamp);
  if (!seesIt) problems.push('staff inbox does not show the tenant\'s message');

  const thread = spage.locator(`text=${stamp}`).first();
  if (await thread.count() > 0) {
    await thread.click();
    await spage.waitForTimeout(2000);
    const sbox = spage.locator('textarea, input[placeholder*="eply" i], input[placeholder*="essage" i]').first();
    if (await sbox.count() > 0) {
      await sbox.fill(fromStaff);
      await shoot(spage, 'msg-04-staff-composed');
      await spage.locator('button:has-text("Send")').first().click();
      await spage.waitForTimeout(4000);
      await shoot(spage, 'msg-05-staff-after-send');
    } else problems.push('staff cannot reply — no reply box on the thread');
  }
  await sctx.close();

  // --- tenant sees the reply ---
  await tpage.reload();
  await tpage.waitForTimeout(5000);
  const msgTab2 = tpage.locator('aside a:has-text("Messages"), nav a:has-text("Messages"), button:has-text("Messages")').first();
  if (await msgTab2.count() > 0) { await msgTab2.click(); await tpage.waitForTimeout(3000); }
  await shoot(tpage, 'msg-06-tenant-sees-reply');
  const tenantSees = (await tpage.locator('main').innerText()).includes(fromStaff);
  if (!tenantSees) problems.push('the tenant never sees the staff reply');
  await tctx.close();

  console.log('\n--- MESSAGING ROUND TRIP FINDINGS ---');
  for (const p of problems) console.log('  ' + p);
  expect(problems, problems.join('\n')).toEqual([]);
});
