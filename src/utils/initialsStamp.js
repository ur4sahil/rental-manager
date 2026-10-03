// Initials on every page of a document, laid out as Sigma's paper lease
// has them: a short line at the foot of each page with "Landlord" under
// it at the LEFT margin and "Tenant" under it at the RIGHT margin (a
// second tenant's line sits inside the first's). Printed empty on the
// unsigned copy and the signing screen, filled with the initials (typed,
// in an italic face; or drawn, as the picture they drew) on the signed
// copy. Witnesses have no line: they sign once, on the last page. The
// ROSTER (initialsRoster in signatureStamp.js) lists the signers in the
// order their signature lines appear, so the line a signer initials on
// screen is the line their initials land on. api/_initials-stamp.js is
// the same code for the server, which stamps the copy it stores; keep
// the two together.
export const INITIALS_BOX = { width: 60, height: 22, gap: 10, left: 72, right: 72, bottom: 26 };   // pt

/** Does this role sit at the left margin (the landlord's side)? */
export const isLandlordRole = (role) => /landlord|lessor|owner|manager/.test(String(role || "").toLowerCase());

/** "typed:SA|ts:..." -> "SA"; a PNG data URL -> null (drawn). */
export function initialsText(data) {
  const s = String(data || "");
  if (!s.startsWith("typed:")) return null;
  return s.slice(6).split("|")[0].trim().slice(0, 6);
}

/**
 * Line `i` of the roster on a page `width` pt wide: { x, y, width, height }
 * in pt, from the bottom-left. The landlord's side (left margin, running
 * right) or the tenants' side (right margin, running left), by the role;
 * without a roster the first line is the landlord's.
 */
export function initialsBoxRect(i, width, roster = null) {
  const B = INITIALS_BOX;
  const roles = Array.isArray(roster) ? roster.map(r => String(r?.role || "")) : null;
  const left = roles ? isLandlordRole(roles[i]) : i === 0;
  const k = roles ? roles.slice(0, i).filter(r => isLandlordRole(r) === left).length : 0;
  const x = left ? B.left + k * (B.width + B.gap) : width - B.right - (k + 1) * B.width - k * B.gap;
  return { x, y: B.bottom, width: B.width, height: B.height };
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
export async function stampInitials(PDFLib, pdfBytes, signers, { pages = null, roster = null } = {}) {
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
      const { x, y, width: w, height: h } = initialsBoxRect(i, width, boxes);
      // The line the initials sit on, as the paper lease prints it.
      page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: 0.6, color: rgb(0.2, 0.2, 0.2) });
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
      if (label) page.drawText(label, { x, y: y - 9, size: label.length > 14 ? 6 : 7.5, font: small, color: rgb(0.2, 0.2, 0.2) });
    });
  }
  return pdf.save();
}
