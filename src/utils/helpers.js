import { supabase } from "../supabase";

// Safe number conversion - prevents NaN from breaking calculations
export const safeNum = (val) => { const n = Number(val); return (isNaN(n) || !isFinite(n)) ? 0 : n; };
// Parse "YYYY-MM-DD" as LOCAL date (not UTC) to avoid timezone day-shift
export function parseLocalDate(str) {
  if (!str) return new Date(NaN);
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d || 1);
}
export function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Short random ID for references (avoids Date.now() collisions)
export function shortId() {
  const arr = new Uint8Array(6);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < 6; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr, b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

// Generate secure random ID (better than Date.now + Math.random)
export const CLASS_COLORS = ["#3B82F6","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"];
export const ALLOWED_DOC_TYPES = ["application/pdf","image/jpeg","image/png","image/gif","image/webp","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","text/plain","text/csv"];
export const ALLOWED_DOC_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|webp|doc|docx|xls|xlsx|txt|csv)$/i;
export function pickColor(str) {
  let hash = 0;
  for (let i = 0; i < (str || "").length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i);
  return CLASS_COLORS[Math.abs(hash) % CLASS_COLORS.length];
}
export function generateId(prefix = "") {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const arr = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
  crypto.getRandomValues(arr);
  } else {
  for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < 16; i++) id += chars[arr[i] % chars.length];
  return (prefix ? prefix + "-" : "") + id;
}

// Format person name from parts: "Sahil A. Agarwal"
export function formatPersonName(first, mi, last) {
  const parts = [];
  if (first) parts.push(first.trim());
  if (mi) parts.push(mi.trim().charAt(0).toUpperCase() + ".");
  if (last) parts.push(last.trim());
  return parts.join(" ") || "";
}
// Build name object for DB insert/update (sets name + first_name + middle_initial + last_name)
export function buildNameFields(first, mi, last) {
  return { name: formatPersonName(first, mi, last), first_name: (first || "").trim(), middle_initial: (mi || "").trim().charAt(0).toUpperCase() || "", last_name: (last || "").trim() };
}
// Parse a single name string into parts (for backward compat)
export function parseNameParts(fullName) {
  if (!fullName) return { first_name: "", middle_initial: "", last_name: "" };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], middle_initial: "", last_name: "" };
  if (parts.length === 2) return { first_name: parts[0], middle_initial: "", last_name: parts[1] };
  return { first_name: parts[0], middle_initial: parts[1].charAt(0), last_name: parts.slice(2).join(" ") };
}

