// ═══════════════════════════════════════════════════════════════
// ERROR MANAGEMENT SYSTEM TESTS
// Tests: error_log table, PM_ERRORS glossary, pmError() patterns,
// structured toast rendering, data integrity checks.
// Run: cd tests && node error-management.test.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
// Read all source files (App.js + utils/ + components/) since code was split into modules
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
// 1. ERROR_LOG TABLE SCHEMA
// ───────────────────────────────────────────
async function testErrorLogTable() {
  console.log('\n📋 ERROR_LOG TABLE');
  const { data, error } = await supabase.from('error_log').select('id, company_id, error_code, message, raw_message, severity, module, context, meta, user_email, user_role, url, user_agent, reported_by_user, resolved, resolution_notes, created_at, resolved_at').limit(1);
  assert(!error, 'error_log table exists and is queryable');
  assert(data !== null, 'error_log has all expected columns');

  // Test insert (should succeed for any authenticated user)
  const { error: insertErr } = await supabase.from('error_log').insert([{
    error_code: 'PM-TEST', message: 'Test error', severity: 'info', module: 'test',
    context: 'automated test', meta: { test: true }, user_email: 'test@test.com',
    reported_by_user: false, resolved: false
  }]);
  assert(!insertErr, 'Can insert into error_log');

  // Clean up
  await supabase.from('error_log').delete().eq('error_code', 'PM-TEST');
}

// ───────────────────────────────────────────
// 2. PM_ERRORS GLOSSARY COMPLETENESS
// ───────────────────────────────────────────
function testPMErrorsGlossary() {
  console.log('\n📖 PM_ERRORS GLOSSARY');

  // Check all error code ranges exist
  const modules = ['PM-1', 'PM-2', 'PM-3', 'PM-4', 'PM-5', 'PM-6', 'PM-7', 'PM-8', 'PM-9'];
  for (const prefix of modules) {
    const regex = new RegExp(`"${prefix}\\d{3}":\\s*\\{`, 'g');
    const matches = APP_CODE.match(regex);
    assert(matches && matches.length > 0, `Has error codes for ${prefix}xxx module (${matches ? matches.length : 0} codes)`);
  }

  // Check structure of each error entry (in PM_ERRORS glossary context)
  const glossaryStart = APP_CODE.indexOf('const PM_ERRORS');
  const glossaryEnd = APP_CODE.indexOf('};', glossaryStart);
  const glossary = APP_CODE.slice(glossaryStart, glossaryEnd);
  assert(glossary.includes('message:'), 'Error entries have message field');
  assert(glossary.includes('action:'), 'Error entries have action field');
  assert(glossary.includes('severity:'), 'Error entries have severity field');
}

