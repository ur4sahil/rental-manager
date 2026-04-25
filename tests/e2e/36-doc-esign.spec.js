// ═══════════════════════════════════════════════════════════════
// 36 — DOC E-SIGN: public /sign/:token page + DB state transitions
// ═══════════════════════════════════════════════════════════════
// Covers the anon-callable signing flow end-to-end at the browser
// layer. The admin-send UI is covered at the RPC layer in
// tests/doc-signatures.test.js (46 assertions); this spec exercises
// the /sign/:token page in a fresh context (no auth) exactly the way
// a real external signer would hit it.
//
// Per test we seed a fresh doc_generated + doc_signatures using the
// Supabase service-role client (bypasses RLS cleanly for test data)
// and clean up in afterEach, so runs are idempotent and don't depend
// on the seed dataset.

const { test, expect } = require('@playwright/test');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config();

const SERVICE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const COMPANY_ID  = 'sandbox-llc';

const svc = (SERVICE_URL && SERVICE_KEY) ? createClient(SERVICE_URL, SERVICE_KEY) : null;

function mkToken(prefix) {
  const rand = crypto.randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return prefix + '-' + rand;
}

async function seedEnvelope({ signed = false, expired = false, signers = ['tenant'] } = {}) {
  const body = '<h1>Test Lease Agreement</h1><p>This is the rendered body used for the signing page test. <strong>Rent:</strong> $1500/mo.</p>';
  const { data: doc, error: docErr } = await svc.from('doc_generated').insert([{
    company_id: COMPANY_ID,
    template_id: null,
    name: 'E-Sign Test Doc ' + Date.now(),
    rendered_body: body,
    field_values: {},
    output_type: 'lease',
    status: 'sent',
    envelope_status: signed ? 'completed' : 'out_for_signature',
    envelope_sent_at: new Date().toISOString(),
    envelope_completed_at: signed ? new Date().toISOString() : null,
  }]).select().single();
  if (docErr) throw new Error('seed doc failed: ' + docErr.message);

  const rows = signers.map((role, idx) => {
    const expiresAt = expired
      ? new Date(Date.now() - 3600 * 1000).toISOString()
      : new Date(Date.now() + 30 * 86400000).toISOString();
    return {
      company_id: COMPANY_ID,
      doc_id: doc.id,
      signer_role: role,
      signer_name: role.charAt(0).toUpperCase() + role.slice(1) + ' E2E',
      signer_email: role + '.e2e@example.com',
      sign_order: idx + 1,
      status: signed ? 'signed' : 'sent',
      access_token: mkToken(role),
      token_expires_at: expiresAt,
      sent_at: new Date().toISOString(),
      signed_at: signed ? new Date().toISOString() : null,
      signature_data: signed ? 'typed:Pre Signed|ts:' + new Date().toISOString() : null,
      signing_method: signed ? 'type' : null,
      consent_text: signed ? 'I agreed.' : null,
      integrity_hash: signed ? 'a'.repeat(64) : null,
    };
  });
  const { data: sigs, error: sErr } = await svc.from('doc_signatures').insert(rows).select();
  if (sErr) throw new Error('seed sigs failed: ' + sErr.message);
  return { doc, sigs };
}

async function cleanupDoc(docId) {
  if (!docId) return;
  // Cascade deletes the doc_signatures rows via FK.
  await svc.from('doc_generated').delete().eq('id', docId);
}

