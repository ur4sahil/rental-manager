// Vercel API Route: Credential encryption / decryption.
//
// Moves AES-256-GCM + PBKDF2 off the client bundle so the master key
// never ships to a browser. Holds ENCRYPTION_KEY as a server-only
// Vercel secret and verifies the caller's Supabase session +
// company_members membership before doing anything.
//
// Key scheme:
//   PBKDF2-HMAC-SHA256, 100k iters, 32-byte output
//   - v3 (per-credential):  salt = <random 16 bytes, hex>, passed by caller
//   - v2 (legacy):          salt = "propmanager_<companyId>_v2"
//   - teller (legacy):      raw text-to-key, pre-C3. Only for
//                           bank_connection.access_token_encrypted rows
//                           that haven't been migrated yet.
//
// Encrypt responses always include the salt used, so callers can persist
// it alongside the ciphertext. Decrypt accepts an optional salt — if
// present, v3; if absent, falls back to legacyScheme (default "v2").
//
// Tag-appended GCM layout matches the old Web Crypto output so existing
// data decrypts unchanged.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

const MASTER_KEY = process.env.ENCRYPTION_KEY || "";

function deriveKeyFromSalt(saltBytes) {
  if (!MASTER_KEY) throw new Error("ENCRYPTION_KEY not configured");
  return crypto.pbkdf2Sync(MASTER_KEY, saltBytes, 100000, 32, "sha256");
}

// PBKDF2 at 100k iterations is ~100ms per derivation. A page that
// decrypts N credential rows under the same legacy scheme used to
// burn N × (1 or 2) derivations; cache the winning key per
// (companyId, scheme) for the lifetime of the serverless instance.
const _legacyKeyCache = new Map();
function legacyKeyCacheKey(companyId, scheme) { return companyId + "|" + scheme; }
function getCachedLegacyKey(companyId, scheme) { return _legacyKeyCache.get(legacyKeyCacheKey(companyId, scheme)) || null; }
function setCachedLegacyKey(companyId, scheme, key) { _legacyKeyCache.set(legacyKeyCacheKey(companyId, scheme), key); }

function deriveLegacyV2Key(companyId) {
  return deriveKeyFromSalt(Buffer.from("propmanager_" + companyId + "_v2", "utf8"));
}

// Pre-env fallback scheme used between commits 148cb76..7fd7a86 when
// REACT_APP_ENCRYPTION_KEY was unset. PBKDF2 input material was
// `companyId + "_propmanager_cred_key"`, not the master key.
function deriveLegacyV2FallbackKey(companyId) {
  const masterMaterial = companyId + "_propmanager_cred_key";
  const salt = Buffer.from("propmanager_" + companyId + "_v2", "utf8");
  return crypto.pbkdf2Sync(masterMaterial, salt, 100000, 32, "sha256");
}

function deriveLegacyTellerKey(companyId) {
  // Matches the old inline scheme in api/teller-save-enrollment.js pre-M15:
  //   (companyId + "_propmanager_cred_key").slice(0,32).padEnd(32,"0")
  const s = (companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0");
  return Buffer.from(s, "utf8");
}

function randomSaltHex() {
  return crypto.randomBytes(16).toString("hex");
}

function encryptPayload(plaintext, key) {
  if (!plaintext) return { encrypted: "", iv: "" };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encrypted: Buffer.concat([ct, tag]).toString("base64"), iv: iv.toString("hex") };
}

