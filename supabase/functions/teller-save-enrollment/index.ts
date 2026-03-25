// Supabase Edge Function: Save Teller Enrollment
// Called after Teller Connect onSuccess — stores access token, creates accounts
// Deploy: supabase functions deploy teller-save-enrollment
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELLER_API = "https://api.teller.io";

// AES-GCM encryption (matches frontend encryptCredential)
async function encrypt(plaintext: string, companyId: string): Promise<{ encrypted: string; iv: string }> {
  if (!plaintext) return { encrypted: "", iv: "" };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyStr = (companyId + "_propmanager_cred_key").slice(0, 32).padEnd(32, "0");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyStr), { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  return { encrypted: btoa(String.fromCharCode(...new Uint8Array(ciphertext))), iv: ivHex };
}

// Build TLS agent for mTLS (production)
function getTellerFetchOptions(accessToken: string): RequestInit {
  const headers: Record<string, string> = {
    "Authorization": "Basic " + btoa(accessToken + ":"),
    "Content-Type": "application/json",
  };
  // mTLS certificate — stored as base64 env vars for Supabase Edge Functions
  // In production, TELLER_CERT and TELLER_KEY are required
  const opts: RequestInit = { headers };
  return opts;
}

serve(async (req) => {
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Verify JWT caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: corsHeaders });

    const { access_token, enrollment_id, institution, company_id } = await req.json();
    if (!access_token || !company_id) return new Response(JSON.stringify({ error: "access_token and company_id required" }), { status: 400, headers: corsHeaders });

    // Encrypt access token
    const { encrypted, iv } = await encrypt(access_token, company_id);

    // Create bank_connection record
    const { data: connection, error: connErr } = await supabase.from("bank_connection").insert({
      company_id,
      source_type: "teller",
      institution_name: institution?.name || "",
      institution_id: institution?.id || "",
      plaid_item_id: enrollment_id || "", // reuse column for teller enrollment ID
      access_token_encrypted: encrypted,
      encryption_iv: iv,
      connection_status: "active",
    }).select("id").single();

    if (connErr) return new Response(JSON.stringify({ error: connErr.message }), { status: 500, headers: corsHeaders });

    // Fetch accounts from Teller API
    const accountsRes = await fetch(`${TELLER_API}/accounts`, getTellerFetchOptions(access_token));
    if (!accountsRes.ok) {
      const errText = await accountsRes.text();
      return new Response(JSON.stringify({ error: "Teller API error: " + errText }), { status: 400, headers: corsHeaders });
    }
    const tellerAccounts = await accountsRes.json();

    // Create bank_account_feed + GL account for each Teller account
    const createdFeeds = [];
    for (const acct of tellerAccounts) {
      const acctType = acct.type === "credit" ? "credit_card" : acct.subtype === "savings" ? "savings" : acct.subtype === "money_market" ? "savings" : "checking";
      const glType = acctType === "credit_card" ? "Liability" : "Asset";
      const glSubtype = acctType === "credit_card" ? "Credit Card" : "Bank";
      const code = acctType === "credit_card" ? "2050" : acctType === "savings" ? "1050" : "1000";
      const nextCode = code + "-" + (acct.id || "").slice(-4);

      // Create GL account
      const { data: glAcct } = await supabase.from("acct_accounts").insert({
        company_id, code: nextCode,
        name: acct.name || `${institution?.name || "Bank"} ${acct.subtype || acctType}`,
        type: glType, subtype: glSubtype, is_active: true,
        old_text_id: company_id + "-" + nextCode
      }).select("id").single();

      // Get balances
      let currentBalance = null;
      let availableBalance = null;
      try {
        const balRes = await fetch(`${TELLER_API}/accounts/${acct.id}/balances`, getTellerFetchOptions(access_token));
        if (balRes.ok) {
          const balData = await balRes.json();
          currentBalance = parseFloat(balData.ledger) || null;
          availableBalance = parseFloat(balData.available) || null;
        }
      } catch {}

      // Create bank_account_feed
      const { data: feed } = await supabase.from("bank_account_feed").insert({
        company_id,
        gl_account_id: glAcct?.id,
        bank_connection_id: connection.id,
        account_name: acct.name || "Bank Account",
        masked_number: acct.last_four || "",
        account_type: acctType,
        institution_name: institution?.name || acct.institution?.name || "",
        connection_type: "teller",
        plaid_account_id: acct.id, // reuse column for teller account ID
        bank_balance_current: currentBalance,
        status: "active",
      }).select("id").single();

      if (feed) createdFeeds.push({ id: feed.id, name: acct.name, type: acctType, mask: acct.last_four });
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
