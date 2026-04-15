// ═══════════════════════════════════════════════════════════════
// REFACTOR VALIDATION TESTS
// Validates the code-split refactor didn't break anything.
// Checks file structure, imports, exports, no circular deps,
// no duplicate definitions, and App.js thin router pattern.
// Run: cd tests && node refactor-validation.test.js
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0, errors = [];
function assert(ok, name) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name); fail++; errors.push(name); }
}

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Read a source file and return its contents */
function readSrc(relPath) {
  return fs.readFileSync(path.join(SRC, relPath), 'utf8');
}

/** Count lines in a file */
function lineCount(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').length;
}

/** Recursively collect all .js files under a directory */
function collectJsFiles(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(collectJsFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

// ───────────────────────────────────────────
// 1. FILE STRUCTURE VALIDATION
// ───────────────────────────────────────────
function testFileStructure() {
  console.log('\n📁 FILE STRUCTURE VALIDATION');

  // App.js exists and is under 1000 lines
  const appPath = path.join(SRC, 'App.js');
  assert(fs.existsSync(appPath), 'src/App.js exists');
  const appLines = lineCount(appPath);
  assert(appLines < 1000, `src/App.js is under 1000 lines (${appLines} lines)`);

  // Utils directory with 8 files
  const utilsDir = path.join(SRC, 'utils');
  assert(fs.existsSync(utilsDir) && fs.statSync(utilsDir).isDirectory(), 'src/utils/ directory exists');
  const utilFiles = ['helpers.js', 'errors.js', 'guards.js', 'encryption.js', 'audit.js', 'notifications.js', 'company.js', 'accounting.js'];
  for (const f of utilFiles) {
    assert(fs.existsSync(path.join(utilsDir, f)), `src/utils/${f} exists`);
  }
  const actualUtilFiles = fs.readdirSync(utilsDir).filter(f => f.endsWith('.js'));
  assert(actualUtilFiles.length === 8, `src/utils/ has exactly 8 files (found ${actualUtilFiles.length})`);

  // Components directory with 23 files
  const compDir = path.join(SRC, 'components');
  assert(fs.existsSync(compDir) && fs.statSync(compDir).isDirectory(), 'src/components/ directory exists');
  const compFiles = [
    'shared.js', 'Accounting.js', 'Banking.js', 'Properties.js', 'Tenants.js',
    'Documents.js', 'Admin.js', 'Maintenance.js', 'Lifecycle.js', 'Leases.js',
    'Owners.js', 'TenantPortal.js', 'Utilities.js', 'CompanySelector.js',
    'Payments.js', 'Notifications.js', 'Dashboard.js', 'Loans.js', 'LateFees.js',
    'HOA.js', 'LoginPage.js', 'Insurance.js', 'LandingPage.js'
  ];
  for (const f of compFiles) {
    assert(fs.existsSync(path.join(compDir, f)), `src/components/${f} exists`);
  }
  const actualCompFiles = fs.readdirSync(compDir).filter(f => f.endsWith('.js'));
  assert(actualCompFiles.length === 23, `src/components/ has exactly 23 files (found ${actualCompFiles.length})`);

  // Total line count across all src/*.js files between 20000 and 25000
  const allJsFiles = collectJsFiles(SRC);
  const totalLines = allJsFiles.reduce((sum, f) => sum + lineCount(f), 0);
  assert(totalLines >= 20000, `Total src lines >= 20000 (${totalLines})`);
  assert(totalLines <= 25000, `Total src lines <= 25000 (${totalLines})`);
}

// ───────────────────────────────────────────
// 2. NO CIRCULAR IMPORTS
// ───────────────────────────────────────────
function testNoCircularImports() {
  console.log('\n🔄 NO CIRCULAR IMPORTS');

  // No component file imports from ../App or ./App
  const compDir = path.join(SRC, 'components');
  for (const f of fs.readdirSync(compDir).filter(f => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(compDir, f), 'utf8');
    const importsApp = /from\s+['"]\.\.\/App['"]/.test(code) || /from\s+['"]\.\/App['"]/.test(code);
    assert(!importsApp, `components/${f} does NOT import from App`);
  }

  // No utils file imports from ../App or ./App
  const utilsDir = path.join(SRC, 'utils');
  for (const f of fs.readdirSync(utilsDir).filter(f => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(utilsDir, f), 'utf8');
    const importsApp = /from\s+['"]\.\.\/App['"]/.test(code) || /from\s+['"]\.\/App['"]/.test(code);
    assert(!importsApp, `utils/${f} does NOT import from App`);
  }

  // helpers.js does NOT import from errors.js directly (uses setter pattern)
  const helpersCode = readSrc('utils/helpers.js');
  const helpersImportsErrors = /from\s+['"]\.\/errors['"]/.test(helpersCode) || /from\s+['"]\.\.\/utils\/errors['"]/.test(helpersCode);
  assert(!helpersImportsErrors, 'helpers.js does NOT import from errors.js (avoids circular dep)');

  // errors.js imports setHelperPmError from helpers and calls it
  const errorsCode = readSrc('utils/errors.js');
  assert(/setHelperPmError/.test(errorsCode), 'errors.js references setHelperPmError (setter pattern)');
  assert(/from\s+['"]\.\/helpers['"]/.test(errorsCode), 'errors.js imports from helpers.js');
}

// ───────────────────────────────────────────
// 3. EXPORT COMPLETENESS
// ───────────────────────────────────────────
function testExportCompleteness() {
  console.log('\n📤 EXPORT COMPLETENESS');

  // helpers.js exports
  const helpers = readSrc('utils/helpers.js');
  const helperExports = ['safeNum', 'parseLocalDate', 'formatLocalDate', 'shortId', 'formatCurrency', 'escapeFilterValue', 'normalizeEmail', 'isValidEmail', 'US_STATES', 'statusColors', 'priorityColors'];
  for (const name of helperExports) {
    assert(helpers.includes('export') && helpers.includes(name), `helpers.js exports ${name}`);
  }

  // errors.js exports
  const errs = readSrc('utils/errors.js');
  const errorExports = ['pmError', 'reportError', 'PM_ERRORS', 'setShowToastGlobal', 'setActiveErrorContext'];
  for (const name of errorExports) {
    assert(errs.includes('export') && errs.includes(name), `errors.js exports ${name}`);
  }

  // guards.js exports
  const guards = readSrc('utils/guards.js');
  const guardExports = ['guardSubmit', 'guardRelease', 'guarded', 'requireCompanyId'];
  for (const name of guardExports) {
    assert(guards.includes('export') && guards.includes(name), `guards.js exports ${name}`);
  }

  // accounting.js exports
  const acct = readSrc('utils/accounting.js');
  const acctExports = ['safeLedgerInsert', 'autoPostJournalEntry', 'resolveAccountId', 'getOrCreateTenantAR', 'autoPostRecurringEntries', '_classIdCache', '_acctIdCache', '_tenantArCache'];
  for (const name of acctExports) {
    assert(acct.includes('export') && acct.includes(name), `accounting.js exports ${name}`);
  }

  // shared.js exports
  const shared = readSrc('components/shared.js');
  const sharedExports = ['ErrorBoundary', 'Badge', 'StatCard', 'Spinner', 'Modal', 'ToastContainer', 'ConfirmModal', 'DocUploadModal'];
  for (const name of sharedExports) {
    assert(shared.includes('export') && shared.includes(name), `shared.js exports ${name}`);
  }
}

// ───────────────────────────────────────────
// 4. IMPORT CONSISTENCY
// ───────────────────────────────────────────
function testImportConsistency() {
  console.log('\n📥 IMPORT CONSISTENCY');

  const appCode = readSrc('App.js');

  // App.js imports from all 8 utils files
  const utilNames = ['helpers', 'errors', 'guards', 'encryption', 'audit', 'notifications', 'company', 'accounting'];
  for (const name of utilNames) {
    const pattern = new RegExp(`from\\s+['"]\\.\/utils\\/${name}['"]`);
    assert(pattern.test(appCode), `App.js imports from ./utils/${name}`);
  }

  // App.js imports from all major component files
  const majorComponents = [
    'Accounting', 'Banking', 'Properties', 'Tenants', 'Documents', 'Admin',
    'Maintenance', 'Lifecycle', 'Leases', 'Owners', 'TenantPortal', 'Utilities',
    'CompanySelector', 'Payments', 'Notifications', 'Dashboard', 'Loans',
    'LateFees', 'HOA', 'LoginPage', 'Insurance', 'LandingPage', 'shared'
  ];
  for (const name of majorComponents) {
    const pattern = new RegExp(`from\\s+['"]\\.\/components\\/${name}['"]`);
    assert(pattern.test(appCode), `App.js imports from ./components/${name}`);
  }

  // Every component that uses supabase imports from ../supabase
  const compDir = path.join(SRC, 'components');
  for (const f of fs.readdirSync(compDir).filter(f => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(compDir, f), 'utf8');
    if (code.includes('supabase.') || code.includes('supabase,')) {
      const importsSupabase = /from\s+['"]\.\.\/supabase['"]/.test(code);
      assert(importsSupabase, `components/${f} imports supabase from ../supabase`);
    }
  }

  // Every component that uses pmError imports from ../utils/errors
  for (const f of fs.readdirSync(compDir).filter(f => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(compDir, f), 'utf8');
    if (/pmError\s*\(/.test(code)) {
      const importsErrors = /from\s+['"]\.\.\/utils\/errors['"]/.test(code);
      assert(importsErrors, `components/${f} imports pmError from ../utils/errors`);
    }
  }

  // Every component that uses React hooks imports React
  for (const f of fs.readdirSync(compDir).filter(f => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(compDir, f), 'utf8');
    if (/\buse(State|Effect|Ref|Memo|Callback|Context)\b/.test(code)) {
      const importsReact = /from\s+['"]react['"]/.test(code);
      assert(importsReact, `components/${f} imports React (uses hooks)`);
    }
  }
}

// ───────────────────────────────────────────
// 5. NO DUPLICATE FUNCTION DEFINITIONS
// ───────────────────────────────────────────
function testNoDuplicateDefinitions() {
  console.log('\n🔍 NO DUPLICATE FUNCTION DEFINITIONS');

  const allJsFiles = collectJsFiles(SRC);
  const keyFunctions = ['safeNum', 'pmError', 'logAudit', 'guardSubmit', 'companyQuery', 'safeLedgerInsert', 'autoPostJournalEntry'];

  for (const funcName of keyFunctions) {
    let defCount = 0;
    let defFiles = [];
    const defPattern = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s+${funcName}\\b|(?:const|let|var)\\s+${funcName}\\s*=)`);
    for (const file of allJsFiles) {
      const code = fs.readFileSync(file, 'utf8');
      if (defPattern.test(code)) {
        defCount++;
        defFiles.push(path.relative(SRC, file));
      }
    }
    assert(defCount === 1, `${funcName} defined in exactly 1 file (found ${defCount}: ${defFiles.join(', ')})`);
  }
}

// ───────────────────────────────────────────
// 6. APP.JS THIN ROUTER VALIDATION
// ───────────────────────────────────────────
function testAppJsThinRouter() {
  console.log('\n🛤️  APP.JS THIN ROUTER VALIDATION');

  const appCode = readSrc('App.js');

  // App.js contains expected structures
  assert(appCode.includes('pageComponents'), 'App.js contains pageComponents map');
  assert(/function\s+AppInner/.test(appCode), 'App.js contains function AppInner');
  assert(/export\s+default\s+function\s+App/.test(appCode), 'App.js contains export default function App');
  assert(/\bROLES\b/.test(appCode), 'App.js contains ROLES constant');
  assert(/\bALL_NAV\b/.test(appCode), 'App.js contains ALL_NAV constant');

  // App.js does NOT contain these extracted functions/components
  const extractedItems = [
    'safeLedgerInsert', 'companyQuery', 'logAudit', 'Badge', 'Spinner',
    'Properties', 'Tenants', 'Payments', 'Accounting', 'BankTransactions'
  ];
  for (const name of extractedItems) {
    // Check that App.js does not DEFINE these (it may import/reference them)
    const defPattern = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=\\s*(?:function|\\())`);
    assert(!defPattern.test(appCode), `App.js does NOT define ${name} (extracted to module)`);
  }

  // App.js still contains Sentry.init
  assert(appCode.includes('Sentry.init'), 'App.js still contains Sentry.init');

  // App.js still contains initErrorTracking IIFE
  assert(appCode.includes('initErrorTracking'), 'App.js still contains initErrorTracking IIFE');
}

// ───────────────────────────────────────────
// RUN ALL
// ───────────────────────────────────────────
function run() {
  console.log('🧪 Refactor Validation Tests');
  console.log('==========================================');
  testFileStructure();
  testNoCircularImports();
  testExportCompleteness();
  testImportConsistency();
  testNoDuplicateDefinitions();
  testAppJsThinRouter();
  console.log('\n==========================================');
  console.log('✅ Passed: ' + pass);
  console.log('❌ Failed: ' + fail);
  if (errors.length > 0) { console.log('\nFailed:'); errors.forEach(e => console.log('  - ' + e)); }
  console.log('\nTotal: ' + (pass + fail) + ' | Pass rate: ' + Math.round(pass / (pass + fail) * 100) + '%');
  process.exit(fail > 0 ? 1 : 0);
}
run();
