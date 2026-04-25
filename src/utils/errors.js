import { supabase } from "../supabase";
import { setHelperPmError } from "./helpers";

// ============ ERROR MANAGEMENT SYSTEM ============
// Severity convention:
//   critical = financial integrity / data loss / money at risk. Pages Sentry as fatal.
//   error    = user-visible failure that blocks the flow.
//   warning  = recoverable / validation / retry-likely-to-succeed.
//   info     = housekeeping; not shipped to Sentry.
export const PM_ERRORS = {
  // PM-1xxx: AUTH & ACCESS
  "PM-1001": { message: "Your session has expired. Please sign in again.", action: "reload", severity: "warning", module: "auth" },
  "PM-1002": { message: "You don't have permission to perform this action.", action: "none", severity: "error", module: "auth" },
  "PM-1003": { message: "This account is already registered. Try signing in instead.", action: "none", severity: "warning", module: "auth" },
  "PM-1004": { message: "Invalid email or password. Please try again.", action: "retry", severity: "warning", module: "auth" },
  "PM-1005": { message: "Your account doesn't have access to this company.", action: "contact", severity: "error", module: "auth" },
  "PM-1006": { message: "This invitation link has expired or was already used.", action: "contact", severity: "warning", module: "auth" },
  "PM-1007": { message: "Unable to send the invitation email. Please verify the email address.", action: "retry", severity: "error", module: "auth" },
  "PM-1008": { message: "You need to be an Admin to change user roles.", action: "none", severity: "error", module: "auth" },
  "PM-1009": { message: "Could not create user account. The email may already be in use.", action: "retry", severity: "error", module: "auth" },
  // PM-2xxx: PROPERTIES
  "PM-2001": { message: "A property with this address already exists.", action: "none", severity: "warning", module: "properties" },
  "PM-2002": { message: "Could not save the property. Please check all required fields.", action: "retry", severity: "error", module: "properties" },
  "PM-2003": { message: "Could not archive this property. It may have active tenants.", action: "none", severity: "error", module: "properties" },
  "PM-2004": { message: "Could not restore this property.", action: "retry", severity: "error", module: "properties" },
  "PM-2005": { message: "Property was saved but the accounting class could not be linked.", action: "contact", severity: "warning", module: "properties" },
  "PM-2006": { message: "Could not update related records after renaming the property address.", action: "contact", severity: "warning", module: "properties" },
  "PM-2007": { message: "Could not load the property setup wizard.", action: "retry", severity: "error", module: "properties" },
  "PM-2008": { message: "Property was saved but the lease record could not be created.", action: "contact", severity: "warning", module: "properties" },
  // PM-3xxx: TENANTS & LEASES
  "PM-3001": { message: "A tenant with this name already exists at this property.", action: "none", severity: "warning", module: "tenants" },
  "PM-3002": { message: "Could not save the tenant record.", action: "retry", severity: "error", module: "tenants" },
  "PM-3003": { message: "Could not archive this tenant.", action: "retry", severity: "error", module: "tenants" },
  "PM-3004": { message: "Could not create or renew the lease.", action: "retry", severity: "error", module: "tenants" },
  "PM-3005": { message: "Required documents are missing. Please upload all mandatory documents before proceeding.", action: "none", severity: "warning", module: "tenants" },
  "PM-3006": { message: "Could not generate the move-out notice.", action: "retry", severity: "error", module: "tenants" },
  "PM-3007": { message: "Could not send tenant invitation.", action: "retry", severity: "error", module: "tenants" },
  "PM-3008": { message: "Lease was renewed but the old lease status could not be updated.", action: "contact", severity: "warning", module: "tenants" },
  // PM-4xxx: ACCOUNTING & JE
  "PM-4001": { message: "This journal entry is out of balance. Debits must equal credits.", action: "retry", severity: "error", module: "accounting" },
  "PM-4002": { message: "Could not save the journal entry.", action: "retry", severity: "error", module: "accounting" },
  "PM-4003": { message: "Could not save the journal entry lines.", action: "contact", severity: "critical", module: "accounting" },
  "PM-4004": { message: "This date falls in a locked accounting period. Unlock it first or use a later date.", action: "none", severity: "warning", module: "accounting" },
  "PM-4005": { message: "Could not void this journal entry.", action: "retry", severity: "error", module: "accounting" },
  "PM-4006": { message: "Could not save the account. It may conflict with an existing one.", action: "retry", severity: "error", module: "accounting" },
  "PM-4008": { message: "Could not create the recurring journal entry template.", action: "retry", severity: "error", module: "accounting" },
  "PM-4010": { message: "Could not save the accounting class.", action: "retry", severity: "error", module: "accounting" },
  "PM-4011": { message: "Could not lock/unlock the accounting period.", action: "retry", severity: "error", module: "accounting" },
  "PM-4012": { message: "Journal entry was created but lines could not be saved. The entry has been rolled back.", action: "contact", severity: "critical", module: "accounting" },
  // PM-5xxx: BANKING & IMPORT
  "PM-5001": { message: "Could not parse the CSV file. Check the format and try again.", action: "retry", severity: "error", module: "banking" },
  "PM-5002": { message: "Could not import transactions. Some rows may have been skipped.", action: "retry", severity: "warning", module: "banking" },
  "PM-5003": { message: "Could not connect to your bank. Please try again.", action: "retry", severity: "error", module: "banking" },
  "PM-5004": { message: "Bank sync failed. Your bank may require re-authentication.", action: "retry", severity: "error", module: "banking" },
  "PM-5005": { message: "Could not categorize this transaction.", action: "retry", severity: "error", module: "banking" },
  "PM-5006": { message: "Could not create the bank account feed.", action: "retry", severity: "error", module: "banking" },
  "PM-5007": { message: "This transaction has already been processed.", action: "none", severity: "warning", module: "banking" },
  "PM-5008": { message: "Could not save the bank rule.", action: "retry", severity: "error", module: "banking" },
  "PM-5009": { message: "Could not match this transaction.", action: "retry", severity: "error", module: "banking" },
  "PM-5010": { message: "Split total doesn't match the transaction amount.", action: "retry", severity: "warning", module: "banking" },
  // PM-6xxx: PAYMENTS & LEDGER — financial integrity: partial-post failures are critical
  "PM-6001": { message: "Could not record the payment.", action: "retry", severity: "error", module: "payments" },
  "PM-6002": { message: "Could not update the tenant balance.", action: "contact", severity: "critical", module: "payments" },
  "PM-6003": { message: "Could not post the late fee.", action: "retry", severity: "error", module: "payments" },
  "PM-6004": { message: "Could not process the owner distribution.", action: "contact", severity: "critical", module: "payments" },
  "PM-6005": { message: "Could not create the ledger entry.", action: "retry", severity: "error", module: "payments" },
  "PM-6006": { message: "Payment was recorded but the accounting entry could not be posted.", action: "contact", severity: "critical", module: "payments" },
  // PM-7xxx: WORK ORDERS & DOCS
  "PM-7001": { message: "Could not save the work order.", action: "retry", severity: "error", module: "work_orders" },
  "PM-7002": { message: "Could not upload the file. Check the file size and type.", action: "retry", severity: "error", module: "work_orders" },
  "PM-7003": { message: "File was uploaded but the record could not be saved.", action: "contact", severity: "warning", module: "work_orders" },
  "PM-7004": { message: "Could not delete the document.", action: "retry", severity: "error", module: "work_orders" },
  "PM-7005": { message: "Could not load work orders.", action: "retry", severity: "error", module: "work_orders" },
  "PM-7006": { message: "Could not save the inspection.", action: "retry", severity: "error", module: "work_orders" },
  // PM-8xxx: NETWORK & INFRASTRUCTURE
  "PM-8001": { message: "Unable to reach the server. Check your internet connection and try again.", action: "retry", severity: "error", module: "infrastructure" },
  "PM-8002": { message: "A required database table is missing. Please contact support.", action: "contact", severity: "critical", module: "infrastructure" },
  "PM-8003": { message: "A required server function is missing. Please contact support.", action: "contact", severity: "critical", module: "infrastructure" },
  "PM-8004": { message: "The request timed out. Please try again.", action: "retry", severity: "warning", module: "infrastructure" },
  "PM-8005": { message: "A database permission error occurred. Your access may need to be updated.", action: "contact", severity: "error", module: "infrastructure" },
  "PM-8006": { message: "Could not save your changes. The server returned an unexpected response.", action: "retry", severity: "error", module: "infrastructure" },
  "PM-8007": { message: "An internal validation check failed. The action was not performed.", action: "contact", severity: "warning", module: "infrastructure" },
  "PM-8009": { message: "Something went wrong. Please reload the page.", action: "reload", severity: "error", module: "infrastructure" },
  // PM-9xxx: DATA INTEGRITY
  "PM-9001": { message: "A journal entry was found with unbalanced debits and credits.", action: "contact", severity: "critical", module: "data_integrity" },
  "PM-9002": { message: "A tenant record has no associated lease.", action: "contact", severity: "warning", module: "data_integrity" },
  "PM-9005": { message: "Duplicate transaction detected. This record may already exist.", action: "none", severity: "warning", module: "data_integrity" },
  "PM-9006": { message: "The tenant's calculated balance doesn't match the ledger total.", action: "contact", severity: "critical", module: "data_integrity" },
  "PM-9007": { message: "A recurring entry template references an account that no longer exists.", action: "contact", severity: "warning", module: "data_integrity" },
  "PM-9008": { message: "An active lease references a property that no longer exists.", action: "contact", severity: "warning", module: "data_integrity" },
};

