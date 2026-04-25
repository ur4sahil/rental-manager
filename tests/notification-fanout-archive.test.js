// Two areas with no prior coverage:
//   1. TenantPortal fans out message_received to ALL active staff
//      (not just one admin via .limit(1)).
//   2. Tenant Archive drawer queries — ledger / docs / messages /
//      payments / work_orders for an archived tenant.
//
// Run: cd tests && node notification-fanout-archive.test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

let pass = 0, fail = 0;
function assert(ok, name, detail) { if (ok) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); fail++; } }

const tenantPortalJs = fs.readFileSync(path.join(__dirname, '../src/components/TenantPortal.js'), 'utf8');
const tenantsJs      = fs.readFileSync(path.join(__dirname, '../src/components/Tenants.js'), 'utf8');
const notificationsJs = fs.readFileSync(path.join(__dirname, '../src/utils/notifications.js'), 'utf8');

(async () => {
console.log('\nNotification fan-out + Tenant Archive drawer');
console.log('================================');

// ─── 1. Fan-out source-level checks ─────────────────────────
console.log('\n1. TenantPortal fan-out');
assert(/staffEmails/.test(tenantPortalJs), 'Uses staffEmails array (not single adminEmail)');
assert(/from\("company_members"\)[\s\S]{0,200}neq\("role", "tenant"\)/.test(tenantPortalJs),
  'Fetches all non-tenant active company_members');
assert(!/\.limit\(1\)\.maybeSingle\(\)[\s\S]{0,400}role.*admin/.test(tenantPortalJs),
  'No single-admin .limit(1) lookup left');
assert(/staffEmails\.map\(e =>\s*queueNotification/.test(tenantPortalJs),
  'Loops staffEmails to queueNotification each');
assert(/in_app: true, email: true, push: true/.test(notificationsJs),
  'queueNotification default channels: push:true (was push:false)');

// ─── 2. Live: a recent tenant message dropped one queue row per staff ─
console.log('\n2. Live — recent tenant→staff message fan-out');
const { data: cm } = await sb.from('company_members').select('user_email, role')
  .eq('company_id', SMITH).eq('status', 'active').neq('role', 'tenant');
const expectedRecipients = new Set((cm || []).map(c => c.user_email.toLowerCase()));
const { data: recentMsg } = await sb.from('messages')
  .select('id, created_at, tenant_id, sender_role')
  .eq('company_id', SMITH).eq('sender_role', 'tenant')
  .order('created_at', { ascending: false }).limit(1).maybeSingle();
if (recentMsg) {
  const winStart = new Date(new Date(recentMsg.created_at).getTime() - 5000).toISOString();
  const winEnd = new Date(new Date(recentMsg.created_at).getTime() + 5000).toISOString();
  const { data: q } = await sb.from('notification_queue')
    .select('recipient_email')
    .eq('company_id', SMITH).eq('type', 'message_received')
    .gte('created_at', winStart).lte('created_at', winEnd);
  const got = new Set((q || []).map(r => r.recipient_email.toLowerCase()));
  assert(got.size >= expectedRecipients.size,
    `Queue rows match staff count (got ${got.size}, expected ≥${expectedRecipients.size})`);
}

// ─── 3. Tenant Archive drawer queries are present ───────────
console.log('\n3. Tenant Archive drawer');
assert(/archivedDetail/.test(tenantsJs), 'archivedDetail state declared');
assert(/from\("ledger_entries"\)[\s\S]{0,300}archivedDetail|from\("ledger_entries"\)[\s\S]{0,300}eq\("tenant_id"/.test(tenantsJs),
  'Drawer fetches ledger_entries for archived tenant');
assert(/from\("documents"\)[\s\S]{0,200}eq\("company_id", companyId\)/.test(tenantsJs),
  'Drawer fetches documents');
assert(/from\("messages"\)[\s\S]{0,200}eq\("company_id", companyId\)/.test(tenantsJs),
  'Drawer fetches messages');
assert(/from\("payments"\)[\s\S]{0,200}eq\("company_id", companyId\)/.test(tenantsJs),
  'Drawer fetches payments');
assert(/from\("work_orders"\)[\s\S]{0,200}eq\("company_id", companyId\)/.test(tenantsJs),
  'Drawer fetches work_orders');
assert(/Restore/.test(tenantsJs) && /archived_at: null/.test(tenantsJs),
  'Restore button still present');

// ─── 4. Live: archive drawer can pull a Smith archived tenant ─
console.log('\n4. Live — pull a Smith archived tenant + history');
const { data: arch } = await sb.from('tenants').select('id, name, property')
  .eq('company_id', SMITH).not('archived_at', 'is', null).limit(1).maybeSingle();
if (arch) {
  const { data: ledger } = await sb.from('ledger_entries').select('id').eq('company_id', SMITH).eq('tenant_id', arch.id).limit(5);
  const { data: msgs }   = await sb.from('messages').select('id').eq('company_id', SMITH).eq('tenant_id', arch.id).limit(5);
  assert(Array.isArray(ledger), `ledger_entries query for archived tenant ${arch.id} returns array`, `name=${arch.name}`);
  assert(Array.isArray(msgs),   `messages query for archived tenant ${arch.id} returns array`);
}

console.log('\n================================');
console.log(`✅ Passed: ${pass}`);
console.log(`❌ Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
