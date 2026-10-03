// The last step of an envelope, on the server: stamp every signature,
// the initials, the envelope ID and the certificate of completion onto
// the document's PDF, store it, record its hash, file it under Documents
// and email each signer their copy.
//
// Until 2026-10-03 this only ran when the LAST SIGNER's browser rendered
// the PDF and uploaded it after clicking Finish. The done screen said
// "you can safely close this window" while that upload was still going;
// a closed tab left the envelope "completed" with no signed copy and no
// emails, for good. Now the office browser renders the document's pages
// once, when the envelope is SENT (envelope-body.pdf, with the
// signature-line positions in envelope-body.json), and the signing call
// itself finishes the envelope from that copy. The signer's browser has
// nothing left to do after Finish.
//
// Files, in the private signed-documents bucket (PDFs only, by the
// bucket's own rule -- so the signature-line positions travel INSIDE the
// body PDF, in its Subject field, instead of in a sidecar file):
//   {company}/{doc}/envelope-body.pdf   the unsigned pages, as the signers saw them
//   {company}/{doc}/signed-<ts>.pdf     the copy of record (set_signed_pdf)
const crypto = require("crypto");
const { afterSignedPdfStored } = require("./_doc-email-impl");

const BUCKET = "signed-documents";
const bodyPdfPath = (doc) => `${doc.company_id}/${doc.id}/envelope-body.pdf`;
const SUBJECT_MARK = "housify-envelope-body:";

/** Is this a PDF? (Every PDF starts with "%PDF-1.x".) */
function looksLikePdf(bytes) {
  return bytes && bytes.length >= 200 && bytes.slice(0, 4).toString() === "%PDF";
}

/**
 * Store the unsigned body the office browser rendered at send time, with
 * where the signature lines are. Overwrites: a document re-sent after an
 * edit must sign the new pages.
 */
