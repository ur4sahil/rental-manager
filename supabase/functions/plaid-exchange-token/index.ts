// Supabase Edge Function: Exchange Plaid Public Token for Access Token
// Deploy: supabase functions deploy plaid-exchange-token
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID") || "";
const PLAID_SECRET = Deno.env.get("PLAID_SECRET") || "";
const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";
const PLAID_BASE = PLAID_ENV === "production" ? "https://production.plaid.com" : PLAID_ENV === "development" ? "https://development.plaid.com" : "https://sandbox.plaid.com";

// Simple AES-GCM encryption (matches frontend encryptCredential)
async function encrypt(plaintext: string, companyId: string): Promise<{ encrypted: string; iv: string }> {
  if (!plaintext) return { encrypted: "", iv: "" };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyStr = (companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyStr), { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  return { encrypted: btoa(String.fromCharCode(...new Uint8Array(ciphertext))), iv: ivHex };
}

serve(async (req) => {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: corsHeaders });

    const { public_token, company_id, institution } = await req.json();
    if (!public_token || !company_id) return new Response(JSON.stringify({ error: "public_token and company_id required" }), { status: 400, headers: corsHeaders });

    // Exchange public token for access token
    const exchangeRes = await fetch(`${PLAID_BASE}/item/public_token/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, public_token }),
    });
    const exchangeData = await exchangeRes.json();
    if (exchangeData.error_code) {
      return new Response(JSON.stringify({ error: exchangeData.error_message }), { status: 400, headers: corsHeaders });
    }

    const accessToken = exchangeData.access_token;
    const itemId = exchangeData.item_id;

    // Encrypt access token
    const { encrypted, iv } = await encrypt(accessToken, company_id);

    // Create bank_connection record
    const { data: connection, error: connErr } = await supabase.from("bank_connection").insert({
      company_id,
      source_type: "plaid",
      institution_name: institution?.name || "",
      institution_id: institution?.institution_id || "",
      plaid_item_id: itemId,
      access_token_encrypted: encrypted,
      encryption_iv: iv,
      connection_status: "active",
    }).select("id").single();

    if (connErr) return new Response(JSON.stringify({ error: connErr.message }), { status: 500, headers: corsHeaders });

    // Fetch accounts for this item
    const accountsRes = await fetch(`${PLAID_BASE}/accounts/get`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: PLAID_CLIENT_ID, secret: PLAID_SECRET, access_token: accessToken }),
    });
    const accountsData = await accountsRes.json();
    const plaidAccounts = accountsData.accounts || [];

    // Create bank_account_feed + acct_accounts for each
    const createdFeeds = [];
    for (const acct of plaidAccounts) {
      const acctType = acct.type === "credit" ? "credit_card" : acct.type === "loan" ? "loan" : acct.subtype === "savings" ? "savings" : "checking";
      const glType = acctType === "credit_card" || acctType === "loan" ? "Liability" : "Asset";
      const glSubtype = acctType === "credit_card" ? "Credit Card" : "Bank";
      const code = acctType === "credit_card" ? "2050" : acctType === "savings" ? "1050" : "1000";
      const nextCode = code + "-" + (acct.account_id || "").slice(-4);

      // Create GL account
      const { data: glAcct } = await supabase.from("acct_accounts").insert({
        company_id, code: nextCode, name: acct.name || `${institution?.name} ${acct.subtype}`,
        type: glType, subtype: glSubtype, is_active: true, old_text_id: company_id + "-" + nextCode
      }).select("id").single();

      // Create bank_account_feed
      const { data: feed } = await supabase.from("bank_account_feed").insert({
        company_id,
        gl_account_id: glAcct?.id,
        bank_connection_id: connection.id,
        account_name: acct.name || acct.official_name || "Bank Account",
        masked_number: acct.mask || "",
        account_type: acctType,
        institution_name: institution?.name || "",
        connection_type: "plaid",
        plaid_account_id: acct.account_id,
        bank_balance_current: acct.balances?.current,
        bank_balance_available: acct.balances?.available,
        status: "active",
      }).select("id").single();

      if (feed) createdFeeds.push({ id: feed.id, name: acct.name, type: acctType, mask: acct.mask });
    }

    return new Response(JSON.stringify({
      connection_id: connection.id,
      accounts: createdFeeds,
      message: `Connected ${createdFeeds.length} account(s) from ${institution?.name || "bank"}`
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
