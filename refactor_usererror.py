#!/usr/bin/env python3
"""Step 2: Replace userError() call sites with pmError(), then remove userError()."""

FILE = "src/App.js"

REPLACEMENTS = [
    # Line ~1491: Signup error
    (
        'if (signupErr) { setError(userError(signupErr.message)); setLoading(false); return; }',
        'if (signupErr) { pmError("PM-1009", { raw: signupErr, context: "user signup" }); setError(PM_ERRORS["PM-1009"].message); setLoading(false); return; }',
    ),
    # Line ~3328: Permanent delete property
    (
        'const { error } = await supabase.from("properties").delete().eq("id", prop.id).eq("company_id", companyId);\n  if (error) { showToast(userError(error.message), "error"); return; }',
        'const { error } = await supabase.from("properties").delete().eq("id", prop.id).eq("company_id", companyId);\n  if (error) { pmError("PM-2003", { raw: error, context: "permanent delete property " + prop.address }); return; }',
    ),
    # Line ~3454-3458: Save property — duplicate handled separately, else uses userError
    (
        'showToast("A property with this exact address already exists in your company. Please check your existing properties.", "error");\n  } else {\n  showToast(userError(error.message), "error");\n  }',
        'pmError("PM-2001", { raw: error, context: "save property " + compositeAddress });\n  } else {\n  pmError("PM-2002", { raw: error, context: "save property " + compositeAddress });\n  }',
    ),
    # Line ~3602: Deactivate property
    (
        'if (error) { showToast(userError(error.message), "error"); return; }\n  // Deactivate accounting class',
        'if (error) { pmError("PM-2003", { raw: error, context: "deactivate property " + property.address }); return; }\n  // Deactivate accounting class',
    ),
    # Line ~3617: Reactivate property
    (
        'if (error) { showToast(userError(error.message), "error"); return; }\n  if (property.class_id) await supabase.from("acct_classes").update({ is_active: true })',
        'if (error) { pmError("PM-2004", { raw: error, context: "reactivate property " + property.address }); return; }\n  if (property.class_id) await supabase.from("acct_classes").update({ is_active: true })',
    ),
    # Line ~4678: Create recurring entry
    (
        'if (error) { showToast("Failed to create recurring entry: " + userError(error.message), "error"); }',
        'if (error) { pmError("PM-4008", { raw: error, context: "create recurring entry for " + showRecurringSetup.tenant }); }',
    ),
    # Line ~4800-4802: Save tenant — duplicate handled separately
    (
        'showToast("A tenant named \\"" + form.name.trim() + "\\" already exists at this property. Please check your existing tenants.", "error");\n  } else {\n  showToast("Error saving tenant: " + userError(error.message), "error");\n  }',
        'pmError("PM-3001", { raw: error, context: "save tenant " + form.name.trim() });\n  } else {\n  pmError("PM-3002", { raw: error, context: "save tenant " + form.name.trim() });\n  }',
    ),
    # Line ~19216: Create company fallback
    (
        'showToast("Failed to create company: " + userError(fallbackErr.message), "error");',
        'pmError("PM-8006", { raw: fallbackErr, context: "create company (client-side fallback)" });',
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
        elif count == 1:
            content = content.replace(old, new)
            replaced += 1
        else:
            print(f"  ⚠ Multiple matches ({count}) for: {old[:60]}...")
            not_found.append(f"MULTIPLE({count}): {old[:60]}")

    with open(FILE, "w") as f:
        f.write(content)

    print(f"\n✅ Replaced {replaced} / {len(REPLACEMENTS)} patterns")
    if not_found:
        print(f"\n❌ Not found ({len(not_found)}):")
        for nf in not_found:
            print(f"  - {nf}")

if __name__ == "__main__":
    main()
