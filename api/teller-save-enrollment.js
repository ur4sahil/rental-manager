// Vercel API Route: Save Teller Enrollment
// Called after Teller Connect onSuccess — stores access token, creates accounts
const https = require("https");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const TELLER_API = "https://api.teller.io";

// AES-GCM encryption (matches frontend encryptCredential)
async function encrypt(plaintext, companyId) {
  if (!plaintext) return { encrypted: "", iv: "" };
  const iv = crypto.randomBytes(12);
  const keyStr = (companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0");
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(keyStr, "utf8"), iv);
  let enc = cipher.update(plaintext, "utf8");
  enc = Buffer.concat([enc, cipher.final(), cipher.getAuthTag()]);
  return { encrypted: enc.toString("base64"), iv: iv.toString("hex") };
}

// mTLS fetch to Teller API
function tellerFetch(url, accessToken) {
  const certB64 = process.env.TELLER_CERT_B64;
  const keyB64 = process.env.TELLER_KEY_B64;
  const cert = certB64 ? Buffer.from(certB64, "base64").toString("utf8") : undefined;
  const key = keyB64 ? Buffer.from(keyB64, "base64").toString("utf8") : undefined;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        Authorization: "Basic " + Buffer.from(accessToken + ":").toString("base64"),
        Accept: "application/json",
      },
    };
    if (cert && key) {
      opts.cert = cert;
      opts.key = key;
    }
    const req = https.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://rental-manager-one.vercel.app");
  res.setHeader("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

    const { access_token, enrollment_id, institution, company_id } = req.body;
    if (!access_token || !company_id) return res.status(400).json({ error: "access_token and company_id required" });

    // Verify user is admin of the company
    const { data: membership } = await supabase
      .from("company_members")
      .select("role")
      .eq("company_id", company_id)
      .ilike("user_email", user.email || "")
      .eq("status", "active")
      .maybeSingle();

    if (!membership || !["admin", "owner"].includes(membership.role)) {
      return res.status(403).json({ error: "Only admins can connect bank accounts" });
    }

    // Encrypt access token
    const { encrypted, iv } = await encrypt(access_token, company_id);

    // Create bank_connection record
    const { data: connection, error: connErr } = await supabase
      .from("bank_connection")
      .insert({
        company_id,
        source_type: "teller",
        institution_name: institution?.name || "",
        institution_id: institution?.id || "",
        plaid_item_id: enrollment_id || "",
        access_token_encrypted: encrypted,
        encryption_iv: iv,
        connection_status: "active",
      })
      .select("id")
      .single();

    if (connErr) return res.status(500).json({ error: connErr.message });

    // Fetch accounts from Teller API (with mTLS)
    const accountsRes = await tellerFetch(`${TELLER_API}/accounts`, access_token);
    if (!accountsRes.ok) {
      return res.status(400).json({ error: "Teller API error: " + accountsRes.body });
    }
    const tellerAccounts = JSON.parse(accountsRes.body);

    // Create bank_account_feed + GL account for each Teller account
    const createdFeeds = [];
    for (const acct of tellerAccounts) {
      const acctType = acct.type === "credit" ? "credit_card" : acct.subtype === "savings" ? "savings" : acct.subtype === "money_market" ? "savings" : "checking";
      const glType = acctType === "credit_card" ? "Liability" : "Asset";
      const glSubtype = acctType === "credit_card" ? "Credit Card" : "Bank";
      const code = acctType === "credit_card" ? "2050" : acctType === "savings" ? "1050" : "1000";
      const nextCode = code + "-" + (acct.id || "").slice(-4);

      // Create GL account
      const { data: glAcct } = await supabase
        .from("acct_accounts")
        .insert({
          company_id,
          code: nextCode,
          name: acct.name || `${institution?.name || "Bank"} ${acct.subtype || acctType}`,
          type: glType,
          subtype: glSubtype,
          is_active: true,
          old_text_id: company_id + "-" + nextCode,
        })
        .select("id")
        .single();

      // Get balances
      let currentBalance = null;
      try {
        const balRes = await tellerFetch(`${TELLER_API}/accounts/${acct.id}/balances`, access_token);
        if (balRes.ok) {
          const balData = JSON.parse(balRes.body);
          currentBalance = parseFloat(balData.ledger) || null;
        }
      } catch {}

      // Create bank_account_feed
      const { data: feed } = await supabase
        .from("bank_account_feed")
        .insert({
          company_id,
          gl_account_id: glAcct?.id,
          bank_connection_id: connection.id,
          account_name: acct.name || "Bank Account",
          masked_number: acct.last_four || "",
          account_type: acctType,
          institution_name: institution?.name || acct.institution?.name || "",
          connection_type: "teller",
          plaid_account_id: acct.id,
          bank_balance_current: currentBalance,
          status: "active",
        })
        .select("id")
        .single();

      if (feed) {
        createdFeeds.push({
          id: feed.id,
          name: acct.name,
          type: acctType,
          mask: acct.last_four,
          gl_account_id: glAcct?.id || null,
          gl_account_name: `${nextCode} ${acct.name || institution?.name || "Bank"}`,
        });
      }
    }

    return res.status(200).json({
      connection_id: connection.id,
      accounts: createdFeeds,
      message: `Connected ${createdFeeds.length} account(s) from ${institution?.name || "bank"}`,
    });
  } catch (e) {
    console.error("teller-save-enrollment error:", e.message);
    return res.status(500).json({ error: "An internal error occurred. Please try again." });
  }
};
