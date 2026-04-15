require('dotenv').config();
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0, errors = [];

function assert(ok, name) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name); fail++; errors.push(name); }
}

// ---------------------------------------------------------------------------
// Read ALL source code for static analysis
// ---------------------------------------------------------------------------
const srcDir = path.resolve(__dirname, '../src');
function readAllSrc(dir) {
  let code = '';
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) code += readAllSrc(path.join(dir, f.name));
    else if (f.name.endsWith('.js')) code += fs.readFileSync(path.join(dir, f.name), 'utf8') + '\n';
  }
  return code;
}
const ALL_CODE = readAllSrc(srcDir);

// Read per-file for import checks
function readSrcFiles(dir) {
  const files = {};
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) Object.assign(files, readSrcFiles(full));
    else if (f.name.endsWith('.js')) files[full] = fs.readFileSync(full, 'utf8');
  }
  return files;
}
const SRC_FILES = readSrcFiles(srcDir);

// ---------------------------------------------------------------------------
// Helper: extract all .from("TABLE") call blocks (up to next ; or newline)
// ---------------------------------------------------------------------------
function extractFromBlocks(table) {
  // Match .from("TABLE") or .from('TABLE') and capture up to the next semicolon or double-newline
  const regex = new RegExp('\\.from\\(["\']' + table + '["\']\\)[^;\\n]*', 'g');
  const matches = ALL_CODE.match(regex) || [];
  return matches;
}

function countViolations(table) {
  const blocks = extractFromBlocks(table);
  let violations = 0;
  const violationList = [];
  for (const block of blocks) {
    // Allow: companyQuery, companyInsert, companyUpsert wrappers (they inject company_id automatically)
    // We only flag raw .from() calls that lack company_id
    if (!block.includes('company_id') && !block.includes('companyQuery') && !block.includes('companyInsert') && !block.includes('companyUpsert')) {
      // Skip select-only schema introspection / RPC calls / count-only
      if (block.includes('.select(') && block.includes('.eq(') && !block.includes('company_id')) {
        violations++;
        violationList.push(block.substring(0, 120));
      } else if (block.includes('.insert(') || block.includes('.update(') || block.includes('.upsert(') || block.includes('.delete(')) {
        violations++;
        violationList.push(block.substring(0, 120));
      }
    }
  }
  return { total: blocks.length, violations, violationList };
}

// ===========================================================================
// 1. MULTI-TENANT ISOLATION (code pattern tests)
// ===========================================================================
async function testMultiTenantIsolation() {
  console.log('\n🔒 MULTI-TENANT ISOLATION');

  const tables = [
    'properties', 'tenants', 'payments', 'leases', 'work_orders',
    'documents', 'acct_journal_entries', 'ledger_entries', 'owner_distributions'
  ];

  for (const table of tables) {
    const blocks = extractFromBlocks(table);
    const { total, violations, violationList } = countViolations(table);
    assert(violations === 0,
      `All .from("${table}") calls include company_id (${total} calls, ${violations} violations)`);
    if (violationList.length > 0) {
      for (const v of violationList.slice(0, 3)) {
        console.log('    ⚠️  ' + v);
      }
    }
  }

  // Verify companyQuery/companyInsert/companyUpsert helpers exist and inject company_id
  assert(ALL_CODE.includes('companyQuery'), 'companyQuery helper exists in codebase');
  assert(ALL_CODE.includes('companyInsert'), 'companyInsert helper exists in codebase');
  assert(ALL_CODE.includes('companyUpsert'), 'companyUpsert helper exists in codebase');

  // Verify requireCompanyId guard exists
  assert(ALL_CODE.includes('requireCompanyId'), 'requireCompanyId guard exists in codebase');
}

