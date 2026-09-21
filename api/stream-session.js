// Mint a short-lived, signed token for one streamed-browser payment session.
//
// The token is what authorises the VPS browser-stream service to open a real
// browser and stream it to this user. It carries the provider/account/amount
// and an 8-minute expiry, HMAC-signed with STREAM_JWT_SECRET (shared with the
// service). Signing here — behind the user's Supabase session — is what keeps
// a driveable browser from being opened by anyone who finds the WebSocket URL.
//
// No card data passes through this route or the token. The card is typed by the
// person into the streamed page and goes browser → utility over HTTPS.
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const secret = process.env.STREAM_JWT_SECRET;
  const streamBase = process.env.STREAM_BASE_URL; // e.g. wss://browser-stream.housify365.com
  if (!secret || !streamBase) { res.status(503).json({ error: "streamed payments are not configured" }); return; }

  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!bearer) { res.status(401).json({ error: "not signed in" }); return; }

  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(500).json({ error: "server not configured" }); return; }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  // The session must be a real, current user — this is the whole gate.
  const { data: u, error } = await sb.auth.getUser(bearer);
  if (error || !u || !u.user) { res.status(401).json({ error: "invalid session" }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { provider, account, amount, billId, companyId } = body || {};
  if (!provider) { res.status(400).json({ error: "provider is required" }); return; }

  const token = sign({
    provider: String(provider).toLowerCase(),
    account: account || null,
    amount: amount != null ? Number(amount) : null,
    billId: billId || null,
    companyId: companyId || null,
    uid: u.user.id,
    exp: Date.now() + 8 * 60 * 1000,
    jti: crypto.randomBytes(6).toString("hex"),
  }, secret);

  res.status(200).json({ streamBase, token, provider: String(provider).toLowerCase() });
};
