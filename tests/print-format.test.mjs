// Printed tables and the name a printed document is saved under.
//
// Two things went wrong on real output:
//  1. One long description in a ledger squeezed every other column until
//     "2026-01-01" and "JE-6641" broke at their hyphens, on every row.
//  2. Every PDF the app produced was offered as
//     "Housify — Property Management.pdf", whatever it was.
import { printTable, printFileName } from "../src/utils/theme.js";

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (detail ? "\n      " + detail : "")); }
};

// ── printTable
const rows = [{ date: "2026-01-01", desc: "A very long description ".repeat(8), amt: "$1,678.40" }];
const html = printTable({
  columns: [
    { label: "Date", nowrap: true, render: r => r.date },
    { label: "Description", render: r => r.desc },
    { label: "Amount", align: "right", render: r => r.amt },
    { label: "Notes", align: "right", nowrap: false, render: () => "may wrap" },
  ],
  rows, footer: [{ label: "Totals", cells: ["$1,678.40", ""] }], dense: true,
});
const cells = [...html.matchAll(/<td style="([^"]*)">/g)].map(m => m[1]);
const heads = [...html.matchAll(/<th style="([^"]*)">/g)].map(m => m[1]);
ok("every header stays on one line", heads.length === 4 && heads.every(s => s.includes("white-space:nowrap")));
ok("a column marked nowrap does not wrap", cells[0].includes("white-space:nowrap"));
ok("a description column is left free to wrap", !cells[1].includes("white-space"));
ok("an amount (right-aligned) column does not wrap unless told otherwise", cells[2].includes("white-space:nowrap"));
ok("nowrap: false overrides the right-aligned default", !cells[3].includes("white-space"));
ok("footer amounts do not wrap", /<tfoot>.*white-space:nowrap/.test(html));
ok("dense tightens the padding", cells[0].includes("padding:4px 7px") && !html.includes("padding:8px 10px"));
ok("the default padding is unchanged for other tables", printTable({ columns: [{ label: "A", key: "a" }], rows: [{ a: 1 }] }).includes("padding:8px 10px"));
ok("an empty table says so", printTable({ columns: [{ label: "A", key: "a" }], rows: [] }).includes("Nothing to show"));

// ── printFileName
ok("names the report, the period and the company",
  printFileName("Balance Sheet", "As of 2026-10-02", "Sigma Housing LLC") === "Balance Sheet - As of 2026-10-02 - Sigma Housing LLC");
ok("skips empty parts", printFileName("Ledger", "", null, undefined, "2026-01-01 to 2026-10-02") === "Ledger - 2026-01-01 to 2026-10-02");
ok("removes characters a file name cannot hold",
  !/[\\/:*?"<>|]/.test(printFileName('P&L: "Q1/Q2" <draft>', "01/01/2026 | 03/31/2026")), printFileName('P&L: "Q1/Q2" <draft>', "01/01/2026 | 03/31/2026"));
ok("keeps an ampersand and a period readable", printFileName("Profit & Loss", "Budget vs. Actuals") === "Profit & Loss - Budget vs. Actuals");
ok("trims stray separators and spaces", printFileName("  Rent Roll  ", " - ", "2026-10-02 ") === "Rent Roll - 2026-10-02");
ok("is never longer than a file system allows", printFileName("x".repeat(400)).length <= 150);
ok("is empty when there is nothing to name", printFileName() === "" && printFileName("", null) === "");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
