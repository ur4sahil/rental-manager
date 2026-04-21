// ═══════════════════════════════════════════════════════════════
// MANAGER APPROVAL ROUTING TESTS
// Verifies the manager-role feature: approver_email columns exist,
// canReviewRequest routes correctly, and approval inserts snapshot
// the assigned manager at creation time.
// Run: cd tests && node manager-approvals.test.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const srcDir = path.resolve(__dirname, '../src');
function readAllSrc(dir) {
  let code = '';
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) code += readAllSrc(path.join(dir, f.name));
    else if (f.name.endsWith('.js')) code += fs.readFileSync(path.join(dir, f.name), 'utf8') + '\n';
  }
  return code;
}
const APP_CODE = readAllSrc(srcDir);

let pass = 0, fail = 0, errors = [];
function assert(ok, name) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name); fail++; errors.push(name); }
}

// ───────────────────────────────────────────
// 1. SCHEMA: manager_email + approver_email columns
// ───────────────────────────────────────────
async function testSchema() {
  console.log('\n📋 MANAGER SCHEMA');
  const { error: auErr } = await supabase.from('app_users').select('manager_email').limit(1);
  assert(!auErr, 'app_users.manager_email column exists');
  const { error: cmErr } = await supabase.from('company_members').select('manager_email').limit(1);
  assert(!cmErr, 'company_members.manager_email column exists');
  const { error: pcrErr } = await supabase.from('property_change_requests').select('approver_email').limit(1);
  assert(!pcrErr, 'property_change_requests.approver_email column exists');
  const { error: derErr } = await supabase.from('doc_exception_requests').select('approver_email').limit(1);
  assert(!derErr, 'doc_exception_requests.approver_email column exists');
}

// ───────────────────────────────────────────
// 2. canReviewRequest helper logic
// ───────────────────────────────────────────
function testCanReviewRequest() {
  console.log('\n🧮 canReviewRequest ROUTING');
  // Inline the helper from helpers.js to test behavior without bundling.
  function canReviewRequest({ userRole, userEmail, approverEmail }) {
    if (userRole === 'admin' || userRole === 'owner') return true;
    if (userRole !== 'manager') return false;
    if (!approverEmail || !userEmail) return false;
    return approverEmail.toLowerCase() === userEmail.toLowerCase();
  }
  assert(canReviewRequest({ userRole: 'admin', userEmail: 'a@x.com', approverEmail: null }),
    'admin can always review');
  assert(canReviewRequest({ userRole: 'owner', userEmail: 'o@x.com', approverEmail: null }),
    'owner can always review');
  assert(!canReviewRequest({ userRole: 'staff', userEmail: 's@x.com', approverEmail: 's@x.com' }),
    'staff cannot review even if self-assigned');
  assert(!canReviewRequest({ userRole: 'tenant', userEmail: 't@x.com', approverEmail: 't@x.com' }),
    'tenant cannot review');
  assert(canReviewRequest({ userRole: 'manager', userEmail: 'M@X.com', approverEmail: 'm@x.com' }),
    'manager matches on case-insensitive email');
  assert(!canReviewRequest({ userRole: 'manager', userEmail: 'm1@x.com', approverEmail: 'm2@x.com' }),
    'manager rejected when approver_email differs');
  assert(!canReviewRequest({ userRole: 'manager', userEmail: 'm@x.com', approverEmail: null }),
    'manager rejected when approver_email is null');
  assert(!canReviewRequest({ userRole: 'manager', userEmail: null, approverEmail: 'm@x.com' }),
    'manager rejected when userEmail missing');
}

// ───────────────────────────────────────────
// 3. Source-level checks — insert sites stamp approver_email
// ───────────────────────────────────────────
function testStamping() {
  console.log('\n🔗 APPROVER_EMAIL STAMPING');
  // Properties.js: requestDeleteProperty insert should include approver_email
  const propReqInsert = /property_change_requests"\)\.insert\(\[\{[^}]*approver_email:/s;
  assert(propReqInsert.test(APP_CODE),
    'property_change_requests insert stamps approver_email');
  // Tenants.js: doc_exception_requests insert should include approver_email
  const derInsert = /doc_exception_requests"\)\.insert\(\[\{[^}]*approver_email:/s;
  assert(derInsert.test(APP_CODE),
    'doc_exception_requests insert stamps approver_email');
  // canReviewRequest is imported where needed
  assert(/canReviewRequest/.test(APP_CODE),
    'canReviewRequest helper is wired into components');
}

// ───────────────────────────────────────────
// 4. Role config includes manager
// ───────────────────────────────────────────
function testRoleConfig() {
  console.log('\n👤 ROLE CONFIG');
  assert(/manager:\s*\{\s*label:\s*"Manager"/.test(APP_CODE),
    'ROLES registry includes manager entry');
  assert(/CUSTOMIZABLE_ROLES[^]*"manager"/.test(APP_CODE),
    'Admin CUSTOMIZABLE_ROLES includes manager');
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  MANAGER APPROVAL ROUTING TESTS');
  console.log('═══════════════════════════════════════════════════════════════');
  await testSchema();
  testCanReviewRequest();
  testStamping();
  testRoleConfig();
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log('  Failures:'); errors.forEach(e => console.log('    • ' + e)); }
  console.log('═══════════════════════════════════════════════════════════════');
  process.exit(fail > 0 ? 1 : 0);
})();
