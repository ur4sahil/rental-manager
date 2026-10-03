// Adversarial checks on the Word export (src/utils/docxExport.js): the
// generated document.xml must carry what the editor carries. Runs in
// node with jsdom standing in for the browser's DOMParser.
import { JSDOM } from "../node_modules/jsdom/lib/api.js";
import JSZip from "../node_modules/jszip/dist/jszip.min.js";
import * as docx from "../node_modules/docx/dist/index.mjs";
import { htmlToDocx, docxFileName } from "../src/utils/docxExport.js";

const dom = new JSDOM("");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;

let pass = 0, fail = 0;
const assert = (c, m) => { if (c) pass++; else { fail++; console.log("  ✗ " + m); } };

async function build(html, opts) {
  const blob = await htmlToDocx(docx, html, opts);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const read = async (n) => (zip.file(n) ? await zip.file(n).async("string") : "");
  return { doc: await read("word/document.xml"), num: await read("word/numbering.xml"), hdr: (await Promise.all(Object.keys(zip.files).filter(n => /word\/header\d*\.xml/.test(n)).map(read))).join("\n"), ftr: (await Promise.all(Object.keys(zip.files).filter(n => /word\/footer\d*\.xml/.test(n)).map(read))).join("\n"), files: Object.keys(zip.files) };
}

