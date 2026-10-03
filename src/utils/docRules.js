// Word-processor rules the document editor follows: indents, the Tab key,
// list numbering styles and how Word's own numbering maps onto them.
// Pure: no editor, no DOM. The editor (docKit.js), the PDF renderer
// (pagedPdf.js), the Word import (docxImport.js) and the CSS all use these
// same tables, so a "(a)" in the editor is a "(a)" on paper.

export const INDENT_STEP_IN = 0.5;      // Word's Increase Indent and default tab stop
export const MAX_INDENT_IN = 5;
const PX_PER_IN = 96, PT_PER_IN = 72, CM_PER_IN = 2.54;

/** A CSS length -> inches. Unknown or empty -> 0. */
export function lengthToInches(css) {
  const m = String(css ?? "").trim().match(/^(-?\d*\.?\d+)\s*(in|pt|px|cm|mm|em|rem)?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] || "px").toLowerCase()) {
    case "in": return n;
    case "pt": return n / PT_PER_IN;
    case "cm": return n / CM_PER_IN;
    case "mm": return n / CM_PER_IN / 10;
    case "em": case "rem": return (n * 16) / PX_PER_IN;
    default: return n / PX_PER_IN;
  }
}
/** Inches -> the CSS the editor stores ("0.5in"); null when zero, so the attribute is dropped. */
export function inchesToCss(n) {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return Math.abs(v) < 0.0005 ? null : `${v}in`;
}
/**
 * One indent step from a current CSS length. Clamped to [min, max] inches.
 * Returns the new CSS value (null = none).
 */
export function stepIndent(current, delta, { min = 0, max = MAX_INDENT_IN } = {}) {
  const now = lengthToInches(current);
  const next = Math.min(max, Math.max(min, Math.round((now + delta) * 1000) / 1000));
  return inchesToCss(next);
}

/**
 * What the Tab key does. Word's habits:
 * - in a list, Tab nests the item and Shift+Tab un-nests it;
 * - at the start of a paragraph, Tab sets a first-line indent (another
 *   press, another half inch), Shift+Tab takes it back, then the left indent;
 * - anywhere else, Tab is a tab character (default stops every half inch).
 * Inside a table the table's own Tab (next cell) wins.
 */
export function tabKeyAction({ shift = false, inTable = false, inList = false, atParagraphStart = false, firstLineIn = 0, leftIn = 0 } = {}) {
  if (inTable) return "none";
  if (inList) return shift ? "lift" : "sink";
  if (!shift) return atParagraphStart ? "indent-first" : "insert-tab";
  if (firstLineIn > 0) return "outdent-first";
  if (leftIn > 0) return "outdent";
  return "none";
}

// ── lists ─────────────────────────────────────────────────────────────
export const ORDERED_STYLES = [
  { key: "decimal", label: "1. 2. 3." },
  { key: "lower-alpha", label: "a. b. c." },
  { key: "upper-alpha", label: "A. B. C." },
  { key: "lower-roman", label: "i. ii. iii." },
  { key: "upper-roman", label: "I. II. III." },
  { key: "paren-decimal", label: "(1) (2) (3)" },
  { key: "paren-alpha", label: "(a) (b) (c)" },
  { key: "paren-roman", label: "(i) (ii) (iii)" },
  { key: "clause", label: "1.1  1.2  1.3" },
];
export const BULLET_STYLES = [
  { key: "disc", label: "•  round" },
  { key: "circle", label: "◦  hollow" },
  { key: "dash", label: "–  dash" },
  { key: "square", label: "▪  square" },
];
export const DEFAULT_ORDERED_STYLE = "decimal";
export const DEFAULT_BULLET = "disc";
const ORDERED_KEYS = new Set(ORDERED_STYLES.map(s => s.key));
const BULLET_KEYS = new Set(BULLET_STYLES.map(s => s.key));
export const isOrderedStyle = (k) => ORDERED_KEYS.has(k);
export const isBulletStyle = (k) => BULLET_KEYS.has(k);
/** Styles whose markers are wider than "9." and need a deeper hang. */
export const wideMarker = (style) => /^paren-|roman$|^clause$/.test(String(style || ""));

/** Nesting a list one level: the style Word's legal numbering uses next. */
export function nextListStyle(parentStyle) {
  switch (parentStyle || DEFAULT_ORDERED_STYLE) {
    case "decimal": case "paren-decimal": return "paren-alpha";
    case "lower-alpha": case "paren-alpha": case "upper-alpha": return "paren-roman";
    case "lower-roman": case "paren-roman": case "upper-roman": return "decimal";
    case "clause": return "clause";
    default: return "paren-alpha";
  }
}

export function toRoman(n) {
  let v = Math.floor(Number(n) || 0);
  if (v <= 0 || v >= 4000) return String(v);
  const t = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [k, s] of t) while (v >= k) { out += s; v -= k; }
  return out;
}
/** 1 -> a, 26 -> z, 27 -> aa (as Word counts). */
export function toAlpha(n) {
  let v = Math.floor(Number(n) || 0);
  if (v <= 0) return String(v);
  const letter = String.fromCharCode(96 + ((v - 1) % 26) + 1);
  return letter.repeat(Math.floor((v - 1) / 26) + 1);
}

