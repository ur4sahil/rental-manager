// Vercel API Route: Save Teller Enrollment
// Called after Teller Connect onSuccess — stores connection + feeds (NO GL accounts)
// GL mapping is done by user in the post-connect modal
const https = require("https");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { setCors } = require("./_cors");

const TELLER_API = "https://api.teller.io";

// AES-256-GCM + PBKDF2 — matches the unified scheme in /api/encrypt.js.
// Pre-M15 this used a weak raw text-to-key derivation
//   (companyId + "_propmanager_cred_key").slice(0,32).padEnd(32,"0")
// that effectively made the per-company key knowable from company_id
// alone. Now each access token gets its own 16-byte random salt stored
// in bank_connection.encryption_salt; the MASTER_KEY is the same
// server-only secret used elsewhere.
const MASTER_KEY = process.env.ENCRYPTION_KEY || "";
async function encrypt(plaintext /*, unused companyId kept for callsite compat */) {
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
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end("ok");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // ─── Cheap local validation FIRST — reject malformed payloads before
    // hitting Supabase Auth. Prevents garbage floods from burning
    // auth.getUser quota / Vercel invocation budget.
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ") || authHeader.length < 20 || authHeader.length > 4096) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body || {};
    const { access_token, enrollment_id, institution, company_id } = body;
    if (typeof access_token !== "string" || !access_token || access_token.length < 10 || access_token.length > 4096) {
      return res.status(400).json({ error: "access_token invalid" });
    }
    if (typeof company_id !== "string" || !company_id || company_id.length > 128) {
      return res.status(400).json({ error: "company_id invalid" });
    }
    if (enrollment_id !== undefined && enrollment_id !== null && (typeof enrollment_id !== "string" || enrollment_id.length > 256)) {
      return res.status(400).json({ error: "enrollment_id invalid" });
    }
    if (institution !== undefined && institution !== null && typeof institution !== "object") {
      return res.status(400).json({ error: "institution invalid" });
    }

    // ─── Only now do we touch Supabase.
    const supabase = createClient(process.env.REACT_APP_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const token = authHeader.slice(7);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: "Invalid token" });

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

    // Encrypt access token (v3 per-credential salt)
    const { encrypted, iv, salt } = await encrypt(access_token, company_id);

    // Check for existing connection with same enrollment_id (reconnect case)
    let connectionId;
    if (enrollment_id) {
      const { data: existingConn } = await supabase
        .from("bank_connection")
        .select("id")
        .eq("company_id", company_id)
        .eq("plaid_item_id", enrollment_id)
        .maybeSingle();

      if (existingConn) {
        // Update existing connection with new token
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
      }
    }

    // Create new connection if not reconnecting
    if (!connectionId) {
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
          encryption_salt: salt,
          connection_status: "active",
        })
        .select("id")
        .single();

      if (connErr) return res.status(500).json({ error: connErr.message });
      connectionId = connection.id;
    }

    // Fetch accounts from Teller API (with mTLS)
    const accountsRes = await tellerFetch(`${TELLER_API}/accounts`, access_token);
    if (!accountsRes.ok) {
      return res.status(400).json({ error: "Teller API error: " + accountsRes.body });
    }
    const tellerAccounts = JSON.parse(accountsRes.body);

    // Create or reuse bank_account_feed for each Teller account (NO GL accounts created)
    const resultFeeds = [];
    for (const acct of tellerAccounts) {
      const acctType = acct.type === "credit" ? "credit_card" : acct.subtype === "savings" ? "savings" : acct.subtype === "money_market" ? "savings" : "checking";
      const suggestedGLType = acctType === "credit_card" ? "Liability" : "Asset";
      const suggestedGLSubtype = acctType === "credit_card" ? "Credit Card" : "Bank";

      // Get balance
      let currentBalance = null;
      try {
        const balRes = await tellerFetch(`${TELLER_API}/accounts/${acct.id}/balances`, access_token);
        if (balRes.ok) {
          const balData = JSON.parse(balRes.body);
          currentBalance = parseFloat(balData.ledger) || null;
        }
      } catch {}

      // Check for existing feed with same Teller account ID (reconnect/dedup)
      const { data: existingFeed } = await supabase
        .from("bank_account_feed")
        .select("id, gl_account_id, status")
        .eq("company_id", company_id)
        .eq("plaid_account_id", acct.id)
        .maybeSingle();

      if (existingFeed) {
        // Reuse existing feed — update connection and reactivate if needed
        await supabase.from("bank_account_feed").update({
          bank_connection_id: connectionId,
          status: "active",
          bank_balance_current: currentBalance,
          account_name: acct.name || existingFeed.account_name || "Bank Account",
          institution_name: institution?.name || "",
        }).eq("id", existingFeed.id);

        resultFeeds.push({
          id: existingFeed.id,
          name: acct.name,
          type: acctType,
          mask: acct.last_four,
          gl_account_id: existingFeed.gl_account_id || null,
          is_existing: true,
          suggested_gl_type: suggestedGLType,
          suggested_gl_subtype: suggestedGLSubtype,
        });
      } else {
        // Create new feed with NO gl_account_id — user maps in modal
        const { data: feed } = await supabase
          .from("bank_account_feed")
          .insert({
            company_id,
            gl_account_id: null,
            bank_connection_id: connectionId,
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
          resultFeeds.push({
            id: feed.id,
            name: acct.name,
            type: acctType,
            mask: acct.last_four,
            gl_account_id: null,
            is_existing: false,
            suggested_gl_type: suggestedGLType,
            suggested_gl_subtype: suggestedGLSubtype,
          });
        }
      }
    }

    return res.status(200).json({
      connection_id: connectionId,
      accounts: resultFeeds,
      message: `Connected ${resultFeeds.length} account(s) from ${institution?.name || "bank"}`,
    });
  } catch (e) {
    console.error("teller-save-enrollment error:", e.message);
    return res.status(500).json({ error: "An internal error occurred. Please try again." });
  }
};
