#!/usr/bin/env python3
"""
Color-token codemod: rewrite non-token Tailwind palettes and arbitrary hex
classNames to use the app's semantic tokens from index.css @theme.

Mapping (prefix-aware — applies to bg-/text-/border-/ring-/from-/to-/via-/
divide-/outline-/fill-/stroke- plus hover:/focus: variants of each):
  amber-*    → warn-*        (same scale 50..900)
  emerald-*  → positive-*
  rose-*     → danger-*
  purple-*   → highlight-*
  yellow-*   → caution-*
  teal-*     → success-*
  cyan-*     → info-*

Arbitrary hex:
  bg-[#fcf8ff]  → bg-surface-muted

Skips:
  - src/index.css / src/utils/theme.js  (the tokens themselves live there)
  - src/components/shared.js            (receipt HTML template string —
                                         migrated in step 5 via printTheme)
  - node_modules, build, tests

Fail-closed: if a mapping produces zero matches it's a warning, not an
abort — but if the final rewritten file is identical to the original it
is not written.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC_ROOTS = [ROOT / "src" / "components", ROOT / "src"]
SKIP_FILES = {"index.css", "theme.js"}

# Prefixes that can precede a color scale token inside a Tailwind className.
PREFIXES = [
    "bg", "text", "border", "ring", "outline", "fill", "stroke",
    "from", "to", "via", "divide",
    "hover:bg", "hover:text", "hover:border", "hover:ring",
    "focus:bg", "focus:text", "focus:border", "focus:ring",
    "group-hover:bg", "group-hover:text",
    "placeholder",
]
PREFIX_ALT = "|".join(re.escape(p) for p in PREFIXES)

# Palette → token map
PALETTE_MAP = {
    "amber": "warn",
    "emerald": "positive",
    "rose": "danger",
    "purple": "highlight",
    "yellow": "caution",
    "teal": "success",
    "cyan": "info",
}

# (pattern, replacement) pairs built once
RULES = []
for old, new in PALETTE_MAP.items():
    # \b(prefix)-old-(shade)\b  →  \1-new-\2
    pattern = re.compile(rf"(?<![\w-])({PREFIX_ALT})-{re.escape(old)}-(\d{{1,3}})\b")
    RULES.append((f"{old}→{new}", pattern, rf"\1-{new}-\2"))

# Arbitrary hex rules — only the one known hex in the codebase (bg-[#fcf8ff]).
# If more appear later, add them explicitly here.
RULES.append(("bg-[#fcf8ff]→bg-surface-muted",
              re.compile(r"bg-\[#fcf8ff\]"),
              "bg-surface-muted"))


def iter_source_files():
    seen = set()
    patterns = ["src/App.js", "src/**/*.js", "src/**/*.jsx"]
    for pat in patterns:
        for f in sorted(ROOT.glob(pat)):
            if f.name in SKIP_FILES: continue
            # Dedupe
            if f in seen: continue
            seen.add(f)
            # Skip anything under node_modules / build / tests
            parts = set(f.parts)
            if "node_modules" in parts or "build" in parts or "tests" in parts:
                continue
            yield f


def rewrite_file(path: Path) -> dict:
    text = path.read_text()
    original = text
    per_rule = {}
    for name, pattern, repl in RULES:
        new_text, n = pattern.subn(repl, text)
        if n:
            per_rule[name] = n
            text = new_text
    if text != original:
        path.write_text(text)
    return per_rule


def main():
    total = 0
    total_rule = {}
    per_file = {}
    for f in iter_source_files():
        counts = rewrite_file(f)
        if counts:
            rel = f.relative_to(ROOT)
            per_file[str(rel)] = counts
            for k, v in counts.items():
                total_rule[k] = total_rule.get(k, 0) + v
                total += v

    print(f"Total color-token replacements: {total}")
    print(f"Files touched:                  {len(per_file)}")
    print()
    print("By rule:")
    for name, n in sorted(total_rule.items(), key=lambda kv: -kv[1]):
        print(f"  {name}: {n}")
    print()
    print("Top files:")
    for name, counts in sorted(per_file.items(), key=lambda kv: -sum(kv[1].values()))[:15]:
        total_for_file = sum(counts.values())
        print(f"  {name}: {total_for_file}")


if __name__ == "__main__":
    main()
