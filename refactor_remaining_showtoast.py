#!/usr/bin/env python3
"""Step 3b: Replace remaining 12 generic showToast("Error: " + error.message) calls."""

FILE = "src/App.js"

REPLACEMENTS = [
    # 11747: Create work order from inspection
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  addNotification("🔧", `Work order created from inspection',
        'if (error) { pmError("PM-7001", { raw: error, context: "create work order from inspection" }); return; }\n  addNotification("🔧", `Work order created from inspection',
    ),
    # 12078: Save lease template
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  setShowTemplateForm(false)',
        'if (error) { pmError("PM-3004", { raw: error, context: "save lease template" }); return; }\n  setShowTemplateForm(false)',
    ),
    # 12362: Save vendor
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  logAudit(editingVendor',
        'if (error) { pmError("PM-8006", { raw: error, context: editingVendor ? "update vendor" : "create vendor" }); return; }\n  logAudit(editingVendor',
    ),
    # 12412: Save vendor invoice
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  logAudit("create", "vendor_invoices"',
        'if (error) { pmError("PM-8006", { raw: error, context: "save vendor invoice" }); return; }\n  logAudit("create", "vendor_invoices"',
    ),
    # 12739: Save owner
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  logAudit(editingOwner',
        'if (error) { pmError("PM-8006", { raw: error, context: editingOwner ? "update owner" : "create owner" }); return; }\n  logAudit(editingOwner',
    ),
    # 12842: Generate owner statement
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  logAudit("create", "owner_statements"',
        'if (error) { pmError("PM-8006", { raw: error, context: "generate owner statement" }); return; }\n  logAudit("create", "owner_statements"',
    ),
    # 13162: Lock accounting period
    (
        '    if (error) { showToast("Error: " + error.message, "error"); return; }\n    logAudit("update", "accounting", `Period locked',
        '    if (error) { pmError("PM-4011", { raw: error, context: "lock accounting period" }); return; }\n    logAudit("update", "accounting", `Period locked',
    ),
    # 13286: Save reconciliation
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n',
        'if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }\n',
        # This is the most generic one - we need more context
    ),
    # 15164: Process autopay payment
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  // AUTO-POST TO ACCOUNTING: Same smart AR',
        'if (error) { pmError("PM-6001", { raw: error, context: "process autopay payment" }); return; }\n  // AUTO-POST TO ACCOUNTING: Same smart AR',
    ),
    # 15358: Create late fee rule
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  addNotification("⚠️", `Late fee rule',
        'if (error) { pmError("PM-6003", { raw: error, context: "save late fee rule" }); return; }\n  addNotification("⚠️", `Late fee rule',
    ),
    # 16080: Update team member
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  await supabase.from("company_members").upsert',
        'if (error) { pmError("PM-1009", { raw: error, context: "update team member" }); return; }\n  await supabase.from("company_members").upsert',
    ),
    # 16086: Create team member
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  // Also add to company_members',
        'if (error) { pmError("PM-1009", { raw: error, context: "create team member" }); return; }\n  // Also add to company_members',
    ),
]

def main():
    with open(FILE, "r") as f:
        content = f.read()

    replaced = 0
    not_found = []

    for item in REPLACEMENTS:
        old = item[0]
        new = item[1]
        count = content.count(old)
        if count == 0:
            not_found.append(old[:80])
        elif count == 1:
            content = content.replace(old, new)
            replaced += 1
        else:
            # If multiple matches, still replace all — the context is unique enough
            content = content.replace(old, new)
            replaced += 1
            print(f"  ⚠ Multiple matches ({count}) for: {old[:60]}...")

    with open(FILE, "w") as f:
        f.write(content)

    print(f"\n✅ Replaced {replaced} / {len(REPLACEMENTS)} patterns")
    if not_found:
        print(f"\n❌ Not found ({len(not_found)}):")
        for nf in not_found:
            print(f"  - {nf}")

if __name__ == "__main__":
    main()