let _activeCompanyId = null;
let _currentUserEmail = null;
let _currentUserRole = null;

export function setActiveErrorContext(companyId, email, role) {
  _activeCompanyId = companyId;
  _currentUserEmail = email;
  _currentUserRole = role;
}

// Classify by Postgres SQLSTATE code first (stable across versions),
// falling back to message-string matching for browser-side errors
// (fetch / network) where SQLSTATE isn't available. String-only
// classification used to silently misroute to the fallback every time
// Supabase or Postgres changed their error text between releases.
//
// Accepts either a raw message string or the full error object — the
// latter lets us peek at err.code (SQLSTATE) without plumbing a new
// parameter through every caller.
const SQLSTATE_MAP = {
  "42P01": "PM-8002", // undefined_table (relation does not exist)
  "42883": "PM-8003", // undefined_function
  "42501": "PM-8005", // insufficient_privilege
  "23505": "PM-9005", // unique_violation
  "57014": "PM-8004", // query_canceled (often from statement_timeout)
};
export function detectInfrastructureCode(errOrMessage, fallbackCode) {
  const codeByState = errOrMessage && typeof errOrMessage === "object" && errOrMessage.code
    ? SQLSTATE_MAP[errOrMessage.code]
    : null;
  if (codeByState) return codeByState;
  const rawMessage = typeof errOrMessage === "string" ? errOrMessage : (errOrMessage?.message || "");
  if (!rawMessage) return fallbackCode;
  const msg = rawMessage.toLowerCase();
  if (msg.includes("fetch") && msg.includes("failed") || msg.includes("networkerror") || msg.includes("failed to fetch")) return "PM-8001";
  if (msg.includes("relation") && msg.includes("does not exist")) return "PM-8002";
  if (msg.includes("function") && msg.includes("does not exist")) return "PM-8003";
  if (msg.includes("timeout") || msg.includes("aborted")) return "PM-8004";
  // Database permission errors specifically — the bare "permission denied"
  // pattern used to match the BROWSER's "Push permission denied" message
  // when registerPushNotifications failed, mistagging it as a Postgres
  // RLS error and flooding Sentry. Tighten so we only catch actual SQL
  // contexts: relation-permission errors, RLS, or "permission denied for
  // <table/schema/function>".
  if (
    msg.includes("row-level security") ||
    msg.includes("rls") ||
    msg.includes("permission denied for ") ||
    msg.includes("permission denied to ")
  ) return "PM-8005";
  if (msg.includes("duplicate key") || msg.includes("unique constraint")) return "PM-9005";
  return fallbackCode;
}

