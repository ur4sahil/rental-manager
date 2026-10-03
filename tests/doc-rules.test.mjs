// The word-processor rules behind the document editor (docRules.js):
// indents, the Tab key, numbering styles, Word's numbering, checkboxes and
// the layout pass.
import fs from "fs";
import { lengthToInches, inchesToCss, stepIndent, tabKeyAction, ORDERED_STYLES, BULLET_STYLES, nextListStyle, toRoman, toAlpha, listMarker, bulletGlyph, wordNumbering, isCheckboxChar, toggleCheckbox, checkboxValue, pageBreakHeight, keepWithNextPush, wideMarker, isOrderedStyle } from "../src/utils/docRules.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); } };
const read = (f) => fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");

// ── lengths and indents
ok("CSS lengths read as inches", lengthToInches("0.5in") === 0.5 && lengthToInches("36pt") === 0.5 && lengthToInches("48px") === 0.5 && Math.abs(lengthToInches("2.54cm") - 1) < 1e-9 && lengthToInches("") === 0 && lengthToInches(null) === 0 && lengthToInches("abc") === 0);
ok("inches write back as the editor stores them; zero means no attribute", inchesToCss(0.5) === "0.5in" && inchesToCss(0) === null && inchesToCss(0.0001) === null && inchesToCss(-0.25) === "-0.25in");
ok("one step is half an inch, from nothing or from a value in any unit", stepIndent(null, 0.5) === "0.5in" && stepIndent("0.5in", 0.5) === "1in" && stepIndent("36pt", 0.5) === "1in" && stepIndent("1in", -0.5) === "0.5in");
ok("stepping back below zero stops at zero, and forward stops at the limit", stepIndent("0.25in", -0.5) === null && stepIndent("4.9in", 0.5) === "5in");

// ── the Tab key
ok("in a table the table decides", tabKeyAction({ inTable: true, inList: true }) === "none");
ok("in a list Tab nests and Shift+Tab un-nests", tabKeyAction({ inList: true }) === "sink" && tabKeyAction({ inList: true, shift: true }) === "lift");
ok("at the start of a paragraph Tab is a first-line indent", tabKeyAction({ atParagraphStart: true }) === "indent-first");
ok("elsewhere Tab is a tab character", tabKeyAction({ atParagraphStart: false }) === "insert-tab" && tabKeyAction({}) === "insert-tab");
ok("Shift+Tab takes the first-line indent back first, then the left indent, then nothing", tabKeyAction({ shift: true, firstLineIn: 0.5, leftIn: 1 }) === "outdent-first" && tabKeyAction({ shift: true, firstLineIn: 0, leftIn: 1 }) === "outdent" && tabKeyAction({ shift: true }) === "none");

// ── numbering
ok("nine numbering styles and four bullets, each with a label", ORDERED_STYLES.length === 9 && ORDERED_STYLES.every(s => s.key && s.label) && BULLET_STYLES.length === 4);
ok("roman numerals", toRoman(1) === "i" && toRoman(4) === "iv" && toRoman(9) === "ix" && toRoman(14) === "xiv" && toRoman(40) === "xl" && toRoman(1999) === "mcmxcix" && toRoman(0) === "0");
ok("letters run a..z then aa, as Word counts", toAlpha(1) === "a" && toAlpha(26) === "z" && toAlpha(27) === "aa" && toAlpha(52) === "zz" && toAlpha(53) === "aaa");
ok("each style's marker", listMarker("decimal", 3) === "3." && listMarker("lower-alpha", 2) === "b." && listMarker("upper-alpha", 2) === "B." && listMarker("lower-roman", 4) === "iv." && listMarker("upper-roman", 4) === "IV." && listMarker("paren-decimal", 7) === "(7)" && listMarker("paren-alpha", 3) === "(c)" && listMarker("paren-roman", 2) === "(ii)");
ok("clause numbering carries the parents", listMarker("clause", 2, [1]) === "1.2" && listMarker("clause", 3, [12, 4]) === "12.4.3" && listMarker("clause", 1) === "1");
ok("an unknown style or a bad number falls back sanely", listMarker("nonsense", 2) === "2." && listMarker(null, 0) === "1." && listMarker("decimal", "x") === "1.");
ok("nesting a list steps down Word's legal sequence: 1. -> (a) -> (i) -> 1.", nextListStyle("decimal") === "paren-alpha" && nextListStyle("paren-alpha") === "paren-roman" && nextListStyle("paren-roman") === "decimal" && nextListStyle("lower-alpha") === "paren-roman" && nextListStyle(null) === "paren-alpha" && nextListStyle("clause") === "clause");
ok("wider markers get the deeper hang; plain ones do not", wideMarker("paren-alpha") && wideMarker("lower-roman") && wideMarker("clause") && !wideMarker("decimal") && !wideMarker("lower-alpha"));
ok("bullet glyphs", bulletGlyph("disc") === "\u25CF" && bulletGlyph("dash") === "\u2013" && bulletGlyph("nope") === "\u25CF");
ok("only known styles are accepted", isOrderedStyle("paren-roman") && !isOrderedStyle("roman") && !isOrderedStyle(null));

