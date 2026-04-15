import { supabase } from "../supabase";
import { setHelperPmError } from "./helpers";

// ============ ERROR MANAGEMENT SYSTEM ============
export const PM_ERRORS = {
  // PM-1xxx: AUTH & ACCESS
  "PM-1001": { message: "Your session has expired. Please sign in again.", action: "reload", severity: "warning" },
  "PM-1002": { message: "You don't have permission to perform this action.", action: "none", severity: "error" },
  "PM-1003": { message: "This account is already registered. Try signing in instead.", action: "none", severity: "warning" },
  "PM-1004": { message: "Invalid email or password. Please try again.", action: "retry", severity: "warning" },
  "PM-1005": { message: "Your account doesn't have access to this company.", action: "contact", severity: "error" },
  "PM-1006": { message: "This invitation link has expired or was already used.", action: "contact", severity: "warning" },
  "PM-1007": { message: "Unable to send the invitation email. Please verify the email address.", action: "retry", severity: "error" },
  "PM-1008": { message: "You need to be an Admin to change user roles.", action: "none", severity: "error" },
  "PM-1009": { message: "Could not create user account. The email may already be in use.", action: "retry", severity: "error" },
  // PM-2xxx: PROPERTIES
  "PM-2001": { message: "A property with this address already exists.", action: "none", severity: "warning" },
  "PM-2002": { message: "Could not save the property. Please check all required fields.", action: "retry", severity: "error" },
  "PM-2003": { message: "Could not archive this property. It may have active tenants.", action: "none", severity: "error" },
  "PM-2004": { message: "Could not restore this property.", action: "retry", severity: "error" },
  "PM-2005": { message: "Property was saved but the accounting class could not be linked.", action: "contact", severity: "warning" },
  "PM-2006": { message: "Could not update related records after renaming the property address.", action: "contact", severity: "warning" },
  "PM-2007": { message: "Could not load the property setup wizard.", action: "retry", severity: "error" },
  "PM-2008": { message: "Property was saved but the lease record could not be created.", action: "contact", severity: "warning" },
  // PM-3xxx: TENANTS & LEASES
  "PM-3001": { message: "A tenant with this name already exists at this property.", action: "none", severity: "warning" },
  "PM-3002": { message: "Could not save the tenant record.", action: "retry", severity: "error" },
  "PM-3003": { message: "Could not archive this tenant.", action: "retry", severity: "error" },
  "PM-3004": { message: "Could not create or renew the lease.", action: "retry", severity: "error" },
  "PM-3005": { message: "Required documents are missing. Please upload all mandatory documents before proceeding.", action: "none", severity: "warning" },
  "PM-3006": { message: "Could not generate the move-out notice.", action: "retry", severity: "error" },
  "PM-3007": { message: "Could not send tenant invitation.", action: "retry", severity: "error" },
  "PM-3008": { message: "Lease was renewed but the old lease status could not be updated.", action: "contact", severity: "warning" },
  // PM-4xxx: ACCOUNTING & JE
  "PM-4001": { message: "This journal entry is out of balance. Debits must equal credits.", action: "retry", severity: "error" },
  "PM-4002": { message: "Could not save the journal entry.", action: "retry", severity: "error" },
  "PM-4003": { message: "Could not save the journal entry lines.", action: "contact", severity: "critical" },
  "PM-4004": { message: "This date falls in a locked accounting period. Unlock it first or use a later date.", action: "none", severity: "warning" },
  "PM-4005": { message: "Could not void this journal entry.", action: "retry", severity: "error" },
  "PM-4006": { message: "Could not save the account. It may conflict with an existing one.", action: "retry", severity: "error" },
  "PM-4008": { message: "Could not create the recurring journal entry template.", action: "retry", severity: "error" },
  "PM-4010": { message: "Could not save the accounting class.", action: "retry", severity: "error" },
  "PM-4011": { message: "Could not lock/unlock the accounting period.", action: "retry", severity: "error" },
  "PM-4012": { message: "Journal entry was created but lines could not be saved. The entry has been rolled back.", action: "contact", severity: "critical" },
  // PM-5xxx: BANKING & IMPORT
  "PM-5001": { message: "Could not parse the CSV file. Check the format and try again.", action: "retry", severity: "error" },
  "PM-5002": { message: "Could not import transactions. Some rows may have been skipped.", action: "retry", severity: "warning" },
  "PM-5003": { message: "Could not connect to your bank. Please try again.", action: "retry", severity: "error" },
  "PM-5004": { message: "Bank sync failed. Your bank may require re-authentication.", action: "retry", severity: "error" },
  "PM-5005": { message: "Could not categorize this transaction.", action: "retry", severity: "error" },
  "PM-5006": { message: "Could not create the bank account feed.", action: "retry", severity: "error" },
  "PM-5007": { message: "This transaction has already been processed.", action: "none", severity: "warning" },
  "PM-5008": { message: "Could not save the bank rule.", action: "retry", severity: "error" },
  "PM-5009": { message: "Could not match this transaction.", action: "retry", severity: "error" },
  "PM-5010": { message: "Split total doesn't match the transaction amount.", action: "retry", severity: "warning" },
  // PM-6xxx: PAYMENTS & LEDGER
  "PM-6001": { message: "Could not record the payment.", action: "retry", severity: "error" },
  "PM-6002": { message: "Could not update the tenant balance.", action: "contact", severity: "critical" },
  "PM-6003": { message: "Could not post the late fee.", action: "retry", severity: "error" },
  "PM-6004": { message: "Could not process the owner distribution.", action: "contact", severity: "error" },
  "PM-6005": { message: "Could not create the ledger entry.", action: "retry", severity: "error" },
  "PM-6006": { message: "Payment was recorded but the accounting entry could not be posted.", action: "contact", severity: "critical" },
  // PM-7xxx: WORK ORDERS & DOCS
  "PM-7001": { message: "Could not save the work order.", action: "retry", severity: "error" },
  "PM-7002": { message: "Could not upload the file. Check the file size and type.", action: "retry", severity: "error" },
  "PM-7003": { message: "File was uploaded but the record could not be saved.", action: "contact", severity: "warning" },
  "PM-7004": { message: "Could not delete the document.", action: "retry", severity: "error" },
  "PM-7005": { message: "Could not load work orders.", action: "retry", severity: "error" },
  "PM-7006": { message: "Could not save the inspection.", action: "retry", severity: "error" },
  // PM-8xxx: NETWORK & INFRASTRUCTURE
  "PM-8001": { message: "Unable to reach the server. Check your internet connection and try again.", action: "retry", severity: "error" },
  "PM-8002": { message: "A required database table is missing. Please contact support.", action: "contact", severity: "critical" },
  "PM-8003": { message: "A required server function is missing. Please contact support.", action: "contact", severity: "critical" },
  "PM-8004": { message: "The request timed out. Please try again.", action: "retry", severity: "warning" },
  "PM-8005": { message: "A database permission error occurred. Your access may need to be updated.", action: "contact", severity: "error" },
  "PM-8006": { message: "Could not save your changes. The server returned an unexpected response.", action: "retry", severity: "error" },
  // PM-9xxx: DATA INTEGRITY
  "PM-9001": { message: "A journal entry was found with unbalanced debits and credits.", action: "contact", severity: "critical" },
  "PM-9002": { message: "A tenant record has no associated lease.", action: "contact", severity: "warning" },
  "PM-9005": { message: "Duplicate transaction detected. This record may already exist.", action: "none", severity: "warning" },
  "PM-9006": { message: "The tenant's calculated balance doesn't match the ledger total.", action: "contact", severity: "critical" },
  "PM-9007": { message: "A recurring entry template references an account that no longer exists.", action: "contact", severity: "warning" },
};

