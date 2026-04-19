// Shared CORS policy for every route in /api/.
// Production, any *.vercel.app preview, and localhost (dev) may call us.
// Previously each route hard-coded https://rental-manager-one.vercel.app,
// which blocked preview deployments and forced testing in prod.
//
// The underscore prefix keeps Vercel from treating this as a route.
const PROD_ORIGIN = "https://rental-manager-one.vercel.app";

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === PROD_ORIGIN) return true;
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith(".vercel.app")) return true;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
  } catch (_) { return false; }
  return false;
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  // Echo the origin back when allowed (required for credentialled fetches).
  // Otherwise fall back to prod so the preflight still answers with a
  // parsable header — the browser will block the actual request at the
  // origin check anyway.
  res.setHeader("Access-Control-Allow-Origin", isAllowedOrigin(origin) ? origin : PROD_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Vary", "Origin");
}

module.exports = { setCors, isAllowedOrigin };
