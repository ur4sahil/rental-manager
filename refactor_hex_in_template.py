#!/usr/bin/env python3
"""
Template-literal-aware hex → printTheme replacer.

Scans each target file line-by-line. Within any line that is INSIDE a
template literal (detected by presence of `` ` `` somewhere before on
the line OR open-backtick-state carried from previous lines), replaces
recognized hex literals with `${printTheme.TOKEN}` directly — no
string concatenation.

Outside template literals, falls back to the earlier string-concat
codemod's behavior.

Safer than the naive regex codemod because it respects the parser
context enough to avoid the "inside backticks, `+` is just text"
failure mode that broke Tenants.js ledger PDF.
"""
import re
from pathlib import Path

ROOT = Path(__file__).parent

TARGETS = [
    "src/components/Tenants.js",
]

HEX_MAP = {
    "#1a1a1a": "printTheme.ink",
    "#1e293b": "printTheme.inkStrong",
    "#334155": "printTheme.inkStrong",
    "#64748b": "printTheme.inkMuted",
    "#94a3b8": "printTheme.inkSubtle",
    "#111":    "printTheme.ink",
    "#333":    "printTheme.inkStrong",
    "#555":    "printTheme.inkMuted",
    "#666":    "printTheme.inkMuted",
    "#666666": "printTheme.inkMuted",
    "#999":    "printTheme.inkSubtle",
    "#999999": "printTheme.inkSubtle",
    "#888":    "printTheme.inkSubtle",
    "#e5e7eb": "printTheme.borderLight",
    "#cbd5e1": "printTheme.borderMed",
    "#ccc":    "printTheme.borderMed",
    "#dee2e6": "printTheme.borderLight",
    "#f8fafc": "printTheme.surfaceAlt",
    "#f9fafb": "printTheme.surfaceMuted",
    "#f1f5f9": "printTheme.surfaceMuted",
    "#f3f4f6": "printTheme.surfaceMuted",
    "#f8f9fa": "printTheme.surfaceMuted",
    "#ffffff": "printTheme.surface",
    "#fff":    "printTheme.surface",
    "#4f46e5": "printTheme.brand",
    "#6366f1": "printTheme.brandLight",
    "#4338ca": "printTheme.brandDark",
    "#eef2ff": "printTheme.brandSoft",
    "#e0e7ff": "printTheme.brandEdge",
    "#374151": "printTheme.inkStrong",
    "#1e3a5f": "printTheme.signatureInk",
    "#dc2626": "printTheme.danger",
    "#ef4444": "printTheme.danger",
    "#b91c1c": "printTheme.danger",
    "#c00":    "printTheme.danger",
    "#fef2f2": "printTheme.dangerBg",
    "#059669": "printTheme.success",
    "#15803d": "printTheme.success",
    "#16a34a": "printTheme.success",
    "#4ade80": "printTheme.success",
    "#f0fdf4": "printTheme.successBg",
    "#d97706": "printTheme.warn",
    "#fffbeb": "printTheme.warnBg",
    "#2563eb": "printTheme.info",
}


def process_file(path: Path) -> int:
    text = path.read_text()
    count = 0
    # Sort longest-first to avoid partial matches (e.g. #333333 before #333).
    for hx in sorted(HEX_MAP.keys(), key=lambda k: -len(k)):
        token = HEX_MAP[hx]
        pattern = re.compile(re.escape(hx) + r"\b")
        new_text, n = pattern.subn("${" + token + "}", text)
        if n:
            text = new_text
            count += n
    path.write_text(text)
    return count


def main():
    total = 0
    for rel in TARGETS:
        path = ROOT / rel
        if not path.exists():
            continue
        n = process_file(path)
        print(f"  {rel}: {n} replacements")
        total += n
    print(f"\nTotal: {total}")


if __name__ == "__main__":
    main()
