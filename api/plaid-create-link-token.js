// Vercel API Route: Create a Plaid Link token.
// The frontend calls this before opening Plaid Link. Returns a short-lived
// link_token. Two modes:
//   - New connection: pass products (transactions).
//   - Update/reconnect: pass access_token (via body.reconnect_connection_id)
//     to open Link in update mode for ITEM_LOGIN_REQUIRED re-auth — no new
//     Item is created, so it doesn't consume an extra connection.
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { getPlaidClient, decrypt } = require("./_plaid");

function emailFilterValue(email) {
  const s = (email || "").trim().toLowerCase();
  return s.replace(/[%_,.*()\\]/g, c => "\\" + c);
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.body || {};

    // Auth: JWT + admin/owner membership of the company
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
    if (!body.company_id) return res.status(400).json({ error: "company_id required" });

    const { data: mem } = await supabase
      .from("company_members")
      .select("role")
      .eq("company_id", body.company_id)
      .ilike("user_email", emailFilterValue(user.email || ""))
      .eq("status", "active")
      .maybeSingle();
    if (!mem || !["admin", "owner"].includes(mem.role)) {
      return res.status(403).json({ error: "Only admins can connect bank accounts" });
    }

    const plaid = getPlaidClient();
    const appUrl = process.env.APP_URL || "https://housify365.com";

    const request = {
      user: { client_user_id: String(body.company_id) },
      client_name: "Housify",
      language: "en",
      country_codes: ["US"],
      webhook: `${appUrl}/api/plaid-webhook`,
    };

    // Update mode: re-authenticate an existing Item. Look up its decrypted
    // access_token; when set, Plaid ignores `products`.
    if (body.reconnect_connection_id) {
      const { data: conn } = await supabase
        .from("bank_connection")
        .select("access_token_encrypted, encryption_iv, encryption_salt")
        .eq("id", body.reconnect_connection_id)
        .eq("company_id", body.company_id)
        .eq("source_type", "plaid")
        .maybeSingle();
      const accessToken = conn && decrypt(conn.access_token_encrypted, conn.encryption_iv, conn.encryption_salt);
      if (!accessToken) return res.status(404).json({ error: "Connection not found" });
      request.access_token = accessToken;
    } else {
      request.products = ["transactions"];
      request.transactions = { days_requested: 730 };
    }

    const resp = await plaid.linkTokenCreate(request);
    return res.status(200).json({ link_token: resp.data.link_token, expiration: resp.data.expiration });
  } catch (e) {
    console.error("plaid-create-link-token error:", e.response?.data || e.message);
    return res.status(500).json({ error: "Could not start bank connection. Please try again." });
  }
};
