// Server copy of src/utils/initialsStamp.js (CommonJS). Keep the two together.
// Initials on every page of a document. Each signer has a small labelled
// box in the foot of each page -- printed empty on the unsigned copy and
// the signing screen, filled with the initials (typed, in an italic face;
// or drawn, as the picture they drew) on the signed copy. The boxes sit
// at the right of the page foot in the ROSTER's order: the signers in
// the order their signature lines appear in the document (initialsRoster
// in signatureStamp.js), so the box a signer initials on screen is the
// box their initials land in. api/_initials-stamp.js is the same code
// for the server, which stamps the copy it stores; keep the two together.
const INITIALS_BOX = { width: 54, height: 22, gap: 8, right: 40, bottom: 18 };   // pt

/** "typed:SA|ts:..." -> "SA"; a PNG data URL -> null (drawn). */
function initialsText(data) {
  const s = String(data || "");
  if (!s.startsWith("typed:")) return null;
  return s.slice(6).split("|")[0].trim().slice(0, 6);
}

/** Box `i` of `n` on a page `width` pt wide: { x, y, width, height } in pt, from the bottom-left. */
function initialsBoxRect(i, width) {
  const B = INITIALS_BOX;
  return { x: width - B.right - (i + 1) * B.width - i * B.gap, y: B.bottom, width: B.width, height: B.height };
}

/**
 * @param {object} PDFLib  the pdf-lib module
 * @param {Uint8Array} pdfBytes
 * @param {Array<{ initials_data, signer_role, signer_name, sign_order }>} signers  the rows (initials_data may be empty)
 * @param {{ pages?: number, roster?: Array<{ role, label }> }} o
 *   pages: stamp only the first `pages` pages (the body; not the certificate).
 *   roster: every signer's box, in order, whether or not they gave initials
 *   (the document's own order). Without it, the signers with initials, by
 *   sign_order, as older documents were stamped.
 */
async function stampInitials(PDFLib, pdfBytes, signers, { pages = null, roster = null } = {}) {
  const rows = (signers || []).filter(s => s && s.signer_role);
  const byRole = new Map(rows.map(s => [String(s.signer_role), s]));
  const boxes = Array.isArray(roster) && roster.length
    ? roster.map(r => ({ role: String(r.role), label: r.label || String(r.role), row: byRole.get(String(r.role)) || null }))
    : rows.filter(s => s.initials_data).map(s => ({ role: String(s.signer_role), label: String(s.signer_role || s.signer_name || "").replace(/_/g, " "), row: s }));
  if (!boxes.length) return pdfBytes;
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.load(pdfBytes);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const small = await pdf.embedFont(StandardFonts.Helvetica);
  const images = new Map();
  for (const b of boxes) {
    const data = b.row?.initials_data;
    if (!data || initialsText(data) !== null) continue;
    try { images.set(b, await pdf.embedPng(data)); } catch (_e) { /* not a PNG: skipped */ }
  }
  const all = pdf.getPages();
  const count = pages === null ? all.length : Math.min(all.length, Math.max(0, pages));
  for (let p = 0; p < count; p++) {
    const page = all[p];
    const { width } = page.getSize();
    boxes.forEach((b, i) => {
      const { x, y, width: w, height: h } = initialsBoxRect(i, width);
      page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.5 });
      const data = b.row?.initials_data;
      const text = data ? initialsText(data) : null;
      if (text !== null && text) {
        const size = 11, tw = italic.widthOfTextAtSize(text, size);
        page.drawText(text, { x: x + (w - tw) / 2, y: y + 7, size, font: italic, color: rgb(0.1, 0.1, 0.35) });
      } else if (images.get(b)) {
        const img = images.get(b), ih = h - 4, iw = Math.min(w - 4, img.width * (ih / img.height));
        page.drawImage(img, { x: x + (w - iw) / 2, y: y + 2, width: iw, height: ih });
      }
      const label = String(b.label || "").slice(0, 24);
      if (label) page.drawText(label, { x, y: y - 7, size: label.length > 14 ? 4.6 : 5.5, font: small, color: rgb(0.4, 0.4, 0.4) });
    });
  }
  return pdf.save();
}

module.exports = { INITIALS_BOX, initialsText, initialsBoxRect, stampInitials };