let _activeCompanyId = null;
let _currentUserEmail = null;
let _currentUserRole = null;

export function setActiveErrorContext(companyId, email, role) {
  _activeCompanyId = companyId;
  _currentUserEmail = email;
  _currentUserRole = role;
}

export function detectInfrastructureCode(rawMessage, fallbackCode) {
  if (!rawMessage) return fallbackCode;
  const msg = rawMessage.toLowerCase();
  if (msg.includes("fetch") && msg.includes("failed") || msg.includes("networkerror") || msg.includes("failed to fetch")) return "PM-8001";
  if (msg.includes("relation") && msg.includes("does not exist")) return "PM-8002";
  if (msg.includes("function") && msg.includes("does not exist")) return "PM-8003";
  if (msg.includes("timeout") || msg.includes("aborted")) return "PM-8004";
  if (msg.includes("row-level security") || msg.includes("rls") || msg.includes("permission denied")) return "PM-8005";
  if (msg.includes("duplicate key") || msg.includes("unique constraint")) return "PM-9005";
  return fallbackCode;
}

export async function logErrorToSupabase(errorRecord) {
  try {
    const moduleMap = { "1": "auth", "2": "properties", "3": "tenants", "4": "accounting", "5": "banking", "6": "payments", "7": "work_orders", "8": "infrastructure", "9": "data_integrity" };
    await supabase.from("error_log").insert([{
      company_id: _activeCompanyId || null, error_code: errorRecord.code, message: errorRecord.message,
      raw_message: errorRecord.rawMessage || null, severity: errorRecord.severity,
      module: moduleMap[errorRecord.code?.charAt(3)] || "unknown",
      context: errorRecord.context || null, meta: errorRecord.meta || {},
      user_email: _currentUserEmail || "anonymous", user_role: _currentUserRole || "unknown",
      url: errorRecord.url || null, user_agent: errorRecord.userAgent || null, reported_by_user: false
    }]);
  } catch (_) { /* Cannot error while logging an error */ }
}

