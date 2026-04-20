#!/usr/bin/env python3
"""
Narrow <button> codemod targeting three specific className shapes that
map 1:1 to ui.js primitives. Everything else stays raw — bespoke
state-dependent styling isn't worth forcing into <Btn> variants.

Patterns (single-line <button ...>LABEL</button> only; multi-line
buttons need manual review):

  A. Primary fill   — className exactly 'text-xs bg-brand-600 text-white
     px-3 py-1.5 rounded-lg' (or ±hover:bg-brand-700) → <Btn size="sm">
  B. Danger fill    — same shape with bg-danger-600 → <Btn variant="danger-fill" size="sm">
  C. Success fill   — bg-success-600 → <Btn variant="success-fill" size="sm">
  D. Warn fill      — bg-warn-600 → <Btn variant="warning-fill" size="sm">
  E. Chip pill      — 'text-xs bg-neutral-100 text-neutral-600 px-2.5
     py-0.5 rounded-full font-medium' → <Chip>
  F. Text link      — 'text-xs text-brand-600 hover:underline' (or +block)
     → <TextLink>
  G. Danger link    — 'text-xs text-danger-500 hover:underline' or
     'text-xs text-danger-400 hover:text-danger-600' → <TextLink tone="danger">

Imports are injected into the existing { ... } from "../ui" line.

Skipped: shared.js, LandingPage.js (marketing-only), any <button> that
doesn't match a rule. Rule matching requires EXACT className text so
drift is zero.
"""
import re
from pathlib import Path

ROOT = Path(__file__).parent / "src" / "components"
SKIP_FILES = {"shared.js", "LandingPage.js"}

# Each rule: (name, className-regex, replacement-template, primitive-name).
# The regex captures whatever's before/after the className inside the <button>,
# and the label between the tags.
# Helper for writing rules: matches a <button> whose className contains the
# exact CORE string, possibly surrounded by other utility classes. Captures
# pre-attrs, post-attrs, and ANY extra classes for the `className=` prop on
# the replacement. The label is matched non-greedy so nested JSX survives.
def _rule(core, replacement_open_tag, replacement_close_tag, primitive):
    core_re = re.escape(core)
    pat = re.compile(
        r'<button\s+([^>]*?)'
        r'className="('
        r'(?:[^"]*\s)?' + core_re + r'(?:\s[^"]*)?'
        r')"'
        r'(.*?)>'
        r'([^<]+)'
        r'</button>'
    )
    def fn(m):
        pre, cls, post, label = m.group(1), m.group(2), m.group(3), m.group(4)
        # Strip the core from cls; the rest becomes the className= on the
        # new primitive.
        remaining = re.sub(r'\s*\b' + core_re + r'\b\s*', ' ', cls).strip()
        remaining = re.sub(r'\s+', ' ', remaining)
        cls_prop = f' className="{remaining}"' if remaining else ''
        return f"{replacement_open_tag}{cls_prop} {pre.strip()}{post}>{label}{replacement_close_tag}"
    return (pat, fn, primitive)

RULES = [
    ("chip-edit",          _rule("text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full font-medium hover:bg-neutral-200", "<Chip", "</Chip>", "Chip")),
    ("chip-edit-compact",  _rule("text-xs bg-neutral-100 text-neutral-600 px-2.5 py-0.5 rounded-full", "<Chip", "</Chip>", "Chip")),
    ("text-link-brand",    _rule("text-xs text-brand-600 hover:underline", "<TextLink", "</TextLink>", "TextLink")),
    ("text-link-danger-400", _rule("text-xs text-danger-400 hover:text-danger-600", '<TextLink tone="danger"', "</TextLink>", "TextLink")),
    ("text-link-danger-500", _rule("text-xs text-danger-500 hover:underline", '<TextLink tone="danger"', "</TextLink>", "TextLink")),
    ("text-link-neutral",  _rule("text-xs text-neutral-500 hover:underline", '<TextLink tone="neutral"', "</TextLink>", "TextLink")),
    ("btn-primary-sm",     _rule("text-xs bg-brand-600 text-white px-3 py-1.5 rounded-lg hover:bg-brand-700", '<Btn size="sm"', "</Btn>", "Btn")),
    ("btn-primary-sm-nh",  _rule("text-xs bg-brand-600 text-white px-3 py-1.5 rounded-lg", '<Btn size="sm"', "</Btn>", "Btn")),
    ("btn-danger-fill-sm", _rule("text-xs bg-danger-600 text-white px-3 py-1.5 rounded-lg", '<Btn variant="danger-fill" size="sm"', "</Btn>", "Btn")),
    ("btn-success-fill-sm", _rule("text-xs bg-success-600 text-white px-3 py-1.5 rounded-lg", '<Btn variant="success-fill" size="sm"', "</Btn>", "Btn")),
]


def ensure_import(text: str, needed: set) -> str:
    needed = set(needed)
    if not needed:
        return text
    ui_import_re = re.compile(r'import\s+\{([^}]*)\}\s+from\s+"\.\./ui"')
    m = ui_import_re.search(text)
    if m:
        existing = set(x.strip() for x in m.group(1).split(","))
        merged = sorted(existing | needed)
        return ui_import_re.sub(
            f'import {{ {", ".join(merged)} }} from "../ui"',
            text, count=1,
        )
    return re.sub(
        r'(^import React[^\n]*\n)',
        r'\1import { ' + ", ".join(sorted(needed)) + ' } from "../ui";\n',
        text, count=1, flags=re.MULTILINE,
    )


def rewrite_file(path: Path) -> dict:
    text = path.read_text()
    original = text
    counts = {}
    used_primitives = set()
    for name, (pattern, fn, primitive) in RULES:
        new_text, n = pattern.subn(fn, text)
        if n:
            counts[name] = n
            used_primitives.add(primitive)
            text = new_text
    if text == original:
        return {}
    text = ensure_import(text, used_primitives)
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
    print(f"Total <button> conversions: {total}")
    for k, v in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"  {k}: {v}")
    print()
    for name, counts in sorted(per_file.items(), key=lambda kv: -sum(kv[1].values())):
        total_for_file = sum(counts.values())
        print(f"  {name}: {total_for_file} ({dict(counts)})")


if __name__ == "__main__":
    main()