// In-session dedup: one identical error (same code + context + rawMessage)
// emits at most once per 60 seconds. Prevents a render-loop bug from flooding
// Sentry / error_log with thousands of identical events.
const DEDUP_TTL_MS = 60_000;
const _recentErrors = new Map();
function shouldEmit(fingerprint) {
  const now = Date.now();
  const last = _recentErrors.get(fingerprint);
  if (last && now - last < DEDUP_TTL_MS) return false;
  _recentErrors.set(fingerprint, now);
  // Opportunistic cleanup to prevent unbounded growth.
  if (_recentErrors.size > 500) {
    for (const [k, t] of _recentErrors) if (now - t > DEDUP_TTL_MS) _recentErrors.delete(k);
  }
  return true;
}

export async function logErrorToSupabase(errorRecord) {
  try {
    await supabase.from("error_log").insert([{
      company_id: _activeCompanyId || null, error_code: errorRecord.code, message: errorRecord.message,
      raw_message: errorRecord.rawMessage || null, severity: errorRecord.severity,
      module: errorRecord.module || "unknown",
      context: errorRecord.context || null, meta: errorRecord.meta || {},
      user_email: _currentUserEmail || "anonymous", user_role: _currentUserRole || "unknown",
      url: errorRecord.url || null, user_agent: errorRecord.userAgent || null, reported_by_user: false
    }]);
  } catch (e) {
    // Logger itself is broken — surface once so we can notice. Can't call pmError
    // here (infinite loop), so just console.error.
    try { console.error("[error_log] insert failed", e?.message || e, errorRecord); } catch (_) {}
  }
}

export let _showToastGlobal = null; // Set by AppInner on mount
export function setShowToastGlobal(fn) { _showToastGlobal = fn; }

