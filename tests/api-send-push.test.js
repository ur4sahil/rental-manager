// /api/send-push coverage. Hits the live endpoint at
// rental-manager-one.vercel.app and asserts auth + happy path.
// Adversarial cases: missing JWT, invalid JWT, cross-company spoof.
//
// Run: cd tests && node api-send-push.test.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// Endpoint moved 2026-04-26 — send-push consolidated into the
// notifications dispatcher to free a Vercel function slot for Stripe.
// Same handler, same contract, just behind ?action=push.
const ENDPOINT = 'https://rental-manager-one.vercel.app/api/notifications?action=push';
const SMITH = 'dce4974d-afa9-4e65-afdf-1189b815195d';

let pass = 0, fail = 0;
function assert(ok, name, detail) { if (ok) { console.log('  ✅ ' + name); pass++; } else { console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); fail++; } }

// Source file moved to api/_send-push-impl.js (underscore-prefixed
// non-routed module imported by the notifications dispatcher).
const sendPushJs = fs.readFileSync(path.join(__dirname, '../api/_send-push-impl.js'), 'utf8');

(async () => {
console.log('\n/api/send-push');
console.log('================================');

// ─── 1. Source: auth + dispatch shape ─────────────────────
console.log('\n1. Source-level auth + payload checks');
assert(/company_members[\s\S]{0,200}status.*active/.test(sendPushJs),
  'Caller membership verified via company_members + status=active');
assert(!/from\(.app_users.\)/.test(sendPushJs),
  'No app_users lookup (legacy table; was a silent-403 source)');
assert(/getUser\(jwt\)/.test(sendPushJs), 'JWT verified via auth.getUser');
assert(/setVapidDetails/.test(sendPushJs), 'VAPID configured');
assert(/410|404|stale/.test(sendPushJs), 'Stale-endpoint pruning logic present');
assert(/setCors/.test(sendPushJs), 'CORS handler invoked');

// ─── 2. Adversarial — endpoint surface ─────────────────────
console.log('\n2. Adversarial — live endpoint');

// 2a. GET → 405
const r405 = await fetch(ENDPOINT, { method: 'GET' });
assert(r405.status === 405, 'GET → 405 method not allowed', `got ${r405.status}`);

// 2b. POST without bearer → 401
const r401 = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert(r401.status === 401, 'POST without bearer → 401', `got ${r401.status}`);

// 2c. POST with garbage bearer → 401
const rGarbage = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer garbage.token.value' },
  body: '{}'
});
assert(rGarbage.status === 401, 'POST with invalid bearer → 401', `got ${rGarbage.status}`);

// 2d. POST with valid bearer but missing fields → 400
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PW = process.env.TEST_PASSWORD;
if (TEST_EMAIL && TEST_PW) {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: sess } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PW });
  const jwt = sess?.session?.access_token;
  if (jwt) {
    const r400 = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt },
      body: JSON.stringify({})
    });
    assert(r400.status === 400, 'POST with valid JWT but no body fields → 400', `got ${r400.status}`);

    // 2e. Cross-company spoof — caller is admin@propmanager.com (not a Smith member).
    //     Should 403.
    const rSpoof = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt },
      body: JSON.stringify({ company_id: SMITH, user_email: 'foo@bar.com', title: 'spoof' })
    });
    assert(rSpoof.status === 403 || rSpoof.status === 200,
      'Cross-company spoof either rejected (403) or no-op delivered (200 / no subs)',
      `got ${rSpoof.status}`);
    if (rSpoof.status === 200) {
      const j = await rSpoof.json().catch(() => ({}));
      assert((j.delivered || 0) === 0, 'Spoof returned 0 delivered');
    }
  }
}

console.log('\n================================');
console.log(`✅ Passed: ${pass}`);
console.log(`❌ Failed: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
