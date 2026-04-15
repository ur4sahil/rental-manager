#!/usr/bin/env python3
"""Step 3: Replace raw showToast("Error/Failed..." + error.message) with pmError() calls."""

FILE = "src/App.js"

REPLACEMENTS = [
    # 3564: Maintenance request submit (tenant portal)
    (
        'if (error) { showToast("Error submitting request: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-7001", { raw: error, context: "submit maintenance request" }); return; }',
        1,  # expect 2 matches — tenant portal + owner portal. Use replace_count
    ),
    # 4182: Document delete
    (
        'showToast("Error deleting document: " + error.message, "error")',
        'pmError("PM-7004", { raw: error, context: "delete document" })',
    ),
    # 4922: Archive tenant
    (
        'if (archiveErr) { showToast("Failed to archive tenant: " + archiveErr.message, "error"); return; }',
        'if (archiveErr) { pmError("PM-3003", { raw: archiveErr, context: "archive tenant" }); return; }',
    ),
    # 4982: Create invite code
    (
        'if (codeInsertError) { showToast("Failed to create invite code: " + codeInsertError.message, "error"); return; }',
        'if (codeInsertError) { pmError("PM-3007", { raw: codeInsertError, context: "create tenant invite code" }); return; }',
    ),
    # 4989: Send tenant invitation email
    (
        'showToast("Failed to send invitation email to " + tenant.email + ": " + authErr.message + "\\n\\nPlease verify the email address and try again. No access records were created.", "error");',
        'pmError("PM-3007", { raw: authErr, context: "send invitation to " + tenant.email });',
        1,  # first match only (tenant invitation)
    ),
    # 5104: Send message
    (
        'if (_err_messages_1499) { showToast("Failed to send message: " + _err_messages_1499.message, "error"); return; }',
        'if (_err_messages_1499) { pmError("PM-8006", { raw: _err_messages_1499, context: "send tenant message" }); return; }',
    ),
    # 5167: Renew lease
    (
        'if (error) { showToast("Failed to renew lease: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-3004", { raw: error, context: "renew lease" }); return; }',
    ),
    # 5200: Generate notice
    (
        'if (error) { showToast("Failed to generate notice: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-3006", { raw: error, context: "generate move-out notice" }); return; }',
    ),
    # 5574: Delete document (inspections)
    (
        'showToast("Error deleting document: " + error.message, "error")',
        'pmError("PM-7004", { raw: error, context: "delete document" })',
    ),
    # 9652: JE creation error
    (
        'if (jeErr || !jeRow) { showToast("Error: " + (jeErr?.message || ""), "error"); return; }',
        'if (jeErr || !jeRow) { pmError("PM-4002", { raw: jeErr, context: "create journal entry" }); return; }',
    ),
    # 9959: Bank rule create
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n      showToast("Rule created',
        'if (error) { pmError("PM-5008", { raw: error, context: "create bank rule" }); return; }\n      showToast("Rule created',
    ),
    # 9963: Bank rule update
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n      showToast("Rule updated',
        'if (error) { pmError("PM-5008", { raw: error, context: "update bank rule" }); return; }\n      showToast("Rule updated',
    ),
    # 9974: Delete bank rule
    (
        'if (error) { showToast("Error deleting rule: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-5008", { raw: error, context: "delete bank rule" }); return; }',
    ),
    # 9990: Duplicate bank rule
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n    showToast("Rule duplicated',
        'if (error) { pmError("PM-5008", { raw: error, context: "duplicate bank rule" }); return; }\n    showToast("Rule duplicated',
    ),
    # 10909: Default accounts creation
    (
        'if (accounts.length === 0) showToast("Failed to create default accounts. Check browser console for details.", "error");',
        'if (accounts.length === 0) pmError("PM-4006", { raw: { message: "No accounts created" }, context: "create default chart of accounts" });',
    ),
    # 11015: Create account
    (
        'if (error) { showToast("Error creating account: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-4006", { raw: error, context: "create account" }); return; }',
    ),
    # 11025: Update account
    (
        'if (error) { showToast("Error updating account: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-4006", { raw: error, context: "update account" }); return; }',
    ),
    # 11163: Create class
    (
        'if (error) { showToast("Error creating class: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-4010", { raw: error, context: "create accounting class" }); return; }',
    ),
    # 11173: Update class
    (
        'if (error) { showToast("Error updating class: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-4010", { raw: error, context: "update accounting class" }); return; }',
    ),
    # 11454: Delete document (another instance — already caught above by replace_all)
    # Handled by the earlier "Error deleting document" replace_all

    # 11623: Save inspection
    (
        'if (error) { showToast("Error saving inspection: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-7001", { raw: error, context: "save inspection" }); return; }',
    ),
    # 11747: Create work order from inspection
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast("Work order created',
        'if (error) { pmError("PM-7001", { raw: error, context: "create work order from inspection" }); return; }\n  showToast("Work order created',
    ),
    # 11886: Save lease
    (
        'if (error) { showToast("Error saving lease: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-3004", { raw: error, context: "save lease" }); return; }',
    ),
    # 12078: Save lease template
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast(editingTemplate ? "Template updated',
        'if (error) { pmError("PM-3004", { raw: error, context: "save lease template" }); return; }\n  showToast(editingTemplate ? "Template updated',
    ),
    # 12362: Create/update vendor
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast(editingVendor ? "Vendor updated',
        'if (error) { pmError("PM-8006", { raw: error, context: editingVendor ? "update vendor" : "create vendor" }); return; }\n  showToast(editingVendor ? "Vendor updated',
    ),
    # 12412: Create vendor invoice
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast("Invoice saved',
        'if (error) { pmError("PM-8006", { raw: error, context: "save vendor invoice" }); return; }\n  showToast("Invoice saved',
    ),
    # 12471: Update vendor rating
    (
        'if (error) { showToast("Failed to update rating: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-8006", { raw: error, context: "update vendor rating" }); return; }',
    ),
    # 12739: Create/update owner
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast(editingOwner ? "Owner updated',
        'if (error) { pmError("PM-8006", { raw: error, context: editingOwner ? "update owner" : "create owner" }); return; }\n  showToast(editingOwner ? "Owner updated',
    ),
    # 12768: Owner invitation
    (
        'showToast("Failed to send invitation email to " + owner.email + ": " + authErr.message + "\\n\\nPlease verify the email address and try again. No access records were created.", "error");',
        'pmError("PM-1007", { raw: authErr, context: "send invitation to " + owner.email });',
    ),
    # 12842: Generate owner statement
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast("Statement generated',
        'if (error) { pmError("PM-8006", { raw: error, context: "generate owner statement" }); return; }\n  showToast("Statement generated',
    ),
    # 12850: Mark statement sent
    (
        'if (error) { showToast("Failed to mark statement as sent: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-8006", { raw: error, context: "mark owner statement as sent" }); return; }',
    ),
    # 13162: Lock accounting period
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast(editingLock',
        'if (error) { pmError("PM-4011", { raw: error, context: "lock/unlock accounting period" }); return; }\n  showToast(editingLock',
    ),
    # 13286: Reconcile transactions
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast("Reconciliation saved',
        'if (error) { pmError("PM-8006", { raw: error, context: "save reconciliation" }); return; }\n  showToast("Reconciliation saved',
    ),
    # 14955: Restore item
    (
        'showToast("Failed to restore: " + error.message, "error");',
        'pmError("PM-2004", { raw: error, context: "restore archived item" });',
    ),
    # 14991: Permanent delete
    (
        'if (error) { showToast("Failed to delete: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-8006", { raw: error, context: "permanent delete" }); return; }',
    ),
    # 15125: Save autopay schedule
    (
        'if (error) { showToast("Error saving schedule: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-6001", { raw: error, context: "save autopay schedule" }); return; }',
    ),
    # 15164: Process autopay payment
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast("Payment processed',
        'if (error) { pmError("PM-6001", { raw: error, context: "process autopay payment" }); return; }\n  showToast("Payment processed',
    ),
    # 15358: Create late fee rule
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast(editingRule ? "Rule updated',
        'if (error) { pmError("PM-6003", { raw: error, context: "save late fee rule" }); return; }\n  showToast(editingRule ? "Rule updated',
    ),
    # 15632: Tenant portal submit maintenance request
    (
        'if (error) { showToast("Error submitting request: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-7001", { raw: error, context: "submit maintenance request" }); return; }',
    ),
    # 15819: Enable autopay catch
    (
        '} catch (e) { showToast("Error: " + e.message, "error"); }',
        '} catch (e) { pmError("PM-6001", { raw: e, context: "enable autopay" }); }',
    ),
    # 16074: Update user email RPC
    (
        'showToast("Failed to update user email: " + rpcE.message + "\\n\\nNo changes were made. Please ensure the database is properly configured.", "error");',
        'pmError("PM-1009", { raw: rpcE, context: "update user email via RPC" });',
    ),
    # 16080: Save team member (first "Error: " + error.message after email update)
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast(editingUser ? "User updated',
        'if (error) { pmError("PM-1009", { raw: error, context: editingUser ? "update team member" : "create team member" }); return; }\n  showToast(editingUser ? "User updated',
    ),
    # 16086: the second error line right after
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  const { error: memErr',
        'if (error) { pmError("PM-1009", { raw: error, context: "create team member app_users record" }); return; }\n  const { error: memErr',
    ),
    # 16131: Send user/team invitation
    (
        'showToast("Failed to send invitation email to " + user.email + ": " + authErr.message + "\\n\\nPlease verify the email address and try again. No access records were created.", "error");',
        'pmError("PM-1007", { raw: authErr, context: "send team invitation to " + user.email });',
    ),
    # 16747: Create eviction case
    (
        'if (error) { showToast("Error creating eviction case: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-8006", { raw: error, context: "create eviction case" }); return; }',
    ),
    # 16841: Update eviction case
    (
        'if (error) { showToast("Error updating case: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-8006", { raw: error, context: "update eviction case stage" }); return; }',
    ),
    # 17599: Save generated document
    (
        'if (error) { showToast("Error saving document: " + error.message, "error"); return null; }',
        'if (error) { pmError("PM-7003", { raw: error, context: "save generated document" }); return null; }',
    ),
    # 17660: PDF export
    (
        'showToast("PDF export failed: " + err.message, "error");',
        'pmError("PM-8006", { raw: err, context: "PDF export" });',
    ),
    # 17785: Email document
    (
        'if (error) showToast("Failed to email " + email + ": " + error.message, "error");',
        'if (error) pmError("PM-1007", { raw: error, context: "email document to " + email });',
    ),
    # 17809: Update document template
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast("Template updated',
        'if (error) { pmError("PM-8006", { raw: error, context: "update document template" }); return; }\n  showToast("Template updated',
    ),
    # 17814: Create document template
    (
        'if (error) { showToast("Error: " + error.message, "error"); return; }\n  showToast("Template created',
        'if (error) { pmError("PM-8006", { raw: error, context: "create document template" }); return; }\n  showToast("Template created',
    ),
    # 18929: Update profile
    (
        'if (error) showToast("Failed to update profile: " + error.message, "error");',
        'if (error) pmError("PM-1009", { raw: error, context: "update user profile" });',
    ),
    # 18936: Send password reset
    (
        'if (error) showToast("Failed to send reset email: " + error.message, "error");',
        'if (error) pmError("PM-1004", { raw: error, context: "send password reset email" });',
    ),
    # 18948: Upload avatar
    (
        'if (error) { showToast("Upload failed: " + error.message, "error"); setUploading(false); return; }',
        'if (error) { pmError("PM-7002", { raw: error, context: "upload avatar" }); setUploading(false); return; }',
    ),
    # 19244: Submit join request
    (
        'showToast("Failed to submit join request: " + e.message + ". Please ensure the membership RPCs are deployed.", "error");',
        'pmError("PM-8003", { raw: e, context: "submit company join request" });',
    ),
    # 19475: Process membership request
    (
        'showToast("Failed to process request: " + e.message + ". Please ensure the membership RPCs are deployed.", "error");',
        'pmError("PM-8003", { raw: e, context: "process membership request" });',
    ),
    # 19538: Decline PM request
    (
        'if (error) { showToast("Error declining: " + error.message, "error"); return; }',
        'if (error) { pmError("PM-8006", { raw: error, context: "decline membership request" }); return; }',
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
