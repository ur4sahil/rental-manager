// A document's HTML -> a Word file (.docx) that keeps what the editor
// keeps: paragraphs with their alignment, indents, spacing and line
// height; runs with bold, italic, underline, strike, colour, highlight,
// super/subscript, font and size; tabs; numbered and bulleted lists in
// their styles; tables; forced page breaks; and the page setup with its
// header and footer. The old export flattened everything to plain
// paragraphs, which was no use to an attorney marking up a lease.
//
// Works in a browser (DOMParser). The `docx` module is handed in so the
// caller can load it lazily.
import { lengthToInches } from "./docRules.js";

const TWIPS_PER_IN = 1440;
const toTwips = (css) => Math.round(lengthToInches(css) * TWIPS_PER_IN);
const PX_TO_TWIPS = 15;
const FONT_MAP = { "liberation serif": "Times New Roman", "liberation sans": "Arial", "liberation mono": "Courier New" };
const firstFont = (family) => { const f = String(family || "").split(",")[0].replace(/['"]/g, "").trim(); return FONT_MAP[f.toLowerCase()] || f || null; };
const NUM_FORMAT = { decimal: "decimal", "lower-alpha": "lowerLetter", "upper-alpha": "upperLetter", "lower-roman": "lowerRoman", "upper-roman": "upperRoman", "paren-decimal": "decimal", "paren-alpha": "lowerLetter", "paren-roman": "lowerRoman", clause: "decimal" };
const NUM_TEXT = (style, lvl) => (/^paren-/.test(style) ? `(%${lvl + 1})` : style === "clause" ? Array.from({ length: lvl + 1 }, (_, i) => `%${i + 1}`).join(".") : `%${lvl + 1}.`);
const BULLET_TEXT = { disc: "•", circle: "o", dash: "–", square: "▪" };
const HIGHLIGHT_NAMES = { "#fef08a": "yellow", "#bbf7d0": "green", "#bfdbfe": "cyan", "#fbcfe8": "magenta", "#fed7aa": "yellow", "#e9d5ff": "magenta", "#e5e7eb": "lightGray", yellow: "yellow", green: "green", cyan: "cyan", magenta: "magenta", blue: "blue", red: "red", lightgray: "lightGray" };

function cssColor(v) {
  const s = String(v || "").trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{6})$/i); if (m) return m[1].toUpperCase();
  m = s.match(/^#([0-9a-f]{3})$/i); if (m) return m[1].split("").map(c => c + c).join("").toUpperCase();
  m = s.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (m) return [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, "0")).join("").toUpperCase();
  return null;
}
function highlightName(v) {
  const s = String(v || "").trim().toLowerCase();
  if (HIGHLIGHT_NAMES[s]) return HIGHLIGHT_NAMES[s];
  const hex = cssColor(s); if (!hex) return null;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  if (r > 200 && g > 200 && b < 180) return "yellow";
  if (g > r && g > b) return "green";
  if (b > r && b > g) return "cyan";
  if (r > g && r > b) return "magenta";
  return "lightGray";
}

/**
 * @param {object} docx  the `docx` module
 * @param {string} html  the document body (merged; the page-setup marker removed)
 * @param {object} o     { pageSetup, title, defaultFont, defaultSizePt }
 * @returns {Promise<Blob>}
 */
export async function htmlToDocx(docx, html, { pageSetup = null, title = "Document", defaultFont = "Times New Roman", defaultSizePt = 12 } = {}) {
  const { Document, Packer, Paragraph, TextRun, Tab, Table, TableRow, TableCell, WidthType, AlignmentType, PageBreak, Header, Footer, PageNumber, BorderStyle, LineRuleType } = docx;
  const doc = new DOMParser().parseFromString(`<div id="root">${html || ""}</div>`, "text/html");
  const root = doc.getElementById("root");
  const numbering = [];     // numbering.config entries, one per list
  const children = [];      // the section's content

  // ── runs ───────────────────────────────────────────────────────────
  const runsOf = (node, inherited) => {
    const out = [];
    const walk = (n, st) => {
      if (n.nodeType === 3) {
        const text = n.nodeValue;
        if (!text) return;
        const parts = text.split("\t");
        parts.forEach((part, i) => {
          const children = [];
          if (i > 0) children.push(new Tab());
          if (part) children.push(part);
          if (children.length) out.push(new TextRun({ ...st, children }));
        });
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (tag === "br") { out.push(new TextRun({ ...st, break: 1 })); return; }
      const next = { ...st };
      if (tag === "b" || tag === "strong") next.bold = true;
      if (tag === "i" || tag === "em") next.italics = true;
      if (tag === "u") next.underline = {};
      if (tag === "s" || tag === "del" || tag === "strike") next.strike = true;
      if (tag === "sup") next.superScript = true;
      if (tag === "sub") next.subScript = true;
      if (tag === "code") next.font = "Courier New";
      if (tag === "a" && n.getAttribute("href")) { next.underline = {}; next.color = "1D4ED8"; }
      const style = n.style;
      if (style) {
        if (style.fontWeight && (style.fontWeight === "bold" || Number(style.fontWeight) >= 600)) next.bold = true;
        if (style.fontStyle === "italic") next.italics = true;
        if (/underline/.test(style.textDecoration || style.textDecorationLine || "")) next.underline = {};
        if (/line-through/.test(style.textDecoration || style.textDecorationLine || "")) next.strike = true;
        if (style.fontFamily) { const f = firstFont(style.fontFamily); if (f) next.font = f; }
        if (style.fontSize) { const pt = lengthToInches(style.fontSize) * 72; if (pt > 0) next.size = Math.round(pt * 2); }
        if (style.color) { const c = cssColor(style.color); if (c) next.color = c; }
        if (style.backgroundColor) { const h = highlightName(style.backgroundColor); if (h) next.highlight = h; }
        if (style.verticalAlign === "super") next.superScript = true;
        if (style.verticalAlign === "sub") next.subScript = true;
      }
      for (const c of n.childNodes) walk(c, next);
    };
    for (const c of node.childNodes) walk(c, inherited || {});
    return out;
  };

  // ── paragraphs ─────────────────────────────────────────────────────
  const paragraphOf = (el, extra = {}) => {
    const st = el.style || {};
    const opts = { children: runsOf(el, extra.run), ...extra.paragraph };
    const align = st.textAlign || el.getAttribute("align");
    if (align === "center") opts.alignment = AlignmentType.CENTER;
    else if (align === "right") opts.alignment = AlignmentType.RIGHT;
    else if (align === "justify") opts.alignment = AlignmentType.JUSTIFIED;
    const indent = {};
    if (st.marginLeft) indent.left = toTwips(st.marginLeft);
    if (st.marginRight) indent.right = toTwips(st.marginRight);
    if (st.textIndent) { const t = toTwips(st.textIndent); if (t < 0) indent.hanging = -t; else if (t > 0) indent.firstLine = t; }
    if (extra.indent) Object.assign(indent, extra.indent);
    if (Object.keys(indent).length) opts.indent = indent;
    const spacing = {};
    if (st.marginTop) spacing.before = toTwips(st.marginTop);
    if (st.marginBottom) spacing.after = toTwips(st.marginBottom);
    if (st.lineHeight) {
      const lh = String(st.lineHeight).trim();
      if (/^[\d.]+$/.test(lh)) { spacing.line = Math.round((Number(lh) / 1.15) * 240); spacing.lineRule = LineRuleType.AUTO; }
      else if (/pt$|px$|in$/.test(lh)) { spacing.line = toTwips(lh); spacing.lineRule = LineRuleType.EXACT; }
    }
    if (Object.keys(spacing).length) opts.spacing = spacing;
    if (el.getAttribute("data-keep-next") === "1") opts.keepNext = true;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      opts.heading = docx.HeadingLevel["HEADING_" + tag[1]];
      opts.children = runsOf(el, { bold: true, ...(extra.run || {}) });
    }
    return new Paragraph(opts);
  };

  // ── lists ──────────────────────────────────────────────────────────
  // Every <ol>/<ul> gets its own numbering instance, so a nested list
  // restarts under each parent item (as the editor shows it) and keeps
  // its own style; `depth` only sets how far in it sits.
  const listNumbering = (list, depth) => {
    const ordered = list.tagName === "OL";
    const ref = "list-" + (numbering.length + 1);
    const style = ordered ? (list.getAttribute("data-list-style") || "decimal") : (list.getAttribute("data-bullet") || "disc");
    const start = ordered ? Math.max(1, parseInt(list.getAttribute("start"), 10) || 1) : 1;
    numbering.push({
      reference: ref,
      levels: [{
        level: 0,
        format: ordered ? NUM_FORMAT[style] || "decimal" : "bullet",
        text: ordered ? NUM_TEXT(style, 0) : (BULLET_TEXT[style] || "\u2022"),
        alignment: AlignmentType.LEFT,
        start,
        style: { paragraph: { indent: { left: 720 * (depth + 1), hanging: 360 } } },
      }],
    });
    return ref;
  };
  const listItems = (list, depth) => {
    const out = [];
    const ref = listNumbering(list, depth);
    for (const li of list.children) {
      if (li.tagName !== "LI") continue;
      let first = true;
      for (const child of li.childNodes) {
        if (child.nodeType === 1 && /^(UL|OL)$/.test(child.tagName)) { out.push(...listItems(child, depth + 1)); continue; }
        if (child.nodeType === 1 && /^(P|H[1-6]|DIV)$/.test(child.tagName)) {
          out.push(paragraphOf(child, first ? { paragraph: { numbering: { reference: ref, level: 0 } } } : { indent: { left: (depth + 1) * 720 } }));
          first = false;
        } else if (child.nodeType === 3 && child.nodeValue.trim()) {
          out.push(new Paragraph({ children: [new TextRun(child.nodeValue)], numbering: first ? { reference: ref, level: 0 } : undefined, indent: first ? undefined : { left: (depth + 1) * 720 } }));
          first = false;
        }
      }
    }
    return out;
  };

  // ── tables ─────────────────────────────────────────────────────────
  const cellBorder = (on) => (on ? { style: BorderStyle.SINGLE, size: 4, color: "333333" } : { style: BorderStyle.NONE, size: 0, color: "FFFFFF" });
  const tableOf = (table) => {
    const borders = table.getAttribute("data-borders") || "all";
    const rows = [];
    const trs = Array.from(table.querySelectorAll(":scope > tbody > tr, :scope > thead > tr, :scope > tr"));
    trs.forEach((tr, ri) => {
      const cells = [];
      Array.from(tr.children).forEach((td, ci) => {
        const blocks = [];
        for (const c of td.childNodes) {
          if (c.nodeType === 1 && /^(P|H[1-6])$/.test(c.tagName)) blocks.push(paragraphOf(c));
          else if (c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName)) blocks.push(...listItems(c, 0));
          else if (c.nodeType === 3 && c.nodeValue.trim()) blocks.push(new Paragraph({ children: [new TextRun(c.nodeValue)] }));
        }
        if (!blocks.length) blocks.push(new Paragraph({ children: [] }));
        const outer = { top: ri === 0, bottom: ri === trs.length - 1, left: ci === 0, right: ci === tr.children.length - 1 };
        const b = (side) => cellBorder(borders === "all" || (borders === "outer" && outer[side]));
        cells.push(new TableCell({
          children: blocks,
          columnSpan: parseInt(td.getAttribute("colspan"), 10) || 1, rowSpan: parseInt(td.getAttribute("rowspan"), 10) || 1,
          borders: { top: b("top"), bottom: b("bottom"), left: b("left"), right: b("right") },
          shading: td.tagName === "TH" ? { fill: "F3F4F6" } : undefined,
        }));
      });
      if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: tr.parentElement.tagName === "THEAD" }));
    });
    if (!rows.length) return null;
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
  };

  // ── the body, block by block ───────────────────────────────────────
  const block = (el) => {
    if (el.nodeType === 3) { if (el.nodeValue.trim()) children.push(new Paragraph({ children: [new TextRun(el.nodeValue)] })); return; }
    if (el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (el.hasAttribute("data-page-break")) { children.push(new Paragraph({ children: [new PageBreak()] })); return; }
    if (el.classList && el.classList.contains("hx-page-setup")) return;
    if (/^(p|h[1-6])$/.test(tag)) { children.push(paragraphOf(el)); return; }
    if (tag === "ul" || tag === "ol") { children.push(...listItems(el, 0)); return; }
    if (tag === "table") { const t = tableOf(el); if (t) children.push(t); return; }
    if (tag === "hr") { children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] })); return; }
    if (tag === "blockquote") { for (const c of el.childNodes) if (c.nodeType === 1 && /^(P|H[1-6])$/.test(c.tagName)) children.push(paragraphOf(c, { indent: { left: 720 } })); return; }
    if (tag === "div" || tag === "section" || tag === "article") { for (const c of el.childNodes) block(c); return; }
    // An inline element at the top level: wrap it.
    children.push(new Paragraph({ children: runsOf(el) }));
  };
  for (const c of root.childNodes) block(c);
  if (!children.length) children.push(new Paragraph({ children: [] }));

  // ── page setup, header and footer ──────────────────────────────────
  const ps = pageSetup || {};
  const px = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d) * PX_TO_TWIPS;
  const slotRuns = (text) => {
    const out = [];
    String(text || "").split("\n").forEach((line, i) => {
      const parts = line.split("{page}");
      const children = [];
      parts.forEach((p, j) => { if (j > 0) children.push(PageNumber.CURRENT); if (p) children.push(p); });
      out.push(new TextRun({ children, break: i > 0 ? 1 : undefined, size: Math.round(defaultSizePt * 2), font: defaultFont }));
    });
    return out;
  };
  const furniture = (left, right) => new Paragraph({ tabStops: [{ type: docx.TabStopType.RIGHT, position: px(ps.pageWidth, 816) - px(ps.marginLeft, 96) - px(ps.marginRight, 96) }], children: [...slotRuns(left), new TextRun({ children: [new Tab()] }), ...slotRuns(right)] });
  const headers = { default: new Header({ children: [furniture(ps.headerLeft, ps.headerRight)] }) };
  const footers = { default: new Footer({ children: [furniture(ps.footerLeft, ps.footerRight === undefined ? "Page {page}" : ps.footerRight)] }) };
  if (ps.firstPageDifferent) {
    headers.first = new Header({ children: [furniture(ps.firstHeaderLeft, ps.firstHeaderRight)] });
    footers.first = new Footer({ children: [furniture(ps.firstFooterLeft, ps.firstFooterRight)] });
  }

  const document = new Document({
    title,
    creator: "Housify",
    styles: { default: { document: { run: { font: defaultFont, size: Math.round(defaultSizePt * 2) } } } },
    numbering: { config: numbering },
    sections: [{
      properties: {
        page: {
          size: { width: px(ps.pageWidth, 816), height: px(ps.pageHeight, 1056) },
          margin: { top: px(ps.marginTop, 96), bottom: px(ps.marginBottom, 96), left: px(ps.marginLeft, 96), right: px(ps.marginRight, 96), header: px(ps.headerDistance, 48), footer: px(ps.footerDistance, 48) },
        },
        titlePage: !!ps.firstPageDifferent,
      },
      headers, footers,
      children,
    }],
  });
  return Packer.toBlob(document);
}

export const docxFileName = (name) => (String(name || "document").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "document") + ".docx";
