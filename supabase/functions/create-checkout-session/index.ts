// Supabase Edge Function: Create Stripe Checkout Session
// Called from Tenant Portal to initiate Stripe payment
// Deploy: supabase functions deploy create-checkout-session

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// --- Rate Limiter (per-IP, sliding window) ---
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 10;       // max requests
const RATE_WINDOW = 60_000;  // per 60 seconds
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (hits.length >= RATE_LIMIT) return false;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  // Cleanup old IPs every 1000 entries
  if (rateLimitMap.size > 1000) {
    for (const [k, v] of rateLimitMap) {
      if (v.every(t => now - t > RATE_WINDOW)) rateLimitMap.delete(k);
    }
  }
  return true;
}

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "https://rental-manager-one.vercel.app",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Rate limit check
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(clientIp)) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://rental-manager-one.vercel.app", "Retry-After": "60" },
    });
  }

  try {
    const { amount, tenantId, tenantName, property, companyId, successUrl, cancelUrl } = await req.json();

    if (!amount || amount <= 0) {
      return new Response(JSON.stringify({ error: "Invalid amount" }), { status: 400 });
    }

    if (!STRIPE_SECRET_KEY) {
      return new Response(JSON.stringify({ error: "Stripe not configured" }), { status: 500 });
    }

    // Extract user email from JWT
    // Verify JWT with Supabase auth (signature verification, not just decode)
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user?.email) {
      return new Response(JSON.stringify({ error: "Unauthorized — invalid or expired token" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://rental-manager-one.vercel.app" },
      });
    }
    const userEmail = user.email;

    // Verify caller belongs to claimed company AND has appropriate role
    const { data: membership } = await supabase.from("company_members")
      .select("role, status")
      .eq("company_id", companyId)
      .ilike("user_email", userEmail)
      .eq("status", "active")
      .maybeSingle();

    if (!membership) {
      return new Response(JSON.stringify({ error: "Not a member of this company" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://rental-manager-one.vercel.app" },
      });
    }
    // Only tenants can create checkout sessions for their own rent payments
    if (membership.role !== "tenant") {
      return new Response(JSON.stringify({ error: "Only tenants can make payments" }), {
        status: 403,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://rental-manager-one.vercel.app" },
      });
    }

    // Create Stripe Checkout Session via API
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("payment_method_types[0]", "card");
    params.append("payment_method_types[1]", "us_bank_account");
    params.append("line_items[0][price_data][currency]", "usd");
    params.append("line_items[0][price_data][unit_amount]", String(Math.round(amount * 100)));
    params.append("line_items[0][price_data][product_data][name]", `Rent Payment — ${property || "Property"}`);
    params.append("line_items[0][quantity]", "1");
    params.append("success_url", successUrl || "https://rental-manager-one.vercel.app/?payment=success");
    params.append("cancel_url", cancelUrl || "https://rental-manager-one.vercel.app/?payment=cancelled");
    params.append("metadata[tenantId]", tenantId || "");
    params.append("metadata[tenantName]", tenantName || "");
    params.append("metadata[property]", property || "");
    params.append("metadata[companyId]", companyId || "");

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(STRIPE_SECRET_KEY + ":")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      return new Response(JSON.stringify({ error: session.error?.message || "Stripe error" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://rental-manager-one.vercel.app" },
      });
    }

    return new Response(JSON.stringify({ sessionId: session.id, url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://rental-manager-one.vercel.app" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://rental-manager-one.vercel.app" },
    });
  }
});