test.describe('Public e-sign page (/sign/:token)', () => {
  test.beforeAll(() => {
    if (!svc) test.skip(true, 'SUPABASE_URL/SUPABASE_SERVICE_KEY missing in tests/.env');
  });

  test('invalid token shows friendly error', async ({ page }) => {
    await page.goto('/sign/this-token-does-not-exist-but-is-long-enough');
    await expect(page.locator('text=Can\'t sign right now')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=/not valid|token not found/i')).toBeVisible();
  });

  test('short/malformed token shows friendly error', async ({ page }) => {
    await page.goto('/sign/abc');
    await expect(page.locator('text=Can\'t sign right now')).toBeVisible({ timeout: 10000 });
  });

  test('expired token is rejected', async ({ page }) => {
    const { doc, sigs } = await seedEnvelope({ expired: true });
    try {
      await page.goto('/sign/' + sigs[0].access_token);
      await expect(page.locator('text=/expired/i')).toBeVisible({ timeout: 10000 });
    } finally {
      await cleanupDoc(doc.id);
    }
  });

  test('valid token: shows doc, signs with typed name, completes', async ({ page }) => {
    const { doc, sigs } = await seedEnvelope({ signers: ['tenant'] });
    const token = sigs[0].access_token;

    try {
      await page.goto('/sign/' + token);

      // Doc header + body rendered
      await expect(page.locator('text=E-Sign Test Doc')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('text=Test Lease Agreement')).toBeVisible();
      await expect(page.locator('text=Rent:')).toBeVisible();

      // Signer identity surfaced (the page prefers signer_name when set,
      // falls back to email when not)
      await expect(page.locator('text=Tenant E2E').first()).toBeVisible();

      // DB: viewing the page should flip sent → viewed
      // (small delay to ensure the get_signature_by_token RPC round-trip has landed)
      await page.waitForTimeout(500);
      const { data: afterView } = await svc.from('doc_signatures').select('status, viewed_at').eq('id', sigs[0].id).single();
      expect(afterView.status).toBe('viewed');
      expect(afterView.viewed_at).not.toBeNull();

      // Pick "Type Name" mode — easier than drawing on a canvas in headless
      await page.locator('button:has-text("Type Name")').click();
      await page.locator('input[placeholder*="legal name"]').fill('Tenant E2E Signer');

      // Three separate consent checkboxes per ESIGN §101(c) (commit 69f3ffa):
      //   1. Consent to electronic records
      //   2. Hardware/software acknowledgment
      //   3. Signature legal-effect agreement
      // The Sign button stays disabled until all three are checked.
      const boxes = page.locator('input[type="checkbox"]');
      const boxCount = await boxes.count();
      for (let i = 0; i < boxCount; i++) await boxes.nth(i).check();
      await page.locator('button:has-text("Sign")').last().click();

      // Success screen — wording shifted from "Audit hash" to
      // "Signature hash" + "Document hash at send" in commit 69f3ffa.
      await expect(page.locator('text=/signature recorded|thanks/i')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('text=/Signature hash|Audit hash|Document hash/i')).toBeVisible();

      // DB: signed row populated, envelope flipped to completed
      const { data: afterSign } = await svc.from('doc_signatures').select('*').eq('id', sigs[0].id).single();
      expect(afterSign.status).toBe('signed');
      expect(afterSign.signed_at).not.toBeNull();
      expect(afterSign.signature_data).toContain('typed:');
      expect(afterSign.signer_name).toBe('Tenant E2E Signer');
      expect(afterSign.integrity_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(afterSign.consent_text).toMatch(/electronic signature|agree|sign/i);

      const { data: docAfter } = await svc.from('doc_generated').select('envelope_status, envelope_completed_at').eq('id', doc.id).single();
      expect(docAfter.envelope_status).toBe('completed');
      expect(docAfter.envelope_completed_at).not.toBeNull();
    } finally {
      await cleanupDoc(doc.id);
    }
  });

  test('already-signed token returns helpful message', async ({ page }) => {
    const { doc, sigs } = await seedEnvelope({ signed: true });
    try {
      await page.goto('/sign/' + sigs[0].access_token);
      await expect(page.locator('text=/already signed|no longer available/i')).toBeVisible({ timeout: 10000 });
    } finally {
      await cleanupDoc(doc.id);
    }
  });

  test('consent checkbox is required to enable the Sign button', async ({ page }) => {
    const { doc, sigs } = await seedEnvelope({ signers: ['tenant'] });
    try {
      await page.goto('/sign/' + sigs[0].access_token);
      await expect(page.locator('text=Test Lease Agreement')).toBeVisible({ timeout: 10000 });

      await page.locator('button:has-text("Type Name")').click();
      await page.locator('input[placeholder*="legal name"]').fill('Nope Nope');

      // Sign button should be disabled until consent is checked
      const signBtn = page.locator('button:has-text("Agree to the terms"), button:has-text("Sign & Submit")').last();
      await expect(signBtn).toBeDisabled();

      await page.locator('input[type="checkbox"]').check();
      await expect(page.locator('button:has-text("Sign & Submit")')).toBeEnabled();
    } finally {
      await cleanupDoc(doc.id);
    }
  });
});
