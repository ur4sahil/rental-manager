export const _submitGuards = {};
// Use NUL as the separator — a character that can't appear in a JS
// identifier key or a UUID, so ("save", "foo") can't collide with
// ("save:foo", undefined) the way the old ":" separator could.
const GUARD_SEP = "\u0000";
function buildKey(key, recordId) {
  return recordId !== undefined && recordId !== null ? key + GUARD_SEP + recordId : key;
}
export function guardSubmit(key, recordId) {
  const guardKey = buildKey(key, recordId);
  if (_submitGuards[guardKey]) return false;
  _submitGuards[guardKey] = Date.now();
  setTimeout(() => { delete _submitGuards[guardKey]; }, 30000); // auto-cleanup after 30s
  return true;
}
export function guardRelease(key, recordId) {
  const guardKey = buildKey(key, recordId);
  delete _submitGuards[guardKey]; // delete instead of setting false to prevent memory leak
}
// Periodic sweep to catch any guard whose setTimeout cleanup was
// throttled (hidden tab, browser backgrounding). Stores creation
// timestamp so we can tell age; anything older than 2 min is stale.
// The prior sweep tested !_submitGuards[k], which was never true
// because guards are set to truthy values — making the interval a
// no-op. Running every 5 min is fine; this is belt-and-suspenders.
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const k of Object.keys(_submitGuards)) {
    const stamp = _submitGuards[k];
    if (typeof stamp === "number" && stamp < cutoff) delete _submitGuards[k];
  }
}, 300000);
// Wrapper: use in async functions to auto-release on completion or error
export async function guarded(key, fn) {
  if (!guardSubmit(key)) return;
  try { await fn(); } finally { guardRelease(key); }
}

export function requireCompanyId(companyId, context = "") {
  if (!companyId) {
  const msg = "CRITICAL: Missing companyId" + (context ? " in " + context : "") + " — operation blocked";
  console.error(msg);
  throw new Error(msg);
  }
  return companyId;
}
