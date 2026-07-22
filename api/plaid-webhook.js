// Vercel API Route: Plaid webhook receiver.
// Public endpoint, so every request is authenticated before we act. Plaid
// signs each webhook with an ES256 JWT in the `Plaid-Verification` header,
// signed by a key we fetch by `kid`. Verifying that signature proves the
// request genuinely came from Plaid (the JWT can't be forged), and the `iat`
// freshness check bounds replay. We route on the parsed JSON body; the JWT —
// not the body — is the trust anchor, so we don't depend on fragile raw-body
// reconstruction in the serverless runtime.
//
// Handled webhooks:
//   TRANSACTIONS / SYNC_UPDATES_AVAILABLE (+ *_UPDATE) -> sync that Item
//   ITEM / ERROR (ITEM_LOGIN_REQUIRED), ITEM / PENDING_EXPIRATION -> needs_reauth
const { createClient } = require("@supabase/supabase-js");
const { importJWK, jwtVerify, decodeProtectedHeader } = require("jose");
const { getPlaidClient } = require("./_plaid");

async function verifyPlaidJwt(plaid, jwtToken) {
  const { kid, alg } = decodeProtectedHeader(jwtToken);
  if (alg !== "ES256" || !kid) return false;
  const keyRes = await plaid.webhookVerificationKeyGet({ key_id: kid });
  const key = await importJWK(keyRes.data.key, "ES256");
  const { payload } = await jwtVerify(jwtToken, key, { algorithms: ["ES256"], clockTolerance: 300 });
  // Bound replay: reject webhooks older than 5 minutes.
  if (!payload.iat || Date.now() / 1000 - payload.iat > 300) return false;
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const jwtToken = req.headers["plaid-verification"];
    if (!jwtToken) return res.status(401).json({ error: "Missing verification" });

    const plaid = getPlaidClient();
    let verified = false;
    try {
      verified = await verifyPlaidJwt(plaid, jwtToken);
    } catch (e) {
      console.error("plaid-webhook verify error:", e.message);
    }
    if (!verified) return res.status(401).json({ error: "Invalid webhook signature" });

    const payload = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
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
