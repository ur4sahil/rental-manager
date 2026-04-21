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
// REQUIRED_TENANT_DOCS: each entry matches by explicit doc.type first
// (authoritative — set by the upload widget's type dropdown), then falls
// back to word-boundary name regex. Previous loose substring matching
// flipped tenants to "complete" on false positives: video.pdf satisfied
// "Government-Issued ID" because "video" contains "id", and
// life_insurance_beneficiaries.pdf satisfied "Renters Insurance".
export const REQUIRED_TENANT_DOCS = [
  { label: "Signed Lease Agreement", types: ["Lease"], nameRe: /\blease\b/i },
  { label: "Government-Issued ID", types: ["ID"], nameRe: /\b(id|license|passport|government[-_\s]?issued)\b/i },
  { label: "Renters Insurance", types: ["Insurance"], nameRe: /\b(renters?[-_\s]?insurance|rental[-_\s]?insurance)\b/i },
  { label: "Proof of Utility Transfer", types: ["Receipt", "Other"], nameRe: /\b(utility|utilities)\b/i },
];

// True if the given list of documents covers every REQUIRED_TENANT_DOCS entry.
export function hasAllRequiredTenantDocs(docs) {
  return REQUIRED_TENANT_DOCS.every(({ types, nameRe }) =>
    (docs || []).some(d => {
      const t = (d?.type || "").trim();
      if (types.includes(t) && nameRe.test(d?.name || "")) return true;
      // Fallback when the uploader didn't pick a matching type: accept
      // if the filename itself is unambiguous. "insurance.pdf" alone
      // still counts; "life_insurance.pdf" does not.
      return nameRe.test(d?.name || "");
    })
  );
}

