// Shared parser + snapshot writer for table-columns.test.mjs.
// Run `node table-snapshot.mjs --write` to re-baseline after a DELIBERATE
// table change; the diff in the fixture is then part of the review.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const REPO = path.join(import.meta.dirname, "..");
export const FIXTURE = path.join(import.meta.dirname, "fixtures", "table-columns.json");

// Every <DataTable .../>, with its column keys, whether it has a footer,
// and how many footer cells that footer supplies.
export function dataTables(src) {
  const out = [];
  const re = /<DataTable\b/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index, j = i, brace = 0;
    while (j < src.length) {
      const c = src[j];
      if (c === "{") brace++;
      else if (c === "}") brace--;
      else if (brace === 0 && src.startsWith("/>", j)) { j += 2; break; }
      j++;
    }
    const b = src.slice(i, j);
    const keys = [...b.matchAll(/\{\s*key:\s*"([^"]*)"/g)].map(x => x[1]);
    const foot = /\n\s*footer=/.test(b);
    out.push({
      keys,
      // The label of the footer's total row, so a total cannot quietly
      // become a different total.
      footer: foot ? (b.match(/footer=\{\[\{\s*label:\s*"([^"]*)"/) || [null, "(computed)"])[1] : null,
      groups: /\n\s*groups=/.test(b),
      sortable: [...b.matchAll(/\{\s*key:\s*"([^"]*)"[^}]*?sort:\s*(?:true|")/g)].map(x => x[1]),
      // Row-level behaviour, not just columns. The Banking migration kept
      // all eight columns and still lost the row's click handler, its
      // keyboard-cursor ring and its aria-selected -- invisible to a
      // column-only snapshot, and the reason these are pinned too.
      behaviour: ["onRowClick", "rowAttrs", "rowClassName", "expandedRow", "stickyFirstColumn",
                  "stickyLastColumn", "hideHeader", "stickyHeader", "onSort"]
        .filter(k => new RegExp(`\\n\\s*${k}[=\\s]`).test(b)),
    });
    re.lastIndex = j;
  }
  return out;
}

// printTable() calls, with their column labels and footer label.
export function printTables(src) {
  return [...src.matchAll(/printTable\(\{[\s\S]*?\n\s*\}\)/g)].map(x => ({
    labels: [...x[0].matchAll(/\{\s*label:\s*"([^"]*)"/g)].map(y => y[1]),
    footer: (x[0].match(/footer:\s*\[\{\s*label:\s*"([^"]*)"/) || [null, null])[1],
  }));
}

export function snapshot() {
  const dir = path.join(REPO, "src");
  const files = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  walk(dir);
  const out = {};
  for (const f of files.sort()) {
    const src = readFileSync(f, "utf8");
    const dt = dataTables(src), pt = printTables(src);
    if (!dt.length && !pt.length) continue;
    out[path.relative(REPO, f)] = { dataTables: dt, printTables: pt };
  }
  return out;
}

if (process.argv.includes("--write")) {
  writeFileSync(FIXTURE, JSON.stringify(snapshot(), null, 2) + "\n");
  console.log(`wrote ${FIXTURE}`);
}
