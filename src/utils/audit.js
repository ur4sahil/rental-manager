import { supabase } from "../supabase";
import { normalizeEmail } from "./helpers";
import { pmError } from "./errors";

// ============ AUDIT TRAIL HELPER ============
// Call this from any module to log an action
export const AUDIT_ACTIONS = new Set(["create","update","delete","approve","reject","login","logout","invite","void","request"]);
export const AUDIT_MODULES = new Set(["properties","tenants","payments","maintenance","leases","vendors","owners","accounting","documents","team","pm_requests","bank_reconciliation","owner_distributions","settings"]);
export async function logAudit(action, module, details = "", recordId = "", userEmail = "", userRoleVal = "unknown", companyId) {
  try {
  // Validate action and module to prevent injection of arbitrary audit entries
  if (!AUDIT_ACTIONS.has(action)) { pmError("PM-9001", { raw: { message: "invalid audit action: " + action }, context: "logAudit validation", silent: true }); return; }
  if (!AUDIT_MODULES.has(module)) { pmError("PM-9001", { raw: { message: "invalid audit module: " + module }, context: "logAudit validation", silent: true }); return; }
  if (!userEmail) {
  const { data: { user } } = await supabase.auth.getUser();
  userEmail = user?.email || "unknown";
  }
  if (!companyId) { pmError("PM-9001", { raw: { message: "missing companyId" }, context: "logAudit", silent: true }); return; }
  // Sanitize audit details: truncate, strip HTML, redact sensitive patterns
  let safeDetails = String(details || "").replace(/<[^>]*>/g, "").slice(0, 500);
  safeDetails = safeDetails.replace(/password[:\s=]*\S+/gi, "password:[REDACTED]").replace(/(token|secret|key|access_token)[:\s=]*\S+/gi, "$1:[REDACTED]");
  const { error: _err130 } = await supabase.from("audit_trail").insert([{ company_id: companyId, action, module, details: safeDetails, record_id: recordId ? String(recordId) : "", user_email: normalizeEmail(userEmail), user_role: userRoleVal }]);
  if (_err130) pmError("PM-8006", { raw: _err130, context: "audit log insert", silent: true });
  } catch (e) { pmError("PM-8006", { raw: e, context: "audit log", silent: true }); }
}
