// ═══════════════════════════════════════════════════════════════
// DOC SIGNATURES — unified e-sign engine (phase 8)
// Exercises the three SECURITY DEFINER RPCs shipped in
// supabase/migrations/20260406_doc_builder_esign.sql:
//   - get_signature_by_token(token)
//   - sign_document(token, name, data, method, consent, ua)
//   - create_doc_envelope(doc_id, signers)  — auth-gated; only
//     checked for its rejection of anon callers here.
// Covers happy path + token/email/method/consent validation +
// sequential envelope advancement + envelope completion.
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SERVICE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY    = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLIC_KEY;
if (!SERVICE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in tests/.env');
  process.exit(1);
}

const svc  = createClient(SERVICE_URL, SERVICE_KEY);
const anon = ANON_KEY ? createClient(SERVICE_URL, ANON_KEY) : null;

const COMPANY_ID = 'sandbox-llc';

let pass = 0, fail = 0, errors = [];
function assert(ok, name, detail) {
  if (ok) { console.log('  ✅ ' + name); pass++; }
  else { console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); fail++; errors.push(name); }
}

// Helper: hand-crafted URL-safe token (doesn't go through _gen_signing_token
// because service-role inserts bypass the RPC path).
function mkToken(prefix) {
  const rand = require('crypto').randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return prefix + '-' + rand;
}

async function createDoc(name, body) {
  const { data, error } = await svc.from('doc_generated').insert([{
    company_id: COMPANY_ID,
    template_id: null,
    name: name,
    rendered_body: body,
    field_values: {},
    output_type: 'lease',
    status: 'sent',
    envelope_status: 'out_for_signature',
    envelope_sent_at: new Date().toISOString(),
  }]).select().single();
  if (error) throw new Error('createDoc failed: ' + error.message);
  return data;
}

async function createSig(docId, role, email, order, status, tokenOverride, expiryOverride) {
  const token = tokenOverride || mkToken(role);
  const expiry = expiryOverride || new Date(Date.now() + 30 * 86400000).toISOString();
  const { data, error } = await svc.from('doc_signatures').insert([{
    company_id: COMPANY_ID,
    doc_id: docId,
    signer_role: role,
    signer_name: role.charAt(0).toUpperCase() + role.slice(1) + ' Test',
    signer_email: email,
    sign_order: order,
    status: status || 'sent',
    access_token: token,
    token_expires_at: expiry,
    sent_at: new Date().toISOString(),
  }]).select().single();
  if (error) throw new Error('createSig failed: ' + error.message);
  return data;
}

async function cleanupDoc(docId) {
  // Cascades to doc_signatures.
  await svc.from('doc_generated').delete().eq('id', docId);
}

