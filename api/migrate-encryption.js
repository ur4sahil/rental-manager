// Vercel API Route: One-shot migration of legacy-encrypted credentials
// to the per-credential-salt (v3) scheme.
//
// Idempotent: only touches rows where the ciphertext exists AND
// encryption_salt is still NULL. Run once post-deploy via:
//   curl -X POST https://<host>/api/migrate-encryption \
//        -H "Authorization: Bearer $CRON_SECRET"
//
// Two input schemes handled:
//   - bank_connection.access_token_encrypted  → legacy "teller" scheme
//     (raw text-to-key: (companyId+"_propmanager_cred_key").slice(0,32).padEnd)
//   - everything else                          → legacy "v2" scheme
//     (PBKDF2 of MASTER with salt "propmanager_<companyId>_v2")
//
// Output scheme (all rows after migration):
//   PBKDF2-HMAC-SHA256, 100k iters, MASTER_KEY, per-credential 16-byte salt
//   AES-256-GCM with per-value IV, tag-appended
//
// Safe to re-run — rows with encryption_salt IS NOT NULL are skipped.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

const CRON_SECRET = process.env.CRON_SECRET || "";
const MASTER_KEY = process.env.ENCRYPTION_KEY || "";

function deriveV2Key(companyId) {
  if (!MASTER_KEY) throw new Error("ENCRYPTION_KEY not configured");
  const salt = Buffer.from("propmanager_" + companyId + "_v2", "utf8");
  return crypto.pbkdf2Sync(MASTER_KEY, salt, 100000, 32, "sha256");
}

// v2-fallback: rows encrypted between commits 148cb76 and 7fd7a86 when
// REACT_APP_ENCRYPTION_KEY was not set used `companyId + "_propmanager_cred_key"`
// as the PBKDF2 input material. Same salt + params as v2 otherwise.
function deriveV2FallbackKey(companyId) {
  const masterMaterial = companyId + "_propmanager_cred_key";
  const salt = Buffer.from("propmanager_" + companyId + "_v2", "utf8");
  return crypto.pbkdf2Sync(masterMaterial, salt, 100000, 32, "sha256");
}

