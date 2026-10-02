// Field maths for document templates: the values a lease prints that
// nobody should have to type.
//
// A lease states the same few facts many ways -- the rent as "$2700" and
// as "Two Thousand Seven Hundred", the start date as "15th", "October"
// and "2026", the term in months as "12" and "Twelve", plus sums that
// follow from them (prorated first month, total rent, late charge). In a
// form-fed mail merge every one of those is its own box to fill in, and
// they drift apart the moment one is edited. Here a template declares a
// handful of real inputs and derives the rest:
//
//   field_config.calculated  { name: { formula } }       numbers
//   field_config.derived     { name: { from, format } }  text made from a field
//                            { name: { text, blank_when_zero } }  composed text
//
// Pure functions, no React, so they can be tested on their own.

// "$2,700.00" -> 2700. Prefilled currency arrives formatted, and a bare
// parseFloat reads that as NaN.
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// "2026-10-15" (a date input) as a LOCAL date. new Date("2026-10-15") is
// midnight UTC, which is the 14th in Maryland.
export function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ONES = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function under1000(n) {
  const parts = [];
  if (n >= 100) { parts.push(ONES[Math.floor(n / 100)] + " Hundred"); n %= 100; }
  if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : ""));
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(" ");
}
// 33570 -> "Thirty-Three Thousand Five Hundred Seventy"
export function integerToWords(value) {
  let n = Math.floor(Math.abs(toNumber(value)));
  if (n === 0) return "Zero";
  const out = [];
  for (const [size, name] of [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]]) {
    if (n >= size) { out.push(under1000(Math.floor(n / size)) + " " + name); n %= size; }
  }
  if (n > 0) out.push(under1000(n));
  return out.join(" ");
}
const centsOf = (value) => Math.round((Math.abs(toNumber(value)) % 1) * 100) % 100;
const ordinal = (d) => d + (d % 100 >= 11 && d % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][d % 10] || "th");
const pad2 = (n) => String(n).padStart(2, "0");
const ddMmmYyyy = (d) => `${pad2(d.getDate())}-${MONTHS[d.getMonth()].slice(0, 3)}-${d.getFullYear()}`;
const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

// How a derived field shows its source. Listed for the template editor.
export const FIELD_FORMATS = [
  ["day_ordinal", "Day of month (15th)"],
  ["day", "Day of month (15)"],
  ["month_name", "Month (October)"],
  ["year", "Year (2026)"],
  ["date_dd_mmm_yyyy", "Date (15-Oct-2026)"],
  ["date_long", "Date (October 15, 2026)"],
  ["month_end", "Last day of that month (31-Oct-2026)"],
  ["words", "Amount in words, with cents if any"],
  ["words_whole", "Whole dollars in words"],
  ["cents", "Cents (00)"],
  ["amount", "Number (2700 or 822.58)"],
  ["money", "Money (2,700.00)"],
  ["number", "Whole number (12)"],
  ["text", "As typed"],
];

