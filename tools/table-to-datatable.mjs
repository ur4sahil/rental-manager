// Lift a hand-rolled <table> into a DataTable call, taking the cell
// contents VERBATIM from the source.
//
//   node tools/table-to-datatable.mjs src/components/Documents.js 184
//
// Why this exists: every one of the 62 tables has a rich actions cell --
// signed-url fetches, confirm dialogs, credential reveals. Retyping those
// from a terminal view is how the first migration ended up calling a
// function that did not exist. This copies the exact bytes between each
// <td> and its close, so the logic cannot be paraphrased.
//
// It prints a suggestion; it does not edit the file. The column keys,
// alignment and any per-row variables still need a human eye.
import fs from "fs";

const [file, lineArg] = process.argv.slice(2);
if (!file || !lineArg) { console.error("usage: table-to-datatable.mjs <file> <line-of-<table>>"); process.exit(1); }
const src = fs.readFileSync(file, "utf8");
const lines = src.split("\n");
const startLine = Number(lineArg) - 1;
if (!/<table/.test(lines[startLine])) { console.error(`line ${lineArg} is not a <table>: ${lines[startLine].trim().slice(0,60)}`); process.exit(1); }

// Find </table> by tag depth, not by the first match -- nested tables exist.
let depth = 0, endLine = -1;
for (let i = startLine; i < lines.length; i++) {
  depth += (lines[i].match(/<table[ >]/g) || []).length;
  depth -= (lines[i].match(/<\/table>/g) || []).length;
  if (depth === 0) { endLine = i; break; }
}
if (endLine < 0) { console.error("no matching </table>"); process.exit(1); }
const block = lines.slice(startLine, endLine + 1).join("\n");