function decryptPayload(b64, ivHex, key) {
  if (!b64 || !ivHex) return "";
  const iv = Buffer.from(ivHex, "hex");
  const combined = Buffer.from(b64, "base64");
  const TAG_LEN = 16;
  if (combined.length < TAG_LEN) throw new Error("ciphertext too short");
  const ct = combined.slice(0, combined.length - TAG_LEN);
  const tag = combined.slice(combined.length - TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// Input bounds. Generous enough for any real credential but tight enough
// that a garbage-payload flood can't slide through.
const MAX_PLAINTEXT_LEN = 4096;   // 4 KB covers any password / token / secret
const MAX_CIPHERTEXT_LEN = 8192;  // base64(4 KB + 16-byte tag) ≈ 5.5 KB; 8 KB leaves headroom
const MAX_COMPANYID_LEN = 128;
const IV_HEX_LEN = 24;            // 12 bytes × 2 hex chars
const SALT_HEX_MIN = 16;
const SALT_HEX_MAX = 64;
const VALID_ACTIONS = new Set(["encrypt", "decrypt"]);
const VALID_LEGACY_SCHEMES = new Set(["teller", "v2"]);
const HEX_RE = /^[0-9a-fA-F]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // ─── Cheap local validation FIRST. Every check below runs without touching
  // Supabase, so a garbage-payload flood never triggers an auth.getUser call
  // or a DB round-trip. Budget DoS → 400 at the edge of the function.
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ") || authHeader.length < 20 || authHeader.length > 4096) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  const body = req.body || {};
  const { action, companyId, plaintext, ciphertext, iv, salt, legacyScheme } = body;

  if (!VALID_ACTIONS.has(action)) return res.status(400).json({ error: "Invalid action" });
  if (typeof companyId !== "string" || !companyId || companyId.length > MAX_COMPANYID_LEN) {
    return res.status(400).json({ error: "Invalid companyId" });
  }
  if (action === "encrypt") {
    if (typeof plaintext !== "string" || plaintext.length > MAX_PLAINTEXT_LEN) {
      return res.status(400).json({ error: "Invalid plaintext" });
    }
  } else {
    if (typeof ciphertext !== "string" || !ciphertext || ciphertext.length > MAX_CIPHERTEXT_LEN || !BASE64_RE.test(ciphertext)) {
      return res.status(400).json({ error: "Invalid ciphertext" });
    }
    if (typeof iv !== "string" || iv.length !== IV_HEX_LEN || !HEX_RE.test(iv)) {
      return res.status(400).json({ error: "Invalid iv" });
    }
  }
  if (salt !== undefined && salt !== null) {
    if (typeof salt !== "string" || salt.length < SALT_HEX_MIN || salt.length > SALT_HEX_MAX || !HEX_RE.test(salt)) {
      return res.status(400).json({ error: "Invalid salt" });
    }
  }
  if (legacyScheme !== undefined && legacyScheme !== null && !VALID_LEGACY_SCHEMES.has(legacyScheme)) {
    return res.status(400).json({ error: "Invalid legacyScheme" });
  }

  // ─── Only AFTER the cheap rejects do we instantiate the Supabase client and
  // hit auth.getUser.
  const token = authHeader.slice(7);
  const userClient = createClient(
    process.env.REACT_APP_SUPABASE_URL,
    process.env.REACT_APP_SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return res.status(401).json({ error: "Invalid session" });
  const userEmail = userData.user.email;

  const { data: membership } = await userClient
    .from("company_members")
    .select("role, status")
    .eq("company_id", companyId)
    .eq("user_email", userEmail)
    .eq("status", "active")
    .maybeSingle();
  if (!membership) return res.status(403).json({ error: "Not a member of this company" });

  // Credential actions are restricted to admin/owner/pm. Without this
  // check a company member with role=tenant could POST to /api/encrypt
  // with action=decrypt and recover any credential stored for the
  // company — utility passwords, HOA logins, Teller access tokens. The
  // UI never shows credentials to tenants, but the API enforced no
  // role gate, so the guard has to live here.
  const CRED_ROLES = new Set(["admin", "owner", "pm"]);
  if (!CRED_ROLES.has(membership.role)) {
    return res.status(403).json({ error: "Insufficient role for credential operations" });
  }

  try {
    if (action === "encrypt") {
      // Write new ciphertext under v3 (per-credential salt). Honour a
      // caller-provided salt if given (for idempotent re-encryption); else
      // generate a fresh one. Shape already validated above.
      const saltHex = (typeof salt === "string" && salt.length >= 16) ? salt : randomSaltHex();
      const key = deriveKeyFromSalt(Buffer.from(saltHex, "hex"));
      const out = encryptPayload(plaintext, key);
      return res.status(200).json({ ...out, salt: saltHex });
    }
    if (action === "decrypt") {
      // Try candidate keys in order; use the first that authenticates.
      // This lets pre-migration rows keep rendering without the
      // frontend needing to know which legacy scheme was used. Caches
      // the winning legacy key per (companyId, scheme) so subsequent
      // decrypts in the same serverless process skip re-deriving.
      let candidates;
      if (typeof salt === "string" && salt.length >= 16) {
        candidates = [{ key: deriveKeyFromSalt(Buffer.from(salt, "hex")), scheme: null }];
      } else {
        const scheme = legacyScheme === "teller" ? "teller" : "v2";
        const cached = getCachedLegacyKey(companyId, scheme);
        if (cached) {
          candidates = [{ key: cached, scheme }];
        } else if (scheme === "teller") {
          candidates = [{ key: deriveLegacyTellerKey(companyId), scheme }];
        } else {
          candidates = [
            { key: deriveLegacyV2Key(companyId), scheme },
            { key: deriveLegacyV2FallbackKey(companyId), scheme: scheme + "-fallback" },
          ];
        }
      }
      let plain = null, lastErr = null;
      for (const cand of candidates) {
        try {
          plain = decryptPayload(ciphertext, iv, cand.key);
          if (cand.scheme) setCachedLegacyKey(companyId, cand.scheme.replace(/-fallback$/, ""), cand.key);
          break;
        } catch (e) { lastErr = e; }
      }
      if (plain === null) throw lastErr || new Error("decryption failed");
      return res.status(200).json({ plaintext: plain });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Crypto error" });
  }
};