export function formatValue(value, format) {
  if (value === undefined || value === null || value === "") return "";
  switch (format) {
    case "day_ordinal": { const d = toDate(value); return d ? ordinal(d.getDate()) : ""; }
    case "day": { const d = toDate(value); return d ? String(d.getDate()) : ""; }
    case "month_name": { const d = toDate(value); return d ? MONTHS[d.getMonth()] : ""; }
    case "year": { const d = toDate(value); return d ? String(d.getFullYear()) : ""; }
    case "date_dd_mmm_yyyy": { const d = toDate(value); return d ? ddMmmYyyy(d) : ""; }
    case "date_long": { const d = toDate(value); return d ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : ""; }
    case "month_end": { const d = toDate(value); return d ? ddMmmYyyy(new Date(d.getFullYear(), d.getMonth() + 1, 0)) : ""; }
    case "words": { const c = centsOf(value); return integerToWords(value) + (c ? ` and ${pad2(c)}/100` : ""); }
    case "words_whole": return integerToWords(value);
    case "cents": return pad2(centsOf(value));
    case "amount": { const n = toNumber(value); return Number.isInteger(n) ? String(n) : n.toFixed(2); }
    case "money": return toNumber(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "number": return String(Math.round(toNumber(value)));
    default: return String(value);
  }
}

// Functions a formula may call on FIELDS (they need the raw value, a
// date as often as a number, so they run before the arithmetic).
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const FUNCTIONS = {
  // Whole months from start through end, counting the end day itself:
  // 18-Apr-2026 to 17-Apr-2027 is 12, and so is 15-Oct-2026 to
  // 31-Oct-2027 (12 months after a partial first month).
  months_between(values, a, b) {
    const s = toDate(values[a]), e0 = toDate(values[b]);
    if (!s || !e0) return 0;
    const e = new Date(e0.getFullYear(), e0.getMonth(), e0.getDate() + 1);
    const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) - (e.getDate() < s.getDate() ? 1 : 0);
    return Math.max(0, months);
  },
  // Rent for a partial first month: rent x days remaining / days in THAT
  // month. Starting on the 1st is a full month, so nothing is prorated.
  prorate(values, rent, date) {
    const d = toDate(values[date]);
    if (!d || d.getDate() === 1) return 0;
    const dim = daysInMonth(d);
    return round2(toNumber(values[rent]) * (dim - d.getDate() + 1) / dim);
  },
  days_left(values, date) { const d = toDate(values[date]); return d ? daysInMonth(d) - d.getDate() + 1 : 0; },
  days_in_month(values, date) { const d = toDate(values[date]); return d ? daysInMonth(d) : 0; },
};

// Arithmetic over field names, e.g. "rent_per_month * lease_term_months +
// prorated_rent". No eval: a recursive-descent parser over + - * / ( ).
export function evaluateFormula(formula, values) {
  try {
    let expr = String(formula || "").replace(/\b([a-z_]+)\(\s*([a-z0-9_]+)\s*(?:,\s*([a-z0-9_]+)\s*)?\)/gi, (m, fn, a, b) => {
      const f = FUNCTIONS[fn.toLowerCase()];
      return f ? String(f(values, a, b)) : "0";
    });
    expr = expr.replace(/[a-z_][a-z0-9_]*/gi, (m) => String(toNumber(values[m])));
    if (!/^[\d\s+\-*/().]+$/.test(expr)) return 0;
    const tokens = expr.match(/(\d+\.?\d*|\.\d+|[+\-*/()])/g) || [];
    let pos = 0;
    const parseFactor = () => {
      if (tokens[pos] === "(") { pos++; const r = parseExpr(); if (tokens[pos] === ")") pos++; return r; }
      if (tokens[pos] === "-") { pos++; return -parseFactor(); }
      return parseFloat(tokens[pos++]) || 0;
    };
    const parseTerm = () => {
      let result = parseFactor();
      while (pos < tokens.length && (tokens[pos] === "*" || tokens[pos] === "/")) {
        const op = tokens[pos++]; const right = parseFactor();
        result = op === "*" ? result * right : (right !== 0 ? result / right : 0);
      }
      return result;
    };
    function parseExpr() {
      let result = parseTerm();
      while (pos < tokens.length && (tokens[pos] === "+" || tokens[pos] === "-")) {
        const op = tokens[pos++]; const right = parseTerm();
        result = op === "+" ? result + right : result - right;
      }
      return result;
    }
    const out = parseExpr();
    return Number.isFinite(out) ? round2(out) : 0;
  } catch {
    return 0;
  }
}

/**
 * Fill in everything a template derives: calculated numbers, then the
 * text made from them. Returns a new values object.
 */
export function deriveValues(values, fieldConfig) {
  const updated = { ...values };
  const calc = fieldConfig?.calculated || {};
  // Twice: a formula may use another calculated field declared after it
  // (total rent uses the prorated amount), and order in a JSON object is
  // not something a template author should have to think about.
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, cfg] of Object.entries(calc)) updated[name] = evaluateFormula(cfg.formula, updated);
  }
  const derived = fieldConfig?.derived || {};
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, cfg] of Object.entries(derived)) {
      if (cfg.text !== undefined) {
        const blank = cfg.blank_when_zero && toNumber(updated[cfg.blank_when_zero]) === 0;
        updated[name] = blank ? "" : String(cfg.text).replace(/\{(\w+)\}/g, (m, k) => (updated[k] ?? ""));
      } else {
        updated[name] = formatValue(updated[cfg.from], cfg.format);
      }
    }
  }
  return updated;
}
