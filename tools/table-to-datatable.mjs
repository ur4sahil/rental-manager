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
  headers = [...block.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
    .map(m => m[1].trim())
    .filter(h => !/\.map\(|=>/.test(h));   // never a code fragment
}

// Cells: walk the tbody and split on <td ...> ... </td> with tag depth, so
// a <td> containing another element's ">" does not end it early.
const tbody = block.slice(block.indexOf("<tbody"), block.lastIndexOf("</tbody>"));

// The row variable, taken from the .map() that built the rows. Guessing
// "r" meant every lifted body referenced an undefined name.
const rowVar = (/\.map\(\s*\(?\s*([A-Za-z_$][\w$]*)/.exec(tbody) || [, "row"])[1];
// The array being mapped, so the rows={} prop is filled in rather than
// left as a comment for someone to guess at.
const rowsExpr = (/\{\s*([A-Za-z_$][\w$.?\[\]]*)\s*\.map\(/.exec(tbody) || [, "rows"])[1];
const cells = [];
const re = /<td([^>]*)>/g;
let m;
while ((m = re.exec(tbody))) {
  const attrs = m[1];
  let i = re.lastIndex, d = 1;
  while (i < tbody.length && d > 0) {
    if (tbody.startsWith("<td", i)) { d++; i += 3; continue; }
    if (tbody.startsWith("</td>", i)) { d--; if (!d) break; i += 5; continue; }
    i++;
  }
  cells.push({ attrs, body: tbody.slice(re.lastIndex, i).trim() });
  re.lastIndex = i;
  if (cells.length >= headers.length) break;   // first row is the template
}

const align = (attrs) => (/text-right/.test(attrs) ? ', align: "right"' : /text-center/.test(attrs) ? ', align: "center"' : "");
const cls = (attrs) => {
  // Keep only classes that are not padding or alignment -- DataTable owns
  // those, and carrying them through would reintroduce the 24 densities.
  const c = (/className="([^"]*)"/.exec(attrs) || [, ""])[1]
    .split(/\s+/).filter(x => x && !/^(px|py|p)-/.test(x) && !/^text-(left|right|center)$/.test(x));
  return c.length ? `, className: "${c.join(" ")}"` : "";
};
const key = (h, i) => (h || `col${i}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || `col${i}`;

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
  console.log(`      render: ${rowVar} => (${wrapped}) },`);
});
console.log("  ]}");
console.log(`  rows={${rowsExpr}}`);
console.log(`  rowKey={${rowVar} => ${rowVar}.id}`);
console.log('  empty="Nothing to show"');
console.log("/>");
console.log(`\n// lifted from ${file}:${startLine + 1}-${endLine + 1}`);
console.log(`// row variable "${rowVar}", rows from "${rowsExpr}" -- both read from the source.`);
console.log(`// STILL CHECK BY HAND: column keys, whether any cell needs align:"right",`);
console.log(`// and any per-row variable computed above the <tr> (e.g. a status chip),`);
console.log(`// which has to move inside the render that uses it.`);
