#!/usr/bin/env python3
"""
Hex-to-printTheme codemod for template-string HTML.

Walks each target file, finds any single- or double-quoted string that
contains a hex literal from the known-mapping set, rewrites the quotes
to backticks (template literal), and swaps every mapped hex for
${printTheme.TOKEN}.

Preserves concatenation — `'a' + b + 'c'` becomes `` `a` + b + `c` `` so
downstream glue is untouched.

Only runs on a whitelist of files that generate print/email HTML. Other
files can contain hex legitimately (user-color defaults in Accounting
class form, inline style= with semantic meaning) and are left alone.
"""
import re
from pathlib import Path

ROOT = Path(__file__).parent

# Files to process — must opt in, no glob.
TARGETS = [
    "src/components/Documents.js",
    "src/components/Leases.js",
    "src/components/Tenants.js",
    "src/components/shared.js",
]

# Hex → printTheme token. Case-insensitive match on the hex. Order matters
# only for overlap: longer specifics first. Lowercase keys.
HEX_MAP = {
    # Neutral / ink
    "#1a1a1a": "printTheme.ink",
    "#1e293b": "printTheme.inkStrong",
    "#334155": "printTheme.inkStrong",      # close to 1e293b, same token
    "#64748b": "printTheme.inkMuted",
    "#94a3b8": "printTheme.inkSubtle",
    "#555555": "printTheme.inkMuted",
    "#555":    "printTheme.inkMuted",
    "#333333": "printTheme.inkStrong",
    "#333":    "printTheme.inkStrong",
    "#666666": "printTheme.inkMuted",
    "#666":    "printTheme.inkMuted",
    "#999999": "printTheme.inkSubtle",
    "#999":    "printTheme.inkSubtle",
    "#888":    "printTheme.inkSubtle",
    "#111":    "printTheme.ink",
    # Borders
    "#e5e7eb": "printTheme.borderLight",
    "#cbd5e1": "printTheme.borderMed",
    "#ccc":    "printTheme.borderMed",
    # Surfaces
    "#f8fafc": "printTheme.surfaceAlt",
    "#f9fafb": "printTheme.surfaceMuted",
    "#f3f4f6": "printTheme.surfaceMuted",
    "#ffffff": "printTheme.surface",
    "#fff":    "printTheme.surface",
    # Brand
    "#4f46e5": "printTheme.brand",
    "#6366f1": "printTheme.brandLight",
    "#4338ca": "printTheme.brandDark",
    "#eef2ff": "printTheme.brandSoft",
    "#e0e7ff": "printTheme.brandEdge",
    # Signature ink
    "#1e3a5f": "printTheme.signatureInk",
    # Semantic
    "#dc2626": "printTheme.danger",
    "#ef4444": "printTheme.danger",
    "#b91c1c": "printTheme.danger",
    "#c00":    "printTheme.danger",
    "#fef2f2": "printTheme.dangerBg",
    "#059669": "printTheme.success",
    "#15803d": "printTheme.success",
    "#f0fdf4": "printTheme.successBg",
    "#d97706": "printTheme.warn",
    "#fffbeb": "printTheme.warnBg",
    "#2563eb": "printTheme.info",
}

# Match a JS string literal that contains at least one `#xxxxxx` or `#xxx` hex.
# Single or double quoted. Non-greedy, allows escaped quotes of the same kind.
STR_RE = re.compile(
    r"""
    (?P<quote>['"])           # opening quote
    (?P<body>
        (?:\\.|(?!\1).)*?      # body: escaped chars OR non-quote chars, lazy
        \#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b  # must contain at least one hex
        (?:\\.|(?!\1).)*?
    )
    (?P=quote)                # matching closing quote
    """,
    re.VERBOSE,
)


def replace_hex_in_body(body: str) -> tuple[str, bool]:
    """Return (new_body, changed)."""
    changed = False
    # Sort hex keys longest-first so "#333333" matches before "#333".
    for hx in sorted(HEX_MAP.keys(), key=lambda k: -len(k)):
        token = HEX_MAP[hx]
        # Only substitute when the hex is at a word boundary (not part of a
        # longer hex like #12345678).
        pattern = re.compile(re.escape(hx) + r"\b")
        new_body, n = pattern.subn("${" + token + "}", body)
        if n:
            body = new_body
            changed = True
    return body, changed


def process_file(path: Path) -> int:
    text = path.read_text()
    original = text

    def repl(m: re.Match) -> str:
        """Rewrite using string concat so we don't need to flip quote style —
        which avoids the nested-template-literal breakage (style="..."
        inside an outer `...` would need backtick-escaping, and that
        escalates fast). Example:
          'color:#1e293b;border:1px solid #e5e7eb'
        becomes
          'color:' + printTheme.inkStrong + ';border:1px solid ' + printTheme.borderLight + ''
        Parser is happy, quoting stays put, no template interaction.
        """
        body = m.group("body")
        q = m.group("quote")
        # Build a list of (plain-string-fragment, token-or-None) pairs.
        parts = [body]
        for hx in sorted(HEX_MAP.keys(), key=lambda k: -len(k)):
            token = HEX_MAP[hx]
            pattern = re.compile(re.escape(hx) + r"\b")
            next_parts = []
            for p in parts:
                if isinstance(p, tuple):
                    next_parts.append(p)
                    continue
                segments = pattern.split(p)
                for i, seg in enumerate(segments):
                    if i > 0:
                        next_parts.append(("TOKEN", token))
                    next_parts.append(seg)
            parts = next_parts
        # If nothing changed, bail.
        if all(not isinstance(p, tuple) for p in parts):
            return m.group(0)
        # Reassemble as JS concatenation of quoted fragments and token
        # identifiers.
        out = []
        for p in parts:
            if isinstance(p, tuple):
                out.append(p[1])
            elif p:  # non-empty string
                out.append(q + p + q)
        return " + ".join(out)

    text = STR_RE.sub(repl, text)
    if text == original:
        return 0
    # Ensure printTheme is imported — matched in Step 5 manual pass, but be
    # idempotent in case we run this codemod fresh.
    if "from \"../utils/theme\"" not in text and "from '../utils/theme'" not in text:
        text = re.sub(
            r'(import\s+\{[^}]*\}\s+from\s+"\.\./utils/errors";?\n)',
            r'\1import { printTheme } from "../utils/theme";\n',
            text,
            count=1,
        )
    path.write_text(text)

    # Rough count of replacements: difference in hex literal count.
    def count_hex(s: str) -> int:
        return len(re.findall(r'#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b', s))
    return count_hex(original) - count_hex(text)


def main():
    total = 0
    for rel in TARGETS:
        path = ROOT / rel
        if not path.exists():
            print(f"  SKIP: {rel} not found")
            continue
        n = process_file(path)
        print(f"  {rel}: {n} hex → token replacements")
        total += n
    print(f"\nTotal: {total}")


if __name__ == "__main__":
    main()
