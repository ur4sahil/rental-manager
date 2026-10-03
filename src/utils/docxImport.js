// Word (.docx) -> HTML that keeps the look of the page.
//
// mammoth is deliberately semantic: it keeps headings, lists, bold and
// tables, and throws away everything Word calls "direct formatting" --
// alignment, indents, line spacing, fonts and sizes. For a lease that is
// most of what makes it look like the document that was uploaded, so
// this wraps mammoth and carries that formatting across as inline styles
// the editor understands (see ParagraphFormat in RichTextEditor.js).
//
// How it travels: mammoth has no way to attach attributes to its output,
// so each paragraph and run is tagged with a private-use marker in its
// TEXT, and the markers are swapped for style attributes once the HTML
// exists. Line spacing is not in mammoth's model at all, so it is read
// straight from the document XML and matched to paragraphs by order --
// verified by comparing text, and dropped to the document default if the
// two ever disagree, so a mismatch costs fidelity, never correctness.

import { wordNumbering } from "./docRules";

const LIST_INDENT_TWIPS = 720; // the editor's list indent, 0.5in
const OPEN = "\uE000";
const CLOSE = "\uE001";

// Word's "single" spacing is the font's natural line height, about 1.15x
// the font size for Times/Arial-class faces. CSS line-height is a plain
// multiple of the font size, so a Word multiple needs this factor or a
// double-spaced lease comes out ~13% short and loses pages.
export const WORD_SINGLE_LINE = 1.15;

const TWIPS_PER_INCH = 1440;
const inches = (twips) => +(Number(twips) / TWIPS_PER_INCH).toFixed(3) + "in";
const points = (twips) => +(Number(twips) / 20).toFixed(2) + "pt";

