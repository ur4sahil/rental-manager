// The one place that knows what a screen is CALLED in the URL.
//
// Navigation used to be history.pushState("#" + page), so every URL was
// "/#acct_qbimport" -- a fragment, which never reaches a server (so it
// cannot be routed, rewritten or logged), which puts an internal id in
// front of the customer, and which preserves the query string by design,
// so one page's params followed the user everywhere else. Now: real
// paths. Page ids stay the app's internal currency; this module is the
// only translator between an id and the path a user sees, because two
// spellings of one screen means one of them is wrong.
//
// The server half is vercel.json's `rewrites` -- app paths to
// /index.html, /api/* and build/'s own files excluded.

// ---- id -> path. Every key of App.js's `pageComponents` is here, ------
// written for a reader: hyphens not underscores, words not abbreviations,
// nesting that mirrors the sidebar.
export const PAGE_PATHS = {
  dashboard: "/dashboard", tasks: "/tasks", tenants: "/tenants", payments: "/payments",
  leases: "/leases", latefees: "/late-fees", moveout: "/move-out", evictions: "/evictions",
  properties: "/properties", property_import: "/properties/import",
  property_import_add: "/properties/import/add", property_import_edit: "/properties/import/edit",
  maintenance: "/maintenance", inspections: "/inspections", utilities: "/utilities",
  hoa: "/hoa-payments", loans: "/loans", insurance: "/insurance", tax_bills: "/tax-bills",
  accounting: "/accounting", acct_opening: "/accounting/opening-balances",
  acct_coa: "/accounting/chart-of-accounts", acct_journal: "/accounting/journal-entries",
  acct_recurring: "/accounting/recurring-entries", acct_bankimport: "/accounting/bank-transactions",
  acct_qbimport: "/accounting/import-from-quickbooks", acct_reconcile: "/accounting/reconcile",
  acct_classes: "/accounting/class-tracking", acct_reports: "/accounting/reports",
  documents: "/documents", doc_builder: "/document-builder", vendors: "/vendors",
  owners: "/owners", notifications: "/notifications", messages: "/messages", admin: "/admin",
  // "/portal", not "/tenant-portal": its audience has only one portal.
  tenant_portal: "/portal", tenant_overview: "/portal/overview", tenant_pay: "/portal/pay",
  tenant_autopay: "/portal/autopay", tenant_ledger: "/portal/ledger",
  tenant_maintenance: "/portal/maintenance", tenant_documents: "/portal/documents",
  tenant_messages: "/portal/messages", owner_portal: "/owner",
};
// The other direction, derived so the two cannot disagree.
const PATH_TO_PAGE = Object.fromEntries(Object.entries(PAGE_PATHS).map(([id, p]) => [p, id]));

// Never claimed by this router: /sign/<token> is the public signing page
// (App.js hands it to PublicSignPage before any auth bootstrapping, and
// resolving it here would push a signer into the login flow), and /api/*
// are Vercel serverless functions, not screens at all.
const RESERVED = ["/sign", "/api"];

// ---- reports ----------------------------------------------------------
// The open report is part of the address of the Reports page, so it gets
// slugs too -- "bs" and "tb" are accountants' shorthand, unreadable in a
// URL. An id not named here falls back to itself, underscores hyphenated,
// so a new report is addressable the day it ships.
export const REPORT_SLUGS = {
  pl: "profit-and-loss", pl_by_class: "profit-and-loss-by-class", pl_compare: "profit-and-loss-comparison",
  bs: "balance-sheet", cash_flow: "cash-flow", budget_vs_actual: "budget-vs-actuals",
  ar_aging_summary: "ar-aging-summary", ar_aging_detail: "ar-aging-detail",
  customer_balance_summary: "tenant-balance-summary", open_invoices: "open-invoices",
  collections: "collections", ap_aging_summary: "ap-aging-summary", unpaid_bills: "unpaid-bills",
  vendor_balance_summary: "vendor-balance-summary", expenses_by_category: "expenses-by-category",
  expenses_by_vendor: "expenses-by-vendor", tb: "trial-balance", gl: "general-ledger",
  journal: "journal", txn_by_date: "transactions-by-date", account_list: "account-listing",
  audit_log: "audit-log", recon_summary: "reconciliation-summary", rent_roll: "rent-roll",
  vacancy: "vacancy", lease_expirations: "lease-expirations", rent_collection: "rent-collection",
  work_orders_summary: "work-order-summary", security_deposits: "security-deposits",
  noi_by_property: "noi-by-property", license_compliance: "license-compliance",
};
const SLUG_TO_REPORT = Object.fromEntries(Object.entries(REPORT_SLUGS).map(([id, s]) => [s, id]));
export function reportSlug(id) { return id ? (REPORT_SLUGS[id] || String(id).replace(/_/g, "-")) : ""; }
// The caller checks this against the live catalogue, so an unknown slug
// coming back as a plausible id just lands on the catalogue.
export function reportIdFromSlug(s) { return s ? (SLUG_TO_REPORT[s] || String(s).replace(/-/g, "_")) : ""; }

// ---- reading a path ---------------------------------------------------
function trimPath(pathname) {
  const p = String(pathname || "/");
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}
function isReserved(path) { return RESERVED.some(r => path === r || path.startsWith(r + "/")); }

