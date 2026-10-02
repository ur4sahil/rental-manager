// Adversarial tests for the document field maths (src/utils/docFields.js):
// the numbers and words a lease prints without anyone typing them. A wrong
// answer here is a wrong rent on a signed lease, so the cases below go for
// the edges -- month ends, leap years, the 1st, formatted currency input,
// cents, and garbage.
import fs from "fs";
import path from "path";
const src = fs.readFileSync(path.join(import.meta.dirname, "../src/utils/docFields.js"), "utf8");
const m = await import("data:text/javascript," + encodeURIComponent(src));
const { toNumber, toDate, integerToWords, formatValue, evaluateFormula, deriveValues } = m;

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; console.log(`❌ ${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`); }
};

// --- numbers out of whatever was typed or prefilled
eq("formatted currency", toNumber("$2,700.00"), 2700);
eq("plain", toNumber("1500"), 1500);
eq("cents", toNumber("822.58"), 822.58);
eq("empty", toNumber(""), 0);
eq("garbage", toNumber("abc"), 0);
eq("undefined", toNumber(undefined), 0);
eq("negative", toNumber("-50"), -50);

// --- dates are LOCAL (new Date('2026-10-15') is the 14th in Maryland)
eq("iso date day", toDate("2026-10-15").getDate(), 15);
eq("iso date month", toDate("2026-10-15").getMonth(), 9);
eq("us date", toDate("10/15/2026").getDate(), 15);
eq("bad date", toDate("soon"), null);
eq("empty date", toDate(""), null);

// --- words
eq("0", integerToWords(0), "Zero");
eq("12", integerToWords(12), "Twelve");
eq("21", integerToWords(21), "Twenty-One");
eq("75", integerToWords(75), "Seventy-Five");
eq("100", integerToWords(100), "One Hundred");
eq("1500", integerToWords(1500), "One Thousand Five Hundred");
eq("2700", integerToWords(2700), "Two Thousand Seven Hundred");
eq("33570", integerToWords(33570), "Thirty-Three Thousand Five Hundred Seventy");
eq("19447", integerToWords(19447), "Nineteen Thousand Four Hundred Forty-Seven");
eq("1000000", integerToWords(1000000), "One Million");
eq("1000001", integerToWords(1000001), "One Million One");
eq("words drop cents", integerToWords("2700.99"), "Two Thousand Seven Hundred");

// --- formats
eq("ordinal 1", formatValue("2026-10-01", "day_ordinal"), "1st");
eq("ordinal 2", formatValue("2026-10-02", "day_ordinal"), "2nd");
eq("ordinal 3", formatValue("2026-10-03", "day_ordinal"), "3rd");
eq("ordinal 11", formatValue("2026-10-11", "day_ordinal"), "11th");
eq("ordinal 12", formatValue("2026-10-12", "day_ordinal"), "12th");
eq("ordinal 13", formatValue("2026-10-13", "day_ordinal"), "13th");
eq("ordinal 21", formatValue("2026-10-21", "day_ordinal"), "21st");
eq("ordinal 22", formatValue("2026-10-22", "day_ordinal"), "22nd");
eq("ordinal 23", formatValue("2026-10-23", "day_ordinal"), "23rd");
eq("ordinal 31", formatValue("2026-10-31", "day_ordinal"), "31st");
eq("month", formatValue("2026-10-15", "month_name"), "October");
eq("year", formatValue("2026-10-15", "year"), "2026");
eq("dd-mmm-yyyy", formatValue("2026-04-08", "date_dd_mmm_yyyy"), "08-Apr-2026");
eq("month end oct", formatValue("2026-10-15", "month_end"), "31-Oct-2026");
eq("month end feb leap", formatValue("2028-02-10", "month_end"), "29-Feb-2028");
eq("month end feb", formatValue("2027-02-10", "month_end"), "28-Feb-2027");
eq("month end dec", formatValue("2026-12-31", "month_end"), "31-Dec-2026");
eq("words whole", formatValue("$2,700.00", "words_whole"), "Two Thousand Seven Hundred");
eq("words with cents", formatValue(822.58, "words"), "Eight Hundred Twenty-Two and 58/100");
eq("words no cents", formatValue(1170, "words"), "One Thousand One Hundred Seventy");
eq("cents 00", formatValue(2700, "cents"), "00");
eq("cents 58", formatValue(822.58, "cents"), "58");
eq("cents 05", formatValue(10.05, "cents"), "05");
eq("amount whole", formatValue("$2,700.00", "amount"), "2700");
eq("amount cents", formatValue(822.58, "amount"), "822.58");
eq("money", formatValue(33570, "money"), "33,570.00");
eq("blank stays blank", formatValue("", "words"), "");
eq("bad date formats blank", formatValue("soon", "month_name"), "");