// ───────────────────────────────────────────────────────────────
// 1. get_signature_by_token
// ───────────────────────────────────────────────────────────────
async function testGetByToken() {
  console.log('\n🔑 get_signature_by_token');
  const doc = await createDoc('Test GET doc', '<p>Hello {{name}}</p>');
  const sig = await createSig(doc.id, 'tenant', 'tenant@example.com', 1, 'sent');

  try {
    // Happy path — returns payload + marks viewed_at
    const { data: payload, error } = await svc.rpc('get_signature_by_token', { p_token: sig.access_token });
    assert(!error, 'no RPC error on valid token', error?.message);
    assert(payload && !payload.error, 'payload has no error field');
    assert(payload && payload.doc_id === doc.id, 'payload.doc_id matches');
    assert(payload && payload.signer_email === 'tenant@example.com', 'email surfaced correctly');
    assert(payload && payload.doc_body && payload.doc_body.includes('Hello'), 'doc_body included');
    assert(payload && payload.status === 'viewed', 'status flipped to viewed on first call');
    const { data: after } = await svc.from('doc_signatures').select('status, viewed_at').eq('id', sig.id).single();
    assert(after?.status === 'viewed' && !!after?.viewed_at, 'viewed_at stamped in DB');

    // Second call on 'viewed' — still returns payload, doesn't re-stamp
    const beforeTs = after.viewed_at;
    const { data: payload2 } = await svc.rpc('get_signature_by_token', { p_token: sig.access_token });
    assert(payload2 && payload2.doc_id === doc.id, 'second call still returns payload');
    const { data: after2 } = await svc.from('doc_signatures').select('viewed_at').eq('id', sig.id).single();
    assert(after2.viewed_at === beforeTs, 'viewed_at not overwritten on subsequent calls');

    // Invalid token
    const { data: bad } = await svc.rpc('get_signature_by_token', { p_token: 'nope-nope-not-a-real-token-ever' });
    assert(bad?.error, 'unknown token returns error payload');

    // Short token (< 20 chars)
    const { data: tooShort } = await svc.rpc('get_signature_by_token', { p_token: 'abc' });
    assert(tooShort?.error === 'invalid token', 'short token rejected with "invalid token"');

    // Expired token
    const expiredSig = await createSig(doc.id, 'cosigner', 'co@example.com', 2, 'sent', null, new Date(Date.now() - 86400000).toISOString());
    const { data: expired } = await svc.rpc('get_signature_by_token', { p_token: expiredSig.access_token });
    assert(expired?.error === 'token expired', 'expired token rejected with "token expired"');
  } finally {
    await cleanupDoc(doc.id);
  }
}

// ───────────────────────────────────────────────────────────────
// 2. sign_document — validation paths
// ───────────────────────────────────────────────────────────────
async function testSignValidation() {
  console.log('\n🚫 sign_document — validation');
  const doc = await createDoc('Test validation doc', '<p>body</p>');
  const sig = await createSig(doc.id, 'tenant', 'v@example.com', 1, 'sent');

  try {
    const baseConsent = 'I agree to be legally bound by this document.';
    const baseUA = 'Mozilla/5.0 (Test Runner)';

    // Short signature
    const { data: short } = await svc.rpc('sign_document', {
      p_token: sig.access_token,
      p_signer_name: 'Foo',
      p_signature_data: 'xxx',
      p_signing_method: 'type',
      p_consent_text: baseConsent,
      p_user_agent: baseUA,
    });
    assert(short?.error === 'signature required', 'signature data < 10 chars rejected');

    // Missing consent
    const { data: noConsent } = await svc.rpc('sign_document', {
      p_token: sig.access_token,
      p_signer_name: 'Foo',
      p_signature_data: 'typed:Foo Bar|ts:2026-04-17T00:00:00Z',
      p_signing_method: 'type',
      p_consent_text: '',
      p_user_agent: baseUA,
    });
    assert(noConsent?.error === 'consent text required', 'missing consent rejected');

    // Invalid signing method
    const { data: badMethod } = await svc.rpc('sign_document', {
      p_token: sig.access_token,
      p_signer_name: 'Foo',
      p_signature_data: 'typed:Foo Bar|ts:2026-04-17T00:00:00Z',
      p_signing_method: 'stamp',
      p_consent_text: baseConsent,
      p_user_agent: baseUA,
    });
    assert(badMethod?.error === 'invalid signing method', 'unsupported method rejected');

    // Unknown token
    const { data: badToken } = await svc.rpc('sign_document', {
      p_token: 'definitely-not-a-real-token-just-padding-to-reach-20-characters',
      p_signer_name: 'Foo',
      p_signature_data: 'typed:Foo Bar|ts:2026-04-17T00:00:00Z',
      p_signing_method: 'type',
      p_consent_text: baseConsent,
      p_user_agent: baseUA,
    });
    assert(badToken?.error === 'token not found', 'unknown token rejected');

    // Expired token
    const expiredSig = await createSig(doc.id, 'landlord', 'll@example.com', 2, 'sent', null, new Date(Date.now() - 3600 * 1000).toISOString());
    const { data: expired } = await svc.rpc('sign_document', {
      p_token: expiredSig.access_token,
      p_signer_name: 'Foo',
      p_signature_data: 'typed:Foo Bar|ts:2026-04-17T00:00:00Z',
      p_signing_method: 'type',
      p_consent_text: baseConsent,
      p_user_agent: baseUA,
    });
    assert(expired?.error === 'token expired', 'expired token rejected');
  } finally {
    await cleanupDoc(doc.id);
  }
}

