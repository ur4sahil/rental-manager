#!/usr/bin/env python3
"""
Refactor App.js to adopt ui.js components — Pass 2.
Handles: Select (broader), Btn (string concat + more variants), IconBtn.
"""

import re

def read_file(path):
    with open(path, 'r') as f:
        return f.read()

def write_file(path, content):
    with open(path, 'w') as f:
        f.write(content)

def fix_closing_tags(src, new_tag, old_tag):
    close_old = f'</{old_tag}>'
    close_new = f'</{new_tag}>'
    TAG_EVENT = re.compile(
        rf'(<{new_tag}[\s>]|<{new_tag}\s[^>]*/>|<{old_tag}[\s>]|<{old_tag}\s[^>]*/>'
        rf'|</{old_tag}>|</{new_tag}>)'
    )
    stack = []
    result = []
    last_end = 0
    for m in TAG_EVENT.finditer(src):
        token = m.group(0)
        start = m.start()
        result.append(src[last_end:start])
        if re.match(rf'<{new_tag}\s[^>]*/>', token):
            result.append(token)
        elif re.match(rf'<{old_tag}\s[^>]*/>', token):
            result.append(token)
        elif re.match(rf'<{new_tag}[\s>]', token):
            stack.append('new')
            result.append(token)
        elif re.match(rf'<{old_tag}[\s>]', token):
            stack.append('old')
            result.append(token)
        elif token == close_old:
            if stack and stack[-1] == 'new':
                stack.pop()
                result.append(close_new)
            elif stack and stack[-1] == 'old':
                stack.pop()
                result.append(close_old)
            else:
                result.append(close_old)
        elif token == close_new:
            if stack:
                stack.pop()
            result.append(close_new)
        else:
            result.append(token)
        last_end = m.end()
    result.append(src[last_end:])
    return ''.join(result)


