// Vercel API Route: Plaid Link — link-token creation AND public_token
// exchange in one function. Combined to stay under the Hobby-plan 12
// serverless-function limit; both steps are POST, JWT-authed, admin-only,
// and part of the same Link flow. Dispatch on body.action:
//   "create_token" -> /link/token/create (new, or update/reconnect mode)
//   "exchange"      -> /item/public_token/exchange + /accounts/get, save
//                      connection, return account metadata for post-connect
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");
const { getPlaidClient, decrypt, encrypt, mapAcctType } = require("./_plaid");

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
    const action = body.action || "create_token";

    // Shared auth: JWT + admin/owner membership of the company.
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

    // ── create_token ─────────────────────────────────────────────────────
    if (action === "create_token") {
      const appUrl = process.env.APP_URL || "https://housify365.com";
      const request = {
        user: { client_user_id: String(body.company_id) },
        client_name: "Housify",
        language: "en",
        country_codes: ["US"],
        webhook: `${appUrl}/api/plaid-webhook`,
      };
      // Update mode: re-authenticate an existing Item by its decrypted token.
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
    }

    // ── exchange ─────────────────────────────────────────────────────────
    if (action === "exchange") {
      const { public_token, company_id, institution } = body;
      if (!public_token) return res.status(400).json({ error: "public_token required" });

      const ex = await plaid.itemPublicTokenExchange({ public_token });
      const accessToken = ex.data.access_token;
      const itemId = ex.data.item_id;
      const { encrypted, iv, salt } = encrypt(accessToken);

      // Reconnect case: same item_id -> update the existing connection's token.
      let connectionId;
      const { data: existingConn } = await supabase
        .from("bank_connection")
        .select("id")
        .eq("company_id", company_id)
        .eq("plaid_item_id", itemId)
        .maybeSingle();

      if (existingConn) {
        await supabase.from("bank_connection").update({
          access_token_encrypted: encrypted,
          encryption_iv: iv,
          encryption_salt: salt,
          connection_status: "active",
          last_error_code: null,
          last_error_message: null,
          institution_name: institution?.name || "",
        }).eq("id", existingConn.id);
        connectionId = existingConn.id;
      } else {
        const { data: connection, error: connErr } = await supabase
          .from("bank_connection")
          .insert({
            company_id,
            source_type: "plaid",
            institution_name: institution?.name || "",
            institution_id: institution?.id || "",
            plaid_item_id: itemId,
            plaid_sync_cursor: null,
            access_token_encrypted: encrypted,
            encryption_iv: iv,
            encryption_salt: salt,
            connection_status: "active",
          })
          .select("id")
          .single();
        if (connErr) return res.status(500).json({ error: connErr.message });
        connectionId = connection.id;
      }

      const acctRes = await plaid.accountsGet({ access_token: accessToken });
      const plaidAccounts = acctRes.data.accounts || [];

      const resultAccounts = [];
      for (const acct of plaidAccounts) {
        const acctType = mapAcctType(acct.type, acct.subtype);
        const suggestedGLType = acctType === "credit_card" ? "Liability" : "Asset";
        const suggestedGLSubtype = acctType === "credit_card" ? "Credit Card" : "Bank";
        const currentBalance = acct.balances?.current != null ? parseFloat(acct.balances.current) : null;

        // Two-step feed match: plaid_account_id first (true reconnect), then
        // fall back to (institution + masked last-4 + type) — recognizes the
        // same real account across a NEW enrollment and adopts the new id,
        // keeping history/GL on the existing card.
        let matchedByLastFour = false;
        let { data: existingFeed } = await supabase
          .from("bank_account_feed")
          .select("id, gl_account_id, status")
          .eq("company_id", company_id)
          .eq("plaid_account_id", acct.account_id)
          .maybeSingle();

        if (!existingFeed && acct.mask) {
          const { data: byLastFour } = await supabase
            .from("bank_account_feed")
            .select("id, gl_account_id, status")
            .eq("company_id", company_id)
            .eq("institution_name", institution?.name || "")
            .eq("masked_number", acct.mask)
            .eq("account_type", acctType)
            .maybeSingle();
          if (byLastFour) { existingFeed = byLastFour; matchedByLastFour = true; }
        }

        if (existingFeed) {
          const feedUpdate = {
            bank_connection_id: connectionId,
            bank_balance_current: currentBalance,
            account_name: acct.name || "Bank Account",
            institution_name: institution?.name || "",
          };
          if (matchedByLastFour) {
            feedUpdate.plaid_account_id = acct.account_id;
            if (existingFeed.status) feedUpdate.status = existingFeed.status;
          } else {
            feedUpdate.status = "active";
          }
          await supabase.from("bank_account_feed").update(feedUpdate).eq("id", existingFeed.id);
        }

        resultAccounts.push({
          plaid_account_id: acct.account_id,
          name: acct.name,
          type: acctType,
          mask: acct.mask,
          institution_name: institution?.name || "",
          balance: currentBalance,
          existing_feed_id: existingFeed?.id || null,
          existing_gl_account_id: existingFeed?.gl_account_id || null,
          is_existing: !!existingFeed,
          suggested_gl_type: suggestedGLType,
          suggested_gl_subtype: suggestedGLSubtype,
        });
      }

      return res.status(200).json({
        connection_id: connectionId,
        accounts: resultAccounts,
        message: `Connected ${resultAccounts.length} account(s) from ${institution?.name || "bank"}`,
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error("plaid-link error:", e.response?.data || e.message);
    return res.status(500).json({ error: "Bank connection failed — please try again" });
  }
};
