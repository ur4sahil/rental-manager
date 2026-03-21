const fs = require('fs');
let content = fs.readFileSync('data-layer.test.js', 'utf8');

// Fix table name
content = content.replace(/from\('chart_of_accounts'\)/g, "from('acct_accounts')");

// Fix the journal entry test to match actual table structure
const oldJE = `var jeId = 'je-test-' + Date.now();
  var { error: je } = await supabase.from('journal_entries').insert({ id: jeId, date: new Date().toISOString().slice(0, 10), description: 'Test JE', reference: 'TEST', lines: JSON.stringify([{ account_id: '1000', debit: 100, credit: 0 }, { account_id: '4000', debit: 0, credit: 100 }]), total_debit: 100, total_credit: 100, status: 'posted' });
  assert(!je, 'Can insert balanced journal entry');
  if (!je) await supabase.from('journal_entries').delete().eq('id', jeId);`;

const newJE = `var { data: jeData, error: je } = await supabase.from('journal_entries').insert({ date: new Date().toISOString().slice(0, 10), account: 'Checking Account', description: 'Test JE - automated', debit: 100, credit: 0 }).select().single();
  assert(!je, 'Can insert journal entry');
  if (jeData) await supabase.from('journal_entries').delete().eq('id', jeData.id);`;

content = content.replace(oldJE, newJE);

fs.writeFileSync('data-layer.test.js', content);
console.log('✅ Test file fixed - table names and JE structure updated');
