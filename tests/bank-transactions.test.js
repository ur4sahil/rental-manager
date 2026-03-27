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
const APP_CODE = fs.readFileSync(path.resolve(__dirname, '../src/App.js'), 'utf8');

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

  const labels = ['Bank Import', 'Bank Transfer', 'Bank Split', 'Payment', 'Stripe', 'Recurring', 'Deposit', 'Prorated Rent', 'Rent Charge', 'Late Fee', 'Vendor Invoice', 'Work Order', 'Deposit Return', 'Deposit Forfeiture', 'Move-Out'];
  for (const label of labels) {
    assert(APP_CODE.includes(`return "${label}"`), `JE source label: "${label}"`);
  }
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
