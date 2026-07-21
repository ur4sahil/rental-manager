// Shared Plaid helpers for the api/ routes. Plaid replaced Teller.io after
// Teller shut down its API (2026-07). No mTLS needed — Plaid uses plain
// client_id/secret headers, so these are ordinary Vercel serverless routes.
const crypto = require("crypto");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");

// ── Plaid client ──────────────────────────────────────────────────────────
// PLAID_ENV is "sandbox" | "development" | "production". Development is a
// legacy Plaid tier; we run sandbox for tests and production for real banks.
function getPlaidClient() {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || "sandbox";
  if (!clientId || !secret) throw new Error("PLAID_CLIENT_ID / PLAID_SECRET not configured");
  const basePath = PlaidEnvironments[env] || PlaidEnvironments.sandbox;
  return new PlaidApi(new Configuration({
    basePath,
    baseOptions: { headers: { "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret } },
  }));
}

// ── Credential encryption ───────────────────────────────────────────────────
// Identical AES-256-GCM + PBKDF2 scheme used for Teller tokens, so Plaid
// access_tokens store in the same bank_connection columns
// (access_token_encrypted / encryption_iv / encryption_salt) and decrypt the
// same way. MASTER_KEY is the shared server-only ENCRYPTION_KEY secret.
const MASTER_KEY = process.env.ENCRYPTION_KEY || "";
function encrypt(plaintext) {
  if (!plaintext) return { encrypted: "", iv: "", salt: "" };
  if (!MASTER_KEY) throw new Error("ENCRYPTION_KEY not configured");
  const iv = crypto.randomBytes(12);
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(MASTER_KEY, salt, 100000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([ct, tag]).toString("base64"),
    iv: iv.toString("hex"),
    salt: salt.toString("hex"),
  };
}
function decrypt(encryptedB64, ivHex, saltHex) {
  if (!encryptedB64 || !ivHex || !saltHex || !MASTER_KEY) return "";
  try {
    const key = crypto.pbkdf2Sync(MASTER_KEY, Buffer.from(saltHex, "hex"), 100000, 32, "sha256");
    const iv = Buffer.from(ivHex, "hex");
    const raw = Buffer.from(encryptedB64, "base64");
    const authTag = raw.slice(raw.length - 16);
    const ciphertext = raw.slice(0, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, null, "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return "";
  }
}

// ── Account type mapping ────────────────────────────────────────────────────
// Map Plaid (type, subtype) to our feed account_type vocabulary. Mirrors the
// Teller mapping (checking / savings / credit_card) so the frontend and GL
// suggestions behave identically.
function mapAcctType(type, subtype) {
  if (type === "credit") return "credit_card";
  if (subtype === "savings" || subtype === "money market") return "savings";
  if (type === "depository") return "checking";
  return type || "checking"; // loan/investment surface as-is; user picks in modal
}

// ── Fingerprint (cross-source dedup with CSV imports) ───────────────────────
// MUST stay identical to csvBuildFingerprint in src/components/Banking.js and
// buildFingerprint in the (retired) teller-sync — the CSV<>bank crosswalk
// depends on byte-identical output.
function normDescription(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\\"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function buildFingerprint(feedId, date, direction, absAmount, description) {
  return `${feedId}|${date}|${direction}|${Math.round(absAmount * 100)}|${normDescription(description)}`;
}

// ── Plaid transaction → bank_feed_transaction row ───────────────────────────
// CRITICAL sign convention: Plaid `amount` is POSITIVE for money LEAVING the
// account (outflow) and NEGATIVE for money entering (inflow) — the OPPOSITE of
// Teller. We normalize to (direction, abs amount) so all downstream code
// (fingerprint, reconciliation, GL) is sign-agnostic. Returns null for the
// caller to skip (e.g. no matching feed).
function plaidTxnToRow(txn, feed, companyId) {
  const amountNum = parseFloat(txn.amount) || 0;
  // Plaid: +amount = outflow, -amount = inflow. Flip vs Teller.
  const direction = amountNum > 0 ? "outflow" : "inflow";
  const amount = Math.abs(amountNum);
  const date = txn.date || ""; // posted date (YYYY-MM-DD)
  const payee = txn.merchant_name || txn.counterparties?.[0]?.name || "";
  const desc = txn.name || payee || "";
  const fp = buildFingerprint(feed.id, date, direction, amount, desc);
  const sanitizedPayload = {
    transaction_id: txn.transaction_id,
    account_id: txn.account_id,
    date: txn.date,
    authorized_date: txn.authorized_date,
    amount: txn.amount,
    name: txn.name,
    merchant_name: txn.merchant_name,
    pending: txn.pending,
    payment_channel: txn.payment_channel,
    category: txn.personal_finance_category?.primary || (Array.isArray(txn.category) ? txn.category[0] : undefined),
  };
  return {
    company_id: companyId,
    bank_account_feed_id: feed.id,
    source_type: "plaid",
    provider_transaction_id: txn.transaction_id,
    posted_date: date,
    amount,
    direction,
    bank_description_raw: desc,
    bank_description_clean: desc,
    payee_raw: payee,
    payee_normalized: payee,
    check_number: txn.check_number || null,
    reference_number: null,
    balance_after: null,
    fingerprint_hash: fp,
    status: "for_review",
    raw_payload_json: sanitizedPayload,
  };
}

module.exports = { getPlaidClient, encrypt, decrypt, mapAcctType, normDescription, buildFingerprint, plaidTxnToRow };
