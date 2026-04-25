// ════════════════════════════════════════════════════════════════════
// Manual click-coverage matrix generator
//
// Walks src/components/*.js, finds every onClick= handler, and emits a
// markdown table to tests/MANUAL-CLICK-MATRIX.md with one row per
// clickable surface. The "Expected" column is the inline handler body
// (verbatim, truncated) so a human reviewer can compare what actually
// happens to what the code says SHOULD happen — that's the whole
// point: click + verify intent, not just "no crash".
//
// Usage:
//   cd tests && node scripts/build-click-matrix.js
//
// The generated file has Pass/Fail/Notes columns the human ticks while
// walking the app. Running this script overwrites the table while
// preserving any existing Pass/Fail markers (matched by file:line key).
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', '..', 'src', 'components');
const OUT_FILE = path.join(__dirname, '..', 'MANUAL-CLICK-MATRIX.md');

// ── Parser ─────────────────────────────────────────────────────────
// We're not building an AST — a regex pass over JSX is good enough for
// a coverage checklist. Two patterns to match:
//   1. <Btn ... onClick={() => ...}>Label</Btn>
//   2. <button ... onClick={() => ...}>Label</button>
// Plus row-action shorthand inside JSX expressions.
//
// For each match we capture:
//   - file path (relative to repo root)
//   - line number
//   - button label (best effort — strips tags, JSX expressions, whitespace)
//   - handler hint — what's inside `onClick={...}` truncated
//
// We do NOT try to be exhaustive — if the regex misses an exotic
// handler shape, that's fine. Coverage > correctness for a checklist.

const ONCLICK_RE = /onClick\s*=\s*\{([^}]{0,300})\}/g; // captures up to 300 chars of handler

// Find the visible label closest to a button-like JSX element. Walks
// forward from the onClick line up to ~6 lines and pulls the text.
function findLabel(lines, lineIdx) {
  // Look forward for the closing `>` then the label, then a closing tag
  for (let i = lineIdx; i < Math.min(lines.length, lineIdx + 8); i++) {
    const line = lines[i];
    // Pattern: ">Label<" or "label={...}" or "{label}"
    const closeIdx = line.indexOf('>');
    if (closeIdx === -1) continue;
    const after = line.slice(closeIdx + 1);
    // Stop at next `<` to avoid eating sibling JSX
    const labelEnd = after.indexOf('<');
    let candidate = labelEnd === -1 ? after : after.slice(0, labelEnd);
    candidate = candidate.replace(/\{[^}]*\}/g, '').trim();
    if (candidate && /[a-zA-Z]/.test(candidate)) return candidate.slice(0, 60);
  }
  // Fall back to the line itself
  const m = lines[lineIdx].match(/>([^<]{2,60})</);
  return m ? m[1].trim().slice(0, 60) : '(no label)';
}

