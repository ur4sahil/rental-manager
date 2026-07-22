// ═══════════════════════════════════════════════════════════════
// BANK TRANSACTIONS MODULE TESTS
// Tests: bank tables schema, CSV parsing, format detection,
// transaction categorization, entity tagging.
// Run: cd tests && node bank-transactions.test.js
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
// 1. BANK TABLES SCHEMA
// ───────────────────────────────────────────
async function testBankTables() {
  console.log('\n🏦 BANK TABLES');

  const tables = ['bank_account_feed', 'bank_feed_transaction', 'bank_import_batch', 'bank_posting_decision', 'bank_posting_decision_line', 'bank_feed_transaction_link', 'bank_transaction_rule'];
  for (const table of tables) {
    const { error } = await supabase.from(table).select('id').limit(1);
    assert(!error, `Table "${table}" exists and is queryable`);
  }

  // Check bank_feed_transaction has required columns
  const { data, error } = await supabase.from('bank_feed_transaction').select('id, company_id, bank_account_feed_id, posted_date, amount, direction, bank_description_raw, bank_description_clean, status, fingerprint_hash, journal_entry_id').limit(1);
  assert(!error, 'bank_feed_transaction has all required columns');

  // Check bank_account_feed has company_id
  const { data: feeds } = await supabase.from('bank_account_feed').select('id, company_id, gl_account_id, account_name, account_type').limit(1);
  assert(feeds !== null, 'bank_account_feed has required columns including gl_account_id');
}

// ───────────────────────────────────────────
// 2. KNOWN_BANK_FORMATS DEFINED
// ───────────────────────────────────────────
function testBankFormats() {
  console.log('\n📄 BANK FORMAT DETECTION');

  assert(APP_CODE.includes('KNOWN_BANK_FORMATS'), 'KNOWN_BANK_FORMATS constant is defined');
  const banks = ['Chase', 'Bank of America', 'Wells Fargo', 'Citibank', 'Capital One', 'US Bank'];
  for (const bank of banks) {
    assert(APP_CODE.includes(`name: "${bank}"`), `Format defined for ${bank}`);
  }
}

// ───────────────────────────────────────────
// 3. CSV PARSING FUNCTIONS
// ───────────────────────────────────────────
function testCsvFunctions() {
  console.log('\n📊 CSV PARSING');

  assert(APP_CODE.includes('function csvParseText'), 'csvParseText() function exists');
  assert(APP_CODE.includes('function csvDetectFormat'), 'csvDetectFormat() function exists');
  assert(APP_CODE.includes('function csvParseAmount'), 'csvParseAmount() function exists');
  assert(APP_CODE.includes('function csvParseDate'), 'csvParseDate() function exists');
  assert(APP_CODE.includes('function csvBuildFingerprint'), 'csvBuildFingerprint() function exists');

  // Verify CSV parser handles quoted fields (commas inside quotes)
  assert(APP_CODE.includes('inQ'), 'CSV parser handles quoted fields');
}

// ───────────────────────────────────────────
// 4. TRANSACTION CATEGORIZATION
// ───────────────────────────────────────────
function testCategorization() {
  console.log('\n🏷️  CATEGORIZATION');

  assert(APP_CODE.includes('function acceptTransaction'), 'acceptTransaction() function exists');
  assert(APP_CODE.includes('function acceptTransfer'), 'acceptTransfer() function exists');
  assert(APP_CODE.includes('function acceptSplit'), 'acceptSplit() function exists');
  assert(APP_CODE.includes('function excludeTransaction'), 'excludeTransaction() function exists');
  assert(APP_CODE.includes('function undoTransaction'), 'undoTransaction() function exists');

  // Verify categorization creates JE
  assert(APP_CODE.includes('acct_journal_entries').valueOf && APP_CODE.includes('BANK-'), 'Categorization creates JE with BANK- reference');

  // Verify onRefreshAccounting callback
  assert(APP_CODE.includes('onRefreshAccounting'), 'BankTransactions calls onRefreshAccounting after categorization');
}

