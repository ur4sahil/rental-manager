// Read a utility statement's OWN figures -- bill date, billing period, total
// due and due date -- from the statement PDF itself.
//
// Why: a utility bill row stores the account's CURRENT balance (what the
// portal says is owed today; $0 once paid, negative when in credit). The
// statement filed with it is a document from a specific date with its own
// total, and showing the balance beside it mislabelled it (WSSC 4747 River
// Valley: statement "Bill Date 07/13/26, Total Due $805.37" was listed as
// "2026-08 · $-1.00"). These fields let the Statements list describe the
// statement as the statement describes itself.
//
// Parsing is best effort and conservative: a field that is not found is null,
// never guessed. Patterns cover the four portals Housy reads (Pepco, BGE,
// Washington Gas, WSSC) and the generic wording they share.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const NUM_DATE = String.raw`\d{1,2}\/\d{1,2}\/\d{2,4}`;
const TXT_DATE = String.raw`(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}`;
const DATE = `(?:${NUM_DATE}|${TXT_DATE})`;
const MONEY = String.raw`(-\s?\$\s?[\d,]+\.\d{2}|\$\s?-?\s?[\d,]+\.\d{2})`;

// "07/13/26" | "9/2/2026" | "Sep 15, 2026" | "October 6, 2026" -> "YYYY-MM-DD"
function toIsoDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = Number(m[3]); if (y < 100) y += 2000;
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  m = t.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    const d = Number(m[2]);
    if (!mo || d < 1 || d > 31) return null;
    return `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

function toMoney(s) {
  if (!s) return null;
  const neg = /-/.test(s);
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Typographic minus/dash before an amount reads as "-" (WSSC prints "−$1.00").
function normalise(text) {
  return String(text || "")
    .replace(/[−‒–—﹣－](?=\s?\$)/g, "-")
    .replace(/\s+/g, " ")
    // pdfjs splits some glyph runs: "08/1 1/26" for 08/11/26, "$1 17.54" for
    // $117.54 (WSSC). Rejoin digits split inside a date or an amount.
    .replace(/(\d)\s(?=\d\/)/g, "$1")
    .replace(/(\/\d)\s(?=\d\b)/g, "$1")
    .replace(/(\$[\d,]*\d)\s(?=\d[\d,]*\.\d{2}\b)/g, "$1");
}

function firstMatch(text, patterns) {
  for (const re of patterns) { const m = text.match(re); if (m) return m; }
  return null;
}

function statementFields(rawText) {
  const text = normalise(rawText);
  const out = { bill_date: null, period_start: null, period_end: null, total_due: null, due_date: null };
  if (!text.trim()) return out;

  // Billing period, labelled (Pepco "SERVICE FROM 8/4/26 TO 9/1/26" / "Billing
  // Period: Aug 4, 2026 to Sep 1, 2026", BGE "Billing Period: Aug 13, 2026 -
  // Sep 15, 2026", WG "Invoice Period: Aug 14, 2026-Sep 10, 2026").
  const per = firstMatch(text, [
    new RegExp(`(?:billing period|bill period|invoice period|service period|service from)\\s*:?\\s*(${DATE})\\s*(?:-|to|through)\\s*(${DATE})`, "i"),
  ]);
  if (per) { out.period_start = toIsoDate(per[1]); out.period_end = toIsoDate(per[2]); }

  // Bill date, labelled (Pepco "Issued 9/2/26", BGE "Issued Date: September
  // 15, 2026", WG "Invoice Date: September 14, 2026", WSSC "Bill Date").
  const bd = firstMatch(text, [
    new RegExp(`(?:bill date|issued date|issue date|invoice date|statement date|billing date)\\s*:?\\s*(${DATE})`, "i"),
    new RegExp(`\\bissued\\s*:?\\s*(${DATE})`, "i"),
  ]);
  if (bd) out.bill_date = toIsoDate(bd[1]);

  // WSSC lays its header out as labels first, values after: "Bill Date Bill
  // Period ... 07/13/26 04/08/26-07/11/26". The period is the one "date-date"
  // run with no space; the bill date is the date right before it.
  // Same header as pdfjs orders it: "05/01/26-08/01/26 92 Days 08/03/26".
  if (!out.period_start || !out.bill_date) {
    const w2 = text.match(new RegExp(`(${NUM_DATE})-(${NUM_DATE})\\s+\\d+\\s+Days\\s+(${NUM_DATE})`, "i"));
    if (w2) {
      if (!out.period_start) { out.period_start = toIsoDate(w2[1]); out.period_end = toIsoDate(w2[2]); }
      out.bill_date = out.bill_date || toIsoDate(w2[3]);
    }
  }
  if (!out.period_start || !out.bill_date) {
    const w = text.match(new RegExp(`(${NUM_DATE})\\s+(${NUM_DATE})-(${NUM_DATE})`));
    if (w) {
      out.bill_date = out.bill_date || toIsoDate(w[1]);
      if (!out.period_start) { out.period_start = toIsoDate(w[2]); out.period_end = toIsoDate(w[3]); }
    }
  }

  // Total due, most specific wording first. "Please pay $43.60 by October 6,
  // 2026" (WG) also carries the due date.
  const pp = text.match(new RegExp(`please pay\\s*${MONEY}\\s*by\\s*(${DATE})`, "i"));
  if (pp) { out.total_due = toMoney(pp[1]); out.due_date = toIsoDate(pp[2]); }
  if (out.total_due == null) {
    const t = firstMatch(text, [
      new RegExp(`total amount due by\\s*(${DATE})\\s*${MONEY}`, "i"),
      new RegExp(`total amount due\\s*:?\\s*${MONEY}`, "i"),
      // A statement in credit: BGE "No Amount Due - Credit Balance -$484.35".
      new RegExp(`credit balance\\s*:?\\s*${MONEY}`, "i"),
      // WSSC stub: "Due 09/02/26 $395.78" (date, then the total).
      new RegExp(`\\bdue\\s+(${NUM_DATE})\\s*${MONEY}`, "i"),
      new RegExp(`\\btotal due\\s*:?\\s*${MONEY}`, "i"),
      new RegExp(`\\bamount due\\s*:?\\s*${MONEY}`, "i"),
    ]);
    if (t) {
      if (t.length === 3) { out.due_date = out.due_date || toIsoDate(t[1]); out.total_due = toMoney(t[2]); }
      else out.total_due = toMoney(t[1]);
    }
  }

  // Due date (Pepco "Due Date 9/23/26", WG "Due date Oct 06, 2026", WSSC
  // "Due 09/02/26").
  if (!out.due_date) {
    const d = firstMatch(text, [
      new RegExp(`due date\\s*:?\\s*(${DATE})`, "i"),
      new RegExp(`\\bdue\\s*(?:by|on)?\\s*:?\\s*(${DATE})`, "i"),
    ]);
    if (d) out.due_date = toIsoDate(d[1]);
  }
  return out;
}

// Text of the first few pages, via pdfjs (already an app dependency). pdfjs v5
// is ESM-only, so it is loaded with a dynamic import from this CommonJS file.
async function pdfText(buf, maxPages = 3) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const parts = [];
  for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    parts.push(tc.items.map(it => (it.str || "") + (it.hasEOL ? "\n" : " ")).join(""));
  }
  await doc.destroy().catch(() => {});
  return parts.join("\n");
}

module.exports = { statementFields, pdfText, toIsoDate };
