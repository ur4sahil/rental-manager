// ═══════════════════════════════════════════════════════════════
// INFRASTRUCTURE & BUILD VALIDATION TESTS
// Tests: dependencies, build, env vars, security headers,
// service worker, file structure, package health.
// Run: cd tests && node infra.test.js
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0, errors = [];
function assert(ok, name) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name); fail++; errors.push(name); }
}

const ROOT = path.resolve(__dirname, '..');

// ───────────────────────────────────────────
// 1. FILE STRUCTURE
// ───────────────────────────────────────────
function testFileStructure() {
  console.log('\n📁 FILE STRUCTURE');
  const required = [
    'src/App.js',
    'src/supabase.js',
    'src/index.js',
    'src/index.css',
    'public/index.html',
    'public/sw.js',
    'public/manifest.json',
    'public/favicon.ico',
    'public/logo192.png',
    'package.json',
    'package-lock.json',
    'CLAUDE.md',
  ];
  for (const file of required) {
    const exists = fs.existsSync(path.join(ROOT, file));
    assert(exists, `${file} exists`);
  }
}

// ───────────────────────────────────────────
// 2. PACKAGE.JSON HEALTH
// ───────────────────────────────────────────
function testPackageJson() {
  console.log('\n📦 PACKAGE.JSON');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert(pkg.dependencies['react'], 'React is a dependency');
  assert(pkg.dependencies['react-dom'], 'React DOM is a dependency');
  assert(pkg.dependencies['@supabase/supabase-js'], 'Supabase JS is a dependency');
  assert(pkg.dependencies['react-scripts'] || pkg.devDependencies?.['react-scripts'], 'React Scripts available');

  // Check scripts
  assert(pkg.scripts.start, 'npm start script exists');
  assert(pkg.scripts.build, 'npm build script exists');

  // Check no vulnerable patterns
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert(!allDeps['eval'] && !allDeps['eval5'], 'No eval packages in dependencies');
}

// ───────────────────────────────────────────
// 3. ENVIRONMENT VARIABLES
// ───────────────────────────────────────────
function testEnvVars() {
  console.log('\n🔐 ENVIRONMENT VARIABLES');

  // Test env (for tests)
  assert(process.env.SUPABASE_URL, 'SUPABASE_URL is set in test .env');
  assert(process.env.SUPABASE_SERVICE_KEY, 'SUPABASE_SERVICE_KEY is set in test .env');

  // .env should NOT be committed
  const gitignore = fs.existsSync(path.join(ROOT, '.gitignore'))
    ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    : '';
  assert(gitignore.includes('.env'), '.gitignore includes .env');

  // Test .env should also not be committed
  const testEnvExists = fs.existsSync(path.join(__dirname, '.env'));
  assert(testEnvExists, 'tests/.env exists locally');
}

// ───────────────────────────────────────────
// 4. VERCEL CONFIG & SECURITY HEADERS
// ───────────────────────────────────────────
function testVercelConfig() {
  console.log('\n🔒 VERCEL CONFIG & SECURITY HEADERS');
  const vercelPath = path.join(ROOT, 'vercel.json');
  const exists = fs.existsSync(vercelPath);
  assert(exists, 'vercel.json exists');

  if (exists) {
    const config = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
    const headers = config.headers || [];
    const allHeaders = headers.flatMap(h => (h.headers || []).map(hh => hh.key));

    assert(allHeaders.includes('X-Frame-Options'), 'X-Frame-Options header set (clickjacking protection)');
    assert(allHeaders.includes('X-Content-Type-Options'), 'X-Content-Type-Options header set (MIME sniffing)');
    assert(allHeaders.includes('Referrer-Policy'), 'Referrer-Policy header set');
    assert(allHeaders.includes('Strict-Transport-Security'), 'HSTS header set');
    assert(allHeaders.includes('Permissions-Policy'), 'Permissions-Policy header set');
    assert(allHeaders.includes('X-DNS-Prefetch-Control'), 'X-DNS-Prefetch-Control header set');

    // Check specific values
    const frameOpts = headers.flatMap(h => h.headers || []).find(h => h.key === 'X-Frame-Options');
    if (frameOpts) {
      assert(frameOpts.value === 'DENY', 'X-Frame-Options is DENY');
    }

    const hsts = headers.flatMap(h => h.headers || []).find(h => h.key === 'Strict-Transport-Security');
    if (hsts) {
      assert(hsts.value.includes('max-age='), 'HSTS has max-age');
    }
  }
}