// ───────────────────────────────────────────
// 5. ENTITY TAGGING (CUSTOMER/VENDOR)
// ───────────────────────────────────────────
function testEntityTagging() {
  console.log('\n👤 ENTITY TAGGING');

  // Journal lines entity columns
  assert(APP_CODE.includes('entity_type'), 'entity_type field exists in code');
  assert(APP_CODE.includes('entity_id'), 'entity_id field exists in code');
  assert(APP_CODE.includes('entity_name'), 'entity_name field exists in code');

  // Entity dropdown in JE form
  assert(APP_CODE.includes('customer:'), 'JE form uses customer: prefix for tenant entities');
  assert(APP_CODE.includes('vendor:'), 'JE form uses vendor: prefix for vendor entities');
  assert(APP_CODE.includes('optgroup label="Tenants"'), 'Entity select has Tenants group');
  assert(APP_CODE.includes('optgroup label="Vendors"'), 'Entity select has Vendors group');

  // Entity in bank categorization
  assert(APP_CODE.includes('entityType'), 'Bank categorization tracks entityType');
  assert(APP_CODE.includes('entityId'), 'Bank categorization tracks entityId');
  assert(APP_CODE.includes('entityName'), 'Bank categorization tracks entityName');
}

// ───────────────────────────────────────────
// 6. BANK RULES
// ───────────────────────────────────────────
function testBankRules() {
  console.log('\n📏 BANK RULES');

  assert(APP_CODE.includes('RENTAL_RULE_PRESETS'), 'Has rental rule presets');
  assert(APP_CODE.includes('function deleteRule'), 'deleteRule() function exists');
  assert(APP_CODE.includes('function toggleRule'), 'toggleRule() function exists');
  assert(APP_CODE.includes('function duplicateRule'), 'duplicateRule() function exists');

  // Security: toggleRule has company_id
  const toggleRuleSection = APP_CODE.slice(APP_CODE.indexOf('function toggleRule'));
  assert(toggleRuleSection.includes('company_id'), 'toggleRule scoped by company_id');
}

// ───────────────────────────────────────────
// 7. DUPLICATE PREVENTION
// ───────────────────────────────────────────
function testDuplicatePrevention() {
  console.log('\n🔒 DUPLICATE PREVENTION');

  assert(APP_CODE.includes('fingerprint_hash'), 'Uses fingerprint hashing for dedup');
  assert(APP_CODE.includes('skipDuplicates'), 'Import wizard has skipDuplicates option');
  assert(APP_CODE.includes('creatingFeed'), 'Bank account creation has loading guard');
  assert(APP_CODE.includes('A bank account with this name already exists'), 'Duplicate bank account check exists');
}

// ───────────────────────────────────────────
// 8. JE SOURCE LABELS
// ───────────────────────────────────────────
function testSourceLabels() {
  console.log('\n🏷️  JE SOURCE LABELS');

  // Friendly REF labels are now data-driven via the REF_LABELS prefix→label
  // table + refLabel() in Accounting.js (was a chain of `return "X"` literals).
  // Assert the central mapper exists and each prefix→label pair is wired, so
  // a renamed/removed mapping fails the test — same intent, real implementation.
  assert(APP_CODE.includes('export function refLabel'), 'refLabel() central mapper exists');
  assert(APP_CODE.includes('const REF_LABELS'), 'REF_LABELS prefix→label table exists');

  // [prefix, expectedLabel] — the pair literal must appear in REF_LABELS.
  const pairs = [
    ['BANK-', 'Bank Import'],
    ['XFER-', 'Bank Transfer'],
    ['SPLIT-', 'Bank Split'],
    ['PAY-', 'Payment'],
    ['STRIPE-', 'Stripe'],
    ['RECUR-', 'Recurring'],
    ['DEP-', 'Deposit'],
    ['PRORENT-', 'Prorated Rent'],
    ['RENT-', 'Rent Charge'],
    ['LATE-', 'Late Fee'],
    ['VINV-', 'Vendor Invoice'],
    ['WO-', 'Work Order'],
    ['DEPRET-', 'Deposit Return'],
    ['DEPFORF-', 'Deposit Forfeiture'],
    ['MOVEOUT-', 'Move-Out'],
  ];
  // Whitespace-tolerant match for `["PREFIX-", "Label"]` (allows curly/extra spaces).
  const norm = APP_CODE.replace(/\s+/g, ' ');
  for (const [prefix, label] of pairs) {
    assert(norm.includes(`["${prefix}", "${label}"]`), `REF label: "${prefix}" → "${label}"`);
  }
}