// The page a path names, or null when it names none (a bare "/", a
// reserved prefix, a typo). Longest-prefix, not exact-only:
// /accounting/reports/balance-sheet IS the Reports page with the report
// named under it -- but exact wins first, so /properties/import/edit is
// not swallowed by /properties/import.
export function pageForPath(pathname) {
  const path = trimPath(pathname);
  if (!path || path === "/" || isReserved(path)) return null;
  if (PATH_TO_PAGE[path]) return PATH_TO_PAGE[path];
  let best = null;
  for (const p of Object.keys(PATH_TO_PAGE)) {
    if (path.startsWith(p + "/") && (!best || p.length > best.length)) best = p;
  }
  return best ? PATH_TO_PAGE[best] : null;
}

// Whatever a path carries BELOW its page: "balance-sheet" for
// /accounting/reports/balance-sheet, "" for /accounting/reports.
export function subPathFor(page, pathname) {
  const base = PAGE_PATHS[page], path = trimPath(pathname);
  return base && path.startsWith(base + "/") ? path.slice(base.length + 1) : "";
}

export function pathForPage(page) { return PAGE_PATHS[page] || "/dashboard"; }

// ---- query params that belong to ONE page -----------------------------
// A pushState to a path keeps the query string exactly as the old
// fragment-only one did, so without this the Reports page's ?asOf= still
// rides along everywhere else. The rule lives here so no page has to
// remember to clean up after itself. "report" is absent because WHICH
// report is open is in the path now; normalizeLegacyUrl() folds a legacy
// one in, so any that survives is stale.
export const PAGE_SCOPED_PARAMS = { acct_reports: ["period", "asOf", "from", "to"] };
const LEGACY_PARAMS = ["report"];
function foreignParams(page) {
  const out = [];
  for (const [owner, keys] of Object.entries(PAGE_SCOPED_PARAMS)) if (owner !== page) out.push(...keys);
  return out.concat(LEGACY_PARAMS);
}

// The URL to push when navigating to `page`: that page's path, the query
// string minus any other page's params, no fragment.
//
// The subtlety is a page addressing something below itself. Clicking
// Reports in the sidebar while /accounting/reports/balance-sheet is open
// targets the page already open -- rebuilding the bare path would drop the
// report from the URL while the component went on showing it, and the next
// refresh would land somewhere the URL never said. Same page in, same path
// out.
export function pageUrl(page, loc = window.location) {
  const q = new URLSearchParams(loc.search);
  foreignParams(page).forEach(k => q.delete(k));
  const qs = q.toString();
  const path = pageForPath(loc.pathname) === page ? loc.pathname : pathForPage(page);
  return path + (qs ? "?" + qs : "");
}

// The URL with stale params swept, or null when there is nothing to do --
// boot resolves the page from the path and Back/Forward go through
// setPageRaw, so navigation is not the only way `page` changes.
export function sweptUrl(page, loc = window.location) {
  const q = new URLSearchParams(loc.search);
  const stale = foreignParams(page).filter(k => q.has(k));
  if (stale.length === 0) return null;
  stale.forEach(k => q.delete(k));
  const qs = q.toString();
  return loc.pathname + (qs ? "?" + qs : "") + loc.hash;
}

// ---- legacy "#page" URLs ----------------------------------------------
// They are in bookmarks, in browser history, in every notification email
// already sent and in every push payload already delivered, so none may
// break. The app rewrites one into its path with replaceState before it
// renders: no reload, no flash, and the user lands where the old link
// pointed. Returns the page resolved, or null if this was not a legacy URL.
//
// setScreen() used to write here too, so "#login" and "#company_select"
// are in old entries. Neither is a page, and treating one as a page id
// silently lands the user on the Dashboard -- this list once said
// "companySelect" while setScreen wrote "company_select", so it sailed
// through.
const SCREEN_HASHES = new Set(["loading", "landing", "login", "set_password", "reset_password", "company_select", "app", "companySelect"]);
export function normalizeLegacyUrl(loc = window.location, history = window.history) {
  if (isReserved(trimPath(loc.pathname))) return null;
  const q = new URLSearchParams(loc.search);
  const h = String(loc.hash || "").replace(/^#/, "");
  // Supabase's recovery / magic-link hash arrives as
  // "access_token=...&type=recovery=...". detectSessionInUrl usually
  // clears it first; never read it as a page id if it has not.
  const auth = h.includes("access_token=") || h.includes("type=recovery");
  let page = h && !auth && !SCREEN_HASHES.has(h) && PAGE_PATHS[h] ? h : null;
  // "?report=bs" with no page hash was a valid old link too -- the Reports
  // page wrote the param and the hash independently.
  if (!page && q.has("report") && !pageForPath(loc.pathname)) page = "acct_reports";
  if (!page) return null;
  // Fold the report into the path rather than dropping it, so an emailed
  // Balance Sheet link still opens the Balance Sheet.
  let path = PAGE_PATHS[page];
  if (page === "acct_reports" && q.get("report")) path += "/" + reportSlug(q.get("report"));
  q.delete("report");
  const qs = q.toString();
  history.replaceState({ ...(history.state || {}), page }, "", path + (qs ? "?" + qs : ""));
  return page;
}
