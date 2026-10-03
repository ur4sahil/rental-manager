// The certificate of completion, drawn on the server with pdf-lib and
// appended to the signed copy of record. The last signer's browser used
// to make this page with a picture renderer from what IT could see: one
// signer, and the page came out clipped. Here every signer's row is
// read, so the certificate lists them all -- who, which email, when,
// from where, how, which disclosure they consented to, and the hashes
// that tie the signatures to the document text.
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const PAGE = [612, 792];
const MARGIN = 54;
const ink = rgb(0.1, 0.1, 0.12), muted = rgb(0.4, 0.4, 0.45), rule = rgb(0.75, 0.75, 0.78);

const fmt = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
};
const wrap = (font, size, text, width) => {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(next, size) <= width || !cur) cur = next; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
};
// A hash is one unbreakable token: split it into two halves if it is too wide.
const wrapToken = (font, size, text, width) => {
  const s = String(text || "");
  if (font.widthOfTextAtSize(s, size) <= width) return [s];
  const out = []; let cur = "";
  for (const ch of s) { if (font.widthOfTextAtSize(cur + ch, size) > width) { out.push(cur); cur = ch; } else cur += ch; }
  if (cur) out.push(cur);
  return out;
};

/**
 * @param {object} o
 * @param {object} o.doc        the doc_generated row
 * @param {Array}  o.signers    every doc_signatures row (signed ones are listed with their record)
 * @param {string} [o.companyName]
 * @param {string} [o.storedHashNote]  text about the stored copy (the copy's own hash is recorded in the database)
 * @returns {Promise<Uint8Array>}  a PDF of one or more pages
 */
