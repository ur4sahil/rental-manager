// Server copy of src/utils/signatureStamp.js (CommonJS). Keep the two together.
// Signatures drawn onto the signature lines of a signed PDF. The lines
// are the signature slots of the document's signature block
// (signatureBlock.js); pagedPdf reports where each one landed as an
// anchor, and this draws each signer's signature on their own line and
// the date they signed on their date line. api/_signature-stamp.js is
// the same code for the server, which stamps the copy it stores (it can
// read every signer's row; the last signer's browser can only see its
// own). Keep the two together.
const PX_TO_PT = 0.75;
const MAX_SIG_HEIGHT_PT = 30;   // a drawn signature's height on the page
const TYPED_SIZE_PT = 18;
const DATE_SIZE_PT = 10;

/** "typed:Jane Doe|ts:..." -> "Jane Doe"; a PNG data URL -> null (drawn). */
function signatureText(data) {
  const s = String(data || "");
  if (!s.startsWith("typed:")) return null;
  return s.slice(6).split("|")[0].trim().slice(0, 80);
}

/** The date a signature was given, as it is printed: MM/DD/YYYY. */
function signedDateText(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0") + "/" + d.getFullYear();
}

/** A signer role's printed label: tenant -> Tenant, tenant_2 -> Co-tenant 2, witness_x -> Witness, landlord -> Landlord. */
function roleLabel(role) {
  const r = String(role || "").toLowerCase();
  if (!r) return "";
  if (r.startsWith("witness_")) return "Witness (" + roleLabel(r.slice(8)) + ")";
  if (/^tenant(_1)?$/.test(r)) return "Tenant";
  const m = r.match(/^tenant_(\d+)$/);
  if (m) return "Co-tenant " + m[1];
  if (/landlord/.test(r)) return "Landlord";
  return r.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * The initials roster: every signer with a signature line in the document,
 * in document order, [{ role, label }]. The initials boxes at the foot of
 * each page follow this order -- on the signing screen, on the unsigned
 * copy and on the signed copy alike. Empty for a document without a
 * signature block (older documents, stamped by sign_order instead).
 */
function initialsRoster(html) {
  const out = [], seen = new Set();
  const re = /data-sig-role="([^"]*)"/g;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const role = m[1].replace(/&quot;/g, "\"");
    if (!role || seen.has(role)) continue;
    seen.add(role);
    out.push({ role, label: roleLabel(role) });
  }
  return out;
}

/** Anchors a document carries that are safe to draw: numbers finite, on a page. */
function validAnchors(anchors, pageCount = Infinity) {
  if (!Array.isArray(anchors)) return [];
  return anchors.filter(a => a && typeof a === "object"
    && (a.kind === "sign" || a.kind === "date") && typeof a.role === "string" && a.role.length <= 80
    && Number.isInteger(a.page) && a.page >= 0 && a.page < pageCount
    && [a.x, a.y, a.w, a.h].every(n => Number.isFinite(n) && n >= 0 && n < 20000)).slice(0, 200);
}

/**
 * @param {object} PDFLib  the pdf-lib module
 * @param {Uint8Array} pdfBytes
 * @param {Array<{ signer_role, signature_data, signed_at, status }>} signers
 * @param {Array} anchors  from renderPagedPdfWithAnchors (page px)
 * @returns {Promise<Uint8Array>}  the same bytes when there is nothing to draw
 */
/**
 * The envelope ID in the top margin of every body page, as DocuSign and
 * DigiSign print theirs: any single page can be matched to its record,
 * and a page from another document cannot be slipped into the stack.
 * @param {{ pages?: number }} o  only the first `pages` pages (the body)
 */