// ── Word's numbering definitions
ok("Word formats map to our styles", wordNumbering("decimal", "%1.").style === "decimal" && wordNumbering("lowerLetter", "%1.").style === "lower-alpha" && wordNumbering("lowerLetter", "(%1)").style === "paren-alpha" && wordNumbering("lowerLetter", "%1)").style === "paren-alpha" && wordNumbering("lowerRoman", "(%1)").style === "paren-roman" && wordNumbering("upperRoman", "%1.").style === "upper-roman" && wordNumbering("decimal", "(%1)").style === "paren-decimal");
ok("multi-level patterns are clauses", wordNumbering("decimal", "%1.%2").style === "clause" && wordNumbering("decimal", "%1.%2.%3").style === "clause");
ok("bullets by their glyph", wordNumbering("bullet", "\uF0B7").style === "disc" && wordNumbering("bullet", "o").style === "circle" && wordNumbering("bullet", "-").style === "dash" && wordNumbering("bullet", "\u25AA").style === "square" && wordNumbering("bullet").kind === "bullet");
ok("an unknown format is plain numbering", wordNumbering("cardinalText", "%1").style === "decimal" && wordNumbering(undefined).kind === "ordered");

// ── checkboxes
ok("a checkbox is a character that toggles", isCheckboxChar("\u2610") && isCheckboxChar("\u2612") && isCheckboxChar("\u2611") && !isCheckboxChar("x") && toggleCheckbox("\u2610") === "\u2612" && toggleCheckbox("\u2612") === "\u2610");
ok("a checkbox field fills from yes/no words", checkboxValue(true) === "\u2612" && checkboxValue("yes") === "\u2612" && checkboxValue("X") === "\u2612" && checkboxValue("no") === "\u2610" && checkboxValue("") === "\u2610" && checkboxValue(null) === "\u2610");

// ── the layout pass
const breaks = [[1000, 1100], [2100, 2200]];
ok("a page break stretches to the foot of its page", pageBreakHeight(600, breaks) === 500 && pageBreakHeight(1500, breaks) === 700);
ok("a page break that is already first on a page takes no room (no blank page)", pageBreakHeight(1100, breaks) === 0 && pageBreakHeight(1101, breaks) === 0 && pageBreakHeight(2199, breaks) === 0);
ok("a page break after the last gap, or with no pages, takes none", pageBreakHeight(2500, breaks) === 0 && pageBreakHeight(100, []) === 0 && pageBreakHeight(100, null) === 0);
ok("keep-with-next: a heading at the foot of a page with its text on the next is pushed over", keepWithNextPush(950, 990, 1120, breaks) === 150);
ok("keep-with-next: nothing when both sit on one page, or the next block is not below", keepWithNextPush(500, 540, 560, breaks) === 0 && keepWithNextPush(500, 540, 520, breaks) === 0 && keepWithNextPush(1150, 1190, 1210, breaks) === 0);