// ── runs ────────────────────────────────────────────────────────────
{
  const { doc } = await build('<p>Plain <strong>bold</strong> <em>it</em> <u>under</u> <s>gone</s> x<sup>2</sup> H<sub>2</sub>O <span style="color:#dc2626">red</span> <mark style="background-color:#fef08a">hi</mark> <span style="font-family:Arial;font-size:14pt">arial</span></p>');
  assert(/<w:b\/>/.test(doc), "bold run");
  assert(/<w:i\/>/.test(doc), "italic run");
  assert(/<w:u w:val="single"\/>/.test(doc), "underline run");
  assert(/<w:strike\/>/.test(doc), "strike run");
  assert(/<w:vertAlign w:val="superscript"\/>/.test(doc), "superscript");
  assert(/<w:vertAlign w:val="subscript"\/>/.test(doc), "subscript");
  assert(/<w:color w:val="DC2626"\/>/.test(doc), "colour run");
  assert(/<w:highlight w:val="yellow"\/>/.test(doc), "highlight run");
  assert(/w:ascii="Arial"/.test(doc), "font run");
  assert(/<w:sz w:val="28"\/>/.test(doc), "14pt -> half-points 28");
}
// ── tabs and whitespace ─────────────────────────────────────────────
{
  const { doc } = await build("<p>Name:\tJohn   Smith</p>");
  assert(/<w:tab\/>/.test(doc), "a tab character becomes w:tab");
  assert(/xml:space="preserve">John   Smith/.test(doc), "run text keeps multiple spaces");
}
// ── paragraph format ────────────────────────────────────────────────
{
  const { doc } = await build('<p style="text-align:justify;margin-left:1in;text-indent:-0.5in;margin-top:12pt;margin-bottom:6pt;line-height:1.5" data-keep-next="1">Hanging</p><p style="text-indent:0.5in;text-align:center">First line</p><h2>Heading</h2>');
  assert(/<w:jc w:val="both"\/>/.test(doc), "justify");
  assert(/<w:ind w:left="1440" w:hanging="720"\/>/.test(doc), "left + hanging indent in twips");
  assert(/<w:ind w:firstLine="720"\/>/.test(doc), "first-line indent");
  assert(/<w:jc w:val="center"\/>/.test(doc), "center");
  assert(/<w:spacing [^>]*w:before="240"/.test(doc), "space before 12pt");
  assert(/<w:spacing [^>]*w:after="120"/.test(doc), "space after 6pt");
  assert(/w:line="313" w:lineRule="auto"/.test(doc), "line height 1.5 (relative to 1.15 base)");
  assert(/<w:keepNext\/>/.test(doc), "keep with next");
  assert(/<w:pStyle w:val="Heading2"\/>/.test(doc), "heading style");
}
// ── lists ───────────────────────────────────────────────────────────
{
  const { doc, num } = await build('<ol data-list-style="paren-alpha" start="3"><li><p>one</p></li><li><p>two</p><ol data-list-style="paren-roman"><li><p>nested</p></li></ol></li></ol><ul data-bullet="dash"><li><p>b</p></li></ul>');
  assert(/<w:numPr>/.test(doc), "numbered paragraphs");
  assert(/<w:numFmt w:val="lowerLetter"\/>/.test(num) && /<w:lvlText w:val="\(%1\)"\/>/.test(num), "(a) style in numbering.xml");
  assert(/<w:start w:val="3"\/>/.test(num), "start at 3");
  assert(/<w:numFmt w:val="lowerRoman"\/>/.test(num), "nested roman list has its own definition");
  assert(/<w:lvlText w:val="–"\/>/.test(num) && /<w:numFmt w:val="bullet"\/>/.test(num), "dash bullet");
  assert((doc.match(/<w:numId w:val="(\d+)"\/>/g) || []).length === 4 && !/numId w:val="2"\/>[\s\S]*numId w:val="2"\/>[\s\S]*numId w:val="2"\/>/.test(doc), "nested item uses its own list instance");
  const defs = (num.match(/<w:abstractNum /g) || []).length;
  assert(defs === 4, "four list definitions (outer, nested, bullet), got " + defs);
}
// ── tables ──────────────────────────────────────────────────────────
{
  const { doc } = await build('<table data-borders="outer"><tbody><tr><th colspan="2"><p>Head</p></th></tr><tr><td><p>a</p></td><td><p>b<br>c</p></td></tr></tbody></table>');
  assert(/<w:tbl>/.test(doc), "table emitted");
  assert(/<w:gridSpan w:val="2"\/>/.test(doc), "colspan");
  assert(/<w:shd [^>]*w:fill="F3F4F6"/.test(doc), "header cell shaded");
  assert(/<w:br\/>/.test(doc), "line break inside a cell");
  assert(/<w:left w:val="nil"|<w:left w:val="none"/.test(doc), "outer borders: inner edge off");
}
// ── page break and page setup ───────────────────────────────────────
{
  const ps = { pageWidth: 816, pageHeight: 1056, marginTop: 96, marginBottom: 96, marginLeft: 144, marginRight: 96, headerLeft: "Lease", headerRight: "", footerLeft: "", footerRight: "Page {page}", firstPageDifferent: true, firstHeaderLeft: "", firstHeaderRight: "", firstFooterLeft: "Initials: ____", firstFooterRight: "" };
  const { doc, hdr, ftr } = await build('<div class="hx-page-setup" title="x"></div><p>a</p><div data-page-break="1"></div><p>b</p>', { pageSetup: ps });
  assert(/<w:br w:type="page"\/>/.test(doc), "forced page break");
  assert(/<w:pgSz w:w="12240" w:h="15840"/.test(doc), "letter page size in twips");
  assert(/<w:pgMar [^>]*w:left="2160"/.test(doc), "1.5in left margin");
  assert(/<w:titlePg\/>/.test(doc), "different first page flag");
  assert(/Lease/.test(hdr), "header text");
  assert(/<w:fldChar w:fldCharType="begin"\/>|PAGE/.test(ftr), "footer page number field");
  assert(/Initials: ____/.test(ftr), "first-page footer");
  assert(/w:type="first"/.test(doc), "first-page header/footer referenced");
}
// ── hostile input ───────────────────────────────────────────────────
{
  const { doc } = await build("");
  assert(/<w:body>/.test(doc), "empty body still yields a document");
  const r = await build('<p style="margin-left:junk;font-size:abc">x</p><ul></ul><table></table><p><span style="color:rgb(0, 128, 0)">g</span></p>');
  assert(/<w:color w:val="008000"\/>/.test(r.doc), "rgb() colour");
  assert(!/NaN/.test(r.doc), "no NaN from junk lengths");
}
assert(docxFileName("Lease: Joe / 2026") === "Lease_Joe_2026.docx", "file name sanitised");
assert(docxFileName("") === "document.docx", "empty name");

console.log(`docx-export: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
