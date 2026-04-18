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

// Counties / independent cities the portfolio operates in. Drives the
// wizard Step-1 county dropdown (filtered by the selected state). DC is
// not a county but is treated as a single jurisdiction. VA has both
// counties AND independent cities that handle taxes on their own, hence
// the "... City" entries sitting alongside "... County".
export const COUNTIES_BY_STATE = {
  DC: ["District of Columbia"],
  MD: [
    "Anne Arundel County",
    "Calvert County",
    "Charles County",
    "Frederick County",
    "Howard County",
    "Montgomery County",
    "Prince George's County",
    "St. Mary's County",
  ],
  VA: [
    "Alexandria City",
    "Arlington County",
    "Fairfax City",
    "Fairfax County",
    "Falls Church City",
    "Fauquier County",
    "Loudoun County",
    "Manassas City",
    "Manassas Park City",
    "Prince William County",
    "Richmond City",
    "Spotsylvania County",
    "Stafford County",
  ],
  PA: ["York County"],
};

// Best-effort ZIP → {state, county} lookup for the DMV + Richmond + York PA
// operating area. Fed to tests/backfill-property-county.js for legacy rows;
// NOT authoritative — the wizard dropdown + validation is the source of
// truth going forward. Any ZIP we don't cover leaves county NULL and the
// wizard will demand it on the next edit.
export const ZIP_TO_COUNTY = {
  // ===== DC — 20001-20099 (residential only; skip gov-only 20500s) =====
  "20001": { state: "DC", county: "District of Columbia" }, "20002": { state: "DC", county: "District of Columbia" },
  "20003": { state: "DC", county: "District of Columbia" }, "20004": { state: "DC", county: "District of Columbia" },
  "20005": { state: "DC", county: "District of Columbia" }, "20007": { state: "DC", county: "District of Columbia" },
  "20008": { state: "DC", county: "District of Columbia" }, "20009": { state: "DC", county: "District of Columbia" },
  "20010": { state: "DC", county: "District of Columbia" }, "20011": { state: "DC", county: "District of Columbia" },
  "20012": { state: "DC", county: "District of Columbia" }, "20015": { state: "DC", county: "District of Columbia" },
  "20016": { state: "DC", county: "District of Columbia" }, "20017": { state: "DC", county: "District of Columbia" },
  "20018": { state: "DC", county: "District of Columbia" }, "20019": { state: "DC", county: "District of Columbia" },
  "20020": { state: "DC", county: "District of Columbia" }, "20024": { state: "DC", county: "District of Columbia" },
  "20032": { state: "DC", county: "District of Columbia" }, "20036": { state: "DC", county: "District of Columbia" },
  "20037": { state: "DC", county: "District of Columbia" },

  // ===== MD Montgomery County — 208xx, 209xx =====
  "20814": { state: "MD", county: "Montgomery County" }, "20815": { state: "MD", county: "Montgomery County" },
  "20816": { state: "MD", county: "Montgomery County" }, "20817": { state: "MD", county: "Montgomery County" },
  "20832": { state: "MD", county: "Montgomery County" }, "20833": { state: "MD", county: "Montgomery County" },
  "20850": { state: "MD", county: "Montgomery County" }, "20851": { state: "MD", county: "Montgomery County" },
  "20852": { state: "MD", county: "Montgomery County" }, "20853": { state: "MD", county: "Montgomery County" },
  "20854": { state: "MD", county: "Montgomery County" }, "20855": { state: "MD", county: "Montgomery County" },
  "20861": { state: "MD", county: "Montgomery County" }, "20862": { state: "MD", county: "Montgomery County" },
  "20866": { state: "MD", county: "Montgomery County" }, "20871": { state: "MD", county: "Montgomery County" },
  "20872": { state: "MD", county: "Montgomery County" }, "20874": { state: "MD", county: "Montgomery County" },
  "20876": { state: "MD", county: "Montgomery County" }, "20877": { state: "MD", county: "Montgomery County" },
  "20878": { state: "MD", county: "Montgomery County" }, "20879": { state: "MD", county: "Montgomery County" },
  "20882": { state: "MD", county: "Montgomery County" }, "20886": { state: "MD", county: "Montgomery County" },
  "20895": { state: "MD", county: "Montgomery County" }, "20896": { state: "MD", county: "Montgomery County" },
  "20901": { state: "MD", county: "Montgomery County" }, "20902": { state: "MD", county: "Montgomery County" },
  "20903": { state: "MD", county: "Montgomery County" }, "20904": { state: "MD", county: "Montgomery County" },
  "20905": { state: "MD", county: "Montgomery County" }, "20906": { state: "MD", county: "Montgomery County" },
  "20910": { state: "MD", county: "Montgomery County" }, "20912": { state: "MD", county: "Montgomery County" },

  // ===== MD Prince George's County — 207xx, parts of 206xx/208xx =====
  "20707": { state: "MD", county: "Prince George's County" }, "20708": { state: "MD", county: "Prince George's County" },
  "20710": { state: "MD", county: "Prince George's County" }, "20712": { state: "MD", county: "Prince George's County" },
  "20715": { state: "MD", county: "Prince George's County" }, "20716": { state: "MD", county: "Prince George's County" },
  "20720": { state: "MD", county: "Prince George's County" }, "20721": { state: "MD", county: "Prince George's County" },
  "20735": { state: "MD", county: "Prince George's County" }, "20737": { state: "MD", county: "Prince George's County" },
  "20740": { state: "MD", county: "Prince George's County" }, "20742": { state: "MD", county: "Prince George's County" },
  "20743": { state: "MD", county: "Prince George's County" }, "20744": { state: "MD", county: "Prince George's County" },
  "20745": { state: "MD", county: "Prince George's County" }, "20746": { state: "MD", county: "Prince George's County" },
  "20747": { state: "MD", county: "Prince George's County" }, "20748": { state: "MD", county: "Prince George's County" },
  "20762": { state: "MD", county: "Prince George's County" }, "20769": { state: "MD", county: "Prince George's County" },
  "20770": { state: "MD", county: "Prince George's County" }, "20772": { state: "MD", county: "Prince George's County" },
  "20774": { state: "MD", county: "Prince George's County" }, "20781": { state: "MD", county: "Prince George's County" },
  "20782": { state: "MD", county: "Prince George's County" }, "20783": { state: "MD", county: "Prince George's County" },
  "20784": { state: "MD", county: "Prince George's County" }, "20785": { state: "MD", county: "Prince George's County" },

  // ===== MD Charles / Frederick / Howard / Anne Arundel / Calvert / St. Mary's — partial =====
  "20601": { state: "MD", county: "Charles County" }, "20602": { state: "MD", county: "Charles County" },
  "20603": { state: "MD", county: "Charles County" }, "20640": { state: "MD", county: "Charles County" },
  "21701": { state: "MD", county: "Frederick County" }, "21702": { state: "MD", county: "Frederick County" },
  "21703": { state: "MD", county: "Frederick County" }, "21704": { state: "MD", county: "Frederick County" },
  "21709": { state: "MD", county: "Frederick County" }, "21754": { state: "MD", county: "Frederick County" },
  "21770": { state: "MD", county: "Frederick County" }, "21771": { state: "MD", county: "Frederick County" },
  "21774": { state: "MD", county: "Frederick County" }, "21793": { state: "MD", county: "Frederick County" },
  "21043": { state: "MD", county: "Howard County" }, "21044": { state: "MD", county: "Howard County" },
  "21045": { state: "MD", county: "Howard County" }, "21046": { state: "MD", county: "Howard County" },
  "21075": { state: "MD", county: "Howard County" },
  "21401": { state: "MD", county: "Anne Arundel County" }, "21403": { state: "MD", county: "Anne Arundel County" },
  "21409": { state: "MD", county: "Anne Arundel County" },
  "20678": { state: "MD", county: "Calvert County" }, "20657": { state: "MD", county: "Calvert County" },
  "20653": { state: "MD", county: "St. Mary's County" }, "20650": { state: "MD", county: "St. Mary's County" },

  // ===== VA Arlington — 222xx =====
  "22201": { state: "VA", county: "Arlington County" }, "22202": { state: "VA", county: "Arlington County" },
  "22203": { state: "VA", county: "Arlington County" }, "22204": { state: "VA", county: "Arlington County" },
  "22205": { state: "VA", county: "Arlington County" }, "22206": { state: "VA", county: "Arlington County" },
  "22207": { state: "VA", county: "Arlington County" }, "22209": { state: "VA", county: "Arlington County" },
  "22213": { state: "VA", county: "Arlington County" }, "22214": { state: "VA", county: "Arlington County" },

  // ===== VA Fairfax County incl. independent Fairfax City + Falls Church City =====
  "22003": { state: "VA", county: "Fairfax County" }, "22015": { state: "VA", county: "Fairfax County" },
  "22027": { state: "VA", county: "Fairfax County" }, "22030": { state: "VA", county: "Fairfax City" },
  "22031": { state: "VA", county: "Fairfax County" }, "22032": { state: "VA", county: "Fairfax County" },
  "22033": { state: "VA", county: "Fairfax County" }, "22039": { state: "VA", county: "Fairfax County" },
  "22041": { state: "VA", county: "Fairfax County" }, "22042": { state: "VA", county: "Fairfax County" },
  "22043": { state: "VA", county: "Fairfax County" }, "22044": { state: "VA", county: "Falls Church City" },
  "22046": { state: "VA", county: "Falls Church City" }, "22060": { state: "VA", county: "Fairfax County" },
  "22066": { state: "VA", county: "Fairfax County" }, "22079": { state: "VA", county: "Fairfax County" },
  "22101": { state: "VA", county: "Fairfax County" }, "22102": { state: "VA", county: "Fairfax County" },
  "22124": { state: "VA", county: "Fairfax County" }, "22150": { state: "VA", county: "Fairfax County" },
  "22151": { state: "VA", county: "Fairfax County" }, "22152": { state: "VA", county: "Fairfax County" },
  "22153": { state: "VA", county: "Fairfax County" }, "22180": { state: "VA", county: "Fairfax County" },
  "22181": { state: "VA", county: "Fairfax County" }, "22182": { state: "VA", county: "Fairfax County" },
  "22303": { state: "VA", county: "Fairfax County" }, "22306": { state: "VA", county: "Fairfax County" },
  "22307": { state: "VA", county: "Fairfax County" }, "22309": { state: "VA", county: "Fairfax County" },
  "22310": { state: "VA", county: "Fairfax County" }, "22311": { state: "VA", county: "Fairfax County" },
  "22312": { state: "VA", county: "Fairfax County" }, "22315": { state: "VA", county: "Fairfax County" },

  // ===== VA Alexandria City — 223xx =====
  "22301": { state: "VA", county: "Alexandria City" }, "22302": { state: "VA", county: "Alexandria City" },
  "22304": { state: "VA", county: "Alexandria City" }, "22305": { state: "VA", county: "Alexandria City" },
  "22314": { state: "VA", county: "Alexandria City" },

  // ===== VA Loudoun — 201xx (Fairfax vs Loudoun overlap noted inline) =====
  "20105": { state: "VA", county: "Loudoun County" }, "20120": { state: "VA", county: "Fairfax County" },
  "20147": { state: "VA", county: "Loudoun County" }, "20148": { state: "VA", county: "Loudoun County" },
  "20151": { state: "VA", county: "Fairfax County" }, "20152": { state: "VA", county: "Loudoun County" },
  "20164": { state: "VA", county: "Loudoun County" }, "20165": { state: "VA", county: "Loudoun County" },
  "20166": { state: "VA", county: "Loudoun County" }, "20170": { state: "VA", county: "Fairfax County" },
  "20171": { state: "VA", county: "Fairfax County" }, "20175": { state: "VA", county: "Loudoun County" },
  "20176": { state: "VA", county: "Loudoun County" }, "20180": { state: "VA", county: "Loudoun County" },
  "20190": { state: "VA", county: "Fairfax County" }, "20191": { state: "VA", county: "Fairfax County" },
  "20194": { state: "VA", county: "Fairfax County" },

  // ===== VA Prince William / Manassas independent cities =====
  "20109": { state: "VA", county: "Prince William County" }, "20110": { state: "VA", county: "Manassas City" },
  "20111": { state: "VA", county: "Manassas City" }, "20112": { state: "VA", county: "Prince William County" },
  "22191": { state: "VA", county: "Prince William County" }, "22192": { state: "VA", county: "Prince William County" },
  "22193": { state: "VA", county: "Prince William County" },

  // ===== VA Stafford / Spotsylvania / Fauquier — partial =====
  "22554": { state: "VA", county: "Stafford County" }, "22556": { state: "VA", county: "Stafford County" },
  "22407": { state: "VA", county: "Spotsylvania County" }, "22551": { state: "VA", county: "Spotsylvania County" },
  "20186": { state: "VA", county: "Fauquier County" }, "20187": { state: "VA", county: "Fauquier County" },

  // ===== VA Richmond City — 232xx =====
  "23220": { state: "VA", county: "Richmond City" }, "23221": { state: "VA", county: "Richmond City" },
  "23222": { state: "VA", county: "Richmond City" }, "23223": { state: "VA", county: "Richmond City" },
  "23224": { state: "VA", county: "Richmond City" }, "23225": { state: "VA", county: "Richmond City" },
  "23226": { state: "VA", county: "Richmond City" }, "23227": { state: "VA", county: "Richmond City" },
  "23230": { state: "VA", county: "Richmond City" }, "23231": { state: "VA", county: "Richmond City" },
  "23233": { state: "VA", county: "Richmond City" }, "23234": { state: "VA", county: "Richmond City" },

  // ===== PA York County — 173xx–174xx =====
  "17313": { state: "PA", county: "York County" }, "17315": { state: "PA", county: "York County" },
  "17331": { state: "PA", county: "York County" }, "17339": { state: "PA", county: "York County" },
  "17340": { state: "PA", county: "York County" }, "17349": { state: "PA", county: "York County" },
  "17356": { state: "PA", county: "York County" }, "17401": { state: "PA", county: "York County" },
  "17402": { state: "PA", county: "York County" }, "17403": { state: "PA", county: "York County" },
  "17404": { state: "PA", county: "York County" }, "17406": { state: "PA", county: "York County" },
  "17407": { state: "PA", county: "York County" }, "17408": { state: "PA", county: "York County" },
};

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