// --- term in months (the end day counts)
const mb = (a, b) => evaluateFormula("months_between(s, e)", { s: a, e: b });
eq("anniversary lease", mb("2026-04-18", "2027-04-17"), 12);
eq("partial first month + 12", mb("2026-10-15", "2027-10-31"), 12);
eq("calendar year", mb("2026-11-01", "2027-10-31"), 12);
eq("one month", mb("2026-11-01", "2026-11-30"), 1);
eq("six months", mb("2026-01-15", "2026-07-14"), 6);
eq("two years", mb("2026-03-01", "2028-02-29"), 24);
eq("short of a month", mb("2026-10-15", "2026-10-31"), 0);
eq("end before start", mb("2027-01-01", "2026-01-01"), 0);
eq("missing end", mb("2026-01-01", ""), 0);

// --- proration: rent x days left / ACTUAL days in that month
const pr = (rent, d) => evaluateFormula("prorate(r, d)", { r: rent, d });
eq("30-day month", pr(2700, "2026-04-18"), 1170);          // 13/30
eq("31-day month", pr(1500, "2026-10-15"), 822.58);        // 17/31
eq("starts on the 1st", pr(1500, "2026-11-01"), 0);
eq("last day of month", pr(3100, "2026-10-31"), 100);      // 1/31
eq("february", pr(2800, "2027-02-15"), 1400);              // 14/28
eq("leap february", pr(2900, "2028-02-15"), 1500);         // 15/29
eq("formatted rent", pr("$2,700.00", "2026-04-18"), 1170);
eq("no date", pr(2700, ""), 0);

// --- arithmetic and safety
eq("total", evaluateFormula("rent * term + prorated", { rent: "$1,500.00", term: 12, prorated: 822.58 }), 18822.58);
eq("late 5%", evaluateFormula("rent * 0.05", { rent: 1500 }), 75);
eq("divide by zero", evaluateFormula("a / b", { a: 10, b: 0 }), 0);
eq("unknown function", evaluateFormula("steal(a)", { a: 5 }), 0);
eq("no code execution", evaluateFormula("a; process.exit(1)", { a: 1 }), 0);
eq("precedence", evaluateFormula("a + b * c", { a: 1, b: 2, c: 3 }), 7);
eq("parentheses", evaluateFormula("(a + b) * c", { a: 1, b: 2, c: 3 }), 9);

// --- the whole lease, as the template declares it
const fc = {
  calculated: {
    // total is declared BEFORE the two things it depends on, on purpose
    total_lease_rent: { formula: "rent_per_month * lease_term_months + prorated_rent" },
    lease_term_months: { formula: "months_between(lease_start_date, lease_end_date)" },
    prorated_rent: { formula: "prorate(rent_per_month, lease_start_date)" },
    late_charge: { formula: "rent_per_month * 0.05" },
  },
  derived: {
    proration_line: { text: "Prorated Amount – {proration_from}–{proration_to} = ${prorated_amount}", blank_when_zero: "prorated_rent" },
    proration_from: { from: "lease_start_date", format: "date_dd_mmm_yyyy" },
    proration_to: { from: "lease_start_date", format: "month_end" },
    prorated_amount: { from: "prorated_rent", format: "amount" },
    term_words: { from: "lease_term_months", format: "words_whole" },
    total_words: { from: "total_lease_rent", format: "words" },
    rent_words: { from: "rent_per_month", format: "words_whole" },
    start_day: { from: "lease_start_date", format: "day_ordinal" },
  },
};
const v = deriveValues({ rent_per_month: "$2,700.00", lease_start_date: "2026-04-18", lease_end_date: "2027-04-17" }, fc);
eq("lease: term", v.lease_term_months, 12);
eq("lease: prorated", v.prorated_rent, 1170);
eq("lease: total (your sample lease: $33,570)", v.total_lease_rent, 33570);
eq("lease: late", v.late_charge, 135);
eq("lease: term words", v.term_words, "Twelve");
eq("lease: total words", v.total_words, "Thirty-Three Thousand Five Hundred Seventy");
eq("lease: rent words", v.rent_words, "Two Thousand Seven Hundred");
eq("lease: start day", v.start_day, "18th");
eq("lease: proration line", v.proration_line, "Prorated Amount – 18-Apr-2026–30-Apr-2026 = $1170");
const v1 = deriveValues({ rent_per_month: 1500, lease_start_date: "2026-11-01", lease_end_date: "2027-10-31" }, fc);
eq("starts on the 1st: no proration line", v1.proration_line, "");
eq("starts on the 1st: total is 12 months", v1.total_lease_rent, 18000);
const v0 = deriveValues({}, fc);
eq("nothing filled in: no crash, zero total", v0.total_lease_rent, 0);
eq("does not mutate its input", (() => { const inp = { rent_per_month: 1 }; deriveValues(inp, fc); return Object.keys(inp).length; })(), 1);

console.log(`\n✅ Passed: ${passed}\n❌ Failed: ${failed}`);
process.exit(failed ? 1 : 0);