// ───────────────────────────────────────────────────────────────
// 3. sign_document — happy path, hash, idempotence
// ───────────────────────────────────────────────────────────────
async function testSignHappyPath() {
  console.log('\n✍️  sign_document — happy path');
  const doc = await createDoc('Happy-path doc', '<p>This is the body.</p>');
  const sig = await createSig(doc.id, 'tenant', 'happy@example.com', 1, 'sent');

  try {
    const consent = 'I agree that my electronic signature is the legal equivalent of my manual/handwritten signature.';
    const sigData = 'typed:Happy Tenant|ts:' + new Date().toISOString();
    const { data: result, error } = await svc.rpc('sign_document', {
      p_token: sig.access_token,
      p_signer_name: 'Happy Tenant',
      p_signature_data: sigData,
      p_signing_method: 'type',
      p_consent_text: consent,
      p_user_agent: 'Mozilla/5.0 (Test Runner)',
    });
    assert(!error, 'sign_document succeeds', error?.message);
    assert(result && result.success === true, 'result.success=true');
    assert(result && typeof result.integrity_hash === 'string', 'integrity_hash returned');
    assert(result && /^[0-9a-f]{64}$/.test(result.integrity_hash || ''), 'hash is 64 hex chars (SHA-256)');

    const { data: row } = await svc.from('doc_signatures').select('*').eq('id', sig.id).single();
    assert(row.status === 'signed', 'status updated to signed');
    assert(row.signed_at, 'signed_at stamped');
    assert(row.signer_name === 'Happy Tenant', 'signer_name stored from payload');
    assert(row.signature_data === sigData, 'signature_data stored verbatim');
    assert(row.signing_method === 'type', 'signing_method stored');
    assert(row.consent_text === consent, 'consent_text stored');
    assert(row.user_agent === 'Mozilla/5.0 (Test Runner)', 'user_agent stored');
    assert(row.integrity_hash === result.integrity_hash, 'DB hash matches response hash');

    // Can't re-sign the same signature row
    const { data: resign } = await svc.rpc('sign_document', {
      p_token: sig.access_token,
      p_signer_name: 'Replay Attempt',
      p_signature_data: sigData,
      p_signing_method: 'type',
      p_consent_text: consent,
      p_user_agent: 'Mozilla/5.0 (Test Runner)',
    });
    assert(resign?.error === 'already signed or cancelled', 'second sign attempt rejected');
  } finally {
    await cleanupDoc(doc.id);
  }
}

// ───────────────────────────────────────────────────────────────
// 4. Hash non-determinism (because timestamp is in the input)
// ───────────────────────────────────────────────────────────────
async function testHashChangesPerSign() {
  console.log('\n🧮 integrity hash non-determinism');
  const doc = await createDoc('Hash doc', '<p>same body</p>');
  const sig1 = await createSig(doc.id, 'tenant', 'h1@example.com', 1, 'sent');
  const sig2 = await createSig(doc.id, 'landlord', 'h2@example.com', 2, 'sent');

  try {
    const args = (token) => ({
      p_token: token,
      p_signer_name: 'Same Name',
      p_signature_data: 'typed:Same Name|ts:static',
      p_signing_method: 'type',
      p_consent_text: 'I agree to sign this document electronically.',
      p_user_agent: 'UA',
    });
    const { data: r1 } = await svc.rpc('sign_document', args(sig1.access_token));
    const { data: r2 } = await svc.rpc('sign_document', args(sig2.access_token));
    assert(r1?.integrity_hash && r2?.integrity_hash, 'both sign attempts returned a hash');
    // Different emails + different timestamps → different hashes
    assert(r1.integrity_hash !== r2.integrity_hash, 'hashes differ per signer (email differs)');
  } finally {
    await cleanupDoc(doc.id);
  }
}

