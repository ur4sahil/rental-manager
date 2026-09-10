// Static functional audit: find controls that cannot work, by reading the
// source rather than driving a browser.
//
//   cd tests && node audit-static.test.js
//
// Seven browser-harness attempts produced nothing but their own bugs.
// Every real defect found by hand this session was visible in the source:
//
//   Renew Lease   setLeaseModal("renew") — the form renders only inside
//                 activePanel === "lease"; the button is in "actions".
//   Edit Tenant   opened a form underneath a fixed, higher-z-index panel.
//   Move-Out      navigated to a wizard filtering lease_status='active'
//                 while the rest of the app writes 'current'.
//
// So look for those shapes directly:
//
//   1. A setter called from one panel whose consumer renders only in
//      another  ->  the click does nothing visible.
//   2. A <button> with no onClick and no type=submit  ->  inert.
//   3. A state setter that nothing ever reads  ->  dead switch.
//   4. A string literal compared against a column whose stored values
//      never include it  ->  a filter that always returns nothing.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
let findings = [];
function finding(kind, file, detail) { findings.push({ kind, file, detail }); }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.js$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(path.join(__dirname, ".."), f);

  // ---- 1. inert buttons -------------------------------------------
  // A <button> with neither a handler nor a submit type does nothing.
  //
  // v1 of this check reported 8 and every one was wrong: four were inside
  // a generated HTML string for the printable lease (lowercase onclick=,
  // not React), one was a COMMENT describing button defaults, and the
  // rest were multi-line JSX whose handler sat on the following line. So
  // read to the closing bracket, and skip comments and HTML strings.
  for (const m of src.matchAll(/<button\b/g)) {
    const lineNo = src.slice(0, m.index).split("\n").length;
    const lineText = src.split("\n")[lineNo - 1] || "";
    if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue;         // a comment
    if (/onclick=/.test(lineText)) continue;                     // generated HTML, not JSX
    // Take everything up to the tag's closing '>' at depth 0, so
    // attributes spread over several lines are included.
    let i = m.index + 7, depth = 0, tag = "";
    for (; i < src.length && i < m.index + 4000; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
      tag += ch;
    }
    if (/onClick|onMouseDown|onPointerDown|onKeyDown|type\s*=\s*["']submit["']|\{\s*\.\.\./.test(tag)) continue;
    finding("inert button", rel, `line ${lineNo}: <button> with no handler and no type=submit`);
  }

  // ---- 2. setters whose state nothing reads ------------------------
  for (const m of src.matchAll(/const \[(\w+), (set\w+)\] = useState/g)) {
    const [, state, setter] = m;
    const reads = (src.match(new RegExp(`\\b${state}\\b`, "g")) || []).length;
    const writes = (src.match(new RegExp(`\\b${setter}\\b`, "g")) || []).length;
    // One read is the declaration itself.
    // Distinguish the two cases, because they are not the same problem:
    // never written at all is dead code; written repeatedly but never
    // read means the value is computed and thrown away. v1 called both
    // "the control cannot show anything", which was wrong for both --
    // all ten turned out to be harmless.
    if (reads <= 1 && writes <= 1) {
      finding("unused declaration", rel, `${state} is declared and never used at all`);
    } else if (reads <= 1 && writes > 1) {
      // Checked by hand and benign. Listed with the reason so the tool
      // stops crying wolf, and so the next person does not have to
      // re-derive it -- rather than churning working code to silence it.
      const BENIGN = {
        autopayEnabled: "duplicate of stripeAutopay, which drives the tab and renders 'Autopay is on'",
        showForm: "only ever set to false; vestigial from before the wizard replaced this form",
        paymentMethodModal: "the modal was never built; the setX(null) after authorising a bill is a no-op",
        prefillData: "callers use the returned object directly, not the state",
        draggingPlacement: "the drag works off closure variables; the state is decorative",
      };
      if (BENIGN[state]) continue;
      finding("write-only state", rel, `${state} is written ${writes - 1}x by ${setter} and never read — check whether the value is meant to drive something`);
    }
  }
}

// ---- 3. panel-scoped setters called from another panel -------------
// The Renode shape: setX("v") called where activePanel is something else,
// but the only render of X sits behind a different activePanel value.
const tenants = fs.readFileSync(path.join(SRC, "components", "Tenants.js"), "utf8");
for (const m of tenants.matchAll(/set(\w*Modal)\(["'](\w+)["']\)/g)) {
  const setter = "set" + m[1], value = m[2], stateName = m[1][0].toLowerCase() + m[1].slice(1);
  // Which activePanel guards the render of this state?
  const renderRe = new RegExp(`${stateName}\\s*===\\s*["']${value}["']`);
  const rm = renderRe.exec(tenants);
  if (!rm) { finding("orphan modal state", "src/components/Tenants.js", `${setter}("${value}") is set but nothing renders ${stateName} === "${value}"`); continue; }
  // Find the nearest enclosing activePanel guard above the render.
  const before = tenants.slice(0, rm.index);
  const panelGuards = [...before.matchAll(/activePanel === ["'](\w+)["']/g)];
  const renderPanel = panelGuards.length ? panelGuards[panelGuards.length - 1][1] : null;
  // And the panel the setter is called from.
  const sBefore = tenants.slice(0, m.index);
  const sGuards = [...sBefore.matchAll(/activePanel === ["'](\w+)["']/g)];
  const callPanel = sGuards.length ? sGuards[sGuards.length - 1][1] : null;
  if (renderPanel && callPanel && renderPanel !== callPanel &&
      !new RegExp(`setActivePanel\\(["']${renderPanel}["']\\)`).test(tenants.slice(m.index, m.index + 400))) {
    finding("panel mismatch", "src/components/Tenants.js",
      `${setter}("${value}") is called from the "${callPanel}" panel, but it only renders inside "${renderPanel}" — the click does nothing`);
  }
}

// ---- 4. status literals the database never stores -------------------
// Move-Out filtered lease_status='active' while imports write 'current'.
const KNOWN = { lease_status: ["current", "past", "active", "inactive", "review"] };
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(path.join(__dirname, ".."), f);
  for (const m of src.matchAll(/\.eq\(\s*["'](lease_status)["']\s*,\s*["'](\w+)["']\s*\)/g)) {
    const [, col, val] = m;
    if (!KNOWN[col].includes(val)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    // Skip comments. The check matched a code sample inside the very
    // comment explaining why the pattern is wrong.
    const text = src.split("\n")[line - 1] || "";
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
    finding("single-value status filter", rel,
      `line ${line}: .eq("${col}", "${val}") — this column holds several spellings; an .in([...]) is safer`);
  }
}

// ---- lease_status must never be read against one spelling ----------
// The column carries two words for one concept ('active' and 'current'),
// and production holds ONLY 'active'. A read matching a single literal
// therefore finds nothing at all rather than "most rows": getRentRoll
// compared === "current" and reported every unit VACANT with $0 rent, in
// the report, the Excel export and the PDF, for every company.
//
// Writes are exempt -- settling on one word when writing is the fix, not
// the bug. Only READS are flagged.
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (/ACTIVE_LEASE/.test(line)) return;
    // Skip comments -- helpers.js documents this exact bug, and a rule
    // that flags its own explanation is noise.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const isWrite = /\.update\(|\.insert\(|\.upsert\(|lease_status:\s*"/.test(line);
    if (isWrite) return;
    const strictCompare = /lease_status\s*===?\s*["'](active|current|inactive|past)["']/.test(line)
                       || /["'](active|current|inactive|past)["']\s*===?\s*[\w.]*lease_status/.test(line);
    const strictQuery   = /\.eq\(\s*["']lease_status["']\s*,\s*["']/.test(line);
    if (strictCompare || strictQuery) {
      finding("lease-status-single-spelling", `${file}:${i + 1}`,
        `reads lease_status against one literal — use ACTIVE_LEASE. ${line.trim().slice(0, 110)}`);
    }
  });
}

const byKind = {};
findings.forEach(f => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
console.log("\n=== STATIC FUNCTIONAL AUDIT ===\n");
let total = 0;
for (const kind of Object.keys(byKind)) {
  const list = byKind[kind];
  total += list.length;
  console.log(`${kind.toUpperCase()} — ${list.length}`);
  list.slice(0, 25).forEach(x => console.log(`   ${x.file}\n      ${x.detail}`));
  if (list.length > 25) console.log(`   …and ${list.length - 25} more`);
  console.log("");
}
console.log(`total: ${total} findings across ${files.length} files`);
// Exit non-zero on a finding, so this fails a run rather than printing
// into the void. Anything judged benign belongs in the BENIGN map above
// with its reason, not silently tolerated here.
if (total > 0) process.exitCode = 1;
fs.writeFileSync(process.env.AUDIT_OUT || "./static-audit.json", JSON.stringify(findings, null, 2));
