// ═══════════════════════════════════════════════════════════════
// RLS ENFORCEMENT TESTS (behavioral, live DB)
// Regression net for the multi-tenant RLS hardening (Phases 1–3,
// migrations 20260530000001/2/3). The existing security-adversarial
// suite only checks CODE PATTERNS (every .from() carries company_id);
// it can't catch a migration that re-adds an always-true policy or
// re-broadens get_user_company_ids(). These tests probe the REAL
// outcome through PostgREST with the exact keys the app ships:
//   • anon key (shipped in the frontend bundle) must read NOTHING
//   • a staff user sees ONLY their member companies (cross-company)
//   • a portal tenant sees ONLY their own rows (within-company)
// If a future change reopens the leak, an anon/tenant probe returns
// rows the user shouldn't see and the test fails — regardless of how
// the leak was reintroduced (policy, view, or helper fn).
//
// Run: cd tests && node rls-enforcement.test.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_EMAIL = process.env.TEST_EMAIL;
const ADMIN_PASS = process.env.TEST_PASSWORD;

// Seeded portal-tenant fixture (from seed-clicktest-data.js). The
// within-company check is conditional on this account existing so the
// suite stays green after `npm run seed:click:cleanup`.
const TENANT_EMAIL = 'clicktest-tenant@propmanager.com';
const TENANT_PASS = 'ClickTest!2026';

// Tables that must NEVER be readable by the anon (frontend) key.
const PROTECTED = [
  'tenants', 'payments', 'properties', 'work_orders', 'messages',
  'leases', 'documents', 'acct_journal_entries', 'acct_journal_lines',
  'owner_distributions', 'ledger_entries',
];

let pass = 0, fail = 0, skip = 0;
const errors = [];
function assert(ok, name, detail = '') {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); fail++; errors.push(name); }
}
function skipped(name, why) { console.log('  ⏭️  ' + name + (why ? ` — ${why}` : '')); skip++; }

// A fresh client per identity — no shared auth state to bleed across roles.
function client(key) {
  return createClient(URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function run() {
  if (!URL || !ANON || !SERVICE) {
    console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY in tests/.env');
    process.exit(1);
  }

  // ───────────────────────────────────────────
  // 1. ANON KEY READS NOTHING (cross-company leak via shipped key)
  // ───────────────────────────────────────────
  console.log('\n🔒 ANON KEY — protected tables must return zero rows');
  const anon = client(ANON);
  for (const table of PROTECTED) {
    const { data, error } = await anon.from(table).select('*').limit(5);
    // RLS-blocked SELECT returns [] with no error. A non-empty result
    // means the anon key can exfiltrate data — the exact leak we closed.
    const rows = (data || []).length;
    assert(!error && rows === 0, `anon cannot read ${table}`,
      error ? `error: ${error.message}` : `got ${rows} rows`);
  }

  // ───────────────────────────────────────────
  // 2. STAFF USER — cross-company scoping (Phase 1)
  // ───────────────────────────────────────────
  console.log('\n🏢 STAFF USER — sees only member companies');
  if (!ADMIN_EMAIL || !ADMIN_PASS) {
    skipped('staff cross-company isolation', 'TEST_EMAIL/TEST_PASSWORD not set');
  } else {
    const svc = client(SERVICE);
    const { count: totalCompanies } = await svc
      .from('companies').select('id', { count: 'exact', head: true });
    // Ground truth: which companies is the admin a STAFF member of?
    const { data: mem } = await svc.from('company_members')
      .select('company_id, role, status').ilike('user_email', ADMIN_EMAIL);
    const staffCompanies = new Set((mem || [])
      .filter(m => m.status === 'active' && !['tenant', 'owner'].includes(m.role))
      .map(m => m.company_id));

    const admin = client(ANON);
    const { error: loginErr } = await admin.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASS });
    assert(!loginErr, 'staff user can authenticate', loginErr ? loginErr.message : '');

    if (!loginErr) {
      const { data: tn } = await admin.from('tenants').select('id, company_id');
      const seen = new Set((tn || []).map(t => t.company_id));
      assert((tn || []).length > 0, 'staff user CAN read its own tenants (policies not over-blocking)');
      assert(seen.size < (totalCompanies || Infinity),
        'staff user does NOT see all companies (scoped, not always-true)',
        `saw ${seen.size}/${totalCompanies} companies`);
      assert([...seen].every(c => staffCompanies.has(c)),
        'every tenant the staff user reads belongs to a company they staff',
        `member of ${staffCompanies.size}, saw ${seen.size}`);
      await admin.auth.signOut();
    }
  }

  // ───────────────────────────────────────────
  // 3. PORTAL TENANT — within-company scoping (Phase 3)
  // ───────────────────────────────────────────
  console.log('\n👤 PORTAL TENANT — sees only own rows');
  const tenant = client(ANON);
  const { error: tErr } = await tenant.auth.signInWithPassword({ email: TENANT_EMAIL, password: TENANT_PASS });
  if (tErr) {
    skipped('portal tenant within-company isolation', `fixture ${TENANT_EMAIL} not seeded (run npm run seed:click)`);
  } else {
    const { data: tn } = await tenant.from('tenants').select('id, company_id');
    const { data: pay } = await tenant.from('payments').select('id');
    const { data: led } = await tenant.from('ledger_entries').select('journal_entry_id');
    // A portal tenant is an active company_member, so before Phase 3 it
    // could read the WHOLE company via get_user_company_ids(). Now it
    // must see exactly its own row(s) — not the whole company.
    assert((tn || []).length === 1, 'portal tenant reads exactly its own tenant row', `got ${(tn || []).length}`);
    assert((led || []).length <= 1, 'portal tenant ledger is self-filtered (own row only)', `got ${(led || []).length}`);
    assert((pay || []).length <= 1, 'portal tenant reads only its own payments', `got ${(pay || []).length}`);
    await tenant.auth.signOut();
  }

  console.log('\n================================');
  console.log(`✅ Passed: ${pass}   ⏭️  Skipped: ${skip}   ❌ Failed: ${fail}`);
  console.log(`Total: ${pass + fail} | Pass rate: ${pass + fail ? Math.round((pass / (pass + fail)) * 100) : 0}%`);
  if (fail > 0) {
    console.log('\nFailed:');
    errors.forEach(e => console.log('  - ' + e));
    process.exit(1);
  }
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
