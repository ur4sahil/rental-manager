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

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SVC) {
    res.status(500).json({ error: "Supabase env not configured" });
    return;
  }

  // Parse body — Vercel's default body parser handles JSON.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const { token, doc_id, pdf_base64 } = body || {};
  if (!token || typeof token !== "string" || token.length < 20) {
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

  // 1. Verify the token belongs to a signer of THIS doc, the token
  //    hasn't expired, and the envelope is in 'completed' state.
  //    Status 'signed' on the signature row + 'completed' on the
  //    envelope means signing already happened — this is the brief
  //    window during which the client can upload the rendered PDF.
  const { data: sig, error: sigErr } = await sb.from("doc_signatures")
    .select("id, doc_id, status, token_expires_at")
    .eq("access_token", token).maybeSingle();
  if (sigErr || !sig) { res.status(401).json({ error: "invalid token" }); return; }
  if (sig.doc_id !== doc_id) { res.status(403).json({ error: "token does not match doc_id" }); return; }
  if (sig.status !== "signed") { res.status(403).json({ error: "signer has not yet signed" }); return; }
  if (sig.token_expires_at && new Date(sig.token_expires_at) < new Date()) {
    res.status(403).json({ error: "token expired" }); return;
  }

  const { data: doc } = await sb.from("doc_generated")
    .select("id, company_id, name, envelope_status, signed_pdf_path")
    .eq("id", doc_id).maybeSingle();
  if (!doc) { res.status(404).json({ error: "doc not found" }); return; }
  if (doc.envelope_status !== "completed") {
    res.status(403).json({ error: "envelope not completed" }); return;
  }
  // Idempotent — if the PDF was already uploaded, return the existing path.
  if (doc.signed_pdf_path) {
    res.status(200).json({
      signed_pdf_path: doc.signed_pdf_path,
      already_set: true,
    });
    return;
  }

  // 2. Decode + hash the PDF bytes.
  let pdfBytes;
  try { pdfBytes = Buffer.from(pdf_base64, "base64"); }
  catch (_e) { res.status(400).json({ error: "invalid base64" }); return; }
  if (pdfBytes.length < 200 || pdfBytes.slice(0, 4).toString() !== "%PDF") {
    // Sanity check: PDFs always start with "%PDF-1.x".
    res.status(400).json({ error: "not a PDF" }); return;
  }
  const pdfHash = crypto.createHash("sha256").update(pdfBytes).digest("hex");

  // 3. Upload to Storage. Path includes timestamp so accidental
  //    re-uploads create a new versioned object instead of
  //    overwriting (Storage upsert=false enforces this anyway).
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${doc.company_id}/${doc_id}/signed-${ts}.pdf`;
  const { error: upErr } = await sb.storage.from("signed-documents")
    .upload(path, pdfBytes, { contentType: "application/pdf", upsert: false });
  if (upErr) {
    res.status(500).json({ error: "upload failed: " + upErr.message }); return;
  }

  // 4. Persist path + hash via service-role-only RPC (idempotent).
  //    The RPC also fans out a notification_queue row per signer
  //    (type='signed_doc_copy') so the email-delivery worker can
  //    pick them up later. See migration 20260424000012.
  const { data: setRes, error: setErr } = await sb.rpc("set_signed_pdf", {
    p_doc_id: doc_id,
    p_pdf_path: path,
    p_pdf_hash: pdfHash,
  });
  if (setErr) {
    sb.storage.from("signed-documents").remove([path]).catch(() => {});
    res.status(500).json({ error: "set_signed_pdf failed: " + setErr.message }); return;
  }

  // 5. Mint a 24h signed URL so the just-signed signer can
  //    download their copy immediately without waiting for the
  //    email-delivery worker. The bucket is private — only this
  //    service-role-signed URL can read the object.
  let downloadUrl = null;
  try {
    const { data: signed } = await sb.storage.from("signed-documents")
      .createSignedUrl(path, 24 * 60 * 60); // 24 hours
    downloadUrl = signed?.signedUrl || null;
  } catch (_e) {
    // Non-fatal — the row is in queue, worker can re-sign later.
  }

  res.status(200).json({
    signed_pdf_path: path,
    signed_pdf_hash: pdfHash,
    bytes: pdfBytes.length,
    download_url: downloadUrl,
    signers_queued: setRes?.signers_queued ?? 0,
    already_set: !!setRes?.already_set,
  });
};
