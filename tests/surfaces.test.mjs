// One recipe per kind of surface.
//
// The app had fourteen ways to draw what is conceptually the same thing --
// a panel with content in it. By count: rounded-xl border-neutral-200 (47),
// rounded-3xl shadow-card (47), rounded-3xl border-brand-50 (39),
// rounded-xl shadow-sm (21), rounded-xl border-brand-100 (21),
// rounded-xl border-neutral-100 (12), and more. Three radii and three
// border colours, picked ad hoc, for the same object. The Card component
// existed and eleven places used it.
//
// This pins the outcome: the shared recipe is defined in ui.js, and no
// component reintroduces one of the retired spellings. It does NOT forbid
// every hand-written surface -- a danger banner, a dashed drop zone and a
// colour-coded status panel are all genuinely different things and are
// meant to look different.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

const ui = readFileSync(path.join(ROOT, "src/ui.js"), "utf8");
assert("ui.js defines the SURFACE recipes", /export const SURFACE = \{/.test(ui));
for (const k of ["card", "raised", "inset", "overlay"]) {
  assert(`SURFACE.${k} is defined`, new RegExp(`\\n\\s+${k}:`).test(ui));
}
assert("Card renders from SURFACE", /SURFACE\[variant\] \|\| SURFACE\.card/.test(ui));

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js") && !p.endsWith("ui.js")) files.push(p);
  }
})(path.join(ROOT, "src"));

// The spellings that were folded away. Any of these reappearing means a
// new component went back to inventing its own card.
const RETIRED = [
  "rounded-3xl shadow-card",
  "rounded-3xl border border-brand-50",
  "rounded-xl border border-brand-100",
  "rounded-xl border border-neutral-100",
  "rounded-xl border border-subtle-100",
  "rounded-xl border border-subtle-200",
  "rounded-2xl border border-brand-100",
  "rounded-2xl border border-neutral-200",
  "rounded-2xl shadow-xl",
];
for (const recipe of RETIRED) {
  const hits = files.filter(f => readFileSync(f, "utf8").includes(recipe))
    .map(f => path.relative(ROOT, f));
  assert(`"${recipe}" stays retired`, hits.length === 0,
    `reappeared in: ${hits.join(", ")}`);
}

// ---- elevation -------------------------------------------------------
// Two levels, not five. The app used Tailwind's stock sm/md/lg/xl/2xl --
// five guesses at the two states that exist: a surface at rest and
// something floating above the page. 61 shadow-sm sat alongside 70
// shadow-card for the same kind of card.
const SHADOWS = files.flatMap(f =>
  [...readFileSync(f, "utf8").matchAll(/\bshadow-(sm|md|lg|xl|2xl|card|pop)\b/g)].map(m => m[1]));
const offScale = [...new Set(SHADOWS.filter(s => !["card", "pop"].includes(s)))];
assert("elevation uses only the two declared levels", offScale.length === 0,
  `off-scale shadows still in use: ${offScale.map(s => "shadow-" + s).join(", ")}`);
const ui2 = readFileSync(path.join(ROOT, "src/index.css"), "utf8");
for (const t of ["--shadow-card", "--shadow-pop"]) {
  assert(`${t} is declared once`, (ui2.match(new RegExp(t + ":", "g")) || []).length === 1,
    "declared twice means the later one wins and editing the documented value does nothing");
}

// And the shared recipe really is shared, rather than everything having
// drifted somewhere new.
const shared = files.reduce((n, f) =>
  n + (readFileSync(f, "utf8").match(/rounded-xl border border-neutral-200/g) || []).length, 0);
assert("the shared card recipe is widely used", shared > 150, `only ${shared} uses`);
console.log(`      (${shared} uses of the shared card recipe)`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// ---- filter controls must not claim a whole row ----------------------
// Select applies w-full unless its className carries a width or the
// `filter` prop is set. In a stacked label wrapper that is correct. Sitting
// INLINE in a flex row -- after a <span> or a non-block <label> -- it makes
// the control take the entire line, which is how two Bank Transactions
// filters ended up occupying two full-width rows for about 150px of
// content each.
//
// Matches the inline shape only: a span or inline label immediately
// followed by a Select, inside a flex container. Stacked wrappers are left
// alone deliberately; "fixing" those would make them shrink oddly.
{
  const files = fs.readdirSync(path.join(SRC, "components")).filter(f => f.endsWith(".js"));
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, "components", f), "utf8");
    const lines = src.split("\n");
    for (let i = 1; i < lines.length; i++) {
      if (!/<Select(\s|$)/.test(lines[i])) continue;
      const tag = lines[i] + " " + (lines[i + 1] || "");
      const seg = tag.split("<Select")[1] || "";
      if (/\bw-(\d|full|auto|\[)/.test(seg) || /^\s*filter[\s/>]/.test(seg)) continue;
      const prev = lines[i - 1];
      // Inline label or span on the line before, and not a block label
      // (block means a stacked wrapper, where full width is right).
      const inlineLabel = /<span[^>]*>[^<]*:\s*<\/span>|<label(?![^>]*\bblock\b)[^>]*>/.test(prev);
      const ctx = lines.slice(Math.max(0, i - 5), i).join(" ");
      const inRow = /className="[^"]*\bflex\b[^"]*\bgap-/.test(ctx) && !/flex-col/.test(ctx);
      if (inlineLabel && inRow) offenders.push(`${f}:${i + 1}`);
    }
  }
  assert("no Select sits inline in a filter row without a width or `filter`",
    offenders.length === 0, offenders.join(", "));
}
