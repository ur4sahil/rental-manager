// The type scale is declared once and nothing may go off it.
//
// The app had no scale at all: Tailwind's defaults plus 115 arbitrary
// sizes -- text-[10px] in 79 places, text-[11px] in 31, text-[9px] in 4,
// and one text-[14px]. An arbitrary size cannot be restyled centrally,
// which is the objection that started this work ("why are we hardcoding
// the UI changes"). They are now named steps in index.css's @theme.
//
// This guards two things a build cannot: that no new one-off creeps in,
// and that every step actually EMITS. Tailwind v4 fails silently when a
// token lands in the wrong namespace -- max-w-statement was declared as
// --width-statement, generated no class at all, and was only caught by
// grepping the built CSS.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
let pass = 0, fail = 0;
const assert = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "\n      " + detail : ""}`); }
};

const css = readFileSync(path.join(ROOT, "src/index.css"), "utf8");

// ---- the scale is declared ------------------------------------------
const declared = [...css.matchAll(/--text-([a-z0-9]+):\s*([^;]+);/g)].map(m => m[1]);
assert("index.css declares a type scale", declared.length >= 8,
  `only ${declared.length} steps: ${declared.join(", ")}`);
for (const step of ["2xs", "xs", "sm", "base", "lg", "xl", "2xl"]) {
  assert(`--text-${step} is declared`, declared.includes(step));
}

// A custom step with no line-height inherits the parent's, which reads
// loose beside the rows next to it.
const custom = declared.filter(d => !["xs","sm","base","lg","xl","2xl","3xl","4xl","5xl"].includes(d));
for (const c of custom) {
  assert(`--text-${c} declares its own line-height`,
    css.includes(`--text-${c}--line-height:`),
    "Tailwind pairs a line-height with its built-in steps but not with a custom one");
}

// ---- nothing off the scale ------------------------------------------
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".js")) files.push(p);
  }
})(path.join(ROOT, "src"));

const offenders = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/text-\[[^\]]+\]/g)) {
    // An arbitrary COLOR is a different thing -- only sizes are pinned here.
    if (/^text-\[(#|rgb|hsl|var)/.test(m[0])) continue;
    offenders.push(`${path.relative(ROOT, f)}: ${m[0]}`);
  }
}
assert("no arbitrary font sizes outside the scale", offenders.length === 0,
  offenders.slice(0, 8).join("\n      ") + (offenders.length > 8 ? `\n      …and ${offenders.length - 8} more` : ""));

// ---- every step emits a real class ----------------------------------
// Only meaningful after a build; skipped rather than guessed at otherwise.
const buildDir = path.join(ROOT, "build/static/css");
if (existsSync(buildDir)) {
  const cssFile = readdirSync(buildDir).filter(f => f.endsWith(".css"))
    .map(f => path.join(buildDir, f)).sort((a, b) => readFileSync(b).length - readFileSync(a).length)[0];
  const built = readFileSync(cssFile, "utf8");
  for (const step of declared) {
    if (css.includes(`--text-${step}--line-height`) && !declared.includes(step)) continue;
    assert(`.text-${step} is emitted in the built CSS`,
      built.includes(`.text-${step}{font-size:var(--text-${step})`),
      "declared in @theme but Tailwind generated no class — check the namespace");
  }
} else {
  console.log("SKIP  built CSS not present (run npm run build to check emission)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
