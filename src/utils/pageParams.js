// Query params that belong to ONE page, and the rules for keeping them there.
//
// The app navigates with history.pushState("#" + page). That is a
// fragment-only URL, which PRESERVES the query string by design -- so
// once the Reports page wrote ?report=bs&asOf=…, those params followed
// the user onto every other page:
//
//     /?report=bs&asOf=2026-05-01#acct_qbimport
//
// Keeping the rule here rather than at each navigation site means no page
// has to remember to clean up after itself, and adding a second page with
// its own params is one entry in the map below.

// page id -> the params that page owns
export const PAGE_SCOPED_PARAMS = {
  acct_reports: ["report", "period", "asOf", "from", "to"],
};

// Every param owned by some OTHER page than `page`.
function foreignParams(page) {
  const out = [];
  for (const [owner, keys] of Object.entries(PAGE_SCOPED_PARAMS)) {
    if (owner !== page) out.push(...keys);
  }
  return out;
}

// The URL to push when navigating to `page`: same path, same hash, but
// without any other page's params.
export function pageUrl(page, loc = window.location) {
  const q = new URLSearchParams(loc.search);
  foreignParams(page).forEach(k => q.delete(k));
  const qs = q.toString();
  return loc.pathname + (qs ? "?" + qs : "") + "#" + page;
}

// The URL with stale params swept, or null when there is nothing to do.
//
// Navigation is not the only way `page` changes -- boot resolves it from
// the hash, and Back/Forward go through setPageRaw -- so a URL pasted or
// reloaded with leftover params needs sweeping too. Returning null lets
// the caller skip a pointless replaceState.
export function sweptUrl(page, loc = window.location) {
  const q = new URLSearchParams(loc.search);
  const stale = foreignParams(page).filter(k => q.has(k));
  if (stale.length === 0) return null;
  stale.forEach(k => q.delete(k));
  const qs = q.toString();
  return loc.pathname + (qs ? "?" + qs : "") + loc.hash;
}
