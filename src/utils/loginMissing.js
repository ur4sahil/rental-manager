// "LOGIN MISSING" to-dos for the Tasks & Approvals page.
//
// A utility, insurance policy, loan or HOA can be saved without its portal
// login (chk_*_creds_not_blank allows NULL; the column defaults are NULL since
// 20260928120000). Nothing then reminds anyone to add it, and the daily bill
// sweep silently skips a utility it cannot log in to. These to-dos are
// COMPUTED from the records themselves -- there is no task table -- so one
// disappears the moment a login is saved.
//
// Pure module (no supabase import) so tests/login-missing.test.mjs can run the
// exact same rules in node that the page runs in the browser.

// A value counts as a stored login only when it is non-blank. Rows written
// before 20260914210000 could hold '' -- treat that as missing too.
export const hasValue = (v) => typeof v === "string" ? v.trim() !== "" : v != null;

// A login is BOTH halves. A username with no password (or the reverse) is not
// a login: the portal worker skips such a row, so it must not clear the to-do.
export const hasPair = (u, p) => hasValue(u) && hasValue(p);

// Exactly one half typed into a form. Every save refuses this rather than
// storing half a login that looks saved and never works.
export const isHalfLogin = (username, password) => hasValue(username) !== hasValue(password);
export const halfLoginMessage = (what = "portal login") =>
  "Enter both the username and the password for the " + what + ", or leave both blank.";

// Utilities the TENANT pays are the tenant's business, not a to-do for us.
// The utilities table stores the short form ("tenant"); the wizard's form
// state uses the long form ("tenant_pays"). Accept both.
export function isTenantPaid(responsibility) {
  const r = String(responsibility || "").trim().toLowerCase();
  return r === "tenant" || r === "tenant_pays";
}

// Utilities covered by the condo/HOA fee: nobody logs in to pay them. The
// app's one value for this is "condo_fee" (Utilities.js, the wizard).
export function isCondoFee(responsibility) {
  return String(responsibility || "").trim().toLowerCase() === "condo_fee";
}

// A paid-off loan needs no portal login. Loans.js offers "active" / "paid_off".
export const isPaidOff = (status) => String(status || "").trim().toLowerCase() === "paid_off";

// Portfolio (blanket) loans cover several properties, so they have no single
// property card; they share one card under this name.
export const PORTFOLIO_LOANS_GROUP = "Portfolio loans";

// One entry per record type (property-scoped unless `group` says otherwise). `select` is what the Tasks page reads; `name`
// picks the display name; `hasLogin` decides whether the to-do is needed.
export const LOGIN_MISSING_SOURCES = [
  {
    kind: "utility", label: "Utility", icon: "⚡", page: "utilities", table: "utilities",
    // The daily bill sweep reads logins from `utilities`, so that row is the
    // one that decides. Final bills are one-off move-out statements.
    select: "id, property, provider, responsibility, is_final_bill, archived_at, username_encrypted, password_encrypted",
    name: (r) => r.provider,
    include: (r) => !r.archived_at && r.is_final_bill !== true && !isTenantPaid(r.responsibility) && !isCondoFee(r.responsibility),
    hasLogin: (r) => hasPair(r.username_encrypted, r.password_encrypted),
  },
  {
    kind: "insurance", label: "Insurance", icon: "🛡️", page: "insurance", table: "property_insurance",
    select: "id, property, provider, archived_at, username_encrypted, password_encrypted",
    name: (r) => r.provider,
    include: (r) => !r.archived_at,
    hasLogin: (r) => hasPair(r.username_encrypted, r.password_encrypted),
  },
  {
    kind: "loan", label: "Loan", icon: "🏦", page: "loans", table: "property_loans",
    select: "id, property, lender_name, status, archived_at, username_encrypted, password_encrypted",
    name: (r) => r.lender_name,
    include: (r) => !r.archived_at && !isPaidOff(r.status),
    hasLogin: (r) => hasPair(r.username_encrypted, r.password_encrypted),
  },
  {
    kind: "portfolio_loan", label: "Portfolio loan", icon: "🏦", page: "loans", table: "portfolio_loans",
    select: "id, lender_name, status, archived_at, username_encrypted, password_encrypted",
    name: (r) => r.lender_name,
    include: (r) => !r.archived_at && !isPaidOff(r.status),
    hasLogin: (r) => hasPair(r.username_encrypted, r.password_encrypted),
    // No single property: grouped under one "Portfolio loans" card, and the
    // Loans page opens the portfolio loan's own edit form.
    group: () => PORTFOLIO_LOANS_GROUP,
    action: (r) => ({ editPortfolioId: r.id }),
  },
  {
    kind: "hoa", label: "HOA", icon: "🏘️", page: "hoa", table: "hoa_payments",
    // An HOA carries up to three logins (association, management company,
    // payment portal). Any one of them is a login.
    select: "id, property, hoa_name, archived_at, username_encrypted, password_encrypted, mgmt_username_encrypted, mgmt_password_encrypted, pay_username_encrypted, pay_password_encrypted",
    name: (r) => r.hoa_name,
    include: (r) => !r.archived_at,
    hasLogin: (r) => hasPair(r.username_encrypted, r.password_encrypted)
      || hasPair(r.mgmt_username_encrypted, r.mgmt_password_encrypted)
      || hasPair(r.pay_username_encrypted, r.pay_password_encrypted),
  },
];

// rowsByKind: { utility: [...], insurance: [...], loan: [...], hoa: [...] }
// propertyIdByAddress: optional Map(address -> property id), for the card.
//
// Returns task objects in the shape TasksList already renders: `address`
// puts each one under its property's card; `link` + `linkAction` open that
// record's edit form on its own page.
export function buildLoginMissingTasks(rowsByKind, propertyIdByAddress = new Map(), { allowedPages } = {}) {
  const tasks = [];
  for (const src of LOGIN_MISSING_SOURCES) {
    // Only to-dos the viewer can act on: the link must open a page they have.
    if (Array.isArray(allowedPages) && !allowedPages.includes(src.page)) continue;
    const rows = (rowsByKind && rowsByKind[src.kind]) || [];
    // Utilities can hold more than one live row for the same provider at the
    // same property; that is one login to add, so one to-do. If any of those
    // rows has a login, the provider is covered.
    const seen = new Map();
    for (const r of rows) {
      if (!r || !src.include(r)) continue;
      const key = src.kind === "utility"
        ? String(r.property || "") + "|" + String(r.provider || "").trim().toLowerCase()
        : String(r.id);
      const prev = seen.get(key);
      if (!prev) seen.set(key, { row: r, covered: src.hasLogin(r) });
      else if (src.hasLogin(r)) prev.covered = true;
    }
    for (const { row: r, covered } of seen.values()) {
      if (covered) continue;
      const name = String(src.name(r) || "").trim() || src.label;
      const address = src.group ? src.group(r) : (r.property || null);
      tasks.push({
        icon: src.icon,
        title: name + " — login missing (" + src.label + ")",
        subtitle: address || "",
        address,
        propertyId: src.group ? null : (propertyIdByAddress.get(r.property) || null),
        link: src.page,
        linkAction: src.action ? src.action(r) : { editRecordId: r.id },
        priority: "medium",
        _kind: "login_missing",
        recordType: src.kind,
        recordId: r.id,
      });
    }
  }
  return tasks;
}
