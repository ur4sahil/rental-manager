// A real-text PDF of a document, page for page as the editor shows it.
//
// The old export photographed the HTML (html2canvas) and sliced the
// picture into pages: 8 MB files, text that can't be selected or
// searched, and page breaks that had nothing to do with the editor's.
//
// This lays the document out off-screen with the SAME engine the editor
// uses (docKit: same schema, same pagination add-on, same CSS), then
// reads back where the browser put every word and writes it at those
// coordinates with pdf-lib, in the same font files the screen used. The
// browser does all the typesetting; nothing here decides a line break or
// a page break, so the PDF cannot disagree with what was on screen.
import { Editor } from "@tiptap/core";
import { DEFAULT_PAGE_SETUP, DOC_FONT_FAMILY, DOC_FONT_SIZE, DOC_LINE_HEIGHT, docExtensions, settlePagination } from "./docKit";

import serifRegular from "../fonts/LiberationSerif-Regular.ttf";
import serifBold from "../fonts/LiberationSerif-Bold.ttf";
import serifItalic from "../fonts/LiberationSerif-Italic.ttf";
import serifBoldItalic from "../fonts/LiberationSerif-BoldItalic.ttf";
import sansRegular from "../fonts/LiberationSans-Regular.ttf";
import sansBold from "../fonts/LiberationSans-Bold.ttf";
import sansItalic from "../fonts/LiberationSans-Italic.ttf";
import sansBoldItalic from "../fonts/LiberationSans-BoldItalic.ttf";
import monoRegular from "../fonts/LiberationMono-Regular.ttf";
import monoBold from "../fonts/LiberationMono-Bold.ttf";
import monoItalic from "../fonts/LiberationMono-Italic.ttf";
import monoBoldItalic from "../fonts/LiberationMono-BoldItalic.ttf";

// ascent/descent as a fraction of the font size (hhea table). The browser
// reports a word's box, not its baseline; the baseline sits `ascent`
// below the top of that box.
const FACES = {
  serif: { ascent: 0.891, descent: 0.216, files: [serifRegular, serifBold, serifItalic, serifBoldItalic] },
  sans: { ascent: 0.905, descent: 0.212, files: [sansRegular, sansBold, sansItalic, sansBoldItalic] },
  mono: { ascent: 0.833, descent: 0.300, files: [monoRegular, monoBold, monoItalic, monoBoldItalic] },
};
const PX_TO_PT = 0.75;

function faceOf(fontFamily) {
  const first = String(fontFamily || "").split(",")[0].toLowerCase();
  if (/mono|courier|consolas|menlo/.test(first)) return "mono";
  if (/sans|arial|helvetica|calibri|inter|roboto|segoe|verdana|tahoma|system-ui/.test(first) && !/liberation serif/.test(first)) return "sans";
  return "serif";
}
function parseColor(css) {
  const m = String(css || "").match(/rgba?\(([^)]+)\)/);
  if (!m) return [0.09, 0.09, 0.09];
  const [r, g, b] = m[1].split(",").map(v => parseFloat(v) / 255);
  return [r || 0, g || 0, b || 0];
}

/**
 * Lay `html` out on pages and read the layout back.
 * @returns {Promise<{ pages: number, width: number, height: number, items: Array, cleanup: Function }>}
 */