// Try to extract a useful "page section" from preceding lines —
// typically a heading like {/* ── Some Section ── */} or `<PageHeader title="..."/>`.
function findSection(lines, lineIdx) {
  for (let i = lineIdx; i >= Math.max(0, lineIdx - 50); i--) {
    const line = lines[i];
    const sectionComment = line.match(/\/\/\s*[─=━]+\s*(.{3,60}?)\s*[─=━]/) || line.match(/\{\/\*\s*[─=━]+\s*(.{3,60}?)\s*[─=━]+/);
    if (sectionComment) return sectionComment[1].trim();
    const pageHeader = line.match(/<PageHeader\s+title=["']([^"']+)["']/);
    if (pageHeader) return pageHeader[1];
  }
  return '';
}

function summarizeHandler(handler) {
  // Strip newlines / extra whitespace, collapse, truncate.
  let s = handler.replace(/\s+/g, ' ').trim();
  if (s.length > 110) s = s.slice(0, 107) + '…';
  return s;
}

function parseFile(absPath) {
  const rel = path.relative(path.join(__dirname, '..', '..'), absPath);
  const text = fs.readFileSync(absPath, 'utf8');
  const lines = text.split('\n');
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Quick prefilter to avoid running the regex on every line
    if (!line.includes('onClick')) continue;
    let m;
    ONCLICK_RE.lastIndex = 0;
    while ((m = ONCLICK_RE.exec(line)) !== null) {
      const handler = m[1];
      // Skip noise: empty handlers, pure stopPropagation, or component variable refs
      if (!/[a-zA-Z(]/.test(handler)) continue;
      const label = findLabel(lines, i);
      const section = findSection(lines, i);
      rows.push({
        file: rel,
        line: i + 1,
        section,
        label,
        handler: summarizeHandler(handler),
      });
    }
  }
  return rows;
}

// ── Preserve Pass/Fail markers from previous run ─────────────────
function loadPriorMarkers() {
  if (!fs.existsSync(OUT_FILE)) return new Map();
  const text = fs.readFileSync(OUT_FILE, 'utf8');
  const markers = new Map();
  // Rows look like: | file:line | … | … | … | ✓/✗/blank | notes |
  const rowRe = /^\|\s*([\w/.-]+:\d+)\s*\|.*?\|\s*([✓✗\?\s])\s*\|\s*([^|]*?)\s*\|\s*$/gm;
  let m;
  while ((m = rowRe.exec(text)) !== null) {
    const key = m[1];
    const status = m[2].trim();
    const notes = m[3].trim();
    if (status || notes) markers.set(key, { status, notes });
  }
  return markers;
}

// ── Render markdown ──────────────────────────────────────────────
function renderMarkdown(rowsByFile, priorMarkers) {
  const lines = [];
  lines.push('# Manual click-coverage matrix');
  lines.push('');
  lines.push('Generated by `tests/scripts/build-click-matrix.js`. One row per `onClick={…}` handler in `src/components/*.js`.');
  lines.push('');
  lines.push('**How to use:**');
  lines.push('1. Click the surface in the running app.');
  lines.push('2. Verify the **Expected (handler)** column matches what actually happens — modal opens, page navigates, toast appears, row is removed, etc.');
  lines.push('3. Mark the **Status** column: `✓` if it does the intended thing, `✗` if it doesn\'t, `?` if you can\'t tell.');
  lines.push('4. Add notes (broken modal, wrong toast text, missing confirmation, etc.).');
  lines.push('');
  lines.push('Re-running the generator preserves the Status and Notes columns by `file:line` key.');
  lines.push('');
  lines.push('---');
  lines.push('');

  let totalRows = 0;
  let pass = 0, fail = 0, unknown = 0, todo = 0;

  for (const [file, rows] of rowsByFile) {
    if (!rows.length) continue;
    const fileLabel = path.basename(file, '.js');
    lines.push('## ' + fileLabel + ' (`' + file + '`)');
    lines.push('');
    lines.push('| File:Line | Section | Label | Expected (handler) | Status | Notes |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of rows) {
      const key = r.file + ':' + r.line;
      const prior = priorMarkers.get(key);
      const status = prior?.status || ' ';
      const notes = (prior?.notes || '').replace(/\|/g, '\\|');
      const label = r.label.replace(/\|/g, '\\|');
      const handler = r.handler.replace(/\|/g, '\\|');
      lines.push(`| ${key} | ${r.section || ''} | ${label} | \`${handler}\` | ${status} | ${notes} |`);
      totalRows++;
      if (status === '✓') pass++;
      else if (status === '✗') fail++;
      else if (status === '?') unknown++;
      else todo++;
    }
    lines.push('');
  }

  // Header summary — insert just before the `---` divider that separates
  // intro from the per-file tables. Find that divider index dynamically.
  const dividerIdx = lines.findIndex(l => l === '---');
  if (dividerIdx > -1) {
    lines.splice(dividerIdx, 0, `**Progress:** ${pass} ✓ · ${fail} ✗ · ${unknown} ? · ${todo} todo · **${totalRows} total**`, '');
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  const files = fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => path.join(SRC_DIR, f));

  const priorMarkers = loadPriorMarkers();
  const rowsByFile = new Map();
  for (const f of files) {
    const rows = parseFile(f);
    if (rows.length) rowsByFile.set(path.relative(path.join(__dirname, '..', '..'), f), rows);
  }

  const md = renderMarkdown(rowsByFile, priorMarkers);
  fs.writeFileSync(OUT_FILE, md);

  const totalRows = Array.from(rowsByFile.values()).reduce((s, r) => s + r.length, 0);
  console.log(`✅ Wrote ${OUT_FILE}`);
  console.log(`   ${rowsByFile.size} component files · ${totalRows} clickable surfaces`);
  if (priorMarkers.size > 0) console.log(`   Preserved ${priorMarkers.size} prior status/notes markers`);
}

main();