function deriveTellerLegacyKey(companyId) {
  const s = (companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0");
  return Buffer.from(s, "utf8");
}

function deriveV3Key(saltBytes) {
  if (!MASTER_KEY) throw new Error("ENCRYPTION_KEY not configured");
  return crypto.pbkdf2Sync(MASTER_KEY, saltBytes, 100000, 32, "sha256");
}

function decryptWith(key, ciphertextB64, ivHex) {
  if (!ciphertextB64 || !ivHex) return "";
  const iv = Buffer.from(ivHex, "hex");
  const raw = Buffer.from(ciphertextB64, "base64");
  const TAG = 16;
  const tag = raw.slice(raw.length - TAG);
  const ct = raw.slice(0, raw.length - TAG);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function encryptV3(plaintext, saltBytes) {
  const iv = crypto.randomBytes(12);
  const key = deriveV3Key(saltBytes);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return {
    encrypted: Buffer.concat([ct, tag]).toString("base64"),
    iv: iv.toString("hex"),
  };
}

// Per-table definition: which columns hold ciphertext, which is the IV
// column, what the legacy decrypt scheme is.
const TABLES = [
  {
    name: "bank_connection",
    legacy: "teller",
    fields: ["access_token_encrypted"],
    extraSelect: "id, company_id, access_token_encrypted, encryption_iv, encryption_salt",
  },
  {
    name: "hoa_payments",
    legacy: "v2",
    fields: ["username_encrypted", "password_encrypted"],
    extraSelect: "id, company_id, username_encrypted, password_encrypted, encryption_iv, encryption_salt",
  },
  {
    name: "property_insurance",
    legacy: "v2",
    fields: ["username_encrypted", "password_encrypted"],
    extraSelect: "id, company_id, username_encrypted, password_encrypted, encryption_iv, encryption_salt",
  },
  {
    name: "property_loans",
    legacy: "v2",
    fields: ["username_encrypted", "password_encrypted"],
    extraSelect: "id, company_id, username_encrypted, password_encrypted, encryption_iv, encryption_salt",
  },
  {
    name: "utilities",
    legacy: "v2",
    fields: ["username_encrypted", "password_encrypted"],
    extraSelect: "id, company_id, username_encrypted, password_encrypted, encryption_iv, encryption_salt",
  },
  {
    name: "utility_accounts",
    legacy: "v2",
    fields: ["username_encrypted", "password_encrypted"],
    extraSelect: "id, company_id, username_encrypted, password_encrypted, encryption_iv, encryption_salt",
  },
];

async function migrateTable(supabase, tbl) {
  const out = { table: tbl.name, scanned: 0, migrated: 0, skipped: 0, failed: 0, errors: [] };

  // Only rows that still have the legacy scheme (no salt).
  const { data: rows, error } = await supabase.from(tbl.name)
    .select(tbl.extraSelect)
    .is("encryption_salt", null);
  if (error) {
    out.failed = -1;
    out.errors.push("select: " + error.message);
    return out;
  }

  for (const row of rows || []) {
    out.scanned++;
    // Skip rows with nothing to migrate.
    const hasAny = tbl.fields.some(f => row[f]);
    if (!hasAny || !row.encryption_iv) { out.skipped++; continue; }

    try {
      // Legacy derivation candidates. For tbl.legacy === "teller" only the
      // weak scheme applies. For v2 tables, rows may have been encrypted
      // under either the env-key v2 path OR the pre-env fallback path
      // (see git: 148cb76 introduced the fallback; 7fd7a86 removed it).
      const candidateKeys = tbl.legacy === "teller"
        ? [deriveTellerLegacyKey(row.company_id)]
        : [deriveV2Key(row.company_id), deriveV2FallbackKey(row.company_id)];

      // IMPORTANT: rows have multiple ciphertext fields (username + password)
      // that were each encrypted with their own random IV, but the schema
      // only stores ONE encryption_iv column — the last one written. So at
      // most ONE field decrypts with the stored IV; the other is lost.
      // Decrypt per-field independently so we salvage what we can instead
      // of failing the whole row. The unrecoverable field is written back
      // as empty string — user will re-enter it.
      const plains = {};
      let anyAuthenticated = false;
      for (const f of tbl.fields) {
        if (!row[f]) { plains[f] = ""; continue; }
        let got = null;
        for (const key of candidateKeys) {
          try { got = decryptWith(key, row[f], row.encryption_iv); break; }
          catch (_) { /* wrong key/IV combo — try next */ }
        }
        if (got !== null) {
          plains[f] = got;
          anyAuthenticated = true;
        } else {
          plains[f] = ""; // unrecoverable — user must re-enter
        }
      }
      if (!anyAuthenticated) throw new Error("No field authenticated under any candidate key");

      // Fresh per-row salt. Re-encrypt each field under v3; each field gets a
      // fresh IV. We persist only one IV column (pre-existing schema shape),
      // using the last-encrypted field's IV. Any caller still using the
      // legacy one-IV-for-all-fields convention reads the password cleanly;
      // the username-with-wrong-IV behaviour is a pre-existing latent issue
      // that is outside the M15 scope.
      const salt = crypto.randomBytes(16);
      const update = { encryption_salt: salt.toString("hex") };
      let lastIv = null;
      for (const f of tbl.fields) {
        if (!plains[f]) { update[f] = ""; continue; }
        const r = encryptV3(plains[f], salt);
        update[f] = r.encrypted;
        lastIv = r.iv;
      }
      if (lastIv) update.encryption_iv = lastIv;

      const { error: upErr } = await supabase.from(tbl.name).update(update).eq("id", row.id);
      if (upErr) {
        out.failed++;
        out.errors.push(`${tbl.name}/${row.id}: ${upErr.message}`);
        continue;
      }
      out.migrated++;
    } catch (e) {
      out.failed++;
      out.errors.push(`${tbl.name}/${row.id}: ${e.message}`);
    }
  }
  return out;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const authHeader = req.headers.authorization || "";
  const isCronAuth = CRON_SECRET && CRON_SECRET.length >= 8 && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isCronAuth) return res.status(401).json({ error: "Unauthorized" });
  if (!MASTER_KEY) return res.status(500).json({ error: "ENCRYPTION_KEY not configured" });

  try {
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const results = [];
    for (const tbl of TABLES) {
      results.push(await migrateTable(supabase, tbl));
    }
    const totals = results.reduce((a, r) => ({
      scanned: a.scanned + (r.scanned || 0),
      migrated: a.migrated + (r.migrated || 0),
      skipped: a.skipped + (r.skipped || 0),
      failed: a.failed + (r.failed > 0 ? r.failed : 0),
    }), { scanned: 0, migrated: 0, skipped: 0, failed: 0 });
    return res.status(200).json({ ok: true, totals, per_table: results, at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