const SERIF = /times|liberation serif|georgia|garamond|cambria|palatino|book antiqua|baskerville|century|serif/i;
const MONO = /courier|consolas|mono|menlo/i;
// "Liberation Serif Regular" -> "Liberation Serif"; then a stack that
// lands on a metric-compatible face when the named one isn't installed.
export function fontStack(name) {
  const clean = String(name || "").replace(/\s+(regular|bold|italic|regula)\b.*$/i, "").replace(/['"]/g, "").trim();
  if (!clean) return "";
  if (MONO.test(clean)) return `'${clean}', 'Courier New', monospace`;
  if (/sans/i.test(clean) && !/liberation serif/i.test(clean)) return `'${clean}', Arial, Helvetica, sans-serif`;
  if (SERIF.test(clean)) return `'${clean}', 'Times New Roman', Times, serif`;
  return `'${clean}', Arial, Helvetica, sans-serif`;
}

function parseXml(text) {
  if (!text) return null;
  const doc = new DOMParser().parseFromString(text, "application/xml");
  return doc.getElementsByTagName("parsererror").length ? null : doc;
}
const child = (el, name) => {
  if (!el) return null;
  for (const c of el.children) if (c.tagName === name) return c;
  return null;
};
const attr = (el, name) => (el ? el.getAttribute(name) : null);

// Paragraph properties off a <w:pPr>, only the ones present.
function readPPr(pPr) {
  const out = {};
  if (!pPr) return out;
  const sp = child(pPr, "w:spacing");
  if (sp) {
    if (attr(sp, "w:line") != null) { out.line = Number(attr(sp, "w:line")); out.lineRule = attr(sp, "w:lineRule") || "auto"; }
    if (attr(sp, "w:before") != null) out.before = Number(attr(sp, "w:before"));
    if (attr(sp, "w:after") != null) out.after = Number(attr(sp, "w:after"));
  }
  const ind = child(pPr, "w:ind");
  if (ind) {
    const left = attr(ind, "w:left") ?? attr(ind, "w:start");
    const right = attr(ind, "w:right") ?? attr(ind, "w:end");
    if (left != null) out.left = Number(left);
    if (right != null) out.right = Number(right);
    if (attr(ind, "w:firstLine") != null) out.firstLine = Number(attr(ind, "w:firstLine"));
    if (attr(ind, "w:hanging") != null) out.hanging = Number(attr(ind, "w:hanging"));
  }
  const jc = child(pPr, "w:jc");
  if (jc) out.jc = attr(jc, "w:val");
  if (child(pPr, "w:keepNext")) out.keepNext = attr(child(pPr, "w:keepNext"), "w:val") !== "0";
  if (child(pPr, "w:pageBreakBefore")) out.pageBreakBefore = attr(child(pPr, "w:pageBreakBefore"), "w:val") !== "0";
  const numPr = child(pPr, "w:numPr");
  if (numPr) {
    const numId = attr(child(numPr, "w:numId"), "w:val"), ilvl = attr(child(numPr, "w:ilvl"), "w:val");
    if (numId != null) { out.numId = String(numId); out.ilvl = Number(ilvl || 0); }
  }
  return out;
}

// numbering.xml -> numId + level -> the numbering style (docRules). Word
// keeps the definitions apart from the paragraphs: a paragraph names a
// numId and a level, the numId names an abstract definition, and that
// holds the format ("lowerLetter") and the pattern ("(%1)") per level.
function readNumbering(numDoc) {
  const out = {};
  if (!numDoc) return out;
  const abstract = {};
  for (const a of numDoc.getElementsByTagName("w:abstractNum")) {
    const id = attr(a, "w:abstractNumId");
    abstract[id] = {};
    for (const lvl of a.getElementsByTagName("w:lvl")) {
      abstract[id][Number(attr(lvl, "w:ilvl") || 0)] = wordNumbering(attr(child(lvl, "w:numFmt"), "w:val"), attr(child(lvl, "w:lvlText"), "w:val"));
    }
  }
  for (const n of numDoc.getElementsByTagName("w:num")) {
    const id = attr(n, "w:numId"), abs = attr(child(n, "w:abstractNumId"), "w:val");
    out[id] = { ...(abstract[abs] || {}) };
    for (const o of n.getElementsByTagName("w:lvlOverride")) {
      const lvl = child(o, "w:lvl");
      if (lvl) out[id][Number(attr(o, "w:ilvl") || 0)] = wordNumbering(attr(child(lvl, "w:numFmt"), "w:val"), attr(child(lvl, "w:lvlText"), "w:val"));
    }
  }
  return out;
}

// styles.xml -> what a paragraph inherits when it says nothing itself.
function readStyles(stylesDoc, themeDoc) {
  const res = { byId: {}, defaultParagraphStyle: null, docDefaults: {}, fontSize: 11, font: "" };
  if (!stylesDoc) return res;
  const dd = stylesDoc.getElementsByTagName("w:docDefaults")[0];
  const readRPr = (rPr) => {
    if (!rPr) return;
    const sz = child(rPr, "w:sz");
    if (sz && attr(sz, "w:val")) res.fontSize = Number(attr(sz, "w:val")) / 2;
    const rf = child(rPr, "w:rFonts");
    if (rf) {
      if (attr(rf, "w:ascii")) res.font = attr(rf, "w:ascii");
      else if (attr(rf, "w:asciiTheme") && themeDoc) {
        const group = /major/i.test(attr(rf, "w:asciiTheme")) ? "a:majorFont" : "a:minorFont";
        const latin = themeDoc.getElementsByTagName(group)[0]?.getElementsByTagName("a:latin")[0];
        if (latin && attr(latin, "typeface")) res.font = attr(latin, "typeface");
      }
    }
  };
  if (dd) {
    res.docDefaults = readPPr(child(child(dd, "w:pPrDefault"), "w:pPr"));
    readRPr(child(child(dd, "w:rPrDefault"), "w:rPr"));
  }
  for (const st of stylesDoc.getElementsByTagName("w:style")) {
    if (attr(st, "w:type") !== "paragraph") continue;
    const id = attr(st, "w:styleId");
    res.byId[id] = { basedOn: attr(child(st, "w:basedOn"), "w:val"), props: readPPr(child(st, "w:pPr")) };
    if (attr(st, "w:default") === "1") { res.defaultParagraphStyle = id; readRPr(child(st, "w:rPr")); }
  }
  return res;
}

function resolveParagraph(pEl, styles) {
  const pPr = child(pEl, "w:pPr");
  const chain = [readPPr(pPr)];
  let id = attr(child(pPr, "w:pStyle"), "w:val") || styles.defaultParagraphStyle;
  for (let guard = 0; id && styles.byId[id] && guard < 20; guard++) {
    chain.push(styles.byId[id].props);
    id = styles.byId[id].basedOn;
  }
  chain.push(styles.docDefaults);
  // Nearest definition wins, per property.
  return chain.reduceRight((acc, p) => Object.assign(acc, p), {});
}

const ALIGN = { both: "justify", distribute: "justify", center: "center", right: "right", end: "right", left: "left", start: "left" };

function paragraphCss(p) {
  const css = [];
  if (p.jc && ALIGN[p.jc] && ALIGN[p.jc] !== "left") css.push("text-align:" + ALIGN[p.jc]);
  if (p.line != null) {
    css.push("line-height:" + (p.lineRule === "auto"
      ? +((p.line / 240) * WORD_SINGLE_LINE).toFixed(3)
      : points(p.line)));
  }
  if (p.hanging) css.push("text-indent:-" + inches(p.hanging));
  else if (p.firstLine) css.push("text-indent:" + inches(p.firstLine));
  if (p.left) css.push("margin-left:" + inches(p.left));
  if (p.right) css.push("margin-right:" + inches(p.right));
  css.push("margin-top:" + points(p.before || 0));
  css.push("margin-bottom:" + points(p.after || 0));
  return css.join(";");
}

const plainText = (node) => {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  return (node.children || []).map(plainText).join("");
};
const fingerprint = (s) => String(s || "").replace(/\s+/g, "").slice(0, 24);

const markerRun = (value) => ({
  type: "run", children: [{ type: "text", value }], styleId: null, styleName: null,
  isBold: false, isUnderline: false, isItalic: false, isStrikethrough: false, isAllCaps: false, isSmallCaps: false,
  verticalAlignment: "baseline", font: null, fontSize: null, highlight: null,
});

/**
 * @param {ArrayBuffer} arrayBuffer the .docx file
 * @returns {Promise<{ html: string, warnings: number, footer: { left: string, right: string }, page: object|null }>}
 */
export async function convertDocxToHtml(arrayBuffer) {
  const mammothMod = await import("mammoth");
  const mammoth = mammothMod.default || mammothMod;
  const JSZip = (await import("jszip")).default;

  // -- Read what mammoth won't: spacing, inherited styles, footer text.
  let styles = readStyles(null, null);
  let xmlParagraphs = [];
  let numbering = {};
  let footer = { left: "", right: "" };
  let page = null;
  let mammothInput = arrayBuffer;
  try {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const read = async (path) => (zip.file(path) ? zip.file(path).async("string") : "");
    // Zoho Writer exports a soft line break as <w:br w:type="line"/>. The
    // spec only knows page/column/textWrapping, so mammoth warns
    // "unsupported break type" and drops it -- two sentences that sat on
    // separate lines arrive glued together. Rewrite it as a plain <w:br/>
    // and hand mammoth the corrected file.
    const rawDoc = await read("word/document.xml");
    if (/<w:br\b[^>]*w:type="line"/.test(rawDoc)) {
      zip.file("word/document.xml", rawDoc.replace(/<w:br\b[^>]*w:type="line"[^>]*\/>/g, "<w:br/>"));
      mammothInput = await zip.generateAsync({ type: "arraybuffer" });
    }
    const themeDoc = parseXml(await read("word/theme/theme1.xml"));
    styles = readStyles(parseXml(await read("word/styles.xml")), themeDoc);
    numbering = readNumbering(parseXml(await read("word/numbering.xml")));
    const docXml = parseXml(rawDoc);
    if (docXml) {
      xmlParagraphs = Array.from(docXml.getElementsByTagName("w:p")).map((p) => {
        // A page break is a run-level <w:br w:type="page"/>: before the
        // paragraph's text it breaks before, after it breaks after.
        let breakBefore = false, breakAfter = false, seenText = false;
        for (const n of p.getElementsByTagName("*")) {
          if (n.tagName === "w:t" && n.textContent) seenText = true;
          else if (n.tagName === "w:br" && attr(n, "w:type") === "page") { if (seenText) breakAfter = true; else breakBefore = true; }
        }
        return {
          props: resolveParagraph(p, styles), breakBefore, breakAfter,
          text: fingerprint(Array.from(p.getElementsByTagName("w:t")).map((t) => t.textContent).join("")),
        };
      });
    }
    // Page size and margins, in CSS px (twips / 15). The bottom margin and
    // the footer's distance from the edge decide how many lines fit on a
    // page, so without these a 16-page lease drifts from Word by page 7.
    const sect = docXml ? Array.from(docXml.getElementsByTagName("w:sectPr")).pop() : null;
    const pgSz = child(sect, "w:pgSz"), pgMar = child(sect, "w:pgMar");
    const px = (el, name) => (attr(el, name) != null ? Math.round(Number(attr(el, name)) / 15) : null);
    if (pgSz && pgMar) {
      page = {
        pageWidth: px(pgSz, "w:w"), pageHeight: px(pgSz, "w:h"),
        marginTop: px(pgMar, "w:top"), marginBottom: px(pgMar, "w:bottom"),
        marginLeft: px(pgMar, "w:left"), marginRight: px(pgMar, "w:right"),
        headerDistance: px(pgMar, "w:header"), footerDistance: px(pgMar, "w:footer"),
      };
      if (Object.values(page).some((v) => v == null || !(v >= 0))) page = null;
    }
    const footerPath = Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n)).sort()[0];
    const footerXml = footerPath ? parseXml(await read(footerPath)) : null;
    if (footerXml) {
      // A footer line like "_______ <tabs> _____" is two things pushed to
      // opposite edges with tabs. Pages here have a left and a right
      // footer slot, so split each line at the tab/space run and stack
      // the halves: left = "_______\nLandlord", right = "_____\nTenant".
      const left = [], right = [];
      for (const p of footerXml.getElementsByTagName("w:p")) {
        const line = Array.from(p.getElementsByTagName("*"))
          .map((n) => (n.tagName === "w:t" ? n.textContent : n.tagName === "w:tab" ? "\t" : ""))
          .join("");
        const parts = line.split(/(?:\t|\s{3,})+/).map((x) => x.trim()).filter(Boolean);
        if (!parts.length) continue;
        left.push(parts[0]);
        if (parts.length > 1) right.push(parts[parts.length - 1]);
      }
      footer = { left: left.join("\n"), right: right.join("\n") };
    }
  } catch (_e) {
    // Formatting is a bonus on top of the text. A zip we can't read
    // still imports through mammoth below, just plainer.
    xmlParagraphs = [];
  }

  // -- Tag paragraphs and runs while mammoth walks the document.
  const paraCss = [];   // index -> css, filled in after the walk
  const listLeft = [];  // index -> Word's left indent (twips), for list items
  const paraExtra = []; // index -> { keepNext, breakBefore, breakAfter, list }
  const seen = [];      // mammoth paragraphs, in the order it visits them
  const runCss = [];
  const tagRuns = (node, isHeading) => {
    if (!node || !node.children) return node;
    if (node.type === "run") {
      const hasText = node.children.some((c) => c.type === "text" && c.value);
      // A heading keeps the heading's own size unless the run sets one.
      const size = node.fontSize || (isHeading ? null : styles.fontSize);
      const font = fontStack(node.font || (isHeading ? "" : styles.font));
      // Word's highlight is a named colour ("yellow"); CSS knows the names.
      const highlight = node.highlight && /^[a-z]+$/i.test(node.highlight) && node.highlight !== "none" ? node.highlight.toLowerCase() : "";
      const css = [font && "font-family:" + font, size && "font-size:" + size + "pt", highlight && "background-color:" + highlight].filter(Boolean).join(";");
      if (!hasText || !css) return node;
      const i = runCss.push(css) - 1;
      return { ...node, children: [{ type: "text", value: `${OPEN}R${i}${CLOSE}` }, ...node.children, { type: "text", value: `${OPEN}/R${CLOSE}` }] };
    }
    return { ...node, children: node.children.map((c) => tagRuns(c, isHeading)) };
  };
  const transformDocument = mammoth.transforms.paragraph((p) => {
    const i = seen.push({ text: fingerprint(plainText(p)), alignment: p.alignment, indent: p.indent }) - 1;
    const isHeading = /^(heading|title)/i.test(p.styleName || "");
    const tagged = tagRuns(p, isHeading);
    return { ...tagged, children: [markerRun(`${OPEN}P${i}${CLOSE}`), ...tagged.children] };
  });

  const result = await mammoth.convertToHtml(
    { arrayBuffer: mammothInput },
    { styleMap: ["u => u", "r[style-name='Strong'] => strong"], transformDocument, ignoreEmptyParagraphs: false }
  );
  let html = (result && result.value) || "";
  const warnings = ((result && result.messages) || []).filter((m) => m.type === "warning").length;

  // -- Per-paragraph spacing only if the XML and mammoth agree on what
  // the paragraphs are. Otherwise every paragraph gets the document
  // default, which is still far closer than nothing.
  const aligned = xmlParagraphs.length === seen.length && seen.every((s, i) => s.text === xmlParagraphs[i].text);
  seen.forEach((s, i) => {
    const props = aligned ? xmlParagraphs[i].props : {
      ...styles.docDefaults,
      jc: s.alignment,
      left: s.indent?.start, right: s.indent?.end, firstLine: s.indent?.firstLine, hanging: s.indent?.hanging,
    };
    paraCss[i] = paragraphCss(props);
    listLeft[i] = props.left || 0;
    const x = aligned ? xmlParagraphs[i] : null;
    paraExtra[i] = {
      keepNext: !!props.keepNext,
      breakBefore: !!(x && (x.breakBefore || props.pageBreakBefore)), breakAfter: !!(x && x.breakAfter),
      list: props.numId != null && numbering[props.numId] ? numbering[props.numId][props.ilvl || 0] || null : null,
    };
  });

  // Word lets the spacing under the LAST line of a page hang into the
  // bottom margin: a double-spaced line needs only its single-spaced
  // height to fit. That is why this lease holds 23 lines a page in Word
  // where plain arithmetic (page body / line pitch) says 22. Browsers
  // need the whole line box to fit, so hand the editor the difference
  // for the document's dominant spacing and let it deepen the page by it.
  if (page) {
    const weight = {};
    seen.forEach((sp, i) => {
      const pr = aligned ? xmlParagraphs[i].props : styles.docDefaults;
      const mult = pr.line != null && (pr.lineRule || "auto") === "auto" ? pr.line / 240 : 1;
      weight[mult] = (weight[mult] || 0) + sp.text.length + 1;
    });
    const dominant = Number(Object.keys(weight).sort((a, b) => weight[b] - weight[a])[0] || 1);
    page.lineSlack = +Math.max(0, (dominant - 1) * WORD_SINGLE_LINE * styles.fontSize * (96 / 72)).toFixed(1);
  }

  // -- Swap the markers for real markup.
  const runRe = new RegExp(`${OPEN}R(\\d+)${CLOSE}`, "g");
  html = html.replace(runRe, (_m, i) => `<span style="${runCss[Number(i)]}">`).split(`${OPEN}/R${CLOSE}`).join("</span>");

  const dom = new DOMParser().parseFromString(`<div id="docx-root">${html}</div>`, "text/html");
  const root = dom.getElementById("docx-root");
  const paraRe = new RegExp(`${OPEN}P(\\d+)${CLOSE}`);
  const walker = dom.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (paraRe.test(n.nodeValue)) hits.push(n);
  for (const node of hits) {
    const m = node.nodeValue.match(paraRe);
    node.nodeValue = node.nodeValue.replace(paraRe, "");
    let css = paraCss[Number(m[1])];
    const extra = paraExtra[Number(m[1])] || {};
    let block = node.parentElement?.closest("p,h1,h2,h3,h4,h5,h6,li");
    if (!block || !css) continue;
    if (block.tagName === "LI") {
      // The numbering style Word used for this level, on the list itself
      // (the first item of a list decides; later ones agree).
      const list = block.parentElement;
      if (extra.list && list && /^(OL|UL)$/.test(list.tagName)) {
        if (list.tagName === "OL" && extra.list.kind === "ordered" && !list.hasAttribute("data-list-style")) list.setAttribute("data-list-style", extra.list.style);
        if (list.tagName === "UL" && extra.list.kind === "bullet" && !list.hasAttribute("data-bullet")) list.setAttribute("data-bullet", extra.list.style);
      }
      // In Word a bullet is a hanging indent: the paragraph's left edge
      // and a negative first line make room for the marker. In HTML the
      // list does that itself (index.css: 0.5in indent, marker hanging
      // 0.25in), so keeping them drags the first line back over the bullet.
      // Word's left edge for the text is measured from the page margin;
      // the list here already indents by LIST_INDENT_TWIPS, so store the
      // difference.
      const left = listLeft[Number(m[1])];
      css = css.split(";").filter((d) => !/^(text-indent|margin-left):/.test(d))
        .concat(left != null && left !== LIST_INDENT_TWIPS ? ["margin-left:" + inches(left - LIST_INDENT_TWIPS)] : []).join(";");
      // mammoth writes list text straight into the <li>; the editor keeps
      // paragraph formatting on a <p>, so give the text one.
      const p = dom.createElement("p");
      while (block.firstChild && !/^(UL|OL)$/.test(block.firstChild.nodeName)) p.appendChild(block.firstChild);
      block.insertBefore(p, block.firstChild);
      block = p;
    }
    block.setAttribute("style", css);
    if (extra.keepNext) block.setAttribute("data-keep-next", "1");
    // Forced page breaks become the editor's own page-break block, placed
    // beside the top-level block this paragraph belongs to.
    const top = block.closest("li") ? block.closest("ul,ol") : block;
    if (extra.breakBefore && top && top.parentElement) { const br = dom.createElement("div"); br.setAttribute("data-page-break", ""); top.parentElement.insertBefore(br, top); }
    if (extra.breakAfter && top && top.parentElement) { const br = dom.createElement("div"); br.setAttribute("data-page-break", ""); top.parentElement.insertBefore(br, top.nextSibling); }
  }
  // Word tabs come through as raw \t and stay so: the editor sets tab stops
  // every half inch (index.css tab-size), as Word does by default.
  // Runs that held only a marker leave an empty span behind.
  root.querySelectorAll("span").forEach((s) => { if (!s.textContent && !s.children.length) s.remove(); });

  return { html: root.innerHTML, warnings, footer, page };
}
