// Vercel API Route: Plaid webhook receiver.
// Public endpoint, so every request is authenticated before we act. Plaid
// signs each webhook with an ES256 JWT in the `Plaid-Verification` header,
// signed by a key we fetch by `kid`. Verifying that signature proves the
// request genuinely came from Plaid (the JWT can't be forged); the `iat`
// freshness check bounds replay. We route on the parsed JSON body; the JWT is
// the trust anchor, so we don't depend on fragile raw-body reconstruction.
//
// JWT verification uses Node's built-in crypto (ES256 = ECDSA P-256 + SHA-256,
// JOSE r||s signature). We deliberately avoid the `jose` package: it's ESM and
// crashes at load (FUNCTION_INVOCATION_FAILED) when bundled into a CommonJS
// Vercel function.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { getPlaidClient } = require("./_plaid");

function b64urlToBuf(s) { return Buffer.from(s, "base64url"); }
function b64urlToJson(s) { return JSON.parse(b64urlToBuf(s).toString("utf8")); }

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// `rawBody` is the exact bytes Plaid sent. The JWT carries their SHA-256
// (request_body_sha256); without comparing it, a captured JWT could be
// replayed for 5 minutes with a DIFFERENT body -- any item_id.
async function verifyPlaidJwt(plaid, jwtToken, rawBody) {
  const parts = String(jwtToken || "").split(".");
  if (parts.length !== 3) return false;
  const header = b64urlToJson(parts[0]);
  if (header.alg !== "ES256" || !header.kid) return false;
  // Fetch the ECDSA public key (JWK) for this kid from Plaid.
  const keyRes = await plaid.webhookVerificationKeyGet({ key_id: header.kid });
  const pubKey = crypto.createPublicKey({ key: keyRes.data.key, format: "jwk" });
  const signingInput = Buffer.from(parts[0] + "." + parts[1]);
  const signature = b64urlToBuf(parts[2]); // JOSE raw r||s
  const sigOk = crypto.verify("sha256", signingInput, { key: pubKey, dsaEncoding: "ieee-p1363" }, signature);
  if (!sigOk) return false;
  const payload = b64urlToJson(parts[1]);
  // Bound replay: reject webhooks older than 5 minutes, or from the future.
  const age = Date.now() / 1000 - Number(payload.iat || 0);
  if (!payload.iat || age > 300 || age < -60) return false;
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const claimed = String(payload.request_body_sha256 || "");
  if (claimed.length !== bodyHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(claimed), Buffer.from(bodyHash));
}

module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const jwtToken = req.headers["plaid-verification"];
    if (!jwtToken) return res.status(401).json({ error: "Missing verification" });

    const plaid = getPlaidClient();
    const rawBody = await readRawBody(req);
    let verified = false;
    try {
      verified = await verifyPlaidJwt(plaid, jwtToken, rawBody);
    } catch (e) {
      console.error("plaid-webhook verify error:", e.message);
    }
    if (!verified) return res.status(401).json({ error: "Invalid webhook signature" });

    let payload = {};
    try { payload = JSON.parse(rawBody.toString("utf8") || "{}"); } catch (_) { payload = {}; }
    const { webhook_type, webhook_code, item_id } = payload;
    if (!item_id) return res.status(200).json({ ok: true });

    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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

    if (webhook_type === "TRANSACTIONS" && ["SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"].includes(webhook_code)) {
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