// ───────────────────────────────────────────
// 3. pmError() ADOPTION COMPLETENESS
// ───────────────────────────────────────────
function testPmErrorAdoption() {
  console.log('\n🔧 pmError() ADOPTION');

  // Count pmError calls
  const pmErrorCalls = (APP_CODE.match(/pmError\(/g) || []).length;
  assert(pmErrorCalls > 100, `pmError() called ${pmErrorCalls} times (expected >100)`);

  // Count remaining raw console.warn/error (should be minimal)
  const consoleWarns = (APP_CODE.match(/console\.warn\(/g) || []).length;
  const consoleErrors = (APP_CODE.match(/console\.error\(/g) || []).length;
  assert(consoleWarns + consoleErrors <= 5, `Only ${consoleWarns + consoleErrors} raw console.warn/error calls remain (max 5 intentional)`);

  // No raw showToast("Error: " + error.message) patterns
  const rawToasts = (APP_CODE.match(/showToast\("Error:.*error\.message/g) || []).length;
  assert(rawToasts === 0, `No raw error.message in showToast (${rawToasts} found)`);

  // No empty catch {} blocks
  const emptyCatches = (APP_CODE.match(/catch\s*\{\}/g) || []).length;
  assert(emptyCatches === 0, `No empty catch {} blocks (${emptyCatches} found)`);

  // userError() function should be deleted
  assert(!APP_CODE.includes('function userError('), 'Old userError() function is deleted');
}

// ───────────────────────────────────────────
// 4. SENTRY INTEGRATION
// ───────────────────────────────────────────
function testSentryIntegration() {
  console.log('\n🔍 SENTRY INTEGRATION');

  assert(APP_CODE.includes('import * as Sentry'), 'Sentry is imported');
  assert(APP_CODE.includes('Sentry.init('), 'Sentry.init() is called');
  assert(APP_CODE.includes('REACT_APP_SENTRY_DSN'), 'Uses REACT_APP_SENTRY_DSN env var');
  assert(APP_CODE.includes('window.Sentry'), 'Sentry available globally via window.Sentry');
  assert(APP_CODE.includes('beforeSend'), 'Sentry has beforeSend PII scrubbing');
  assert(APP_CODE.includes('ignoreErrors'), 'Sentry has ignoreErrors for non-actionable errors');
}

// ───────────────────────────────────────────
// 5. STRUCTURED ERROR TOAST
// ───────────────────────────────────────────
function testStructuredToast() {
  console.log('\n🍞 STRUCTURED ERROR TOAST');

  assert(APP_CODE.includes('isError'), 'Toast system supports isError flag');
  assert(APP_CODE.includes('reportError'), 'reportError() function exists');
  assert(APP_CODE.includes('t.code'), 'Error toast renders error code');
  assert(APP_CODE.includes('Report'), 'Error toast has Report button');
}

// ───────────────────────────────────────────
// 6. DATA INTEGRITY GUARDS
// ───────────────────────────────────────────
function testDataIntegrityGuards() {
  console.log('\n🛡️  DATA INTEGRITY GUARDS');

  assert(APP_CODE.includes('runDataIntegrityChecks'), 'runDataIntegrityChecks() function exists');
  assert(APP_CODE.includes('find_unbalanced_jes'), 'Uses find_unbalanced_jes RPC');
  assert(APP_CODE.includes('PM-9001'), 'Checks for unbalanced JEs (PM-9001)');
  assert(APP_CODE.includes('PM-9002'), 'Checks for orphan tenants (PM-9002)');
  assert(APP_CODE.includes('PM-9006'), 'Checks for balance mismatches (PM-9006)');
  assert(APP_CODE.includes('PM-9007'), 'Checks for stale recurring entries (PM-9007)');
  assert(APP_CODE.includes('PM-9008'), 'Checks for archived property leases (PM-9008)');
}

// ───────────────────────────────────────────
// 7. ERROR LOG DASHBOARD
// ───────────────────────────────────────────
function testErrorLogDashboard() {
  console.log('\n📊 ERROR LOG DASHBOARD');

  assert(APP_CODE.includes('ErrorLogDashboard'), 'ErrorLogDashboard component exists');
  assert(APP_CODE.includes('Run Health Check'), 'Has Run Health Check button');
  assert(APP_CODE.includes('markResolved'), 'Has markResolved function');
  assert(APP_CODE.includes('"errors"'), 'Error Log tab in admin page');
}

// ═══════════════════════════════════════════
// RUN ALL TESTS
// ═══════════════════════════════════════════
async function main() {
  console.log('🧪 Error Management System Tests');
  console.log('==========================================');
  await testErrorLogTable();
  testPMErrorsGlossary();
  testPmErrorAdoption();
  testSentryIntegration();
  testStructuredToast();
  testDataIntegrityGuards();
  testErrorLogDashboard();

  console.log('\n==========================================');
  console.log(`✅ Passed: ${pass}`);
  console.log(`❌ Failed: ${fail}`);
  if (errors.length > 0) {
    console.log('\nFailed:');
    errors.forEach(e => console.log('  - ' + e));
  }
  console.log(`\nTotal: ${pass + fail} | Pass rate: ${Math.round(pass / (pass + fail) * 100)}%`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test runner error:', e); process.exit(1); });