// ───────────────────────────────────────────
// 5. SERVICE WORKER
// ───────────────────────────────────────────
function testServiceWorker() {
  console.log('\n📱 SERVICE WORKER');
  const swPath = path.join(ROOT, 'public/sw.js');
  const exists = fs.existsSync(swPath);
  assert(exists, 'sw.js exists in public/');

  if (exists) {
    const sw = fs.readFileSync(swPath, 'utf8');
    assert(sw.includes('push'), 'Service worker handles push events');
    assert(sw.includes('notificationclick') || sw.includes('notification'),
      'Service worker handles notification clicks');
    assert(sw.includes('showNotification'), 'Service worker shows notifications');
  }
}

// ───────────────────────────────────────────
// 6. HTML ENTRY POINT
// ───────────────────────────────────────────
function testHtmlEntry() {
  console.log('\n🌐 HTML ENTRY POINT');
  const htmlPath = path.join(ROOT, 'public/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert(html.includes('root'), 'Has React root div');
  assert(html.includes('tailwind') || html.includes('Tailwind'), 'Includes Tailwind CSS');
  assert(html.includes('Manrope') || html.includes('manrope'), 'Loads Manrope font');
  assert(html.includes('Material') || html.includes('material'), 'Loads Material Icons');
  assert(html.includes('manifest'), 'References PWA manifest');
  assert(html.includes('<meta') && html.includes('viewport'), 'Has viewport meta tag');
}

// ───────────────────────────────────────────
// 7. SUPABASE CLIENT CONFIG
// ───────────────────────────────────────────
function testSupabaseConfig() {
  console.log('\n🗄️  SUPABASE CLIENT CONFIG');
  const supabasePath = path.join(ROOT, 'src/supabase.js');
  const supabaseCode = fs.readFileSync(supabasePath, 'utf8');

  assert(supabaseCode.includes('createClient'), 'Uses createClient from Supabase');
  assert(supabaseCode.includes('REACT_APP_SUPABASE_URL'), 'References REACT_APP_SUPABASE_URL');
  assert(supabaseCode.includes('REACT_APP_SUPABASE_ANON_KEY'), 'References REACT_APP_SUPABASE_ANON_KEY');
  // Should throw if env vars missing
  assert(supabaseCode.includes('throw') || supabaseCode.includes('error') || supabaseCode.includes('Error'),
    'Fails if env vars missing');
}

// ───────────────────────────────────────────
// 8. APP.JS CODE QUALITY CHECKS
// ───────────────────────────────────────────
function testCodeQuality() {
  console.log('\n🧹 CODE QUALITY CHECKS');
  const appCode = fs.readFileSync(path.join(ROOT, 'src/App.js'), 'utf8');

  // Security: no hardcoded keys/secrets
  assert(!appCode.includes('sk_live_'), 'No hardcoded Stripe live keys');
  assert(!appCode.includes('sk_test_'), 'No hardcoded Stripe test keys');
  assert(!appCode.match(/supabaseUrl\s*=\s*['"]https:/), 'No hardcoded Supabase URLs');
  assert(!appCode.match(/supabaseKey\s*=\s*['"]eyJ/), 'No hardcoded Supabase keys');

  // Essential patterns present
  assert(appCode.includes('companyQuery'), 'Uses companyQuery helper');
  assert(appCode.includes('companyInsert'), 'Uses companyInsert helper');
  assert(appCode.includes('requireCompanyId'), 'Uses requireCompanyId guard');
  assert(appCode.includes('logAudit'), 'Uses logAudit function');
  assert(appCode.includes('autoPostJournalEntry'), 'Uses autoPostJournalEntry');
  assert(appCode.includes('guardSubmit'), 'Uses double-submit prevention');
  assert(appCode.includes('parseLocalDate'), 'Uses parseLocalDate (timezone-safe)');
  assert(appCode.includes('userError'), 'Uses userError (sanitized errors)');
  assert(appCode.includes('sanitizeFileName'), 'Uses sanitizeFileName');
  assert(appCode.includes('escapeHtml'), 'Uses escapeHtml');
  assert(appCode.includes('.ilike('), 'Uses case-insensitive email matching (.ilike)');

  // UI component patterns (post-refactor)
  assert(appCode.includes('showToast('), 'Uses showToast (non-blocking notifications)');
  assert(appCode.includes('showConfirm('), 'Uses showConfirm (modal confirmations)');
  assert(appCode.includes('from "./ui"'), 'Imports reusable UI components from ui.js');
  assert(!appCode.includes('window.confirm('), 'No legacy window.confirm() calls');

  // Verify no raw alert() calls remain (should all be showToast)
  const alertMatches = appCode.match(/[^a-zA-Z]alert\(/g);
  assert(!alertMatches || alertMatches.length === 0, 'No raw alert() calls (' + (alertMatches ? alertMatches.length : 0) + ' found)');

  // No dangerous patterns
  // dangerouslySetInnerHTML is used by Document Builder for HTML template preview (merge fields → rendered output)
  // Content is sanitized via escapeHtml() on merge field values
  const dsiCount = (appCode.match(/dangerouslySetInnerHTML/g) || []).length;
  assert(dsiCount <= 5, 'Limited dangerouslySetInnerHTML usage (' + dsiCount + ' found, max 5 for doc preview)');
  assert(!appCode.includes('eval('), 'No eval() calls');
  // document.write is used legitimately for print previews in new windows
  const writeCount = (appCode.match(/document\.write/g) || []).length;
  assert(writeCount <= 3, 'No excessive document.write calls (' + writeCount + ' found, max 3 for print + comment)');

  // Line count sanity check
  const lineCount = appCode.split('\n').length;
  assert(lineCount > 8000, `App.js has ${lineCount} lines (expected 8000+)`);
  assert(lineCount < 20000, `App.js has ${lineCount} lines (not exceeded 20k limit)`);
}

// ───────────────────────────────────────────
// 9. NODE_MODULES NOT COMMITTED
// ───────────────────────────────────────────
function testNoNodeModules() {
  console.log('\n🚫 SENSITIVE FILES');
  const gitignore = fs.existsSync(path.join(ROOT, '.gitignore'))
    ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    : '';
  assert(gitignore.includes('node_modules'), '.gitignore excludes node_modules');
  assert(gitignore.includes('.env'), '.gitignore excludes .env files');
}

// ───────────────────────────────────────────
// 10. MANIFEST.JSON
// ───────────────────────────────────────────
function testManifest() {
  console.log('\n📋 PWA MANIFEST');
  const manifestPath = path.join(ROOT, 'public/manifest.json');
  const exists = fs.existsSync(manifestPath);
  assert(exists, 'manifest.json exists');

  if (exists) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert(manifest.short_name || manifest.name, 'Manifest has name');
    assert(manifest.icons && manifest.icons.length > 0, 'Manifest has icons');
    assert(manifest.start_url, 'Manifest has start_url');
  }
}

// ───────────────────────────────────────────
// RUN ALL
// ───────────────────────────────────────────
function run() {
  console.log('🧪 Infrastructure & Build Validation Tests');
  console.log('==========================================');
  testFileStructure();
  testPackageJson();
  testEnvVars();
  testVercelConfig();
  testServiceWorker();
  testHtmlEntry();
  testSupabaseConfig();
  testCodeQuality();
  testNoNodeModules();
  testManifest();
  console.log('\n==========================================');
  console.log('✅ Passed: ' + pass);
  console.log('❌ Failed: ' + fail);
  if (errors.length > 0) { console.log('\nFailed:'); errors.forEach(e => console.log('  - ' + e)); }
  console.log('\nTotal: ' + (pass + fail) + ' | Pass rate: ' + Math.round(pass / (pass + fail) * 100) + '%');
  process.exit(fail > 0 ? 1 : 0);
}
run();
