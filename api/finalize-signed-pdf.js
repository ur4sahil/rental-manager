// Vercel API Route: finalize a signed envelope by uploading the
// rendered PDF to Storage and recording its SHA-256 + path on
// doc_generated.
//
// Auth model is unusual here because the typical caller is a SIGNER
// who has just completed signing — they don't have a Supabase session.
// We authorize by the signing token (a 32-byte URL-safe random
// string handed out by create_doc_envelope), which is the same
// secret that authorized the sign_document RPC. The token is still
// valid (within its 30-day window) and the envelope must already be
// in 'completed' state — i.e. someone with this token successfully
// signed it through the public RPC. Service-role key never leaves
// the server.
//
// Contract:
//   POST /api/finalize-signed-pdf
//   Body: { token, doc_id, pdf_base64 }
//   Response: 200 { signed_pdf_path, signed_pdf_hash } | 4xx { error }

const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { requireMember } = require("./_member");
const { SEND_ROLES } = require("./_doc-email-impl");
const { finalizeFromBytes, finalizeFromStoredBody, storeEnvelopeBody, looksLikePdf } = require("./_finalize-impl");

module.exports = async (req, res) => {
  // ?action=sign: the signing itself (api/_sign-document-impl.js), on this
  // route because api/ is at Vercel's 12-function cap.
  if (req.query && req.query.action === "sign") return require("./_sign-document-impl")(req, res);
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
  // ?action=body: the office browser stores the document's pages when the
  // envelope is sent (api/_finalize-impl.js). ?action=server: staff ask
  // the server to finish a completed envelope from that stored body.
  if (req.query && (req.query.action === "body" || req.query.action === "server")) return staffAction(req, res, req.query.action);

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SVC) {
    res.status(500).json({ error: "Supabase env not configured" });
    return;
  }

  // Parse body — Vercel's default body parser handles JSON.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const { token, doc_id, pdf_base64, company_id, body_pages, sig_anchors } = body || {};
  // Two callers. The signer who completed the envelope (their signing
  // token), and -- when that signer closed the tab before the upload
  // finished, which used to leave the envelope "completed" with no signed
  // copy forever -- a staff member storing it from Document Builder.
  const staffCall = !token && !!company_id;
  if (!staffCall && (!token || typeof token !== "string" || token.length < 20)) {
    res.status(400).json({ error: "token required" }); return;
  }
  if (!doc_id || typeof doc_id !== "string") {
    res.status(400).json({ error: "doc_id required" }); return;
  }
  if (!pdf_base64 || typeof pdf_base64 !== "string" || pdf_base64.length < 100) {
    res.status(400).json({ error: "pdf_base64 required" }); return;
  }

  // Cap upload size at ~25 MB to keep Vercel function memory bounded.
  // Base64 is ~4/3 the size of binary, so 33MB base64 ≈ 25MB binary.
  if (pdf_base64.length > 33 * 1024 * 1024) {
    res.status(413).json({ error: "PDF too large" }); return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });

  const { data: doc } = await sb.from("doc_generated")
    .select("*").eq("id", doc_id).maybeSingle();
  if (!doc) { res.status(404).json({ error: "doc not found" }); return; }
  if (doc.envelope_status !== "completed") {
    res.status(403).json({ error: "envelope not completed" }); return;
  }

  if (staffCall) {
    const auth = await requireMember(req, { companyId: company_id, roles: SEND_ROLES, sb });
    if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
    if (doc.company_id !== String(company_id)) { res.status(404).json({ error: "doc not found" }); return; }
  } else {
    // 1. The token must belong to a signer of THIS doc who has signed.
    const { data: sig, error: sigErr } = await sb.from("doc_signatures")
      .select("id, doc_id, status, token_expires_at")
      .eq("access_token", token).maybeSingle();
    if (sigErr || !sig) { res.status(401).json({ error: "invalid token" }); return; }
    if (sig.doc_id !== doc_id) { res.status(403).json({ error: "token does not match doc_id" }); return; }
    if (sig.status !== "signed") { res.status(403).json({ error: "signer has not yet signed" }); return; }
    if (sig.token_expires_at && new Date(sig.token_expires_at) < new Date()) {
      res.status(403).json({ error: "token expired" }); return;
    }
    // Only the signature that COMPLETED the envelope may upload, and only in
    // the minutes right after it. Any signer's token used to work for the
    // token's whole 30-day life, so a signer could come back later and file
    // a different PDF as the copy of record (2026-09-30 audit). The bytes are
    // still client-rendered; the DB's integrity_hash / doc_hash_at_send remain
    // the forensic truth for the document text.
    const { data: sigs } = await sb.from("doc_signatures")
      .select("id, signed_at, status").eq("doc_id", doc_id);
    const signedRows = (sigs || []).filter(s => s.status === "signed" && s.signed_at);
    const last = signedRows.sort((a, b) => new Date(b.signed_at) - new Date(a.signed_at))[0];
    if (!last || last.id !== sig.id) {
      res.status(403).json({ error: "only the signer who completed the envelope can upload the signed copy" }); return;
    }
    const FINALIZE_WINDOW_MS = 30 * 60 * 1000;
    if (Date.now() - new Date(last.signed_at).getTime() > FINALIZE_WINDOW_MS) {
      res.status(403).json({ error: "the upload window after signing has closed" }); return;
    }
  }
  // Decode the browser-made PDF and finish the envelope from it.
  let pdfBytes;
  try { pdfBytes = Buffer.from(pdf_base64, "base64"); }
  catch (_e) { res.status(400).json({ error: "invalid base64" }); return; }
  if (!looksLikePdf(pdfBytes)) { res.status(400).json({ error: "not a PDF" }); return; }
  try {
    const out = await finalizeFromBytes(sb, req, doc, { pdfBytes, bodyPages: body_pages, anchors: sig_anchors });
    res.status(200).json(out);
  } catch (e) {
    console.error("[finalize-signed-pdf] failed:", e.message);
    res.status(e.status || 500).json({ error: e.status === 400 ? e.message : (String(e.message).startsWith("upload failed") ? "upload failed" : "recording the signed copy failed") });
  }
};

