// Stored portal logins: which key opens them, and which login to use.
//
// Pure helpers, split out of ensure-session.js (a CLI that runs on load) so
// the rules can be tested. Nothing here reads the database or the network.
const fs = require("fs");
const crypto = require("crypto");

// THE MASTER KEY. ENCRYPTION_KEY_FILE first: its bytes are read verbatim, and
// the deployed key carries a trailing newline (the ciphertext was written
// under KEY + "\n"). A key exported through a shell `$(...)` loses that
// newline, which changes both the key bytes and the raw hash. The env var is
// only the fallback when no file is configured or readable.
function readMasterKey(env = process.env) {
  if (env.ENCRYPTION_KEY_FILE) {
    try {
      const k = fs.readFileSync(env.ENCRYPTION_KEY_FILE, "utf8");
      if (k) return k;
    } catch {}
  }
  return env.ENCRYPTION_KEY || "";
}

// THE FINGERPRINT RULE -- identical to api/encrypt.js KEY_FP:
//   fp = sha256( the EXACT key bytes used to decrypt ), first 12 hex chars
// Not normalised: a trailing newline is part of the key, so a key that lost
// it is a DIFFERENT key and must show a different fingerprint (a mismatch
// reported as such, not a row that silently fails to decrypt).
function fingerprintOf(material) {
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 12);
}
function keyFingerprint(master) {
  return fingerprintOf(String(master || ""));
}
function acceptedFingerprints(master) {
  return new Set([keyFingerprint(master)]);
}

// DECRYPT -- the same scheme as api/encrypt.js v3: PBKDF2-SHA256, 100k
// iterations, 32-byte key, AES-256-GCM with the 16-byte tag appended.
function decryptValue(master, b64, ivHex, saltHex) {
  if (!b64 || !ivHex || !saltHex) return "";
  const key = crypto.pbkdf2Sync(master, Buffer.from(saltHex, "hex"), 100000, 32, "sha256");
  const iv = Buffer.from(ivHex, "hex");
  const combined = Buffer.from(b64, "base64");
  const TAG = 16;
  if (combined.length < TAG) throw new Error("ciphertext too short");
  const ct = combined.slice(0, combined.length - TAG);
  const tag = combined.slice(combined.length - TAG);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// Only live, ongoing lines carry a usable login. An archived row is a retired
// or duplicate account whose stale login must not outvote a rotated one, and
// the owner->tenant final-bill closeout line is a copy of the ongoing line.
// The API and the direct query already filter these; this is the backstop for
// a row set from anywhere else.
function isLiveLoginRow(r) {
  return !!r && !r.archived_at && r.is_final_bill !== true;
}

// PICK THE MOST COMMON (username, password) among the matching rows. Each
// utility account stores its own copy of the portal login, so the current
// credential repeats while stale ones are the minority. preferUser pins one.
// Returns { username, password } or { error, sawForeignKey }.
function pickCredential(rows, master, { aliases = [], preferUser = "" } = {}) {
  const al = aliases.map(a => String(a).toLowerCase());
  const matches = (rows || []).filter(r => {
    if (!isLiveLoginRow(r)) return false;
    const p = String(r.provider || "").trim().toLowerCase();
    return al.some(a => p === a || p.includes(a));
  });
  if (!matches.length) return { error: "no_rows" };
  const okFps = acceptedFingerprints(master);
  const pin = String(preferUser || "").trim().toLowerCase();
  const groups = new Map();
  let sawForeignKey = false;
  for (const r of matches) {
    if (r.credential_key_fp && !okFps.has(r.credential_key_fp)) { sawForeignKey = true; continue; }
    let u, p;
    try {
      u = decryptValue(master, r.username_encrypted, r.encryption_iv_username || r.encryption_iv, r.encryption_salt);
      p = decryptValue(master, r.password_encrypted, r.encryption_iv, r.encryption_salt);
    } catch { continue; }
    if (!u || !p) continue;
    if (pin && u.trim().toLowerCase() !== pin) continue;
    const key = u + "\x00" + p;
    const g = groups.get(key) || { count: 0, username: u, password: p };
    g.count++; groups.set(key, g);
  }
  if (!groups.size) return { error: "none_decrypted", sawForeignKey };
  const best = [...groups.values()].sort((a, b) => b.count - a.count)[0];
  return { username: best.username, password: best.password, votes: best.count };
}

module.exports = { readMasterKey, keyFingerprint, acceptedFingerprints, decryptValue, isLiveLoginRow, pickCredential };
