import { supabase } from "../supabase";
import { normalizeEmail } from "./helpers";
import { pmError } from "./errors";

// ============ AUDIT TRAIL HELPER ============
// Call this from any module to log an action
export const AUDIT_ACTIONS = new Set([
  "create","update","delete","approve","reject","login","logout","invite","void","request",
  "deactivate","archive","send","export",
]);
export const AUDIT_MODULES = new Set([
  "properties","tenants","payments","maintenance","leases","vendors","owners","accounting",
  "documents","team","pm_requests","bank_reconciliation","owner_distributions","settings",
  "property_tax_bills","property_licenses","property_requests","late_fees","loans","hoa",
  "insurance","utilities","autopay","banking","doc_builder","evictions","notifications",
  "vendor_invoices","companies","messages",
]);
export async function logAudit(action, module, details = "", recordId = "", userEmail = "", userRoleVal = "unknown", companyId) {
  try {
  // Validate action and module to prevent injection of arbitrary audit entries.
  // Previous behavior dropped the row entirely on unknown action/module —
  // so any new module added to the app without updating this file silently
  // never produced audit entries. A dropped row is a worse audit outcome
  // than a row with "(unknown action: X)" stamped in the details, so we
  // now fall back to safe placeholders and still write the row.
  let safeAction = action;
  let actionUnknown = false;
  if (!AUDIT_ACTIONS.has(action)) {
    pmError("PM-8007", { raw: { message: "invalid audit action: " + action }, context: "logAudit validation — preserving as 'update' with unknown marker", silent: true });
    safeAction = "update";
    actionUnknown = true;
  }
  let safeModule = module;
  let moduleUnknown = false;
  if (!AUDIT_MODULES.has(module)) {
    pmError("PM-8007", { raw: { message: "invalid audit module: " + module }, context: "logAudit validation — preserving with unknown marker", silent: true });
    safeModule = "settings"; // catch-all that exists in the whitelist
    moduleUnknown = true;
  }
  if (!userEmail) {
  const { data: { user } } = await supabase.auth.getUser();
  userEmail = user?.email || "unknown";
  }
  if (!companyId) { pmError("PM-8007", { raw: { message: "missing companyId" }, context: "logAudit", silent: true }); return; }
  // Sanitize audit details: truncate, strip HTML, redact sensitive patterns
  let safeDetails = String(details || "").replace(/<[^>]*>/g, "").slice(0, 500);
  safeDetails = safeDetails.replace(/password[:\s=]*\S+/gi, "password:[REDACTED]").replace(/(token|secret|key|access_token)[:\s=]*\S+/gi, "$1:[REDACTED]");
  // Prepend an unknown-marker so the audit trail stays self-describing
  // when a new action/module shows up without a whitelist update.
  const marker = [];
  if (actionUnknown) marker.push("action_unknown=" + String(action).slice(0, 32));
  if (moduleUnknown) marker.push("module_unknown=" + String(module).slice(0, 32));
  if (marker.length) safeDetails = "[" + marker.join(" ") + "] " + safeDetails;
  const { error: _err130 } = await supabase.from("audit_trail").insert([{ company_id: companyId, action: safeAction, module: safeModule, details: safeDetails, record_id: recordId ? String(recordId) : "", user_email: normalizeEmail(userEmail), user_role: userRoleVal }]);
  if (_err130) pmError("PM-8006", { raw: _err130, context: "audit log insert", silent: true });
  } catch (e) { pmError("PM-8006", { raw: e, context: "audit log", silent: true }); }
}