// Staff calls (a member with a send role, by their session):
//   ?action=body   { company_id, doc_id, pdf_base64, body_pages, sig_anchors }
//                  → 200 { stored: true, pages, hash }
//   ?action=server { company_id, doc_id }
//                  → 200 finalize result | 404 { error: "no stored body" }
async function staffAction(req, res, action) {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SVC) { res.status(500).json({ error: "Supabase env not configured" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const { company_id, doc_id, pdf_base64, body_pages, sig_anchors } = body || {};
  if (!company_id || !doc_id || typeof doc_id !== "string") { res.status(400).json({ error: "company_id and doc_id required" }); return; }
  const sb = createClient(SUPABASE_URL, SUPABASE_SVC, { auth: { persistSession: false } });
  const auth = await requireMember(req, { companyId: company_id, roles: SEND_ROLES, sb });
  if (auth.error) { res.status(auth.status).json({ error: auth.error }); return; }
  const { data: doc } = await sb.from("doc_generated").select("*").eq("id", doc_id).maybeSingle();
  if (!doc || doc.company_id !== String(company_id)) { res.status(404).json({ error: "doc not found" }); return; }
  try {
    if (action === "body") {
      if (!pdf_base64 || typeof pdf_base64 !== "string" || pdf_base64.length < 100) { res.status(400).json({ error: "pdf_base64 required" }); return; }
      if (pdf_base64.length > 33 * 1024 * 1024) { res.status(413).json({ error: "PDF too large" }); return; }
      // A finished or cancelled envelope keeps the pages it was signed on.
      if (doc.envelope_status === "completed" || doc.envelope_status === "voided") { res.status(409).json({ error: "envelope already " + doc.envelope_status }); return; }
      const meta = await storeEnvelopeBody(sb, doc, { pdfBytes: Buffer.from(pdf_base64, "base64"), bodyPages: body_pages, anchors: sig_anchors });
      res.status(200).json({ stored: true, pages: meta.pages, hash: meta.hash, anchors: meta.anchors.length });
      return;
    }
    if (doc.envelope_status !== "completed") { res.status(403).json({ error: "envelope not completed" }); return; }
    const out = await finalizeFromStoredBody(sb, req, doc);
    if (!out) { res.status(404).json({ error: "no stored body" }); return; }
    res.status(200).json(out);
  } catch (e) {
    console.error("[finalize-signed-pdf] staff " + action + " failed:", e.message);
    res.status(e.status || 500).json({ error: String(e.message).slice(0, 200) });
  }
}
