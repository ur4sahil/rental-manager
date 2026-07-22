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

// ── Cross-source dedup (Teller/CSV -> Plaid) ────────────────────────────────
// Match key for the SAME real bank event across DIFFERENT import sources.
// Provider ids never line up across sources, and descriptions differ by
// provider (Teller's raw bank string vs Plaid's cleaned `name`), so the key
// deliberately EXCLUDES description: feed + posted date + direction + cents.
// Looser than the full fingerprint, but paired with count-aware matching
// (selectInserts) it can't collapse genuinely-distinct transactions — it only
// skips as many incoming rows as there are existing rows with the same key.
function crossSourceKey(feedId, date, direction, absAmount) {
  return `${feedId}|${date}|${direction}|${Math.round(Math.abs(Number(absAmount) || 0) * 100)}`;
}

// Decide which incoming rows to INSERT after dedup. Pure + deterministic so
// the count logic is unit-testable.
//   - alreadyImported: Set of provider_transaction_id already in the DB
//     (same-source re-import guard — exact).
//   - existingCounts: Map<crossSourceKey, count> of existing OTHER-source rows
//     in the window. COUNT-AWARE: an incoming row is skipped only while an
//     unmatched existing row with its key remains; the count decrements as we
//     match. So 3 Teller + 3 identical Plaid -> skip all 3; 1 Teller + 3
//     distinct Plaid -> skip 1, insert 2 (no legit loss).
function selectInserts(rows, existingCounts, alreadyImported) {
  const counts = new Map(existingCounts); // clone; we mutate as we match
  const seen = alreadyImported || new Set();
  const inserts = [];
  for (const r of rows) {
    if (r.provider_transaction_id && seen.has(r.provider_transaction_id)) continue;
    const k = crossSourceKey(r.bank_account_feed_id, r.posted_date, r.direction, r.amount);
    const remaining = counts.get(k) || 0;
    if (remaining > 0) { counts.set(k, remaining - 1); continue; }
    inserts.push(r);
  }
  return inserts;
}

module.exports = { getPlaidClient, encrypt, decrypt, mapAcctType, normDescription, buildFingerprint, plaidTxnToRow, crossSourceKey, selectInserts };
