// Vercel API Route: Credential encryption / decryption.
//
// Moves AES-256-GCM + PBKDF2 off the client bundle so the master key
// never ships to a browser. Bit-compatible with the old Web Crypto
// implementation in src/utils/encryption.js so existing rows still
// decrypt — same PBKDF2 params (SHA-256, 100k iters), same salt
// (`propmanager_<companyId>_v2`), same tag-appended GCM layout.
//
// Auth: user's Supabase session JWT in the Authorization header. We
// verify the user is an active `company_members` row for the requested
// companyId before doing anything. Service role is NOT used here — RLS
// enforces membership lookup.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const MASTER_KEY = process.env.ENCRYPTION_KEY || "";

function deriveKey(companyId) {
  if (!MASTER_KEY) throw new Error("ENCRYPTION_KEY not configured");
  const salt = Buffer.from("propmanager_" + companyId + "_v2", "utf8");
  return crypto.pbkdf2Sync(MASTER_KEY, salt, 100000, 32, "sha256");
}

function encryptPayload(plaintext, companyId) {
  if (!plaintext) return { encrypted: "", iv: "" };
  const iv = crypto.randomBytes(12);
  const key = deriveKey(companyId);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { encrypted: Buffer.concat([ct, tag]).toString("base64"), iv: iv.toString("hex") };
}

function decryptPayload(b64, ivHex, companyId) {
  if (!b64 || !ivHex) return "";
  const key = deriveKey(companyId);
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
  res.setHeader("Access-Control-Allow-Origin", "https://rental-manager-one.vercel.app");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "Missing bearer token" });
  const token = authHeader.slice(7);

  const { action, companyId, plaintext, ciphertext, iv } = req.body || {};
  if (!action || !companyId) return res.status(400).json({ error: "Missing action or companyId" });

  // Verify the caller is an active member of companyId using their own JWT
  // (so RLS does the gatekeeping — service role is not used here).
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
      return res.status(200).json(encryptPayload(plaintext, companyId));
    }
    if (action === "decrypt") {
      if (typeof ciphertext !== "string" || typeof iv !== "string") return res.status(400).json({ error: "Missing ciphertext or iv" });
      return res.status(200).json({ plaintext: decryptPayload(ciphertext, iv, companyId) });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Crypto error" });
  }
};
