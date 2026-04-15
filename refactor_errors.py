#!/usr/bin/env python3
"""
Replace remaining console.warn/console.error calls with pmError() in App.js.
Each replacement is mapped by unique string match to the correct PM error code.
"""

import re

FILE = "src/App.js"

# Each tuple: (unique_old_string, new_string)
# We match EXACT substrings to avoid ambiguity
REPLACEMENTS = [
    # Line ~298: Missing RPCs
    (
        'console.warn("Missing RPCs:", missing.join(", "));',
        'pmError("PM-8003", { raw: { message: "Missing RPCs: " + missing.join(", ") }, context: "RPC health check", silent: true });',
    ),
    # Line ~507: Signed URL
    (
        'if (error) { console.warn("Signed URL failed for", filePath, error.message); return ""; }',
        'if (error) { pmError("PM-8006", { raw: error, context: "signed URL for " + filePath, silent: true }); return ""; }',
    ),
    # Line ~622-623: logAudit validation
    (
        'if (!AUDIT_ACTIONS.has(action)) { console.warn("logAudit: invalid action:", action); return; }',
        'if (!AUDIT_ACTIONS.has(action)) { pmError("PM-9001", { raw: { message: "invalid audit action: " + action }, context: "logAudit validation", silent: true }); return; }',
    ),
    (
        'if (!AUDIT_MODULES.has(module)) { console.warn("logAudit: invalid module:", module); return; }',
        'if (!AUDIT_MODULES.has(module)) { pmError("PM-9001", { raw: { message: "invalid audit module: " + module }, context: "logAudit validation", silent: true }); return; }',
    ),
    # Line ~628: logAudit missing companyId
    (
        'if (!companyId) { console.warn("logAudit: missing companyId — skipping"); return; }',
        'if (!companyId) { pmError("PM-9001", { raw: { message: "missing companyId" }, context: "logAudit", silent: true }); return; }',
    ),
    # Line ~633: Audit log insert
    (
        'if (_err130) console.warn("Audit log insert failed:", _err130.message);',
        'if (_err130) pmError("PM-8006", { raw: _err130, context: "audit log insert", silent: true });',
    ),
    # Line ~634: Audit log catch
    (
        '} catch (e) { console.warn("Audit log failed:", e); }',
        '} catch (e) { pmError("PM-8006", { raw: e, context: "audit log", silent: true }); }',
    ),
    # Line ~648: autoPostJournalEntry missing companyId
    (
        'if (!companyId) { console.error("autoPostJournalEntry: missing companyId — blocked"); return null; }',
        'if (!companyId) { pmError("PM-4002", { raw: { message: "missing companyId" }, context: "autoPostJournalEntry", silent: true }); return null; }',
    ),
    # Line ~650: period lock
    (
        'if (await checkPeriodLock(companyId, date)) { console.warn("autoPostJournalEntry: blocked by period lock (date: " + date + ")"); return null; }',
        'if (await checkPeriodLock(companyId, date)) { pmError("PM-4004", { raw: { message: "blocked by period lock" }, context: "autoPostJournalEntry, date: " + date, silent: true }); return null; }',
    ),
    # Line ~671: JE insert failed
    (
        'if (jeErr || !jeRow) { console.error("Journal entry insert failed:", jeErr?.message); return null; }',
        'if (jeErr || !jeRow) { pmError("PM-4002", { raw: jeErr, context: "journal entry insert" }); return null; }',
    ),
    # Line ~681: Journal lines insert
    (
        'console.error("Journal lines insert failed:", lineErr.message);',
        'pmError("PM-4003", { raw: lineErr, context: "journal lines insert" });',
    ),
    # Line ~688: Auto-post JE catch
    (
        '} catch (e) { console.error("Auto-post JE failed:", e); return null; }',
        '} catch (e) { pmError("PM-4002", { raw: e, context: "auto-post journal entry" }); return null; }',
    ),
    # Line ~736: Email queue
    (
        'if (_notifWriteErr) console.warn("Email queue failed:", _notifWriteErr.message);',
        'if (_notifWriteErr) pmError("PM-8006", { raw: _notifWriteErr, context: "email queue insert", silent: true });',
    ),
    # Line ~787: Owner dist JE failed
    (
        'if (!jeId) { console.warn("Owner distribution JE failed — skipping distribution record"); return; }',
        'if (!jeId) { pmError("PM-6004", { raw: { message: "JE failed" }, context: "owner distribution — skipping record", silent: true }); return; }',
    ),
    # Line ~793: Owner dist insert
    (
        'if (distErr) console.warn("Owner dist insert:", distErr.message);',
        'if (distErr) pmError("PM-6004", { raw: distErr, context: "owner distribution insert", silent: true });',
    ),
    # Line ~867: resolveAccountId auto-create
    (
        'if (createErr) console.warn("resolveAccountId: auto-create failed for", bareCode, createErr.message);',
        'if (createErr) pmError("PM-4006", { raw: createErr, context: "resolveAccountId auto-create for " + bareCode, silent: true });',
    ),
    # Line ~912: AR sub-account creation
    (
        'console.warn("AR sub-account creation failed after 3 attempts:", createErr?.message);',
        'pmError("PM-4006", { raw: createErr, context: "AR sub-account creation after 3 attempts", silent: true });',
    ),
    # Line ~996: Recurring balance update (inline .catch)
    (
        '.catch(e => console.warn("Recurring balance update:", e.message))',
        '.catch(e => pmError("PM-6002", { raw: e, context: "recurring balance update", silent: true }))',
    ),
    # Line ~1005: Auto recurring entries
    (
        '} catch (e) { console.warn("Auto recurring entries failed:", e); return { posted: 0 }; }',
        '} catch (e) { pmError("PM-4008", { raw: e, context: "auto recurring entries", silent: true }); return { posted: 0 }; }',
    ),
    # Line ~1518: Auto-join from invite
    (
        'if (memErr) console.warn("Auto-join from invite failed:", memErr.message);',
        'if (memErr) pmError("PM-1006", { raw: memErr, context: "auto-join from invite", silent: true });',
    ),
    # Line ~1526: app_users write
    (
        'if (appUserErr && !appUserErr.message.includes("duplicate")) { console.warn("app_users write failed:", appUserErr.message); }',
        'if (appUserErr && !appUserErr.message.includes("duplicate")) { pmError("PM-1009", { raw: appUserErr, context: "app_users write", silent: true }); }',
    ),
    # Line ~1666: Approval count
    (
        '} catch (e) { console.warn("Approval count:", e); }',
        '} catch (e) { pmError("PM-8006", { raw: e, context: "approval count fetch", silent: true }); }',
    ),
    # Line ~1686: Dashboard accounting fetch
    (
        '} catch(e) { console.warn("Dashboard accounting fetch:", e); }',
        '} catch(e) { pmError("PM-4002", { raw: e, context: "dashboard accounting fetch", silent: true }); }',
    ),
    # Line ~1968: Wizard persistence init (the one that remains)
    (
        'if (error) console.warn("Wizard persistence init failed:", error.message);',
        'if (error) pmError("PM-2007", { raw: error, context: "wizard persistence init", silent: true });',
    ),
    # Line ~2219: Class creation in wizard
    (
        'if (insClsErr) console.warn("Class creation failed:", insClsErr.message);',
        'if (insClsErr) pmError("PM-4010", { raw: insClsErr, context: "accounting class creation in wizard", silent: true });',
    ),
    # Line ~3502: Auto rent post after property save
    (
        '} catch (e) { console.warn("Auto rent post after property save:", e.message); }',
        '} catch (e) { pmError("PM-4008", { raw: e, context: "auto rent post after property save", silent: true }); }',
    ),
    # Line ~3519: Property rename RPC
    (
        'console.warn("Property rename RPC failed, running client-side fallback:", renameErr.message);',
        'pmError("PM-2006", { raw: renameErr, context: "property rename RPC, running client-side fallback", silent: true });',
    ),
    # Line ~3538: Rename failures
    (
        'console.error("Rename failures:", renameFails.map(r => r.reason?.message || r.reason));',
        'pmError("PM-2006", { raw: { message: renameFails.map(r => r.reason?.message || r.reason).join("; ") }, context: "property rename failures", silent: true });',
    ),
    # Line ~3587: saveProperty error
    (
        'console.error("saveProperty error:", e);',
        'pmError("PM-2002", { raw: e, context: "saveProperty" });',
    ),
    # Line ~3754: Accounting class creation
    (
        'if (classErr) console.warn("Accounting class creation failed:", classErr.message);',
        'if (classErr) pmError("PM-4010", { raw: classErr, context: "accounting class creation", silent: true });',
    ),
    # Line ~4761: Tenants property fetch
    (
        'if (error) console.warn("Tenants property fetch:", error.message); setProperties(data || []);',
        'if (error) pmError("PM-8006", { raw: error, context: "tenants property fetch", silent: true }); setProperties(data || []);',
    ),
    # Line ~4846: Auto rent charge posting (.catch)
    (
        '.catch(e => console.warn("Auto rent charge posting failed:", e.message))',
        '.catch(e => pmError("PM-4008", { raw: e, context: "auto rent charge posting", silent: true }))',
    ),
    # Line ~4864: Tenant rename RPC
    (
        'console.warn("Tenant rename RPC failed, running client-side fallback:", tenantRenameErr.message);',
        'pmError("PM-3002", { raw: tenantRenameErr, context: "tenant rename RPC, running client-side fallback", silent: true });',
    ),
    # Line ~4891: saveTenant error
    (
        'console.error("saveTenant error:", e);',
        'pmError("PM-3002", { raw: e, context: "saveTenant" });',
    ),
    # Line ~4936: Property to vacant
    (
        'if (propErr) console.warn("Failed to update property to vacant:", propErr.message);',
        'if (propErr) pmError("PM-2002", { raw: propErr, context: "update property to vacant", silent: true });',
    ),
    # Line ~4940: Terminate leases
    (
        'if (leaseErr) console.warn("Failed to terminate leases:", leaseErr.message);',
        'if (leaseErr) pmError("PM-3004", { raw: leaseErr, context: "terminate leases on archive", silent: true });',
    ),
    # Line ~4954: Balance zero-out (.catch)
    (
        '.catch(e => console.warn("Balance zero-out:", e.message))',
        '.catch(e => pmError("PM-6002", { raw: e, context: "balance zero-out on archive", silent: true }))',
    ),
    # Line ~5099: messages write
    (
        'if (_err1494) console.warn("messages write failed:", _err1494.message);',
        'if (_err1494) pmError("PM-8006", { raw: _err1494, context: "messages write", silent: true });',
    ),
    # Line ~10914: Default account insert
    (
        'if (insErr) console.warn("Default account insert failed for " + acct.code + ":", insErr.message);',
        'if (insErr) pmError("PM-4006", { raw: insErr, context: "default account insert for " + acct.code, silent: true });',
    ),
    # Line ~10993: Backfilled class_id (informational — keep as silent)
    (
        'if (patched > 0) console.warn("Backfilled class_id on " + patched + " JE lines via property→class_id");',
        'if (patched > 0) pmError("PM-9001", { raw: { message: "Backfilled class_id on " + patched + " JE lines" }, context: "JE lines class_id backfill", silent: true });',
    ),
    # Line ~11099: acct_journal_lines write
    (
        'if (_err3930) console.warn("acct_journal_lines write failed:", _err3930.message);',
        'if (_err3930) pmError("PM-4003", { raw: _err3930, context: "acct_journal_lines write", silent: true });',
    ),
    # Line ~11103: Update lines failed, restoring
    (
        'console.warn("Update lines failed, restoring:", linesErr.message);',
        'pmError("PM-4003", { raw: linesErr, context: "update journal lines failed, restoring" });',
    ),
    # Line ~11153: Void balance RPC
    (
        '} catch (e) { console.warn("Void balance RPC error:", e.message); }',
        '} catch (e) { pmError("PM-6002", { raw: e, context: "void balance RPC", silent: true }); }',
    ),
    # Line ~11873: Tenant status update
    (
        'if (tenantErr) console.warn("Tenant status update failed:", tenantErr.message);',
        'if (tenantErr) pmError("PM-3002", { raw: tenantErr, context: "tenant status update", silent: true });',
    ),
    # Line ~12448: Vendor increment RPC fallback
    (
        'console.warn("Vendor increment RPC fallback:", rpcE.message);',
        'pmError("PM-8006", { raw: rpcE, context: "vendor increment RPC fallback", silent: true });',
    ),
    # Line ~12455: Vendor totals fallback
    (
        'if (_vendErr) console.warn("Vendor totals fallback update failed:", _vendErr.message);',
        'if (_vendErr) pmError("PM-8006", { raw: _vendErr, context: "vendor totals fallback update", silent: true });',
    ),
    # Line ~13326: Lock bank feed transactions
    (
        'if (lockErr) console.warn("Failed to lock bank feed transactions:", lockErr.message);',
        'if (lockErr) pmError("PM-5006", { raw: lockErr, context: "lock bank feed transactions", silent: true });',
    ),
    # Line ~13509: fetchQueueStatus
    (
        '} catch (e) { console.warn("fetchQueueStatus:", e.message); }',
        '} catch (e) { pmError("PM-8006", { raw: e, context: "fetch notification queue status", silent: true }); }',
    ),
    # Line ~13545: notification_settings write (3 instances)
    (
        'if (_err6051) console.warn("notification_settings write failed:", _err6051.message);',
        'if (_err6051) pmError("PM-8006", { raw: _err6051, context: "notification_settings write", silent: true });',
    ),
    (
        'if (_err6056) console.warn("notification_settings write failed:", _err6056.message);',
        'if (_err6056) pmError("PM-8006", { raw: _err6056, context: "notification_settings write", silent: true });',
    ),
    (
        'if (_err6061) console.warn("notification_settings write failed:", _err6061.message);',
        'if (_err6061) pmError("PM-8006", { raw: _err6061, context: "notification_settings write", silent: true });',
    ),
    # Line ~13571: notification_log write
    (
        'if (_err_notification_log_6067) console.warn("notification_log write failed:", _err_notification_log_6067.message);',
        'if (_err_notification_log_6067) pmError("PM-8006", { raw: _err_notification_log_6067, context: "notification_log write", silent: true });',
    ),
    # Line ~13612: notification_log write
    (
        'if (_err6104) console.warn("notification_log write failed:", _err6104.message);',
        'if (_err6104) pmError("PM-8006", { raw: _err6104, context: "notification_log write", silent: true });',
    ),
    # Line ~13636: notification_log write
    (
        'if (_err6121) console.warn("notification_log write failed:", _err6121.message);',
        'if (_err6121) pmError("PM-8006", { raw: _err6121, context: "notification_log write", silent: true });',
    ),
    # Line ~14976: Restore tenant
    (
        'if (tErr) console.warn("Failed to restore tenant:", t.name, tErr.message);',
        'if (tErr) pmError("PM-3002", { raw: tErr, context: "restore tenant " + t.name, silent: true });',
    ),
    # Line ~14980: Restore leases
    (
        'if (lErr) console.warn("Failed to restore leases:", lErr.message);',
        'if (lErr) pmError("PM-3004", { raw: lErr, context: "restore leases", silent: true });',
    ),
    # Line ~14988: Update property on restore
    (
        'if (propErr) console.warn("Failed to update property:", propErr.message);',
        'if (propErr) pmError("PM-2002", { raw: propErr, context: "update property on restore", silent: true });',
    ),
    # Line ~15382: Late fee already applied
    (
        'console.warn("Late fee already applied for " + payment.tenant + " this month");',
        'pmError("PM-9005", { raw: { message: "Late fee already applied for " + payment.tenant + " this month" }, context: "late fee duplicate check", silent: true });',
    ),
    # Line ~15592: Stripe edge function
    (
        '} catch (stripeErr) { console.warn("Stripe Edge Function not available, using fallback:", stripeErr.message); }',
        '} catch (stripeErr) { pmError("PM-8006", { raw: stripeErr, context: "Stripe edge function, using fallback", silent: true }); }',
    ),
    # Line ~15655: messages write
    (
        'if (_err7538) console.warn("messages write failed:", _err7538.message);',
        'if (_err7538) pmError("PM-8006", { raw: _err7538, context: "messages write", silent: true });',
    ),
    # Line ~16456: Balance update on move-out credit
    (
        '.catch(e => console.warn("Balance update failed:", e.message))',
        '.catch(e => pmError("PM-6002", { raw: e, context: "balance update on move-out credit", silent: true }))',
    ),
    # Line ~16488: Move-out partial failure
    (
        'console.error("Move-out partial failure:", stepErr, "Completed steps:", completedSteps);',
        'pmError("PM-3006", { raw: stepErr, context: "move-out partial failure, completed: " + completedSteps.join(", "), silent: true });',
    ),
    # Line ~17669: PDF export error
    (
        'console.error("PDF export error:", err);',
        'pmError("PM-8006", { raw: err, context: "PDF export" });',
    ),
    # Line ~18616: Tasks fetch
    (
        '} catch (e) { console.warn("Tasks fetch:", e); }',
        '} catch (e) { pmError("PM-8006", { raw: e, context: "tasks fetch", silent: true }); }',
    ),
    # Line ~19177: create_company_atomic RPC
    (
        'console.warn("RPC create_company_atomic failed, using client-side fallback:", rpcE.message);',
        'pmError("PM-8003", { raw: rpcE, context: "create_company_atomic RPC, using client-side fallback", silent: true });',
    ),
    # Line ~19777: ensureDefaultAccounts insert
    (
        'if (error) console.warn("ensureDefaultAccounts insert failed for " + row.code + ":", error.message);',
        'if (error) pmError("PM-4006", { raw: error, context: "ensureDefaultAccounts insert for " + row.code, silent: true });',
    ),
    # Line ~19810: Auto rent charges (.catch)
    (
        '.catch(e => console.warn("Auto rent charges:", e.message))',
        '.catch(e => pmError("PM-4008", { raw: e, context: "auto rent charges on login", silent: true }))',
    ),
    # Line ~19812: Auto recurring entries (.catch)
    (
        '.catch(e => console.warn("Auto recurring entries:", e.message))',
        '.catch(e => pmError("PM-4008", { raw: e, context: "auto recurring entries on login", silent: true }))',
    ),
    # Line ~19814: COA seed (.catch)
    (
        '.catch(e => console.warn("COA seed:", e.message))',
        '.catch(e => pmError("PM-4006", { raw: e, context: "chart of accounts seed", silent: true }))',
    ),
    # Line ~19833: auth_user_id backfill
    (
        'if (uidErr) console.warn("auth_user_id backfill failed:", uidErr.message);',
        'if (uidErr) pmError("PM-1009", { raw: uidErr, context: "auth_user_id backfill", silent: true });',
    ),
    # Line ~19861: Inbox write
    (
        'if (error) console.warn("Inbox write:", error.message);',
        'if (error) pmError("PM-8006", { raw: error, context: "inbox write", silent: true });',
    ),
    # Line ~19870: Push notifications not supported
    (
        'console.warn("Push notifications not supported");',
        'pmError("PM-8006", { raw: { message: "Push notifications not supported" }, context: "push registration", silent: true });',
    ),
    # Line ~19875: Push permission denied
    (
        'if (permission !== "granted") { console.warn("Push permission denied"); return; }',
        'if (permission !== "granted") { pmError("PM-8006", { raw: { message: "Push permission denied" }, context: "push registration", silent: true }); return; }',
    ),
    # Line ~19880: VAPID key not configured
    (
        'if (!VAPID_PUBLIC_KEY) { console.warn("VAPID key not configured — push disabled"); return; }',
        'if (!VAPID_PUBLIC_KEY) { pmError("PM-8006", { raw: { message: "VAPID key not configured" }, context: "push registration", silent: true }); return; }',
    ),
    # Line ~19902: Push subscription save
    (
        'if (error) console.warn("Push subscription save:", error.message);',
        'if (error) pmError("PM-8006", { raw: error, context: "push subscription save", silent: true });',
    ),
    # Line ~19906: Push registration failed
    (
        '} catch (e) { console.warn("Push registration failed:", e.message); }',
        '} catch (e) { pmError("PM-8006", { raw: e, context: "push registration", silent: true }); }',
    ),
    # Line ~19965: Auto notification check
    (
        '} catch (e) { console.warn("Auto notification check:", e.message); }',
        '} catch (e) { pmError("PM-8006", { raw: e, context: "auto notification check", silent: true }); }',
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
            # Multiple matches — replace all (these are unique enough)
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
