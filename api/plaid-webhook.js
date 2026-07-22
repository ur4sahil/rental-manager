// Vercel API Route: Plaid webhook receiver.
// Public endpoint — so every request is cryptographically verified before we
// act on it. Plaid signs each webhook with an ES256 JWT in the
// `Plaid-Verification` header whose body contains a SHA-256 of the raw request
// body; we fetch the matching verification key by `kid` and verify both the
// signature and the body hash. Unverified requests are rejected.
//
// Handled webhooks:
//   TRANSACTIONS / SYNC_UPDATES_AVAILABLE  -> trigger a sync of that Item
//   ITEM / ERROR (ITEM_LOGIN_REQUIRED),
//   ITEM / PENDING_EXPIRATION              -> flag connection needs_reauth
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { importJWK, jwtVerify, decodeProtectedHeader } = require("jose");
const { getPlaidClient } = require("./_plaid");

// Raw body is required for the SHA-256 hash check, so disable Vercel's parser.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

async function verifyPlaidWebhook(plaid, jwtToken, rawBody) {
  const { kid, alg } = decodeProtectedHeader(jwtToken);
  if (alg !== "ES256" || !kid) return false;
  // Fetch the verification key for this kid
  const keyRes = await plaid.webhookVerificationKeyGet({ key_id: kid });
  const jwk = keyRes.data.key;
  const key = await importJWK(jwk, "ES256");
  // Verify signature (throws on failure), tolerate small clock skew
  const { payload } = await jwtVerify(jwtToken, key, { algorithms: ["ES256"], clockTolerance: 300 });
  // Reject stale webhooks (replay) — must be within 5 minutes
  if (!payload.iat || Date.now() / 1000 - payload.iat > 300) return false;
  // Body integrity: hash of the raw body must match the claim
  const bodyHash = crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
  return payload.request_body_sha256 === bodyHash;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const rawBody = await readRawBody(req);
    const jwtToken = req.headers["plaid-verification"];
    if (!jwtToken) return res.status(401).json({ error: "Missing verification" });

    const plaid = getPlaidClient();
    let verified = false;
    try {
      verified = await verifyPlaidWebhook(plaid, jwtToken, rawBody);
    } catch (e) {
      console.error("plaid-webhook verify error:", e.message);
    }
    if (!verified) return res.status(401).json({ error: "Invalid webhook signature" });

    const payload = JSON.parse(rawBody || "{}");
    const { webhook_type, webhook_code, item_id } = payload;
    if (!item_id) return res.status(200).json({ ok: true }); // nothing to route

    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Re-auth-required signals: flag the connection so the UI prompts a relink.
    const needsReauth =
      (webhook_type === "ITEM" && webhook_code === "ERROR" && payload.error?.error_code === "ITEM_LOGIN_REQUIRED") ||
      (webhook_type === "ITEM" && webhook_code === "PENDING_EXPIRATION");
    if (needsReauth) {
      await supabase.from("bank_connection")
        .update({ connection_status: "needs_reauth", last_error_code: "ITEM_LOGIN_REQUIRED", last_error_message: "Re-authentication required" })
        .eq("plaid_item_id", item_id)
        .eq("source_type", "plaid");
      return res.status(200).json({ ok: true, action: "flagged_reauth" });
    }

    // New transactions available: trigger a sync of just this Item via the
    // sync route (cron-authenticated, single-item scope).
    if (webhook_type === "TRANSACTIONS" && (webhook_code === "SYNC_UPDATES_AVAILABLE" || webhook_code === "DEFAULT_UPDATE" || webhook_code === "INITIAL_UPDATE" || webhook_code === "HISTORICAL_UPDATE")) {
      const appUrl = process.env.APP_URL || "https://housify365.com";
      try {
        await fetch(`${appUrl}/api/plaid-sync-transactions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cron_secret: process.env.CRON_SECRET, item_id }),
        });
      } catch (e) {
        console.error("plaid-webhook sync trigger failed:", e.message);
      }
      return res.status(200).json({ ok: true, action: "sync_triggered" });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("plaid-webhook error:", e.message);
    return res.status(200).json({ ok: true }); // 200 so Plaid doesn't retry-storm on our bugs
  }
};