def refactor(src):
    changes = {}

    # ── 1. UPDATE IMPORT ──
    old_import = 'import { Input, Textarea, Select, Btn, Card, PageHeader, FormField, TabBar, FilterPill, SectionTitle, EmptyState, IconBtn, BulkBar } from "./ui";'
    if old_import not in src:
        # Try simpler import
        old_import2 = 'import { Input, Textarea } from "./ui";'
        new_import = 'import { Input, Textarea, Select, Btn, Card, PageHeader, FormField, TabBar, FilterPill, SectionTitle, EmptyState, IconBtn, BulkBar } from "./ui";'
        if old_import2 in src:
            src = src.replace(old_import2, new_import)
            changes['import'] = 1
    else:
        changes['import'] = 0  # already has full import

    # ── 2. SELECT (broader patterns) ──
    select_count = 0
    SELECT_STRIP = {
        'border', 'border-brand-100', 'border-slate-200', 'border-violet-200',
        'rounded-2xl', 'rounded-xl', 'rounded-lg',
        'px-3', 'px-2', 'py-2', 'py-1.5', 'py-1',
        'text-sm', 'text-xs', 'w-full',
        'focus:border-brand-300', 'focus:outline-none', 'transition-colors',
    }

    def replace_select(m):
        nonlocal select_count
        select_count += 1
        classes = m.group(1)
        remaining = [c for c in classes.split() if c not in SELECT_STRIP]
        if remaining:
            return f'<Select className="{" ".join(remaining)}"'
        return '<Select'

    # Match selects with various border patterns
    src = re.sub(
        r'<select\s+className="([^"]*(?:border-brand-100|border-slate-200|border-violet-200|rounded-2xl|rounded-xl)[^"]*)"',
        replace_select,
        src
    )
    src = fix_closing_tags(src, 'Select', 'select')
    changes['select'] = select_count

    # ── 3. BUTTONS → Btn (static className="...") ──
    btn_count = 0

    def detect_variant(classes):
        if 'bg-brand-600' in classes and 'text-white' in classes:
            return 'primary'
        if 'text-brand-600' in classes and 'border-brand-200' in classes:
            return 'secondary'
        if 'bg-red-600' in classes and 'text-white' in classes:
            return 'danger-fill'
        if 'text-red-600' in classes and 'border-red-200' in classes:
            return 'danger'
        if 'bg-emerald-600' in classes and 'text-white' in classes:
            return 'success-fill'
        if 'bg-green-600' in classes and 'text-white' in classes:
            return 'success-fill'
        if 'text-emerald-600' in classes and 'border-emerald-200' in classes:
            return 'success'
        if 'text-green-600' in classes and 'border-green-200' in classes:
            return 'success'
        if 'bg-amber-600' in classes and 'text-white' in classes:
            return 'warning-fill'
        if 'text-amber-600' in classes and 'border-amber-200' in classes:
            return 'amber'
        if 'text-purple-600' in classes and 'border-purple-200' in classes:
            return 'purple'
        if 'bg-violet-600' in classes and 'text-white' in classes:
            return 'primary'  # violet buttons → primary
        if 'bg-blue-600' in classes and 'text-white' in classes:
            return 'primary'  # blue buttons → primary
        if 'bg-slate-800' in classes and 'text-white' in classes:
            return 'primary'  # dark buttons → primary
        if 'bg-slate-100' in classes and 'text-slate-600' in classes:
            return 'slate'
        if 'bg-neutral-100' in classes and 'text-neutral-600' in classes:
            return 'slate'
        return None

    def detect_size(classes):
        if 'text-xs' in classes:
            if 'px-2' in classes and ('py-1 ' in classes or classes.endswith('py-1')):
                return 'xs'
            return 'sm'
        if 'text-sm' in classes:
            if 'px-5' in classes or 'py-2.5' in classes:
                return 'lg'
            return 'md'
        return 'md'

    BTN_STRIP = {
        'inline-flex', 'items-center', 'justify-center', 'font-semibold',
        'font-medium', 'transition-colors', 'transition-all',
        'disabled:opacity-50', 'disabled:cursor-not-allowed', 'disabled:opacity-40',
        'bg-brand-600', 'text-white', 'hover:bg-brand-700',
        'text-brand-600', 'border', 'border-brand-200', 'hover:bg-brand-50', 'bg-white',
        'bg-red-600', 'hover:bg-red-700', 'text-red-600', 'border-red-200', 'hover:bg-red-50',
        'bg-green-600', 'hover:bg-green-700', 'bg-emerald-600', 'hover:bg-emerald-700',
        'text-emerald-600', 'border-emerald-200', 'hover:bg-emerald-50',
        'text-green-600', 'border-green-200', 'hover:bg-green-50',
        'bg-amber-600', 'hover:bg-amber-700', 'text-amber-600', 'border-amber-200', 'hover:bg-amber-50',
        'text-purple-600', 'border-purple-200', 'hover:bg-purple-50',
        'bg-violet-600', 'hover:bg-violet-700',
        'bg-blue-600', 'hover:bg-blue-700',
        'bg-slate-800', 'hover:bg-slate-700',
        'bg-slate-100', 'text-slate-600', 'hover:bg-slate-200',
        'bg-neutral-100', 'text-neutral-600', 'hover:bg-neutral-200',
        'text-neutral-500', 'hover:text-neutral-700', 'hover:bg-neutral-100',
        'text-xs', 'text-sm', 'px-2', 'px-3', 'px-4', 'px-5', 'px-6',
        'py-1', 'py-1.5', 'py-2', 'py-2.5',
        'rounded-lg', 'rounded-xl', 'rounded-2xl',
        'gap-1', 'gap-1.5', 'gap-2',
    }

    VARIANT_TRIGGERS = (
        r'bg-brand-600|text-brand-600 border border-brand-200'
        r'|bg-red-600|text-red-600 border border-red-200'
        r'|bg-green-600|bg-emerald-600'
        r'|bg-amber-600'
        r'|bg-violet-600|bg-blue-600|bg-slate-800'
        r'|text-slate-600 bg-slate-100'
    )

    def make_btn(classes, prefix_props=''):
        nonlocal btn_count
        variant = detect_variant(classes)
        if variant is None:
            return None
        size = detect_size(classes)
        remaining = [c for c in classes.split() if c not in BTN_STRIP]
        btn_count += 1
        parts = ['<Btn']
        if variant != 'primary':
            parts.append(f' variant="{variant}"')
        if size != 'md':
            parts.append(f' size="{size}"')
        if remaining:
            parts.append(f' className="{" ".join(remaining)}"')
        if prefix_props.strip():
            parts.append(f' {prefix_props.strip()}')
        return ''.join(parts)

    # Pattern A: <button onClick={...} ... className="..."
    def replace_btn_a(m):
        result = make_btn(m.group(2), m.group(1))
        return result if result else m.group(0)

    src = re.sub(
        rf'<button\s+((?:(?!className)[^>])*?)className="([^"]*(?:{VARIANT_TRIGGERS})[^"]*)"',
        replace_btn_a,
        src
    )

    # Pattern B: <button className="..." ...
    def replace_btn_b(m):
        result = make_btn(m.group(1))
        return result if result else m.group(0)

    src = re.sub(
        rf'<button\s+className="([^"]*(?:{VARIANT_TRIGGERS})[^"]*)"',
        replace_btn_b,
        src
    )

    src = fix_closing_tags(src, 'Btn', 'button')
    changes['btn'] = btn_count

    # ── 4. ICON BUTTONS → IconBtn ──
    iconbtn_count = 0

    def replace_iconbtn(m):
        nonlocal iconbtn_count
        prefix = m.group(1) or ""
        icon_name = m.group(2)
        iconbtn_count += 1
        props = prefix.strip()
        return f'<IconBtn icon="{icon_name}" {props}'.rstrip()

    # Match: <button className="...text-slate-400 hover:bg-slate-100..." ...><span class="material-icons-outlined ...">icon</span></button>
    src = re.sub(
        r'<button\s+((?:(?!className)[^>])*?)className="[^"]*(?:text-slate-400|text-neutral-400)[^"]*hover:bg-(?:slate|neutral)-100[^"]*"[^>]*>\s*<span\s+className="material-icons-outlined[^"]*">(\w+)</span>\s*</button>',
        replace_iconbtn,
        src
    )
    # Also match className first
    src = re.sub(
        r'<button\s+className="[^"]*(?:text-slate-400|text-neutral-400)[^"]*hover:bg-(?:slate|neutral)-100[^"]*"((?:(?!>)[^>])*?)>\s*<span\s+className="material-icons-outlined[^"]*">(\w+)</span>\s*</button>',
        replace_iconbtn,
        src
    )
    changes['iconbtn'] = iconbtn_count

    # ── STATS ──
    slate_remaining = len(re.findall(r'slate-', src))
    changes['slate_remaining'] = slate_remaining

    return src, changes


if __name__ == '__main__':
    path = 'src/App.js'
    src = read_file(path)

    result, changes = refactor(src)
    write_file(path, result)

    print("=== UI Component Adoption Results (Pass 2) ===")
    print(f"  Import updated:      {changes.get('import', 0)}")
    print(f"  Select → <Select>:   {changes.get('select', 0)}")
    print(f"  Button → <Btn>:      {changes.get('btn', 0)}")
    print(f"  IconBtn adopted:     {changes.get('iconbtn', 0)}")
    print(f"  slate- remaining:    {changes.get('slate_remaining', 0)}")

    raw_selects = len(re.findall(r'<select[\s>]', result))
    raw_buttons = len(re.findall(r'<button[\s>]', result))
    raw_cards = len(re.findall(r'bg-white rounded-3xl shadow-card', result))
    print(f"\n  Remaining raw <select>:     {raw_selects}")
    print(f"  Remaining raw <button>:     {raw_buttons}")
    print(f"  Remaining card divs:        {raw_cards}")
