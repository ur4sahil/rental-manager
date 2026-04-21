// Shared CORS policy for every route in /api/.
//
// Production, explicitly-whitelisted Vercel previews, and localhost (dev)
// may call us. Previously we blanket-allowed every *.vercel.app hostname —
// which meant any attacker who can publish a free-tier preview could make
// credentialled cross-origin requests to our production API on behalf of
// a logged-in admin who visited that preview.
//
// Preview deployments for this project are still supported via two env
// vars, evaluated at request time:
//   CORS_EXTRA_ORIGINS        — comma-separated full origins to allow,
//                               e.g. "https://rental-manager-staging.vercel.app"
//   CORS_VERCEL_TEAM_SLUGS    — comma-separated team slugs whose preview
//                               URLs (rental-manager-*-<slug>.vercel.app)
//                               are allowed. Set this to your Vercel team
//                               slug for branch/PR previews to work.
//
// The underscore prefix keeps Vercel from treating this as a route.
const PROD_ORIGIN = "https://rental-manager-one.vercel.app";
const PROJECT_PREFIX = "rental-manager-";

function splitEnv(name) {
  return (process.env[name] || "").split(",").map(s => s.trim()).filter(Boolean);
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === PROD_ORIGIN) return true;
  const extra = splitEnv("CORS_EXTRA_ORIGINS");
  if (extra.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return false;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    if (!u.hostname.endsWith(".vercel.app")) return false;
    if (!u.hostname.startsWith(PROJECT_PREFIX)) return false;
    // Require the hostname to end with -<team-slug>.vercel.app for an
    // allowed team. This blocks "rental-manager-anything.vercel.app"
    // deployed by a stranger whose project just happens to share our
    // prefix.
    const teams = splitEnv("CORS_VERCEL_TEAM_SLUGS");
    if (teams.length === 0) return false;
    return teams.some(slug => u.hostname.endsWith("-" + slug + ".vercel.app"));
  } catch (_) { return false; }
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