/**
 * The marker text for item `n` of a list in `style`. `parents` are the
 * numbers of the enclosing numbered lists (for "1.2.3").
 */
export function listMarker(style, n, parents = []) {
  const num = Math.max(1, Math.floor(Number(n) || 1));
  switch (style || DEFAULT_ORDERED_STYLE) {
    case "lower-alpha": return toAlpha(num) + ".";
    case "upper-alpha": return toAlpha(num).toUpperCase() + ".";
    case "lower-roman": return toRoman(num) + ".";
    case "upper-roman": return toRoman(num).toUpperCase() + ".";
    case "paren-decimal": return "(" + num + ")";
    case "paren-alpha": return "(" + toAlpha(num) + ")";
    case "paren-roman": return "(" + toRoman(num) + ")";
    case "clause": return [...(parents || []), num].join(".");
    default: return num + ".";
  }
}
export const bulletGlyph = (b) => ({ disc: "●", circle: "◦", dash: "–", square: "▪" }[b] || "●");

/**
 * Word's numbering definition -> our style. numFmt is w:numFmt (decimal,
 * lowerLetter, upperLetter, lowerRoman, upperRoman, bullet); lvlText is
 * the pattern ("%1.", "(%1)", "%1)", "%1.%2"). Unknown -> decimal.
 */
export function wordNumbering(numFmt, lvlText = "") {
  const fmt = String(numFmt || "").trim();
  const pat = String(lvlText || "").trim();
  if (fmt === "bullet") {
    if (/[o◦○]/.test(pat)) return { kind: "bullet", style: "circle" };
    if (/[-–—]/.test(pat)) return { kind: "bullet", style: "dash" };
    if (/[▪■◼❑]/.test(pat)) return { kind: "bullet", style: "square" };
    return { kind: "bullet", style: "disc" };
  }
  const paren = /^\(%\d\)$/.test(pat) || /^%\d\)$/.test(pat);
  if (/%\d\.%\d/.test(pat)) return { kind: "ordered", style: "clause" };
  switch (fmt) {
    case "lowerLetter": return { kind: "ordered", style: paren ? "paren-alpha" : "lower-alpha" };
    case "upperLetter": return { kind: "ordered", style: paren ? "paren-alpha" : "upper-alpha" };
    case "lowerRoman": return { kind: "ordered", style: paren ? "paren-roman" : "lower-roman" };
    case "upperRoman": return { kind: "ordered", style: paren ? "paren-roman" : "upper-roman" };
    default: return { kind: "ordered", style: paren ? "paren-decimal" : "decimal" };
  }
}

// ── checkboxes in text ───────────────────────────────────────────────
// A checkbox is a character, so it survives every sanitizer and the merge
// (a checkbox FIELD fills in as one of these). The PDF draws it as a box.
export const CHECKBOX_OFF = "☐", CHECKBOX_ON = "☒";
export const isCheckboxChar = (ch) => ch === CHECKBOX_OFF || ch === CHECKBOX_ON || ch === "☑";
export const toggleCheckbox = (ch) => (ch === CHECKBOX_OFF ? CHECKBOX_ON : CHECKBOX_OFF);
export const checkboxValue = (v) => (v === true || /^(true|yes|on|1|x|checked)$/i.test(String(v ?? "").trim()) || v === CHECKBOX_ON ? CHECKBOX_ON : CHECKBOX_OFF);

// ── page geometry helpers for the layout pass ────────────────────────
/**
 * Where a forced page break's spacer must end. `top` is the spacer's own
 * top; `breaks` are the [top, bottom] of each page-gap float after it, in
 * order. A break sitting at the very start of a page (its top within
 * `tolerance` of a gap's bottom) takes no room: a blank page would be worse.
 * Returns the spacer height in px.
 */
export function pageBreakHeight(top, breaks, tolerance = 2) {
  if (!Array.isArray(breaks) || !breaks.length) return 0;
  for (const [bTop, bBottom] of breaks) {
    if (Math.abs(bBottom - top) <= tolerance) return 0;
    if (bTop >= top) return Math.max(0, bBottom - top);
  }
  return 0;
}
/**
 * Keep-with-next: block B ends at `bottom`, the next block's first line
 * starts at `nextTop`. If a page gap [gTop, gBottom] lies between them, B
 * is pushed to the next page: returns the push in px (0 = none).
 */
export function keepWithNextPush(top, bottom, nextTop, breaks) {
  if (!Array.isArray(breaks) || !(nextTop > bottom)) return 0;
  for (const [gTop, gBottom] of breaks) {
    if (gTop >= bottom - 0.5 && gBottom <= nextTop + 0.5) return Math.max(0, gBottom - top);
    if (gTop > nextTop) break;
  }
  return 0;
}