async function storeEnvelopeBody(sb, doc, { pdfBytes, bodyPages, anchors }) {
  if (!looksLikePdf(pdfBytes)) throw new Error("not a PDF");
  const { PDFDocument } = require("pdf-lib");
  const pdf = await PDFDocument.load(pdfBytes);
  const pages = pdf.getPageCount();
  const n = Number(bodyPages);
  if (Number.isFinite(n) && n > 0 && n !== pages) throw new Error(`body_pages ${n} but the PDF has ${pages} pages`);
  const { validAnchors } = require("./_signature-stamp");
  const meta = { v: 1, pages, anchors: validAnchors(anchors, pages), created_at: new Date().toISOString() };
  pdf.setSubject(SUBJECT_MARK + JSON.stringify(meta));
  const bytes = Buffer.from(await pdf.save());
  const up = await sb.storage.from(BUCKET).upload(bodyPdfPath(doc), bytes, { contentType: "application/pdf", upsert: true });
  if (up.error) throw new Error(up.error.message);
  return { ...meta, hash: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/** The stored body with its signature-line positions, or null when the envelope predates it. */
async function loadEnvelopeBody(sb, doc) {
  const dl = await sb.storage.from(BUCKET).download(bodyPdfPath(doc));
  if (dl.error || !dl.data) return null;
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  if (!looksLikePdf(bytes)) return null;
  try {
    const { PDFDocument } = require("pdf-lib");
    const pdf = await PDFDocument.load(bytes);
    const subject = String(pdf.getSubject() || "");
    if (!subject.startsWith(SUBJECT_MARK)) return null;
    const meta = JSON.parse(subject.slice(SUBJECT_MARK.length));
    return { pdfBytes: bytes, bodyPages: pdf.getPageCount(), anchors: Array.isArray(meta.anchors) ? meta.anchors : [] };
  } catch (e) { console.error("[finalize] stored body unreadable:", e.message); return null; }
}

/**
 * Stamp, store, record, file and email. `doc` is the doc_generated row
 * (envelope_status must be 'completed'). Idempotent: a document with a
 * signed copy already is returned as-is.
 * Returns { signed_pdf_path, signed_pdf_hash, bytes, download_url,
 *           signers_queued, filed_document_id, already_set }.
 */
async function finalizeFromBytes(sb, req, doc, { pdfBytes, bodyPages, anchors }) {
  if (doc.signed_pdf_path) return { signed_pdf_path: doc.signed_pdf_path, already_set: true };
  if (!looksLikePdf(pdfBytes)) throw Object.assign(new Error("not a PDF"), { status: 400 });
  const n = Number(bodyPages);
  const pages = Number.isFinite(n) && n > 0 ? n : null;
  const PDFLib = require("pdf-lib");
  // Signatures on the document's own signature lines, the envelope ID in
  // the top margin of every body page, every signer's initials at the
  // foot of each page, then the certificate of completion after the body.
  try {
    const { validAnchors, stampSignatures, stampEnvelopeId, initialsRoster } = require("./_signature-stamp");
    const good = validAnchors(anchors, pages || Infinity);
    if (good.length) {
      const { data: rows } = await sb.from("doc_signatures").select("signer_role, signature_data, signed_at, status, integrity_hash").eq("doc_id", doc.id).eq("status", "signed");
      if (rows && rows.length) pdfBytes = Buffer.from(await stampSignatures(PDFLib, pdfBytes, rows, good, { envelopeId: doc.id }));
    }
    pdfBytes = Buffer.from(await stampEnvelopeId(PDFLib, pdfBytes, doc.id, { pages }));
    const roster = initialsRoster(doc.rendered_body);
    const { data: inis } = await sb.from("doc_signatures").select("initials_data, signer_role, signer_name, sign_order").eq("doc_id", doc.id).eq("status", "signed").order("sign_order");
    if ((inis || []).some(r => r.initials_data)) {
      const { stampInitials } = require("./_initials-stamp");
      pdfBytes = Buffer.from(await stampInitials(PDFLib, pdfBytes, inis, { pages, roster: roster.length ? roster : null }));
    }
    if (pages) {
      const { certificatePdf, withCertificate } = require("./_certificate");
      const { data: all } = await sb.from("doc_signatures")
        .select("signer_role, signer_name, signer_email, sign_order, status, signed_at, signing_method, signer_ip, user_agent, integrity_hash, e_records_consented, e_records_consent_at, e_records_consent_version, hardware_software_acknowledged, viewed_at, paper_copy_requested_at, consent_withdrawn_at, initials_data, created_at")
        .eq("doc_id", doc.id);
      const { data: co } = await sb.from("companies").select("name").eq("id", doc.company_id).maybeSingle();
      const cert = await certificatePdf({ doc, signers: all || [], companyName: co?.name || "" });
      pdfBytes = Buffer.from(await withCertificate(pdfBytes, pages, cert));
    }
  } catch (e) { console.error("[finalize] signature/initials stamp skipped:", e.message); }
  const pdfHash = crypto.createHash("sha256").update(pdfBytes).digest("hex");

  // Store. The path carries a timestamp so a repeat never overwrites.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${doc.company_id}/${doc.id}/signed-${ts}.pdf`;
  const { error: upErr } = await sb.storage.from(BUCKET).upload(path, pdfBytes, { contentType: "application/pdf", upsert: false });
  if (upErr) throw Object.assign(new Error("upload failed: " + upErr.message), { status: 500 });

  // Record path + hash (service-role RPC; also queues a notification per
  // signer, migration 20260424000012).
  const { data: setRes, error: setErr } = await sb.rpc("set_signed_pdf", { p_doc_id: doc.id, p_pdf_path: path, p_pdf_hash: pdfHash });
  if (setErr) {
    sb.storage.from(BUCKET).remove([path]).catch(() => {});
    throw Object.assign(new Error("recording the signed copy failed: " + setErr.message), { status: 500 });
  }

  // A 24h link for the signer on screen. Emailed links go through our own
  // domain (the /docs rewrite) in production only.
  let downloadUrl = null;
  try {
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(path, 24 * 60 * 60);
    const MARK = "/storage/v1/object/sign/";
    const raw = signed?.signedUrl || null;
    const base = (process.env.APP_URL || "").replace(/\/$/, "");
    downloadUrl = raw && base && raw.includes(MARK) && (process.env.VERCEL_ENV || "") === "production"
      ? base + "/docs/" + raw.slice(raw.indexOf(MARK) + MARK.length)
      : raw;
  } catch (_e) { /* the row is recorded; the email worker can sign a link later */ }

  // File it under Documents, email each signer, tell the sender.
  let after = { copies: [] };
  if (!setRes?.already_set) {
    try { after = await afterSignedPdfStored(sb, req, doc, pdfBytes); }
    catch (e) { console.error("[finalize] follow-up failed:", e.message); }
  }
  return {
    signed_pdf_path: path,
    signed_pdf_hash: pdfHash,
    bytes: pdfBytes.length,
    download_url: downloadUrl,
    signers_queued: (after.copies || []).filter(c => c.status === "sent").length,
    filed_document_id: after.filed_document_id || null,
    already_set: !!setRes?.already_set,
  };
}

/**
 * Finish a completed envelope from the body stored at send time. Returns
 * the finalize result, or null when there is no stored body (an envelope
 * sent before 2026-10-03): the caller then falls back to a browser-made
 * PDF.
 */
async function finalizeFromStoredBody(sb, req, doc) {
  if (doc.signed_pdf_path) return { signed_pdf_path: doc.signed_pdf_path, already_set: true };
  const body = await loadEnvelopeBody(sb, doc);
  if (!body) return null;
  return finalizeFromBytes(sb, req, doc, body);
}

module.exports = { storeEnvelopeBody, loadEnvelopeBody, finalizeFromBytes, finalizeFromStoredBody, looksLikePdf, BUCKET, bodyPdfPath };
