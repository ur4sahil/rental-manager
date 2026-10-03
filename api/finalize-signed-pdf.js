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
const { requireMember } = require("./_member");
const { afterSignedPdfStored, SEND_ROLES } = require("./_doc-email-impl");

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
  // Initials on every page, when the template asked for them: stamped
  // here, where every signer's row can be read, on the body pages only
  // (the certificate follows them). Then hashed, so the hash covers what
  // is stored.
  // Signatures on the document's own signature lines first (the browser
  // that built the PDF sends where the lines are; every signer's row is
  // read here), then the initials, then the hash.
  try {
    const n = Number(body_pages);
    const bodyPages = Number.isFinite(n) && n > 0 ? n : null;
    const { validAnchors, stampSignatures } = require("./_signature-stamp");
    const anchors = validAnchors(sig_anchors, bodyPages || Infinity);
    if (anchors.length) {
      const { data: rows } = await sb.from("doc_signatures").select("signer_role, signature_data, signed_at, status").eq("doc_id", doc_id).eq("status", "signed");
      if (rows && rows.length) pdfBytes = Buffer.from(await stampSignatures(require("pdf-lib"), pdfBytes, rows, anchors));
    }
    // Initials boxes: one per signer in the document's own order (the
    // roster), filled where the signer gave initials; older documents
    // (no signature block) get a box per signer with initials, by order.
    const { initialsRoster } = require("./_signature-stamp");
    const roster = initialsRoster(doc.rendered_body);
    const { data: inis } = await sb.from("doc_signatures").select("initials_data, signer_role, signer_name, sign_order").eq("doc_id", doc_id).eq("status", "signed").order("sign_order");
    if ((inis || []).some(r => r.initials_data)) {
      const PDFLib = require("pdf-lib");
      const { stampInitials } = require("./_initials-stamp");
      pdfBytes = Buffer.from(await stampInitials(PDFLib, pdfBytes, inis, { pages: bodyPages, roster: roster.length ? roster : null }));
    }
  } catch (e) { console.error("[finalize] signature/initials stamp skipped:", e.message); }
  const pdfHash = crypto.createHash("sha256").update(pdfBytes).digest("hex");

  // 3. Upload to Storage. Path includes timestamp so accidental
  //    re-uploads create a new versioned object instead of
  //    overwriting (Storage upsert=false enforces this anyway).
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${doc.company_id}/${doc_id}/signed-${ts}.pdf`;
  const { error: upErr } = await sb.storage.from("signed-documents")
    .upload(path, pdfBytes, { contentType: "application/pdf", upsert: false });
  if (upErr) {
    console.error("[finalize-signed-pdf] upload failed:", upErr.message);
    res.status(500).json({ error: "upload failed" }); return;
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
    console.error("[finalize-signed-pdf] set_signed_pdf failed:", setErr.message);
    res.status(500).json({ error: "recording the signed copy failed" }); return;
  }

  // 5. Mint a 24h signed URL so the just-signed signer can
  //    download their copy immediately without waiting for the
  //    email-delivery worker. The bucket is private — only this
  //    service-role-signed URL can read the object.
  let downloadUrl = null;
  try {
    const { data: signed } = await sb.storage.from("signed-documents")
      .createSignedUrl(path, 24 * 60 * 60); // 24 hours
    // This link is EMAILED to whoever signed, so the hostname is the one
    // place it is read by someone who has never seen our app. Route it
    // through our own domain via the /docs rewrite in vercel.json rather
    // than sending a tenant a link to <project-ref>.supabase.co. Same
    // signature, same expiry -- only the host changes.
    const MARK = "/storage/v1/object/sign/";
    const raw = signed?.signedUrl || null;
    const base = (process.env.APP_URL || "").replace(/\/$/, "");
    // The /docs rewrite points at the PRODUCTION storage project, so it is
    // only right in production; elsewhere hand back the direct link.
    downloadUrl = raw && base && raw.includes(MARK) && (process.env.VERCEL_ENV || "") === "production"
      ? base + "/docs/" + raw.slice(raw.indexOf(MARK) + MARK.length)
      : raw;
  } catch (_e) {
    // Non-fatal — the row is in queue, worker can re-sign later.
  }

  // 6. File it under Documents, email each signer their copy, tell the
  //    sender. Best effort: the signed copy is already safely stored.
  let after = { copies: [] };
  if (!setRes?.already_set) {
    try { after = await afterSignedPdfStored(sb, req, doc, pdfBytes); }
    catch (e) { console.error("[finalize-signed-pdf] follow-up failed:", e.message); }
  }

  res.status(200).json({
    signed_pdf_path: path,
    signed_pdf_hash: pdfHash,
    bytes: pdfBytes.length,
    download_url: downloadUrl,
    signers_queued: (after.copies || []).filter(c => c.status === "sent").length,
    filed_document_id: after.filed_document_id || null,
    already_set: !!setRes?.already_set,
  });
};