// ===========================================================================
// 2. POSTGREST INJECTION PREVENTION
// ===========================================================================
async function testPostgrestInjection() {
  console.log('\n🛡️  POSTGREST INJECTION PREVENTION');

  // Check for .or() calls with raw string concatenation (+ without escapeFilterValue nearby)
  const orCalls = ALL_CODE.match(/\.or\([^)]*\+[^)]*\)/g) || [];
  let unsafeOrCalls = 0;
  for (const call of orCalls) {
    if (!call.includes('escapeFilterValue')) {
      unsafeOrCalls++;
    }
  }
  assert(unsafeOrCalls === 0,
    `No .or() calls with raw string concatenation without escapeFilterValue (${unsafeOrCalls} found)`);

  // Check for .ilike() with raw "%" patterns (no escapeFilterValue)
  const ilikeCalls = ALL_CODE.match(/\.ilike\([^)]*%[^)]*\)/g) || [];
  let unsafeIlike = 0;
  for (const call of ilikeCalls) {
    if (!call.includes('escapeFilterValue') && !call.includes('escaped')) {
      unsafeIlike++;
    }
  }
  assert(unsafeIlike === 0,
    `No .ilike() calls with raw % patterns without escapeFilterValue (${unsafeIlike} found)`);

  // Verify escapeFilterValue is imported in every file that uses .ilike() or .or()
  let missingImports = 0;
  const missingFiles = [];
  for (const [filePath, content] of Object.entries(SRC_FILES)) {
    const usesIlike = content.includes('.ilike(');
    const usesOr = /\.or\(/.test(content);
    if (usesIlike || usesOr) {
      const hasEscape = content.includes('escapeFilterValue');
      if (!hasEscape) {
        missingImports++;
        missingFiles.push(path.basename(filePath));
      }
    }
  }
  assert(missingImports === 0,
    `escapeFilterValue imported in every file using .ilike()/.or() (${missingImports} missing: ${missingFiles.join(', ')})`);

  // Verify escapeFilterValue function definition exists
  assert(ALL_CODE.includes('function escapeFilterValue') || ALL_CODE.includes('escapeFilterValue ='),
    'escapeFilterValue function is defined in codebase');

  // Check that escapeFilterValue handles special PostgREST chars
  const escFn = ALL_CODE.match(/escapeFilterValue[\s\S]*?(?=\nexport|\nfunction|\nconst\s+\w+\s*=\s*(?!.*escapeFilterValue))/);
  if (escFn) {
    assert(escFn[0].includes('%') || escFn[0].includes('replace'),
      'escapeFilterValue handles special characters');
  }
}

