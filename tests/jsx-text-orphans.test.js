// No JSX closer may be left stranded as visible text.
//
// `)}` sitting in a JSX children region is not a syntax error -- it is TEXT.
// The build succeeds, every test passes, and the characters render on the
// page. One sat in Properties.js from the 15 April refactor until 17
// September, printing ")}" on the production Properties screen for five
// months, directly above the "Setup incomplete" banner.
//
// Nothing else could have caught it. eslint sees valid JSX, the compiler sees
// valid JSX, and a screenshot is the only other way to know.
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? "\n   " + detail : ""}`); }
}

const SRC = path.join(__dirname, "..", "src");
function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".js") && !f.endsWith(".test.js")) out.push(p);
  }
  return out;
}

console.log("\n=== JSX TEXT ORPHANS ===\n");

const orphans = [];
for (const file of walk(SRC)) {
  const rel = path.relative(path.join(__dirname, ".."), file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 1; i < lines.length; i++) {
    // A line that is nothing but closing parens and a brace.
    if (!/^\s*\)+\}\s*$/.test(lines[i])) continue;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    const prev = (lines[j] || "").trim();
    // Directly after a JSX comment, nothing opened an expression for it to
    // close -- the comment IS a complete expression container. That is the
    // exact shape of the one that shipped.
    if (/\*\/\}$/.test(prev)) {
      orphans.push(`${rel}:${i + 1} — ")}" straight after a JSX comment: ${prev.slice(0, 60)}`);
    }
  }
}

assert(
  "no closing brace is stranded after a JSX comment",
  orphans.length === 0,
  orphans.join("\n   ") +
  "\n   A `)}` in a children region is TEXT, not syntax. It compiles, it lints, and it renders."
);

console.log(`\n${failed === 0 ? "✅" : "❌"} Passed: ${passed}   ❌ Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
