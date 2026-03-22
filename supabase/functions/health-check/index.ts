// Supabase Edge Function: Health Check
// Returns OK if the function is reachable and DB is queryable
// Deploy: supabase functions deploy health-check --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

serve(async () => {
  const start = Date.now();
  const checks: Record<string, string> = {};

  // 1. Edge Function is alive
  checks.edge_function = "ok";

  // 2. Database connectivity
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { error } = await supabase.from("companies").select("id").limit(1);
    checks.database = error ? `error: ${error.message}` : "ok";
  } catch (e) {
    checks.database = `error: ${(e as Error).message}`;
  }

  const allOk = Object.values(checks).every(v => v === "ok");
  const latency = Date.now() - start;

  return new Response(JSON.stringify({
    status: allOk ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    latency_ms: latency,
    checks,
  }), {
    status: allOk ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
});