export function pmError(code, { raw = null, context = "", silent = false, meta = {} } = {}) {
  const entry = PM_ERRORS[code] || PM_ERRORS["PM-8006"];
  const rawMessage = raw?.message || raw?.error?.message || String(raw || "");
  const rawStack = raw?.stack || raw?.error?.stack || null;
  // Pass the raw error object when available so detectInfrastructureCode
  // can read the Postgres SQLSTATE; it falls back to rawMessage when we
  // only have a string.
  const resolvedCode = detectInfrastructureCode(raw || rawMessage, code);
  const resolved = PM_ERRORS[resolvedCode] || entry;
  const fingerprint = resolvedCode + "|" + context + "|" + rawMessage.slice(0, 120);
  if (!shouldEmit(fingerprint)) {
    // Dedup fired — we've already logged + toasted this fingerprint in
    // the last 60s. Mute the toast too. Previous behavior left the
    // Sentry/log side silenced but still fired a new toast for every
    // occurrence, which flooded the user during render-loop bugs (the
    // whole point of the dedup was to stop that flood, and the toast
    // channel was leaking through it).
    return null;
  }
  const enrichedMeta = rawStack ? { ...meta, stack: String(rawStack).slice(0, 2000) } : meta;
  const errorRecord = {
    code: resolvedCode, message: resolved.message, action: resolved.action, severity: resolved.severity,
    module: resolved.module || "unknown",
    rawMessage: rawMessage.slice(0, 500), context, meta: enrichedMeta,
    timestamp: new Date().toISOString(), url: window.location.href,
    userAgent: navigator.userAgent.slice(0, 200),
  };
  const consoleFn = resolved.severity === "critical" || resolved.severity === "error" ? console.error : console.warn;
  consoleFn(`[${resolvedCode}] ${resolved.message}`, { raw: rawMessage.slice(0, 200), context, meta: enrichedMeta });
  if (!silent && typeof _showToastGlobal === "function") {
    _showToastGlobal(null, null, { isError: true, code: resolvedCode, message: resolved.message, action: resolved.action, severity: resolved.severity });
  }
  logErrorToSupabase(errorRecord);
  if (window.Sentry && resolved.severity !== "info") {
    try {
      window.Sentry.captureEvent({
        message: `${resolvedCode}: ${resolved.message}`,
        level: resolved.severity === "critical" ? "fatal" : resolved.severity === "error" ? "error" : "warning",
        // Tags are indexable filters in Sentry UI — much more useful than `extra`.
        tags: {
          errorCode: resolvedCode,
          module: resolved.module || "unknown",
          companyId: _activeCompanyId || "none",
          userRole: _currentUserRole || "unknown",
          context: context ? String(context).slice(0, 80) : "none",
        },
        extra: { rawMessage: rawMessage.slice(0, 300), context, meta: enrichedMeta, userEmail: _currentUserEmail || "anonymous" },
      });
    } catch (_) { /* Sentry SDK issue — don't let it break the app */ }
  }
  return errorRecord;
}

export async function reportError(code) {
  try {
    const { data } = await supabase.from("error_log").select("id, message, context, meta").eq("error_code", code).eq("resolved", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data) {
      await supabase.from("error_log").update({ reported_by_user: true }).eq("id", data.id);
      // Queue an email so someone actually sees the report. notification_queue
      // is the shared plumbing used by license/tax reminders — the worker reads
      // rows with status=pending and dispatches. The consumer is responsible
      // for looking up admin recipients from the company.
      if (_activeCompanyId) {
        try {
          // Notify every active admin for this company — previous version
          // wrote the reporter's own email as the recipient, so the queue
          // consumer would have emailed the user their own report. Fall
          // back to the reporter only when no admins resolve (fresh
          // company with no admin provisioned yet).
          const { data: admins } = await supabase
            .from("company_members")
            .select("user_email")
            .eq("company_id", _activeCompanyId)
            .eq("status", "active")
            .in("role", ["admin", "owner"]);
          const recipients = (admins || []).map(a => (a.user_email || "").toLowerCase()).filter(Boolean);
          const targets = recipients.length > 0 ? recipients : [(_currentUserEmail || "anonymous").toLowerCase()];
          const payload = {
            error_code: code,
            error_log_id: data.id,
            message: data.message,
            context: data.context || null,
            meta: data.meta || {},
            reported_by: _currentUserEmail || "anonymous",
            reported_role: _currentUserRole || "unknown",
          };
          await supabase.from("notification_queue").insert(
            targets.map(email => ({
              company_id: _activeCompanyId,
              type: "error_reported",
              recipient_email: email,
              data: payload,
              status: "pending",
            }))
          );
        } catch (_) { /* queue insert failure shouldn't block the UX */ }
      }
    }
    if (typeof _showToastGlobal === "function") _showToastGlobal(`Error ${code} reported. Your admin team has been notified.`, "success");
  } catch (_) {
    if (typeof _showToastGlobal === "function") _showToastGlobal(`Error code: ${code}. Please share this with your admin.`, "info");
  }
}

// Wire up pmError to helpers.js (for getSignedUrl)
setHelperPmError(pmError);
