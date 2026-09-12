// Every table's columns, footers and sortable headers, pinned.
//
// Phase 1 moved 62 hand-rolled tables onto the shared DataTable using a
// tool that lifts <td> bodies verbatim. Verbatim is not complete, and
// three losses got past review, a clean build, eslint and the whole unit
// suite:
//
//   * Tenants.js came out with ONE column -- the select-all checkbox. Its
//     other seven headers were <SortTh> components rather than literal
//     <th>, so the tool never saw them and lifted only the first <td>.
//   * Ten Accounting report TOTAL rows were <tfoot> elements, which the
//     tool does not read. AR Aging, AP Aging, Trial Balance, Security
//     Deposits, Owner Distributions and five more rendered with no total.
//   * The journal entry form lost its remove-line column outright, so
//     there was no way to delete a line.
//
// Each still rendered a tidy table, which is why nothing caught them.
// An aggregate "no column was lost" check cannot catch them either: the
// pre-migration source could not see a <SortTh> header, so there was no
// honest number to compare against. (The first version of this test did
// exactly that, and passed when a column was deleted to check it.)
//
// So the shape is pinned instead. Any column, footer or sortable header
// that disappears fails here. Adding or renaming one is fine -- re-baseline
// with `node table-snapshot.mjs --write` and the fixture diff goes into
// the review, which is the point.
import { readFileSync } from "node:fs";
import { snapshot, FIXTURE } from "./table-snapshot.mjs";

let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

const want = JSON.parse(readFileSync(FIXTURE, "utf8"));
const got = snapshot();

for (const file of Object.keys(want)) {
  const w = want[file], g = got[file];
  if (!g) { assert(`${file}: still has tables`, false, "file has no tables at all now"); continue; }

  assert(`${file}: table count`, g.dataTables.length === w.dataTables.length,
    `${w.dataTables.length} DataTables expected, ${g.dataTables.length} found`);

  const n = Math.min(w.dataTables.length, g.dataTables.length);
  for (let i = 0; i < n; i++) {
    const a = w.dataTables[i], b = g.dataTables[i];
    const missing = a.keys.filter(k => !b.keys.includes(k));
    assert(`${file} table ${i}: keeps its columns`, missing.length === 0,
      `dropped: ${missing.join(", ")}  (had ${a.keys.join(", ")})`);
    assert(`${file} table ${i}: keeps its total row`, !(a.footer && !b.footer),
      `footer "${a.footer}" is gone`);
    if (a.footer && b.footer) {
      assert(`${file} table ${i}: total row still says "${a.footer}"`, a.footer === b.footer,
        `was "${a.footer}", now "${b.footer}"`);
    }
    const lost = (a.behaviour || []).filter(k => !(b.behaviour || []).includes(k));
    assert(`${file} table ${i}: keeps its row behaviour`, lost.length === 0,
      `no longer set: ${lost.join(", ")}`);
    const unsortable = (a.sortable || []).filter(k => !(b.sortable || []).includes(k));
    assert(`${file} table ${i}: keeps its sortable headers`, unsortable.length === 0,
      `no longer sortable: ${unsortable.join(", ")}`);
  }

  for (let i = 0; i < w.printTables.length; i++) {
    const a = w.printTables[i], b = g.printTables[i];
    if (!b) { assert(`${file} printTable ${i}: still present`, false); continue; }
    const missing = a.labels.filter(l => !b.labels.includes(l));
    assert(`${file} printTable ${i}: keeps its columns`, missing.length === 0,
      `dropped: ${missing.join(", ")}`);
    assert(`${file} printTable ${i}: keeps its total row`, !(a.footer && !b.footer),
      `footer "${a.footer}" is gone`);
  }
}

// The JE line editor specifically: keyboard navigation finds a row by index
// through a DOM attribute, and the flat migration dropped it.
const acct = readFileSync(new URL("../src/components/Accounting.js", import.meta.url), "utf8");
assert("JE lines carry data-je-line for keyboard navigation",
  /rowAttrs=\{\(line, i\) => \(\{ "data-je-line": i \}\)\}/.test(acct));
assert("JE lines have a remove-line control", /removeLine\(i\)/.test(acct));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