// Headers: either explicit <th> or a mapped array of strings.
// The MAPPED form is checked first. Several tables build headers as
// ["A","B"].map(h => <th>{h}</th>), and an explicit-<th> regex matches
// that line too -- capturing the whole .map() as a single header, which
// is what the first version of this script did.
let headers = [];
const mapped = /\[((?:\s*"[^"]*",?\s*)+)\]\s*\.map\(/.exec(block);
if (mapped) {
  headers = [...mapped[1].matchAll(/"([^"]*)"/g)].map(m => m[1]);
} else {
  // <th(?=[\s>]) matters: "<thead ...>" also begins with "<th", so a bare
  // /<th[^>]*>/ matched the THEAD tag and captured the first header as
  // '<tr><th className="...">Property'.
  headers = [...block.matchAll(/<th(?=[\s>])[^>]*>([\s\S]*?)<\/th>/g)]
    .map(m => m[1].trim())
    .filter(h => !/\.map\(|=>/.test(h));   // never a code fragment
}

// Cells: walk the tbody and split on <td ...> ... </td> with tag depth, so
// a <td> containing another element's ">" does not end it early.
const tbody = block.slice(block.indexOf("<tbody"), block.lastIndexOf("</tbody>"));

// The row variable, taken from the .map() that built the rows. Guessing
// "r" meant every lifted body referenced an undefined name.
// The map parameter may be DESTRUCTURED -- .map(([vendor, d]) => ...) is
// common for Object.entries() tables -- so capture a bracketed or braced
// pattern as well as a plain identifier. Matching only identifiers made
// the tool fall back to "row" and every lifted body then referenced the
// destructured names, which did not exist.
const rowVar = (/\.map\(\s*\(?\s*(\[[^\]]*\]|\{[^}]*\}|[A-Za-z_$][\w$]*)/.exec(tbody) || [, "row"])[1];
// The array being mapped, so the rows={} prop is filled in rather than
// left as a comment for someone to guess at.
const rowsExpr = (/\{\s*(\(?[A-Za-z_$][^\n]*?\)?)\s*\.map\(/.exec(tbody) || [, "/* rows */"])[1];

// PREAMBLE. Many tables compute per-row values between the .map() and the
// <tr>:
//   {rows.map(r => { const chip = statusChip(r); return (<tr>...
// Those statements are not inside any cell, so lifting only the cells
// left every render referencing an undefined name -- 38 eslint errors
// across 8 tables on the first pass through Accounting.js. Captured here
// and replayed inside each render that needs it, which also keeps every
// cell self-contained.
let preamble = "";
{
  const m = /\.map\(\s*\(?[^)]*\)?\s*=>\s*\{/.exec(tbody);
  if (m) {
    const from = m.index + m[0].length;
    const ret = tbody.indexOf("return", from);
    if (ret > from) {
      const body = tbody.slice(from, ret).trim();
      // Only simple declarations; anything else is left alone rather than
      // replayed blindly.
      if (body && /^(const|let|var)\s/.test(body) && !/\breturn\b/.test(body)) preamble = body;
    }
  }
}
const cells = [];

// Find the end of a <td ...> opening tag, tracking brace depth and
// quotes. A plain /<td([^>]*)>/ stops at the first ">", but JSX
// classNames routinely contain a template literal with a comparison in
// it -- className={`... ${t.balance > 0 ? "x" : ""}`} -- so the tag
// "ended" mid-attribute and the cell body began halfway through an
// expression, producing output that could not compile.
function endOfTag(str, from) {
  let i = from, depth = 0, q = null;
  while (i < str.length) {
    const c = str[i];
    if (q) { if (c === q && str[i - 1] !== "\\") q = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; i++; continue; }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; i++; continue; }
    if (c === ">" && depth === 0) return i;
    i++;
  }
  return -1;
}

let pos = 0;
while (cells.length < headers.length) {
  const open = tbody.indexOf("<td", pos);
  if (open < 0) break;
  if (!/[\s>]/.test(tbody[open + 3] || "")) { pos = open + 3; continue; }
  const tagEnd = endOfTag(tbody, open + 3);
  if (tagEnd < 0) break;
  const attrs = tbody.slice(open + 3, tagEnd);
  // Body ends at the matching </td>, counting nested <td> (none in
  // practice, but a table inside a cell would otherwise break it).
  let i = tagEnd + 1, d = 1;
  while (i < tbody.length && d > 0) {
    if (/^<td[\s>]/.test(tbody.slice(i, i + 4))) { d++; i += 3; continue; }
    if (tbody.startsWith("</td>", i)) { d--; if (!d) break; i += 5; continue; }
    i++;
  }
  cells.push({ attrs, body: tbody.slice(tagEnd + 1, i).trim() });
  pos = i + 5;
}

let ROWVAR = "row";
const align = (attrs) => (/text-right/.test(attrs) ? ', align: "right"' : /text-center/.test(attrs) ? ', align: "center"' : "");
const cls = (attrs) => {
  // A dynamic className -- className={`... ${cond ? "a" : "b"}`} -- is
  // emitted as a FUNCTION so the conditional styling survives. Stripping
  // it to its static parts silently dropped, for example, the red on an
  // overdue balance.
  const dyn = /className=\{(`[\s\S]*?`|[^}]*)\}/.exec(attrs);
  if (dyn) {
    const expr = dyn[1]
      // DataTable owns padding and alignment; carrying them through would
      // reintroduce the 24 densities this exists to remove.
      .replace(/\b(px|py|p)-[0-9.]+\s*/g, "")
      .replace(/\btext-(left|right|center)\s*/g, "");
    return `, className: ${ROWVAR} => (${expr})`;
  }
  // Keep only classes that are not padding or alignment -- DataTable owns
  // those, and carrying them through would reintroduce the 24 densities.
  const c = (/className="([^"]*)"/.exec(attrs) || [, ""])[1]
    .split(/\s+/).filter(x => x && !/^(px|py|p)-/.test(x) && !/^text-(left|right|center)$/.test(x));
  return c.length ? `, className: "${c.join(" ")}"` : "";
};
const key = (h, i) => (h || `col${i}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `col${i}`;

ROWVAR = rowVar;
console.log(`// ${file}:${lineArg}-${endLine + 1}  (${headers.length} columns, ${cells.length} cells lifted)`);
console.log("<DataTable");
console.log("  columns={[");
headers.forEach((h, i) => {
  const c = cells[i];
  const body = c ? c.body : "null";
  const inline = !/\n/.test(body) && body.length < 80;
  console.log(`    { key: "${key(h, i)}", label: ${JSON.stringify(h)}${c ? align(c.attrs) + cls(c.attrs) : ""},`);
  const wrapped = inline
    ? `<>${body}</>`
    : `<>\n        ${body.split("\n").join("\n        ")}\n      </>`;
  // Replay the preamble only in the renders that actually reference one of
  // its names, so unrelated cells stay one-liners.
  const declared = [...preamble.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(x => x[1]);
  const needs = declared.some(nm => new RegExp(`(?<![\\w$.])${nm}(?![\\w$])`).test(body));
  const destructured = /^[[{]/.test(rowVar);
  const idxArg = /(?<![\w$.])i(?![\w$])/.test(body)
    ? `(${rowVar}, i)`
    : (destructured ? `(${rowVar})` : rowVar);
  if (needs) {
    console.log(`      render: ${idxArg} => { ${preamble.replace(/\n\s*/g, " ")} return (${wrapped}); } },`);
  } else {
    console.log(`      render: ${idxArg} => (${wrapped}) },`);
  }
});
console.log("  ]}");
console.log(`  rows={${rowsExpr}}`);
console.log(/^[[{]/.test(rowVar)
  // A destructured row has no .id to key on; the index is the honest
  // choice rather than inventing a key.
  ? "  rowKey={(row, i) => i}"
  : `  rowKey={${rowVar} => ${rowVar}.id}`);
console.log('  empty="Nothing to show"');
console.log("/>");
console.log(`\n// lifted from ${file}:${startLine + 1}-${endLine + 1}`);
console.log(`// row variable "${rowVar}", rows from "${rowsExpr}" -- both read from the source.`);
console.log(`// STILL CHECK BY HAND: column keys, whether any cell needs align:"right",`);
console.log(`// and any per-row variable computed above the <tr> (e.g. a status chip),`);
console.log(`// which has to move inside the render that uses it.`);