export let _showToastGlobal = null; // Set by AppInner on mount
export function setShowToastGlobal(fn) { _showToastGlobal = fn; }

export function pmError(code, { raw = null, context = "", silent = false, meta = {} } = {}) {
  const entry = PM_ERRORS[code] || PM_ERRORS["PM-8006"];
  const rawMessage = raw?.message || raw?.error?.message || String(raw || "");
  const resolvedCode = detectInfrastructureCode(rawMessage, code);
  const resolved = PM_ERRORS[resolvedCode] || entry;
  const errorRecord = {
    code: resolvedCode, message: resolved.message, action: resolved.action, severity: resolved.severity,
    rawMessage: rawMessage.slice(0, 500), context, meta,
    timestamp: new Date().toISOString(), url: window.location.href,
    userAgent: navigator.userAgent.slice(0, 200),
  };
  const consoleFn = resolved.severity === "critical" || resolved.severity === "error" ? console.error : console.warn;
  consoleFn(`[${resolvedCode}] ${resolved.message}`, { raw: rawMessage.slice(0, 200), context, meta });
  if (!silent && typeof _showToastGlobal === "function") {
    _showToastGlobal(null, null, { isError: true, code: resolvedCode, message: resolved.message, action: resolved.action, severity: resolved.severity });
  }
  logErrorToSupabase(errorRecord);
  if (window.Sentry && resolved.severity !== "info") {
    window.Sentry.captureEvent({
      message: `${resolvedCode}: ${resolved.message}`, level: resolved.severity === "critical" ? "fatal" : resolved.severity === "error" ? "error" : "warning",
      tags: { errorCode: resolvedCode }, extra: { rawMessage: rawMessage.slice(0, 300), context, meta },
    });
  }
  return errorRecord;
}

export async function reportError(code) {
  try {
    const { data } = await supabase.from("error_log").select("id").eq("error_code", code).eq("resolved", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (data) await supabase.from("error_log").update({ reported_by_user: true }).eq("id", data.id);
    if (typeof _showToastGlobal === "function") _showToastGlobal(`Error ${code} reported. Your admin team has been notified.`, "success");
  } catch (_) {
    if (typeof _showToastGlobal === "function") _showToastGlobal(`Error code: ${code}. Please share this with your admin.`, "info");
  }
}

// Wire up pmError to helpers.js (for getSignedUrl)
setHelperPmError(pmError);
