// Initials on every page of a signed PDF. Each signer who gave initials
// gets a small box in the foot of each page: the initials (typed, in an
// italic face; or drawn, as the picture they drew) with the signer's role
// under it. api/_initials-stamp.js is the same code for the server, which
// stamps the copy it stores; keep the two together.
export const INITIALS_BOX = { width: 54, height: 22, gap: 8, right: 40, bottom: 18 };

/** "typed:SA|ts:..." -> "SA"; a PNG data URL -> null (drawn). */
export function initialsText(data) {
  const s = String(data || "");
  if (!s.startsWith("typed:")) return null;
  return s.slice(6).split("|")[0].trim().slice(0, 6);
}

/**
 * @param {object} PDFLib  the pdf-lib module
 * @param {Uint8Array} pdfBytes
 * @param {Array<{ initials_data, signer_role, signer_name }>} signers  only those with initials
 * @param {{ pages?: number }} o  stamp only the first `pages` pages (the body; not the certificate)
 */
export async function stampInitials(PDFLib, pdfBytes, signers, { pages = null } = {}) {
  const list = (signers || []).filter(s => s && s.initials_data);
  if (!list.length) return pdfBytes;
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.load(pdfBytes);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const small = await pdf.embedFont(StandardFonts.Helvetica);
  const images = new Map();
  for (const s of list) {
    if (initialsText(s.initials_data) !== null) continue;
    try { images.set(s, await pdf.embedPng(s.initials_data)); } catch (_e) { /* not a PNG: skipped */ }
  }
  const all = pdf.getPages();
  const count = pages === null ? all.length : Math.min(all.length, Math.max(0, pages));
  const B = INITIALS_BOX;
  for (let p = 0; p < count; p++) {
    const page = all[p];
    const { width } = page.getSize();
    list.forEach((s, i) => {
      const x = width - B.right - (i + 1) * B.width - i * B.gap, y = B.bottom;
      page.drawRectangle({ x, y, width: B.width, height: B.height, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.5 });
      const text = initialsText(s.initials_data);
      if (text !== null) {
        const size = 11, w = italic.widthOfTextAtSize(text, size);
        page.drawText(text, { x: x + (B.width - w) / 2, y: y + 7, size, font: italic, color: rgb(0.1, 0.1, 0.35) });
      } else if (images.get(s)) {
        const img = images.get(s), h = B.height - 4, w = Math.min(B.width - 4, img.width * (h / img.height));
        page.drawImage(img, { x: x + (B.width - w) / 2, y: y + 2, width: w, height: h });
      }
      const label = String(s.signer_role || s.signer_name || "").replace(/_/g, " ").slice(0, 16);
      if (label) page.drawText(label, { x, y: y - 7, size: 5.5, font: small, color: rgb(0.4, 0.4, 0.4) });
    });
  }
  return pdf.save();
}
