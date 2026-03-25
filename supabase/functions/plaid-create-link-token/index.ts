// Supabase Edge Function: Create Plaid Link Token
// Deploy: supabase functions deploy plaid-create-link-token
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID") || "";
const PLAID_SECRET = Deno.env.get("PLAID_SECRET") || "";
const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";
const PLAID_BASE = PLAID_ENV === "production" ? "https://production.plaid.com" : PLAID_ENV === "development" ? "https://development.plaid.com" : "https://sandbox.plaid.com";

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

    const { company_id } = await req.json();
    if (!company_id) return new Response(JSON.stringify({ error: "company_id required" }), { status: 400, headers: corsHeaders });

    // Create Plaid Link Token
    const plaidRes = await fetch(`${PLAID_BASE}/link/token/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: PLAID_CLIENT_ID,
        secret: PLAID_SECRET,
        user: { client_user_id: user.id },
        client_name: "PropManager",
        products: ["transactions"],
        transactions: { days_requested: 90 },
        country_codes: ["US"],
        language: "en",
      }),
    });
    const plaidData = await plaidRes.json();

    if (plaidData.error_code) {
      return new Response(JSON.stringify({ error: plaidData.error_message || plaidData.error_code }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ link_token: plaidData.link_token }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
  }
});
