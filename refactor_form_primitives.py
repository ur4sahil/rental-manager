#!/usr/bin/env python3
"""
Form-primitive codemod: rewrite raw <input type="checkbox|radio|file" .../>
to <Checkbox/>, <Radio/>, <FileInput/> from ui.js.

Notes:
  - Only rewrites single-line self-closing <input ... /> tags. Multi-line
    inputs are left untouched (very rare — <20 in the codebase).
  - Strips `type="checkbox|radio|file"` from the attrs (redundant with the
    component).
  - Adds an import entry for each primitive actually used.
  - Does NOT merge any wrapping <label>. Calls with a surrounding <label>
    continue to render as a bare <input> equivalent; the Checkbox/Radio
    primitives accept a `label` prop but only use it when invoked without
    a wrapping label.

Skipped: shared.js (primitives-in-primitives risk), SignaturePad.js.
"""
import re
from pathlib import Path

ROOT = Path(__file__).parent / "src" / "components"
SKIP_FILES = {"shared.js", "SignaturePad.js"}

# Type → component name
TYPE_MAP = {
    "checkbox": "Checkbox",
    "radio":    "Radio",
    "file":     "FileInput",
}

# Terminator must be literal /> so `>` inside arrow functions doesn't prematurely close.
INPUT_RE = re.compile(r'<input\s+([\s\S]*?)\s*/>')
TYPE_RE = re.compile(r'\btype="(checkbox|radio|file)"\s*')


def rewrite_file(path: Path) -> dict:
    text = path.read_text()
    original = text
    counts = {}

    def repl(m: re.Match) -> str:
        attrs = m.group(1)
        tm = TYPE_RE.search(attrs)
        if not tm:
            return m.group(0)
        component = TYPE_MAP[tm.group(1)]
        # Remove the type="X" attr now that the component implies it.
        new_attrs = TYPE_RE.sub("", attrs).strip()
        counts[component] = counts.get(component, 0) + 1
        return f"<{component} {new_attrs} />" if new_attrs else f"<{component} />"

    text = INPUT_RE.sub(repl, text)
    if text == original:
        return {}

    # Inject imports for whichever primitives were used.
    needed = [c for c in counts.keys()]
    ui_import_re = re.compile(r'import\s+\{([^}]*)\}\s+from\s+"\.\./ui"')
    m = ui_import_re.search(text)
    if m:
        existing = set(x.strip() for x in m.group(1).split(","))
        missing = [c for c in needed if c not in existing]
        if missing:
            merged = sorted(existing | set(needed))
            text = ui_import_re.sub(
                f'import {{ {", ".join(merged)} }} from "../ui"',
                text, count=1,
            )
    else:
        # No ui.js import yet — insert a fresh one after first React import.
        text = re.sub(
            r'(^import React[^\n]*\n)',
            r'\1import { ' + ", ".join(sorted(needed)) + ' } from "../ui";\n',
            text, count=1, flags=re.MULTILINE,
        )

    path.write_text(text)
    return counts


def main():
    totals = {}
    per_file = {}
    for f in sorted(ROOT.glob("*.js")):
        if f.name in SKIP_FILES:
            continue
        counts = rewrite_file(f)
        if counts:
            per_file[f.name] = counts
            for k, v in counts.items():
                totals[k] = totals.get(k, 0) + v

    total = sum(totals.values())
    print(f"Total form-primitive conversions: {total}")
    for k, v in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")
    print()
    for name, counts in sorted(per_file.items(), key=lambda kv: -sum(kv[1].values())):
        total_for_file = sum(counts.values())
        print(f"  {name}: {total_for_file} ({dict(counts)})")


if __name__ == "__main__":
    main()
