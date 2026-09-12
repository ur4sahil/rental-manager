// Render DataTable and assert its structure.
//
// Why it renders rather than greps: the bug this primitive exists to
// prevent is structural -- a 9-column header over 8-column rows, a footer
// whose total sits under the wrong column, an empty state that spans two
// columns of five. None of that is visible in source; it only appears in
// the markup.
//
// ui.js is JSX, so it is transpiled here at runtime rather than committing
// a build step for one test.
const path = require("path");
const babel = require("@babel/core");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const src = path.join(__dirname, "..", "src", "ui.js");
const { code } = babel.transformFileSync(src, {
  presets: [
    ["@babel/preset-react", { runtime: "classic" }],
    ["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }],
  ],
  configFile: false,
});
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function("module", "exports", "require", code)(mod, mod.exports, require);
const { DataTable } = mod.exports;

const count = (html, tag) => (html.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : (fail++, console.log("  ❌ " + m)); };

const cols = [
  { key: "date", label: "Date" },
  { key: "desc", label: "Description" },
  { key: "dr", label: "Debit", align: "right" },
  { key: "cr", label: "Credit", align: "right" },
];
const rows = [
  { id: 1, date: "2026-09-01", desc: "Rent", dr: "999.00", cr: "" },
  { id: 2, date: "2026-09-05", desc: "Late fee", dr: "50.00", cr: "" },
];
const render = (props) => renderToStaticMarkup(React.createElement(DataTable, props));

let h = render({ columns: cols, rows });
ok(count(h, "th") === 4, `header cells: got ${count(h, "th")}`);
ok(count(h, "tr") === 3, `header + 2 rows: got ${count(h, "tr")}`);
ok(/tnum/.test(h), "right-aligned columns get tabular figures");
ok(/overflow-x-auto/.test(h), "wrapped so the page body never scrolls sideways");

// The empty state must span EVERY column, or the table visibly breaks.
h = render({ columns: cols, rows: [], empty: "No entries" });
ok(/colspan="4"/i.test(h), `empty row spans all columns: saw ${/colspan="(\d+)"/i.exec(h) && RegExp.$1}`);
ok(/No entries/.test(h), "empty message shown");

// A footer gives cells for the LAST n columns; the label spans the rest.
// Callers counting colSpans by hand is how the ledger ended up with a
// header wider than its rows.
h = render({ columns: cols, rows, footer: [{ label: "Totals", cells: ["1,049.00", "0.00"], strong: true }] });
const spans = [...h.matchAll(/colspan="(\d+)"/gi)].map(m => Number(m[1]));
ok(spans.includes(2), `footer label spans 2 of 4: saw ${JSON.stringify(spans)}`);
ok(/1,049\.00/.test(h) && /Totals/.test(h), "footer content rendered");

// Grouped mode: one tbody per account, each with its own subtotal, then a
// grand total -- the shape a combined ledger needs.
h = render({
  columns: cols,
  groups: [
    { key: "a", label: "1000 Checking", rows: [rows[0]], footer: { label: "Total for Checking", cells: ["999.00", "0.00"] } },
    { key: "b", label: "1100 AR", rows: [rows[1]], footer: { label: "Total for AR", cells: ["50.00", "0.00"] } },
  ],
  footer: [{ label: "2 accounts", cells: ["1,049.00", "0.00"], strong: true }],
});
ok(count(h, "tbody") === 3, `2 group bodies + grand total: got ${count(h, "tbody")}`);
ok(/Total for Checking/.test(h) && /Total for AR/.test(h), "per-group subtotals render");
ok(/2 accounts/.test(h), "grand total renders");

h = render({ columns: cols, rows, loading: true });
ok(/Loading/.test(h) && !/Rent</.test(h), "loading replaces rows, never shows stale ones");

h = render({ columns: cols, rows, stickyHeader: true });
ok(/sticky top-0/.test(h), "sticky header applied on request");

// Density is a token in ui.js, not a per-caller guess. Both must differ.
const a = render({ columns: cols, rows, density: "normal" });
const b = render({ columns: cols, rows, density: "compact" });
ok(a !== b, "density changes the rendered padding");

console.log(`\n✅ Passed: ${pass}\n❌ Failed: ${fail}`);
process.exit(fail ? 1 : 0);
