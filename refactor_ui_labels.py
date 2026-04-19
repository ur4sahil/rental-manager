#!/usr/bin/env python3
"""
1. Rename 'Name' column headers to 'Tenant/Vendor' in JE form, view modal, bank categorization
2. Add '+ New Account' option to all account dropdowns
"""

FILE = "src/App.js"

REPLACEMENTS = [
    # === RENAME "Name" → "Tenant/Vendor" ===

    # JE form table header (line ~8044)
    (
        'text-neutral-500 w-32">Name</th>',
        'text-neutral-500 w-32">Tenant/Vendor</th>',
    ),

    # JE view modal header (line ~8137)
    (
        'text-neutral-500">Name</th><th',
        'text-neutral-500">Tenant/Vendor</th><th',
    ),

    # Bank categorization label (line ~10726)
    (
        '<div><label className="text-xs font-medium text-neutral-500 block mb-1">Name</label>\n          <select value={addForm.entityId',
        '<div><label className="text-xs font-medium text-neutral-500 block mb-1">Tenant/Vendor</label>\n          <select value={addForm.entityId',
    ),

    # === ADD "+ New Account" TO ACCOUNT DROPDOWNS ===

    # JE form account select — add "+ New Account" after the optgroups
    # The JE form uses ACCOUNT_TYPES.map(type => <optgroup>...)
    # We need to add an option at the end of the select
    (
        '<option value="">-- Select --</option>{ACCOUNT_TYPES.map(type => <optgroup key={type} label={type}>{accounts.filter(a=>a.type===type&&a.is_active).map(a => <option key={a.id} value={a.id}>{a.code || "•"} {a.name}</option>)}</optgroup>)}</Select>',
        '<option value="">-- Select --</option><option value="__new__">+ New Account</option>{ACCOUNT_TYPES.map(type => <optgroup key={type} label={type}>{accounts.filter(a=>a.type===type&&a.is_active).map(a => <option key={a.id} value={a.id}>{a.code || "•"} {a.name}</option>)}</optgroup>)}</Select>',
    ),

    # Bank categorization account select
    (
        '<option value="">Select account...</option>{ACCOUNT_TYPES.map(type => <optgroup key={type} label={type}>{accounts.filter(a => a.type === type && a.is_active).map(a => <option key={a.id} value={a.id}>{a.code || "•"} {a.name}</option>)}</optgroup>)}\n          </select>',
        '<option value="">Select account...</option><option value="__new__">+ New Account</option>{ACCOUNT_TYPES.map(type => <optgroup key={type} label={type}>{accounts.filter(a => a.type === type && a.is_active).map(a => <option key={a.id} value={a.id}>{a.code || "•"} {a.name}</option>)}</optgroup>)}\n          </select>',
    ),
]

def main():
    with open(FILE, "r") as f:
        content = f.read()

    replaced = 0
    not_found = []

    for old, new in REPLACEMENTS:
        count = content.count(old)
        if count == 0:
            not_found.append(old[:80])
        elif count >= 1:
            content = content.replace(old, new)
            replaced += 1
            if count > 1:
                print(f"  ℹ Replaced all {count} matches for: {old[:60]}...")

    with open(FILE, "w") as f:
        f.write(content)

    print(f"\n✅ Replaced {replaced} / {len(REPLACEMENTS)} patterns")
    if not_found:
        print(f"\n❌ Not found ({len(not_found)}):")
        for nf in not_found:
            print(f"  - {nf}")

if __name__ == "__main__":
    main()
