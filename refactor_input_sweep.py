#!/usr/bin/env python3
"""
Input sweep: convert raw <input type="X" ...> to <Input ...> from ui.js,
but only for types that <Input> supports (text, email, password, number,
date, tel, and untyped — which defaults to text). Leaves file/checkbox/
radio/hidden alone — those have no ui.js primitive.

Rules:
  - Skip shared.js (contains the primitives themselves).
  - Skip SignaturePad.js (canvas + hidden plumbing).
  - Skip any single <input ... /> line whose type is in NON_CONVERTIBLE.
  - Only rewrites single-line <input ... /> tags; any multi-line tag
    (< 1% of usages here) is left untouched for manual review.
  - After conversion, ensures `Input` is in the `from "../ui"` import.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent / "src" / "components"
SKIP_FILES = {"shared.js", "SignaturePad.js"}
NON_CONVERTIBLE = {"file", "checkbox", "radio", "hidden"}

# Match <input ... /> — terminator MUST be literal "/>" (JSX self-close).
# Using [\s\S]*? (non-greedy any-char including newlines) instead of [^>]
# so `>` inside arrow functions (onChange={e => ...}) or comparisons
# (condition={a > b}) doesn't prematurely end the match. The regex stops
# at the first literal "/>".
INPUT_RE = re.compile(r'<input\s+([\s\S]*?)\s*/>')
TYPE_RE = re.compile(r'\btype="([^"]+)"')


def should_convert(attrs: str) -> bool:
    m = TYPE_RE.search(attrs)
    if not m:
        # untyped <input> defaults to text — convert
        return True
    return m.group(1) not in NON_CONVERTIBLE


def rewrite_file(path: Path) -> int:
    text = path.read_text()
    original = text
    count = 0

    def repl(m: re.Match) -> str:
        nonlocal count
        attrs = m.group(1).strip()
        if not should_convert(attrs):
            return m.group(0)
        count += 1
        # <Input> is a React component that always self-closes and renders
        # an <input> internally. Preserve the attrs block verbatim.
        return f"<Input {attrs} />"

    text = INPUT_RE.sub(repl, text)
    if count == 0:
        return 0

    # Ensure Input is imported from ../ui. Look for existing ui import first.
    ui_import_re = re.compile(r'from\s+"\.\./ui"')
    if ui_import_re.search(text):
        # Add Input to the existing import if not already there.
        def add_input(m: re.Match) -> str:
            imp = m.group(0)
            if re.search(r'\bInput\b', imp):
                return imp
            # Inject Input into the destructuring list.
            return re.sub(r'\{([^}]*)\}', lambda g: "{" + g.group(1).rstrip() + ", Input }" if g.group(1).strip() else "{ Input }", imp, count=1)
        text = re.sub(r'import\s+\{[^}]*\}\s+from\s+"\.\./ui"', add_input, text, count=1)
    else:
        # No ui import yet — insert a new one right after the first react import.
        text = re.sub(r'(^import React[^\n]*\n)', r'\1import { Input } from "../ui";\n', text, count=1, flags=re.MULTILINE)

    if text != original:
        path.write_text(text)
    return count


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

    print(f"Converted {total} <input> → <Input> across {len(per_file)} files")
    for name, n in sorted(per_file.items(), key=lambda kv: -kv[1]):
        print(f"  {name}: {n}")


if __name__ == "__main__":
    main()
