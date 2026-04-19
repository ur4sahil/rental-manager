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

function deriveLegacyV2Key(companyId) {
  return deriveKeyFromSalt(Buffer.from("propmanager_" + companyId + "_v2", "utf8"));
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

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Missing bearer token" });
  const token = authHeader.slice(7);

  const { action, companyId, plaintext, ciphertext, iv, salt, legacyScheme } = req.body || {};
  if (!action || !companyId) return res.status(400).json({ error: "Missing action or companyId" });

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

  try {
    if (action === "encrypt") {
      if (typeof plaintext !== "string") return res.status(400).json({ error: "Missing plaintext" });
      // Always write new ciphertext under v3 (per-credential salt). Honour a
      // caller-provided salt if given (for idempotent re-encryption); else
      // generate a fresh one.
      const saltHex = (typeof salt === "string" && salt.length >= 16) ? salt : randomSaltHex();
      const key = deriveKeyFromSalt(Buffer.from(saltHex, "hex"));
      const out = encryptPayload(plaintext, key);
      return res.status(200).json({ ...out, salt: saltHex });
    }
    if (action === "decrypt") {
      if (typeof ciphertext !== "string" || typeof iv !== "string") return res.status(400).json({ error: "Missing ciphertext or iv" });
      let key;
      if (typeof salt === "string" && salt.length >= 16) {
        // v3 — per-credential salt
        key = deriveKeyFromSalt(Buffer.from(salt, "hex"));
      } else if (legacyScheme === "teller") {
        key = deriveLegacyTellerKey(companyId);
      } else {
        key = deriveLegacyV2Key(companyId);
      }
      const plain = decryptPayload(ciphertext, iv, key);
      return res.status(200).json({ plaintext: plain });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Crypto error" });
  }
};