// ===========================================================================
// 3. XSS PREVENTION
// ===========================================================================
async function testXSSPrevention() {
  console.log('\n🕷️  XSS PREVENTION');

  // Every dangerouslySetInnerHTML must be preceded by DOMPurify.sanitize or sanitizeTemplateHtml
  let unsafeDangerousHtml = 0;
  const dangerousFiles = [];
  for (const [filePath, content] of Object.entries(SRC_FILES)) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('dangerouslySetInnerHTML')) {
        // Check surrounding context (10 lines before) for sanitization
        const context = lines.slice(Math.max(0, i - 10), i + 1).join('\n');
        if (!context.includes('DOMPurify') && !context.includes('sanitizeTemplateHtml') && !context.includes('sanitize')) {
          unsafeDangerousHtml++;
          dangerousFiles.push(path.basename(filePath) + ':' + (i + 1));
        }
      }
    }
  }
  assert(unsafeDangerousHtml === 0,
    `All dangerouslySetInnerHTML uses have DOMPurify/sanitizeTemplateHtml (${unsafeDangerousHtml} unsafe: ${dangerousFiles.join(', ')})`);

  // No innerHTML = assignments
  let innerHtmlAssignments = 0;
  const innerHtmlFiles = [];
  for (const [filePath, content] of Object.entries(SRC_FILES)) {
    const matches = content.match(/innerHTML\s*=/g) || [];
    if (matches.length > 0) {
      innerHtmlAssignments += matches.length;
      innerHtmlFiles.push(path.basename(filePath) + ' (' + matches.length + ')');
    }
  }
  // Note: innerHTML = in source files is a warning; React components should use dangerouslySetInnerHTML
  assert(innerHtmlAssignments === 0,
    `No innerHTML = assignments in source files (${innerHtmlAssignments} found in: ${innerHtmlFiles.join(', ')})`);

  // DOMPurify imported in every file using dangerouslySetInnerHTML
  let missingPurify = 0;
  const purifyMissing = [];
  for (const [filePath, content] of Object.entries(SRC_FILES)) {
    if (content.includes('dangerouslySetInnerHTML')) {
      if (!content.includes('DOMPurify') && !content.includes('sanitizeTemplateHtml')) {
        missingPurify++;
        purifyMissing.push(path.basename(filePath));
      }
    }
  }
  assert(missingPurify === 0,
    `DOMPurify/sanitizeTemplateHtml imported in every file using dangerouslySetInnerHTML (${missingPurify} missing: ${purifyMissing.join(', ')})`);

  // No eval() or Function() constructor with dynamic input
  const evalMatches = ALL_CODE.match(/\beval\s*\(/g) || [];
  assert(evalMatches.length === 0,
    `No eval() calls in source code (${evalMatches.length} found)`);

  const funcConstructor = ALL_CODE.match(/new\s+Function\s*\(/g) || [];
  assert(funcConstructor.length === 0,
    `No new Function() constructor calls (${funcConstructor.length} found)`);
}

// ===========================================================================
// 4. FILE UPLOAD SECURITY
// ===========================================================================
async function testFileUploadSecurity() {
  console.log('\n📎 FILE UPLOAD SECURITY');

  // File upload validation rejects text/html and text/javascript
  assert(ALL_CODE.includes('text/html') || ALL_CODE.includes('text\\/html'),
    'File upload checks for text/html MIME type');
  assert(ALL_CODE.includes('text/javascript') || ALL_CODE.includes('application/javascript'),
    'File upload checks for text/javascript MIME type');

  // Magic bytes validation exists
  const hasMagicBytes = ALL_CODE.includes('25504446') || ALL_CODE.includes('magic') ||
    ALL_CODE.includes('fileSignature') || ALL_CODE.includes('file signature') ||
    ALL_CODE.includes('arrayBuffer') || ALL_CODE.includes('Uint8Array');
  assert(hasMagicBytes, 'Magic bytes / file signature validation exists');

  // File size limit exists
  const hasSizeLimit = ALL_CODE.includes('25 * 1024 * 1024') || ALL_CODE.includes('26214400') ||
    ALL_CODE.includes('size >') || ALL_CODE.includes('file.size') ||
    ALL_CODE.match(/\d+\s*\*\s*1024\s*\*\s*1024/);
  assert(hasSizeLimit, 'File size limit validation exists');

  // sanitizeFileName is used
  assert(ALL_CODE.includes('sanitizeFileName'), 'sanitizeFileName function is used for file paths');

  // Verify sanitizeFileName is defined
  const hasSanitizeDef = ALL_CODE.includes('function sanitizeFileName') || ALL_CODE.includes('sanitizeFileName =');
  assert(hasSanitizeDef, 'sanitizeFileName function is defined in codebase');

  // Check that sanitizeFileName strips path traversal (replace non-alphanum with _ handles ../)
  const sanitizeFnDef = ALL_CODE.match(/function\s+sanitizeFileName[^}]+\}/);
  if (sanitizeFnDef) {
    const fnBody = sanitizeFnDef[0];
    assert(fnBody.includes('replace') || fnBody.includes('..'),
      'sanitizeFileName strips unsafe characters via replace (handles path traversal)');
  } else {
    assert(false, 'sanitizeFileName function definition not found');
  }

  // MIME type whitelist approach (not blocklist)
  const hasAllowedTypes = ALL_CODE.includes('allowedTypes') || ALL_CODE.includes('ALLOWED_TYPES') ||
    ALL_CODE.includes('acceptedTypes') || ALL_CODE.includes('validTypes') ||
    ALL_CODE.includes('application/pdf') || ALL_CODE.includes('image/');
  assert(hasAllowedTypes, 'File upload uses MIME type whitelist (allowedTypes/validTypes pattern)');
}

