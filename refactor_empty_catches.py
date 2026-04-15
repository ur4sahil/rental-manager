#!/usr/bin/env python3
"""Step 1: Replace empty catch {} blocks with pmError() calls."""

FILE = "src/App.js"

REPLACEMENTS = [
    # Line ~9096: Date parsing fallback
    (
        'try{const d=new Date(raw);if(!isNaN(d))return d.toISOString().slice(0,10);}catch{}',
        'try{const d=new Date(raw);if(!isNaN(d))return d.toISOString().slice(0,10);}catch(_e){pmError("PM-8006",{raw:_e,context:"date parsing fallback",silent:true});}',
    ),
    # Line ~10006: Bank rule stats RPC
    (
        'try { await supabase.rpc("increment_rule_stats", { rule_id: ruleId }); } catch {}',
        'try { await supabase.rpc("increment_rule_stats", { rule_id: ruleId }); } catch (_e) { pmError("PM-5008", { raw: _e, context: "increment bank rule stats", silent: true }); }',
    ),
    # Line ~10056: localStorage pattern learning
    (
        '      }\n    } catch {}\n  }\n\n  const RENTAL_RULE_PRESETS',
        '      }\n    } catch (_e) { pmError("PM-8006", { raw: _e, context: "bank categorization pattern learning", silent: true }); }\n  }\n\n  const RENTAL_RULE_PRESETS',
    ),
    # Line ~11421: Magic bytes validation (work order upload — different from DocUploadModal)
    (
        "if (!ok) { showToast(\"File content doesn't match expected format.\", \"error\"); return; } } catch {}",
        "if (!ok) { showToast(\"File content doesn't match expected format.\", \"error\"); return; } } catch (_e) { pmError(\"PM-7002\", { raw: _e, context: \"file magic bytes validation\", silent: true }); }",
    ),
    # Line ~12174: JSON.parse checklist
    (
        'items = JSON.parse(showChecklist.lease[showChecklist.type === "in" ? "move_in_checklist" : "move_out_checklist"] || "[]"); } catch {}',
        'items = JSON.parse(showChecklist.lease[showChecklist.type === "in" ? "move_in_checklist" : "move_out_checklist"] || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse move checklist JSON", silent: true }); }',
    ),
    # Line ~13019: JSON.parse statement line items (first instance)
    (
        'let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch {}\n  return items.map((cat, ci) => (\n  <div key={ci} className="mb-4">',
        'let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse owner statement line items", silent: true }); }\n  return items.map((cat, ci) => (\n  <div key={ci} className="mb-4">',
    ),
    # Line ~13438: JSON.parse reconciliation items
    (
        'let items = []; try { items = JSON.parse(viewRecon.unreconciled_items || "[]"); } catch {}',
        'let items = []; try { items = JSON.parse(viewRecon.unreconciled_items || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse reconciliation items", silent: true }); }',
    ),
    # Line ~14315: JSON.parse statement line items (second instance)
    (
        'let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch {} return items.map((cat, ci) => (\n  <div key={ci} className="mb-3">',
        'let items = []; try { items = JSON.parse(viewStatement.line_items || "[]"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "parse statement line items", silent: true }); } return items.map((cat, ci) => (\n  <div key={ci} className="mb-3">',
    ),
    # Line ~19800: localStorage setItem
    (
        'try { localStorage.setItem("lastCompanyId", company.id); } catch {}',
        'try { localStorage.setItem("lastCompanyId", company.id); } catch (_e) { pmError("PM-8006", { raw: _e, context: "save lastCompanyId to localStorage", silent: true }); }',
    ),
    # Line ~19987: localStorage removeItem
    (
        'try { localStorage.removeItem("lastCompanyId"); } catch {}',
        'try { localStorage.removeItem("lastCompanyId"); } catch (_e) { pmError("PM-8006", { raw: _e, context: "remove lastCompanyId from localStorage", silent: true }); }',
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