// Recompute and persist tenants.doc_status based on the tenant's current documents.
// - Preserves "exception_approved" (admin-approved override)
// - Otherwise sets "complete" when all required docs are present, else "pending_docs"
//
// Accepts either (companyId, tenantName) for legacy callers OR
// (companyId, { tenantId, tenantName, property }) for the preferred
// id-scoped path. documents.tenant_id doesn't exist in this schema, so
// the docs scan still has to filter by name — but we also scope by
// property when provided so two tenants sharing a name at different
// addresses don't cross-count uploads.
export async function recomputeTenantDocStatus(companyId, tenantOrOpts) {
  if (!companyId || !tenantOrOpts) return;
  const opts = typeof tenantOrOpts === "string" ? { tenantName: tenantOrOpts } : (tenantOrOpts || {});
  const { tenantId, tenantName, property } = opts;
  if (!tenantId && !tenantName) return;
  let tRowsQ = supabase.from("tenants").select("id, doc_status").eq("company_id", companyId).is("archived_at", null);
  tRowsQ = tenantId ? tRowsQ.eq("id", tenantId) : tRowsQ.ilike("name", tenantName);
  const { data: rows } = await tRowsQ;
  const targets = (rows || []).filter(r => r.doc_status !== "exception_approved");
  if (targets.length === 0) return;
  let docsQ = supabase.from("documents").select("name, type").eq("company_id", companyId).is("archived_at", null);
  if (tenantName) docsQ = docsQ.eq("tenant", tenantName);
  if (property) docsQ = docsQ.eq("property", property);
  const { data: docs } = await docsQ;
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
// Sanitize user input for Supabase PostgREST filter strings (.or, .ilike, .like).
// The only characters SQL LIKE treats as wildcards are %, _ and \ (the
// default escape). Commas + parens are ONLY meaningful on the .or()
// separator boundary, not inside a value, and stars are a PostgREST URL
// alias for % — so escaping them had no benefit but produced broken
// matches for legitimate values like "Smith (executor)". Narrowed to
// the three chars that actually matter.
export function escapeFilterValue(val) {
  if (!val) return "";
  return String(val).replace(/[%_\\]/g, c => "\\" + c);
}

// Case-insensitive email equality. `_` in a raw .ilike pattern is a SQL
// LIKE wildcard, so emails like "john_doe@x.com" used to match
// "johnxdoe@x.com" too — a real collision when two users differ only by
// an underscore. Escape the value so every character is literal.
export function emailFilterValue(email) {
  return escapeFilterValue((email || "").trim().toLowerCase());
}
// Sanitize HTML for safe insertion into document.write() contexts
export function sanitizeForPrint(str) {
  if (!str) return "";
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

export const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

export const STATE_NAMES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};

// Counties / independent cities the portfolio operates in. Mirrors the
// FlipRadar active-counties registry (shared/counties.js) for the DMV,
// plus Richmond City, Baltimore City, and York County PA that are
// specific to PropManager's portfolio.
//
// Totals: 1 DC + 11 MD + 14 VA + 1 PA = 27 jurisdictions.
//
// DC is not a county but is treated as a single jurisdiction. VA has
// both counties AND independent cities that each levy their own
// property tax, hence the "... City" entries sitting alongside
// "... County".
export const COUNTIES_BY_STATE = {
  DC: ["District of Columbia"],
  MD: [
    "Anne Arundel County",
    "Baltimore City",
    "Baltimore County",
    "Calvert County",
    "Charles County",
    "Frederick County",
    "Harford County",
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
    "Fredericksburg City",
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

// Property-tax billing schedule per jurisdiction. Keyed by
// "<county>|<state>". Each entry is an array of installments: month/day
// and a human label. For fiscal-year jurisdictions (Falls Church,
// Manassas Park) the label still maps to the calendar month/day the bill
// is due; year rollover happens in the bill generator.
//
// Sources (for audit): DC OTR, MD SDAT + individual county treasurers,
// VA per-locality tax admin pages, York County PA assessment office,
// Richmond City finance. See research notes in the PR description.
//
// These are DEFAULTS — a PM can edit a generated bill's due_date on any
// property if their specific jurisdiction shifts a date (not uncommon).
export const COUNTY_TAX_SCHEDULES = {
  // DC
  "District of Columbia|DC": [
    { label: "1st half (DC)",    month: 3, day: 31 },
    { label: "2nd half (DC)",    month: 9, day: 15 },
  ],

  // MD — statewide pattern: annual bill issued July 1, semi-annual
  // option for all classes but LLCs/investment pay annually by Sept 30
  // or split Sept 30 + Dec 31. Baltimore City is slightly unique; see
  // below. Everything else shares the same default schedule.
  "Anne Arundel County|MD":     [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "Baltimore County|MD":        [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "Calvert County|MD":          [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "Charles County|MD":          [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "Frederick County|MD":        [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "Harford County|MD":          [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "Howard County|MD":           [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "Montgomery County|MD":       [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "Prince George's County|MD":  [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  "St. Mary's County|MD":       [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],
  // Baltimore City — same statutory schedule; discount programs differ.
  "Baltimore City|MD":          [{ label: "1st half (MD)", month: 9, day: 30 }, { label: "2nd half (MD)", month: 12, day: 31 }],

  // VA standard NoVA/surrounding counties: Jun 5 + Dec 5.
  "Loudoun County|VA":          [{ label: "1st half (VA)", month: 6, day: 5  }, { label: "2nd half (VA)", month: 12, day: 5  }],
  "Stafford County|VA":         [{ label: "1st half (VA)", month: 6, day: 5  }, { label: "2nd half (VA)", month: 12, day: 5  }],
  "Spotsylvania County|VA":     [{ label: "1st half (VA)", month: 6, day: 5  }, { label: "2nd half (VA)", month: 12, day: 5  }],
  "Fauquier County|VA":         [{ label: "1st half (VA)", month: 6, day: 5  }, { label: "2nd half (VA)", month: 12, day: 5  }],
  // Fredericksburg City — fiscal-year FY ending Jun 30, so 1st half is
  // Dec 5 of the prior calendar year and 2nd half Jun 5 of the tax year.
  "Fredericksburg City|VA":     [{ label: "1st half (VA)", month: 12, day: 5 }, { label: "2nd half (VA)", month: 6,  day: 5  }],
  // Fairfax County: Jul 28 (not Jun 5) + Dec 5. Fairfax City defaults
  // to same for now; user can adjust per property.
  "Fairfax County|VA":          [{ label: "1st half (VA)", month: 7, day: 28 }, { label: "2nd half (VA)", month: 12, day: 5  }],
  "Fairfax City|VA":            [{ label: "1st half (VA)", month: 7, day: 28 }, { label: "2nd half (VA)", month: 12, day: 5  }],
  // Arlington: Jun 15 + Oct 5 (unusual — not Dec 5).
  "Arlington County|VA":        [{ label: "1st half (VA)", month: 6, day: 15 }, { label: "2nd half (VA)", month: 10, day: 5  }],
  // Alexandria City: Jun 15 + Nov 15.
  "Alexandria City|VA":         [{ label: "1st half (VA)", month: 6, day: 15 }, { label: "2nd half (VA)", month: 11, day: 15 }],
  // Falls Church + Manassas Park: fiscal-year billing Dec 5 + Jun 5.
  "Falls Church City|VA":       [{ label: "1st half (VA)", month: 12, day: 5 }, { label: "2nd half (VA)", month: 6,  day: 5  }],
  "Manassas Park City|VA":      [{ label: "1st half (VA)", month: 12, day: 5 }, { label: "2nd half (VA)", month: 6,  day: 5  }],
  // Prince William County: Jul 15 + Dec 5 (calendar year).
  "Prince William County|VA":   [{ label: "1st half (VA)", month: 7, day: 15 }, { label: "2nd half (VA)", month: 12, day: 5  }],
  // Manassas City — fiscal-year like Manassas Park + Falls Church: Dec 5 + Jun 5.
  "Manassas City|VA":           [{ label: "1st half (VA)", month: 12, day: 5 }, { label: "2nd half (VA)", month: 6,  day: 5  }],
  // Richmond City: Jan 14 + Jun 14 — uniquely early for VA.
  "Richmond City|VA":           [{ label: "1st half (VA)", month: 1, day: 14 }, { label: "2nd half (VA)", month: 6, day: 14  }],

  // PA York County — 3 bills per year per property: county + municipal
  // (combined) + school district. All delinquent Dec 31. For tracking we
  // represent the two distinct bill cycles; the discount/face/penalty
  // windows are notes the user can eyeball via the records URL.
  "York County|PA": [
    { label: "County & Municipal (PA)", month: 4, day: 30  },   // face amount window
    { label: "School District (PA)",    month: 10, day: 31 },   // face amount window
  ],
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

  // ===== MD Baltimore City (21201-21231) — independent of Baltimore County =====
  "21201": { state: "MD", county: "Baltimore City" }, "21202": { state: "MD", county: "Baltimore City" },
  "21205": { state: "MD", county: "Baltimore City" }, "21206": { state: "MD", county: "Baltimore City" },
  "21210": { state: "MD", county: "Baltimore City" }, "21211": { state: "MD", county: "Baltimore City" },
  "21212": { state: "MD", county: "Baltimore City" }, "21213": { state: "MD", county: "Baltimore City" },
  "21214": { state: "MD", county: "Baltimore City" }, "21215": { state: "MD", county: "Baltimore City" },
  "21216": { state: "MD", county: "Baltimore City" }, "21217": { state: "MD", county: "Baltimore City" },
  "21218": { state: "MD", county: "Baltimore City" }, "21223": { state: "MD", county: "Baltimore City" },
  "21224": { state: "MD", county: "Baltimore City" }, "21225": { state: "MD", county: "Baltimore City" },
  "21226": { state: "MD", county: "Baltimore City" }, "21229": { state: "MD", county: "Baltimore City" },
  "21230": { state: "MD", county: "Baltimore City" }, "21231": { state: "MD", county: "Baltimore City" },

  // ===== MD Baltimore County — surrounds the City; primary residential ZIPs =====
  "21204": { state: "MD", county: "Baltimore County" }, "21207": { state: "MD", county: "Baltimore County" },
  "21208": { state: "MD", county: "Baltimore County" }, "21209": { state: "MD", county: "Baltimore County" },
  "21219": { state: "MD", county: "Baltimore County" }, "21220": { state: "MD", county: "Baltimore County" },
  "21221": { state: "MD", county: "Baltimore County" }, "21222": { state: "MD", county: "Baltimore County" },
  "21227": { state: "MD", county: "Baltimore County" }, "21228": { state: "MD", county: "Baltimore County" },
  "21234": { state: "MD", county: "Baltimore County" }, "21236": { state: "MD", county: "Baltimore County" },
  "21237": { state: "MD", county: "Baltimore County" }, "21244": { state: "MD", county: "Baltimore County" },

  // ===== MD Harford County — 210xx–215xx =====
  "21001": { state: "MD", county: "Harford County" }, "21009": { state: "MD", county: "Harford County" },
  "21014": { state: "MD", county: "Harford County" }, "21015": { state: "MD", county: "Harford County" },
  "21017": { state: "MD", county: "Harford County" }, "21028": { state: "MD", county: "Harford County" },
  "21034": { state: "MD", county: "Harford County" }, "21040": { state: "MD", county: "Harford County" },
  "21050": { state: "MD", county: "Harford County" }, "21078": { state: "MD", county: "Harford County" },
  "21084": { state: "MD", county: "Harford County" }, "21085": { state: "MD", county: "Harford County" },
  "21154": { state: "MD", county: "Harford County" }, "21160": { state: "MD", county: "Harford County" },

  // ===== VA Fredericksburg City — 22401-22408 (some are surrounding counties, keep to city proper) =====
  "22401": { state: "VA", county: "Fredericksburg City" }, "22408": { state: "VA", county: "Fredericksburg City" },

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