// Guard: require companyId — FAIL CLOSED if missing (no silent fallback)
export function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e).trim()); }
export function normalizeEmail(email) {
  return (email || "").toLowerCase().trim();
}
export function formatCurrency(amount) {
  return "$" + safeNum(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Generate a time-limited signed URL for private storage files (1 hour expiry)
// NOTE: pmError is injected via setHelperPmError to avoid circular dependency with errors.js
let _pmError = null;
export function setHelperPmError(fn) { _pmError = fn; }
export async function getSignedUrl(bucket, filePath, expiresIn = 3600) {
  if (!filePath) return "";
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(filePath, expiresIn);
  if (error) { if (_pmError) _pmError("PM-8006", { raw: error, context: "signed URL for " + filePath, silent: true }); return ""; }
  return data?.signedUrl || "";
}

// Format phone: accepts digits, adds +1 prefix, formats as (XXX) XXX-XXXX
export function formatPhoneInput(value) {
  // Strip everything except digits and +
  let digits = value.replace(/[^\d+]/g, "");
  // If they typed +, keep the country code portion
  if (digits.startsWith("+")) {
  // International format — limit to 15 digits total (E.164 max)
  return digits.slice(0, 16);
  }
  // US format — strip to 10 digits
  digits = digits.replace(/\D/g, "");
  if (digits.length > 10) digits = digits.slice(0, 10);
  // Format as (XXX) XXX-XXXX
  if (digits.length >= 7) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length >= 4) return `(${digits.slice(0,3)}) ${digits.slice(3)}`;
  if (digits.length > 0) return `(${digits}`;
  return "";
}

// Canonical list of required docs per tenant. The match keywords are tested as
// case-insensitive substrings against both document.name and document.type.
// A doc counts as satisfying a requirement if ANY of its keywords matches.
export const REQUIRED_TENANT_DOCS = [
  { label: "Signed Lease Agreement", match: ["lease"] },
  { label: "Government-Issued ID", match: ["id", "government"] },
  { label: "Renters Insurance", match: ["insurance"] },
  { label: "Proof of Utility Transfer", match: ["utility"] },
];

// True if the given list of documents covers every REQUIRED_TENANT_DOCS entry.
export function hasAllRequiredTenantDocs(docs) {
  return REQUIRED_TENANT_DOCS.every(({ match }) =>
    (docs || []).some(d => {
      const n = (d?.name || "").toLowerCase();
      const t = (d?.type || "").toLowerCase();
      return match.some(m => n.includes(m) || t.includes(m));
    })
  );
}

// Recompute and persist tenants.doc_status based on the tenant's current documents.
// - Preserves "exception_approved" (admin-approved override)
// - Otherwise sets "complete" when all required docs are present, else "pending_docs"
export async function recomputeTenantDocStatus(companyId, tenantName) {
  if (!companyId || !tenantName) return;
  const { data: rows } = await supabase
    .from("tenants")
    .select("id, doc_status")
    .eq("company_id", companyId)
    .ilike("name", tenantName)
    .is("archived_at", null);
  const targets = (rows || []).filter(r => r.doc_status !== "exception_approved");
  if (targets.length === 0) return;
  const { data: docs } = await supabase
    .from("documents")
    .select("name, type")
    .eq("company_id", companyId)
    .ilike("tenant", tenantName)
    .is("archived_at", null);
  const nextStatus = hasAllRequiredTenantDocs(docs) ? "complete" : "pending_docs";
  await supabase
    .from("tenants")
    .update({ doc_status: nextStatus })
    .in("id", targets.map(r => r.id))
    .eq("company_id", companyId);
}

export function sanitizeFileName(name) {
  if (!name) return "file";
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
// ============ CSV EXPORT HELPER ============
export function exportToCSV(data, columns, filename, showToast) {
  if (!data || data.length === 0) { if (showToast) showToast("No data to export.", "error"); return; }
  const header = columns.map(c => c.label).join(",");
  const rows = data.map(row => columns.map(c => {
  let val = typeof c.key === "function" ? c.key(row) : row[c.key];
  if (val === null || val === undefined) val = "";
  val = String(val).replace(/"/g, '""');
  return val.includes(",") || val.includes('"') || val.includes("\n") ? `"${val}"` : val;
  }).join(","));
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename + ".csv"; a.click();
  URL.revokeObjectURL(url);
}

export function buildAddress(p) {
  const parts = [p.address_line_1, p.address_line_2, p.city, (p.state && p.zip) ? p.state + " " + p.zip : p.state || p.zip].filter(Boolean);
  return parts.join(", ") || p.address || "";
}

export function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
// Sanitize user input for Supabase PostgREST filter strings (.or, .ilike, .like)
// Escapes characters that have special meaning in PostgREST filter syntax
export function escapeFilterValue(val) {
  if (!val) return "";
  return String(val).replace(/[%_,.*()\\]/g, c => "\\" + c);
}
// Sanitize HTML for safe insertion into document.write() contexts
export function sanitizeForPrint(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

export const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

export const STATE_NAMES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};

export const statusColors = {
  occupied: "bg-positive-100 text-positive-700",
  vacant: "bg-caution-100 text-caution-700",
  maintenance: "bg-danger-100 text-danger-700",
  "notice given": "bg-notice-100 text-notice-700",
  active: "bg-positive-100 text-positive-700",
  notice: "bg-notice-100 text-notice-700",
  open: "bg-info-100 text-info-700",
  in_progress: "bg-highlight-100 text-highlight-700",
  completed: "bg-neutral-100 text-neutral-500",
  paid: "bg-positive-100 text-positive-700",
  partial: "bg-caution-100 text-caution-700",
  unpaid: "bg-danger-100 text-danger-700",
  pending: "bg-caution-100 text-caution-700",
  approved: "bg-positive-100 text-positive-700",
  eviction: "bg-danger-100 text-danger-700",
};

export const priorityColors = {
  emergency: "bg-danger-500 text-white",
  normal: "bg-info-100 text-info-700",
  low: "bg-neutral-100 text-neutral-500",
};