// ── wiring
const kit = read("src/utils/docKit.js"), css = read("src/index.css"), imp = read("src/utils/docxImport.js"), pdf = read("src/utils/pagedPdf.js"), rte = read("src/components/RichTextEditor.js");
ok("spaces and tabs are kept when a document is loaded (the signature page's spacing)", /preserveWhitespace: true/.test(kit) && /parseOptions: PARSE_OPTIONS/.test(rte) && /parseOptions: PARSE_OPTIONS/.test(pdf) && /parseOptions: PARSE_OPTIONS/.test(read("src/components/Documents.js")));
ok("a typed tab is inserted as text, never parsed as HTML", /tr\.insertText\("\\t"\)/.test(kit) && !/insertContent\("\\t"\)/.test(kit));
ok("Word tabs stay tabs on import, and tab stops are every half inch", !/\\u2003\\u2003/.test(imp) && /tab-size: 48px/.test(css));
ok("the Tab key handler wins over the browser's focus move", /Tab: act\(false\), "Shift-Tab": act\(true\)/.test(kit) && /priority: 1000/.test(kit));
ok("numbering styles live on the list element for the CSS, the PDF and the import alike", /"data-list-style"/.test(kit) && /data-list-style="paren-alpha"/.test(css) && /listMarker\(style, itemNumber\(li\), parents\)/.test(pdf) && /setAttribute\("data-list-style", extra\.list\.style\)/.test(imp));
ok("keep-with-next and page breaks come in from Word", /keepNext/.test(imp) && /w:pageBreakBefore/.test(imp) && /data-page-break/.test(imp) && /"data-keep-next"/.test(kit));
ok("the layout pass only runs on real pages", /\.\.\.\(paged \? \[LayoutFixups\] : \[\]\)/.test(kit));
ok("checkboxes, highlights and bullet shapes are drawn in the PDF, not sent as glyphs the fonts lack", /type: "box"/.test(pdf) && /type: "fill"/.test(pdf) && /type: "ring"/.test(pdf) && /isCheckboxChar/.test(pdf));
ok("the toolbar offers indent, outdent, colours, highlight, super/subscript, strike, paragraph, lists, table, checkbox, page break and find", ["outdent()", "indent()", "setColor(c)", "setBackgroundColor(c)", "toggleSuperscript()", "toggleSubscript()", "toggleStrike()", "setParagraphFormat(", "setListStyle(o.key)", "setBullet(b.key)", "restartListAt(1)", "continueList()", "mergeCells()", "setTableBorders(", "insertCheckbox()", "insertPageBreak()", "setSearch(", "replaceAll("].every(s => rte.includes(s)));
ok("the ruler draws from the page setup and drags the paragraph's indents", /export function Ruler\(/.test(rte) && /setParagraphFormat\(attrs\)/.test(rte) && /<Ruler editor=\{editor\} setup=\{setup\} zoom=\{zoom\} onSetupChange=\{onPageSetupChange\} \/>/.test(rte));
ok("the vertical ruler drags the page margins and header/footer distances, snapped and clamped", /export function VRuler\(/.test(rte) && /snapPageSetup\(d\.key/.test(rte) && ["headerDistance", "marginTop", "marginBottom", "footerDistance"].every(k => rte.includes(`handle("${k}"`)) && /onSetupChange\(\{ \[d\.key\]: d\.value \}\)/.test(rte));

// ── the PDF renderer's sheet pitch ──────────────────────────────────
// A different first-page footer moves the first page gap's TOP (the gap
// starts where the footer starts) but not its BOTTOM (the next page's
// content start). Measured from the tops, a one-line footer difference
// became the pitch for every page and the text drifted a line further
// down on each successive page (found 2026-10-03, initials-e2e).
{
  const pdf = read("src/utils/pagedPdf.js");
  const i = pdf.indexOf("const pitch = breakers.length > 1");
  const chain = pdf.slice(i, i + 200);
  ok("pagedPdf measures the sheet pitch between gap BOTTOMS, not tops", i > 0 && /gapBottom\(breakers\[1\]\) - gapBottom\(breakers\[0\]\)/.test(chain));
  ok("gapBottom reads the gap's bottom edge", /getBoundingClientRect\(\)\.bottom/.test(pdf.slice(i - 400, i)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