// ───────────────────────────────────────────────────────────────
// 5. Sequential envelope advancement
// ───────────────────────────────────────────────────────────────
async function testSequentialAdvancement() {
  console.log('\n🔁 sequential envelope advancement');
  // For sequential mode, create_doc_envelope looks up the template's signing_mode.
  // Since we're bypassing the RPC and seeding directly, we model the sequential
  // state: signer 1 is 'sent', signer 2 is 'pending'. To exercise the branch in
  // sign_document that advances the next signer, we need the doc's template_id
  // to point at a template with signing_mode='sequential'. Create a tiny one.
  const { data: template, error: tErr } = await svc.from('doc_templates').insert([{
    company_id: COMPANY_ID,
    name: 'Test sequential template ' + Date.now(),
    category: 'general',
    body: '<p>test</p>',
    fields: [],
    signing_mode: 'sequential',
    signer_roles: [],
    is_active: true,
  }]).select().single();
  if (tErr) { assert(false, 'create template', tErr.message); return; }

  const { data: doc, error: dErr } = await svc.from('doc_generated').insert([{
    company_id: COMPANY_ID,
    template_id: template.id,
    name: 'Test sequential doc',
    rendered_body: '<p>body</p>',
    field_values: {},
    output_type: 'html',
    status: 'sent',
    envelope_status: 'out_for_signature',
    envelope_sent_at: new Date().toISOString(),
  }]).select().single();
  if (dErr) { assert(false, 'create seq doc', dErr.message); await svc.from('doc_templates').delete().eq('id', template.id); return; }

  const sig1 = await createSig(doc.id, 'tenant',   's1@example.com', 1, 'sent');
  const sig2 = await createSig(doc.id, 'landlord', 's2@example.com', 2, 'pending');

  try {
    // Sign order-1
    const { data: r1 } = await svc.rpc('sign_document', {
      p_token: sig1.access_token,
      p_signer_name: 'Seq 1',
      p_signature_data: 'typed:Seq 1|ts:' + new Date().toISOString(),
      p_signing_method: 'type',
      p_consent_text: 'I agree to sign.',
      p_user_agent: 'UA',
    });
    assert(r1?.success && r1.all_signed === false, 'first signer signs, envelope not yet complete');
    assert(r1.next_signer_email === 's2@example.com', 'next_signer_email returned');

    // Verify sig2 status flipped from 'pending' → 'sent'
    const { data: sig2After } = await svc.from('doc_signatures').select('status').eq('id', sig2.id).single();
    assert(sig2After.status === 'sent', 'second signer flipped from pending → sent');

    // Sign order-2
    const { data: r2 } = await svc.rpc('sign_document', {
      p_token: sig2.access_token,
      p_signer_name: 'Seq 2',
      p_signature_data: 'typed:Seq 2|ts:' + new Date().toISOString(),
      p_signing_method: 'type',
      p_consent_text: 'I agree to sign.',
      p_user_agent: 'UA',
    });
    assert(r2?.success && r2.all_signed === true, 'second signer signs → all_signed=true');

    // Doc envelope flipped to completed
    const { data: docAfter } = await svc.from('doc_generated').select('envelope_status, envelope_completed_at').eq('id', doc.id).single();
    assert(docAfter.envelope_status === 'completed', 'doc envelope_status = completed');
    assert(!!docAfter.envelope_completed_at, 'envelope_completed_at stamped');
  } finally {
    await cleanupDoc(doc.id);
    await svc.from('doc_templates').delete().eq('id', template.id);
  }
}