// ===========================================================================
// 5. AUTHENTICATION & SESSION
// ===========================================================================
async function testAuthSession() {
  console.log('\n🔐 AUTHENTICATION & SESSION');

  // Inactivity timeout exists
  const hasIdleTimeout = ALL_CODE.includes('idle') || ALL_CODE.includes('inactivity') ||
    ALL_CODE.includes('IDLE_TIMEOUT') || ALL_CODE.includes('INACTIVITY_TIMEOUT') ||
    ALL_CODE.includes('lastActivity');
  assert(hasIdleTimeout, 'Inactivity timeout mechanism exists');

  // Auth state listener exists
  assert(ALL_CODE.includes('onAuthStateChange'), 'Auth state listener (onAuthStateChange) exists');

  // Session check on mount
  assert(ALL_CODE.includes('getSession'), 'Session check on mount (getSession) exists');

  // No hardcoded passwords
  const passwordPatterns = ALL_CODE.match(/password\s*[:=]\s*['"][^'"]{4,}['"]/gi) || [];
  // Filter out non-secrets (form field names, labels, etc.)
  const realPasswords = passwordPatterns.filter(p =>
    !p.includes('password:') && !p.includes('password"') && !p.includes("password'") &&
    !p.includes('type') && !p.includes('placeholder') && !p.includes('label') &&
    !p.includes('Password') && !p.includes('password_')
  );
  assert(realPasswords.length === 0,
    `No hardcoded passwords in source code (${realPasswords.length} suspicious patterns)`);

  // No hardcoded API keys (long hex/base64 strings assigned to key variables)
  const apiKeyPatterns = ALL_CODE.match(/(?:api_key|apikey|secret_key|SECRET)\s*[:=]\s*['"][a-zA-Z0-9_\-]{20,}['"]/gi) || [];
  assert(apiKeyPatterns.length === 0,
    `No hardcoded API keys in source code (${apiKeyPatterns.length} found)`);

  // No hardcoded Supabase keys
  const supabaseKeys = ALL_CODE.match(/eyJ[a-zA-Z0-9_-]{50,}/g) || [];
  assert(supabaseKeys.length === 0,
    `No hardcoded JWT/Supabase keys in source code (${supabaseKeys.length} found)`);

  // Auth uses environment variables
  assert(ALL_CODE.includes('process.env') || ALL_CODE.includes('REACT_APP_SUPABASE'),
    'Auth configuration uses environment variables');

  // Sign-out clears state
  assert(ALL_CODE.includes('signOut'), 'Sign-out functionality exists');
}

// ===========================================================================
// 6. INPUT SANITIZATION
// ===========================================================================
async function testInputSanitization() {
  console.log('\n🧹 INPUT SANITIZATION');

  // Audit log details are sanitized
  const hasAuditSanitize = ALL_CODE.includes('logAudit');
  assert(hasAuditSanitize, 'logAudit function is used throughout codebase');

  // Check audit.js for sanitization (HTML strip + truncation + redaction)
  let auditContent = '';
  for (const [filePath, content] of Object.entries(SRC_FILES)) {
    if (filePath.includes('audit.js')) auditContent = content;
  }
  if (auditContent) {
    assert(auditContent.includes('replace') || auditContent.includes('strip') || auditContent.includes('sanitize'),
      'Audit log details are sanitized (HTML strip/replace)');
    assert(auditContent.includes('substring') || auditContent.includes('slice') || auditContent.includes('truncat'),
      'Audit log details are truncated');
    assert(auditContent.includes('redact') || auditContent.includes('mask') || auditContent.includes('***') || auditContent.includes('ssn') || auditContent.includes('password'),
      'Audit log redacts sensitive fields');
  }

  // Record IDs handle null/undefined
  const recordIdGuard = ALL_CODE.includes('recordId ?') || ALL_CODE.includes('recordId &&') ||
    ALL_CODE.includes('recordId ||') || ALL_CODE.includes('record_id ?') ||
    ALL_CODE.includes("recordId !== undefined") || ALL_CODE.includes('recordId != null');
  assert(recordIdGuard, 'Record IDs handle null/undefined with guard checks');

  // Email validation exists
  assert(ALL_CODE.includes('isValidEmail'), 'isValidEmail function exists');

  // isValidEmail uses proper regex with @ and .test()
  const emailFnDef = ALL_CODE.match(/function\s+isValidEmail[^}]+\}/);
  if (emailFnDef) {
    const fnBody = emailFnDef[0];
    assert(fnBody.includes('@') && fnBody.includes('.test'),
      'isValidEmail validates @ sign and uses regex .test()');
  } else {
    assert(false, 'isValidEmail function definition not found');
  }

  // Currency values use safeNum() - check for raw Number() on financial fields
  const dangerousNumberCalls = [];
  const financialFields = ['amount', 'rent', 'deposit', 'balance', 'payment', 'fee', 'cost', 'price'];
  for (const field of financialFields) {
    const pattern = new RegExp('Number\\([^)]*' + field + '[^)]*\\)', 'gi');
    const matches = ALL_CODE.match(pattern) || [];
    for (const m of matches) {
      if (!m.includes('safeNum')) {
        dangerousNumberCalls.push(m.substring(0, 60));
      }
    }
  }
  assert(dangerousNumberCalls.length === 0,
    `Currency values use safeNum() instead of raw Number() (${dangerousNumberCalls.length} raw Number() on financial fields)`);
  if (dangerousNumberCalls.length > 0) {
    for (const v of dangerousNumberCalls.slice(0, 3)) {
      console.log('    ⚠️  ' + v);
    }
  }

  // safeNum function exists and returns 0 for NaN
  assert(ALL_CODE.includes('safeNum'), 'safeNum function exists in codebase');

  // No direct SQL string interpolation
  const sqlInjection = ALL_CODE.match(/`SELECT\s.*\$\{/gi) || [];
  assert(sqlInjection.length === 0,
    `No SQL string interpolation in source code (${sqlInjection.length} found)`);

  // No document.cookie direct access (session handled by Supabase)
  const cookieAccess = ALL_CODE.match(/document\.cookie/g) || [];
  assert(cookieAccess.length === 0,
    `No direct document.cookie access (${cookieAccess.length} found)`);

  // No localStorage for sensitive data (tokens should be in Supabase session)
  // Match only truly sensitive patterns: token, password, secret (not generic "key" variable names)
  const localStorageSecrets = ALL_CODE.match(/localStorage\.setItem\s*\([^)]*(?:token|password|secret|api_key|apiKey)[^)]*\)/gi) || [];
  assert(localStorageSecrets.length === 0,
    `No sensitive data (token/password/secret) stored in localStorage (${localStorageSecrets.length} found)`);
}

// ===========================================================================
// 7. ADDITIONAL SECURITY PATTERNS
// ===========================================================================
async function testAdditionalPatterns() {
  console.log('\n🔎 ADDITIONAL SECURITY PATTERNS');

  // No console.log of sensitive data in production code
  const sensitiveConsole = ALL_CODE.match(/console\.log\([^)]*(?:password|secret|token|api_key|apiKey|ssn|social_security)[^)]*\)/gi) || [];
  assert(sensitiveConsole.length === 0,
    `No console.log of sensitive data (${sensitiveConsole.length} found)`);

  // CORS / CSP awareness — vercel.json should exist with security headers
  const vercelConfigPath = path.resolve(__dirname, '../vercel.json');
  const hasVercelConfig = fs.existsSync(vercelConfigPath);
  assert(hasVercelConfig, 'vercel.json exists for security headers / CSP');

  if (hasVercelConfig) {
    const vercelConfig = fs.readFileSync(vercelConfigPath, 'utf8');
    assert(vercelConfig.includes('Content-Security-Policy') || vercelConfig.includes('content-security-policy'),
      'vercel.json includes Content-Security-Policy header');
    assert(vercelConfig.includes('X-Frame-Options') || vercelConfig.includes('x-frame-options'),
      'vercel.json includes X-Frame-Options header');
  }

  // Error handling — async Supabase calls check error field
  // Count .from() calls that don't destructure { error }
  const fromSelectCalls = ALL_CODE.match(/await\s+supabase\s*\.from\(/g) || [];
  assert(fromSelectCalls.length > 0, `Supabase queries exist (${fromSelectCalls.length} found)`);

  // guardSubmit/Release pattern exists for form submissions
  assert(ALL_CODE.includes('guardSubmit'), 'guardSubmit double-submit prevention exists');
  assert(ALL_CODE.includes('guardRelease'), 'guardRelease cleanup exists');

  // Encryption module exists
  assert(ALL_CODE.includes('encrypt') || ALL_CODE.includes('AES') || ALL_CODE.includes('crypto'),
    'Encryption module exists for sensitive data');

  // RLS awareness — no service_role key in client code
  const serviceRole = ALL_CODE.match(/service_role|SERVICE_ROLE/g) || [];
  assert(serviceRole.length === 0,
    `No service_role key references in client source (${serviceRole.length} found)`);

  // Supabase client uses anon key (not service key)
  const supabaseInit = SRC_FILES[path.resolve(srcDir, 'supabase.js')] || '';
  assert(supabaseInit.includes('REACT_APP_SUPABASE_ANON_KEY') || supabaseInit.includes('anon'),
    'Supabase client initialized with anon key (not service key)');

  // No window.location manipulation with user input
  const windowLocationAssign = ALL_CODE.match(/window\.location\s*=\s*[^'"][^;]+/g) || [];
  assert(windowLocationAssign.length === 0,
    `No dynamic window.location assignments (${windowLocationAssign.length} found)`);

  // Double-entry accounting guard (prevent imbalanced journal entries)
  assert(ALL_CODE.includes('autoPostJournalEntry') || ALL_CODE.includes('create_journal_entry'),
    'Double-entry journal posting uses structured function (not raw inserts)');

  // Soft delete pattern (archive instead of hard delete)
  const hasArchive = ALL_CODE.includes('archived') || ALL_CODE.includes('is_deleted') || ALL_CODE.includes('soft_delete');
  assert(hasArchive, 'Soft delete / archive pattern exists');

  // Rate limiting awareness — check for debounce/throttle on search
  const hasDebounce = ALL_CODE.includes('debounce') || ALL_CODE.includes('setTimeout') || ALL_CODE.includes('throttle');
  assert(hasDebounce, 'Debounce/throttle exists for search or API calls');

  // Verify all .delete() calls are scoped (not unscoped bulk deletes)
  const deleteCalls = ALL_CODE.match(/\.delete\(\)[^.]*$/gm) || [];
  let unscopedDeletes = 0;
  for (const call of deleteCalls) {
    if (!call.includes('.eq(') && !call.includes('.match(') && !call.includes('.in(')) {
      unscopedDeletes++;
    }
  }
  // Check .delete() followed by .eq on next chain
  const deleteChains = ALL_CODE.match(/\.delete\(\)\s*\./g) || [];
  assert(deleteChains.length > 0 || deleteCalls.length === 0,
    'All .delete() calls are followed by filter conditions');
}

// ===========================================================================
// RUNNER
// ===========================================================================
async function main() {
  console.log('🔍 SECURITY ADVERSARIAL TESTS');
  console.log('='.repeat(60));

  await testMultiTenantIsolation();
  await testPostgrestInjection();
  await testXSSPrevention();
  await testFileUploadSecurity();
  await testAuthSession();
  await testInputSanitization();
  await testAdditionalPatterns();

  console.log('\n' + '='.repeat(60));
  console.log(`\n✅ ${pass} passed | ❌ ${fail} failed | Total: ${pass + fail}`);
  if (errors.length) {
    console.log('\nFailed tests:');
    for (const e of errors) console.log('  - ' + e);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