async function stampEnvelopeId(PDFLib, pdfBytes, envelopeId, { pages = null } = {}) {
  const id = String(envelopeId || "").trim();
  if (!id) return pdfBytes;
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.load(pdfBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const all = pdf.getPages();
  const count = pages === null ? all.length : Math.min(all.length, Math.max(0, pages));
  const text = "Housify Envelope ID: " + id;
  for (let p = 0; p < count; p++) {
    const page = all[p];
    const { height } = page.getSize();
    page.drawText(text, { x: 36, y: height - 22, size: 7, font, color: rgb(0.35, 0.35, 0.4) });
  }
  return pdf.save();
}

/** The tag under a signature line: "Signed via Housify · ID 1A2B3C4D" (the signature's own hash, else the envelope's). */
function signatureTag(signer, envelopeId) {
  const key = String(signer?.integrity_hash || envelopeId || "").replace(/-/g, "").slice(0, 8).toUpperCase();
  return "Signed via Housify" + (key ? " \u00b7 ID " + key : "");
}

/**
 * @param {{ envelopeId?: string }} o  with an envelopeId, each signature gets its tag underneath
 */
async function stampSignatures(PDFLib, pdfBytes, signers, anchors, { envelopeId = null } = {}) {
  const byRole = new Map();
  for (const s of signers || []) {
    if (s && s.signer_role && s.signature_data && (s.status === "signed" || s.status === undefined)) byRole.set(String(s.signer_role), s);
  }
  const list = validAnchors(anchors).filter(a => byRole.has(a.role));
  if (!list.length || !byRole.size) return pdfBytes;
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.load(pdfBytes);
  const pages = pdf.getPages();
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const plain = await pdf.embedFont(StandardFonts.Helvetica);
  const images = new Map();
  for (const a of list) {
    const s = byRole.get(a.role);
    if (a.kind !== "sign" || signatureText(s.signature_data) !== null || images.has(s)) continue;
    try { images.set(s, await pdf.embedPng(s.signature_data)); }
    catch (_e) { try { images.set(s, await pdf.embedJpg(s.signature_data)); } catch (_e2) { /* not an image: skipped */ } }
  }
  const ink = rgb(0.08, 0.08, 0.35);
  for (const a of list) {
    const page = pages[a.page];
    if (!page) continue;
    const s = byRole.get(a.role);
    const { height: H } = page.getSize();
    const x = a.x * PX_TO_PT, lineTop = H - a.y * PX_TO_PT, lineBottom = lineTop - a.h * PX_TO_PT, w = a.w * PX_TO_PT;
    // The slot's text is a row of underscores; the signature sits on that
    // rule, so its bottom is a little above the slot's bottom edge.
    const base = lineBottom + 3;
    if (a.kind === "date") {
      const text = signedDateText(s.signed_at);
      if (text) page.drawText(text, { x: x + 2, y: base + 1, size: DATE_SIZE_PT, font: plain, color: ink });
      continue;
    }
    // The tag sits on the right end of the line, above the rule (there is
    // no room under it: "Print Name" follows at once); the signature keeps
    // to the room left of it.
    const tag = envelopeId ? signatureTag(s, envelopeId) : "";
    const tagW = tag ? plain.widthOfTextAtSize(tag, 5) + 4 : 0;
    const room = w - 4 - tagW;
    const typed = signatureText(s.signature_data);
    if (typed !== null) {
      let size = TYPED_SIZE_PT;
      while (size > 9 && italic.widthOfTextAtSize(typed, size) > room) size -= 1;
      page.drawText(typed, { x: x + 2, y: base + 2, size, font: italic, color: ink });
    } else if (images.get(s)) {
      const img = images.get(s);
      let h = MAX_SIG_HEIGHT_PT, iw = img.width * (h / img.height);
      if (iw > room) { iw = room; h = img.height * (iw / img.width); }
      page.drawImage(img, { x: x + 2, y: base, width: iw, height: h });
    }
    if (tag) page.drawText(tag, { x: x + w - tagW, y: base + 1.5, size: 5, font: plain, color: rgb(0.35, 0.35, 0.4) });
  }
  return pdf.save();
}

module.exports = { stampSignatures, stampEnvelopeId, signatureTag, signatureText, signedDateText, validAnchors, roleLabel, initialsRoster };
