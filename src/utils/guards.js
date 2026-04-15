export const _submitGuards = {};
export function guardSubmit(key, recordId) {
  const guardKey = recordId ? key + ":" + recordId : key;
  if (_submitGuards[guardKey]) return false;
  _submitGuards[guardKey] = true;
  setTimeout(() => { delete _submitGuards[guardKey]; }, 30000); // auto-cleanup after 30s
  return true;
}
export function guardRelease(key, recordId) {
  const guardKey = recordId ? key + ":" + recordId : key;
  delete _submitGuards[guardKey]; // delete instead of setting false to prevent memory leak
}
// Periodic cleanup of stale guards (runs every 5 min)
setInterval(() => { Object.keys(_submitGuards).forEach(k => { if (!_submitGuards[k]) delete _submitGuards[k]; }); }, 300000);
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