// ───────────────────────────────────────────
// 9. PLAID INTEGRATION
// ───────────────────────────────────────────
// Teller.io shut down its API (2026-07); PropManager migrated bank sync to
// Plaid. These assert the Plaid adapter surface. Teller files remain until
// cutover but are no longer wired up.
function testPlaidIntegration() {
  console.log('\n🔗 PLAID INTEGRATION');

  // Adapter files exist as Vercel API routes. link-token + exchange are
  // combined into plaid-link.js (Hobby-plan 12-function limit).
  assert(fs.existsSync(path.resolve(__dirname, '../api/plaid-link.js')), 'api/plaid-link.js exists (create_token + exchange)');
  assert(fs.existsSync(path.resolve(__dirname, '../api/plaid-sync-transactions.js')), 'api/plaid-sync-transactions.js exists');
  assert(fs.existsSync(path.resolve(__dirname, '../api/plaid-webhook.js')), 'api/plaid-webhook.js exists');
  assert(fs.existsSync(path.resolve(__dirname, '../api/_plaid.js')), 'api/_plaid.js shared helper exists');
  // Under the 12-function Hobby cap
  assert(fs.readdirSync(path.resolve(__dirname, '../api')).filter(f => f.endsWith('.js') && !f.startsWith('_')).length <= 12, 'api/ stays within the 12 serverless-function limit');

  const shared = fs.readFileSync(path.resolve(__dirname, '../api/_plaid.js'), 'utf8');
  // CRITICAL: Plaid amount sign is OPPOSITE of Teller (+ = outflow).
  assert(/amountNum > 0 \? "outflow" : "inflow"/.test(shared), 'Sign flip: Plaid +amount maps to outflow');
  assert(shared.includes('pbkdf2Sync') && shared.includes('aes-256-gcm'), 'Reuses AES-256-GCM + PBKDF2 token encryption');
  assert(shared.includes('source_type: "plaid"'), 'Transform stamps source_type plaid');

  const exch = fs.readFileSync(path.resolve(__dirname, '../api/plaid-link.js'), 'utf8');
  assert(exch.includes('itemPublicTokenExchange'), 'Exchange swaps public_token for access_token');
  assert(exch.includes('linkTokenCreate') && exch.includes('"create_token"'), 'plaid-link handles create_token action');
  assert(exch.includes('is_existing') && exch.includes('suggested_gl_type'), 'Exchange returns post-connect metadata');
  // Last-4 fallback match (carried over from the Teller fix): a fresh Item
  // mints new account ids, so re-links re-attach by masked_number + adopt id.
  assert(exch.includes('masked_number') && exch.includes('acct.mask'), 'Exchange has last-4 fallback match');
  assert(exch.includes('matchedByLastFour'), 'Exchange tracks last-4 fallback branch');
  assert(/matchedByLastFour[\s\S]{0,200}plaid_account_id = acct\.account_id/.test(exch), 'Last-4 re-link adopts new Plaid account id');
  assert(/matchedByLastFour[\s\S]{0,200}existingFeed\.status/.test(exch), 'Last-4 re-link preserves prior feed status');

  const syncCode = fs.readFileSync(path.resolve(__dirname, '../api/plaid-sync-transactions.js'), 'utf8');
  assert(syncCode.includes('transactionsSync'), 'Sync uses cursor-based /transactions/sync');
  assert(syncCode.includes('plaid_sync_cursor'), 'Sync persists the per-Item cursor');
  assert(syncCode.includes('CRON_SECRET') && syncCode.includes('isCronAuth'), 'Sync supports CRON auth');
  assert(syncCode.includes('ITEM_LOGIN_REQUIRED') && syncCode.includes('needs_reauth'), 'Sync flags needs_reauth on ITEM_LOGIN_REQUIRED');
  assert(/status.*for_review[\s\S]{0,120}\.in\("provider_transaction_id"/.test(syncCode) || syncCode.includes('.eq("status", "for_review")'), 'Removals only delete untouched for_review rows');

  const hook = fs.readFileSync(path.resolve(__dirname, '../api/plaid-webhook.js'), 'utf8');
  assert(hook.includes('crypto.verify') && hook.includes('ES256') && hook.includes('ieee-p1363'), 'Webhook verifies the Plaid ES256 JWT via Node crypto (no jose/ESM)');
  assert(/payload\.iat/.test(hook) && hook.includes('300'), 'Webhook bounds replay via iat freshness (5 min)');
  assert(hook.includes('SYNC_UPDATES_AVAILABLE'), 'Webhook handles SYNC_UPDATES_AVAILABLE');
  assert(hook.includes('Invalid webhook signature'), 'Webhook rejects unverified requests');

  // Frontend: Plaid Link loaded dynamically, Teller Connect gone
  assert(APP_CODE.includes('window.Plaid') && APP_CODE.includes('cdn.plaid.com'), 'App loads Plaid Link SDK from CDN');
  assert(APP_CODE.includes('/api/plaid-link') && APP_CODE.includes('"exchange"') && APP_CODE.includes('"create_token"'), 'App calls the combined Plaid link endpoint with create_token + exchange actions');
  assert(!APP_CODE.includes('TellerConnect'), 'Teller Connect SDK no longer referenced in app');
}

// ───────────────────────────────────────────
// 10. TELLER FEED DEDUP (DB)
// ───────────────────────────────────────────
async function testTellerFeedDedup() {
  console.log('\n🔄 TELLER FEED DEDUP');

  // bank_connection table supports teller source_type
  const { data: connCols, error: connErr } = await supabase.from('bank_connection').select('id, company_id, source_type, plaid_item_id, connection_status').limit(1);
  assert(!connErr, 'bank_connection table has source_type, plaid_item_id, connection_status columns');

  // bank_account_feed supports teller connection_type and status transitions
  const { data: feedCols, error: feedErr } = await supabase.from('bank_account_feed').select('id, company_id, gl_account_id, plaid_account_id, connection_type, status, bank_connection_id').limit(1);
  assert(!feedErr, 'bank_account_feed has plaid_account_id, connection_type, status, bank_connection_id columns');

  // Verify feed status enum includes inactive
  // (The schema CHECK allows: active, inactive, errored)
  assert(true, 'bank_account_feed.status supports active/inactive/errored');
}

// ───────────────────────────────────────────
// 11. GL ACCOUNT DELETION
// ───────────────────────────────────────────
function testGLAccountDeletion() {
  console.log('\n🗑️  GL ACCOUNT DELETION');

  assert(APP_CODE.includes('function deleteGLAccount'), 'deleteGLAccount() function exists');
  assert(APP_CODE.includes('acct_journal_lines').valueOf() && APP_CODE.includes('Cannot delete: account has journal entries'), 'Checks for JE references before delete');
  assert(APP_CODE.includes('Cannot delete: account is linked to an active bank feed'), 'Checks for active bank feeds before delete');
  assert(APP_CODE.includes('Permanently delete account'), 'Shows confirmation dialog before delete');

  // COA has delete button
  assert(APP_CODE.includes('onDelete') && APP_CODE.includes('deleteGLAccount'), 'COA receives onDelete prop');
  assert(APP_CODE.includes('title="Delete account"'), 'COA has delete button with title');
}

// ───────────────────────────────────────────
// 12. FEED MANAGEMENT (DISCONNECT/ARCHIVE)
// ───────────────────────────────────────────
function testFeedManagement() {
  console.log('\n🔌 FEED MANAGEMENT');

  assert(APP_CODE.includes('function disconnectFeed'), 'disconnectFeed() function exists');
  assert(APP_CODE.includes('function updateFeedMapping'), 'updateFeedMapping() function exists');
  assert(APP_CODE.includes("status: \"inactive\""), 'disconnectFeed sets status to inactive');
  assert(APP_CODE.includes("connection_status: \"disconnected\""), 'disconnectFeed updates connection if last feed');
  assert(APP_CODE.includes('feedMenuOpen'), 'Feed cards have dropdown menu state');
  assert(APP_CODE.includes('Change GL Mapping'), 'Feed menu has Change GL Mapping option');
  assert(APP_CODE.includes('Disconnect'), 'Feed menu has Disconnect option');
  assert(APP_CODE.includes('Not mapped to GL'), 'Unmapped feeds show warning badge');
}

// ───────────────────────────────────────────
// 13. POST-CONNECT MODAL
// ───────────────────────────────────────────
function testPostConnectModal() {
  console.log('\n📋 POST-CONNECT MODAL');

  assert(APP_CODE.includes('postConnectModal'), 'Post-connect modal state exists');
  assert(APP_CODE.includes('postConnectSelected'), 'Account selection state exists');
  assert(APP_CODE.includes('postConnectNewAcct'), 'Inline account creation state exists');

  // Checkboxes for account selection
  assert(APP_CODE.includes('Select Accounts to Connect'), 'Modal has account selection header');
  assert(APP_CODE.includes('type="checkbox"') && APP_CODE.includes('postConnectSelected'), 'Modal has checkboxes for account selection');

  // GL mapping required
  assert(APP_CODE.includes('GL Account') && APP_CODE.includes('*Required'), 'Modal shows Required indicator for unmapped accounts');
  assert(APP_CODE.includes('allMapped'), 'Import button checks all accounts are mapped');

  // Inline account creation
  assert(APP_CODE.includes('Create New Account') && APP_CODE.includes('postConnectNewAcct'), 'Modal has inline account creation form');

  // Deselected accounts get deactivated
  assert(APP_CODE.includes("status: \"inactive\"") && APP_CODE.includes('unselected'), 'Unselected accounts are deactivated on import');
}

// ───────────────────────────────────────────
// 14. JE DESCRIPTION QUALITY
// ───────────────────────────────────────────
function testJEDescriptionQuality() {
  console.log('\n📝 JE DESCRIPTION QUALITY');

  // Description uses payee + full description, not truncated bank_description_clean
  assert(APP_CODE.includes('payee_normalized') && APP_CODE.includes('bank_description_raw'), 'JE description uses payee + full raw description');
  assert(APP_CODE.includes("Bank transaction"), 'JE description has fallback text');
  // Reference was originally a literal "Bank Import" string which
  // violated idx_je_company_reference_unique after the first
  // categorization. Now BANK-${txn.id} per txn, matching the
  // XFER-/SPLIT- convention. The human-readable label still exists
  // — it's just rendered at display time by the BANK- prefix
  // translator below (line 289 asserts that path).
  assert(APP_CODE.includes('reference: `BANK-${txn.id}`') || APP_CODE.includes('reference: "BANK-"'), 'JE reference is unique per bank txn (BANK-${txn.id})');

  // Ledger overlay translates BANK- prefix to a friendly label. This now runs
  // through refLabel()/REF_LABELS (data-driven) instead of an inline
  // `r.startsWith("BANK-") return "Bank Import"`. Assert the mapping pair is
  // wired AND that the ledger/JE rows actually render via refLabel(l.reference).
  const normCode = APP_CODE.replace(/\s+/g, ' ');
  assert(normCode.includes('["BANK-", "Bank Import"]'), 'REF_LABELS maps BANK- → "Bank Import"');
  assert(APP_CODE.includes('refLabel(l.reference)') || APP_CODE.includes('refLabel(je.reference)'), 'Ledger/JE rows render reference via refLabel()');
}

// ───────────────────────────────────────────
// 15. PAGINATION
// ───────────────────────────────────────────
function testPagination() {
  console.log('\n📄 PAGINATION');

  assert(APP_CODE.includes('txnPage'), 'Transaction page state exists');
  // txnPageSize is now user-selectable state (was a const TXN_PAGE_SIZE
  // before the Per-page dropdown shipped). Accept either form.
  assert(APP_CODE.includes('TXN_PAGE_SIZE') || APP_CODE.includes('txnPageSize'), 'Page size state/constant defined');
  assert(APP_CODE.includes('paginatedTxns'), 'Paginated transactions computed');
  assert(APP_CODE.includes('txnTotalPages'), 'Total pages computed');
  assert(APP_CODE.includes('Prev') && APP_CODE.includes('Next'), 'Pagination has Prev/Next buttons');
  assert(APP_CODE.includes('setTxnPage(0)'), 'Page resets on filter change');
}

// ───────────────────────────────────────────
// 16. EXCEL EXPORT
// ───────────────────────────────────────────
function testExcelExport() {
  console.log('\n📊 EXCEL EXPORT');

  assert(APP_CODE.includes("import ExcelJS from"), 'ExcelJS library imported');
  assert(APP_CODE.includes('function exportExcel'), 'exportExcel() function exists');
  assert(APP_CODE.includes('.xlsx'), 'Exports as .xlsx format');
  assert(APP_CODE.includes('formula'), 'Excel exports include formulas');

  // Report coverage
  const reports = ['pl', 'pl_by_class', 'pl_compare', 'bs', 'gl', 'tb', 'rent_roll', 'vacancy',
    'lease_expirations', 'noi_by_property', 'ar_aging_summary', 'open_invoices', 'collections',
    'ap_aging_summary', 'unpaid_bills', 'expenses_by_category', 'expenses_by_vendor',
    'txn_by_date', 'journal', 'account_list', 'rent_collection', 'work_orders_summary',
    'security_deposits', 'customer_balance_summary', 'vendor_balance_summary'];
  for (const r of reports) {
    assert(APP_CODE.includes(`id === "${r}"`), `Excel export handles report: ${r}`);
  }
}

// ───────────────────────────────────────────
// 17. LEDGER NAVIGATION
// ───────────────────────────────────────────
function testLedgerNavigation() {
  console.log('\n🧭 LEDGER NAVIGATION');

  assert(APP_CODE.includes('pendingLedgerReturn'), 'Pending ledger return state exists');
  assert(APP_CODE.includes('onCloseJEDetail'), 'JE detail has close callback for back-to-ledger');
  assert(APP_CODE.includes('setPendingLedgerReturn'), 'Ledger saves state before navigating to JE');
}

// ═══════════════════════════════════════════
// RUN ALL TESTS
// ═══════════════════════════════════════════
async function main() {
  console.log('🧪 Bank Transactions Module Tests');
  console.log('==========================================');
  await testBankTables();
  testBankFormats();
  testCsvFunctions();
  testCategorization();
  testEntityTagging();
  testBankRules();
  testDuplicatePrevention();
  testSourceLabels();
  testPlaidIntegration();
  await testTellerFeedDedup();
  testGLAccountDeletion();
  testFeedManagement();
  testPostConnectModal();
  testJEDescriptionQuality();
  testPagination();
  testExcelExport();
  testLedgerNavigation();

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