async function certificatePdf({ doc, signers, companyName = "" }) {
  const pdf = await PDFDocument.create();
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const sansBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = PAGE[0] - 2 * MARGIN;
  let page = pdf.addPage(PAGE), y = PAGE[1] - MARGIN;
  const newPage = () => { page = pdf.addPage(PAGE); y = PAGE[1] - MARGIN; };
  const need = (h) => { if (y - h < MARGIN) newPage(); };
  const line = (text, { font = sans, size = 9.5, color = ink, x = MARGIN, gap = 3 } = {}) => {
    for (const l of wrap(font, size, text, width - (x - MARGIN))) { need(size + gap); page.drawText(l, { x, y: y - size, size, font, color }); y -= size + gap; }
  };
  const kv = (k, v, { monoValue = false } = {}) => {
    const size = 9; const kw = 120;
    const vLines = monoValue ? wrapToken(mono, 8, v, width - kw) : wrap(sans, size, v, width - kw);
    need((size + 3) * vLines.length);
    page.drawText(k, { x: MARGIN, y: y - size, size, font: sansBold, color: muted });
    vLines.forEach((l, i) => page.drawText(l, { x: MARGIN + kw, y: y - size - i * (size + 3), size: monoValue ? 8 : size, font: monoValue ? mono : sans, color: ink }));
    y -= (size + 3) * vLines.length;
  };
  const hr = () => { need(10); page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: PAGE[0] - MARGIN, y: y - 4 }, thickness: 0.5, color: rule }); y -= 10; };

  line("Certificate of Completion", { font: serifBold, size: 18, gap: 6 });
  line(String(doc.name || ""), { font: serif, size: 12, gap: 8 });
  kv("Envelope ID", String(doc.id || ""), { monoValue: true });
  if (companyName) kv("Sent by", companyName);
  if (doc.property_address) kv("Property", String(doc.property_address));
  if (doc.envelope_sent_at) kv("Sent", fmt(doc.envelope_sent_at));
  if (doc.envelope_completed_at) kv("Completed", fmt(doc.envelope_completed_at));
  kv("Document hash at send", String(doc.doc_hash_at_send || ""), { monoValue: true });
  line("SHA-256 of the document text as it was sent. Every signer signed this exact version; the signature hashes below are computed over it.", { size: 8, color: muted, gap: 8 });
  hr();
  line("Signers", { font: sansBold, size: 11, gap: 6 });
  // An optional slot nobody was named for (no email, never sent) is not a signer.
  const rows = (signers || []).filter(s => s && (s.status === "signed" || s.signer_email)).slice().sort((a, b) => (a.sign_order || 0) - (b.sign_order || 0) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
  rows.forEach((s, i) => {
    need(60);
    const role = String(s.signer_role || "").replace(/_/g, " ");
    line(`${i + 1}. ${s.signer_name || s.signer_email || role}  —  ${role}`, { font: sansBold, size: 10, gap: 4 });
    kv("Email", String(s.signer_email || ""));
    kv("Status", s.status === "signed" ? "Signed" : String(s.status || ""));
    if (s.status === "signed") {
      kv("Signed at", fmt(s.signed_at));
      kv("Method", s.signing_method === "draw" ? "Drawn signature" : s.signing_method === "type" ? "Typed signature" : String(s.signing_method || ""));
      if (s.initials_data) kv("Initials", (String(s.initials_data).match(/^typed:([^|]+)/) || [])[1] ? `Typed "${(String(s.initials_data).match(/^typed:([^|]+)/) || [])[1]}"` + ((String(s.initials_data).match(/\|pages:(\d+)/) || [])[1] ? ` on every page (${(String(s.initials_data).match(/\|pages:(\d+)/) || [])[1]} pages, each clicked)` : "") : "Drawn, on every page");
      if (s.signer_ip) kv("IP address", String(s.signer_ip));
      if (s.user_agent) kv("Browser", String(s.user_agent).slice(0, 140));
      kv("Consent", (s.e_records_consented ? "Consented to electronic records and signatures" : "No electronic-records consent recorded") + (s.e_records_consent_version ? " (disclosure " + s.e_records_consent_version + ")" : "") + (s.hardware_software_acknowledged ? "; confirmed ability to access electronic documents" : ""));
      if (s.e_records_consent_at) kv("Consent at", fmt(s.e_records_consent_at));
      if (s.integrity_hash) kv("Signature hash", String(s.integrity_hash), { monoValue: true });
      if (s.viewed_at) kv("First opened", fmt(s.viewed_at));
      if (s.paper_copy_requested_at) kv("Paper copy", "Requested " + fmt(s.paper_copy_requested_at));
      if (s.consent_withdrawn_at) kv("Consent withdrawn", fmt(s.consent_withdrawn_at));
    }
    y -= 6;
  });
  hr();
  line("Each signature hash is a SHA-256 digest over the document hash, the signer's email, the signature payload and the time of signing. The signed copy of record is stored with its own SHA-256 hash recorded against this envelope; any change to the file breaks that hash. Each signer's link was private to their email address; the time, IP address and browser of each signature were recorded when it was given.", { size: 8, color: muted, gap: 4 });
  line("Generated by Housify at " + fmt(new Date().toISOString()) + ".", { size: 8, color: muted });
  return pdf.save();
}

/** The first `keep` pages of a PDF, then the certificate: the signed copy of record. */
async function withCertificate(bodyBytes, keep, certBytes) {
  const out = await PDFDocument.create();
  const body = await PDFDocument.load(bodyBytes);
  const n = Number.isFinite(keep) && keep > 0 ? Math.min(keep, body.getPageCount()) : body.getPageCount();
  const pages = await out.copyPages(body, Array.from({ length: n }, (_, i) => i));
  pages.forEach(p => out.addPage(p));
  // certBytes null: the body pages alone (the certificate is its own file).
  if (certBytes) {
    const cert = await PDFDocument.load(certBytes);
    const cpages = await out.copyPages(cert, cert.getPageIndices());
    cpages.forEach(p => out.addPage(p));
  }
  const title = body.getTitle();
  if (title) out.setTitle(title);
  out.setProducer("Housify");
  return out.save();
}

module.exports = { certificatePdf, withCertificate };
