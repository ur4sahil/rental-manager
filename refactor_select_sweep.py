#!/usr/bin/env python3
"""
Select sweep: convert raw <select>...</select> to <Select>...</Select>
from ui.js. Every raw <select> is a candidate — unlike <button>, there's
no icon-only or "tab pill" variant to exclude. The <Select> component
renders a real <select> underneath so any styling passed through
className is preserved.

Rules:
  - Skip shared.js (contains primitives).
  - Rewrite opening <select ...> and closing </select> tags.
  - Ensure `Select` is in the `from "../ui"` import.
"""
import re
from pathlib import Path

ROOT = Path(__file__).parent / "src" / "components"
SKIP_FILES = {"shared.js"}

# Opening tag — match <select followed by attrs until the closing >
# (but NOT >= or => etc.). Use [\s\S]*? to handle multi-line.
SELECT_OPEN_RE = re.compile(r'<select(\s+[\s\S]*?)?>')
SELECT_CLOSE_RE = re.compile(r'</select>')


def rewrite_file(path: Path) -> int:
    text = path.read_text()
    original = text

    # Count opens / closes first to verify symmetry.
    opens = len(SELECT_OPEN_RE.findall(text))
    closes = len(SELECT_CLOSE_RE.findall(text))
    if opens == 0 and closes == 0:
        return 0
    if opens != closes:
        print(f"  WARN: {path.name} has {opens} opens but {closes} closes — skipping")
        return 0

    # Rewrite opens: preserve captured attrs body exactly.
    text = SELECT_OPEN_RE.sub(lambda m: f"<Select{m.group(1) or ''}>", text)
    text = SELECT_CLOSE_RE.sub("</Select>", text)

    if text == original:
        return 0

    # Ensure Select is imported.
    ui_import_re = re.compile(r'from\s+"\.\./ui"')
    if ui_import_re.search(text):
        def add_select(m: re.Match) -> str:
            imp = m.group(0)
            if re.search(r'\bSelect\b', imp):
                return imp
            return re.sub(r'\{([^}]*)\}', lambda g: "{" + g.group(1).rstrip() + ", Select }" if g.group(1).strip() else "{ Select }", imp, count=1)
        text = re.sub(r'import\s+\{[^}]*\}\s+from\s+"\.\./ui"', add_select, text, count=1)
    else:
        text = re.sub(r'(^import React[^\n]*\n)', r'\1import { Select } from "../ui";\n', text, count=1, flags=re.MULTILINE)

    path.write_text(text)
    return opens


def main():
    total = 0
    per_file = {}
    for f in sorted(ROOT.glob("*.js")):
        if f.name in SKIP_FILES:
            continue
        n = rewrite_file(f)
        if n:
            per_file[f.name] = n
            total += n

    print(f"Converted {total} <select> → <Select> across {len(per_file)} files")
    for name, n in sorted(per_file.items(), key=lambda kv: -kv[1]):
        print(f"  {name}: {n}")


if __name__ == "__main__":
    main()