async function layout(html, setup) {
  const host = document.createElement("div");
  host.className = "paged-editor hx-pdf-host";
  host.setAttribute("aria-hidden", "true");
  // Off-screen but laid out. Not display:none (no layout) and not
  // visibility:hidden (it inherits, and hidden text reports no boxes in
  // some engines). The font/colour block mirrors the editor's wrapper.
  host.style.cssText = `position:fixed;left:-20000px;top:0;opacity:0;pointer-events:none;`
    + `font-family:${DOC_FONT_FAMILY};font-size:${DOC_FONT_SIZE};line-height:${DOC_LINE_HEIGHT};color:rgb(23,23,23);overflow-wrap:anywhere;`;
  const mount = document.createElement("div");
  host.appendChild(mount);
  document.body.appendChild(host);

  const editor = new Editor({
    element: mount,
    // pageGap 0: sheets sit flush, so a position in the column maps
    // straight to (page, offset). The gap is decoration in the editor.
    extensions: docExtensions({ paged: true, setup, pageGap: 0 }),
    content: html,
    editable: false,
  });
  const cleanup = () => { try { editor.destroy(); } catch { /* already gone */ } host.remove(); };

  try {
    // The layout must be measured in the faces that will be embedded.
    if (document.fonts?.load) {
      await Promise.all(["", "bold ", "italic ", "italic bold "].flatMap(v => ["Liberation Serif", "Liberation Sans", "Liberation Mono"]
        .map(f => document.fonts.load(`${v}16px "${f}"`).catch(() => null))));
    }
    await settlePagination(editor).done;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const pm = editor.view.dom;
    const box = pm.getBoundingClientRect();
    const ox = box.left + pm.clientLeft, oy = box.top + pm.clientTop;
    const breakers = Array.from(pm.querySelectorAll(".rm-page-break .breaker"));
    const pages = Math.max(1, breakers.length);
    const height = setup.pageHeight, width = setup.pageWidth;
    // Sheet pitch, measured rather than assumed: the add-on's gap element
    // keeps its two 1px rules even at pageGap 0.
    const pitch = breakers.length > 1
      ? breakers[1].getBoundingClientRect().top - breakers[0].getBoundingClientRect().top
      : height;
    const place = (left, top) => {
      const y = top - oy;
      const page = Math.min(pages - 1, Math.max(0, Math.floor((y + 0.5) / pitch)));
      return { page, x: left - ox, y: y - page * pitch };
    };

    const items = [];
    const styleCache = new Map();
    const styleOf = (el) => {
      let s = styleCache.get(el);
      if (!s) {
        const cs = getComputedStyle(el);
        const face = faceOf(cs.fontFamily);
        const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
        const italic = cs.fontStyle === "italic" || cs.fontStyle === "oblique";
        s = {
          hidden: cs.display === "none" || cs.visibility === "hidden",
          face, variant: (bold ? 1 : 0) + (italic ? 2 : 0),
          size: parseFloat(cs.fontSize) || 16, color: parseColor(cs.color),
          decoration: cs.textDecorationLine || "",
        };
        styleCache.set(el, s);
      }
      return s;
    };
    const baselineOf = (rect, s) => {
      const f = FACES[s.face];
      // Centre the font's own box in the reported one (they differ by
      // rounding), then drop to the baseline.
      return rect.top + (rect.height - (f.ascent + f.descent) * s.size) / 2 + f.ascent * s.size;
    };

    // --- text, a word at a time. Each word is drawn where the browser put
    // it, so justification and every wrap carry over exactly.
    const range = document.createRange();
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el) continue;
      const s = styleOf(el);
      if (s.hidden || !s.size) continue;
      const text = node.nodeValue;
      const re = /\S+/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
        const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
        if (!rects.length) continue;
        if (rects.length === 1) {
          const p = place(rects[0].left, baselineOf(rects[0], s));
          items.push({ type: "text", ...p, text: m[0], s });
          continue;
        }
        // A word the browser split across lines (very long, or broken at
        // a hyphen): place it a character at a time.
        for (let i = 0; i < m[0].length; i++) {
          range.setStart(node, m.index + i); range.setEnd(node, m.index + i + 1);
          const r = range.getClientRects()[0];
          if (!r || !r.width) continue;
          const p = place(r.left, baselineOf(r, s));
          items.push({ type: "text", ...p, text: m[0][i], s });
        }
      }
    }

    // --- page numbers: the add-on prints them with a CSS counter, which
    // is not text in the DOM.
    pm.querySelectorAll(".rm-page-number, .rm-page-number-plus").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.height) return;
      const s = styleOf(el);
      const p = place(r.left, baselineOf(r, s));
      items.push({ type: "text", ...p, text: String(p.page + 1), s });
    });

    // --- underline / strike-through: one rule per line fragment of the
    // decorated element, so it runs under the spaces too -- a signature
    // line in a lease is an underlined run of nothing but spaces.
    pm.querySelectorAll("u, ins, s, del, strike, a, [style*='text-decoration']").forEach((el) => {
      const s = styleOf(el);
      const under = el.tagName === "U" || el.tagName === "INS" || s.decoration.includes("underline");
      const strike = /^(S|DEL|STRIKE)$/.test(el.tagName) || s.decoration.includes("line-through");
      if ((!under && !strike) || s.hidden) return;
      for (const r of el.getClientRects()) {
        if (r.width < 0.5) continue;
        const base = baselineOf(r, s);
        const thickness = Math.max(0.5, s.size * 0.05);
        if (under) items.push({ type: "line", ...place(r.left, base + s.size * 0.11), w: r.width, thickness, color: s.color });
        if (strike) items.push({ type: "line", ...place(r.left, base - s.size * 0.27), w: r.width, thickness, color: s.color });
      }
    });

    // --- list markers: drawn by CSS (::before), so not in the DOM either.
    pm.querySelectorAll("li").forEach((li) => {
      const p = li.querySelector(":scope > p");
      const first = p && document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
      if (!first || !first.nodeValue.length) return;
      range.setStart(first, 0); range.setEnd(first, 1);
      const r = range.getClientRects()[0];
      if (!r) return;
      const s = styleOf(first.parentElement);
      const base = baselineOf(r, s);
      const hang = 24; // 0.25in, as in index.css
      const list = li.parentElement;
      if (list && list.tagName === "OL") {
        const n = Array.from(list.children).indexOf(li) + (parseInt(list.getAttribute("start"), 10) || 1);
        items.push({ type: "text", ...place(r.left - hang, base), text: n + ".", s: styleOf(p) });
      } else {
        const radius = s.size * 0.15;
        items.push({ type: "dot", ...place(r.left - hang + radius, base - s.size * 0.28), radius, color: s.color });
      }
    });

    // --- rules and table cell borders
    pm.querySelectorAll("hr").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width) items.push({ type: "line", ...place(r.left, r.top + r.height / 2), w: r.width, thickness: 0.75, color: [0.6, 0.6, 0.6] });
    });
    pm.querySelectorAll("td, th").forEach((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const color = parseColor(cs.borderTopColor);
      const edges = [
        [parseFloat(cs.borderTopWidth), r.left, r.top, r.width, 0], [parseFloat(cs.borderBottomWidth), r.left, r.bottom, r.width, 0],
        [parseFloat(cs.borderLeftWidth), r.left, r.top, 0, r.height], [parseFloat(cs.borderRightWidth), r.right, r.top, 0, r.height],
      ];
      for (const [bw, x, y, w, h] of edges) {
        if (!(bw > 0)) continue;
        const a = place(x, y), b = place(x + w, y + h);
        if (a.page === b.page) items.push({ type: "line", ...a, w, h, thickness: bw, color });
      }
    });

    return { pages, width, height, items, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * Render a document to PDF bytes.
 * @param {object} o
 * @param {string} o.html        the merged, sanitized document body
 * @param {object} [o.pageSetup] page setup (size, margins, header/footer)
 * @param {string} [o.title]     PDF title metadata
 * @returns {Promise<Uint8Array>}
 */
export async function renderPagedPdf({ html, pageSetup, title }) {
  const setup = { ...DEFAULT_PAGE_SETUP, ...(pageSetup || {}) };
  const [{ PDFDocument, rgb }, fontkitMod] = await Promise.all([import("pdf-lib"), import("@pdf-lib/fontkit")]);
  const { pages, width, height, items, cleanup } = await layout(html || "", setup);
  try {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkitMod.default || fontkitMod);
    if (title) pdf.setTitle(String(title).slice(0, 200));
    pdf.setProducer("Housify");

    // Embed only the faces this document uses.
    const fonts = new Map();
    const need = new Set(items.filter(i => i.type === "text").map(i => i.s.face + ":" + i.s.variant));
    await Promise.all(Array.from(need).map(async (key) => {
      const [face, variant] = key.split(":");
      const bytes = await (await fetch(FACES[face].files[Number(variant)])).arrayBuffer();
      fonts.set(key, await pdf.embedFont(bytes, { subset: true }));
    }));

    const W = width * PX_TO_PT, H = height * PX_TO_PT;
    const sheets = Array.from({ length: pages }, () => pdf.addPage([W, H]));
    for (const it of items) {
      const sheet = sheets[it.page];
      if (!sheet) continue;
      const x = it.x * PX_TO_PT, y = H - it.y * PX_TO_PT;
      if (it.type === "text") {
        sheet.drawText(it.text, { x, y, size: it.s.size * PX_TO_PT, font: fonts.get(it.s.face + ":" + it.s.variant), color: rgb(...it.s.color) });
      } else if (it.type === "line") {
        sheet.drawLine({ start: { x, y }, end: { x: x + (it.w || 0) * PX_TO_PT, y: y - (it.h || 0) * PX_TO_PT }, thickness: it.thickness * PX_TO_PT, color: rgb(...it.color) });
      } else if (it.type === "dot") {
        sheet.drawCircle({ x, y, size: it.radius * PX_TO_PT, color: rgb(...it.color) });
      }
    }
    return await pdf.save();
  } finally {
    cleanup();
  }
}

/** Join PDFs end to end (document pages, then e.g. a signature certificate). */
export async function concatPdfs(parts) {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  for (const bytes of parts) {
    if (!bytes) continue;
    const src = await PDFDocument.load(bytes);
    (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
  }
  return out.save();
}

export function pdfFileName(name) {
  return (String(name || "document").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "document") + ".pdf";
}