// ───────────────────────────────────────────────────────────────
// 6. Parallel envelope completion
// ───────────────────────────────────────────────────────────────
async function testParallelCompletion() {
  console.log('\n⚡ parallel envelope completion');
  const doc = await createDoc('Parallel test doc', '<p>body</p>');
  // No template_id → sign_document falls back to 'parallel'. Both signers start 'sent'.
  const sigs = [
    await createSig(doc.id, 'a', 'a@example.com', 1, 'sent'),
    await createSig(doc.id, 'b', 'b@example.com', 2, 'sent'),
  ];

  try {
    // Sign first — envelope should still be open
    const { data: r1 } = await svc.rpc('sign_document', {
      p_token: sigs[0].access_token,
      p_signer_name: 'A',
      p_signature_data: 'typed:A|ts:' + new Date().toISOString(),
      p_signing_method: 'type',
      p_consent_text: 'I agree to sign.',
      p_user_agent: 'UA',
    });
    assert(r1?.all_signed === false, 'first signer → all_signed=false');
    const { data: d1 } = await svc.from('doc_generated').select('envelope_status').eq('id', doc.id).single();
    assert(d1.envelope_status === 'out_for_signature', 'envelope still out_for_signature after 1 of 2');

    // Sign second — envelope completes
    const { data: r2 } = await svc.rpc('sign_document', {
      p_token: sigs[1].access_token,
      p_signer_name: 'B',
      p_signature_data: 'typed:B|ts:' + new Date().toISOString(),
      p_signing_method: 'type',
      p_consent_text: 'I agree to sign.',
      p_user_agent: 'UA',
    });
    assert(r2?.all_signed === true, 'second signer → all_signed=true');
    const { data: d2 } = await svc.from('doc_generated').select('envelope_status, envelope_completed_at').eq('id', doc.id).single();
    assert(d2.envelope_status === 'completed', 'envelope flipped to completed');
    assert(!!d2.envelope_completed_at, 'envelope_completed_at stamped');
  } finally {
    await cleanupDoc(doc.id);
  }
}

// ───────────────────────────────────────────────────────────────
// 7. create_doc_envelope rejects unauthenticated callers
// ───────────────────────────────────────────────────────────────
async function testCreateEnvelopeAuthGate() {
  console.log('\n🛡️  create_doc_envelope auth gate');
  const doc = await createDoc('Auth-gate doc', '<p>body</p>');
  try {
    // Service-role client has no auth.jwt() email context, so the RPC should throw.
    const { data, error } = await svc.rpc('create_doc_envelope', {
      p_doc_id: doc.id,
      p_signers: [{ role: 'tenant', email: 'x@y.com', order: 1 }],
    });
    assert(!!error, 'create_doc_envelope rejects service-role/anon call', data ? 'no error returned' : '');
    assert(error && /not authenticated|not authorized|auth/i.test(error.message || ''), 'error message mentions auth');
    // If anon client is available, also verify it fails (same reason, no email claim).
    if (anon) {
      const { error: aErr } = await anon.rpc('create_doc_envelope', {
        p_doc_id: doc.id,
        p_signers: [{ role: 'tenant', email: 'x@y.com', order: 1 }],
      });
      assert(!!aErr, 'anon client also rejected');
    }
  } finally {
    await cleanupDoc(doc.id);
  }
}

async function run() {
  console.log('═══════════════════════════════════════');
  console.log('🧪 doc_signatures RPC tests');
  console.log('═══════════════════════════════════════');
  const started = Date.now();

  try {
    await testGetByToken();
    await testSignValidation();
    await testSignHappyPath();
    await testHashChangesPerSign();
    await testSequentialAdvancement();
    await testParallelCompletion();
    await testCreateEnvelopeAuthGate();
  } catch (e) {
    console.error('\nFATAL:', e.message);
    fail++;
  }

  const took = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n═══════════════════════════════════════');
  console.log('✅ Passed: ' + pass);
  console.log('❌ Failed: ' + fail);
  if (errors.length > 0) { console.log('\nFailed:'); errors.forEach(e => console.log('  - ' + e)); }
  console.log('\nDuration: ' + took + 's | Pass rate: ' + Math.round(pass / (pass + fail) * 100) + '%');
  process.exit(fail > 0 ? 1 : 0);
}

run();
