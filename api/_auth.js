// Shared constant-time comparison for cron/shared-secret auth.
// Plain `===` on strings is O(n) but with early-exit on first mismatch,
// which leaks information via timing differences — a classic side
// channel for shared-secret endpoints. crypto.timingSafeEqual compares
// in constant time regardless of where the strings diverge. Falls back
// to simple === only when the lengths differ (no leak possible — the
// length itself is the mismatch signal).
const crypto = require("crypto");

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isCronSecretBearer(authHeader, cronSecret) {
  if (!cronSecret || cronSecret.length < 8) return false;
  if (typeof authHeader !== "string") return false;
  const expected = "Bearer " + cronSecret;
  return constantTimeEqual(authHeader, expected);
}

function cronSecretMatches(bodySecret, cronSecret) {
  if (!cronSecret || cronSecret.length < 8) return false;
  return constantTimeEqual(bodySecret || "", cronSecret);
}

module.exports = { constantTimeEqual, isCronSecretBearer, cronSecretMatches };
